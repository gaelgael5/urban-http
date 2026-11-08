from urban_http.protocols.parse import parse_protocol_command
from urban_http.command import parse_command


def req(cmd, variables=None):
    r = parse_protocol_command(cmd, variables)
    assert r.request is not None, r.warnings
    return r.request


def test_http_routed():
    assert parse_protocol_command("curl https://e.com").is_http is True


def test_parse_command_kind():
    assert parse_command("curl https://e.com").kind == "http"
    p = parse_command("curl ftp://ftp.e.com/f.txt")
    assert p.kind == "protocol" and p.scheme == "ftp"


def test_url_decomposition():
    r = req("curl ftp://bob:s3cret@ftp.e.com:2121/dossier/f.txt")
    assert r.host == "ftp.e.com" and r.port == 2121 and r.path == "/dossier/f.txt"
    assert r.username == "bob" and r.password == "s3cret"


def test_default_ports():
    assert req("curl ftp://e.com/f").port == 21
    assert req("curl sftp://e.com/f").port == 22
    assert req("curl pop3://e.com/").port == 110
    assert req("curl smtp://e.com").port == 25
    assert req("curl mqtt://e.com/t").port == 1883
    assert req("curl tftp://e.com/f").port == 69
    assert req("curl ws://e.com/s").port == 80
    assert req("curl wss://e.com/s").port == 443


def test_secure_schemes():
    assert req("curl ftps://e.com/f").secure is True
    assert req("curl smtps://e.com").port == 465
    assert req("curl pop3s://e.com/").secure is True


def test_user_overrides_url():
    r = req("curl -u alice:pw ftp://bob:x@e.com/f")
    assert r.username == "alice" and r.password == "pw"


def test_smtp():
    r = req("curl smtp://mail.e.com --mail-from moi@e.com --mail-rcpt a@e.com --mail-rcpt b@e.com -T message.txt")
    assert r.direction == "send"
    assert r.smtp.from_addr == "moi@e.com"
    assert r.smtp.recipients == ["a@e.com", "b@e.com"]
    assert r.payload.file_path == "message.txt"


def test_smtp_no_rcpt():
    r = req("curl smtp://mail.e.com --mail-from moi@e.com")
    assert any(w.code == "missing-recipient" for w in r.warnings)


def test_ftp():
    assert req("curl -T rapport.pdf ftp://e.com/incoming/").direction == "upload"
    r = req('curl -l -Q "CWD /pub" -Q "TYPE A" ftp://e.com/')
    assert r.direction == "list" and r.ftp.quote == ["CWD /pub", "TYPE A"]


def test_mqtt():
    assert req('curl mqtt://courtier/capteurs/temp -d "21.5"').direction == "publish"
    assert req("curl mqtt://courtier/capteurs/temp").direction == "subscribe"
    r = req('curl mqtt://courtier/t -d "x" --qos 2 --retain')
    assert r.mqtt.qos == 2 and r.mqtt.retain is True


def test_file_and_tftp_and_smb():
    assert req("curl file:///etc/hosts").path == "/etc/hosts"
    assert req("curl -T data.bin file:///tmp/out.bin").direction == "upload"
    assert req("curl tftp://10.0.0.1/firmware.bin").direction == "download"
    assert req("curl smb://serveur/partage/dossier/f.txt").path == "/partage/dossier/f.txt"


def test_ws():
    r = req('curl ws://echo.e.com/s -d "salut" -d "monde" -H "Sec-WebSocket-Protocol: chat, superchat"')
    assert r.direction == "publish"
    assert r.ws.messages == ["salut", "monde"]
    assert r.ws.subprotocols == ["chat", "superchat"]
    assert not any(n.lower() == "sec-websocket-protocol" for n, _ in (r.headers or []))


def test_variables_in_url():
    assert req("curl ftp://{{ftpHost}}/f.txt", {"ftpHost": "ftp.e.com"}).host == "ftp.e.com"
