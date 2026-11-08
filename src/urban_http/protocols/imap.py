"""Adaptateur IMAP / IMAPS : lister les dossiers, lister les messages d'un
dossier, ou récupérer un message par UID, via imaplib (bibliothèque standard,
aucune dépendance). Client injectable via ctx.client_factory (tests).

Correspondance URL :
  imap://h/                 → liste des dossiers (mailboxes)
  imap://h/INBOX            → UIDs des messages du dossier
  imap://h/INBOX/42         → message UID 42 (RFC 822)
"""
from __future__ import annotations

from typing import List

from .types import ProtocolContext, ProtocolRequest, ProtocolResult


class _DefaultImapClient:
    def __init__(self, req: ProtocolRequest):
        self._req = req
        self._imap = None

    def connect(self):
        import imaplib
        import ssl as ssl_mod
        req = self._req
        timeout = (req.connect_timeout_ms or req.timeout_ms or 30000) / 1000
        if req.secure:
            ctx = ssl_mod._create_unverified_context() if req.insecure else ssl_mod.create_default_context()
            imap = imaplib.IMAP4_SSL(req.host, req.port, ssl_context=ctx, timeout=timeout)
        else:
            imap = imaplib.IMAP4(req.host, req.port, timeout=timeout)
        if req.username:
            imap.login(req.username, req.password or "")
        self._imap = imap

    def list_mailboxes(self) -> List[str]:
        typ, data = self._imap.list()
        out: List[str] = []
        for line in data or []:
            text = line.decode("utf-8", "replace") if isinstance(line, bytes) else str(line)
            # Format: (\HasNoChildren) "/" "INBOX" → on garde le dernier champ entre guillemets
            name = text.rsplit(' "', 1)[-1].strip().strip('"') if '"' in text else text.split()[-1]
            out.append(name)
        return out

    def list_messages(self, mailbox: str) -> List[str]:
        self._imap.select(mailbox or "INBOX", readonly=True)
        typ, data = self._imap.uid("search", None, "ALL")
        if not data or not data[0]:
            return []
        raw = data[0].decode() if isinstance(data[0], bytes) else str(data[0])
        return raw.split()

    def fetch(self, mailbox: str, uid: int) -> bytes:
        self._imap.select(mailbox or "INBOX", readonly=True)
        typ, data = self._imap.uid("fetch", str(uid), "(RFC822)")
        for part in data or []:
            if isinstance(part, tuple) and len(part) >= 2:
                return part[1]
        return b""

    def logout(self):
        if self._imap:
            try:
                self._imap.logout()
            except Exception:  # noqa: BLE001
                pass


class _ImapAdapter:
    name = "imap"
    schemes = ["imap", "imaps"]

    def execute(self, req: ProtocolRequest, ctx: ProtocolContext) -> ProtocolResult:
        issues: List[str] = []
        mailbox = req.imap.mailbox if req.imap else "INBOX"
        uid = req.imap.uid if req.imap else None
        client = ctx.client_factory(req) if ctx.client_factory else _DefaultImapClient(req)
        client.connect()
        try:
            if uid is not None:
                body = client.fetch(mailbox, uid)
                if req.output and req.output != "-" and ctx.write_file:
                    ctx.write_file(req.output, body)
                return ProtocolResult(scheme=req.scheme, ok=True, summary=f"Message UID {uid} récupéré ({len(body)} octets) dans {mailbox}", body=body, meta={"mailbox": mailbox, "uid": uid, "bytes": len(body)}, issues=issues)

            # Pas d'UID : liste des messages si un dossier est précisé, sinon des dossiers
            path_segments = [s for s in req.path.split("/") if s]
            if path_segments:
                uids = client.list_messages(mailbox)
                return ProtocolResult(scheme=req.scheme, ok=True, summary=f"{len(uids)} message(s) dans {mailbox}", body="\n".join(uids).encode(), meta={"mailbox": mailbox, "uids": uids}, issues=issues)

            mailboxes = client.list_mailboxes()
            return ProtocolResult(scheme=req.scheme, ok=True, summary=f"{len(mailboxes)} dossier(s)", body="\n".join(mailboxes).encode(), meta={"mailboxes": mailboxes}, issues=issues)
        finally:
            client.logout()


imap_adapter = _ImapAdapter()
