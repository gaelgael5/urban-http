"""Adaptateur SFTP : download, upload (-T), listage (-l), via paramiko
(extra PyPI : pip install "urban-http[sftp]"). Client injectable via client_factory.
"""
from __future__ import annotations

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


class _DefaultSftpClient:
    def __init__(self, req: ProtocolRequest):
        self._req = req
        self._transport = None
        self._sftp = None

    def connect(self):
        try:
            import paramiko
        except ImportError as e:
            raise RuntimeError('SFTP nécessite paramiko : pip install "urban-http[sftp]"') from e
        req = self._req
        self._transport = paramiko.Transport((req.host, req.port))
        self._transport.connect(username=req.username, password=req.password)
        self._sftp = paramiko.SFTPClient.from_transport(self._transport)

    def get(self, path: str) -> bytes:
        with self._sftp.open(path, "rb") as f:
            return f.read()

    def put(self, data: bytes, path: str):
        with self._sftp.open(path, "wb") as f:
            f.write(data)

    def listing(self, path: str) -> List[str]:
        return self._sftp.listdir(path or ".")

    def close(self):
        if self._sftp:
            self._sftp.close()
        if self._transport:
            self._transport.close()


class _SftpAdapter:
    name = "sftp"
    schemes = ["sftp"]

    def execute(self, req: ProtocolRequest, ctx: ProtocolContext) -> ProtocolResult:
        issues: List[str] = []
        client = ctx.client_factory() if ctx.client_factory else _DefaultSftpClient(req)
        client.connect()
        try:
            if req.direction == "list":
                entries = client.listing(req.path)
                return ProtocolResult(scheme="sftp", ok=True, summary=f"{len(entries)} entrée(s) listée(s)", body="\n".join(entries).encode(), meta={"entries": entries}, issues=issues)
            if req.direction == "upload":
                data = _read_bytes(req, ctx)
                client.put(data, req.path)
                return ProtocolResult(scheme="sftp", ok=True, summary=f"{len(data)} octets téléversés vers {req.path}", meta={"path": req.path, "bytes": len(data)}, issues=issues)
            body = client.get(req.path)
            if req.output and req.output != "-" and ctx.write_file:
                ctx.write_file(req.output, body)
            return ProtocolResult(scheme="sftp", ok=True, summary=f"{len(body)} octets récupérés depuis {req.path}", body=body, meta={"path": req.path, "bytes": len(body)}, issues=issues)
        finally:
            client.close()


sftp_adapter = _SftpAdapter()
