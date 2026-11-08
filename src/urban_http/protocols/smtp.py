"""Adaptateur SMTP / SMTPS : envoi d'un mail via smtplib (bibliothèque standard,
aucune dépendance). Un client peut être injecté via ctx.client_factory (tests).
"""
from __future__ import annotations

from typing import List

from .types import ProtocolContext, ProtocolRequest, ProtocolResult


def _read_payload(req: ProtocolRequest, ctx: ProtocolContext) -> bytes:
    if not req.payload:
        return b""
    if req.payload.file_path:
        if ctx.read_file:
            d = ctx.read_file(req.payload.file_path)
            return d.encode() if isinstance(d, str) else d
        with open(req.payload.file_path, "rb") as f:
            return f.read()
    return (req.payload.text or "").encode()


class _DefaultSmtpClient:
    """Enrobe smtplib dans l'interface attendue (connect/login/sendmail/quit)."""

    def __init__(self, req: ProtocolRequest):
        self._req = req
        self._smtp = None

    def send(self, from_addr: str, recipients: List[str], message: bytes):
        import smtplib
        import ssl as ssl_mod

        req = self._req
        timeout = (req.connect_timeout_ms or req.timeout_ms or 30000) / 1000
        if req.secure:
            ctx = ssl_mod._create_unverified_context() if req.insecure else ssl_mod.create_default_context()
            smtp = smtplib.SMTP_SSL(req.host, req.port, timeout=timeout, context=ctx)
        else:
            smtp = smtplib.SMTP(req.host, req.port, timeout=timeout)
            if req.tls_opportunistic:
                ctx = ssl_mod._create_unverified_context() if req.insecure else ssl_mod.create_default_context()
                smtp.starttls(context=ctx)
        try:
            if req.username:
                smtp.login(req.username, req.password or "")
            refused = smtp.sendmail(from_addr or "", recipients, message)
            return {"rejected": list(refused.keys()), "response": "250 message accepté"}
        finally:
            try:
                smtp.quit()
            except Exception:  # noqa: BLE001
                pass


class _SmtpAdapter:
    name = "smtp"
    schemes = ["smtp", "smtps"]

    def execute(self, req: ProtocolRequest, ctx: ProtocolContext) -> ProtocolResult:
        issues: List[str] = []
        recipients = req.smtp.recipients if req.smtp else []
        if not recipients:
            raise ValueError("SMTP : aucun destinataire (--mail-rcpt) fourni.")

        message = _read_payload(req, ctx)
        if not message.strip():
            issues.append("Corps du mail vide : fournissez -T message.txt ou -d.")

        from_addr = req.smtp.from_addr if req.smtp else None
        client = ctx.client_factory(req) if ctx.client_factory else _DefaultSmtpClient(req)
        info = client.send(from_addr or "", recipients, message)

        rejected = info.get("rejected") or []
        if rejected and not (req.smtp and req.smtp.allow_rcpt_failures):
            issues.append(f"Destinataires rejetés : {', '.join(rejected)}")

        accepted = [r for r in recipients if r not in rejected]
        return ProtocolResult(
            scheme=req.scheme,
            ok=not rejected or bool(req.smtp and req.smtp.allow_rcpt_failures),
            summary=info.get("response") or f"Mail envoyé à {', '.join(accepted)}",
            meta={"from": from_addr, "accepted": accepted, "rejected": rejected},
            issues=issues,
        )


smtp_adapter = _SmtpAdapter()
