"""Sous-système des protocoles non-HTTP (SMTP, FTP, SFTP, POP3, MQTT, TFTP,
FILE, SMB, WebSocket). Compartimenté : le cœur HTTP n'en dépend pas.

Chaque protocole est un adaptateur. Ceux qui requièrent une bibliothèque tierce
l'importent à l'usage (extra PyPI) ; SMTP/FTP/POP3/TFTP/FILE n'utilisent que la
bibliothèque standard.
"""
from __future__ import annotations

from .types import (
    DEFAULT_PORTS,
    Payload,
    ProtocolAdapter,
    ProtocolContext,
    ProtocolRequest,
    ProtocolResult,
    ProtocolScheme,
    is_secure_scheme,
)
from .registry import (
    execute_protocol,
    get_protocol_adapter,
    register_protocol,
    registered_schemes,
    unregister_protocol,
)
from .parse import parse_protocol_command
from .file import file_adapter
from .smtp import smtp_adapter
from .ftp import ftp_adapter
from .sftp import sftp_adapter
from .pop3 import pop3_adapter
from .mqtt import mqtt_adapter
from .tftp import tftp_adapter
from .smb import smb_adapter
from .ws import ws_adapter
from .imap import imap_adapter
from .scp import scp_adapter

_ALL_ADAPTERS = [
    file_adapter, smtp_adapter, ftp_adapter, sftp_adapter, pop3_adapter,
    mqtt_adapter, tftp_adapter, smb_adapter, ws_adapter, imap_adapter, scp_adapter,
]


def register_default_adapters() -> None:
    """Enregistre tous les adaptateurs de référence."""
    for adapter in _ALL_ADAPTERS:
        register_protocol(adapter)


__all__ = [
    "DEFAULT_PORTS", "Payload", "ProtocolAdapter", "ProtocolContext", "ProtocolRequest",
    "ProtocolResult", "ProtocolScheme", "is_secure_scheme", "execute_protocol",
    "get_protocol_adapter", "register_protocol", "registered_schemes", "unregister_protocol",
    "parse_protocol_command", "register_default_adapters",
    "file_adapter", "smtp_adapter", "ftp_adapter", "sftp_adapter", "pop3_adapter",
    "mqtt_adapter", "tftp_adapter", "smb_adapter", "ws_adapter", "imap_adapter", "scp_adapter",
]
