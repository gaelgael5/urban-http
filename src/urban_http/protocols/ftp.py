"""Adaptateur FTP / FTPS : download, upload (-T), listage (-l), commandes brutes
(-Q/--quote), via ftplib (bibliothèque standard, aucune dépendance).
Un client peut être injecté via ctx.client_factory (tests).
"""
from __future__ import annotations

import io
from typing import List

from .types import ProtocolContext, ProtocolRequest, ProtocolResult


def _read_bytes(req: ProtocolRequest, ctx: ProtocolContext) -> bytes:
    p = req.payload
    if not p:
        return b""
    if p.file_path:
        if ctx.read_file:
            d = ctx.read_file(p.file_path)
            return d.encode() if isinstance(d, str) else d
        with open(p.file_path, "rb") as f:
            return f.read()
    return (p.text or "").encode()


class _DefaultFtpClient:
    """Enrobe ftplib dans l'interface attendue par l'adaptateur."""

    def __init__(self, req: ProtocolRequest):
        self._req = req
        self._ftp = None

    def connect(self):
        import ftplib
        req = self._req
        timeout = (req.connect_timeout_ms or req.timeout_ms or 30000) / 1000
        if req.scheme == "ftps":
            ftp = ftplib.FTP_TLS()
            ftp.connect(req.host, req.port, timeout=timeout)
            ftp.login(req.username or "anonymous", req.password or "")
            ftp.prot_p()
        else:
            ftp = ftplib.FTP()
            ftp.connect(req.host, req.port, timeout=timeout)
            ftp.login(req.username or "anonymous", req.password or "")
        self._ftp = ftp

    def send_quote(self, command: str):
        resp = self._ftp.sendcmd(command)
        code = int(resp[:3]) if resp[:3].isdigit() else 0
        return code, resp

    def listing(self, path: str) -> List[str]:
        return self._ftp.nlst(path or "")

    def download(self, path: str) -> bytes:
        buf = io.BytesIO()
        self._ftp.retrbinary(f"RETR {path}", buf.write)
        return buf.getvalue()

    def upload(self, data: bytes, path: str):
        self._ftp.storbinary(f"STOR {path}", io.BytesIO(data))

    def close(self):
        if self._ftp:
            try:
                self._ftp.quit()
            except Exception:  # noqa: BLE001
                self._ftp.close()


class _FtpAdapter:
    name = "ftp"
    schemes = ["ftp", "ftps"]

    def execute(self, req: ProtocolRequest, ctx: ProtocolContext) -> ProtocolResult:
        issues: List[str] = []
        client = ctx.client_factory() if ctx.client_factory else _DefaultFtpClient(req)
        client.connect()
        try:
            quote_results = []
            for command in (req.ftp.quote if req.ftp else []):
                code, msg = client.send_quote(command)
                quote_results.append({"command": command, "code": code, "message": msg})

            if req.direction == "list":
                entries = client.listing(req.path)
                return ProtocolResult(scheme=req.scheme, ok=True, summary=f"{len(entries)} entrée(s) listée(s)", body="\n".join(entries).encode(), meta={"entries": entries, "quote": quote_results}, issues=issues)

            if req.direction == "upload":
                data = _read_bytes(req, ctx)
                client.upload(data, req.path)
                return ProtocolResult(scheme=req.scheme, ok=True, summary=f"{len(data)} octets téléversés vers {req.path}", meta={"path": req.path, "bytes": len(data), "quote": quote_results}, issues=issues)

            body = client.download(req.path)
            if req.output and req.output != "-" and ctx.write_file:
                ctx.write_file(req.output, body)
            return ProtocolResult(scheme=req.scheme, ok=True, summary=f"{len(body)} octets récupérés depuis {req.path}", body=body, meta={"path": req.path, "bytes": len(body), "quote": quote_results}, issues=issues)
        finally:
            client.close()


ftp_adapter = _FtpAdapter()
