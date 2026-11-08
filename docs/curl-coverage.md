# curl overview — what is covered, what is not

*(Version française : [curl-coverage.fr.md](curl-coverage.fr.md))*

curl is a multi-protocol swiss-army knife: it can send mail (SMTP), transfer
files (FTP, SFTP), read mailboxes (IMAP, POP3), speak MQTT, TELNET, LDAP…
**urban-http has a deliberately narrower scope: turning a curl command into an
application-level HTTP call (Python / `urllib`).**

This document walks through **everything** curl can do, area by area. The SDK's
rule is the same throughout: anything out of scope is **detected and reported by a
stable-code warning**, never silently ignored.

**Legend**: ✅ covered · 🟡 partial / approximated · ⚪ not applicable in an SDK
(a CLI convenience option, accepted without error) · ❌ out of scope, reported.

---

## 1. Protocols

The HTTP core goes through `urllib` (standard library). The other protocols are
covered by **adapters** (see [protocols.md](protocols.md)): the SDK parses them
into a structured request and runs them through a proven library. Protocols
without an adapter always produce the **`unsupported-protocol`** warning with a
suggested alternative.

| Protocol | What curl does with it | Status | Engine |
|---|---|---|---|
| **HTTP / HTTPS** | the core | ✅ | urllib (stdlib) |
| **SMTP / SMTPS** | sending mail (`--mail-from`, `--mail-rcpt`, body via `-T`) | ✅ | smtplib (stdlib) |
| **FTP / FTPS** | file transfer (`-Q`, `--ftp-create-dirs`, `-l`) | ✅ | ftplib (stdlib) |
| **SFTP** | transfer over SSH | ✅ | paramiko (extra) |
| **SCP** | copy over SSH | ✅ | paramiko (extra) |
| **POP3 / POP3S** | mailbox reading (list, RETR n) | ✅ | poplib (stdlib) |
| **IMAP / IMAPS** | mailbox (folders, UIDs, fetch) | ✅ | imaplib (stdlib) |
| **MQTT / MQTTS** | publish / read a message | ✅ | paho-mqtt (extra) |
| **TFTP** | block-based UDP transfer | ✅ | socket (stdlib) |
| **FILE** | read/write a local file | ✅ | open (stdlib) |
| **SMB / SMBS** | file share | ✅ | smbprotocol (extra) |
| **WS / WSS** | WebSocket (send/receive) | ✅ | websockets (extra) |
| **LDAP(S), TELNET, DICT, GOPHER(S), RTSP, RTMP** | misc | ❌ | — |

Options specific to the covered protocols are interpreted (`--mail-from`,
`--mail-rcpt`, `-Q/--quote`, `-l/--list-only`, `--ssl`, `--ssl-reqd`, `-T`,
`-o`…). Those of the still-out-of-scope protocols (`-t/--telnet-option`…) remain
reported through `unsupported-protocol-option`.

## 2. Building the HTTP request

Full detail: [curl-use-cases.md](curl-use-cases.md).

| Area | Status |
|---|---|
| Shell syntax (quotes, bash `\` / cmd `^` continuations, `$'...'`, grouped options, `--opt=val`, `--no-*`) | ✅ |
| Methods (`-X`, `-I`, `-G`, implicit), multiple URLs, `--next`, globbing `{a,b}` `[1-10]` | ✅ |
| Headers (`-H`, empty value, removal, `-A`, `-e`, `-r`, `--compressed`) | ✅ |
| Body: `-d`, `--data-raw/-binary/-urlencode`, `--json`, `-F` multipart, `-T`, `@` files | ✅ |
| `--url-query` (encoded params appended to the URL, curl 7.87+) | ✅ |
| `--request-target`, `--form-escape`, per-part multipart headers | ❌ reported |

## 3. Authentication

| Mechanism | Status |
|---|---|
| Basic (`-u`), Bearer (`--oauth2-bearer`) | ✅ |
| Digest (`--digest`): MD5, MD5-sess, SHA-256, SHA-256-sess, qop=auth, RFC 2069 | ✅ via `execute()` (2 requests) |
| Digest `qop=auth-int` | ❌ (body hashing required) |
| NTLM, Negotiate/Kerberos (`--ntlm`, `--negotiate`, `--krb`, `--delegation`) | ❌ (proprietary multi-round protocols) |
| AWS SigV4 (`--aws-sigv4`) | ❌ (signature not computed) |
| `.netrc` (`-n`, `--netrc`, `--netrc-file`, `--netrc-optional`) | ✅ (`netrc` module, Basic auth) |

## 4. Cookies

| Feature | Status |
|---|---|
| Inline cookies (`-b "a=1"`) | ✅ |
| Reading a Netscape file (`-b cookies.txt`), domain/path/expiry/secure filtering | ✅ (injectable `file_reader`) |
| Writing the cookie jar (`-c`), session engine across requests | ⚪ CLI-specific — the application keeps state |
| `-j/--junk-session-cookies` | ⚪ |

## 5. TLS and certificates

| Feature | Status |
|---|---|
| `-k/--insecure` | ✅ (unverified SSL context) |
| Custom CA (`--cacert`, `--capath`), client certificate (`--cert`, `--key`, `--pass`) | ✅ (`ssl` context) |
| Pinning (`--pinnedpubkey`), ciphers (`--ciphers`, `--tls13-ciphers`) | ❌ / ⚪ |
| TLS versions (`--tlsv1.2`, `--tlsv1.3`) | ⚪ negotiated by the platform |

## 6. Proxies

| Feature | Status |
|---|---|
| HTTP(S) proxy (`-x/--proxy`), Basic proxy auth (`-U/--proxy-user`) | ✅ via `urllib.ProxyHandler` |
| SOCKS (`--socks4`, `--socks4a`, `--socks5`, `--socks5-hostname`) | ❌ reported |
| `--proxy-digest`, `--proxy-ntlm`, `--noproxy` | ❌ / ⚪ |

## 7. Redirects, resilience, timing

| Feature | Status |
|---|---|
| `-L`, `--location-trusted`, `--max-redirs`, `--post30x` | ✅ / 🟡 (urllib semantics) |
| `-m/--max-time` → `urlopen` `timeout` | ✅ |
| `--connect-timeout` | 🟡 approximated |
| `--retry`, `--retry-delay` (exponential backoff on 408/429/5xx) | ✅ |
| `--retry-all-errors`, `--retry-max-time`, `--retry-connrefused` | ⚪ accepted, not differentiated |
| Transfer resume (`-C/--continue-at`, explicit offset) | ✅ via `Range` header |

## 8. Variables

Full detail: [variables.md](variables.md).

| Feature | Status |
|---|---|
| `{{name}}` (Postman) everywhere, `$VAR`/`${VAR}` per shell quoting | ✅ |
| Dynamics `{{$guid}}`, `{{$randomUUID}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}` | ✅ |
| `--variable NAME=value`, `--variable %NAME[=default]`, `--expand-url/-data/-header` (curl 8.3+) | ✅ (our substitution is global; curl's is limited to `--expand-*`) |
| `--variable NAME@file`, expansion functions (`{{name:trim}}`, `{{name:json}}`…) | ❌ reported |

## 9. Transfers and performance

| Feature | Status |
|---|---|
| HTTP upload (`-T` → PUT) | ✅ |
| Parallel execution (`-Z/--parallel`, `--parallel-max`) | 🟡 all requests are returned; orchestration (`concurrent.futures`, `asyncio`…) is up to the application |
| Rate limiting (`--limit-rate`, k/M/G suffixes) | ✅ (caps reading) |
| `--rate`, thresholds (`--speed-limit/-time`) | ⚪ |
| Maximum size (`--max-filesize`) | ⚪ |
| HTTP/2, HTTP/3 (`--http2`, `--http3`) | ⚪ negotiated by the platform |

## 10. Advanced networking and DNS

| Feature | Status |
|---|---|
| `--resolve`, `--connect-to` | ✅ (original Host/SNI preserved) |
| `--unix-socket` | ✅ (AF_UNIX connection) |
| `--dns-servers`, `--doh-url`, `--interface`, `--local-port`, `--abstract-unix-socket` | ❌ reported |
| `-4`, `-6`, `--tcp-nodelay`, `--tcp-fastopen`, `--happy-eyeballs-timeout-ms`, `--keepalive-time` | ⚪ |

## 11. CLI features (not applicable in an SDK)

The SDK returns a `Response`: the application decides what to do with it. All of
these options are **accepted without error** so that a copied command passes as-is:
`-o`, `-O`, `-J`, `-D`, `-i`, `-s`, `-S`, `-v`, `-#`, `-w/--write-out`,
`--trace*`, `--stderr`, `--styled-output`, `--output-dir`, `--create-dirs`,
`--remove-on-error`, `-f/--fail`, `--fail-with-body`, `--etag-save`,
`--help`, `--version`.

## 12. Miscellaneous

| Feature | Status |
|---|---|
| Conditional requests (`-z/--time-cond`, `--etag-compare`) | ❌ reported (set `If-Modified-Since` / `If-None-Match` via `-H`) |
| Config file (`-K/--config`), `--libcurl` | ❌ reported |
| HSTS / Alt-Svc caches (`--hsts`, `--alt-svc`) | ❌ / ⚪ |
| Reading from stdin (`-d @-`) | ❌ reported |

---

## In short

- **The whole "application-level HTTP call" scope of curl is covered**: request,
  body, auth (Basic/Bearer/Digest), cookies, variables, redirects, retries,
  timeout, globbing, multipart — plus Postman import.
- **The main non-HTTP protocols are covered** by adapters (SMTP, FTP/FTPS, SFTP,
  SCP, POP3, IMAP, MQTT, TFTP, FILE, SMB, WebSocket) — see
  [protocols.md](protocols.md). The core stays compartmentalized: dependency-based
  adapters are loaded only on use.
- **Out of scope** are LDAP, TELNET, DICT, GOPHER, RTSP…: reported through
  `unsupported-protocol`.
- A few uncovered HTTP features (auth-int, client certificates, SOCKS, conditional
  `-z`) are listed in the [roadmap](../README.md#roadmap) or reported by a warning.
