"""Modèle de données : résultat du parsing d'une commande curl,
indépendant de l'environnement d'exécution.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, List, Literal, Optional, Tuple, Union

WarningLevel = Literal["info", "warning", "error"]


@dataclass
class ParseWarning:
    """Avertissement émis pendant le parsing."""

    code: str
    message: str
    level: WarningLevel = "warning"
    option: Optional[str] = None


DataMode = Literal["data", "raw", "binary", "urlencode"]


@dataclass
class DataItem:
    """Fragment de données fourni par -d / --data-*."""

    mode: DataMode
    value: Optional[str] = None
    name: Optional[str] = None
    file_path: Optional[str] = None


@dataclass
class FormField:
    """Champ multipart fourni par -F / --form."""

    name: str
    value: Optional[str] = None
    file_path: Optional[str] = None
    content_from_file: Optional[str] = None
    content_type: Optional[str] = None
    file_name: Optional[str] = None


BodyKind = Literal["raw", "urlencoded", "multipart", "file"]


@dataclass
class BodySpec:
    kind: BodyKind
    text: Optional[str] = None
    items: Optional[List[DataItem]] = None
    parts: Optional[List[FormField]] = None
    file_path: Optional[str] = None


AuthKind = Literal["basic", "bearer", "digest", "ntlm", "negotiate", "aws-sigv4"]


@dataclass
class AuthSpec:
    kind: AuthKind
    username: Optional[str] = None
    password: Optional[str] = None
    token: Optional[str] = None


@dataclass
class RequestOptions:
    follow_redirects: bool = False
    insecure: bool = False
    compressed: bool = False
    max_redirs: Optional[int] = None
    timeout_ms: Optional[int] = None
    connect_timeout_ms: Optional[int] = None
    retry: Optional[int] = None
    retry_delay_ms: Optional[int] = None
    proxy: Optional[str] = None
    proxy_user: Optional[str] = None
    http_version: Optional[str] = None


@dataclass
class HttpRequestModel:
    """Requête HTTP prête à être exécutée."""

    method: str
    url: str
    query: List[Tuple[str, str]] = field(default_factory=list)
    headers: List[Tuple[str, str]] = field(default_factory=list)
    body: Optional[BodySpec] = None
    auth: Optional[AuthSpec] = None
    cookie_files: Optional[List[str]] = None
    options: RequestOptions = field(default_factory=RequestOptions)
    warnings: List[ParseWarning] = field(default_factory=list)
    name: Optional[str] = None

    def header(self, name: str) -> Optional[str]:
        """Première valeur d'en-tête correspondant au nom (insensible à la casse)."""
        low = name.lower()
        for n, v in self.headers:
            if n.lower() == low:
                return v
        return None


@dataclass
class ParseResult:
    requests: List[HttpRequestModel] = field(default_factory=list)
    warnings: List[ParseWarning] = field(default_factory=list)


# Lecteur de fichier injectable, pour résoudre les références "@fichier".
FileReader = Callable[[str], Union[bytes, str]]
