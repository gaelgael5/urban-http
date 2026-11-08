"""Connexions HTTP personnalisées et limitation de débit, sur la bibliothèque
standard : socket Unix (--unix-socket), redirection de connexion (--resolve,
--connect-to) et plafonnement du débit de lecture (--limit-rate).
"""
from __future__ import annotations

import http.client
import socket
import time
import urllib.request
from typing import Dict, Optional, Tuple


# --------------------------------------------------------------------------
# --limit-rate : plafonne le débit de lecture
# --------------------------------------------------------------------------

class RateLimiter:
    """Plafonne un débit en octets/seconde par petites pauses. `sleep` est
    injectable pour les tests (pas d'attente réelle).
    """

    def __init__(self, rate_bytes_per_sec: int, sleep=time.sleep, now=time.monotonic):
        self.rate = max(1, rate_bytes_per_sec)
        self._sleep = sleep
        self._now = now
        self._start = now()
        self._sent = 0

    def account(self, n: int) -> None:
        """Comptabilise n octets transférés et attend si l'on va trop vite."""
        self._sent += n
        expected = self._sent / self.rate            # temps minimal pour ce volume
        elapsed = self._now() - self._start
        if expected > elapsed:
            self._sleep(expected - elapsed)


def read_limited(fp, rate: int, chunk: int = 8192, sleep=time.sleep, now=time.monotonic) -> bytes:
    """Lit entièrement un flux en respectant un débit maximal (octets/seconde)."""
    limiter = RateLimiter(rate, sleep=sleep, now=now)
    parts = []
    while True:
        block = fp.read(chunk)
        if not block:
            break
        parts.append(block)
        limiter.account(len(block))
    return b"".join(parts)


# --------------------------------------------------------------------------
# Redirection de connexion : --resolve et --connect-to
# --------------------------------------------------------------------------

def parse_resolve(entry: str) -> Optional[Tuple[str, int, str]]:
    """'[+]host:port:addr' → (host, port, addr). Le préfixe '+' de curl est ignoré."""
    if entry.startswith("+"):
        entry = entry[1:]
    # addr peut être une IPv6 avec des ':', donc on découpe en 3 au maximum par la gauche
    first = entry.find(":")
    second = entry.find(":", first + 1)
    if first == -1 or second == -1:
        return None
    host = entry[:first]
    port_s = entry[first + 1 : second]
    addr = entry[second + 1 :]
    if not port_s.isdigit() or not addr:
        return None
    return host, int(port_s), addr


def parse_connect_to(entry: str) -> Optional[Tuple[str, str, str, str]]:
    """'host1:port1:host2:port2' → (host1, port1, host2, port2) ; champ vide = inchangé."""
    parts = entry.split(":")
    if len(parts) != 4:
        return None
    return parts[0], parts[1], parts[2], parts[3]


def build_connection_overrides(resolve, connect_to) -> Dict[Tuple[str, int], Tuple[str, int]]:
    """Construit une table (host, port) → (host_cible, port_cible)."""
    overrides: Dict[Tuple[str, int], Tuple[str, int]] = {}
    for entry in connect_to or []:
        parsed = parse_connect_to(entry)
        if not parsed:
            continue
        h1, p1, h2, p2 = parsed
        if not p1.isdigit():
            continue
        tgt_host = h2 or h1
        tgt_port = int(p2) if p2.isdigit() else int(p1)
        overrides[(h1, int(p1))] = (tgt_host, tgt_port)
    for entry in resolve or []:
        parsed = parse_resolve(entry)
        if not parsed:
            continue
        host, port, addr = parsed
        overrides[(host, port)] = (addr, port)
    return overrides


def make_override_handlers(overrides, ssl_context):
    """Handlers HTTP/HTTPS appliquant une table de redirection de connexion.

    On connecte à l'adresse cible tout en conservant l'hôte d'origine pour
    l'en-tête Host et le SNI TLS (comportement de curl --resolve / --connect-to).
    """

    class _ResolvingHTTP(http.client.HTTPConnection):
        def connect(self):
            target = overrides.get((self.host, self.port), (self.host, self.port))
            self.sock = self._create_connection(target, self.timeout, self.source_address)
            if self._tunnel_host:
                self._tunnel()

    class _ResolvingHTTPS(http.client.HTTPSConnection):
        def connect(self):
            target = overrides.get((self.host, self.port), (self.host, self.port))
            sock = self._create_connection(target, self.timeout, self.source_address)
            if self._tunnel_host:
                self.sock = sock
                self._tunnel()
                server_hostname = self._tunnel_host
            else:
                server_hostname = self.host  # SNI et Host restent l'hôte d'origine
            self.sock = self._context.wrap_socket(sock, server_hostname=server_hostname)

    class _HTTPHandler(urllib.request.HTTPHandler):
        def http_open(self, req):
            return self.do_open(_ResolvingHTTP, req)

    class _HTTPSHandler(urllib.request.HTTPSHandler):
        def https_open(self, req):
            def factory(host, **kwargs):
                if ssl_context is not None:
                    kwargs["context"] = ssl_context
                return _ResolvingHTTPS(host, **kwargs)
            return self.do_open(factory, req)

    return [_HTTPHandler(), _HTTPSHandler(context=ssl_context) if ssl_context else _HTTPSHandler()]


# --------------------------------------------------------------------------
# --unix-socket : connexion via un socket Unix
# --------------------------------------------------------------------------

def make_unix_socket_handler(socket_path: str):
    """Handler HTTP dont toutes les connexions passent par un socket Unix.
    L'en-tête Host conserve l'hôte de l'URL ; seul le transport change.
    """

    class _UnixHTTPConnection(http.client.HTTPConnection):
        def __init__(self, host, **kwargs):
            kwargs.pop("context", None)
            super().__init__(host, **kwargs)
            self._unix_path = socket_path

        def connect(self):
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            if self.timeout is not None and self.timeout is not socket._GLOBAL_DEFAULT_TIMEOUT:
                sock.settimeout(self.timeout)
            sock.connect(self._unix_path)
            self.sock = sock

    class _UnixHTTPHandler(urllib.request.HTTPHandler):
        def http_open(self, req):
            return self.do_open(_UnixHTTPConnection, req)

    return _UnixHTTPHandler()
