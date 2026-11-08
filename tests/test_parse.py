import base64

from urban_http.parse import parse_curl
from urban_http.execute import auth_header


def one(cmd, variables=None):
    r = parse_curl(cmd, variables)
    assert len(r.requests) > 0
    return r.requests[0]


class TestBasics:
    def test_get(self):
        r = one("curl https://api.example.com/users")
        assert r.method == "GET"
        assert r.url == "https://api.example.com/users"

    def test_default_scheme(self):
        r = one("curl example.com")
        assert r.url == "http://example.com"
        assert any(w.code == "default-scheme" for w in r.warnings)

    def test_method(self):
        assert one("curl -X DELETE https://e.com").method == "DELETE"
        assert one("curl --request put https://e.com").method == "PUT"

    def test_glued_short(self):
        assert one("curl -XPOST https://e.com").method == "POST"

    def test_head_and_conflict(self):
        assert one("curl -I https://e.com").method == "HEAD"
        r = one("curl -I -X GET https://e.com")
        assert r.method == "GET"
        assert any(w.code == "method-conflict" for w in r.warnings)

    def test_url_option(self):
        assert one("curl --url https://e.com").url == "https://e.com"

    def test_grouped_shorts(self):
        assert one("curl -sSL https://e.com").options.follow_redirects is True


class TestHeaders:
    def test_multiple_ordered(self):
        r = one("curl -H 'Accept: application/json' -H 'X-Trace: abc' https://e.com")
        assert r.headers == [("Accept", "application/json"), ("X-Trace", "abc")]

    def test_empty_header(self):
        r = one('curl -H "X-Empty;" https://e.com')
        assert r.header("X-Empty") == ""

    def test_remove_header(self):
        r = one('curl -A agent -H "User-Agent:" https://e.com')
        assert r.header("User-Agent") is None

    def test_ua_referer_range(self):
        r = one('curl -A "MyAgent/1.0" -e "https://ref.com" -r 0-499 https://e.com')
        assert r.header("User-Agent") == "MyAgent/1.0"
        assert r.header("Referer") == "https://ref.com"
        assert r.header("Range") == "bytes=0-499"

    def test_compressed(self):
        assert "gzip" in one("curl --compressed https://e.com").header("Accept-Encoding")


class TestBody:
    def test_simple_data(self):
        r = one('curl -d "name=jean&age=30" https://e.com')
        assert r.method == "POST"
        assert r.body.text == "name=jean&age=30"
        assert r.header("Content-Type") == "application/x-www-form-urlencoded"

    def test_multiple_data(self):
        assert one("curl -d a=1 -d b=2 https://e.com").body.text == "a=1&b=2"

    def test_json_content_type(self):
        r = one("curl -d '{\"a\":1}' -H 'Content-Type: application/json' https://e.com")
        assert r.body.text == '{"a":1}'
        assert r.header("Content-Type") == "application/json"
        assert sum(1 for n, _ in r.headers if n.lower() == "content-type") == 1

    def test_data_urlencode(self):
        assert one("curl --data-urlencode 'q=héllo wörld' https://e.com").body.text == "q=h%C3%A9llo+w%C3%B6rld"

    def test_data_raw(self):
        assert one('curl --data-raw "@notafile" https://e.com').body.text == "@notafile"

    def test_data_file_ref(self):
        r = one("curl -d @payload.json https://e.com")
        assert r.body.items[0].file_path == "payload.json"
        assert any(w.code == "file-reference" for w in r.warnings)

    def test_json_shortcut(self):
        r = one('curl --json \'{"tool": "curl"}\' https://e.com')
        assert r.method == "POST"
        assert r.header("Content-Type") == "application/json"
        assert r.header("Accept") == "application/json"

    def test_get_to_query(self):
        r = one('curl -G -d "q=test" -d "page=2" https://e.com/search')
        assert r.method == "GET"
        assert r.url == "https://e.com/search?q=test&page=2"
        assert r.body is None


class TestMultipart:
    def test_fields(self):
        r = one('curl -F "name=jean" -F "avatar=@photo.png;type=image/png" https://e.com/upload')
        assert r.method == "POST"
        assert r.body.kind == "multipart"
        assert r.body.parts[0].name == "name" and r.body.parts[0].value == "jean"
        assert r.body.parts[1].file_path == "photo.png" and r.body.parts[1].content_type == "image/png"

    def test_form_string(self):
        assert one('curl --form-string "text=@literal" https://e.com').body.parts[0].value == "@literal"


class TestAuthCookies:
    def test_basic(self):
        r = one("curl -u alice:secret https://e.com")
        assert r.auth.kind == "basic"
        assert auth_header(r) == ("Authorization", "Basic " + base64.b64encode(b"alice:secret").decode())

    def test_bearer(self):
        assert auth_header(one("curl --oauth2-bearer TOKEN123 https://e.com")) == ("Authorization", "Bearer TOKEN123")

    def test_digest_info(self):
        r = one("curl --digest -u a:b https://e.com")
        assert r.auth.kind == "digest"
        assert any(w.code == "digest-handshake" and w.level == "info" for w in r.warnings)

    def test_cookies(self):
        assert one('curl -b "session=abc" -b "theme=dark" https://e.com').header("Cookie") == "session=abc; theme=dark"

    def test_cookie_file(self):
        r = one("curl -b cookies.txt https://e.com")
        assert r.cookie_files == ["cookies.txt"]


class TestTransfer:
    def test_options(self):
        r = one("curl -L --max-redirs 3 -k -m 2.5 https://e.com")
        assert r.options.follow_redirects and r.options.max_redirs == 3
        assert r.options.insecure and r.options.timeout_ms == 2500

    def test_retry(self):
        r = one("curl --retry 3 --retry-delay 2 https://e.com")
        assert r.options.retry == 3 and r.options.retry_delay_ms == 2000

    def test_proxy(self):
        r = one("curl -x http://proxy:8080 -U bob:pass https://e.com")
        assert r.options.proxy == "http://proxy:8080" and r.options.proxy_user == "bob:pass"

    def test_upload(self):
        r = one("curl -T rapport.pdf https://e.com/files/")
        assert r.method == "PUT" and r.body.kind == "file" and r.body.file_path == "rapport.pdf"


class TestMulti:
    def test_multiple_urls(self):
        reqs = parse_curl('curl -H "X: 1" https://a.com https://b.com').requests
        assert len(reqs) == 2
        assert reqs[1].headers == [("X", "1")]

    def test_next(self):
        reqs = parse_curl("curl -d a=1 https://a.com --next -I https://b.com").requests
        assert reqs[0].method == "POST" and reqs[1].method == "HEAD"

    def test_no_url(self):
        r = parse_curl("curl -s")
        assert len(r.requests) == 0
        assert any(w.code == "no-url" for w in r.warnings)

    def test_unknown_option(self):
        r = one("curl --frobnicate https://e.com")
        assert r.url == "https://e.com"
        assert any(w.code == "unknown-option" for w in r.warnings)
