# Collections Postman — prise en charge

*(English version: [postman-collections.md](postman-collections.md))*

`parse_postman()` importe le format **Postman Collection v2.0 / v2.1 (JSON)** et
produit les mêmes `HttpRequestModel` que `parse_curl()` : tout l'aval
(`prepare_request`, `execute`) fonctionne à l'identique.

```python
from urban_http import parse_postman, is_postman_collection, execute

result = parse_postman(collection_json, {"baseUrl": "https://staging.example.com"})
for req in result.requests:
    print(req.name, req.method, req.url)
```

La légende des statuts est la même que dans [curl-use-cases.md](curl-use-cases.fr.md).

## Structure de la collection

| Cas d'usage | Statut |
|---|---|
| Schéma Collection v2.0 et v2.1 | ✅ (autre schéma : warning, import au mieux) |
| Dossiers imbriqués (`item` récursif) | ✅ (nom conservé dans `req.name`) |
| Forme courte `request: "https://..."` | ✅ |
| JSON invalide ou non-collection | ❌ erreur propre (`invalid-json`, `not-a-collection`) |

## URL et paramètres

| Cas d'usage | Statut |
|---|---|
| URL chaîne ou objet (`raw`, ou composée de `protocol/host/port/path`) | ✅ |
| Paramètres de query (`url.query`), désactivés exclus | ✅ |

## Variables

Guide complet : [variables.md](variables.fr.md).

| Cas d'usage | Statut |
|---|---|
| Variables de collection (`variable`) | ✅ |
| Valeurs externes via l'argument `variables` | ✅ prioritaires |
| Export d'environnement Postman | ✅ via `parse_postman_environment(json)` |
| Dynamiques `{{$guid}}`, `{{$randomUUID}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}` | ✅ |
| Variable non résolue | 🟡 conservée + warning `unresolved-variable` |

## En-têtes et corps

| Cas d'usage | Statut |
|---|---|
| En-têtes (liste, désactivés exclus ; forme texte brut acceptée) | ✅ |
| `raw` + `options.raw.language` → Content-Type déduit | ✅ |
| `urlencoded` (paires encodées, désactivées exclues) | ✅ |
| `formdata` (champs texte et fichiers, `contentType` par champ) | ✅ |
| `file` (corps binaire) | ✅ |
| `graphql` (query + variables → corps JSON) | ✅ |

## Authentification

| Type Postman | Statut |
|---|---|
| `basic` | ✅ `Authorization: Basic ...` |
| `bearer` | ✅ `Authorization: Bearer ...` |
| `apikey` (in: header ou query) | ✅ |
| `noauth` | ✅ |
| Héritage collection → dossier → requête | ✅ |
| `digest` | ✅ via `execute()` (négociation en deux requêtes) |
| `ntlm` | ❌ warning |
| `oauth1`, `oauth2`, `awsv4`, `hawk`… | ❌ warning |

## Comportement réseau

| Cas d'usage | Statut |
|---|---|
| Redirections suivies par défaut (comportement Postman) | ✅ |
| `protocolProfileBehavior.followRedirects: false` | ✅ |
| Scripts pre-request / tests | ❌ jamais exécutés — warning `scripts-not-executed` |
| Exemples de réponse (`response`) | ⚪ ignorés |
