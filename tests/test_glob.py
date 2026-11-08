import pytest

from urban_http.glob import GlobError, expand_curl_globs
from urban_http.parse import parse_curl


def test_alternatives():
    assert expand_curl_globs("https://e.com/{api,www}/ping") == ["https://e.com/api/ping", "https://e.com/www/ping"]


def test_numeric_range():
    assert expand_curl_globs("https://e.com/p/[1-3]") == ["https://e.com/p/1", "https://e.com/p/2", "https://e.com/p/3"]


def test_zero_padding():
    assert expand_curl_globs("https://e.com/img[01-03].png") == ["https://e.com/img01.png", "https://e.com/img02.png", "https://e.com/img03.png"]


def test_step():
    assert expand_curl_globs("https://e.com/[0-100:50]") == ["https://e.com/0", "https://e.com/50", "https://e.com/100"]


def test_alpha():
    assert expand_curl_globs("https://e.com/[a-c]") == ["https://e.com/a", "https://e.com/b", "https://e.com/c"]


def test_cartesian():
    assert expand_curl_globs("https://{eu,us}.e.com/p/[1-2]") == [
        "https://eu.e.com/p/1", "https://eu.e.com/p/2", "https://us.e.com/p/1", "https://us.e.com/p/2",
    ]


def test_invalid_ipv6():
    with pytest.raises(GlobError):
        expand_curl_globs("http://[::1]:8080/")


def test_too_large():
    with pytest.raises(GlobError, match="limite"):
        expand_curl_globs("https://e.com/[1-100000]")


def test_parse_expands():
    reqs = parse_curl("curl 'https://httpbin.org/anything/[1-3]'").requests
    assert [r.url for r in reqs] == ["https://httpbin.org/anything/1", "https://httpbin.org/anything/2", "https://httpbin.org/anything/3"]


def test_globoff():
    reqs = parse_curl("curl -g 'https://e.com/literal[1-3]'").requests
    assert len(reqs) == 1 and reqs[0].url == "https://e.com/literal[1-3]"


def test_invalid_pattern_warns():
    reqs = parse_curl("curl 'http://[::1]:8080/sante'").requests
    assert len(reqs) == 1 and reqs[0].url == "http://[::1]:8080/sante"
    assert any(w.code == "url-globbing" for w in reqs[0].warnings)
