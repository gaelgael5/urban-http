# Postman collections — support

*(Version française : [postman-collections.fr.md](postman-collections.fr.md))*

`parse_postman()` imports the **Postman Collection v2.0 / v2.1 (JSON)** format and
produces the same `HttpRequestModel` as `parse_curl()`: everything downstream
(`prepare_request`, `execute`) works identically.

```python
from urban_http import parse_postman, is_postman_collection, execute

result = parse_postman(collection_json, {"baseUrl": "https://staging.example.com"})
for req in result.requests:
    print(req.name, req.method, req.url)
```

The status legend is the same as in [curl-use-cases.md](curl-use-cases.md).

## Collection structure

| Use case | Status |
|---|---|
| Collection schema v2.0 and v2.1 | ✅ (other schema: warning, best-effort import) |
| Nested folders (recursive `item`) | ✅ (name kept in `req.name`) |
| Short form `request: "https://..."` | ✅ |
| Invalid JSON or non-collection | ❌ clean error (`invalid-json`, `not-a-collection`) |

## URL and parameters

| Use case | Status |
|---|---|
| String or object URL (`raw`, or composed of `protocol/host/port/path`) | ✅ |
| Query parameters (`url.query`), disabled ones excluded | ✅ |

## Variables

Full guide: [variables.md](variables.md).

| Use case | Status |
|---|---|
| Collection variables (`variable`) | ✅ |
| External values via the `variables` argument | ✅ take priority |
| Postman environment export | ✅ via `parse_postman_environment(json)` |
| Dynamics `{{$guid}}`, `{{$randomUUID}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}` | ✅ |
| Unresolved variable | 🟡 kept + `unresolved-variable` warning |

## Headers and body

| Use case | Status |
|---|---|
| Headers (list, disabled ones excluded; raw-text form accepted) | ✅ |
| `raw` + `options.raw.language` → inferred Content-Type | ✅ |
| `urlencoded` (encoded pairs, disabled ones excluded) | ✅ |
| `formdata` (text and file fields, per-field `contentType`) | ✅ |
| `file` (binary body) | ✅ |
| `graphql` (query + variables → JSON body) | ✅ |

## Authentication

| Postman type | Status |
|---|---|
| `basic` | ✅ `Authorization: Basic ...` |
| `bearer` | ✅ `Authorization: Bearer ...` |
| `apikey` (in: header or query) | ✅ |
| `noauth` | ✅ |
| collection → folder → request inheritance | ✅ |
| `digest` | ✅ via `execute()` (two-request negotiation) |
| `ntlm` | ❌ warning |
| `oauth1`, `oauth2`, `awsv4`, `hawk`… | ❌ warning |

## Network behavior

| Use case | Status |
|---|---|
| Redirects followed by default (Postman behavior) | ✅ |
| `protocolProfileBehavior.followRedirects: false` | ✅ |
| pre-request / test scripts | ❌ never executed — `scripts-not-executed` warning |
| Response examples (`response`) | ⚪ ignored |
