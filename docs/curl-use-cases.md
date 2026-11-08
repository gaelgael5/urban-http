# curl use cases — inventory and support

*(Version française : [curl-use-cases.fr.md](curl-use-cases.fr.md))*

This document lists the curl use cases relevant to an **application-level HTTP
call**, and the status of each in the `urban-http` parser. For the full overview
of curl (non-HTTP protocols: SMTP mail, FTP, WebSocket…), see
**[curl-coverage.md](curl-coverage.md)**.

**Status legend:**

| Status | Meaning |
|---|---|
| ✅ Supported | Faithfully reproduced in the generated HTTP call |
| 🟡 Partial | Supported with a documented approximation (`partial-option` warning) |
| ⚪ Ignored | CLI-only option, no effect on the HTTP request (accepted, sometimes reported as `info`) |
| ❌ Unsupported | Detected and reported by a warning, but not applied |

---

## 1. Command-line syntax

| Use case | Example | Status |
|---|---|---|
| Simple command | `curl https://api.example.com` | ✅ |
| Missing `curl` word (arguments only) | `-X GET https://e.com` | ✅ |
| `curl.exe`, leading `$` prompt or `sudo` | `$ curl.exe ...` | ✅ |
| Single quotes `'...'` | `curl -d '{"a":1}'` | ✅ |
| Double quotes `"..."` with escapes `\" \\ \$` | `curl -H "X: \"v\""` | ✅ |
| bash line continuations `\` | `curl -X POST \`↵`  https://e.com` | ✅ |
| Windows cmd line continuations `^` (Postman export) | `curl -X POST ^`↵` "https://e.com"` | ✅ |
| Windows cmd doubled double-quotes `""` | `curl -d "{""a"":1}" ^`↵ | ✅ |
| ANSI-C quoting `$'...'` (`\n`, `\t`, `\xHH`, `\uHHHH`...) | `curl -d $'a\nb'` | ✅ |
| Grouped short options | `curl -sSL https://e.com` | ✅ |
| Value glued to a short option | `curl -XPOST https://e.com` | ✅ |
| `--option=value` form (tolerance: curl does not accept it) | `--max-time=5` | ✅ |
| `--no-<option>` negation | `--no-location` | ✅ |
| Unknown option | `--frobnicate` | ❌ `unknown-option` warning, parsing continues |
| Reading from stdin (`-`) | `curl -d @- ...` | ❌ warning |
| Config file | `-K, --config` | ❌ warning |

## 2. URL and method

| Use case | Options | Status |
|---|---|---|
| Positional URL | `curl https://e.com` | ✅ |
| Explicit URL | `--url` | ✅ |
| Missing scheme → `http://` added (like curl) | `curl example.com` | ✅ (`default-scheme` info) |
| Multiple URLs with the same configuration | `curl -H "X: 1" url1 url2` | ✅ (one request per URL) |
| Independent chained requests | `--next` | ✅ |
| Explicit method | `-X, --request` | ✅ |
| HEAD | `-I, --head` | ✅ (`-X` wins, like curl) |
| Forced GET with data in the query string | `-G, --get` | ✅ |
| Implicit method POST (if body) / PUT (if `-T`) / GET otherwise | — | ✅ |
| URL globbing: alternatives `{a,b}`, ranges `[1-10]`, `[01-10]` (zero-padding), `[a-z]`, step `[0-100:25]`, cartesian product | `curl http://e.com/[1-10]` | ✅ expanded into several requests (limit: 500 URLs) |
| Invalid globbing pattern (e.g. IPv6 host `[::1]`) or too large | — | 🟡 `url-globbing` warning, URL used as-is |
| Disable globbing | `-g, --globoff` | ✅ |

## 3. Headers

| Use case | Options | Status |
|---|---|---|
| Simple header, order preserved, multiple | `-H "Accept: application/json"` | ✅ |
| Empty-value header | `-H "X-Empty;"` | ✅ |
| Removing a generated header | `-H "User-Agent:"` | ✅ |
| User-Agent | `-A, --user-agent` | ✅ |
| Referer | `-e, --referer` | ✅ (`;auto` ignored, info) |
| Range | `-r, --range` → `Range: bytes=...` | ✅ |
| Compression | `--compressed` → `Accept-Encoding: gzip, deflate, br` | ✅ (urllib decompresses depending on the server) |
| Headers from a file | `-H @file` | ❌ warning |

## 4. Request body

| Use case | Options | Status |
|---|---|---|
| POST data (Content-Type urlencoded by default) | `-d, --data, --data-ascii` | ✅ |
| Multiple `-d` concatenated with `&` | `-d a=1 -d b=2` | ✅ |
| Raw data (`@` not interpreted) | `--data-raw` | ✅ |
| Binary data | `--data-binary` | ✅ |
| URL-encoding the value (`content`, `=content`, `name=content`) | `--data-urlencode` | ✅ |
| JSON shortcut (body + `Content-Type` + `Accept`) | `--json '{"a":1}'` | ✅ |
| Encoded query params, independent of the body | `--url-query 'q=crème brûlée'` (`--data-urlencode` forms + `+raw`) | ✅ |
| Body from a file | `-d @file` | ✅ (CR/LF stripped like curl; injectable `file_reader`) |
| Raw file upload (PUT) | `-T, --upload-file` | ✅ |
| Multipart form | `-F, --form` | ✅ (multipart body built, boundary generated) |
| File field with attributes | `-F "f=@x.png;type=image/png;filename=y.png"` | ✅ |
| File contents as a text field | `-F "notes=<notes.txt"` | ✅ |
| Literal value without interpretation | `--form-string` | ✅ |
| Per-part multipart headers | `-F "...;headers=..."` | ❌ info |

## 5. Authentication

| Use case | Options | Status |
|---|---|---|
| Basic | `-u user:pass` → `Authorization: Basic ...` | ✅ |
| Bearer | `--oauth2-bearer TOKEN` → `Authorization: Bearer ...` | ✅ |
| Explicit Basic | `--basic` | ✅ |
| Digest | `--digest` | ✅ via `execute()`: two-request negotiation (MD5, MD5-sess, SHA-256, SHA-256-sess; qop=auth or RFC 2069). `qop=auth-int` ❌ |
| NTLM / Negotiate (Kerberos) | `--ntlm, --negotiate` | ❌ warning |
| AWS signature | `--aws-sigv4` | ❌ warning |

## 6. Cookies

| Use case | Options | Status |
|---|---|---|
| Inline cookies | `-b "a=1; b=2"` → `Cookie` header | ✅ |
| Cookies from a file (Netscape format, `#HttpOnly_` included) | `-b cookies.txt` | ✅ (domain / path / expiry / secure filtering, like curl; injectable `file_reader`) |
| Writing the cookie jar | `-c, --cookie-jar` | ⚪ info (CLI-specific) |
| Ignore session cookies | `-j, --junk-session-cookies` | ⚪ |

## 7. Redirects

| Use case | Options | Status |
|---|---|---|
| Follow redirects | `-L, --location` | ✅ (`-L` = follow; otherwise `redirect: manual` on the urllib side) |
| Redirect limit | `--max-redirs N` | 🟡 kept in the model |
| Credentials kept after redirect | `--location-trusted` | 🟡 follows redirects, info about the limitation |
| 301/302/303 behavior | `--post301/302/303` | 🟡 standard urllib semantics |

## 8. TLS, proxy and networking

| Use case | Options | Status |
|---|---|---|
| Skip TLS verification | `-k, --insecure` | ✅ (unverified SSL context) |
| Custom CA, client certificate, key password | `--cacert, --capath, --cert (-E), --key, --pass` | ✅ (SSL context: `load_verify_locations` / `load_cert_chain`) |
| HTTP(S) proxy, with authentication | `-x, --proxy, --proxy-user (-U)` | ✅ (via `urllib.ProxyHandler`) |
| HTTP version | `--http1.1, --http2, --http3` | ⚪ negotiated by the platform, kept for information |
| IPv4/IPv6, TLS versions | `-4, -6, --tlsv1.2, --tlsv1.3` | ⚪ |
| Forced DNS resolution, connection redirection, Unix socket | `--resolve, --connect-to, --unix-socket` | ✅ (original Host and SNI preserved) |
| Network interface, DNS/DoH | `--interface, --dns-servers, --doh-url` | ❌ warning |
| Credentials from netrc | `-n/--netrc, --netrc-file, --netrc-optional` | ✅ (`netrc` module, Basic) |

## 9. Timeouts and resilience

| Use case | Options | Status |
|---|---|---|
| Global timeout | `-m, --max-time` → `urlopen` `timeout` | ✅ |
| Connection timeout | `--connect-timeout` | 🟡 approximated by the global timeout |
| Retries on transient errors (408, 429, 500, 502, 503, 504) | `--retry N` | ✅ (exponential backoff 1s, 2s, 4s... like curl) |
| Delay between retries | `--retry-delay` | ✅ |
| Rate limiting (k/M/G suffixes) | `--limit-rate` | ✅ (caps the response read) |
| Transfer resume (explicit offset) | `-C/--continue-at` | ✅ via `Range` header (`-C -` auto: unsupported without an output file) |

## 10. CLI options with no effect on the request (accepted, ignored)

`-s` (silent), `-S` (show-error), `-v` (verbose), `-i` (include), `-o` (output), `-O` (remote-name),
`-J`, `-D` (dump-header), `-w` (write-out), `-f` (fail), `--fail-with-body`, `-#` (progress-bar),
`--trace`, `--trace-ascii`, `--help`, `--version`, `--raw`, `--path-as-is`, `--styled-output`,
`--keepalive-time`, `--no-keepalive`.

They are parsed without error so that any command copied from a terminal or a
Postman export passes as-is.

## 11. Variables

Enabled by passing a `variables` dictionary to `parse_curl(command, variables)`.
Full guide: [variables.md](variables.md).

| Use case | Example | Status |
|---|---|---|
| Postman placeholder `{{name}}` (URL, headers, body, everywhere) | `curl {{baseUrl}}/users` | ✅ |
| Shell variable `$NAME` / `${NAME}`, bare or in double quotes | `curl -H "Authorization: Bearer $TOKEN" ...` | ✅ (only if `variables` is provided) |
| `$NAME` in single quotes: never substituted (like bash) | `curl -d '$TOKEN' ...` | ✅ |
| Value with spaces: stays in its token (no bash word-splitting) | — | ✅ (deliberate, safer for an SDK) |
| Dynamics `{{$guid}}`, `{{$randomUUID}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}` | `curl --json '{"id": "{{$guid}}"}' ...` | ✅ generated at each occurrence, like Postman |
| Native curl 8.3+ variables | `--variable host=api.e.com --expand-url 'https://{{host}}/x'`, `--variable %NAME[=default]` | ✅ (global substitution, superset of curl's `--expand-*`) |
| Other Postman dynamics (`{{$randomCity}}`…) | — | ❌ `unsupported-dynamic-variable` warning, left as-is |
| Unresolved variable (`{{x}}` or `$X` absent from the map) | — | 🟡 left as-is + warning (`unresolved-variable` / `unresolved-shell-variable`) |

---

## What about Postman?

Postman's "Copy as cURL" export (bash **and** Windows cmd) is covered by this
parser: `^` continuations, doubled `""` quotes, `--data-raw`, etc. Direct import of
the **Postman Collection v2.0 / v2.1 (JSON)** format is handled by
`parse_postman()` — see [postman-collections.md](postman-collections.md).
