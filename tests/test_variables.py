import re

from urban_http.parse import parse_curl
from urban_http.postman import parse_postman
from urban_http.variables import parse_postman_environment

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def header(req, name):
    for n, v in req.headers:
        if n.lower() == name.lower():
            return v
    return None


def test_placeholders():
    r = parse_curl("curl -H 'X-Api-Key: {{apiKey}}' -d '{\"env\": \"{{env}}\"}' {{baseUrl}}/users",
                   {"baseUrl": "https://api.e.com", "apiKey": "k-123", "env": "prod"})
    req = r.requests[0]
    assert req.url == "https://api.e.com/users"
    assert header(req, "X-Api-Key") == "k-123"
    assert req.body.text == '{"env": "prod"}'
    assert len(r.warnings) == 0


def test_unresolved_placeholder():
    r = parse_curl("curl https://e.com/{{tenant}}/info")
    assert r.requests[0].url == "https://e.com/{{tenant}}/info"
    assert any(w.code == "unresolved-variable" and "tenant" in w.message for w in r.warnings)


def test_shell_variables():
    v = {"TOKEN": "tok-42", "HOST": "api.e.com"}
    r = parse_curl('curl -H "Authorization: Bearer $TOKEN" https://$HOST/me', v)
    req = r.requests[0]
    assert header(req, "Authorization") == "Bearer tok-42"
    assert req.url == "https://api.e.com/me"


def test_shell_braced():
    r = parse_curl("curl https://${HOST}/sante", {"HOST": "api.e.com"})
    assert r.requests[0].url == "https://api.e.com/sante"


def test_shell_not_in_single_quotes():
    r = parse_curl("curl -d '$TOKEN' https://e.com", {"TOKEN": "x"})
    assert r.requests[0].body.text == "$TOKEN"


def test_no_variables_no_touch():
    r = parse_curl("curl -u 'pa$$word:x' https://e.com/$path")
    assert r.requests[0].url == "https://e.com/$path"
    assert len(r.warnings) == 0


def test_shell_missing():
    r = parse_curl("curl https://e.com/$MISSING", {"HOST": "x"})
    assert r.requests[0].url == "https://e.com/$MISSING"
    assert any(w.code == "unresolved-shell-variable" and "MISSING" in w.message for w in r.warnings)


def test_dynamic_guid():
    r = parse_curl('curl -d \'{"a": "{{$guid}}", "b": "{{$randomUUID}}"}\' https://e.com')
    import json
    body = json.loads(r.requests[0].body.text)
    assert UUID_RE.match(body["a"]) and UUID_RE.match(body["b"])
    assert body["a"] != body["b"]


def test_dynamic_unknown():
    r = parse_curl("curl https://e.com/{{$randomCity}}")
    assert r.requests[0].url == "https://e.com/{{$randomCity}}"
    assert any(w.code == "unsupported-dynamic-variable" for w in r.warnings)


def test_dynamic_postman():
    r = parse_postman({"info": {"name": "t", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
                       "item": [{"request": {"method": "POST", "url": "https://e.com", "body": {"mode": "raw", "raw": '{"id": "{{$guid}}"}'}}}]})
    import json
    assert UUID_RE.match(json.loads(r.requests[0].body.text)["id"])


def test_parse_environment():
    env = '{"name": "Staging", "values": [{"key": "baseUrl", "value": "https://staging.e.com", "enabled": true}, {"key": "off", "value": "x", "enabled": false}, {"key": "token", "value": "t1"}]}'
    assert parse_postman_environment(env) == {"baseUrl": "https://staging.e.com", "token": "t1"}
