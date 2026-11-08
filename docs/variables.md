# Variables — guide complet

`parseCurl` et `parsePostman` acceptent tous les deux une option `variables` :

```ts
parseCurl(commande, { variables: { baseUrl: "https://api.example.com", TOKEN: "tok-42" } });
parsePostman(collectionJson, { variables: { ... } });
```

Trois mécanismes sont pris en charge, implémentés dans un module unique
(`src/variables.ts`) partagé par les deux parsers.

---

## 1. Placeholders Postman `{{nom}}`

Substitués **partout** : URL, en-têtes, corps, authentification — dans les
commandes curl comme dans les collections Postman.

```ts
const { requests } = parseCurl(
  `curl -H 'X-Api-Key: {{apiKey}}' {{baseUrl}}/users`,
  { variables: { baseUrl: "https://api.example.com", apiKey: "k-123" } }
);
requests[0].url; // "https://api.example.com/users"
```

## 2. Variables shell `$VAR` et `${VAR}` (commandes curl)

Une commande copiée d'un script ou d'une documentation contient souvent des
variables d'environnement (`curl -H "Authorization: Bearer $TOKEN" ...`).
Le SDK les résout **exactement comme bash l'aurait fait** avant d'appeler curl :

| Contexte | Comportement | Exemple |
|---|---|---|
| Argument nu | ✅ substitué | `curl https://$HOST/me` |
| Quotes doubles `"..."` | ✅ substitué | `-H "Authorization: Bearer $TOKEN"` |
| Quotes simples `'...'` | ❌ jamais substitué (comme bash) | `-d '$TOKEN'` envoie littéralement `$TOKEN` |

La substitution est faite par le **tokenizer**, car lui seul connaît le contexte
de quoting de chaque caractère.

Deux choix volontaires, différents de bash, plus sûrs pour un SDK :

- **Opt-in** : sans `options.variables`, aucun `$` n'est touché et aucun warning
  n'est émis — un mot de passe `pa$$word` ou un corps contenant `$` restent intacts.
- **Pas de word-splitting** : une valeur contenant des espaces reste dans son
  token, elle n'est jamais re-découpée en plusieurs arguments.

## 3. Variables dynamiques Postman `{{$...}}`

Générées automatiquement, **à chaque occurrence** (deux `{{$guid}}` dans la même
commande donnent deux UUID différents, comme dans Postman). Aucune option à
passer : elles fonctionnent même sans `options.variables`.

| Variable | Valeur générée |
|---|---|
| `{{$guid}}`, `{{$randomUUID}}` | UUID v4 |
| `{{$timestamp}}` | secondes Unix (ex: `1762598400`) |
| `{{$isoTimestamp}}` | horodatage ISO 8601 (ex: `2026-11-08T10:00:00.000Z`) |
| `{{$randomInt}}` | entier entre 0 et 1000 |

Toute autre dynamique Postman (`{{$randomCity}}`, `{{$randomEmail}}`…) est
laissée telle quelle et signalée par le warning `unsupported-dynamic-variable`.

---

## Environnements Postman

Un export d'environnement Postman (`{ values: [{ key, value, enabled }] }`)
se charge en une ligne :

```ts
import { parsePostmanEnvironment, parsePostman } from "urban-http";

const variables = parsePostmanEnvironment(envJson); // les entrées enabled:false sont ignorées
const { requests } = parsePostman(collectionJson, { variables });
```

`parsePostmanEnvironment` tolère aussi un simple objet `{ clé: valeur }`,
qu'il renvoie tel quel.

## Priorité des sources

Comme dans Postman, la source la plus « proche de l'exécution » gagne :

```
options.variables (environnement)  >  variables de la collection
```

```ts
// collection : baseUrl = https://prod.example.com
parsePostman(collection, { variables: { baseUrl: "https://staging.example.com" } });
// → les requêtes ciblent staging
```

## Variables non résolues : jamais d'échec silencieux

Une variable sans valeur est **laissée telle quelle** dans la requête — jamais
remplacée par du vide — et signalée par un warning à code stable :

| Code | Déclencheur | Niveau |
|---|---|---|
| `unresolved-variable` | `{{nom}}` sans valeur | warning |
| `unresolved-shell-variable` | `$NOM` absent de la map (seulement si `options.variables` est fourni) | warning |
| `unsupported-dynamic-variable` | `{{$dynamique}}` non prise en charge | warning |

```ts
const { requests, warnings } = parseCurl(`curl {{apiHost}}/users`);
requests[0].url;  // "{{apiHost}}/users" — conservé
warnings[0].code; // "unresolved-variable"
```

## Dans le site de démo

Le playground (`demo/index.html`) a un panneau **Variables** : une ligne
`clé=valeur` par variable (les lignes vides ou commençant par `#` sont
ignorées). Les valeurs alimentent en direct les deux parsers — l'exemple
« Jamais dans les quotes simples » montre la différence `-d '$TOKEN'` vs
`-d "$TOKEN"` d'un coup d'œil.
