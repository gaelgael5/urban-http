"""Registre des adaptateurs de protocole."""
from __future__ import annotations

from typing import Dict, List, Optional

from .types import ProtocolAdapter, ProtocolContext, ProtocolRequest, ProtocolResult

_registry: Dict[str, ProtocolAdapter] = {}


def register_protocol(adapter: ProtocolAdapter) -> None:
    for scheme in adapter.schemes:
        _registry[scheme] = adapter


def unregister_protocol(scheme: str) -> None:
    _registry.pop(scheme, None)


def get_protocol_adapter(scheme: str) -> Optional[ProtocolAdapter]:
    return _registry.get(scheme)


def registered_schemes() -> List[str]:
    return list(_registry.keys())


def execute_protocol(req: ProtocolRequest, ctx: Optional[ProtocolContext] = None) -> ProtocolResult:
    adapter = _registry.get(req.scheme)
    if adapter is None:
        raise RuntimeError(
            f'Aucun adaptateur enregistré pour "{req.scheme}://". '
            "Appelez register_default_adapters() ou enregistrez un adaptateur pour ce schéma."
        )
    return adapter.execute(req, ctx or ProtocolContext())
