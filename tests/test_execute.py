import base64
import importlib

from urban_http.execute import HttpResponse, auth_header, prepare_request

# Le nom public urban_http.execute désigne la fonction ; on récupère le module.
ex = importlib.import_module("urban_http.execute")
from urban_http.parse import parse_curl


def first(cmd):
    return parse_curl(cmd).requests[0]


def test_prepare_basic():
    req = first("curl -X POST -H 'Content-Type: application/json' -d '{\"a\":1}' -u u:p https://e.com")
    prepared = prepare_request(req)
    assert prepared.method == "POST"
    assert prepared.body == b'{"a":1}'
    assert any(n.lower() == "authorization" and v.startswith("Basic ") for n, v in prepared.headers)


def test_prepare_multipart():
    req = first("curl -F a=1 -F b=2 https://e.com")
    prepared = prepare_request(req)
    ct = next(v for n, v in prepared.headers if n.lower() == "content-type")
    assert ct.startswith("multipart/form-data; boundary=")
    assert b'name="a"' in prepared.body and b"1" in prepared.body


def test_prepare_resolves_file():
    req = first("curl -d @data.txt https://e.com")
    prepared = prepare_request(req, file_reader=lambda p: "ligne1\nligne2")
    assert prepared.body == b"ligne1ligne2"  # --data supprime les retours à la ligne
    assert len(prepared.issues) == 0


def test_prepare_unresolved_file():
    prepared = prepare_request(first("curl -d @missing.txt https://e.com"), file_reader=lambda p: (_ for _ in ()).throw(FileNotFoundError("absent")))
    assert len(prepared.issues) > 0


def test_auth_header_basic():
    assert auth_header(first("curl -u alice:secret https://e.com")) == ("Authorization", "Basic " + base64.b64encode(b"alice:secret").decode())


def _resp(status):
    return HttpResponse(status=status, reason="", headers=[], body=b"", url="https://e.com")


def test_retry_on_transient(monkeypatch):
    calls = {"n": 0}

    def fake(opener, prepared, timeout, limit_rate=None):
        calls["n"] += 1
        return _resp(503 if calls["n"] < 3 else 200)

    monkeypatch.setattr(ex, "_do_request", fake)
    monkeypatch.setattr(ex.time, "sleep", lambda s: None)
    result = ex.execute(first("curl --retry 5 https://e.com"))
    assert result.response.status == 200 and result.attempts == 3


def test_no_retry_without_flag(monkeypatch):
    calls = {"n": 0}

    def fake(opener, prepared, timeout, limit_rate=None):
        calls["n"] += 1
        return _resp(503)

    monkeypatch.setattr(ex, "_do_request", fake)
    result = ex.execute(first("curl https://e.com"))
    assert result.response.status == 503 and calls["n"] == 1


def test_digest_handshake(monkeypatch):
    calls = []

    def fake(opener, prepared, timeout, limit_rate=None):
        auth = next((v for n, v in prepared.headers if n.lower() == "authorization"), None)
        calls.append(auth)
        if len(calls) == 1:
            return HttpResponse(status=401, reason="", headers=[("WWW-Authenticate", 'Digest realm="me@x.com", nonce="abc123", qop="auth", opaque="xyz", algorithm=MD5')], body=b"", url="https://e.com/d/auth/alice/secret")
        return _resp(200)

    monkeypatch.setattr(ex, "_do_request", fake)
    result = ex.execute(first("curl --digest -u alice:secret https://e.com/d/auth/alice/secret"))
    assert result.response.status == 200
    assert len(calls) == 2 and calls[0] is None
    assert calls[1].startswith('Digest username="alice"')
