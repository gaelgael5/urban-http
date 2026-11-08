import base64
import json

from urban_http.postman import is_postman_collection, parse_postman
from urban_http.execute import auth_header


def collection(items, **extra):
    return {"info": {"name": "Test", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"}, "item": items, **extra}


def header(req, name):
    for n, v in req.headers:
        if n.lower() == name.lower():
            return v
    return None


def test_is_collection():
    assert is_postman_collection(json.dumps(collection([]))) is True
    assert is_postman_collection("curl https://e.com") is False


def test_get_query_disabled():
    reqs = parse_postman(collection([{
        "name": "Liste",
        "request": {"method": "GET", "url": {
            "raw": "https://api.example.com/products?limit=10&debug=1",
            "host": ["api", "example", "com"], "path": ["products"],
            "query": [{"key": "limit", "value": "10"}, {"key": "debug", "value": "1", "disabled": True}],
        }},
    }])).requests
    assert reqs[0].name == "Liste"
    assert reqs[0].url == "https://api.example.com/products?limit=10"


def test_short_form():
    reqs = parse_postman(collection([{"request": "https://e.com/ping"}])).requests
    assert reqs[0].url == "https://e.com/ping" and reqs[0].method == "GET"


def test_composed_url():
    reqs = parse_postman(collection([{"request": {"method": "GET", "url": {"protocol": "https", "host": ["api", "e", "com"], "port": "8443", "path": ["v1", "ping"]}}}])).requests
    assert reqs[0].url == "https://api.e.com:8443/v1/ping"


def test_nested_folders():
    reqs = parse_postman(collection([
        {"name": "D", "item": [
            {"name": "Sous", "item": [{"name": "P", "request": "https://e.com/deep"}]},
            {"name": "Directe", "request": "https://e.com/direct"},
        ]},
    ])).requests
    assert [r.url for r in reqs] == ["https://e.com/deep", "https://e.com/direct"]


def test_follow_redirects():
    reqs = parse_postman(collection([
        {"request": "https://e.com/a"},
        {"request": "https://e.com/b", "protocolProfileBehavior": {"followRedirects": False}},
    ])).requests
    assert reqs[0].options.follow_redirects is True
    assert reqs[1].options.follow_redirects is False


def test_raw_json_body():
    reqs = parse_postman(collection([{"request": {"method": "POST", "url": "https://e.com", "body": {"mode": "raw", "raw": '{"a": 1}', "options": {"raw": {"language": "json"}}}}}])).requests
    assert reqs[0].body.text == '{"a": 1}'
    assert header(reqs[0], "Content-Type") == "application/json"


def test_urlencoded_body():
    reqs = parse_postman(collection([{"request": {"method": "POST", "url": "https://e.com", "body": {"mode": "urlencoded", "urlencoded": [{"key": "q", "value": "crème brûlée"}, {"key": "skip", "value": "1", "disabled": True}]}}}])).requests
    assert reqs[0].body.text == "q=cr%C3%A8me+br%C3%BBl%C3%A9e"


def test_formdata_body():
    reqs = parse_postman(collection([{"request": {"method": "POST", "url": "https://e.com", "body": {"mode": "formdata", "formdata": [{"key": "name", "value": "jean", "type": "text"}, {"key": "file", "src": "/tmp/p.png", "type": "file", "contentType": "image/png"}]}}}])).requests
    parts = reqs[0].body.parts
    assert reqs[0].body.kind == "multipart"
    assert parts[0].name == "name" and parts[0].value == "jean"
    assert parts[1].file_path == "/tmp/p.png" and parts[1].content_type == "image/png"


def test_graphql_body():
    reqs = parse_postman(collection([{"request": {"method": "POST", "url": "https://e.com/graphql", "body": {"mode": "graphql", "graphql": {"query": "query { me { id } }", "variables": '{"id": 7}'}}}}])).requests
    assert json.loads(reqs[0].body.text) == {"query": "query { me { id } }", "variables": {"id": 7}}


def test_auth_basic():
    reqs = parse_postman(collection([{"request": {"method": "GET", "url": "https://e.com", "auth": {"type": "basic", "basic": [{"key": "username", "value": "alice"}, {"key": "password", "value": "secret"}]}}}])).requests
    assert auth_header(reqs[0]) == ("Authorization", "Basic " + base64.b64encode(b"alice:secret").decode())


def test_auth_bearer_inherited():
    reqs = parse_postman(collection([{"request": "https://e.com/a"}], auth={"type": "bearer", "bearer": [{"key": "token", "value": "TOK"}]})).requests
    assert auth_header(reqs[0]) == ("Authorization", "Bearer TOK")


def test_apikey_header():
    reqs = parse_postman(collection([{"request": {"method": "GET", "url": "https://e.com", "auth": {"type": "apikey", "apikey": [{"key": "key", "value": "X-Api-Key"}, {"key": "value", "value": "k123"}]}}}])).requests
    assert header(reqs[0], "X-Api-Key") == "k123"


def test_variables_priority():
    reqs = parse_postman(collection([{"request": "{{baseUrl}}/users"}], variable=[{"key": "baseUrl", "value": "https://prod.e.com"}]), variables={"baseUrl": "https://staging.e.com"}).requests
    assert reqs[0].url == "https://staging.e.com/users"


def test_invalid_json():
    r = parse_postman("{pas du json")
    assert len(r.requests) == 0 and r.warnings[0].code == "invalid-json"


def test_scripts_flagged():
    reqs = parse_postman(collection([{"request": "https://e.com", "event": [{"listen": "prerequest", "script": {"exec": ["pm.environment.set('x', 1);"]}}]}])).requests
    assert any(w.code == "scripts-not-executed" for w in reqs[0].warnings)
