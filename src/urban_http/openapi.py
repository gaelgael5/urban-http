"""Générateur OpenAPI → curl.

`openapi_to_curl(contrat)` lit un contrat OpenAPI (v3.x, et au mieux Swagger v2)
et renvoie, pour chaque opération (path + méthode), une commande curl prête à
l'emploi avec des variables {{...}} injectables, le tableau de ses paramètres, et
un modèle générique du corps de requête.

Génération du modèle (corps de requête et valeurs d'exemple) :
  - chaîne                  → le nom de la propriété
  - chaîne date / date-time → l'instant courant au format attendu
  - entier / nombre         → 0
  - booléen                 → false
  - sous-objet              → le sous-objet, développé récursivement
  - tableau                 → toujours un seul élément
  - enum / default / example explicites → cette valeur (plus utile)
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

_METHODS = ("get", "post", "put", "patch", "delete", "options", "head", "trace")


@dataclass
class OperationParam:
    """Un paramètre d'opération (path / query / header / cookie)."""

    name: str
    location: str  # "path" | "query" | "header" | "cookie"
    required: bool
    type: str
    example: Any           # valeur type suggérée pour l'injection
    placeholder: str       # ex. "{{id}}"


@dataclass
class CurlOperation:
    """Une opération du contrat, convertie en commande curl."""

    method: str
    path: str
    operation_id: Optional[str]
    summary: Optional[str]
    curl: str
    variables: List[str]                 # noms des {{...}} présents dans la commande
    example_variables: Dict[str, Any]    # {nom: valeur type} prêt pour parse_curl(curl, ...)
    parameters: List[OperationParam]
    body_example: Any                    # modèle générique du corps (ou None)
    content_type: Optional[str]

    def to_dict(self) -> dict:
        return asdict(self)


def openapi_to_curl(contract: Any, base_url: Optional[str] = None, now: Optional[datetime] = None) -> List[CurlOperation]:
    """Convertit un contrat OpenAPI en une liste d'opérations curl.

    `contract` : un dict déjà parsé, ou une chaîne JSON (ou YAML si pyyaml est
    installé). `base_url` force l'URL de base ; sinon elle vient du contrat.
    `now` : instant de référence pour les dates (par défaut maintenant, UTC).
    """
    spec = _load(contract)
    now = now or datetime.now(timezone.utc)
    ctx = _Context(spec=spec, now=now)
    server = base_url if base_url is not None else _server_url(spec, ctx)

    operations: List[CurlOperation] = []
    paths = spec.get("paths") or {}
    for path, path_item in paths.items():
        if not isinstance(path_item, dict):
            continue
        # Paramètres communs à toutes les méthodes du path
        common_params = path_item.get("parameters") or []
        for method in _METHODS:
            op = path_item.get(method)
            if not isinstance(op, dict):
                continue
            operations.append(_build_operation(method, path, op, common_params, server, ctx))
    return operations


# --------------------------------------------------------------------------

@dataclass
class _Context:
    spec: dict
    now: datetime


def _load(contract: Any) -> dict:
    if isinstance(contract, dict):
        return contract
    if isinstance(contract, (bytes, bytearray)):
        contract = contract.decode("utf-8")
    if isinstance(contract, str):
        try:
            return json.loads(contract)
        except ValueError:
            try:
                import yaml  # type: ignore
            except ImportError as e:
                raise ValueError(
                    "Contrat non-JSON : installez pyyaml pour lire le YAML "
                    '(pip install "urban-http[openapi]") ou passez un dict / du JSON.'
                ) from e
            return yaml.safe_load(contract)
    raise TypeError("contract doit être un dict ou une chaîne JSON/YAML")


def _server_url(spec: dict, ctx: "_Context") -> str:
    # OpenAPI v3 : servers[0].url (avec variables {var} → {{var}})
    servers = spec.get("servers")
    if isinstance(servers, list) and servers:
        url = servers[0].get("url", "")
        variables = servers[0].get("variables") or {}
        for var_name, var_def in variables.items():
            default = var_def.get("default") if isinstance(var_def, dict) else None
            ctx_default = default if default is not None else var_name
            url = url.replace("{" + var_name + "}", "{{" + var_name + "}}")
            ctx.__dict__.setdefault("_server_var_defaults", {})[var_name] = ctx_default
        return url
    # Swagger v2 : schemes + host + basePath
    host = spec.get("host")
    if host:
        scheme = (spec.get("schemes") or ["https"])[0]
        base_path = spec.get("basePath", "")
        return f"{scheme}://{host}{base_path}"
    return "{{baseUrl}}"


def _build_operation(method, path, op, common_params, server, ctx) -> CurlOperation:
    # Fusion des paramètres (niveau path + niveau opération), déduplication par (name, in)
    merged: Dict[tuple, dict] = {}
    for p in list(common_params) + list(op.get("parameters") or []):
        p = _resolve(p, ctx)
        if not isinstance(p, dict) or "name" not in p:
            continue
        merged[(p["name"], p.get("in"))] = p

    parameters: List[OperationParam] = []
    header_lines: List[str] = []
    cookie_pairs: List[str] = []
    query_pairs: List[str] = []
    example_variables: Dict[str, Any] = {}
    variables: List[str] = []

    def add_var(name: str, value: Any) -> None:
        if name not in example_variables:
            # Valeurs d'injection = chaînes (ce sont des valeurs shell), même si le
            # type OpenAPI est entier/booléen ; le type reste visible dans parameters[].
            example_variables[name] = value if isinstance(value, str) else json.dumps(value)
            variables.append(name)

    # URL : chemin avec {param} → {{param}}
    url_path = path
    for (name, location), p in merged.items():
        schema = p.get("schema") or {}
        example = _example_value(schema, name, ctx, [])
        ptype = _type_name(schema)
        placeholder = "{{" + name + "}}"
        parameters.append(OperationParam(name=name, location=location or "", required=bool(p.get("required")), type=ptype, example=example, placeholder=placeholder))
        if location == "path":
            url_path = url_path.replace("{" + name + "}", placeholder)
            add_var(name, example)
        elif location == "query":
            query_pairs.append(f"{name}={placeholder}")
            add_var(name, example)
        elif location == "header":
            header_lines.append(f'-H "{name}: {placeholder}"')
            add_var(name, example)
        elif location == "cookie":
            cookie_pairs.append(f"{name}={placeholder}")
            add_var(name, example)

    # Variables de serveur ({{var}} dans l'URL de base)
    for var_name, default in getattr(ctx, "_server_var_defaults", {}).items():
        if "{{" + var_name + "}}" in server:
            add_var(var_name, default)
    if "{{baseUrl}}" in server:
        add_var("baseUrl", "https://api.example.com")

    url = server.rstrip("/") + url_path
    if query_pairs:
        url += "?" + "&".join(query_pairs)

    # Corps de requête
    body_example = None
    content_type = None
    body_part = ""
    request_body = _resolve(op.get("requestBody"), ctx) if op.get("requestBody") else None
    if isinstance(request_body, dict):
        content = request_body.get("content") or {}
        content_type, media = _pick_media(content)
        if media is not None:
            body_example = _example_value(media.get("schema") or {}, None, ctx, [])
    else:
        # Swagger v2 : paramètre in: body
        for p in list(common_params) + list(op.get("parameters") or []):
            p = _resolve(p, ctx)
            if isinstance(p, dict) and p.get("in") == "body":
                content_type = "application/json"
                body_example = _example_value(p.get("schema") or {}, None, ctx, [])
                break

    if body_example is not None:
        if content_type in (None, "application/json") or content_type.endswith("+json"):
            content_type = content_type or "application/json"
            payload = json.dumps(body_example, ensure_ascii=False)
        else:
            payload = json.dumps(body_example, ensure_ascii=False)
        body_part = f" \\\n  -d '{payload}'"

    # Construction de la commande curl (une option par ligne, continuations \\)
    line_prefix = " \\\n  "
    segments = [f'"{url}"']
    if content_type:
        segments.append(f'-H "Content-Type: {content_type}"')
    segments.extend(header_lines)
    if cookie_pairs:
        segments.append(f"-b \"{'; '.join(cookie_pairs)}\"")
    curl = "curl -X " + method.upper() + line_prefix + line_prefix.join(segments) + body_part

    return CurlOperation(
        method=method.upper(),
        path=path,
        operation_id=op.get("operationId"),
        summary=op.get("summary") or op.get("description"),
        curl=curl,
        variables=variables,
        example_variables=example_variables,
        parameters=parameters,
        body_example=body_example,
        content_type=content_type,
    )


def _pick_media(content: dict):
    """Choisit le type de média (JSON de préférence)."""
    if not content:
        return None, None
    for ct in content:
        if ct == "application/json" or ct.endswith("+json"):
            return ct, content[ct]
    ct = next(iter(content))
    return ct, content[ct]


def _resolve(node: Any, ctx: "_Context", _depth: int = 0):
    """Résout un $ref local (#/components/schemas/X ou #/definitions/X)."""
    if _depth > 50 or not isinstance(node, dict):
        return node
    ref = node.get("$ref")
    if not ref or not isinstance(ref, str) or not ref.startswith("#/"):
        return node
    target: Any = ctx.spec
    for part in ref[2:].split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        if isinstance(target, dict) and part in target:
            target = target[part]
        else:
            return {}
    return _resolve(target, ctx, _depth + 1)


def _type_name(schema: dict) -> str:
    t = schema.get("type")
    if isinstance(t, list):
        t = next((x for x in t if x != "null"), t[0] if t else "string")
    if not t:
        if "properties" in schema or "allOf" in schema:
            return "object"
        if "items" in schema:
            return "array"
        return "string"
    fmt = schema.get("format")
    return f"{t}<{fmt}>" if fmt else t


def _example_value(schema: Any, name: Optional[str], ctx: "_Context", stack: List[str]) -> Any:
    # Garde anti-récursion : on suit le $ref lui-même. Un schéma qui se référence
    # (directement ou via une chaîne) est coupé pour éviter une récursion infinie.
    ref = schema.get("$ref") if isinstance(schema, dict) else None
    if ref:
        if ref in stack:
            return {}  # cycle détecté : on arrête ici
        stack = stack + [ref]
    schema = _resolve(schema, ctx)
    if not isinstance(schema, dict):
        return name or None

    # Valeurs explicites, prioritaires (plus utiles qu'une valeur type)
    if "example" in schema:
        return schema["example"]
    if "default" in schema:
        return schema["default"]
    if isinstance(schema.get("enum"), list) and schema["enum"]:
        return schema["enum"][0]

    # Compositions
    if isinstance(schema.get("allOf"), list):
        merged: Dict[str, Any] = {}
        for sub in schema["allOf"]:
            value = _example_value(sub, name, ctx, stack)
            if isinstance(value, dict):
                merged.update(value)
        if merged:
            return merged
    for key in ("oneOf", "anyOf"):
        if isinstance(schema.get(key), list) and schema[key]:
            return _example_value(schema[key][0], name, ctx, stack)

    t = schema.get("type")
    if isinstance(t, list):
        t = next((x for x in t if x != "null"), None)

    if t == "object" or "properties" in schema:
        props = schema.get("properties") or {}
        result: Dict[str, Any] = {}
        for pname, pschema in props.items():
            result[pname] = _example_value(pschema, pname, ctx, stack)
        return result

    if t == "array" or "items" in schema:
        items = schema.get("items") or {}
        return [_example_value(items, name, ctx, stack)]  # toujours 1 élément

    if t == "string":
        fmt = schema.get("format")
        if fmt == "date":
            return ctx.now.date().isoformat()
        if fmt == "date-time":
            return ctx.now.strftime("%Y-%m-%dT%H:%M:%SZ")
        if fmt == "time":
            return ctx.now.strftime("%H:%M:%S")
        return name or "string"

    if t in ("integer", "number"):
        return 0
    if t == "boolean":
        return False

    return name or "string"
