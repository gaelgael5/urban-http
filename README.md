# urban-http

**English** · [Français](README.fr.md)

[![CI](https://github.com/gaelgael5/urban-http/actions/workflows/ci.yml/badge.svg)](https://github.com/gaelgael5/urban-http/actions/workflows/ci.yml)

A **Python** SDK that turns a **curl** command or a **Postman collection** into an
**executable call** — HTTP through the standard library, and curl's other
protocols (SMTP, FTP, SFTP, POP3, MQTT, TFTP, FILE, SMB, WebSocket) through
adapters whose dependencies are managed as **PyPI extras**. Covered protocols:
HTTP, SMTP, FTP/FTPS, SFTP, SCP, POP3, IMAP, MQTT, TFTP, FILE, SMB, WebSocket.

```
curl command ──────▶ parse_curl() ───┐
                                     ├──▶ HttpRequestModel ──▶ prepare_request() / execute()
Postman collection ─▶ parse_postman() ┘
                    └▶ parse_command() ──▶ ProtocolRequest ──▶ run() (adapter)
```

## Installation

```bash
pip install urban-http                       # core: HTTP + SMTP/FTP/POP3/TFTP/FILE (stdlib, zero dependencies)
pip install "urban-http[sftp,mqtt,smb]"      # extras for protocols that need a third-party library
pip install "urban-http[all]"                # everything
```

The **core has no mandatory dependency**. Each protocol that relies on a
third-party library is an extra:

| Extra | Protocol | PyPI library |
|---|---|---|
| `sftp` | SFTP | paramiko |
| `mqtt` | MQTT / MQTTS | paho-mqtt |
| `smb` | SMB / SMBS | smbprotocol |
| `websocket` | WS / WSS | websockets |
| `web` | local test site | flask (optional) |

SMTP, FTP/FTPS, POP3, IMAP, TFTP and FILE use only the standard library
(`smtplib`, `ftplib`, `poplib`, `imaplib`, `socket`, `open`): no extra. SCP shares
paramiko with SFTP.

## Usage

```python
from urban_http import parse_curl, execute

result = parse_curl(
    "curl -X POST https://api.example.com/items "
    "-H 'Content-Type: application/json' -d '{\"name\": \"keyboard\"}' -u alice:secret -m 10"
)
req = result.requests[0]
req.method          # "POST"
req.url             # "https://api.example.com/items"
req.header("Content-Type")  # "application/json"

resp = execute(req).response
print(resp.status, resp.text())
```

Anything that cannot be reproduced is **reported in `warnings`** (never silently
dropped): each warning has a stable `code`, a `message` and a level.

## Variables

```python
# {{name}} everywhere, and $NAME / ${NAME} like in the shell (double quotes and bare)
parse_curl('curl -H "Authorization: Bearer $TOKEN" {{baseUrl}}/users',
           {"baseUrl": "https://api.example.com", "TOKEN": "tok-42"})

# Postman dynamics generated: {{$guid}}, {{$randomUUID}}, {{$timestamp}}, {{$isoTimestamp}}, {{$randomInt}}
from urban_http import parse_postman_environment
variables = parse_postman_environment(env_json)  # Postman environment export
```

## Postman collections

```python
from urban_http import parse_postman, is_postman_collection

result = parse_postman(collection_json, {"baseUrl": "https://api.example.com"})
for req in result.requests:
    print(req.name, req.method, req.url)
```

Collection v2.0 / v2.1 format: nested folders, variables, every body mode (raw,
urlencoded, formdata, file, graphql), basic/bearer/apikey auth with
collection → folder → request inheritance.

## Other protocols

```python
from urban_http import run, register_default_adapters

register_default_adapters()  # once

# Send a mail (smtplib), FTP upload (ftplib), MQTT publish (paho)...
result = run("curl smtp://mail.example.com --mail-from me@x.com --mail-rcpt you@y.com -T message.eml")
print(result.protocol.summary)
```

`run()` detects the protocol and routes: HTTP through urllib, otherwise the
registered adapter. Each adapter accepts an injectable `client_factory` (tests
without a network, or another library). See **[docs/protocols.md](docs/protocols.md)**.

## OpenAPI → curl

`openapi_to_curl(contract)` reads an OpenAPI v3.x contract (dict, JSON, or YAML
with the `openapi` extra) and returns, for each operation, a curl command with
injectable variables, its parameter table, and a generic request-body model.

```python
from urban_http import openapi_to_curl, parse_curl

for op in openapi_to_curl(contract):
    print(op.method, op.path)
    print(op.curl)                 # with {{placeholders}}
    print(op.example_variables)    # {name: value} ready for parse_curl
    req = parse_curl(op.curl, op.example_variables).requests[0]
```

The body is generated exhaustively with typical values: string → property name,
integer → 0, date/date-time → current instant, sub-object expanded, array with a
single item. See **[docs/openapi.md](docs/openapi.md)**.

## Command line

```bash
urban-http "curl -X POST https://api.example.com -d a=1"     # parse and print the request
urban-http "curl file:///etc/hostname" --run                 # parse AND execute
urban-http "curl {{baseUrl}}/get" --var baseUrl=https://httpbin.org
urban-http --openapi contract.json                           # generate the curl commands of an OpenAPI contract
```

## Test site

```bash
python demo/server.py          # http://127.0.0.1:8000
```

A web page that live-parses any curl command or Postman collection (parsing done
in Python server-side) and executes HTTP requests. The HTTP examples target
httpbin.org.

## Development

```bash
python -m pytest               # 199 tests: tokenizer, parser, Postman, variables,
                               # globbing, cookies, Digest, execution, protocols,
                               # TLS/network options, OpenAPI
```

CI (GitHub Actions) runs the tests on Python 3.9 → 3.13 and builds the package on
every push / PR. A version is published to PyPI by pushing a `vX.Y.Z` tag — see
**[RELEASING.md](RELEASING.md)**.

## curl coverage

- **HTTP/HTTPS**: request, body, multipart, globbing, redirects, retries,
  timeout, Basic/Bearer/Digest auth, cookies (inline and Netscape files),
  variables — plus Postman import. See [docs/curl-use-cases.md](docs/curl-use-cases.md).
- **Other protocols**: SMTP, FTP/FTPS, SFTP, SCP, POP3, IMAP, MQTT, TFTP, FILE,
  SMB, WebSocket. See [docs/protocols.md](docs/protocols.md).
- **Full overview** (what is covered and what is not):
  [docs/curl-coverage.md](docs/curl-coverage.md).

## Roadmap

- Remaining protocols: LDAP, TELNET.
- Auth: AWS SigV4, NTLM/Negotiate, Digest `qop=auth-int`.
- Conditional requests (`-z`, `--etag-compare`), automatic `-C -` resume.
- Extra code generators (httpx, requests).
