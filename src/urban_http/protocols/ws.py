"""Adaptateur WebSocket (ws:// et wss://) : ouvre la connexion, envoie chaque
message -d, lit la première réponse, referme. Via websockets (extra PyPI :
pip install "urban-http[websocket]"). Client injectable via ctx.client_factory.

Note : contrairement à Node, Python n'a pas de client WebSocket dans la
bibliothèque standard, d'où l'extra.
"""
from __future__ import annotations

from typing import List

from .types import ProtocolContext, ProtocolRequest, ProtocolResult


def _to_bytes(data) -> bytes:
    return data.encode() if isinstance(data, str) else data


class _DefaultWsClient:
    def __init__(self):
        self._conn = None

    def connect(self, url: str, subprotocols: List[str], timeout_ms: int):
        try:
            from websockets.sync.client import connect
        except ImportError as e:
            raise RuntimeError('WebSocket nécessite websockets : pip install "urban-http[websocket]"') from e
        kwargs = {"open_timeout": timeout_ms / 1000}
        if subprotocols:
            kwargs["subprotocols"] = subprotocols
        self._conn = connect(url, **kwargs)

    def send(self, message: str):
        self._conn.send(message)

    def recv(self, timeout_ms: int):
        return self._conn.recv(timeout=timeout_ms / 1000)

    def close(self):
        if self._conn:
            try:
                self._conn.close()
            except Exception:  # noqa: BLE001
                pass


class _WsAdapter:
    name = "ws"
    schemes = ["ws", "wss"]

    def execute(self, req: ProtocolRequest, ctx: ProtocolContext) -> ProtocolResult:
        issues: List[str] = []
        if req.headers:
            issues.append("En-têtes de poignée de main ignorés : seuls les sous-protocoles sont pris en charge.")

        subprotocols = req.ws.subprotocols if req.ws else []
        messages = req.ws.messages if req.ws else []
        timeout_ms = req.timeout_ms or 30000

        client = ctx.client_factory() if ctx.client_factory else _DefaultWsClient()
        client.connect(req.url, subprotocols, timeout_ms)
        try:
            for m in messages:
                client.send(m)
            if not messages:
                issues.append("Connexion ouverte sans message à envoyer : lecture du premier message reçu.")

            body = None
            try:
                received = client.recv(timeout_ms)
                body = _to_bytes(received)
            except Exception:  # noqa: BLE001
                if messages:
                    issues.append("Aucune réponse reçue dans le délai imparti après l'envoi.")
                else:
                    issues.append("Délai d'attente atteint sans message.")

            if body is not None and req.output and req.output != "-" and ctx.write_file:
                ctx.write_file(req.output, body)

            summary = (
                f"Réponse reçue ({len(body)} octets)" + (f" après {len(messages)} message(s) envoyé(s)" if messages else "")
                if body is not None
                else f"{len(messages)} message(s) envoyé(s), aucune réponse"
            )
            return ProtocolResult(scheme=req.scheme, ok=True, summary=summary, body=body, meta={"messages_sent": len(messages), "subprotocols": subprotocols, "received": 1 if body is not None else 0}, issues=issues)
        finally:
            client.close()


ws_adapter = _WsAdapter()
