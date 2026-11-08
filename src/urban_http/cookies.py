"""Lecture des fichiers de cookies au format Netscape (celui de curl -b/-c),
avec filtrage domaine / chemin / expiration / secure comme curl.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import List
from urllib.parse import urlsplit


@dataclass
class CookieEntry:
    domain: str
    include_subdomains: bool
    path: str
    secure: bool
    expires: int  # timestamp Unix en secondes ; 0 = cookie de session
    name: str
    value: str


def parse_netscape_cookies(text: str) -> List[CookieEntry]:
    entries: List[CookieEntry] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        http_only = line.startswith("#HttpOnly_")
        if http_only:
            line = line[len("#HttpOnly_") :]
        elif line.startswith("#"):
            continue

        fields = line.split("\t")
        if len(fields) >= 7:
            domain, flag, path, secure, expires, name = fields[:6]
            value = "\t".join(fields[6:])
            entries.append(
                CookieEntry(
                    domain=domain.lstrip("."),
                    include_subdomains=domain.startswith(".") or flag.upper() == "TRUE",
                    path=path or "/",
                    secure=secure.upper() == "TRUE",
                    expires=_to_int(expires),
                    name=name,
                    value=value,
                )
            )
        elif len(fields) == 1 and "=" in line and " " not in line:
            eq = line.index("=")
            entries.append(
                CookieEntry(
                    domain="",
                    include_subdomains=True,
                    path="/",
                    secure=False,
                    expires=0,
                    name=line[:eq],
                    value=line[eq + 1 :],
                )
            )
    return entries


def cookies_for_url(entries: List[CookieEntry], url: str, now: float = None) -> str:
    """Cookies applicables à une URL, au format "nom=valeur; ...". now en secondes."""
    if now is None:
        now = time.time()
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
        path = parts.path or "/"
        is_https = parts.scheme == "https"
    except ValueError:
        return ""

    selected: List[str] = []
    for e in entries:
        if e.expires != 0 and e.expires < now:
            continue
        if e.secure and not is_https:
            continue
        if e.domain:
            domain = e.domain.lower()
            matches = host == domain or (e.include_subdomains and host.endswith("." + domain))
            if not matches:
                continue
        if e.path and e.path != "/":
            prefix = e.path if e.path.endswith("/") else e.path + "/"
            if not (path == e.path or path.startswith(prefix)):
                continue
        if e.name:
            selected.append(f"{e.name}={e.value}")
    return "; ".join(selected)


def _to_int(s: str) -> int:
    try:
        return int(s)
    except (ValueError, TypeError):
        return 0
