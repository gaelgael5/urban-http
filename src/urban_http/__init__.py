"""urban-http : transformer une commande curl ou une collection Postman en appel
exécutable — HTTP via la bibliothèque standard, et SMTP/FTP/SFTP/POP3/MQTT/TFTP/
FILE/SMB/WebSocket via des adaptateurs (extras PyPI pour ceux qui le nécessitent).

Exemple :
    from urban_http import parse_curl, execute

    result = parse_curl("curl -X POST https://api.example.com -d '{\\"a\\":1}'")
    resp = execute(result.requests[0]).response
    print(resp.status, resp.text())
"""
from __future__ import annotations

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
from .tokenize import tokenize, tokenize_full
from .parse import parse_curl
from .postman import is_postman_collection, parse_postman
from .variables import parse_postman_environment
from .execute import ExecuteResult, HttpResponse, PreparedRequest, auth_header, execute, prepare_request
from .glob import GlobError, expand_curl_globs
from .digest import build_digest_authorization, parse_digest_challenge
from .cookies import cookies_for_url, parse_netscape_cookies
from .command import ParsedCommand, RunResult, parse_command, run
from .openapi import CurlOperation, OperationParam, openapi_to_curl
from .protocols import (
    ProtocolContext,
    ProtocolRequest,
    ProtocolResult,
    execute_protocol,
    parse_protocol_command,
    register_default_adapters,
    register_protocol,
    registered_schemes,
    unregister_protocol,
)

__version__ = "0.1.0"

__all__ = [
    "AuthSpec", "BodySpec", "DataItem", "FormField", "HttpRequestModel", "ParseResult",
    "ParseWarning", "RequestOptions", "tokenize", "tokenize_full", "parse_curl",
    "is_postman_collection", "parse_postman", "parse_postman_environment",
    "ExecuteResult", "HttpResponse", "PreparedRequest", "auth_header", "execute", "prepare_request",
    "GlobError", "expand_curl_globs", "build_digest_authorization", "parse_digest_challenge",
    "cookies_for_url", "parse_netscape_cookies", "ParsedCommand", "RunResult", "parse_command",
    "run", "ProtocolContext", "ProtocolRequest", "ProtocolResult", "execute_protocol",
    "parse_protocol_command", "register_default_adapters", "register_protocol",
    "registered_schemes", "unregister_protocol",
    "openapi_to_curl", "CurlOperation", "OperationParam", "__version__",
]
