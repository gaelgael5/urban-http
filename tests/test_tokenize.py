from urban_http.tokenize import tokenize


def test_simple():
    assert tokenize("curl https://example.com") == ["https://example.com"]


def test_single_quotes():
    assert tokenize("curl -d '{\"a\": 1}' url") == ["-d", '{"a": 1}', "url"]


def test_double_quotes_escapes():
    assert tokenize('curl -H "X: \\"quoted\\"" url') == ["-H", 'X: "quoted"', "url"]


def test_bash_line_continuation():
    assert tokenize("curl -X POST \\\n  https://example.com") == ["-X", "POST", "https://example.com"]


def test_cmd_line_continuation():
    assert tokenize('curl -X POST ^\n "https://example.com"') == ["-X", "POST", "https://example.com"]


def test_cmd_doubled_quotes():
    assert tokenize('curl -d "{""a"":1}" ^\n url') == ["-d", '{"a":1}', "url"]


def test_ansi_c_quoting():
    assert tokenize("curl -d $'line1\\nline2' url") == ["-d", "line1\nline2", "url"]


def test_strip_prompt():
    assert tokenize("$ curl https://example.com") == ["https://example.com"]


def test_without_curl_word():
    assert tokenize("-X GET https://example.com") == ["-X", "GET", "https://example.com"]


def test_curl_exe():
    assert tokenize("curl.exe https://example.com") == ["https://example.com"]
