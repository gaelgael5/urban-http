# Variables — guide complet

`parse_curl` et `parse_postman` acceptent tous deux un dictionnaire `variables` :

```python
parse_curl(command, {"baseUrl": "https://api.example.com", "TOKEN": "tok-42"})
parse_postman(collection_json, {"baseUrl": "https://api.example.com"})
```

Trois mécanismes, implémentés dans un module unique (`urban_http/variables.py`)
partagé par les deux parsers.

## 1. Placeholders Postman `{{nom}}`

Substitués **partout** : URL, en-têtes, corps, authentification — dans les
commandes curl comme dans les collections Postman.

```python
r = parse_curl("curl -H 'X-Api-Key: {{apiKey}}' {{baseUrl}}/users",
               {"baseUrl": "https://api.example.com", "apiKey": "k-123"})
r.requests[0].url  # "https://api.example.com/users"
```

## 2. Variables shell `$VAR` et `${VAR}` (commandes curl)

Une commande copiée d'un script contient souvent des variables d'environnement.
Le SDK les résout **comme bash l'aurait fait** avant d'appeler curl :

| Contexte | Comportement | Exemple |
|---|---|---|
| Argument nu | ✅ substitué | `curl https://$HOST/me` |
| Quotes doubles `"..."` | ✅ substitué | `-H "Authorization: Bearer $TOKEN"` |
| Quotes simples `'...'` | ❌ jamais (comme bash) | `-d '$TOKEN'` envoie littéralement `$TOKEN` |

Deux choix volontaires, plus sûrs pour un SDK :

- **Opt-in** : sans dictionnaire `variables`, aucun `$` n'est touché et aucun
  warning n'est émis (un mot de passe `pa$$word` reste intact).
- **Pas de découpage en mots** : une valeur avec espaces reste dans son token.

## 3. Variables dynamiques Postman `{{$...}}`

Générées à **chaque occurrence** (deux `{{$guid}}` donnent deux UUID différents).
Aucune option à passer.

| Variable | Valeur |
|---|---|
| `{{$guid}}`, `{{$randomUUID}}` | UUID v4 (`uuid.uuid4()`) |
| `{{$timestamp}}` | secondes Unix |
| `{{$isoTimestamp}}` | horodatage ISO 8601 |
| `{{$randomInt}}` | entier 0–1000 |

Toute autre dynamique est laissée telle quelle et signalée
(`unsupported-dynamic-variable`).

## Environnements Postman

```python
from urban_http import parse_postman_environment, parse_postman

variables = parse_postman_environment(env_json)   # {values: [{key, value, enabled}]} ou {clé: valeur}
parse_postman(collection_json, variables)
```

Priorité : `variables` (environnement) **>** variables de la collection, comme
dans Postman.

## Variables non résolues : jamais d'échec silencieux

Une variable sans valeur est **laissée telle quelle** et signalée :

| Code | Déclencheur |
|---|---|
| `unresolved-variable` | `{{nom}}` sans valeur |
| `unresolved-shell-variable` | `$NOM` absent du dictionnaire |
| `unsupported-dynamic-variable` | `{{$dynamique}}` non prise en charge |

```python
r = parse_curl("curl {{apiHost}}/users")
r.requests[0].url     # "{{apiHost}}/users" — conservé
r.warnings[0].code    # "unresolved-variable"
```

## Variables natives curl 8.3+

`--variable NOM=valeur`, `--variable %NOM[=défaut]` et `--expand-url/-data/-header`
sont pris en charge (la substitution `{{...}}` du SDK est un sur-ensemble des
`--expand-*` de curl).

```python
parse_curl("curl --variable host=api.e.com --expand-url 'https://{{host}}/ping'")
# → https://api.e.com/ping
```
