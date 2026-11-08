"""Adaptateur SMB / SMBS : lire/écrire un fichier d'un partage, ou lister un
dossier, via smbprotocol (extra PyPI : pip install "urban-http[smb]").
Client injectable via ctx.client_factory (tests).
"""
from __future__ import annotations

from typing import List

from .types import ProtocolContext, ProtocolRequest, ProtocolResult


def _split_share_path(path: str):
    clean = path.lstrip("/")
    slash = clean.find("/")
    if slash == -1:
        return clean, ""
    return clean[:slash], clean[slash + 1 :]


class _DefaultSmbClient:
    def __init__(self, server, port, share, username, password):
        self._server = server
        self._port = port
        self._share = share
        self._username = username
        self._password = password
        self._registered = False

    def _unc(self, file_path: str) -> str:
        p = file_path.replace("/", "\\")
        return rf"\\{self._server}\{self._share}\{p}"

    def _ensure(self):
        try:
            import smbclient
        except ImportError as e:
            raise RuntimeError('SMB nécessite smbprotocol : pip install "urban-http[smb]"') from e
        if not self._registered:
            smbclient.register_session(self._server, username=self._username, password=self._password, port=self._port)
            self._registered = True
        return smbclient

    def read_file(self, path: str) -> bytes:
        smbclient = self._ensure()
        with smbclient.open_file(self._unc(path), mode="rb") as f:
            return f.read()

    def write_file(self, path: str, data: bytes):
        smbclient = self._ensure()
        with smbclient.open_file(self._unc(path), mode="wb") as f:
            f.write(data)

    def readdir(self, path: str) -> List[str]:
        smbclient = self._ensure()
        base = rf"\\{self._server}\{self._share}"
        if path:
            base += "\\" + path.replace("/", "\\")
        return smbclient.listdir(base)

    def disconnect(self):
        pass


class _SmbAdapter:
    name = "smb"
    schemes = ["smb", "smbs"]

    def execute(self, req: ProtocolRequest, ctx: ProtocolContext) -> ProtocolResult:
        issues: List[str] = []
        share, file_path = _split_share_path(req.path)
        if not share:
            raise ValueError("SMB : URL sans partage (smb://serveur/partage/fichier).")

        if ctx.client_factory:
            client = ctx.client_factory({"server": req.host, "port": req.port, "share": share, "username": req.username, "password": req.password})
        else:
            client = _DefaultSmbClient(req.host, req.port, share, req.username, req.password)
        try:
            if req.direction == "list":
                names = client.readdir(file_path)
                return ProtocolResult(scheme=req.scheme, ok=True, summary=f"{len(names)} entrée(s) dans {share}/{file_path}", body="\n".join(names).encode(), meta={"share": share, "path": file_path, "entries": names}, issues=issues)
            if req.direction == "upload":
                if req.payload and req.payload.file_path:
                    d = ctx.read_file(req.payload.file_path) if ctx.read_file else open(req.payload.file_path, "rb").read()
                    data = d.encode() if isinstance(d, str) else d
                else:
                    data = (req.payload.text or "").encode() if req.payload else b""
                client.write_file(file_path, data)
                return ProtocolResult(scheme=req.scheme, ok=True, summary=f"{len(data)} octets écrits dans {share}/{file_path}", meta={"share": share, "path": file_path, "bytes": len(data)}, issues=issues)
            body = client.read_file(file_path)
            if req.output and req.output != "-" and ctx.write_file:
                ctx.write_file(req.output, body)
            return ProtocolResult(scheme=req.scheme, ok=True, summary=f"{len(body)} octets récupérés depuis {share}/{file_path}", body=body, meta={"share": share, "path": file_path, "bytes": len(body)}, issues=issues)
        finally:
            client.disconnect()


smb_adapter = _SmbAdapter()
