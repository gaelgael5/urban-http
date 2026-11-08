"""Gestion des variables, partagée entre le parser curl et Postman :
placeholders {{nom}}, variables dynamiques {{$guid}}... et import d'environnement
Postman. Une variable non résolue est laissée telle quelle et signalée.
"""
from __future__ import annotations

import json
import re
import secrets
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Mapping, Optional

from .model import ParseWarning

_PLACEHOLDER = re.compile(r"\{\{([^{}]+)\}\}")


@dataclass
class VariableContext:
    values: Dict[str, str] = field(default_factory=dict)
    unresolved: List[str] = field(default_factory=list)
    unsupported_dynamic: List[str] = field(default_factory=list)


def create_variable_context(*sources: Optional[Mapping[str, str]]) -> VariableContext:
    """Crée un contexte. Les dernières sources sont prioritaires."""
    values: Dict[str, str] = {}
    for source in sources:
        if not source:
            continue
        for k, v in source.items():
            values[k] = v
    return VariableContext(values=values)


def substitute_placeholders(s: str, ctx: VariableContext) -> str:
    def repl(match: "re.Match[str]") -> str:
        name = match.group(1)
        if name.startswith("$"):
            generated = _dynamic_value(name)
            if generated is not None:
                return generated
            if name not in ctx.unsupported_dynamic:
                ctx.unsupported_dynamic.append(name)
            return match.group(0)
        if name in ctx.values:
            return ctx.values[name]
        if name not in ctx.unresolved:
            ctx.unresolved.append(name)
        return match.group(0)

    return _PLACEHOLDER.sub(repl, s)


def variable_warnings(ctx: VariableContext) -> List[ParseWarning]:
    warnings: List[ParseWarning] = []
    for name in ctx.unresolved:
        warnings.append(
            ParseWarning(
                code="unresolved-variable",
                message=f"Variable {{{{{name}}}}} non résolue : passez sa valeur via variables.",
                level="warning",
            )
        )
    for name in ctx.unsupported_dynamic:
        warnings.append(
            ParseWarning(
                code="unsupported-dynamic-variable",
                message=(
                    f"Variable dynamique {{{{{name}}}}} non prise en charge "
                    "(supportées : $guid, $randomUUID, $timestamp, $isoTimestamp, $randomInt)."
                ),
                level="warning",
            )
        )
    return warnings


def _dynamic_value(name: str) -> Optional[str]:
    if name in ("$guid", "$randomUUID"):
        return str(uuid.uuid4())
    if name == "$timestamp":
        return str(int(time.time()))
    if name == "$isoTimestamp":
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"
    if name == "$randomInt":
        return str(secrets.randbelow(1001))
    return None


def parse_postman_environment(data: object) -> Dict[str, str]:
    """Lit un export d'environnement Postman ({values: [{key, value, enabled}]})
    ou un simple objet {clé: valeur}.
    """
    obj = json.loads(data) if isinstance(data, str) else data
    out: Dict[str, str] = {}
    if not isinstance(obj, dict):
        return out
    values = obj.get("values")
    if isinstance(values, list):
        for v in values:
            if not isinstance(v, dict) or v.get("key") is None or v.get("enabled") is False:
                continue
            val = v.get("value")
            out[v["key"]] = "" if val is None else str(val)
        return out
    for k, v in obj.items():
        if isinstance(v, str):
            out[k] = v
    return out
