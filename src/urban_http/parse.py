"""Parser principal : transforme les tokens d'une commande curl
en un ou plusieurs HttpRequestModel.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple
from urllib.parse import quote_plus

from .glob import GlobError, expand_curl_globs
from .model import (
    AuthSpec,
    BodySpec,
    DataItem,
    FormField,
    HttpRequestModel,
    ParseResult,
    ParseWarning,
    RequestOptions,
)
from .tokenize import tokenize_full
from .variables import create_variable_context, substitute_placeholders, variable_warnings

_SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*://")
_SCHEME_CAP = re.compile(r"^([a-zA-Z][a-zA-Z0-9+.-]*)://")


@dataclass
class _State:
    urls: List[str] = field(default_factory=list)
    explicit_method: Optional[str] = None
    head_method: bool = False
    get: bool = False
    headers: List[Tuple[str, str]] = field(default_factory=list)
    removed_headers: List[str] = field(default_factory=list)
    data_items: List[DataItem] = field(default_factory=list)
    url_query: List[str] = field(default_factory=list)
    form_fields: List[FormField] = field(default_factory=list)
    upload_file: Optional[str] = None
    auth: Optional[AuthSpec] = None
    auth_kind_override: Optional[str] = None
    cookies: List[str] = field(default_factory=list)
    cookie_files: List[str] = field(default_factory=list)
    globoff: bool = False
    user_agent: Optional[str] = None
    referer: Optional[str] = None
    range: Optional[str] = None
    json_mode: bool = False
    options: RequestOptions = field(default_factory=RequestOptions)
    warnings: List[ParseWarning] = field(default_factory=list)

    def warn(self, code: str, message: str, option: Optional[str] = None, level: str = "warning") -> None:
        self.warnings.append(ParseWarning(code=code, message=message, option=option, level=level))


Handler = Callable[["_State", str], None]


@dataclass
class _Opt:
    takes_value: bool
    handler: Handler


def parse_curl(command: str, variables: Optional[Dict[str, str]] = None) -> ParseResult:
    tok = tokenize_full(command, shell_variables=variables)
    var_ctx = create_variable_context(variables)

    variable_def_warnings: List[ParseWarning] = []
    for i in range(len(tok.tokens) - 1):
        if tok.tokens[i] == "--variable":
            _define_command_variable(tok.tokens[i + 1], var_ctx, variables, variable_def_warnings)

    tokens = [substitute_placeholders(t, var_ctx) for t in tok.tokens]

    groups: List[List[str]] = [[]]
    for t in tokens:
        if t in ("--next", "-:"):
            groups.append([])
        else:
            groups[-1].append(t)

    requests: List[HttpRequestModel] = []
    global_warnings: List[ParseWarning] = []

    for group in groups:
        if not group:
            continue
        st = _parse_group(group)
        if not st.urls:
            global_warnings.extend(st.warnings)
            continue
        requests.extend(_build_requests(st))

    if not requests:
        global_warnings.append(ParseWarning(code="no-url", message="Aucune URL trouvée dans la commande.", level="error"))

    for name in tok.unresolved_shell_variables:
        global_warnings.append(
            ParseWarning(code="unresolved-shell-variable", message=f"Variable shell ${name} non résolue : laissée telle quelle.", level="warning")
        )
    global_warnings.extend(variable_def_warnings)
    global_warnings.extend(variable_warnings(var_ctx))

    return ParseResult(requests=requests, warnings=global_warnings)


# --------------------------------------------------------------------------
# Handlers
# --------------------------------------------------------------------------

def _noop(st: "_State", v: str) -> None:
    pass


def _noop_info(label: str) -> Handler:
    def h(st: "_State", v: str) -> None:
        st.warn("cli-only-option", f"{label} : option de ligne de commande sans effet sur la requête HTTP, ignorée.", label, "info")
    return h


def _unsupported(option: str, label: str) -> Handler:
    def h(st: "_State", v: str) -> None:
        st.warn("unsupported-option", f"{option} ({label}) : non pris en charge par le SDK, option ignorée.", option)
    return h


def _protocol_option(option: str, protocol: str) -> Handler:
    def h(st: "_State", v: str) -> None:
        st.warn("unsupported-protocol-option", f"{option} : option {protocol}, hors du périmètre HTTP du SDK, ignorée.", option)
    return h


def _set_http_version(v: str) -> Handler:
    def h(st: "_State", _v: str) -> None:
        st.options.http_version = v
        st.warn("cli-only-option", f"--http{v} : version HTTP négociée par la plateforme, conservée à titre informatif.", f"--http{v}", "info")
    return h


def _partial_redirect(option: str) -> Handler:
    def h(st: "_State", v: str) -> None:
        st.warn("partial-option", f"{option} : sémantique standard des redirections, ce réglage fin n'est pas appliqué.", option, "info")
    return h


def _h_url(st: "_State", v: str) -> None:
    st.urls.append(v)


def _h_request(st: "_State", v: str) -> None:
    st.explicit_method = v.upper()


def _h_header(st: "_State", v: str) -> None:
    if v.startswith("@"):
        st.warn("unsupported-option", f"-H {v} : lecture d'en-têtes depuis un fichier non prise en charge.", "-H")
        return
    colon = v.find(":")
    semi = v.find(";")
    if colon == -1 and semi != -1 and semi == len(v) - 1:
        st.headers.append((v[:semi].strip(), ""))
        return
    if colon == -1:
        st.warn("invalid-header", f'-H "{v}" : format d\'en-tête invalide (attendu "Nom: valeur"), ignoré.', "-H")
        return
    name = v[:colon].strip()
    value = v[colon + 1 :].strip()
    if value == "":
        st.removed_headers.append(name.lower())
        return
    st.headers.append((name, value))


def _push_data(st: "_State", mode: str, v: str) -> None:
    if v.startswith("@"):
        st.data_items.append(DataItem(mode=mode, file_path=v[1:]))
    else:
        st.data_items.append(DataItem(mode=mode, value=v))


def _h_data(st: "_State", v: str) -> None:
    _push_data(st, "data", v)


def _h_data_binary(st: "_State", v: str) -> None:
    _push_data(st, "binary", v)


def _h_data_raw(st: "_State", v: str) -> None:
    st.data_items.append(DataItem(mode="raw", value=v))


def _h_json(st: "_State", v: str) -> None:
    st.json_mode = True
    _push_data(st, "binary", v)


def _h_data_urlencode(st: "_State", v: str) -> None:
    if v.startswith("@"):
        st.data_items.append(DataItem(mode="urlencode", file_path=v[1:]))
        return
    eq = v.find("=")
    at = v.find("@")
    if eq == -1 and at > 0:
        st.data_items.append(DataItem(mode="urlencode", name=v[:at], file_path=v[at + 1 :]))
        return
    if eq == 0:
        st.data_items.append(DataItem(mode="urlencode", value=v[1:]))
        return
    if eq > 0:
        st.data_items.append(DataItem(mode="urlencode", name=v[:eq], value=v[eq + 1 :]))
        return
    st.data_items.append(DataItem(mode="urlencode", value=v))


def _h_url_query(st: "_State", v: str) -> None:
    if v.startswith("+"):
        st.url_query.append(v[1:])
        return
    if v.startswith("@") or ("=" not in v and "@" in v):
        st.warn("unsupported-option", f"--url-query {v} : lecture depuis un fichier non prise en charge pour --url-query.", "--url-query")
        return
    eq = v.find("=")
    if eq == 0:
        st.url_query.append(_encode_form(v[1:]))
    elif eq > 0:
        st.url_query.append(f"{v[:eq]}={_encode_form(v[eq + 1:])}")
    else:
        st.url_query.append(_encode_form(v))


def _split_form_segments(s: str) -> List[str]:
    out: List[str] = []
    cur: List[str] = []
    in_quotes = False
    for c in s:
        if c == '"':
            in_quotes = not in_quotes
        if c == ";" and not in_quotes:
            out.append("".join(cur))
            cur = []
        else:
            cur.append(c)
    out.append("".join(cur))
    return out


def _unquote(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and s.startswith('"') and s.endswith('"'):
        return s[1:-1].replace('\\"', '"')
    return s


def _h_form(literal: bool) -> Handler:
    def h(st: "_State", v: str) -> None:
        eq = v.find("=")
        if eq == -1:
            st.warn("invalid-form", f'-F "{v}" : format invalide (attendu nom=valeur), ignoré.', "-F")
            return
        name = v[:eq]
        rest = v[eq + 1 :]
        field_obj = FormField(name=name)
        if not literal:
            segments = _split_form_segments(rest)
            rest = segments.pop(0) if segments else ""
            for seg in segments:
                parts = seg.split("=")
                attr = parts[0].strip().lower() if parts else ""
                val = _unquote("=".join(parts[1:]))
                if attr == "type":
                    field_obj.content_type = val
                elif attr == "filename":
                    field_obj.file_name = val
                elif attr == "headers":
                    st.warn("partial-option", "-F ;headers= : en-têtes de partie multipart non pris en charge, ignorés.", "-F", "info")
            rest = _unquote(rest)
            if rest.startswith("@"):
                field_obj.file_path = rest[1:]
            elif rest.startswith("<"):
                field_obj.content_from_file = rest[1:]
            else:
                field_obj.value = rest
        else:
            field_obj.value = rest
        st.form_fields.append(field_obj)
    return h


def _h_user(st: "_State", v: str) -> None:
    colon = v.find(":")
    if colon == -1:
        st.auth = AuthSpec(kind="basic", username=v, password="")
    else:
        st.auth = AuthSpec(kind="basic", username=v[:colon], password=v[colon + 1 :])


def _h_cookie(st: "_State", v: str) -> None:
    if "=" in v:
        st.cookies.append(v)
    else:
        st.cookie_files.append(v)
        st.warn("file-reference", f"-b {v} : fichier de cookies (format Netscape), lu à l'exécution ou via file_reader.", "-b", "info")


def _h_referer(st: "_State", v: str) -> None:
    if v == ";auto" or v.endswith(";auto"):
        st.warn("partial-option", "--referer ;auto : le mode automatique n'est pas reproduit, seule la valeur explicite est envoyée.", "--referer", "info")
        v = re.sub(r";auto$", "", v)
        if not v:
            return
    st.referer = v


def _h_digest(st: "_State", v: str) -> None:
    st.auth_kind_override = "digest"
    st.warn("digest-handshake", "--digest : la négociation challenge/réponse (MD5/SHA-256, qop=auth) est gérée par execute() en deux requêtes.", "--digest", "info")


def _h_proxy(st: "_State", v: str) -> None:
    st.options.proxy = v
    st.warn("node-only-option", "--proxy : appliqué via le proxy HTTP(S) de l'exécuteur ; sans effet dans un contexte restreint.", "--proxy", "info")


# --------------------------------------------------------------------------
# Tables d'options
# --------------------------------------------------------------------------

LONG_OPTIONS: Dict[str, _Opt] = {
    "url": _Opt(True, _h_url),
    "request": _Opt(True, _h_request),
    "head": _Opt(False, lambda st, v: setattr(st, "head_method", True)),
    "get": _Opt(False, lambda st, v: setattr(st, "get", True)),
    "url-query": _Opt(True, _h_url_query),
    "variable": _Opt(True, _noop),
    "expand-url": _Opt(True, _h_url),
    "expand-data": _Opt(True, _h_data),
    "expand-header": _Opt(True, _h_header),
    "header": _Opt(True, _h_header),
    "user-agent": _Opt(True, lambda st, v: setattr(st, "user_agent", v)),
    "referer": _Opt(True, _h_referer),
    "range": _Opt(True, lambda st, v: setattr(st, "range", v)),
    "compressed": _Opt(False, lambda st, v: setattr(st.options, "compressed", True)),
    "data": _Opt(True, _h_data),
    "data-ascii": _Opt(True, _h_data),
    "data-raw": _Opt(True, _h_data_raw),
    "data-binary": _Opt(True, _h_data_binary),
    "data-urlencode": _Opt(True, _h_data_urlencode),
    "json": _Opt(True, _h_json),
    "form": _Opt(True, _h_form(False)),
    "form-string": _Opt(True, _h_form(True)),
    "upload-file": _Opt(True, lambda st, v: setattr(st, "upload_file", v)),
    "user": _Opt(True, _h_user),
    "oauth2-bearer": _Opt(True, lambda st, v: setattr(st, "auth", AuthSpec(kind="bearer", token=v))),
    "basic": _Opt(False, lambda st, v: setattr(st, "auth_kind_override", "basic")),
    "digest": _Opt(False, _h_digest),
    "ntlm": _Opt(False, lambda st, v: (setattr(st, "auth_kind_override", "ntlm"), st.warn("unsupported-auth", "--ntlm : authentification NTLM non prise en charge.", "--ntlm"))),
    "negotiate": _Opt(False, lambda st, v: (setattr(st, "auth_kind_override", "negotiate"), st.warn("unsupported-auth", "--negotiate : authentification Negotiate/Kerberos non prise en charge.", "--negotiate"))),
    "anyauth": _Opt(False, _noop),
    "aws-sigv4": _Opt(True, lambda st, v: (setattr(st, "auth", AuthSpec(kind="aws-sigv4", token=v)), st.warn("unsupported-auth", "--aws-sigv4 : la signature AWS n'est pas calculée par le SDK.", "--aws-sigv4"))),
    "cookie": _Opt(True, _h_cookie),
    "cookie-jar": _Opt(True, lambda st, v: st.warn("cli-only-option", "--cookie-jar : écriture d'un fichier de cookies propre au CLI, ignorée.", "--cookie-jar", "info")),
    "junk-session-cookies": _Opt(False, _noop),
    "location": _Opt(False, lambda st, v: setattr(st.options, "follow_redirects", True)),
    "location-trusted": _Opt(False, lambda st, v: (setattr(st.options, "follow_redirects", True), st.warn("partial-option", "--location-trusted : les identifiants ne seront pas renvoyés aux hôtes de redirection.", "--location-trusted", "info"))),
    "max-redirs": _Opt(True, lambda st, v: setattr(st.options, "max_redirs", int(v))),
    "insecure": _Opt(False, lambda st, v: setattr(st.options, "insecure", True)),
    "cacert": _Opt(True, _unsupported("--cacert", "certificat CA personnalisé")),
    "cert": _Opt(True, _unsupported("--cert", "certificat client")),
    "key": _Opt(True, _unsupported("--key", "clé privée cliente")),
    "proxy": _Opt(True, _h_proxy),
    "proxy-user": _Opt(True, lambda st, v: setattr(st.options, "proxy_user", v)),
    "noproxy": _Opt(True, _noop),
    "http1.0": _Opt(False, _set_http_version("1.0")),
    "http1.1": _Opt(False, _set_http_version("1.1")),
    "http2": _Opt(False, _set_http_version("2")),
    "http2-prior-knowledge": _Opt(False, _set_http_version("2")),
    "http3": _Opt(False, _set_http_version("3")),
    "ipv4": _Opt(False, _noop),
    "ipv6": _Opt(False, _noop),
    "tlsv1.2": _Opt(False, _noop),
    "tlsv1.3": _Opt(False, _noop),
    "resolve": _Opt(True, _unsupported("--resolve", "résolution DNS personnalisée")),
    "connect-to": _Opt(True, _unsupported("--connect-to", "redirection de connexion")),
    "interface": _Opt(True, _unsupported("--interface", "interface réseau")),
    "unix-socket": _Opt(True, _unsupported("--unix-socket", "socket Unix")),
    "max-time": _Opt(True, lambda st, v: setattr(st.options, "timeout_ms", round(float(v) * 1000))),
    "connect-timeout": _Opt(True, lambda st, v: (setattr(st.options, "connect_timeout_ms", round(float(v) * 1000)), st.warn("partial-option", "--connect-timeout : pas de timeout de connexion distinct, approximé par un timeout global.", "--connect-timeout", "info"))),
    "retry": _Opt(True, lambda st, v: setattr(st.options, "retry", int(v))),
    "retry-delay": _Opt(True, lambda st, v: setattr(st.options, "retry_delay_ms", round(float(v) * 1000))),
    "retry-max-time": _Opt(True, _noop),
    "retry-all-errors": _Opt(False, _noop),
    "limit-rate": _Opt(True, _unsupported("--limit-rate", "limitation de débit")),
    "speed-limit": _Opt(True, _noop),
    "speed-time": _Opt(True, _noop),
    "keepalive-time": _Opt(True, _noop),
    "no-keepalive": _Opt(False, _noop),
    "mail-from": _Opt(True, _protocol_option("--mail-from", "SMTP (envoi de mail)")),
    "mail-rcpt": _Opt(True, _protocol_option("--mail-rcpt", "SMTP (envoi de mail)")),
    "mail-auth": _Opt(True, _protocol_option("--mail-auth", "SMTP (envoi de mail)")),
    "quote": _Opt(True, _protocol_option("-Q/--quote", "FTP/SFTP (commandes serveur)")),
    "ftp-port": _Opt(True, _protocol_option("-P/--ftp-port", "FTP (mode actif)")),
    "ftp-create-dirs": _Opt(False, _protocol_option("--ftp-create-dirs", "FTP")),
    "ftp-method": _Opt(True, _protocol_option("--ftp-method", "FTP")),
    "ftp-pasv": _Opt(False, _protocol_option("--ftp-pasv", "FTP")),
    "list-only": _Opt(False, _protocol_option("-l/--list-only", "FTP/IMAP/POP3 (listage)")),
    "telnet-option": _Opt(True, _protocol_option("-t/--telnet-option", "TELNET")),
    "tftp-blksize": _Opt(True, _protocol_option("--tftp-blksize", "TFTP")),
    "ssl": _Opt(False, _protocol_option("--ssl", "upgrade TLS des protocoles non-HTTP")),
    "ssl-reqd": _Opt(False, _protocol_option("--ssl-reqd", "upgrade TLS des protocoles non-HTTP")),
    "crlf": _Opt(False, _protocol_option("--crlf", "conversion de fins de ligne (FTP/SMTP)")),
    "netrc": _Opt(False, _unsupported("-n/--netrc", "identifiants depuis ~/.netrc")),
    "netrc-file": _Opt(True, _unsupported("--netrc-file", "identifiants depuis un fichier netrc")),
    "netrc-optional": _Opt(False, _unsupported("--netrc-optional", "identifiants depuis ~/.netrc")),
    "time-cond": _Opt(True, _unsupported("-z/--time-cond", "requête conditionnelle If-Modified-Since")),
    "etag-compare": _Opt(True, _unsupported("--etag-compare", "requête conditionnelle If-None-Match")),
    "etag-save": _Opt(True, _noop_info("--etag-save")),
    "continue-at": _Opt(True, _unsupported("-C/--continue-at", "reprise de transfert")),
    "socks4": _Opt(True, _unsupported("--socks4", "proxy SOCKS")),
    "socks4a": _Opt(True, _unsupported("--socks4a", "proxy SOCKS")),
    "socks5": _Opt(True, _unsupported("--socks5", "proxy SOCKS")),
    "socks5-hostname": _Opt(True, _unsupported("--socks5-hostname", "proxy SOCKS")),
    "parallel": _Opt(False, lambda st, v: st.warn("cli-only-option", "-Z/--parallel : le SDK renvoie toutes les requêtes, l'exécution en parallèle revient à l'application.", "-Z", "info")),
    "parallel-max": _Opt(True, _noop),
    "parallel-immediate": _Opt(False, _noop),
    "output": _Opt(True, _noop_info("--output")),
    "remote-name": _Opt(False, _noop_info("--remote-name")),
    "remote-header-name": _Opt(False, _noop_info("--remote-header-name")),
    "dump-header": _Opt(True, _noop_info("--dump-header")),
    "include": _Opt(False, _noop),
    "silent": _Opt(False, _noop),
    "show-error": _Opt(False, _noop),
    "verbose": _Opt(False, _noop),
    "progress-bar": _Opt(False, _noop),
    "no-progress-meter": _Opt(False, _noop),
    "write-out": _Opt(True, _noop_info("--write-out")),
    "trace": _Opt(True, _noop_info("--trace")),
    "trace-ascii": _Opt(True, _noop_info("--trace-ascii")),
    "fail": _Opt(False, _noop),
    "fail-with-body": _Opt(False, _noop),
    "styled-output": _Opt(False, _noop),
    "globoff": _Opt(False, lambda st, v: setattr(st, "globoff", True)),
    "config": _Opt(True, _unsupported("--config", "fichier de configuration curl")),
    "next": _Opt(False, _noop),
    "help": _Opt(False, _noop_info("--help")),
    "version": _Opt(False, _noop_info("--version")),
    "raw": _Opt(False, _noop),
    "path-as-is": _Opt(False, _noop),
    "post301": _Opt(False, _partial_redirect("--post301")),
    "post302": _Opt(False, _partial_redirect("--post302")),
    "post303": _Opt(False, _partial_redirect("--post303")),
}

SHORT_OPTIONS: Dict[str, str] = {
    "X": "request", "H": "header", "d": "data", "F": "form", "G": "get", "I": "head",
    "u": "user", "b": "cookie", "c": "cookie-jar", "j": "junk-session-cookies",
    "A": "user-agent", "e": "referer", "r": "range", "L": "location", "k": "insecure",
    "x": "proxy", "m": "max-time", "T": "upload-file", "o": "output", "O": "remote-name",
    "J": "remote-header-name", "D": "dump-header", "i": "include", "s": "silent",
    "S": "show-error", "v": "verbose", "#": "progress-bar", "f": "fail", "g": "globoff",
    "K": "config", "4": "ipv4", "6": "ipv6", "w": "write-out", "E": "cert", "U": "proxy-user",
    "Z": "parallel", "Q": "quote", "P": "ftp-port", "l": "list-only", "t": "telnet-option",
    "n": "netrc", "z": "time-cond", "C": "continue-at",
}


# --------------------------------------------------------------------------
# Boucle de parsing
# --------------------------------------------------------------------------

def _parse_group(tokens: List[str]) -> _State:
    st = _State()
    i = 0

    def next_value(option: str) -> Optional[str]:
        nonlocal i
        if i + 1 >= len(tokens):
            st.warn("missing-value", f"{option} attend une valeur mais la commande se termine.", option, "error")
            return None
        i += 1
        return tokens[i]

    while i < len(tokens):
        tok = tokens[i]

        if tok == "-":
            st.warn("unsupported-option", '"-" (lecture depuis stdin) non pris en charge.', "-")
            i += 1
            continue

        if tok.startswith("--"):
            name = tok[2:]
            inline_value: Optional[str] = None
            eq = name.find("=")
            if eq != -1 and name not in LONG_OPTIONS:
                inline_value = name[eq + 1 :]
                name = name[:eq]
            negated = False
            if name not in LONG_OPTIONS and name.startswith("no-") and name[3:] in LONG_OPTIONS:
                negated = True
                name = name[3:]
            opt = LONG_OPTIONS.get(name)
            if opt is None:
                st.warn("unknown-option", f"--{name} : option inconnue, ignorée.", f"--{name}")
                i += 1
                continue
            if negated:
                _apply_negation(st, name)
                i += 1
                continue
            if opt.takes_value:
                v = inline_value if inline_value is not None else next_value(f"--{name}")
                if v is not None:
                    opt.handler(st, v)
            else:
                opt.handler(st, "")
            i += 1
            continue

        if tok.startswith("-") and len(tok) > 1:
            j = 1
            while j < len(tok):
                ch = tok[j]
                long_name = SHORT_OPTIONS.get(ch)
                opt = LONG_OPTIONS.get(long_name) if long_name else None
                if opt is None:
                    st.warn("unknown-option", f"-{ch} : option inconnue, ignorée.", f"-{ch}")
                    j += 1
                    continue
                if opt.takes_value:
                    glued = tok[j + 1 :]
                    v = glued if glued != "" else next_value(f"-{ch}")
                    if v is not None:
                        opt.handler(st, v)
                    j = len(tok)
                else:
                    opt.handler(st, "")
                    j += 1
            i += 1
            continue

        st.urls.append(tok)
        i += 1

    return st


def _apply_negation(st: "_State", name: str) -> None:
    if name == "location":
        st.options.follow_redirects = False
    elif name == "insecure":
        st.options.insecure = False
    elif name == "compressed":
        st.options.compressed = False


# --------------------------------------------------------------------------
# Construction du modèle
# --------------------------------------------------------------------------

def _build_requests(st: "_State") -> List[HttpRequestModel]:
    out: List[HttpRequestModel] = []
    for raw_url in st.urls:
        expanded = [raw_url]
        glob_warning: Optional[ParseWarning] = None
        if not st.globoff and re.search(r"[{}\[\]]", raw_url):
            try:
                expanded = expand_curl_globs(raw_url)
            except GlobError as e:
                glob_warning = ParseWarning(
                    code="url-globbing",
                    message=f"Globbing non développé ({e}) : URL utilisée telle quelle. Utilisez -g pour désactiver le globbing.",
                    level="warning",
                )
        for url in expanded:
            warnings = list(st.warnings)
            if glob_warning:
                warnings.append(glob_warning)
            out.append(_build_one(st, url, warnings))
    return out


def _build_one(st: "_State", raw_url: str, warnings: List[ParseWarning]) -> HttpRequestModel:
    options = RequestOptions(**vars(st.options))
    headers: List[Tuple[str, str]] = []
    query: List[Tuple[str, str]] = []

    url = raw_url
    if url and not _SCHEME_RE.match(url):
        url = "http://" + url
        warnings.append(ParseWarning(code="default-scheme", message='Pas de schéma dans l\'URL : "http://" ajouté (comme curl).', level="info"))

    scheme = (_SCHEME_CAP.match(url).group(1) if _SCHEME_CAP.match(url) else "http").lower()
    if scheme not in ("http", "https"):
        warnings.append(
            ParseWarning(
                code="unsupported-protocol",
                message=f'Protocole "{scheme}://" hors périmètre : parse_curl ne produit que des appels HTTP(S). Utilisez parse_command / run pour les autres protocoles.{_protocol_hint(scheme)}',
                level="error",
            )
        )

    body: Optional[BodySpec] = None
    body_content_type: Optional[str] = None

    if st.form_fields:
        body = BodySpec(kind="multipart", parts=st.form_fields)
    elif st.upload_file:
        body = BodySpec(kind="file", file_path=st.upload_file)
    elif st.data_items and not st.get:
        resolved = _resolve_data_items(st.data_items, warnings)
        kind = "raw" if st.json_mode else "urlencoded"
        if resolved[1]:
            body = BodySpec(kind=kind, items=st.data_items, text=resolved[0])
        else:
            body = BodySpec(kind=kind, text=resolved[0])
        body_content_type = "application/json" if st.json_mode else "application/x-www-form-urlencoded"

    if st.get and st.data_items:
        resolved_text = _resolve_data_items(st.data_items, warnings)[0]
        if resolved_text:
            for pair in resolved_text.split("&"):
                eq = pair.find("=")
                if eq == -1:
                    query.append((pair, ""))
                else:
                    query.append((pair[:eq], pair[eq + 1 :]))
            url = _append_query(url, resolved_text)

    if st.url_query:
        for pair in st.url_query:
            eq = pair.find("=")
            if eq == -1:
                query.append((pair, ""))
            else:
                query.append((pair[:eq], pair[eq + 1 :]))
        url = _append_query(url, "&".join(st.url_query))

    if st.explicit_method:
        method = st.explicit_method
        if st.head_method:
            warnings.append(ParseWarning(code="method-conflict", message=f"-I et -X {st.explicit_method} utilisés ensemble : -X l'emporte (comme curl).", level="info"))
    elif st.head_method:
        method = "HEAD"
    elif st.upload_file:
        method = "PUT"
    elif body and not st.get:
        method = "POST"
    else:
        method = "GET"

    user_header_names = {n.lower() for n, _ in st.headers}
    removed = set(st.removed_headers)

    def add_generated(name: str, value: str) -> None:
        low = name.lower()
        if low in user_header_names or low in removed:
            return
        headers.append((name, value))

    if body_content_type:
        add_generated("Content-Type", body_content_type)
    if st.json_mode:
        add_generated("Accept", "application/json")
    if st.user_agent is not None:
        add_generated("User-Agent", st.user_agent)
    if st.referer:
        add_generated("Referer", st.referer)
    if st.range:
        add_generated("Range", f"bytes={st.range}" if "-" in st.range else f"bytes={st.range}-")
    if st.cookies:
        add_generated("Cookie", "; ".join(st.cookies))
    if st.options.compressed:
        add_generated("Accept-Encoding", "gzip, deflate, br")

    for n, v in st.headers:
        if n.lower() in removed:
            continue
        headers.append((n, v))

    auth = None
    if st.auth is not None:
        auth = AuthSpec(**vars(st.auth))
        if st.auth_kind_override and auth.kind == "basic":
            auth.kind = st.auth_kind_override

    return HttpRequestModel(
        method=method,
        url=url,
        query=query,
        headers=headers,
        body=body,
        auth=auth,
        cookie_files=list(st.cookie_files) if st.cookie_files else None,
        options=options,
        warnings=warnings,
    )


def _resolve_data_items(items: List[DataItem], warnings: List[ParseWarning]) -> Tuple[str, bool]:
    parts: List[str] = []
    has_files = False
    for item in items:
        if item.file_path is not None:
            has_files = True
            placeholder = f"{item.name}=@{item.file_path}" if item.name is not None else f"@{item.file_path}"
            parts.append(placeholder)
            warnings.append(ParseWarning(code="file-reference", message=f'Le corps référence le fichier "{item.file_path}" : il sera lu à l\'exécution (ou via file_reader).', level="info"))
            continue
        value = item.value or ""
        if item.mode == "urlencode":
            encoded = _encode_form(value)
            parts.append(f"{item.name}={encoded}" if item.name is not None else encoded)
        else:
            parts.append(value)
    return "&".join(parts), has_files


def _append_query(url: str, qs: str) -> str:
    if not qs or not url:
        return url
    return url + ("&" if "?" in url else "?") + qs


def _encode_form(s: str) -> str:
    return quote_plus(s)


def _protocol_hint(scheme: str) -> str:
    hints = {
        "ws": " WebSocket est pris en charge : utilisez run() / parse_command().",
        "wss": " WebSocket est pris en charge : utilisez run() / parse_command().",
        "smtp": " SMTP est pris en charge via run() (smtplib).",
        "smtps": " SMTP est pris en charge via run() (smtplib).",
        "ftp": " FTP est pris en charge via run() (ftplib).",
        "ftps": " FTPS est pris en charge via run() (ftplib).",
        "sftp": " SFTP est pris en charge via run() (extra paramiko).",
        "pop3": " POP3 est pris en charge via run() (poplib).",
        "pop3s": " POP3 est pris en charge via run() (poplib).",
        "mqtt": " MQTT est pris en charge via run() (extra paho-mqtt).",
        "tftp": " TFTP est pris en charge via run().",
        "file": " FILE est pris en charge via run().",
        "smb": " SMB est pris en charge via run() (extra smbprotocol).",
        "imap": " IMAP est pris en charge via run() (imaplib).",
        "imaps": " IMAP est pris en charge via run() (imaplib).",
        "scp": " SCP est pris en charge via run() (extra paramiko).",
    }
    return hints.get(scheme, "")


def _define_command_variable(spec: str, ctx, external, warnings: List[ParseWarning]) -> None:
    if spec.startswith("%"):
        eq = spec.find("=")
        name = spec[1:] if eq == -1 else spec[1:eq]
        fallback = None if eq == -1 else spec[eq + 1 :]
        value = (external or {}).get(name, fallback)
        if value is None:
            warnings.append(ParseWarning(code="unresolved-variable", message=f"--variable %{name} : aucune valeur fournie et pas de défaut, variable non définie.", level="warning"))
            return
        ctx.values[name] = value
        return
    eq = spec.find("=")
    if eq <= 0:
        if "@" in spec:
            warnings.append(ParseWarning(code="unsupported-option", message=f"--variable {spec} : lecture de la valeur depuis un fichier non prise en charge.", level="warning"))
        else:
            warnings.append(ParseWarning(code="invalid-variable", message=f"--variable {spec} : format invalide (attendu NOM=valeur ou %NOM).", level="warning"))
        return
    ctx.values[spec[:eq]] = spec[eq + 1 :]
