"""Préparation et exécution d'une requête HTTP avec la bibliothèque standard
(urllib), en appliquant timeout, retries, redirections, Digest, proxy et --insecure.
"""
from __future__ import annotations

import base64
import os
import ssl
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from .cookies import cookies_for_url, parse_netscape_cookies
from .digest import build_digest_authorization, parse_digest_challenge
from .model import FileReader, HttpRequestModel

RETRYABLE_STATUS = {408, 429, 500, 502, 503, 504}


@dataclass
class PreparedRequest:
    url: str
    method: str
    headers: List[Tuple[str, str]]
    body: Optional[bytes]
    issues: List[str] = field(default_factory=list)


@dataclass
class HttpResponse:
    status: int
    reason: str
    headers: List[Tuple[str, str]]
    body: bytes
    url: str

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    def text(self, encoding: str = "utf-8") -> str:
        return self.body.decode(encoding, errors="replace")

    def header(self, name: str) -> Optional[str]:
        low = name.lower()
        for n, v in self.headers:
            if n.lower() == low:
                return v
        return None


@dataclass
class ExecuteResult:
    response: HttpResponse
    attempts: int
    issues: List[str] = field(default_factory=list)


def auth_header(req: HttpRequestModel) -> Optional[Tuple[str, str]]:
    """En-tête Authorization pour Basic/Bearer (Digest se négocie à l'exécution)."""
    if not req.auth:
        return None
    if req.auth.kind == "basic":
        cred = f"{req.auth.username or ''}:{req.auth.password or ''}"
        return ("Authorization", "Basic " + base64.b64encode(cred.encode()).decode("ascii"))
    if req.auth.kind == "bearer":
        return ("Authorization", f"Bearer {req.auth.token or ''}")
    return None


def _read_file(path: str, file_reader: Optional[FileReader], issues: List[str]) -> Optional[bytes]:
    try:
        if file_reader is not None:
            data = file_reader(path)
        else:
            with open(path, "rb") as f:
                data = f.read()
        return data.encode() if isinstance(data, str) else data
    except Exception as e:  # noqa: BLE001
        issues.append(f'Lecture du fichier "{path}" impossible : {e}')
        return None


def prepare_request(req: HttpRequestModel, file_reader: Optional[FileReader] = None) -> PreparedRequest:
    issues: List[str] = []
    headers: List[Tuple[str, str]] = list(req.headers)

    ah = auth_header(req)
    if ah and not any(n.lower() == "authorization" for n, _ in headers):
        headers.append(ah)

    # Cookies depuis fichier(s) -b
    if req.cookie_files:
        resolved: List[str] = []
        for fpath in req.cookie_files:
            content = _read_file(fpath, file_reader, issues)
            if content is None:
                continue
            cookie_str = cookies_for_url(parse_netscape_cookies(content.decode("utf-8", "replace")), req.url)
            if cookie_str:
                resolved.append(cookie_str)
        if resolved:
            existing = [v for n, v in headers if n.lower() == "cookie"]
            headers = [(n, v) for n, v in headers if n.lower() != "cookie"]
            headers.append(("Cookie", "; ".join(existing + resolved)))

    body: Optional[bytes] = None
    b = req.body
    if b:
        if b.kind == "multipart":
            body, ct = _build_multipart(b.parts or [], file_reader, issues)
            if not any(n.lower() == "content-type" for n, _ in headers):
                headers.append(("Content-Type", ct))
        elif b.kind == "file":
            body = _read_file(b.file_path, file_reader, issues) if b.file_path else None
        elif b.items and any(it.file_path for it in b.items):
            parts: List[str] = []
            for item in b.items:
                if item.file_path:
                    content = _read_file(item.file_path, file_reader, issues)
                    text = content.decode("utf-8", "replace") if content else ""
                    if item.mode == "data":
                        text = text.replace("\r", "").replace("\n", "")
                    if item.mode == "urlencode":
                        from urllib.parse import quote_plus
                        enc = quote_plus(text)
                        parts.append(f"{item.name}={enc}" if item.name is not None else enc)
                    else:
                        parts.append(text)
                elif item.mode == "urlencode":
                    from urllib.parse import quote_plus
                    enc = quote_plus(item.value or "")
                    parts.append(f"{item.name}={enc}" if item.name is not None else enc)
                else:
                    parts.append(item.value or "")
            body = "&".join(parts).encode()
        elif b.text is not None:
            body = b.text.encode()

    return PreparedRequest(url=req.url, method=req.method, headers=headers, body=body, issues=issues)


def _build_multipart(parts, file_reader, issues) -> Tuple[bytes, str]:
    boundary = "----urbanhttp" + uuid.uuid4().hex
    chunks: List[bytes] = []
    for part in parts:
        chunks.append(f"--{boundary}\r\n".encode())
        if part.file_path:
            content = _read_file(part.file_path, file_reader, issues) or b""
            filename = part.file_name or os.path.basename(part.file_path) or "file"
            ctype = part.content_type or "application/octet-stream"
            chunks.append(f'Content-Disposition: form-data; name="{part.name}"; filename="{filename}"\r\n'.encode())
            chunks.append(f"Content-Type: {ctype}\r\n\r\n".encode())
            chunks.append(content)
            chunks.append(b"\r\n")
        elif part.content_from_file:
            content = _read_file(part.content_from_file, file_reader, issues) or b""
            chunks.append(f'Content-Disposition: form-data; name="{part.name}"\r\n\r\n'.encode())
            chunks.append(content)
            chunks.append(b"\r\n")
        else:
            chunks.append(f'Content-Disposition: form-data; name="{part.name}"\r\n\r\n'.encode())
            chunks.append((part.value or "").encode())
            chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


def _build_opener(req: HttpRequestModel):
    handlers = []
    if not req.options.follow_redirects:
        handlers.append(_NoRedirect())
    if req.options.insecure:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        handlers.append(urllib.request.HTTPSHandler(context=ctx))
    if req.options.proxy:
        proxy = req.options.proxy
        if "://" not in proxy:
            proxy = "http://" + proxy
        if req.options.proxy_user and "@" not in proxy:
            scheme, rest = proxy.split("://", 1)
            proxy = f"{scheme}://{req.options.proxy_user}@{rest}"
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    return urllib.request.build_opener(*handlers)


def _do_request(opener, prepared: PreparedRequest, timeout: Optional[float]) -> HttpResponse:
    request = urllib.request.Request(prepared.url, data=prepared.body, method=prepared.method)
    for n, v in prepared.headers:
        request.add_header(n, v)
    try:
        resp = opener.open(request, timeout=timeout)
    except urllib.error.HTTPError as e:
        resp = e  # HTTPError est aussi une réponse lisible
    headers = list(resp.headers.items())
    body = resp.read()
    status = resp.getcode() if hasattr(resp, "getcode") and resp.getcode() else getattr(resp, "status", 0)
    reason = getattr(resp, "reason", "") or ""
    return HttpResponse(status=status or 0, reason=reason, headers=headers, body=body, url=prepared.url)


def execute(req: HttpRequestModel, file_reader: Optional[FileReader] = None) -> ExecuteResult:
    prepared = prepare_request(req, file_reader)
    issues = list(prepared.issues)
    opener = _build_opener(req)
    timeout = req.options.timeout_ms / 1000 if req.options.timeout_ms else None

    max_attempts = 1 + max(0, req.options.retry or 0)
    attempt = 0
    last_error: Optional[Exception] = None

    while attempt < max_attempts:
        attempt += 1
        try:
            response = _do_request(opener, prepared, timeout)
            # Négociation Digest
            if response.status == 401 and req.auth and req.auth.kind == "digest" and req.auth.username is not None:
                retried = _answer_digest(req, prepared, response, opener, timeout, issues)
                if retried is not None:
                    response = retried
            if attempt < max_attempts and response.status in RETRYABLE_STATUS:
                time.sleep(_retry_delay(req, attempt))
                continue
            return ExecuteResult(response=response, attempts=attempt, issues=issues)
        except Exception as e:  # noqa: BLE001
            last_error = e
            if attempt < max_attempts:
                time.sleep(_retry_delay(req, attempt))
                continue
            raise
    raise last_error or RuntimeError("exécution impossible")


def _answer_digest(req, prepared, response, opener, timeout, issues) -> Optional[HttpResponse]:
    challenge_header = response.header("WWW-Authenticate")
    if not challenge_header:
        issues.append("Digest : challenge WWW-Authenticate illisible.")
        return None
    challenge = parse_digest_challenge(challenge_header)
    if not challenge:
        issues.append("Digest : le serveur n'a pas renvoyé de challenge Digest exploitable.")
        return None
    from urllib.parse import urlsplit
    parts = urlsplit(prepared.url)
    uri = parts.path + (("?" + parts.query) if parts.query else "")
    authorization = build_digest_authorization(challenge, req.auth.username or "", req.auth.password or "", req.method, uri or "/")
    if not authorization:
        issues.append(f'Digest : algorithme "{challenge.algorithm or "MD5"}" / qop "{challenge.qop or ""}" non pris en charge.')
        return None
    new_headers = [(n, v) for n, v in prepared.headers if n.lower() != "authorization"]
    new_headers.append(("Authorization", authorization))
    return _do_request(opener, PreparedRequest(prepared.url, prepared.method, new_headers, prepared.body), timeout)


def _retry_delay(req: HttpRequestModel, attempt: int) -> float:
    if req.options.retry_delay_ms:
        return req.options.retry_delay_ms / 1000
    return min(1.0 * 2 ** (attempt - 1), 600.0)
