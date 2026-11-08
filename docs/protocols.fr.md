# Protocoles non-HTTP

*(English version: [protocols.md](protocols.md))*

curl ne se limite pas à HTTP : il envoie des mails (SMTP), transfère des fichiers
(FTP, SFTP, TFTP, SMB), lit des boîtes mail (POP3) et publie sur des courtiers
MQTT. urban-http couvre ces protocoles via un **sous-système compartimenté**
(`urban_http/protocols/`) : le cœur HTTP n'en dépend pas, et chaque protocole est
un **adaptateur** qui s'appuie sur la bibliothèque standard ou, à défaut, sur une
bibliothèque tierce installée en **extra PyPI**.

Protocoles couverts : **SMTP/SMTPS, FTP/FTPS, SFTP, SCP, POP3/POP3S,
IMAP/IMAPS, MQTT/MQTTS, TFTP, FILE, SMB/SMBS, WS/WSS (WebSocket)**.

> Comme tout le SDK, une requête est **pilotée par la commande** que vous écrivez :
> un adaptateur exécute une seule opération explicite (envoyer ce mail, téléverser
> ce fichier, publier ce message), jamais de découverte ni d'itération implicite.

## Utilisation

```python
from urban_http import run, register_default_adapters

register_default_adapters()  # une fois, au démarrage

result = run(
    "curl smtp://mail.example.com --mail-from moi@example.com "
    "--mail-rcpt toi@example.com -T message.eml"
)
print(result.protocol.summary)   # "250 message accepté"
```

`run(command)` détecte le protocole et route : HTTP via `urllib`, sinon
l'adaptateur enregistré. Pour analyser sans exécuter :

```python
from urban_http import parse_command

parsed = parse_command("curl ftp://bob@ftp.example.com/f.txt")
# parsed.kind == "protocol" ; parsed.request.host / .port / .path / .direction
```

## Dépendances par protocole

| Protocole | Bibliothèque | Install |
|---|---|---|
| SMTP / SMTPS | `smtplib` (stdlib) | aucune |
| FTP / FTPS | `ftplib` (stdlib) | aucune |
| POP3 / POP3S | `poplib` (stdlib) | aucune |
| IMAP / IMAPS | `imaplib` (stdlib) | aucune |
| TFTP | `socket` (stdlib) | aucune |
| FILE | `open` (stdlib) | aucune |
| SFTP | paramiko | `pip install "urban-http[sftp]"` |
| SCP | paramiko | `pip install "urban-http[scp]"` (= même paramiko que SFTP) |
| MQTT / MQTTS | paho-mqtt | `pip install "urban-http[mqtt]"` |
| SMB / SMBS | smbprotocol | `pip install "urban-http[smb]"` |
| WS / WSS | websockets | `pip install "urban-http[websocket]"` |

Un adaptateur à extra n'importe sa bibliothèque **qu'au premier usage réel** ; tant
que vous ne l'exécutez pas (ou que vous injectez un `client_factory`), l'extra
n'est pas nécessaire. En son absence, l'adaptateur lève une erreur claire indiquant
l'extra à installer.

## Correspondance commande → opération

| Commande curl | Opération |
|---|---|
| `curl smtp://h --mail-from a --mail-rcpt b -T msg` | envoi d'un mail (corps = `-T` ou `-d`) |
| `curl ftp://h/f` / `-T f ftp://h/` / `-l ftp://h/` | téléchargement / téléversement / listage |
| `curl -Q "CMD" ftp://h/f` | commande FTP brute avant le transfert |
| `curl sftp://u@h/f` / `-T f sftp://u@h/f` | téléchargement / téléversement SFTP |
| `curl pop3://u:p@h/` / `pop3://u:p@h/2` | liste des messages / message n°2 |
| `curl imap://u:p@h/` / `imap://u:p@h/INBOX` / `imap://u:p@h/INBOX/42` | liste des dossiers / UIDs du dossier / message UID 42 |
| `curl scp://u@h/chemin` / `-T f scp://u@h/chemin` | copie SSH : téléchargement / téléversement |
| `curl mqtt://h/topic -d "msg"` / `mqtt://h/topic` | publication / lecture du 1er message |
| `curl tftp://h/f` / `-T f tftp://h/f` | téléchargement / téléversement TFTP |
| `curl file:///chemin` / `-T src file:///dest` | lecture / écriture d'un fichier local |
| `curl smb://h/partage/f` / `-T f smb://h/partage/f` / `-l` | lecture / écriture / listage SMB |
| `curl ws://h/chemin -d "msg"` / `ws://h/chemin` | WebSocket : envoi puis lecture de la réponse / lecture du 1er message |

Options communes reconnues : `-u user:pass` (ou `user:pass@hôte` dans l'URL),
`-k/--insecure`, `--ssl`/`--ssl-reqd`, `-o fichier`, `-m`/`--connect-timeout`,
`-r/--range` (FILE). Les variables `{{...}}` et `$VAR` fonctionnent comme pour HTTP.

## Résultat

Chaque exécution renvoie un `ProtocolResult` :

```python
@dataclass
class ProtocolResult:
    scheme: str
    ok: bool                 # succès côté serveur
    summary: str             # résumé lisible
    body: Optional[bytes]    # contenu récupéré (download, message, liste…)
    meta: dict               # taille, codes serveur, identifiants…
    issues: list[str]        # problèmes non bloquants
```

## Architecture — ajouter ou remplacer un adaptateur

Le registre est ouvert : un adaptateur est un objet avec `name`, `schemes` et
`execute(req, ctx)`.

```python
from urban_http import register_protocol

class MonFtp:
    name = "mon-ftp"
    schemes = ["ftp", "ftps"]
    def execute(self, req, ctx):
        ...
        return ProtocolResult(scheme=req.scheme, ok=True, summary="", meta={}, issues=[])

register_protocol(MonFtp())
```

Chaque adaptateur de référence accepte un **client injecté** via
`ctx.client_factory`, ce qui permet de le tester sans réseau ou de brancher une
autre bibliothèque :

```python
from urban_http import run

run("curl ftp://h/f.txt", client_factory=lambda: mon_client_ftp_simulé)
```

## WebSocket

Contrairement à Node, Python n'a pas de client WebSocket dans la bibliothèque
standard : l'adaptateur WebSocket utilise donc l'extra `websockets` (client
synchrone). L'opération : ouvrir la connexion (sous-protocoles via
`-H "Sec-WebSocket-Protocol: ..."`), envoyer chaque message `-d`, lire la première
réponse, refermer.

> **SCP** copie un fichier unique via le transfert de fichiers SSH de paramiko,
> équivalent fonctionnel de scp pour ce cas d'usage (et sans dépendance
> supplémentaire par rapport à SFTP). **IMAP** lit via `imaplib` : liste des
> dossiers, liste des UIDs d'un dossier, ou message complet par UID.

## Hors périmètre

Les protocoles sans adaptateur (LDAP, DICT, GOPHER, RTSP, TELNET…) restent
signalés par le warning `unsupported-protocol`.
