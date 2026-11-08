"""parse_curl (chemin HTTP) signale proprement les protocoles et options non-HTTP."""
from urban_http.parse import parse_curl


def one(cmd):
    r = parse_curl(cmd)
    assert len(r.requests) > 0
    return r.requests[0]


def test_smtp_signaled():
    r = one("curl smtp://mail.example.com --mail-from moi@example.com --mail-rcpt toi@example.com -T message.txt")
    assert any(w.code == "unsupported-protocol" and "smtp" in w.message for w in r.warnings)
    mail = [w for w in r.warnings if w.code == "unsupported-protocol-option"]
    assert len(mail) == 2


def test_ftp_quote():
    r = one('curl -Q "DELE vieux.txt" ftp://ftp.example.com/fichier.txt')
    assert any(w.code == "unsupported-protocol" and "ftp" in w.message.lower() for w in r.warnings)
    assert any(w.code == "unsupported-protocol-option" and w.option == "-Q/--quote" for w in r.warnings)


def test_http_no_protocol_warning():
    assert not any(w.code == "unsupported-protocol" for w in one("curl https://e.com").warnings)
    assert not any(w.code == "unsupported-protocol" for w in one("curl http://e.com").warnings)


def test_recognized_options():
    r = one('curl -n -z "10 Nov 2026" -C 1024 --socks5 localhost:1080 https://e.com')
    opts = [w.option for w in r.warnings if w.code == "unsupported-option"]
    assert "-n/--netrc" in opts and "-z/--time-cond" in opts and "-C/--continue-at" in opts and "--socks5" in opts
    assert not any(w.code == "unknown-option" for w in r.warnings)


def test_parallel():
    r = one("curl -Z --parallel-max 10 https://a.com https://b.com")
    assert any(w.code == "cli-only-option" for w in r.warnings)
    assert not any(w.code == "unknown-option" for w in r.warnings)


def test_url_query():
    r = one("curl --url-query 'q=crème brûlée' --url-query 'page=2' -d 'corps=1' https://e.com/search")
    assert r.url == "https://e.com/search?q=cr%C3%A8me+br%C3%BBl%C3%A9e&page=2"
    assert r.method == "POST" and r.body.text == "corps=1"


def test_variable_curl83():
    r = one("curl --variable host=api.e.com --expand-url 'https://{{host}}/ping'")
    assert r.url == "https://api.e.com/ping"
