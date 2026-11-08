from urban_http.cookies import cookies_for_url, parse_netscape_cookies
from urban_http.parse import parse_curl
from urban_http.execute import prepare_request

JAR = "\n".join([
    "# Netscape HTTP Cookie File",
    "",
    ".example.com\tTRUE\t/\tFALSE\t0\tsession\tabc123",
    "api.example.com\tFALSE\t/v2\tFALSE\t0\tscope\tv2only",
    ".example.com\tTRUE\t/\tTRUE\t0\tsecure_only\ts3cret",
    ".example.com\tTRUE\t/\tFALSE\t1\texpired\tdead",
    "#HttpOnly_.example.com\tTRUE\t/\tFALSE\t0\thttponly\thidden",
    ".autre.com\tTRUE\t/\tFALSE\t0\tother\tx",
])


def test_parse():
    entries = parse_netscape_cookies(JAR)
    assert len(entries) == 6
    assert entries[0].domain == "example.com" and entries[0].name == "session" and entries[0].value == "abc123"
    assert any(e.name == "httponly" for e in entries)


def test_filter_domain():
    entries = parse_netscape_cookies(JAR)
    header = cookies_for_url(entries, "http://www.example.com/")
    assert "session=abc123" in header and "httponly=hidden" in header
    assert "other=x" not in header and "scope=v2only" not in header


def test_filter_path():
    entries = parse_netscape_cookies(JAR)
    assert "scope=v2only" in cookies_for_url(entries, "http://api.example.com/v2/users")
    assert "scope=v2only" not in cookies_for_url(entries, "http://api.example.com/v1/users")


def test_filter_secure_expiry():
    entries = parse_netscape_cookies(JAR)
    assert "secure_only=s3cret" in cookies_for_url(entries, "https://example.com/")
    http = cookies_for_url(entries, "http://example.com/")
    assert "secure_only" not in http and "expired=dead" not in http


def test_prepare_with_cookie_file():
    req = parse_curl("curl -b cookies.txt -b 'inline=1' https://www.example.com/").requests[0]
    assert req.cookie_files == ["cookies.txt"]
    prepared = prepare_request(req, file_reader=lambda p: JAR)
    cookie = next((v for n, v in prepared.headers if n.lower() == "cookie"), None)
    assert "inline=1" in cookie and "session=abc123" in cookie
    assert len(prepared.issues) == 0
