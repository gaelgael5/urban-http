"""Parsing d'une commande curl vers une ProtocolRequest, pour les schémas non-HTTP.
Réutilise le tokenizer et les variables du cœur, avec sa propre lecture d'options.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple
from urllib.parse import quote_plus, unquote

from ..model import ParseWarning
from ..tokenize import tokenize_full
from ..variables import create_variable_context, substitute_placeholders, variable_warnings
from .types import (
    DEFAULT_PORTS,
    FtpOptions,
    MqttOptions,
    Payload,
    ProtocolRequest,
    SmtpOptions,
    WsOptions,
    is_secure_scheme,
)

VALUE_OPTIONS = {
    "-T", "--upload-file", "-o", "--output", "-u", "--user",
    "-d", "--data", "--data-raw", "--data-binary", "--data-ascii",
    "-H", "--header", "-Q", "--quote", "-r", "--range", "-m", "--max-time",
    "--connect-timeout", "--mail-from", "--mail-rcpt", "--mail-auth",
    "--ftp-method", "-P", "--ftp-port", "--url", "--qos",
}

KNOWN_SCHEMES = {
    "smtp", "smtps", "ftp", "ftps", "sftp", "pop3", "pop3s", "mqtt", "mqtts",
    "tftp", "file", "smb", "smbs", "ws", "wss",
}

_SCHEME = re.compile(r"^([a-zA-Z][a-zA-Z0-9+.-]*)://")


@dataclass
class ProtocolParseResult:
    scheme: str
    is_http: bool
    request: Optional[ProtocolRequest] = None
    warnings: List[ParseWarning] = field(default_factory=list)


def parse_protocol_command(command: str, variables: Optional[Dict[str, str]] = None) -> ProtocolParseResult:
    tok = tokenize_full(command, shell_variables=variables)
    var_ctx = create_variable_context(variables)
    tokens = [substitute_placeholders(t, var_ctx) for t in tok.tokens]
    warnings: List[ParseWarning] = []

    raw_url: Optional[str] = None
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t == "--url":
            raw_url = tokens[i + 1] if i + 1 < len(tokens) else None
            break
        if not t.startswith("-"):
            raw_url = t
            break
        if t in VALUE_OPTIONS:
            i += 1
        i += 1

    if not raw_url:
        return ProtocolParseResult(scheme="", is_http=False, warnings=[ParseWarning(code="no-url", message="Aucune URL dans la commande.", level="error")])

    m = _SCHEME.match(raw_url)
    scheme = (m.group(1).lower() if m else "http")

    if scheme in ("http", "https"):
        return ProtocolParseResult(scheme=scheme, is_http=True, warnings=warnings)

    if scheme not in KNOWN_SCHEMES:
        return ProtocolParseResult(scheme=scheme, is_http=False, warnings=[ParseWarning(code="unsupported-protocol", message=f'Protocole "{scheme}://" sans adaptateur dans le SDK.', level="error")])

    request = _build_protocol_request(scheme, raw_url, tokens, var_ctx, warnings)
    return ProtocolParseResult(scheme=scheme, is_http=False, request=request, warnings=warnings)


@dataclass
class _Scanned:
    user: Optional[str] = None
    upload: Optional[str] = None
    output: Optional[str] = None
    data: List[str] = field(default_factory=list)
    headers: List[Tuple[str, str]] = field(default_factory=list)
    quote: List[str] = field(default_factory=list)
    range: Optional[str] = None
    max_time_ms: Optional[int] = None
    connect_timeout_ms: Optional[int] = None
    insecure: bool = False
    ssl: bool = False
    ssl_reqd: bool = False
    list_only: bool = False
    ftp_create_dirs: bool = False
    mail_from: Optional[str] = None
    mail_rcpt: List[str] = field(default_factory=list)
    mail_rcpt_allow_fails: bool = False
    mqtt_qos: Optional[int] = None
    mqtt_retain: bool = False


def _scan_options(tokens: List[str], warnings: List[ParseWarning]) -> _Scanned:
    o = _Scanned()
    i = 0
    n = len(tokens)

    def nxt() -> Optional[str]:
        return tokens[i + 1] if i + 1 < n else None

    while i < n:
        t = tokens[i]
        if t in ("-u", "--user"):
            o.user = nxt(); i += 1
        elif t in ("-T", "--upload-file"):
            o.upload = nxt(); i += 1
        elif t in ("-o", "--output"):
            o.output = nxt(); i += 1
        elif t in ("-d", "--data", "--data-raw", "--data-binary", "--data-ascii"):
            v = nxt(); i += 1
            if v is not None:
                o.data.append(v)
        elif t in ("-H", "--header"):
            v = nxt(); i += 1
            if v is not None:
                colon = v.find(":")
                if colon > 0:
                    o.headers.append((v[:colon].strip(), v[colon + 1 :].strip()))
        elif t in ("-Q", "--quote"):
            v = nxt(); i += 1
            if v is not None:
                o.quote.append(v)
        elif t in ("-r", "--range"):
            o.range = nxt(); i += 1
        elif t in ("-m", "--max-time"):
            v = nxt(); i += 1
            if v:
                o.max_time_ms = round(float(v) * 1000)
        elif t == "--connect-timeout":
            v = nxt(); i += 1
            if v:
                o.connect_timeout_ms = round(float(v) * 1000)
        elif t in ("-k", "--insecure"):
            o.insecure = True
        elif t == "--ssl":
            o.ssl = True
        elif t == "--ssl-reqd":
            o.ssl_reqd = True
        elif t in ("-l", "--list-only"):
            o.list_only = True
        elif t == "--ftp-create-dirs":
            o.ftp_create_dirs = True
        elif t == "--mail-from":
            o.mail_from = nxt(); i += 1
        elif t == "--mail-rcpt":
            v = nxt(); i += 1
            if v is not None:
                o.mail_rcpt.append(v)
        elif t == "--mail-rcpt-allowfails":
            o.mail_rcpt_allow_fails = True
        elif t == "--retain":
            o.mqtt_retain = True
        elif t == "--qos":
            v = nxt(); i += 1
            if v:
                o.mqtt_qos = int(v)
        elif t == "--url":
            i += 1
        else:
            if t in VALUE_OPTIONS:
                i += 1
        i += 1
    return o


def _build_protocol_request(scheme: str, raw_url: str, tokens: List[str], var_ctx, warnings: List[ParseWarning]) -> ProtocolRequest:
    o = _scan_options(tokens, warnings)
    host, port, path, user_url, pass_url = _dissect_url(scheme, raw_url)

    if o.user:
        username = o.user.split(":")[0]
        password = o.user[o.user.find(":") + 1 :] if ":" in o.user else None
    else:
        username, password = user_url, pass_url

    secure = is_secure_scheme(scheme) or o.ssl_reqd

    direction = "download"
    if scheme in ("smtp", "smtps"):
        direction = "send"
    elif o.upload is not None:
        direction = "upload"
    elif o.list_only:
        direction = "list"
    elif scheme in ("mqtt", "mqtts") and o.data:
        direction = "publish"
    elif scheme in ("mqtt", "mqtts"):
        direction = "subscribe"
    elif scheme in ("ws", "wss") and o.data:
        direction = "publish"
    elif scheme in ("ws", "wss"):
        direction = "subscribe"

    payload = _resolve_payload(o, scheme, direction)

    req = ProtocolRequest(
        scheme=scheme, url=raw_url, host=host, port=port if port is not None else DEFAULT_PORTS.get(scheme, 0),
        path=path, direction=direction, secure=secure, tls_opportunistic=o.ssl and not secure,
        insecure=o.insecure, username=username, password=password, payload=payload, output=o.output,
        timeout_ms=o.max_time_ms, connect_timeout_ms=o.connect_timeout_ms, range=o.range, warnings=warnings,
    )

    if scheme in ("smtp", "smtps"):
        req.smtp = SmtpOptions(from_addr=o.mail_from, recipients=o.mail_rcpt, allow_rcpt_failures=o.mail_rcpt_allow_fails)
        if not o.mail_rcpt:
            warnings.append(ParseWarning(code="missing-recipient", message="SMTP : aucun --mail-rcpt fourni, le mail n'aura pas de destinataire.", level="warning"))
    if scheme in ("ftp", "ftps"):
        req.ftp = FtpOptions(quote=o.quote, create_dirs=o.ftp_create_dirs, list_only=o.list_only)
    if scheme in ("mqtt", "mqtts"):
        req.mqtt = MqttOptions(qos=o.mqtt_qos or 0, retain=o.mqtt_retain)
    if scheme in ("ws", "wss"):
        subprotocols: List[str] = []
        other_headers: List[Tuple[str, str]] = []
        for n, v in o.headers:
            if n.lower() == "sec-websocket-protocol":
                subprotocols.extend(s.strip() for s in v.split(",") if s.strip())
            else:
                other_headers.append((n, v))
        req.ws = WsOptions(subprotocols=subprotocols, messages=o.data)
        req.headers = other_headers

    warnings.extend(variable_warnings(var_ctx))
    return req


def _resolve_payload(o: _Scanned, scheme: str, direction: str) -> Optional[Payload]:
    if o.upload is not None:
        up = o.upload[1:] if o.upload.startswith("@") else o.upload
        return Payload(file_path=up)
    if scheme in ("ws", "wss"):
        return None
    if o.data and (direction in ("send", "publish") or scheme == "tftp"):
        for d in o.data:
            if d.startswith("@"):
                return Payload(file_path=d[1:])
        return Payload(text="".join(o.data))
    return None


def _dissect_url(scheme: str, raw_url: str):
    if scheme == "file":
        m = re.match(r"^file://([^/]*)(/.*)?$", raw_url)
        host = m.group(1) if m else ""
        path = (m.group(2) if m and m.group(2) else (raw_url[len("file:") :] if raw_url.startswith("file:") else raw_url))
        return ("" if host == "localhost" else host, None, path, None, None)

    m = re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://([^/]*)(/.*)?$", raw_url)
    authority = m.group(1) if m else ""
    path = m.group(2) if m and m.group(2) else ""

    userinfo = ""
    hostport = authority
    at = authority.rfind("@")
    if at != -1:
        userinfo = authority[:at]
        hostport = authority[at + 1 :]

    host = hostport
    port: Optional[int] = None
    v6 = re.match(r"^\[([^\]]+)\](?::(\d+))?$", hostport)
    if v6:
        host = v6.group(1)
        port = int(v6.group(2)) if v6.group(2) else None
    else:
        colon = hostport.rfind(":")
        if colon != -1 and hostport[colon + 1 :].isdigit():
            host = hostport[:colon]
            port = int(hostport[colon + 1 :])

    user_url = pass_url = None
    if userinfo:
        c = userinfo.find(":")
        user_url = unquote(userinfo if c == -1 else userinfo[:c])
        if c != -1:
            pass_url = unquote(userinfo[c + 1 :])

    return host, port, path, user_url, pass_url
