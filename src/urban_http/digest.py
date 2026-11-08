"""Authentification HTTP Digest (RFC 2617 / RFC 7616) :
parsing du challenge WWW-Authenticate et construction de l'en-tête Authorization.

Algorithmes : MD5, MD5-sess, SHA-256, SHA-256-sess, avec qop="auth" ou sans qop
(RFC 2069). qop="auth-int" n'est pas pris en charge.
"""
from __future__ import annotations

import hashlib
import re
import secrets
from dataclasses import dataclass
from typing import Callable, Dict, Optional

_PARAM = re.compile(r'([a-zA-Z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))')


@dataclass
class DigestChallenge:
    realm: str
    nonce: str
    qop: Optional[str] = None
    opaque: Optional[str] = None
    algorithm: Optional[str] = None
    stale: bool = False


def parse_digest_challenge(header: str) -> Optional[DigestChallenge]:
    idx = re.search(r"(^|[,\s])digest\s", header, re.IGNORECASE)
    if not idx:
        return None
    rest = header[header.lower().index("digest", idx.start()) + len("digest") :]

    params: Dict[str, str] = {}
    for m in _PARAM.finditer(rest):
        key = m.group(1).lower()
        if m.group(2) is not None:
            value = re.sub(r"\\(.)", r"\1", m.group(2))
        else:
            value = m.group(3) or ""
        params[key] = value

    if not params.get("realm") and not params.get("nonce"):
        return None
    return DigestChallenge(
        realm=params.get("realm", ""),
        nonce=params.get("nonce", ""),
        qop=params.get("qop"),
        opaque=params.get("opaque"),
        algorithm=params.get("algorithm"),
        stale=params.get("stale", "").lower() == "true",
    )


def build_digest_authorization(
    challenge: DigestChallenge,
    username: str,
    password: str,
    method: str,
    uri: str,
    cnonce: Optional[str] = None,
    nc: str = "00000001",
) -> Optional[str]:
    algorithm = (challenge.algorithm or "MD5").upper()
    sess = algorithm.endswith("-SESS")
    base = algorithm[:-5] if sess else algorithm

    if base == "MD5":
        hash_fn: Callable[[str], str] = lambda s: hashlib.md5(s.encode()).hexdigest()
    elif base == "SHA-256":
        hash_fn = lambda s: hashlib.sha256(s.encode()).hexdigest()
    else:
        return None

    qop: Optional[str] = None
    if challenge.qop:
        offered = [q.strip().lower() for q in challenge.qop.split(",")]
        if "auth" in offered:
            qop = "auth"
        else:
            return None

    if cnonce is None:
        cnonce = secrets.token_hex(16)

    ha1 = hash_fn(f"{username}:{challenge.realm}:{password}")
    if sess:
        ha1 = hash_fn(f"{ha1}:{challenge.nonce}:{cnonce}")
    ha2 = hash_fn(f"{method.upper()}:{uri}")

    if qop:
        response = hash_fn(f"{ha1}:{challenge.nonce}:{nc}:{cnonce}:{qop}:{ha2}")
    else:
        response = hash_fn(f"{ha1}:{challenge.nonce}:{ha2}")

    parts = [
        f'username="{_escape(username)}"',
        f'realm="{_escape(challenge.realm)}"',
        f'nonce="{_escape(challenge.nonce)}"',
        f'uri="{uri}"',
    ]
    if challenge.algorithm:
        parts.append(f"algorithm={challenge.algorithm}")
    if qop:
        parts += [f"qop={qop}", f"nc={nc}", f'cnonce="{cnonce}"']
    parts.append(f'response="{response}"')
    if challenge.opaque:
        parts.append(f'opaque="{_escape(challenge.opaque)}"')
    return "Digest " + ", ".join(parts)


def _escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')
