# urban-http

SDK pour transformer une commande **curl** ou une **collection Postman** en
**appels HTTP exécutables** dans une application — Node ≥ 18 ou navigateur, sans dépendance à l'exécution.

```
commande curl ───▶ parseCurl() ────┐
                                   ├──▶ HttpRequestModel ──▶ toFetch() / execute()
collection Postman ─▶ parsePostman() ┘
```

## Utilisation

```ts
import { parseCurl, execute, toFetch, toFetchCode } from "urban-http";

const { requests, warnings } = parseCurl(
  `curl -X POST https://api.example.com/items \\
     -H 'Content-Type: application/json' \\
     -d '{"name": "clavier"}' \\
     -u alice:secret -m 10`
);

// 1. Inspecter la requête analysée
const req = requests[0];
req.method;       // "POST"
req.url;          // "https://api.example.com/items"
req.headers;      // [["Content-Type", "application/json"]]
req.body?.text;   // '{"name": "clavier"}'

// 2. L'exécuter directement (fetch, avec timeout et retries de curl)
const { response } = await execute(req);

// 3. Ou récupérer les paramètres fetch pour les utiliser soi-même
const { url, init } = toFetch(req);
await fetch(url, init);

// 4. Ou générer un extrait de code fetch lisible
console.log(toFetchCode(req));
```

Tout ce qui n'est pas reproductible (Digest, proxy, fichiers de cookies…) est **signalé
dans `warnings`** plutôt que silencieusement ignoré : chaque warning a un `code` stable,
un `message` en français et un niveau (`info` | `warning` | `error`).

## Variables

Les deux parsers acceptent `options.variables` :

```ts
// Placeholders {{nom}} partout, et $NOM / ${NOM} comme dans le shell
// (quotes doubles et arguments nus ; jamais dans les quotes simples)
const { requests } = parseCurl(
  `curl -H "Authorization: Bearer $TOKEN" {{baseUrl}}/users`,
  { variables: { baseUrl: "https://api.example.com", TOKEN: "tok-42" } }
);

// Les dynamiques Postman sont générées automatiquement :
// {{$guid}}, {{$randomUUID}}, {{$timestamp}}, {{$isoTimestamp}}, {{$randomInt}}
parseCurl(`curl --json '{"id": "{{$guid}}"}' {{baseUrl}}/items`, { variables });

// Un export d'environnement Postman se charge en une ligne
import { parsePostmanEnvironment } from "urban-http";
const variables = parsePostmanEnvironment(envJson);
```

Une variable non résolue est **laissée telle quelle et signalée par un warning**
(`unresolved-variable`, `unresolved-shell-variable`), jamais remplacée par du vide.
Sans `options.variables`, les `$` des commandes curl ne sont pas touchés.
Guide complet (contextes de quoting, priorités, codes de warning) :
**[docs/variables.md](docs/variables.md)**.

## Collections Postman

```ts
import { parsePostman, isPostmanCollection } from "urban-http";

const { requests } = parsePostman(collectionJson, {
  variables: { baseUrl: "https://staging.example.com" }, // valeurs d'environnement
});
requests[0].name; // le nom de la requête dans la collection
```

Le format **Collection v2.0 / v2.1** est importé vers le même modèle : dossiers imbriqués,
variables `{{...}}`, tous les modes de corps (raw, urlencoded, formdata, file, graphql),
auth basic/bearer/apikey avec héritage collection → dossier → requête.
Détail : **[docs/postman-collections.md](docs/postman-collections.md)**.

## Ce qui est pris en charge

L'inventaire complet des cas d'usage curl et leur statut (✅ supporté, 🟡 partiel,
⚪ ignoré, ❌ signalé) est dans **[docs/curl-use-cases.md](docs/curl-use-cases.md)**.

En résumé : syntaxe shell complète (quotes, continuations bash `\` et cmd `^`, `$'...'`),
méthodes, en-têtes, tous les `--data-*`, `--json`, `-G`, multipart `-F`, Basic/Bearer,
**Digest** (négociation en deux requêtes, MD5/SHA-256), cookies inline **et fichiers de
cookies Netscape**, **globbing d'URL** (`{a,b}`, `[1-10]`), redirections `-L`, timeout `-m`,
retries `--retry`, URLs multiples et `--next`. Côté Node, `-x/--proxy` et `-k/--insecure`
sont appliqués via [undici](https://www.npmjs.com/package/undici) (dépendance optionnelle :
`npm install undici`).

## Site de démonstration

`demo/index.html` est un playground : collez une commande curl, voyez la requête analysée,
les warnings, le code fetch généré, et exécutez la requête depuis le navigateur
(les exemples ciblent httpbin.org, qui autorise le CORS).

```bash
npm run build          # compile le SDK et le bundle navigateur demo/urban-http.browser.js
npx serve demo         # ou n'importe quel serveur statique
```

## Développement

```bash
npm install
npm test               # vitest : tokenizer, parser, exécution (fetch simulé)
npm run build          # tsc -> dist/ + bundle navigateur
```

## Feuille de route

- Digest `qop=auth-int`, certificats clients (`--cert`/`--key`).
- Davantage de variables dynamiques Postman (`{{$randomCity}}`, `{{$randomEmail}}`…).
- Générateurs de code supplémentaires (axios, Python requests…).
