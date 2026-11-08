# urban-http

SDK **Python** pour transformer une commande **curl** ou une **collection Postman**
en **appel exécutable** — HTTP via la bibliothèque standard, et les autres
protocoles de curl (SMTP, FTP, SFTP, POP3, MQTT, TFTP, FILE, SMB, WebSocket) via
des adaptateurs dont les dépendances sont gérées en **extras PyPI**. Protocoles
couverts : HTTP, SMTP, FTP/FTPS, SFTP, SCP, POP3, IMAP, MQTT, TFTP, FILE, SMB,
WebSocket.

```
commande curl ───▶ parse_curl() ────┐
                                    ├──▶ HttpRequestModel ──▶ prepare_request() / execute()
collection Postman ─▶ parse_postman() ┘
                    └▶ parse_command() ──▶ ProtocolRequest ──▶ run() (adaptateur)
```

## Installation

```bash
pip install urban-http                       # cœur : HTTP + SMTP/FTP/POP3/TFTP/FILE (stdlib, zéro dépendance)
pip install "urban-http[sftp,mqtt,smb]"      # extras pour les protocoles qui requièrent une bibliothèque
pip install "urban-http[all]"                # tout
```

Le **cœur n'a aucune dépendance obligatoire**. Chaque protocole qui s'appuie sur
une bibliothèque tierce est un extra :

| Extra | Protocole | Bibliothèque PyPI |
|---|---|---|
| `sftp` | SFTP | paramiko |
| `mqtt` | MQTT / MQTTS | paho-mqtt |
| `smb` | SMB / SMBS | smbprotocol |
| `websocket` | WS / WSS | websockets |
| `web` | site de test local | flask (optionnel) |

SMTP, FTP/FTPS, POP3, IMAP, TFTP et FILE utilisent uniquement la bibliothèque
standard (`smtplib`, `ftplib`, `poplib`, `imaplib`, `socket`, `open`) : aucun
extra. SCP partage paramiko avec SFTP.

## Utilisation

```python
from urban_http import parse_curl, execute

result = parse_curl(
    "curl -X POST https://api.example.com/items "
    "-H 'Content-Type: application/json' -d '{\"name\": \"clavier\"}' -u alice:secret -m 10"
)
req = result.requests[0]
req.method          # "POST"
req.url             # "https://api.example.com/items"
req.header("Content-Type")  # "application/json"

resp = execute(req).response
print(resp.status, resp.text())
```

Tout ce qui n'est pas reproductible est **signalé dans `warnings`** (jamais ignoré
en silence) : chaque warning a un `code` stable, un `message` et un niveau.

## Variables

```python
# {{nom}} partout, et $NOM / ${NOM} comme dans le shell (quotes doubles et nu)
parse_curl('curl -H "Authorization: Bearer $TOKEN" {{baseUrl}}/users',
           {"baseUrl": "https://api.example.com", "TOKEN": "tok-42"})

# Dynamiques Postman générées : {{$guid}}, {{$randomUUID}}, {{$timestamp}}, {{$isoTimestamp}}, {{$randomInt}}
from urban_http import parse_postman_environment
variables = parse_postman_environment(env_json)  # export d'environnement Postman
```

## Collections Postman

```python
from urban_http import parse_postman, is_postman_collection

result = parse_postman(collection_json, {"baseUrl": "https://api.example.com"})
for req in result.requests:
    print(req.name, req.method, req.url)
```

Format Collection v2.0 / v2.1 : dossiers imbriqués, variables, tous les modes de
corps (raw, urlencoded, formdata, file, graphql), auth basic/bearer/apikey avec
héritage collection → dossier → requête.

## Autres protocoles

```python
from urban_http import run, register_default_adapters

register_default_adapters()  # une fois

# Envoi d'un mail (smtplib), téléversement FTP (ftplib), publication MQTT (paho)...
result = run("curl smtp://mail.example.com --mail-from moi@x.com --mail-rcpt toi@y.com -T message.eml")
print(result.protocol.summary)
```

`run()` détecte le protocole et route : HTTP via urllib, sinon l'adaptateur
enregistré. Chaque adaptateur accepte un `client_factory` injectable (tests sans
réseau, ou autre bibliothèque). Détail : **[docs/protocols.md](docs/protocols.md)**.

## Ligne de commande

```bash
urban-http "curl -X POST https://api.example.com -d a=1"     # analyse et affiche la requête
urban-http "curl file:///etc/hostname" --run                 # analyse ET exécute
urban-http "curl {{baseUrl}}/get" --var baseUrl=https://httpbin.org
```

## Site de test

```bash
python demo/server.py          # http://127.0.0.1:8000
```

Une page web qui analyse en direct n'importe quelle commande curl ou collection
Postman (analyse faite en Python côté serveur) et exécute les requêtes HTTP. Les
exemples HTTP ciblent httpbin.org.

## Développement

```bash
python -m pytest               # 148 tests : tokenizer, parser, Postman, variables,
                               # globbing, cookies, Digest, exécution, protocoles
```

## Couverture de curl

- **HTTP/HTTPS** : requête, corps, multipart, globbing, redirections, retries,
  timeout, auth Basic/Bearer/Digest, cookies (inline et fichiers Netscape),
  variables — plus l'import Postman. Détail : [docs/curl-use-cases.md](docs/curl-use-cases.md).
- **Autres protocoles** : SMTP, FTP/FTPS, SFTP, SCP, POP3, IMAP, MQTT, TFTP,
  FILE, SMB, WebSocket. Détail : [docs/protocols.md](docs/protocols.md).
- **Panorama complet** (ce qui est couvert et ce qui ne l'est pas) :
  [docs/curl-coverage.md](docs/curl-coverage.md).

## Feuille de route

- Protocoles restants : LDAP, TELNET.
- Auth : AWS SigV4, NTLM/Negotiate, Digest `qop=auth-int`.
- Requêtes conditionnelles (`-z`, `--etag-compare`), reprise `-C -` automatique.
- Générateurs de code supplémentaires (httpx, requests).
