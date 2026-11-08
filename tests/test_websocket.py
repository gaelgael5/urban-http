import pytest

from urban_http.protocols.parse import parse_protocol_command
from urban_http.protocols.types import ProtocolContext
from urban_http.protocols.ws import ws_adapter


def req_of(cmd):
    r = parse_protocol_command(cmd)
    assert r.request is not None, r.warnings
    return r.request


def dec(b):
    return b.decode() if b else None


class FakeWs:
    """Client WebSocket simulé : envoie dans .sent, répond ce qu'on lui donne."""

    def __init__(self, reply=None, error=False):
        self.sent = []
        self.closed = False
        self._reply = reply
        self._error = error
        self.subprotocols = None

    def connect(self, url, subprotocols, timeout_ms):
        self.subprotocols = subprotocols

    def send(self, message):
        self.sent.append(message)

    def recv(self, timeout_ms):
        if self._error or self._reply is None:
            raise TimeoutError("rien")
        return self._reply

    def close(self):
        self.closed = True


def test_parse_ws_ports():
    assert req_of("curl ws://echo.e.com/socket").port == 80
    s = req_of("curl wss://echo.e.com/socket")
    assert s.port == 443 and s.secure is True


def test_parse_messages_subprotocol():
    r = req_of('curl ws://echo.e.com/s -d "salut" -d "monde" -H "Sec-WebSocket-Protocol: chat, superchat"')
    assert r.direction == "publish"
    assert r.ws.messages == ["salut", "monde"]
    assert r.ws.subprotocols == ["chat", "superchat"]


def test_send_and_reply():
    fake = FakeWs(reply="pong")
    res = ws_adapter.execute(req_of('curl ws://echo.e.com/s -d "ping"'), ProtocolContext(client_factory=lambda: fake))
    assert res.ok and dec(res.body) == "pong"
    assert fake.sent == ["ping"]
    assert res.meta["messages_sent"] == 1 and fake.closed is True


def test_subprotocols_passed():
    fake = FakeWs(reply="ok")
    ws_adapter.execute(req_of('curl ws://e.com/s -H "Sec-WebSocket-Protocol: chat" -d "x"'), ProtocolContext(client_factory=lambda: fake))
    assert fake.subprotocols == ["chat"]


def test_binary_reply():
    fake = FakeWs(reply="binaire".encode())
    res = ws_adapter.execute(req_of("curl ws://e.com/s"), ProtocolContext(client_factory=lambda: fake))
    assert dec(res.body) == "binaire"


def test_no_reply():
    fake = FakeWs(reply=None)
    res = ws_adapter.execute(req_of('curl ws://e.com/s -d "x"'), ProtocolContext(client_factory=lambda: fake))
    assert res.ok and res.body is None
    assert any("Aucune réponse" in i for i in res.issues)
