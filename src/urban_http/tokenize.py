"""Découpe une ligne de commande shell en tokens, comme le ferait bash.

Pris en charge :
- quotes simples '...' (littérales)
- quotes doubles "..." avec échappements \\" \\\\ \\$ \\`
- backslash hors quotes (échappe le caractère suivant)
- continuations de ligne : "\\<newline>" (bash) et "^<newline>" (cmd Windows)
- quoting ANSI-C $'...' (\\n, \\t, \\r, \\xHH, \\uHHHH, \\0, \\NNN)
- doubles quotes doublées "" du cmd Windows à l'intérieur de "..."
- avec shell_variables : substitution de $VAR et ${VAR} là où bash le ferait
  (à nu et dans les quotes doubles, jamais dans les quotes simples)
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

_SHELL_VAR_BRACED = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
_SHELL_VAR_BARE = re.compile(r"^\$([A-Za-z_][A-Za-z0-9_]*)")
_CMD_STYLE = re.compile(r"\^\r?\n")


@dataclass
class TokenizeResult:
    tokens: List[str]
    unresolved_shell_variables: List[str] = field(default_factory=list)


def tokenize(command: str) -> List[str]:
    return tokenize_full(command).tokens


def tokenize_full(command: str, shell_variables: Optional[Dict[str, str]] = None) -> TokenizeResult:
    tokens: List[str] = []
    current: List[str] = []
    has_token = False
    i = 0
    n = len(command)
    unresolved: List[str] = []
    seen_unresolved = set()
    cmd_style = bool(_CMD_STYLE.search(command))

    def push() -> None:
        nonlocal has_token, current
        if has_token:
            tokens.append("".join(current))
            current = []
            has_token = False

    def read_shell_var(pos: int) -> Optional[Tuple[str, int]]:
        if shell_variables is None:
            return None
        rest = command[pos:]
        m = _SHELL_VAR_BRACED.match(rest) or _SHELL_VAR_BARE.match(rest)
        if not m:
            return None
        name = m.group(1)
        if name in shell_variables:
            return (shell_variables[name], len(m.group(0)))
        if name not in seen_unresolved:
            seen_unresolved.add(name)
            unresolved.append(name)
        return (m.group(0), len(m.group(0)))

    while i < n:
        c = command[i]

        # Continuations de ligne (hors quotes)
        if c in ("\\", "^") and (command[i + 1 : i + 2] == "\n" or command[i + 1 : i + 3] == "\r\n"):
            i += 3 if command[i + 1 : i + 2] == "\r" else 2
            continue

        if c in (" ", "\t", "\n", "\r"):
            push()
            i += 1
            continue

        has_token = True

        if c == "'":
            end = command.find("'", i + 1)
            if end == -1:
                current.append(command[i + 1 :])
                i = n
            else:
                current.append(command[i + 1 : end])
                i = end + 1
            continue

        if c == '"':
            i += 1
            while i < n:
                d = command[i]
                if d == "$":
                    sv = read_shell_var(i)
                    if sv is not None:
                        current.append(sv[0])
                        i += sv[1]
                        continue
                if d == '"':
                    if command[i + 1 : i + 2] == '"' and cmd_style:
                        current.append('"')
                        i += 2
                        continue
                    i += 1
                    break
                if d == "\\":
                    nxt = command[i + 1 : i + 2]
                    if nxt in ('"', "\\", "$", "`"):
                        current.append(nxt)
                        i += 2
                        continue
                    if nxt == "\n":
                        i += 2
                        continue
                current.append(d)
                i += 1
            continue

        # Variable shell à nu : $VAR ou ${VAR}
        if c == "$" and command[i + 1 : i + 2] != "'":
            sv = read_shell_var(i)
            if sv is not None:
                current.append(sv[0])
                i += sv[1]
                continue

        # Quoting ANSI-C : $'...'
        if c == "$" and command[i + 1 : i + 2] == "'":
            i += 2
            while i < n and command[i] != "'":
                if command[i] == "\\":
                    text, consumed = _ansi_c_escape(command, i + 1)
                    current.append(text)
                    i += 1 + consumed
                else:
                    current.append(command[i])
                    i += 1
            i += 1  # quote fermante
            continue

        if c == "\\":
            if i + 1 < n:
                current.append(command[i + 1])
                i += 2
            else:
                i += 1
            continue

        current.append(c)
        i += 1

    push()
    return TokenizeResult(tokens=_strip_prompt_and_curl(tokens), unresolved_shell_variables=unresolved)


def _ansi_c_escape(s: str, i: int) -> Tuple[str, int]:
    c = s[i : i + 1]
    simple = {
        "n": "\n", "t": "\t", "r": "\r", "a": "\x07", "b": "\b",
        "f": "\f", "v": "\v", "\\": "\\", "'": "'", '"': '"',
    }
    if c in simple:
        return simple[c], 1
    if c == "x":
        m = re.match(r"[0-9a-fA-F]{1,2}", s[i + 1 :])
        if m:
            return chr(int(m.group(0), 16)), 1 + len(m.group(0))
        return "x", 1
    if c == "u":
        m = re.match(r"[0-9a-fA-F]{1,4}", s[i + 1 :])
        if m:
            return chr(int(m.group(0), 16)), 1 + len(m.group(0))
        return "u", 1
    m = re.match(r"[0-7]{1,3}", s[i:])
    if m:
        return chr(int(m.group(0), 8)), len(m.group(0))
    return c, 1


def _strip_prompt_and_curl(tokens: List[str]) -> List[str]:
    start = 0
    while start < len(tokens) and tokens[start] in ("$", ">", "sudo"):
        start += 1
    first = tokens[start].lower() if start < len(tokens) else None
    if first in ("curl", "curl.exe"):
        start += 1
    return tokens[start:]
