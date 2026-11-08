import io
import os
import socket
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from urban_http.parse import parse_curl
from urban_http.execute import build_ssl_context, execute, prepare_request
from urban_http.net import RateLimiter, build_connection_overrides, parse_connect_to, parse_resolve, read_limited


def first(cmd):
    return parse_curl(cmd).requests[0]


# --- Parsing --------------------------------------------------------------

class TestParsing:
    def test_limit_rate_suffixes(self):
        assert first("curl --limit-rate 500 https://e.com").options.limit_rate == 500
        assert first("curl --limit-rate 100K https://e.com").options.limit_rate == 102400
        assert first("curl --limit-rate 2M https://e.com").options.limit_rate == 2 * 1024 ** 2
        assert first("curl --limit-rate 1G https://e.com").options.limit_rate == 1024 ** 3

    def test_limit_rate_invalid(self):
        r = first("curl --limit-rate abc https://e.com")
        assert r.options.limit_rate is None
        assert any(w.code == "invalid-value" for w in r.warnings)

    def test_continue_at(self):
        assert first("curl -C 2048 https://e.com").options.continue_at == 2048
        assert first("curl -C - https://e.com").options.continue_at == -1

    def test_tls_options(self):
        o = first("curl --cert c.pem --key k.pem --pass secret --cacert ca.pem --capath /certs https://e.com").options
        assert o.client_cert == "c.pem" and o.client_key == "k.pem"
        assert o.key_password == "secret" and o.ca_cert == "ca.pem" and o.ca_path == "/certs"

    def test_cert_with_password(self):
        o = first("curl --cert client.pem:motdepasse https://e.com").options
        assert o.client_cert == "client.pem" and o.key_password == "motdepasse"

    def test_network_options(self):
        o = first("curl --resolve e.com:443:1.2.3.4 --connect-to a:80:b:81 --unix-socket /s.sock https://e.com").options
        assert o.resolve == ["e.com:443:1.2.3.4"]
        assert o.connect_to == ["a:80:b:81"]
        assert o.unix_socket == "/s.sock"

    def test_netrc_options(self):
        assert first("curl -n https://e.com").options.use_netrc is True
        o = first("curl --netrc-file /my/netrc https://e.com").options
        assert o.use_netrc is True and o.netrc_file == "/my/netrc"
        assert first("curl --netrc-optional https://e.com").options.netrc_optional is True


# --- Débit (--limit-rate) -------------------------------------------------

class TestRateLimiter:
    def test_waits_proportionally(self):
        slept = []
        rl = RateLimiter(1000, sleep=lambda s: slept.append(s), now=lambda: 0.0)
        rl.account(2000)  # 2000 o à 1000 o/s → ~2 s
        assert abs(slept[-1] - 2.0) < 0.01

    def test_no_wait_when_slow(self):
        t = [0.0]
        slept = []
        rl = RateLimiter(1000, sleep=lambda s: slept.append(s), now=lambda: t[0])
        t[0] = 5.0  # 5 s écoulées
        rl.account(1000)  # 1 s de budget seulement → pas d'attente
        assert slept == [] or slept[-1] <= 0

    def test_read_limited_reads_all(self):
        data = b"x" * 20000
        slept = []
        out = read_limited(io.BytesIO(data), rate=10000, chunk=4096, sleep=lambda s: slept.append(s), now=lambda: 0.0)
        assert out == data
        assert sum(slept) > 0  # il y a eu throttling


# --- TLS ------------------------------------------------------------------

class TestSSLContext:
    def test_none_when_nothing(self):
        assert build_ssl_context(first("curl https://e.com")) is None

    def test_insecure(self):
        import ssl
        ctx = build_ssl_context(first("curl -k https://e.com"))
        assert ctx.verify_mode == ssl.CERT_NONE and ctx.check_hostname is False

    def test_client_cert_loaded(self):
        cert, key = _self_signed_cert()
        if cert is None:
            pytest.skip("openssl indisponible pour générer un certificat de test")
        ctx = build_ssl_context(first(f"curl --cert {cert} --key {key} https://e.com"))
        assert ctx is not None  # load_cert_chain n'a pas levé


# --- netrc ----------------------------------------------------------------

def test_netrc_applies_basic_auth():
    with tempfile.NamedTemporaryFile("w", delete=False, suffix="_netrc") as f:
        f.write("machine api.example.com login alice password s3cret\n")
        netrc_path = f.name
    os.chmod(netrc_path, 0o600)
    try:
        req = first(f"curl --netrc-file {netrc_path} https://api.example.com/x")
        prepared = prepare_request(req)
        auth = next((v for n, v in prepared.headers if n.lower() == "authorization"), None)
        import base64
        assert auth == "Basic " + base64.b64encode(b"alice:s3cret").decode()
    finally:
        os.unlink(netrc_path)


def test_netrc_missing_entry_optional():
    with tempfile.NamedTemporaryFile("w", delete=False, suffix="_netrc") as f:
        f.write("machine autre.com login x password y\n")
        netrc_path = f.name
    os.chmod(netrc_path, 0o600)
    try:
        req = first(f"curl --netrc-file {netrc_path} --netrc-optional https://api.example.com/x")
        prepared = prepare_request(req)
        assert not any(n.lower() == "authorization" for n, _ in prepared.headers)
        assert prepared.issues == []  # optionnel : pas d'erreur
    finally:
        os.unlink(netrc_path)


# --- Redirection de connexion (parsing) -----------------------------------

def test_parse_resolve_and_connect_to():
    assert parse_resolve("e.com:443:1.2.3.4") == ("e.com", 443, "1.2.3.4")
    assert parse_resolve("+e.com:443:::1") == ("e.com", 443, "::1")  # IPv6, préfixe + ignoré
    assert parse_connect_to("a:80:b:8080") == ("a", "80", "b", "8080")
    ov = build_connection_overrides(["e.com:443:127.0.0.1"], ["a:80:b:8080"])
    assert ov == {("a", 80): ("b", 8080), ("e.com", 443): ("127.0.0.1", 443)}


# --- Bout en bout : --resolve (serveur HTTP local) ------------------------

class _EchoHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = f"host={self.headers.get('Host')}".encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def test_resolve_end_to_end():
    server = HTTPServer(("127.0.0.1", 0), _EchoHandler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        # testhost n'existe pas dans le DNS : --resolve le fait pointer sur 127.0.0.1
        req = first(f"curl --resolve testhost:{port}:127.0.0.1 http://testhost:{port}/")
        result = execute(req)
        assert result.response.status == 200
        assert result.response.text() == f"host=testhost:{port}"  # Host d'origine préservé
    finally:
        server.shutdown()


# --- Bout en bout : --unix-socket (serveur AF_UNIX local) -----------------

def _unix_http_server(path, stop):
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(path)
    srv.listen(5)
    srv.settimeout(0.3)
    while not stop.is_set():
        try:
            conn, _ = srv.accept()
        except socket.timeout:
            continue
        with conn:
            buf = b""
            while b"\r\n\r\n" not in buf:
                chunk = conn.recv(1024)
                if not chunk:
                    break
                buf += chunk
            body = b"salut via socket unix"
            conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n%s" % (len(body), body))
    srv.close()


def test_unix_socket_end_to_end():
    path = tempfile.mktemp(suffix=".sock")
    stop = threading.Event()
    t = threading.Thread(target=_unix_http_server, args=(path, stop), daemon=True)
    t.start()
    time.sleep(0.2)
    try:
        req = first(f"curl --unix-socket {path} http://localhost/status")
        result = execute(req)
        assert result.response.status == 200
        assert result.response.text() == "salut via socket unix"
    finally:
        stop.set()
        t.join(timeout=2)
        if os.path.exists(path):
            os.unlink(path)


# --- utilitaire : certificat auto-signé pour le test TLS ------------------

def _self_signed_cert():
    import shutil
    import subprocess
    if not shutil.which("openssl"):
        return None, None
    d = tempfile.mkdtemp()
    cert = os.path.join(d, "cert.pem")
    key = os.path.join(d, "key.pem")
    try:
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert,
             "-days", "1", "-nodes", "-subj", "/CN=test"],
            check=True, capture_output=True, timeout=30,
        )
        return cert, key
    except Exception:  # noqa: BLE001
        return None, None
