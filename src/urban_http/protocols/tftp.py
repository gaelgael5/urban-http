"""Adaptateur TFTP : récupérer/envoyer un fichier via UDP (socket, bibliothèque
standard, aucune dépendance). Mode octet, blocs de 512 octets.
Client injectable via ctx.client_factory (tests).
"""
from __future__ import annotations

from typing import List

from .types import ProtocolContext, ProtocolRequest, ProtocolResult

BLOCK_SIZE = 512
OP_RRQ, OP_WRQ, OP_DATA, OP_ACK, OP_ERROR = 1, 2, 3, 4, 5


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


def _req_packet(opcode: int, filename: str) -> bytes:
    return bytes([0, opcode]) + filename.encode("ascii") + b"\x00octet\x00"


class _DefaultTftpClient:
    def download(self, host: str, port: int, filename: str, timeout_ms: int) -> bytes:
        import socket
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(timeout_ms / 1000)
        try:
            sock.sendto(_req_packet(OP_RRQ, filename), (host, port))
            chunks: List[bytes] = []
            expected = 1
            while True:
                data, addr = sock.recvfrom(4 + BLOCK_SIZE)
                opcode = int.from_bytes(data[:2], "big")
                if opcode == OP_ERROR:
                    raise RuntimeError(_tftp_error(data))
                if opcode != OP_DATA:
                    continue
                block = int.from_bytes(data[2:4], "big")
                if block == expected:
                    payload = data[4:]
                    chunks.append(payload)
                    sock.sendto(bytes([0, OP_ACK]) + block.to_bytes(2, "big"), addr)
                    expected += 1
                    if len(payload) < BLOCK_SIZE:
                        break
            return b"".join(chunks)
        finally:
            sock.close()

    def upload(self, data: bytes, host: str, port: int, filename: str, timeout_ms: int) -> int:
        import socket
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(timeout_ms / 1000)
        try:
            sock.sendto(_req_packet(OP_WRQ, filename), (host, port))
            total_blocks = len(data) // BLOCK_SIZE + 1
            last_sent = 0
            while True:
                packet, addr = sock.recvfrom(4 + BLOCK_SIZE)
                opcode = int.from_bytes(packet[:2], "big")
                if opcode == OP_ERROR:
                    raise RuntimeError(_tftp_error(packet))
                if opcode != OP_ACK:
                    continue
                acked = int.from_bytes(packet[2:4], "big")
                if acked != last_sent:
                    continue
                if acked == total_blocks:
                    return len(data)
                nxt = acked + 1
                start = (nxt - 1) * BLOCK_SIZE
                chunk = data[start : start + BLOCK_SIZE]
                sock.sendto(bytes([0, OP_DATA]) + nxt.to_bytes(2, "big") + chunk, addr)
                last_sent = nxt
        finally:
            sock.close()


def _tftp_error(packet: bytes) -> str:
    code = int.from_bytes(packet[2:4], "big")
    end = packet.find(b"\x00", 4)
    text = packet[4:end].decode("ascii", "replace")
    return f"erreur TFTP {code} : {text}"


class _TftpAdapter:
    name = "tftp"
    schemes = ["tftp"]

    def execute(self, req: ProtocolRequest, ctx: ProtocolContext) -> ProtocolResult:
        issues: List[str] = []
        filename = req.path.lstrip("/")
        if not filename:
            raise ValueError("TFTP : aucun nom de fichier dans l'URL.")
        timeout_ms = req.timeout_ms or 10000
        client = ctx.client_factory() if ctx.client_factory else _DefaultTftpClient()

        if req.direction == "upload":
            data = _read_bytes(req, ctx)
            sent = client.upload(data, req.host, req.port, filename, timeout_ms)
            return ProtocolResult(scheme="tftp", ok=True, summary=f"{sent} octets envoyés vers {filename}", meta={"filename": filename, "bytes": sent}, issues=issues)

        body = client.download(req.host, req.port, filename, timeout_ms)
        if req.output and req.output != "-" and ctx.write_file:
            ctx.write_file(req.output, body)
        return ProtocolResult(scheme="tftp", ok=True, summary=f"{len(body)} octets récupérés depuis {filename}", body=body, meta={"filename": filename, "bytes": len(body)}, issues=issues)


tftp_adapter = _TftpAdapter()
