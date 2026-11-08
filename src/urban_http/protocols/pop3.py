"""Adaptateur POP3 / POP3S : lister les messages ou en récupérer un, via poplib
(bibliothèque standard, aucune dépendance). Client injectable via ctx.client_factory.
"""
from __future__ import annotations

import re
from typing import List

from .types import ProtocolContext, ProtocolRequest, ProtocolResult


class _DefaultPop3Client:
    def __init__(self, req: ProtocolRequest):
        self._req = req
        self._pop = None

    def connect(self):
        import poplib
        import ssl as ssl_mod
        req = self._req
        timeout = (req.connect_timeout_ms or req.timeout_ms or 30000) / 1000
        if req.secure:
            ctx = ssl_mod._create_unverified_context() if req.insecure else ssl_mod.create_default_context()
            pop = poplib.POP3_SSL(req.host, req.port, timeout=timeout, context=ctx)
        else:
            pop = poplib.POP3(req.host, req.port, timeout=timeout)
        if req.username:
            pop.user(req.username)
            pop.pass_(req.password or "")
        self._pop = pop

    def listing(self) -> str:
        resp, lines, _ = self._pop.list()
        return (resp.decode() if isinstance(resp, bytes) else resp) + "\n" + "\n".join(l.decode() if isinstance(l, bytes) else l for l in lines)

    def retrieve(self, msg: int) -> str:
        _, lines, _ = self._pop.retr(msg)
        return "\n".join(l.decode("utf-8", "replace") if isinstance(l, bytes) else l for l in lines)

    def quit(self):
        if self._pop:
            try:
                self._pop.quit()
            except Exception:  # noqa: BLE001
                pass


class _Pop3Adapter:
    name = "pop3"
    schemes = ["pop3", "pop3s"]

    def execute(self, req: ProtocolRequest, ctx: ProtocolContext) -> ProtocolResult:
        issues: List[str] = []
        client = ctx.client_factory(req) if ctx.client_factory else _DefaultPop3Client(req)
        client.connect()
        try:
            m = re.match(r"^/?(\d+)$", req.path.lstrip("/"))
            if m:
                num = int(m.group(1))
                message = client.retrieve(num)
                body = message.encode()
                if req.output and req.output != "-" and ctx.write_file:
                    ctx.write_file(req.output, body)
                return ProtocolResult(scheme=req.scheme, ok=True, summary=f"Message {num} récupéré ({len(body)} octets)", body=body, meta={"message": num, "bytes": len(body)}, issues=issues)

            listing = client.listing()
            return ProtocolResult(scheme=req.scheme, ok=True, summary="Liste des messages récupérée", body=listing.encode(), meta={"list": listing}, issues=issues)
        finally:
            client.quit()


pop3_adapter = _Pop3Adapter()
