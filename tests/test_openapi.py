import json
from datetime import datetime, timezone

import pytest

from urban_http import openapi_to_curl, parse_curl

NOW = datetime(2026, 11, 8, 14, 30, 0, tzinfo=timezone.utc)


def spec(paths, **extra):
    base = {"openapi": "3.0.0", "servers": [{"url": "https://api.example.com/v1"}], "paths": paths}
    base.update(extra)
    return base


def ops(s):
    return openapi_to_curl(s, now=NOW)


def test_one_operation_per_method():
    s = spec({"/a": {"get": {}, "post": {}}, "/b": {"delete": {}}})
    result = ops(s)
    assert {(o.method, o.path) for o in result} == {("GET", "/a"), ("POST", "/a"), ("DELETE", "/b")}


def test_metadata_and_url():
    s = spec({"/users/{id}": {"get": {"operationId": "getUser", "summary": "Lire",
        "parameters": [{"name": "id", "in": "path", "required": True, "schema": {"type": "integer"}}]}}})
    op = ops(s)[0]
    assert op.operation_id == "getUser" and op.summary == "Lire"
    assert op.curl.startswith("curl -X GET")
    assert "https://api.example.com/v1/users/{{id}}" in op.curl
    assert op.variables == ["id"] and op.example_variables == {"id": "0"}


class TestParameters:
    def test_locations(self):
        s = spec({"/x": {"get": {"parameters": [
            {"name": "q", "in": "query", "schema": {"type": "string"}},
            {"name": "X-Key", "in": "header", "schema": {"type": "string"}},
            {"name": "sid", "in": "cookie", "schema": {"type": "string"}},
        ]}}})
        op = ops(s)[0]
        assert "?q={{q}}" in op.curl
        assert '-H "X-Key: {{X-Key}}"' in op.curl
        assert '-b "sid={{sid}}"' in op.curl
        assert set(op.variables) == {"q", "X-Key", "sid"}

    def test_parameter_table(self):
        s = spec({"/x": {"get": {"parameters": [
            {"name": "id", "in": "path", "required": True, "schema": {"type": "integer"}}]}}})
        p = ops(s)[0].parameters[0]
        assert p.name == "id" and p.location == "path" and p.required is True
        assert p.type == "integer" and p.example == 0 and p.placeholder == "{{id}}"

    def test_path_level_parameters_merged(self):
        s = spec({"/x/{id}": {
            "parameters": [{"name": "id", "in": "path", "required": True, "schema": {"type": "string"}}],
            "get": {"parameters": [{"name": "v", "in": "query", "schema": {"type": "string"}}]},
        }})
        op = ops(s)[0]
        assert set(op.variables) == {"id", "v"}


class TestBodyModel:
    def _body(self, schema):
        s = spec({"/x": {"post": {"requestBody": {"content": {"application/json": {"schema": schema}}}}}})
        return ops(s)[0].body_example

    def test_string_is_property_name(self):
        assert self._body({"type": "object", "properties": {"nom": {"type": "string"}}}) == {"nom": "nom"}

    def test_integer_is_zero(self):
        assert self._body({"type": "object", "properties": {"n": {"type": "integer"}}}) == {"n": 0}

    def test_number_is_zero(self):
        assert self._body({"type": "object", "properties": {"x": {"type": "number"}}}) == {"x": 0}

    def test_boolean_is_false(self):
        assert self._body({"type": "object", "properties": {"ok": {"type": "boolean"}}}) == {"ok": False}

    def test_date_is_now(self):
        assert self._body({"type": "object", "properties": {"d": {"type": "string", "format": "date"}}}) == {"d": "2026-11-08"}

    def test_datetime_is_now(self):
        assert self._body({"type": "object", "properties": {"d": {"type": "string", "format": "date-time"}}}) == {"d": "2026-11-08T14:30:00Z"}

    def test_subobject_expanded(self):
        schema = {"type": "object", "properties": {"a": {"type": "object", "properties": {"b": {"type": "string"}}}}}
        assert self._body(schema) == {"a": {"b": "b"}}

    def test_array_single_item(self):
        schema = {"type": "object", "properties": {"tags": {"type": "array", "items": {"type": "string"}}}}
        assert self._body(schema) == {"tags": ["tags"]}

    def test_enum_first_value(self):
        schema = {"type": "object", "properties": {"r": {"type": "string", "enum": ["admin", "user"]}}}
        assert self._body(schema) == {"r": "admin"}

    def test_explicit_example_honored(self):
        schema = {"type": "object", "properties": {"x": {"type": "string", "example": "exemple-précis"}}}
        assert self._body(schema) == {"x": "exemple-précis"}


class TestRefsAndComposition:
    def test_ref_resolution(self):
        s = spec({"/x": {"post": {"requestBody": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/U"}}}}}}},
                 components={"schemas": {"U": {"type": "object", "properties": {"nom": {"type": "string"}}}}})
        assert ops(s)[0].body_example == {"nom": "nom"}

    def test_allof_merge(self):
        s = spec({"/x": {"post": {"requestBody": {"content": {"application/json": {"schema": {"allOf": [
            {"type": "object", "properties": {"a": {"type": "string"}}},
            {"type": "object", "properties": {"b": {"type": "integer"}}},
        ]}}}}}}})
        assert ops(s)[0].body_example == {"a": "a", "b": 0}

    def test_recursive_schema_terminates(self):
        s = spec({"/x": {"post": {"requestBody": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/Node"}}}}}}},
                 components={"schemas": {"Node": {"type": "object", "properties": {
                     "valeur": {"type": "string"},
                     "enfant": {"$ref": "#/components/schemas/Node"},
                 }}}})
        body = ops(s)[0].body_example   # ne doit pas boucler à l'infini
        assert body["valeur"] == "valeur"
        # Le cycle est coupé dès la ré-occurrence du $ref : l'enfant est développé
        # une fois, et son propre enfant (2ᵉ occurrence de Node) est tronqué.
        assert body["enfant"] == {}


class TestServers:
    def test_server_variables(self):
        s = {"openapi": "3.0.0",
             "servers": [{"url": "https://{host}/v1", "variables": {"host": {"default": "api.example.com"}}}],
             "paths": {"/x": {"get": {}}}}
        op = openapi_to_curl(s, now=NOW)[0]
        assert "https://{{host}}/v1/x" in op.curl
        assert op.example_variables["host"] == "api.example.com"

    def test_base_url_override(self):
        op = openapi_to_curl(spec({"/x": {"get": {}}}), base_url="http://localhost:8080", now=NOW)[0]
        assert "http://localhost:8080/x" in op.curl

    def test_swagger_v2_host_basepath(self):
        s = {"swagger": "2.0", "host": "api.example.com", "basePath": "/v2", "schemes": ["https"],
             "paths": {"/ping": {"get": {}}}}
        op = openapi_to_curl(s, now=NOW)[0]
        assert "https://api.example.com/v2/ping" in op.curl


def test_swagger_v2_body_parameter():
    s = {"swagger": "2.0", "host": "e.com", "basePath": "",
         "definitions": {"U": {"type": "object", "properties": {"nom": {"type": "string"}}}},
         "paths": {"/u": {"post": {"parameters": [{"name": "body", "in": "body", "schema": {"$ref": "#/definitions/U"}}]}}}}
    op = openapi_to_curl(s, now=NOW)[0]
    assert op.body_example == {"nom": "nom"}
    assert op.content_type == "application/json"


def test_json_string_input():
    s = json.dumps(spec({"/x": {"get": {}}}))
    assert openapi_to_curl(s, now=NOW)[0].path == "/x"


def test_integration_with_parse_curl():
    s = spec({"/users/{id}": {"get": {"parameters": [
        {"name": "id", "in": "path", "required": True, "schema": {"type": "integer"}},
        {"name": "q", "in": "query", "schema": {"type": "string"}}]}}})
    op = ops(s)[0]
    # La commande générée + ses variables d'exemple se résolvent via parse_curl
    result = parse_curl(op.curl, op.example_variables)
    req = result.requests[0]
    assert req.url == "https://api.example.com/v1/users/0?q=q"
    assert not any(w.code in ("unresolved-variable", "unresolved-shell-variable") for w in result.warnings)


def test_to_dict():
    op = ops(spec({"/x": {"get": {}}}))[0]
    d = op.to_dict()
    assert d["method"] == "GET" and d["path"] == "/x" and "curl" in d
