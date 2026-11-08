"""Point d'entrée unifié : parser une commande curl quel que soit son protocole,
et l'exécuter via le bon moteur (HTTP via urllib, ou un adaptateur de protocole).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Union

from .execute import ExecuteResult, execute
from .model import HttpRequestModel, ParseWarning
from .parse import parse_curl
from .protocols.parse import parse_protocol_command
from .protocols.registry import execute_protocol
from .protocols.types import ProtocolContext, ProtocolRequest, ProtocolResult


@dataclass
class ParsedCommand:
    kind: str  # "http" | "protocol"
    warnings: List[ParseWarning] = field(default_factory=list)
    requests: List[HttpRequestModel] = field(default_factory=list)
    scheme: str = ""
    request: Optional[ProtocolRequest] = None


def parse_command(command: str, variables: Optional[Dict[str, str]] = None) -> ParsedCommand:
    """Parse une commande curl de n'importe quel protocole."""
    probe = parse_protocol_command(command, variables)
    if probe.is_http:
        result = parse_curl(command, variables)
        return ParsedCommand(kind="http", requests=result.requests, warnings=result.warnings)
    return ParsedCommand(kind="protocol", scheme=probe.scheme, request=probe.request, warnings=probe.warnings)


@dataclass
class RunResult:
    kind: str  # "http" | "protocol"
    http: Optional[ExecuteResult] = None
    protocol: Optional[ProtocolResult] = None


def run(
    command: str,
    variables: Optional[Dict[str, str]] = None,
    file_reader: Optional[Callable[[str], Union[bytes, str]]] = None,
    write_file: Optional[Callable[[str, bytes], None]] = None,
    client_factory: Optional[object] = None,
) -> RunResult:
    """Parse et exécute une commande. Pour un protocole non-HTTP, l'adaptateur
    correspondant doit être enregistré (register_default_adapters()).
    """
    parsed = parse_command(command, variables)
    if parsed.kind == "http":
        if not parsed.requests:
            raise RuntimeError("Aucune requête HTTP à exécuter.")
        return RunResult(kind="http", http=execute(parsed.requests[0], file_reader))
    if parsed.request is None:
        blocker = next((w for w in parsed.warnings if w.level == "error"), None)
        raise RuntimeError(blocker.message if blocker else f'Commande "{parsed.scheme}://" non exécutable.')
    ctx = ProtocolContext(read_file=file_reader, write_file=write_file, client_factory=client_factory)
    return RunResult(kind="protocol", protocol=execute_protocol(parsed.request, ctx))
