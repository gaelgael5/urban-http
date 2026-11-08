"""Import du format Postman Collection v2.0 / v2.1 (JSON) vers des HttpRequestModel,
le même modèle que celui produit par parse_curl.
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote_plus

from .model import AuthSpec, BodySpec, FormField, HttpRequestModel, ParseResult, ParseWarning, RequestOptions
from .variables import create_variable_context, substitute_placeholders, variable_warnings


def is_postman_collection(data: Any) -> bool:
    try:
        obj = json.loads(data) if isinstance(data, str) else data
        return isinstance(obj, dict) and bool(obj.get("info")) and isinstance(obj.get("item"), list)
    except (ValueError, TypeError):
        return False


def parse_postman(data: Any, variables: Optional[Dict[str, str]] = None) -> ParseResult:
    global_warnings: List[ParseWarning] = []
    try:
        collection = json.loads(data) if isinstance(data, str) else data
    except (ValueError, TypeError) as e:
        return ParseResult(requests=[], warnings=[ParseWarning(code="invalid-json", message=f"JSON invalide : {e}", level="error")])

    if not isinstance(collection, dict) or not isinstance(collection.get("item"), list):
        return ParseResult(requests=[], warnings=[ParseWarning(code="not-a-collection", message="Ce JSON n'est pas une collection Postman (champs info/item absents).", level="error")])

    schema = (collection.get("info") or {}).get("schema")
    if schema and "collection/v2." not in schema:
        global_warnings.append(ParseWarning(code="unknown-schema", message=f'Schéma "{schema}" inattendu : seul le format Collection v2.x est pris en charge.', level="warning"))

    collection_vars: Dict[str, str] = {}
    for v in collection.get("variable") or []:
        if v.get("key") is not None and not v.get("disabled"):
            collection_vars[v["key"]] = v.get("value", "")
    var_ctx = create_variable_context(collection_vars, variables)

    def substitute(s: str) -> str:
        return substitute_placeholders(s, var_ctx)

    requests: List[HttpRequestModel] = []
    _walk_items(collection["item"], collection.get("auth"), substitute, requests)

    global_warnings.extend(variable_warnings(var_ctx))
    if not requests:
        global_warnings.append(ParseWarning(code="no-request", message="La collection ne contient aucune requête.", level="error"))

    return ParseResult(requests=requests, warnings=global_warnings)


def _walk_items(items: List[dict], inherited_auth, substitute, out: List[HttpRequestModel]) -> None:
    for item in items:
        request = item.get("request")
        auth = item.get("auth") or (request.get("auth") if isinstance(request, dict) else None) or inherited_auth
        if isinstance(item.get("item"), list):
            _walk_items(item["item"], auth, substitute, out)
        if request is not None:
            out.append(_build_request(item, auth, substitute))


def _build_request(item: dict, auth, substitute) -> HttpRequestModel:
    warnings: List[ParseWarning] = []
    options = RequestOptions()
    behavior = item.get("protocolProfileBehavior") or {}
    options.follow_redirects = behavior.get("followRedirects") is not False

    req = item.get("request")
    if isinstance(req, str):
        req = {"method": "GET", "url": req}
    req = req or {}

    method = (req.get("method") or "GET").upper()
    headers: List[Tuple[str, str]] = []
    query: List[Tuple[str, str]] = []

    url = ""
    u = req.get("url")
    if isinstance(u, str):
        url = substitute(u)
    elif isinstance(u, dict):
        if u.get("raw"):
            url = substitute(u["raw"])
        else:
            host = ".".join(u["host"]) if isinstance(u.get("host"), list) else (u.get("host") or "")
            path = "/".join(u["path"]) if isinstance(u.get("path"), list) else (u.get("path") or "")
            port = ":" + u["port"] if u.get("port") else ""
            url = substitute(f"{u.get('protocol', 'http')}://{host}{port}{'/' + path if path else ''}")
        if isinstance(u.get("query"), list) and u["query"]:
            active = [q for q in u["query"] if not q.get("disabled") and q.get("key") is not None]
            base = url.split("?")[0]
            qs = "&".join(substitute(q["key"]) + ("=" + substitute(q.get("value", "")) if q.get("value") is not None else "") for q in active)
            for q in active:
                query.append((substitute(q["key"]), substitute(q.get("value", ""))))
            url = f"{base}?{qs}" if qs else base

    header_field = req.get("header")
    if isinstance(header_field, str):
        for line in re.split(r"\r?\n", header_field):
            colon = line.find(":")
            if colon > 0:
                headers.append((substitute(line[:colon].strip()), substitute(line[colon + 1 :].strip())))
    else:
        for h in header_field or []:
            if h.get("disabled") or h.get("key") is None:
                continue
            headers.append((substitute(h["key"]), substitute(h.get("value", ""))))

    def has_header(name: str) -> bool:
        return any(n.lower() == name.lower() for n, _ in headers)

    body: Optional[BodySpec] = None
    b = req.get("body")
    if isinstance(b, dict) and not b.get("disabled") and b.get("mode"):
        mode = b["mode"]
        if mode == "raw":
            text = substitute(b.get("raw", ""))
            body = BodySpec(kind="raw", text=text)
            lang = ((b.get("options") or {}).get("raw") or {}).get("language")
            ct = {"json": "application/json", "xml": "application/xml", "html": "text/html", "javascript": "application/javascript", "text": "text/plain"}.get(lang)
            if ct and not has_header("content-type"):
                headers.append(("Content-Type", ct))
        elif mode == "urlencoded":
            pairs = [f"{quote_plus(substitute(p['key']))}={quote_plus(substitute(p.get('value', '')))}" for p in (b.get("urlencoded") or []) if not p.get("disabled") and p.get("key") is not None]
            body = BodySpec(kind="urlencoded", text="&".join(pairs))
            if not has_header("content-type"):
                headers.append(("Content-Type", "application/x-www-form-urlencoded"))
        elif mode == "formdata":
            parts: List[FormField] = []
            for p in b.get("formdata") or []:
                if p.get("disabled") or p.get("key") is None:
                    continue
                if p.get("type") == "file":
                    src = p.get("src")
                    srcs = src if isinstance(src, list) else ([src] if src else [])
                    if not srcs:
                        parts.append(FormField(name=substitute(p["key"]), file_path=""))
                    for s in srcs:
                        parts.append(FormField(name=substitute(p["key"]), file_path=s, content_type=p.get("contentType")))
                else:
                    parts.append(FormField(name=substitute(p["key"]), value=substitute(p.get("value", "")), content_type=p.get("contentType")))
            body = BodySpec(kind="multipart", parts=parts)
        elif mode == "file":
            body = BodySpec(kind="file", file_path=(b.get("file") or {}).get("src", ""))
        elif mode == "graphql":
            gql = b.get("graphql") or {}
            variables_val: Any = None
            raw_vars = gql.get("variables")
            if raw_vars:
                try:
                    variables_val = json.loads(substitute(raw_vars))
                except ValueError:
                    variables_val = substitute(raw_vars)
            payload: Dict[str, Any] = {"query": substitute(gql.get("query", ""))}
            if variables_val is not None:
                payload["variables"] = variables_val
            body = BodySpec(kind="raw", text=json.dumps(payload))
            if not has_header("content-type"):
                headers.append(("Content-Type", "application/json"))
        else:
            warnings.append(ParseWarning(code="unsupported-body-mode", message=f'Mode de corps Postman "{mode}" non pris en charge.', level="warning"))

    auth_spec = _convert_auth(auth, substitute, headers, query, warnings)

    for ev in item.get("event") or []:
        exec_lines = (ev.get("script") or {}).get("exec")
        text = "".join(exec_lines) if isinstance(exec_lines, list) else (exec_lines or "")
        if text.strip():
            warnings.append(ParseWarning(code="scripts-not-executed", message="Cette requête a des scripts Postman (pre-request/tests) : ils ne sont pas exécutés par le SDK.", level="info"))
            break

    return HttpRequestModel(method=method, url=url, query=query, headers=headers, body=body, auth=auth_spec, options=options, warnings=warnings, name=item.get("name"))


def _auth_param(section, key: str) -> Optional[str]:
    if isinstance(section, list):
        for p in section:
            if p.get("key") == key:
                return None if p.get("value") is None else str(p["value"])
        return None
    if isinstance(section, dict):
        v = section.get(key)
        return None if v is None else str(v)
    return None


def _convert_auth(auth, substitute, headers, query, warnings) -> Optional[AuthSpec]:
    if not isinstance(auth, dict) or not auth.get("type") or auth["type"] == "noauth":
        return None
    atype = auth["type"]
    section = auth.get(atype)

    def get(key: str) -> Optional[str]:
        v = _auth_param(section, key)
        return substitute(v) if v is not None else None

    if atype == "basic":
        return AuthSpec(kind="basic", username=get("username") or "", password=get("password") or "")
    if atype == "bearer":
        return AuthSpec(kind="bearer", token=get("token") or "")
    if atype == "apikey":
        key = get("key") or ""
        value = get("value") or ""
        if (get("in") or "header") == "query":
            query.append((key, value))
            warnings.append(ParseWarning(code="apikey-query", message=f"Auth \"apikey\" en query string : vérifiez que l'URL finale contient {key}=...", level="info"))
        elif key:
            headers.append((key, value))
        return None
    if atype == "digest":
        warnings.append(ParseWarning(code="digest-handshake", message="Auth Digest : la négociation challenge/réponse est gérée par execute() en deux requêtes.", level="info"))
        return AuthSpec(kind="digest", username=get("username"), password=get("password"))
    if atype == "ntlm":
        warnings.append(ParseWarning(code="unsupported-auth", message="Auth NTLM : non prise en charge.", level="warning"))
        return AuthSpec(kind="ntlm", username=get("username"), password=get("password"))
    warnings.append(ParseWarning(code="unsupported-auth", message=f'Type d\'auth Postman "{atype}" non pris en charge : ajoutez l\'en-tête correspondant manuellement.', level="warning"))
    return None
