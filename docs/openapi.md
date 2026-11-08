# OpenAPI → curl

*(Version française : [openapi.fr.md](openapi.fr.md))*

`openapi_to_curl(contract)` reads an **OpenAPI v3.x** contract (and, best-effort,
Swagger v2) and returns, for each operation (path + method), a ready-to-use curl
command with injectable `{{...}}` variables.

```python
from urban_http import openapi_to_curl

operations = openapi_to_curl(contract)   # dict, JSON, or YAML (pyyaml extra)
for op in operations:
    print(op.method, op.path)
    print(op.curl)
    print(op.example_variables)
```

The contract can be an **already-parsed dict**, a **JSON string**, or a **YAML
string** (requires `pip install "urban-http[openapi]"` for pyyaml; JSON needs
nothing).

## What each operation returns

```python
@dataclass
class CurlOperation:
    method: str                      # "GET", "POST"…
    path: str                        # "/users/{id}"
    operation_id: Optional[str]
    summary: Optional[str]
    curl: str                        # the curl command, with {{placeholders}}
    variables: list[str]             # names of the {{...}} present in the command
    example_variables: dict          # {name: value} ready for parse_curl(curl, …)
    parameters: list[OperationParam] # parameter table (path/query/header/cookie)
    body_example: Any                # generic body model (or None)
    content_type: Optional[str]
```

```python
@dataclass
class OperationParam:
    name: str
    location: str      # "path" | "query" | "header" | "cookie"
    required: bool
    type: str          # "integer", "string<date-time>"…
    example: Any        # suggested typed example value
    placeholder: str   # "{{id}}"
```

## Model generation (body and example values)

Properties are generated **exhaustively** (required or not), with typical values:

| Schema | Generated value |
|---|---|
| string | the **property name** (`"name"` for `name`) |
| string `format: date` | today's date (`2026-11-08`) |
| string `format: date-time` | the current instant (`2026-11-08T14:30:00Z`) |
| string `format: time` | the current time (`14:30:00`) |
| integer / number | `0` |
| boolean | `false` |
| **sub-object** | the sub-object, **expanded recursively** |
| **array** | **always a single element** |
| `enum` | the first value of the enumeration |
| explicit `example` / `default` | that value (deemed more useful) |

Local `$ref`s (`#/components/schemas/…` and `#/definitions/…`) are resolved.
`allOf` is merged; `oneOf`/`anyOf` takes the first schema. A **recursive** schema
(one that references itself) is cut at the first `$ref` re-occurrence, to guarantee
termination.

## Integration with the rest of the SDK

`example_variables` is **ready to pass to `parse_curl`**: the values are injectable
strings, and the command's `{{placeholders}}` are exactly the dictionary keys.

```python
from urban_http import openapi_to_curl, parse_curl, execute

op = openapi_to_curl(contract)[0]
req = parse_curl(op.curl, op.example_variables).requests[0]
# req is a resolved HTTP request, ready for execute(req)
```

You can also replace the example values with your own:

```python
my_values = {**op.example_variables, "orderId": "12345", "baseUrl": "https://prod.api"}
parse_curl(op.curl, my_values)
```

## Base URL

The base URL comes from `servers[0].url` (v3) or `schemes`+`host`+`basePath` (v2).
Server variables `{var}` become `{{var}}` (with their default value in
`example_variables`). When there is no server, `{{baseUrl}}` is used. You can force
the URL: `openapi_to_curl(contract, base_url="http://localhost:8080")`.

## Command line

```bash
urban-http --openapi contract.json           # prints the curl commands
urban-http --openapi contract.yaml --json     # structured JSON output
cat contract.json | urban-http --openapi -     # from stdin
```
