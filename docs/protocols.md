# Non-HTTP protocols

*(Version française : [protocols.fr.md](protocols.fr.md))*

curl is not limited to HTTP: it sends mail (SMTP), transfers files (FTP, SFTP,
TFTP, SMB), reads mailboxes (POP3) and publishes to MQTT brokers. urban-http
covers these protocols through a **compartmentalized subsystem**
(`urban_http/protocols/`): the HTTP core does not depend on it, and each protocol
is an **adapter** backed by the standard library or, failing that, by a
third-party library installed as a **PyPI extra**.

Covered protocols: **SMTP/SMTPS, FTP/FTPS, SFTP, SCP, POP3/POP3S, IMAP/IMAPS,
MQTT/MQTTS, TFTP, FILE, SMB/SMBS, WS/WSS (WebSocket)**.

> Like the whole SDK, a request is **driven by the command** you write: an adapter
> performs a single explicit operation (send this mail, upload this file, publish
> this message), never discovery or implicit iteration.

## Usage

```python
from urban_http import run, register_default_adapters

register_default_adapters()  # once, at startup

result = run(
    "curl smtp://mail.example.com --mail-from me@example.com "
    "--mail-rcpt you@example.com -T message.eml"
)
print(result.protocol.summary)   # "250 message accepted"
```

`run(command)` detects the protocol and routes: HTTP through `urllib`, otherwise
the registered adapter. To parse without executing:

```python
from urban_http import parse_command

parsed = parse_command("curl ftp://bob@ftp.example.com/f.txt")
# parsed.kind == "protocol"; parsed.request.host / .port / .path / .direction
```

## Dependencies per protocol

| Protocol | Library | Install |
|---|---|---|
| SMTP / SMTPS | `smtplib` (stdlib) | none |
| FTP / FTPS | `ftplib` (stdlib) | none |
| POP3 / POP3S | `poplib` (stdlib) | none |
| IMAP / IMAPS | `imaplib` (stdlib) | none |
| TFTP | `socket` (stdlib) | none |
| FILE | `open` (stdlib) | none |
| SFTP | paramiko | `pip install "urban-http[sftp]"` |
| SCP | paramiko | `pip install "urban-http[scp]"` (= same paramiko as SFTP) |
| MQTT / MQTTS | paho-mqtt | `pip install "urban-http[mqtt]"` |
| SMB / SMBS | smbprotocol | `pip install "urban-http[smb]"` |
| WS / WSS | websockets | `pip install "urban-http[websocket]"` |

An extra-based adapter imports its library **only on first real use**; as long as
you do not execute it (or you inject a `client_factory`), the extra is not needed.
When it is missing, the adapter raises a clear error naming the extra to install.

## Command → operation mapping

| curl command | Operation |
|---|---|
| `curl smtp://h --mail-from a --mail-rcpt b -T msg` | send a mail (body = `-T` or `-d`) |
| `curl ftp://h/f` / `-T f ftp://h/` / `-l ftp://h/` | download / upload / listing |
| `curl -Q "CMD" ftp://h/f` | raw FTP command before the transfer |
| `curl sftp://u@h/f` / `-T f sftp://u@h/f` | SFTP download / upload |
| `curl pop3://u:p@h/` / `pop3://u:p@h/2` | message list / message #2 |
| `curl imap://u:p@h/` / `imap://u:p@h/INBOX` / `imap://u:p@h/INBOX/42` | folder list / folder UIDs / message UID 42 |
| `curl scp://u@h/path` / `-T f scp://u@h/path` | SSH copy: download / upload |
| `curl mqtt://h/topic -d "msg"` / `mqtt://h/topic` | publish / read the first message |
| `curl tftp://h/f` / `-T f tftp://h/f` | TFTP download / upload |
| `curl file:///path` / `-T src file:///dest` | read / write a local file |
| `curl smb://h/share/f` / `-T f smb://h/share/f` / `-l` | SMB read / write / listing |
| `curl ws://h/path -d "msg"` / `ws://h/path` | WebSocket: send then read the reply / read the first message |

Recognized common options: `-u user:pass` (or `user:pass@host` in the URL),
`-k/--insecure`, `--ssl`/`--ssl-reqd`, `-o file`, `-m`/`--connect-timeout`,
`-r/--range` (FILE). The `{{...}}` and `$VAR` variables work as for HTTP.

## Result

Each execution returns a `ProtocolResult`:

```python
@dataclass
class ProtocolResult:
    scheme: str
    ok: bool                 # server-side success
    summary: str             # readable summary
    body: Optional[bytes]    # retrieved content (download, message, list…)
    meta: dict               # size, server codes, identifiers…
    issues: list[str]        # non-blocking problems
```

## Architecture — adding or replacing an adapter

The registry is open: an adapter is an object with `name`, `schemes` and
`execute(req, ctx)`.

```python
from urban_http import register_protocol

class MyFtp:
    name = "my-ftp"
    schemes = ["ftp", "ftps"]
    def execute(self, req, ctx):
        ...
        return ProtocolResult(scheme=req.scheme, ok=True, summary="", meta={}, issues=[])

register_protocol(MyFtp())
```

Each reference adapter accepts an **injected client** via `ctx.client_factory`,
which lets you test it without a network or plug in another library:

```python
from urban_http import run

run("curl ftp://h/f.txt", client_factory=lambda: my_fake_ftp_client)
```

## WebSocket

Unlike Node, Python has no WebSocket client in the standard library, so the
WebSocket adapter uses the `websockets` extra (synchronous client). The operation:
open the connection (subprotocols via `-H "Sec-WebSocket-Protocol: ..."`), send
each `-d` message, read the first reply, close.

> **SCP** copies a single file through paramiko's SSH file transfer, functionally
> equivalent to scp for this use case (and with no dependency beyond SFTP).
> **IMAP** reads through `imaplib`: folder list, a folder's UID list, or a full
> message by UID.

## Out of scope

Protocols without an adapter (LDAP, DICT, GOPHER, RTSP, TELNET…) remain reported
through the `unsupported-protocol` warning.
