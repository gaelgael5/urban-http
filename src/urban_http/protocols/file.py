"""Adaptateur FILE : lecture/écriture de fichiers locaux (curl file://)."""
from __future__ import annotations

from typing import List

from .types import ProtocolContext, ProtocolRequest, ProtocolResult


def _to_bytes(data) -> bytes:
    return data.encode() if isinstance(data, str) else data


class _FileAdapter:
    name = "file"
    schemes = ["file"]

    def execute(self, req: ProtocolRequest, ctx: ProtocolContext) -> ProtocolResult:
        issues: List[str] = []

        if req.direction == "upload":
            if not req.payload:
                raise ValueError("file:// en upload sans contenu (-T) : rien à écrire.")
            if req.payload.file_path:
                data = _to_bytes(ctx.read_file(req.payload.file_path)) if ctx.read_file else open(req.payload.file_path, "rb").read()
            else:
                data = (req.payload.text or "").encode()
            if ctx.write_file:
                ctx.write_file(req.path, data)
            else:
                with open(req.path, "wb") as f:
                    f.write(data)
            return ProtocolResult(scheme="file", ok=True, summary=f"{len(data)} octets écrits dans {req.path}", meta={"path": req.path, "bytes": len(data)}, issues=issues)

        try:
            if ctx.read_file:
                body = _to_bytes(ctx.read_file(req.path))
            else:
                with open(req.path, "rb") as f:
                    body = f.read()
        except OSError as e:
            raise RuntimeError(f"file:// lecture impossible de {req.path} : {e}")

        if req.range:
            body = _apply_range(body, req.range, issues)

        if req.output and req.output != "-":
            if ctx.write_file:
                ctx.write_file(req.output, body)
            else:
                with open(req.output, "wb") as f:
                    f.write(body)
            issues.append(f"Contenu écrit dans {req.output} (-o).")

        return ProtocolResult(scheme="file", ok=True, summary=f"{len(body)} octets lus depuis {req.path}", body=body, meta={"path": req.path, "bytes": len(body)}, issues=issues)


def _apply_range(body: bytes, rng: str, issues: List[str]) -> bytes:
    import re
    m = re.match(r"^(\d*)-(\d*)$", rng.strip())
    if not m:
        issues.append(f'Plage "{rng}" ignorée (format attendu : début-fin).')
        return body
    has_start, has_end = m.group(1) != "", m.group(2) != ""
    if has_start and has_end:
        return body[int(m.group(1)) : int(m.group(2)) + 1]
    if has_start:
        return body[int(m.group(1)) :]
    if has_end:
        return body[-int(m.group(2)) :]
    return body


file_adapter = _FileAdapter()
