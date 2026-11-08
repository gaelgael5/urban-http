# Collections Postman — prise en charge

`parsePostman()` importe le format **Postman Collection v2.0 / v2.1 (JSON)** et produit
les mêmes `HttpRequestModel` que `parseCurl()` : tout l'aval (`toFetch`, `execute`,
`toFetchCode`) fonctionne à l'identique.

```ts
import { parsePostman, isPostmanCollection, execute } from "urban-http";

const { requests, warnings } = parsePostman(collectionJson, {
  variables: { baseUrl: "https://staging.example.com", token: "..." },
});
for (const req of requests) {
  console.log(req.name, req.method, req.url);
}
```

La légende des statuts est la même que dans [curl-use-cases.md](curl-use-cases.md).

## Structure de la collection

| Cas d'usage | Statut |
|---|---|
| Schéma Collection v2.0 et v2.1 | ✅ (autre schéma : warning, import au mieux) |
| Dossiers imbriqués (`item` récursif) | ✅ (toutes les requêtes sont extraites, nom conservé dans `name`) |
| Forme courte `request: "https://..."` | ✅ |
| JSON invalide ou non-collection | ❌ erreur propre (`invalid-json`, `not-a-collection`) |

## URL et paramètres

| Cas d'usage | Statut |
|---|---|
| URL chaîne ou objet (`raw`, ou composée de `protocol/host/port/path`) | ✅ |
| Paramètres de query (`url.query`) | ✅ reconstruits depuis la liste |
| Paramètres **désactivés** dans Postman | ✅ exclus de l'URL finale (comme dans Postman) |

## Variables

| Cas d'usage | Statut |
|---|---|
| Variables de collection (`variable`) | ✅ substituées dans URL, en-têtes, corps, auth |
| Valeurs externes via `options.variables` (environnement) | ✅ prioritaires sur la collection |
| Variable non résolue | 🟡 conservée telle quelle (`{{var}}`) + warning `unresolved-variable` |
| Variables dynamiques `{{$guid}}`, `{{$timestamp}}`... | ❌ non générées (traitées comme non résolues) |

## En-têtes et corps

| Cas d'usage | Statut |
|---|---|
| En-têtes (liste, désactivés exclus ; forme texte brut acceptée) | ✅ |
| `raw` + `options.raw.language` → Content-Type déduit (json, xml, html, text, javascript) | ✅ |
| `urlencoded` (paires encodées, désactivées exclues) | ✅ |
| `formdata` (champs texte et fichiers, `contentType` par champ) | ✅ (fichiers résolus à l'exécution, comme pour curl `-F`) |
| `file` (corps binaire) | ✅ |
| `graphql` (query + variables → corps JSON) | ✅ |

## Authentification

| Type Postman | Statut |
|---|---|
| `basic` | ✅ `Authorization: Basic ...` |
| `bearer` | ✅ `Authorization: Bearer ...` |
| `apikey` (in: header ou query) | ✅ matérialisée en en-tête / paramètre |
| `noauth` | ✅ |
| Héritage collection → dossier → requête | ✅ (la plus proche l'emporte) |
| `digest` | ✅ via `execute()` (négociation en deux requêtes, comme côté curl) |
| `ntlm` | ❌ warning |
| `oauth1`, `oauth2`, `awsv4`, `hawk`... | ❌ warning `unsupported-auth` |

## Comportement réseau

| Cas d'usage | Statut |
|---|---|
| Redirections suivies par défaut (comportement Postman, contraire à curl) | ✅ |
| `protocolProfileBehavior.followRedirects: false` | ✅ |
| Scripts pre-request / tests | ❌ jamais exécutés — warning `scripts-not-executed` si présents |
| Fichiers d'exemples de réponse (`response`) | ⚪ ignorés |
