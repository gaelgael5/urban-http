# OpenAPI → curl

`openapi_to_curl(contrat)` lit un contrat **OpenAPI v3.x** (et, au mieux, Swagger
v2) et renvoie, pour chaque opération (path + méthode), une commande curl prête à
l'emploi avec des variables `{{...}}` injectables.

```python
from urban_http import openapi_to_curl

operations = openapi_to_curl(contrat)   # dict, JSON, ou YAML (extra pyyaml)
for op in operations:
    print(op.method, op.path)
    print(op.curl)
    print(op.example_variables)
```

Le contrat peut être un **dict déjà parsé**, une **chaîne JSON**, ou une **chaîne
YAML** (nécessite `pip install "urban-http[openapi]"` pour pyyaml ; le JSON ne
requiert rien).

## Ce que renvoie chaque opération

```python
@dataclass
class CurlOperation:
    method: str                      # "GET", "POST"…
    path: str                        # "/users/{id}"
    operation_id: Optional[str]
    summary: Optional[str]
    curl: str                        # la commande curl, avec des {{placeholders}}
    variables: list[str]             # noms des {{...}} présents dans la commande
    example_variables: dict          # {nom: valeur} prêt pour parse_curl(curl, …)
    parameters: list[OperationParam] # tableau des paramètres (path/query/header/cookie)
    body_example: Any                # modèle générique du corps (ou None)
    content_type: Optional[str]
```

```python
@dataclass
class OperationParam:
    name: str
    location: str      # "path" | "query" | "header" | "cookie"
    required: bool
    type: str          # "integer", "string<date-time>"…
    example: Any        # valeur type (typée) suggérée
    placeholder: str   # "{{id}}"
```

## Génération du modèle (corps et valeurs d'exemple)

Les propriétés sont générées **exhaustivement** (requises ou non), avec des
valeurs types :

| Schéma | Valeur générée |
|---|---|
| chaîne | le **nom de la propriété** (`"nom"` pour `nom`) |
| chaîne `format: date` | la date du jour (`2026-11-08`) |
| chaîne `format: date-time` | l'instant courant (`2026-11-08T14:30:00Z`) |
| chaîne `format: time` | l'heure courante (`14:30:00`) |
| entier / nombre | `0` |
| booléen | `false` |
| **sous-objet** | le sous-objet, **développé récursivement** |
| **tableau** | **toujours un seul élément** |
| `enum` | la première valeur de l'énumération |
| `example` / `default` explicites | cette valeur (jugée plus utile) |

Les `$ref` locaux (`#/components/schemas/…` et `#/definitions/…`) sont résolus.
`allOf` est fusionné ; `oneOf`/`anyOf` prend le premier schéma. Un schéma
**récursif** (qui se référence) est coupé dès la ré-occurrence du `$ref`, pour
garantir la terminaison.

## Intégration avec le reste du SDK

`example_variables` est **prêt à passer à `parse_curl`** : les valeurs sont des
chaînes injectables, et les `{{placeholders}}` de la commande sont exactement les
clés du dictionnaire.

```python
from urban_http import openapi_to_curl, parse_curl, execute

op = openapi_to_curl(contrat)[0]
req = parse_curl(op.curl, op.example_variables).requests[0]
# req est une requête HTTP résolue, prête pour execute(req)
```

Vous pouvez aussi remplacer les valeurs d'exemple par les vôtres :

```python
mes_valeurs = {**op.example_variables, "orderId": "12345", "baseUrl": "https://prod.api"}
parse_curl(op.curl, mes_valeurs)
```

## URL de base

L'URL de base vient de `servers[0].url` (v3) ou `schemes`+`host`+`basePath` (v2).
Les variables de serveur `{var}` deviennent `{{var}}` (avec leur valeur par défaut
dans `example_variables`). En l'absence de serveur, `{{baseUrl}}` est utilisé. On
peut forcer l'URL : `openapi_to_curl(contrat, base_url="http://localhost:8080")`.

## Ligne de commande

```bash
urban-http --openapi contrat.json           # affiche les commandes curl
urban-http --openapi contrat.yaml --json     # sortie JSON structurée
cat contrat.json | urban-http --openapi -     # depuis stdin
```
