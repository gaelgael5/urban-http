# Cas d'usage curl — inventaire et prise en charge

Ce document liste les cas d'usage de curl pertinents pour un appel HTTP applicatif,
et le statut de chacun dans le parser `urban-http`.

**Légende des statuts :**

| Statut | Signification |
|---|---|
| ✅ Supporté | Reproduit fidèlement dans l'appel HTTP généré |
| 🟡 Partiel | Pris en charge avec une approximation documentée (warning `partial-option`) |
| ⚪ Ignoré | Option propre au CLI, sans effet sur la requête HTTP (acceptée, parfois signalée en `info`) |
| ❌ Non supporté | Détecté et signalé par un warning, mais non appliqué |

---

## 1. Syntaxe de la ligne de commande

| Cas d'usage | Exemple | Statut |
|---|---|---|
| Commande simple | `curl https://api.example.com` | ✅ |
| Mot `curl` absent (arguments seuls) | `-X GET https://e.com` | ✅ |
| `curl.exe`, prompt `$` ou `sudo` en tête | `$ curl.exe ...` | ✅ |
| Quotes simples `'...'` | `curl -d '{"a":1}'` | ✅ |
| Quotes doubles `"..."` avec échappements `\" \\ \$` | `curl -H "X: \"v\""` | ✅ |
| Continuations de ligne bash `\` | `curl -X POST \`↵`  https://e.com` | ✅ |
| Continuations de ligne cmd Windows `^` (export Postman) | `curl -X POST ^`↵` "https://e.com"` | ✅ |
| Doubles quotes doublées `""` du cmd Windows | `curl -d "{""a"":1}" ^`↵ | ✅ |
| Quoting ANSI-C `$'...'` (`\n`, `\t`, `\xHH`, `\uHHHH`...) | `curl -d $'a\nb'` | ✅ |
| Options courtes groupées | `curl -sSL https://e.com` | ✅ |
| Valeur collée à l'option courte | `curl -XPOST https://e.com` | ✅ |
| Forme `--option=valeur` (tolérance : curl ne l'accepte pas) | `--max-time=5` | ✅ |
| Négation `--no-<option>` | `--no-location` | ✅ |
| Option inconnue | `--frobnicate` | ❌ warning `unknown-option`, parsing poursuivi |
| Lecture depuis stdin (`-`) | `curl -d @- ...` | ❌ warning |
| Fichier de configuration | `-K, --config` | ❌ warning |

## 2. URL et méthode

| Cas d'usage | Options | Statut |
|---|---|---|
| URL positionnelle | `curl https://e.com` | ✅ |
| URL explicite | `--url` | ✅ |
| Schéma manquant → `http://` ajouté (comme curl) | `curl example.com` | ✅ (info `default-scheme`) |
| Plusieurs URLs avec la même configuration | `curl -H "X: 1" url1 url2` | ✅ (une requête par URL) |
| Requêtes indépendantes enchaînées | `--next` | ✅ |
| Méthode explicite | `-X, --request` | ✅ |
| HEAD | `-I, --head` | ✅ (`-X` l'emporte, comme curl) |
| GET forcé avec données en query string | `-G, --get` | ✅ |
| Méthode implicite POST (si corps) / PUT (si `-T`) / GET sinon | — | ✅ |
| Globbing d'URL : alternatives `{a,b}`, plages `[1-10]`, `[01-10]` (zéro-padding), `[a-z]`, pas `[0-100:25]`, produit cartésien | `curl http://e.com/[1-10]` | ✅ développé en plusieurs requêtes (limite : 500 URLs) |
| Motif de globbing invalide (ex : hôte IPv6 `[::1]`) ou trop large | — | 🟡 warning `url-globbing`, URL utilisée telle quelle |
| Désactiver le globbing | `-g, --globoff` | ✅ |

## 3. En-têtes

| Cas d'usage | Options | Statut |
|---|---|---|
| En-tête simple, ordre préservé, multiples | `-H "Accept: application/json"` | ✅ |
| En-tête à valeur vide | `-H "X-Empty;"` | ✅ |
| Suppression d'un en-tête généré | `-H "User-Agent:"` | ✅ |
| User-Agent | `-A, --user-agent` | ✅ |
| Referer | `-e, --referer` | ✅ (`;auto` ignoré, info) |
| Range | `-r, --range` → `Range: bytes=...` | ✅ |
| Compression | `--compressed` → `Accept-Encoding: gzip, deflate, br` | ✅ (fetch décompresse automatiquement) |
| En-têtes depuis un fichier | `-H @fichier` | ❌ warning |

## 4. Corps de requête

| Cas d'usage | Options | Statut |
|---|---|---|
| Données POST (Content-Type urlencoded par défaut) | `-d, --data, --data-ascii` | ✅ |
| Plusieurs `-d` concaténés avec `&` | `-d a=1 -d b=2` | ✅ |
| Données brutes (`@` non interprété) | `--data-raw` | ✅ |
| Données binaires | `--data-binary` | ✅ |
| Encodage URL de la valeur (`contenu`, `=contenu`, `nom=contenu`) | `--data-urlencode` | ✅ |
| Raccourci JSON (body + `Content-Type` + `Accept`) | `--json '{"a":1}'` | ✅ |
| Corps depuis un fichier | `-d @fichier` | ✅ Node (CR/LF supprimés comme curl) / 🟡 navigateur via `readFile` injectable |
| Upload de fichier brut (PUT) | `-T, --upload-file` | ✅ Node / 🟡 navigateur |
| Formulaire multipart | `-F, --form` | ✅ (`FormData`, boundary géré par fetch) |
| Champ fichier avec attributs | `-F "f=@x.png;type=image/png;filename=y.png"` | ✅ |
| Contenu de fichier comme champ texte | `-F "notes=<notes.txt"` | ✅ |
| Valeur littérale sans interprétation | `--form-string` | ✅ |
| En-têtes par partie multipart | `-F "...;headers=..."` | ❌ info |

## 5. Authentification

| Cas d'usage | Options | Statut |
|---|---|---|
| Basic | `-u user:pass` → `Authorization: Basic ...` | ✅ |
| Bearer | `--oauth2-bearer TOKEN` → `Authorization: Bearer ...` | ✅ |
| Basic explicite | `--basic` | ✅ |
| Digest | `--digest` | ✅ via `execute()` : négociation en deux requêtes (MD5, MD5-sess, SHA-256, SHA-256-sess ; qop=auth ou RFC 2069). `qop=auth-int` ❌. Navigateur : le serveur doit exposer `WWW-Authenticate` via CORS |
| NTLM / Negotiate (Kerberos) | `--ntlm, --negotiate` | ❌ warning |
| Signature AWS | `--aws-sigv4` | ❌ warning |

## 6. Cookies

| Cas d'usage | Options | Statut |
|---|---|---|
| Cookies inline | `-b "a=1; b=2"` → en-tête `Cookie` | ✅ |
| Cookies depuis un fichier (format Netscape, `#HttpOnly_` inclus) | `-b cookies.txt` | ✅ Node (filtrage domaine / chemin / expiration / secure, comme curl) / 🟡 navigateur via `readFile` |
| Écriture du cookie jar | `-c, --cookie-jar` | ⚪ info (propre au CLI) |
| Ignorer les cookies de session | `-j, --junk-session-cookies` | ⚪ |

## 7. Redirections

| Cas d'usage | Options | Statut |
|---|---|---|
| Suivre les redirections (curl ne suit pas par défaut, le SDK non plus) | `-L, --location` | ✅ (`redirect: "follow"` / `"manual"`) |
| Limite de redirections | `--max-redirs N` | 🟡 non applicable à fetch, conservé dans le modèle |
| Credentials conservés après redirection | `--location-trusted` | 🟡 suit les redirections, info sur la limite |
| Comportement 301/302/303 | `--post301/302/303` | 🟡 sémantique standard fetch |

## 8. TLS, proxy et réseau

| Cas d'usage | Options | Statut |
|---|---|---|
| Ignorer la vérification TLS | `-k, --insecure` | ✅ Node (paquet `undici` requis : `npm install undici`) / ❌ navigateur (impossible) |
| CA / certificat client / clé | `--cacert, --cert (-E), --key` | ❌ warning |
| Proxy HTTP(S), avec authentification | `-x, --proxy, --proxy-user (-U)` | ✅ Node via `undici.ProxyAgent` (paquet `undici` requis) / ❌ navigateur |
| Version HTTP | `--http1.1, --http2, --http3` | ⚪ négociée par la plateforme, conservée à titre informatif |
| IPv4/IPv6, versions TLS | `-4, -6, --tlsv1.2, --tlsv1.3` | ⚪ |
| DNS personnalisé, socket Unix, interface | `--resolve, --connect-to, --unix-socket, --interface` | ❌ warning |

## 9. Timeouts et robustesse

| Cas d'usage | Options | Statut |
|---|---|---|
| Timeout global | `-m, --max-time` → `AbortSignal.timeout()` | ✅ |
| Timeout de connexion | `--connect-timeout` | 🟡 approximé (fetch n'a pas de timeout de connexion distinct) |
| Retries sur erreurs transitoires (408, 429, 500, 502, 503, 504) | `--retry N` | ✅ (backoff exponentiel 1s, 2s, 4s... comme curl) |
| Délai entre retries | `--retry-delay` | ✅ |
| Limitation de débit | `--limit-rate` | ❌ warning |

## 10. Options CLI sans effet sur la requête (acceptées, ignorées)

`-s` (silent), `-S` (show-error), `-v` (verbose), `-i` (include), `-o` (output), `-O` (remote-name),
`-J`, `-D` (dump-header), `-w` (write-out), `-f` (fail), `--fail-with-body`, `-#` (progress-bar),
`--trace`, `--trace-ascii`, `--help`, `--version`, `--raw`, `--path-as-is`, `--styled-output`,
`--keepalive-time`, `--no-keepalive`.

Elles sont parsées sans erreur pour que n'importe quelle commande copiée d'un terminal
ou d'un export Postman passe telle quelle.

## 11. Variables

Activées en passant `options.variables` à `parseCurl(commande, options)`.

| Cas d'usage | Exemple | Statut |
|---|---|---|
| Placeholder Postman `{{nom}}` (URL, en-têtes, corps, partout) | `curl {{baseUrl}}/users` | ✅ |
| Variable shell `$NOM` / `${NOM}`, à nu ou dans des quotes doubles | `curl -H "Authorization: Bearer $TOKEN" ...` | ✅ (uniquement si `options.variables` est fourni) |
| `$NOM` dans des quotes simples : jamais substitué (comme bash) | `curl -d '$TOKEN' ...` | ✅ |
| Valeur avec espaces : reste dans son token (pas de word-splitting bash) | — | ✅ (volontaire, plus sûr pour un SDK) |
| Dynamiques `{{$guid}}`, `{{$randomUUID}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}` | `curl --json '{"id": "{{$guid}}"}' ...` | ✅ générées à chaque occurrence, comme Postman |
| Autres dynamiques Postman (`{{$randomCity}}`…) | — | ❌ warning `unsupported-dynamic-variable`, laissées telles quelles |
| Variable non résolue (`{{x}}` ou `$X` absent de la map) | — | 🟡 laissée telle quelle + warning (`unresolved-variable` / `unresolved-shell-variable`) |

---

## Et Postman ?

L'export « Copy as cURL » de Postman (bash **et** cmd Windows) est couvert par ce parser :
continuations `^`, quotes doublées `""`, `--data-raw`, etc.
L'import direct du format **Postman Collection v2.0 / v2.1 (JSON)** est assuré par
`parsePostman()` — voir [postman-collections.md](postman-collections.md).
