# Variables — full guide

*(Version française : [variables.fr.md](variables.fr.md))*

Both `parse_curl` and `parse_postman` accept a `variables` dictionary:

```python
parse_curl(command, {"baseUrl": "https://api.example.com", "TOKEN": "tok-42"})
parse_postman(collection_json, {"baseUrl": "https://api.example.com"})
```

Three mechanisms, implemented in a single module (`urban_http/variables.py`)
shared by both parsers.

## 1. Postman placeholders `{{name}}`

Substituted **everywhere**: URL, headers, body, authentication — in curl commands
as well as in Postman collections.

```python
r = parse_curl("curl -H 'X-Api-Key: {{apiKey}}' {{baseUrl}}/users",
               {"baseUrl": "https://api.example.com", "apiKey": "k-123"})
r.requests[0].url  # "https://api.example.com/users"
```

## 2. Shell variables `$VAR` and `${VAR}` (curl commands)

A command copied from a script often contains environment variables. The SDK
resolves them **the way bash would have** before calling curl:

| Context | Behavior | Example |
|---|---|---|
| Bare argument | ✅ substituted | `curl https://$HOST/me` |
| Double quotes `"..."` | ✅ substituted | `-H "Authorization: Bearer $TOKEN"` |
| Single quotes `'...'` | ❌ never (like bash) | `-d '$TOKEN'` sends `$TOKEN` literally |

Two deliberate choices, safer for an SDK:

- **Opt-in**: without a `variables` dictionary, no `$` is touched and no warning is
  emitted (a `pa$$word` password stays intact).
- **No word splitting**: a value with spaces stays in its token.

## 3. Postman dynamic variables `{{$...}}`

Generated at **each occurrence** (two `{{$guid}}` give two different UUIDs). No
option to pass.

| Variable | Value |
|---|---|
| `{{$guid}}`, `{{$randomUUID}}` | UUID v4 (`uuid.uuid4()`) |
| `{{$timestamp}}` | Unix seconds |
| `{{$isoTimestamp}}` | ISO 8601 timestamp |
| `{{$randomInt}}` | integer 0–1000 |

Any other dynamic is left as-is and reported (`unsupported-dynamic-variable`).

## Postman environments

```python
from urban_http import parse_postman_environment, parse_postman

variables = parse_postman_environment(env_json)   # {values: [{key, value, enabled}]} or {key: value}
parse_postman(collection_json, variables)
```

Priority: `variables` (environment) **>** collection variables, as in Postman.

## Unresolved variables: never a silent failure

A variable without a value is **left as-is** and reported:

| Code | Trigger |
|---|---|
| `unresolved-variable` | `{{name}}` without a value |
| `unresolved-shell-variable` | `$NAME` absent from the dictionary |
| `unsupported-dynamic-variable` | unsupported `{{$dynamic}}` |

```python
r = parse_curl("curl {{apiHost}}/users")
r.requests[0].url     # "{{apiHost}}/users" — kept
r.warnings[0].code    # "unresolved-variable"
```

## Native curl 8.3+ variables

`--variable NAME=value`, `--variable %NAME[=default]` and
`--expand-url/-data/-header` are supported (the SDK's `{{...}}` substitution is a
superset of curl's `--expand-*`).

```python
parse_curl("curl --variable host=api.e.com --expand-url 'https://{{host}}/ping'")
# → https://api.e.com/ping
```
