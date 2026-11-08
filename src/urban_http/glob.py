"""Globbing d'URL façon curl :
  {a,b,c}         alternatives
  [1-10]          plage numérique (zéro-padding si [01-10])
  [1-10:2]        plage avec pas
  [a-z] / [a-z:3] plage alphabétique
Les motifs se combinent en produit cartésien.
"""
from __future__ import annotations

import re
from typing import List

GLOB_LIMIT = 500


class GlobError(Exception):
    pass


def expand_curl_globs(url: str, limit: int = GLOB_LIMIT) -> List[str]:
    segments: List[List[str]] = []
    literal: List[str] = []
    i = 0
    n = len(url)

    def flush_literal() -> None:
        nonlocal literal
        if literal:
            segments.append(["".join(literal)])
            literal = []

    while i < n:
        c = url[i]
        if c == "{":
            end = url.find("}", i + 1)
            if end == -1:
                raise GlobError('accolade "{" non fermée dans l\'URL')
            flush_literal()
            segments.append(url[i + 1 : end].split(","))
            i = end + 1
        elif c == "[":
            end = url.find("]", i + 1)
            if end == -1:
                raise GlobError('crochet "[" non fermé dans l\'URL')
            flush_literal()
            segments.append(_expand_range(url[i + 1 : end]))
            i = end + 1
        elif c in ("}", "]"):
            raise GlobError(f'"{c}" sans ouvrant correspondant dans l\'URL')
        else:
            literal.append(c)
            i += 1
    flush_literal()

    total = 1
    for seg in segments:
        total *= len(seg)
    if total > limit:
        raise GlobError(f"le globbing produirait {total} URLs (limite du SDK : {limit})")

    results = [""]
    for seg in segments:
        results = [prefix + choice for prefix in results for choice in seg]
    return results


_NUMERIC = re.compile(r"^(\d+)-(\d+)(?::(\d+))?$")
_ALPHA = re.compile(r"^([a-zA-Z])-([a-zA-Z])(?::(\d+))?$")


def _expand_range(spec: str) -> List[str]:
    m = _NUMERIC.match(spec)
    if m:
        start_str, end_str, step_str = m.group(1), m.group(2), m.group(3)
        start, end = int(start_str), int(end_str)
        step = int(step_str) if step_str else 1
        if step <= 0 or end < start:
            raise GlobError(f"plage numérique invalide : [{spec}]")
        width = len(start_str) if start_str.startswith("0") else 0
        out: List[str] = []
        v = start
        while v <= end:
            out.append(str(v).rjust(width, "0") if width > 0 else str(v))
            v += step
        return out

    m = _ALPHA.match(spec)
    if m:
        start, end = ord(m.group(1)), ord(m.group(2))
        step = int(m.group(3)) if m.group(3) else 1
        if step <= 0 or end < start:
            raise GlobError(f"plage alphabétique invalide : [{spec}]")
        return [chr(v) for v in range(start, end + 1, step)]

    raise GlobError(f"plage invalide : [{spec}] (attendu [1-10], [01-10], [a-z], avec :pas optionnel)")
