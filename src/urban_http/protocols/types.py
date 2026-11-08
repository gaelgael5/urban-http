"""Modèle et interface des adaptateurs de protocole non-HTTP.

Une requête est toujours pilotée par la commande : un adaptateur exécute une
seule opération explicite (envoyer ce mail, téléverser ce fichier, publier ce
message), jamais de découverte ni d'itération implicite.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Protocol, Union

from ..model import ParseWarning

ProtocolScheme = str  # "smtp", "ftp", "sftp", "pop3", "mqtt", "tftp", "file", "smb", "ws", ...

DEFAULT_PORTS: Dict[str, int] = {
    "smtp": 25, "smtps": 465, "ftp": 21, "ftps": 990, "sftp": 22,
    "pop3": 110, "pop3s": 995, "mqtt": 1883, "mqtts": 8883, "tftp": 69,
    "file": 0, "smb": 445, "smbs": 445, "ws": 80, "wss": 443,
    "imap": 143, "imaps": 993, "scp": 22,
}

_SECURE = {"smtps", "ftps", "pop3s", "mqtts", "smbs", "wss", "imaps"}


def is_secure_scheme(scheme: str) -> bool:
    return scheme in _SECURE


@dataclass
class Payload:
    text: Optional[str] = None
    file_path: Optional[str] = None


@dataclass
class SmtpOptions:
    from_addr: Optional[str] = None
    recipients: List[str] = field(default_factory=list)
    allow_rcpt_failures: bool = False


@dataclass
class FtpOptions:
    quote: List[str] = field(default_factory=list)
    create_dirs: bool = False
    list_only: bool = False


@dataclass
class MqttOptions:
    qos: int = 0
    retain: bool = False


@dataclass
class WsOptions:
    subprotocols: List[str] = field(default_factory=list)
    messages: List[str] = field(default_factory=list)


@dataclass
class ImapOptions:
    # Dossier (mailbox) sélectionné, ex: "INBOX".
    mailbox: str = "INBOX"
    # UID du message à récupérer, si précisé (imap://h/INBOX/42) ; sinon on liste.
    uid: Optional[int] = None


@dataclass
class ProtocolRequest:
    scheme: str
    url: str
    host: str
    port: int
    path: str
    direction: str  # download | upload | send | list | publish | subscribe
    secure: bool = False
    tls_opportunistic: bool = False
    insecure: bool = False
    username: Optional[str] = None
    password: Optional[str] = None
    payload: Optional[Payload] = None
    output: Optional[str] = None
    timeout_ms: Optional[int] = None
    connect_timeout_ms: Optional[int] = None
    range: Optional[str] = None
    headers: Optional[List] = None
    smtp: Optional[SmtpOptions] = None
    ftp: Optional[FtpOptions] = None
    mqtt: Optional[MqttOptions] = None
    ws: Optional[WsOptions] = None
    imap: Optional[ImapOptions] = None
    warnings: List[ParseWarning] = field(default_factory=list)


@dataclass
class ProtocolResult:
    scheme: str
    ok: bool
    summary: str
    body: Optional[bytes] = None
    meta: Dict[str, Any] = field(default_factory=dict)
    issues: List[str] = field(default_factory=list)


@dataclass
class ProtocolContext:
    read_file: Optional[Callable[[str], Union[bytes, str]]] = None
    write_file: Optional[Callable[[str, bytes], None]] = None
    client_factory: Optional[Any] = None


class ProtocolAdapter(Protocol):
    name: str
    schemes: List[str]

    def execute(self, req: ProtocolRequest, ctx: ProtocolContext) -> ProtocolResult:
        ...
