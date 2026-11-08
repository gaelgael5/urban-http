# Panorama curl — ce qui est couvert, ce qui ne l'est pas

curl est un couteau suisse multi-protocoles : il sait envoyer des mails (SMTP),
transférer des fichiers (FTP, SFTP), lire des boîtes mail (IMAP, POP3), parler
MQTT, TELNET, LDAP… **urban-http a un périmètre volontairement plus étroit :
transformer une commande curl en appel HTTP applicatif (Python / `urllib`)**.

Ce document fait le tour de **tout** ce que sait faire curl, domaine par domaine.
La règle du SDK reste la même partout : ce qui est hors périmètre est **détecté
et signalé par un warning à code stable**, jamais ignoré en silence.

**Légende** : ✅ couvert · 🟡 partiel / approximé · ⚪ sans objet dans un SDK
(option de confort du CLI, acceptée sans erreur) · ❌ hors périmètre, signalé.

---

## 1. Protocoles

Le cœur HTTP passe par `urllib` (bibliothèque standard). Les autres protocoles
sont couverts par des **adaptateurs** (voir [protocols.md](protocols.md)) :
le SDK les analyse en requête structurée et les exécute via une bibliothèque
éprouvée. Les protocoles sans adaptateur produisent toujours le warning
**`unsupported-protocol`** avec une alternative suggérée.

| Protocole | Ce que curl en fait | Statut | Moteur |
|---|---|---|---|
| **HTTP / HTTPS** | le cœur | ✅ | urllib (stdlib) |
| **SMTP / SMTPS** | envoi de mails (`--mail-from`, `--mail-rcpt`, corps via `-T`) | ✅ | nodemailer |
| **FTP / FTPS** | transfert de fichiers (`-Q`, `--ftp-create-dirs`, `-l`) | ✅ | basic-ftp |
| **SFTP** | transfert via SSH | ✅ | ssh2 |
| **POP3 / POP3S** | lecture de boîte mail (liste, RETR n) | ✅ | node:net / node:tls |
| **MQTT / MQTTS** | publier / lire un message | ✅ | mqtt.js |
| **TFTP** | transfert UDP par blocs | ✅ | node:dgram |
| **FILE** | lecture/écriture de fichier local | ✅ | node:fs |
| **SMB / SMBS** | partage de fichiers | ✅ | @marsaud/smb2 |
| **WS / WSS** | WebSocket (envoi/réception) | ✅ | websockets (extra) |
| **IMAP(S)** | lecture de boîte mail | ❌ | imapflow… |
| **SCP** | copie via SSH | ❌ | ssh2 (manuel) |
| **LDAP(S), TELNET, DICT, GOPHER(S), RTSP, RTMP** | divers | ❌ | — |

Les options propres aux protocoles couverts sont interprétées (`--mail-from`,
`--mail-rcpt`, `-Q/--quote`, `-l/--list-only`, `--ssl`, `--ssl-reqd`, `-T`,
`-o`…). Celles des protocoles encore hors périmètre (`-t/--telnet-option`…)
restent signalées par `unsupported-protocol-option`.

## 2. Construction de la requête HTTP

Détail complet : [curl-use-cases.md](curl-use-cases.md).

| Domaine | Statut |
|---|---|
| Syntaxe shell (quotes, continuations bash `\` / cmd `^`, `$'...'`, options groupées, `--opt=val`, `--no-*`) | ✅ |
| Méthodes (`-X`, `-I`, `-G`, implicites), URLs multiples, `--next`, globbing `{a,b}` `[1-10]` | ✅ |
| En-têtes (`-H`, valeur vide, suppression, `-A`, `-e`, `-r`, `--compressed`) | ✅ |
| Corps : `-d`, `--data-raw/-binary/-urlencode`, `--json`, `-F` multipart, `-T`, fichiers `@` | ✅ |
| `--url-query` (paramètres encodés ajoutés à l'URL, curl 7.87+) | ✅ |
| `--request-target`, `--form-escape`, en-têtes multipart par partie | ❌ signalés |

## 3. Authentification

| Mécanisme | Statut |
|---|---|
| Basic (`-u`), Bearer (`--oauth2-bearer`) | ✅ |
| Digest (`--digest`) : MD5, MD5-sess, SHA-256, SHA-256-sess, qop=auth, RFC 2069 | ✅ via `execute()` (2 requêtes) |
| Digest `qop=auth-int` | ❌ (hachage du corps requis) |
| NTLM, Negotiate/Kerberos (`--ntlm`, `--negotiate`, `--krb`, `--delegation`) | ❌ (protocoles propriétaires multi-allers) |
| AWS SigV4 (`--aws-sigv4`) | ❌ (signature non calculée) |
| `.netrc` (`-n`, `--netrc`, `--netrc-file`) | ❌ signalé |

## 4. Cookies

| Fonction | Statut |
|---|---|
| Cookies inline (`-b "a=1"`) | ✅ |
| Lecture d'un fichier Netscape (`-b cookies.txt`), filtrage domaine/chemin/expiration/secure | ✅ (`file_reader` injectable) |
| Écriture du cookie jar (`-c`), moteur de session entre requêtes | ⚪ propre au CLI — l'application garde la main sur l'état |
| `-j/--junk-session-cookies` | ⚪ |

## 5. TLS et certificats

| Fonction | Statut |
|---|---|
| `-k/--insecure` | ✅ (contexte SSL non vérifié) |
| CA personnalisée (`--cacert`, `--capath`), certificat client (`--cert`, `--key`, `--pass`) | ❌ signalés |
| Épinglage (`--pinnedpubkey`), ciphers (`--ciphers`, `--tls13-ciphers`) | ❌ / ⚪ |
| Versions TLS (`--tlsv1.2`, `--tlsv1.3`) | ⚪ négociées par la plateforme |

## 6. Proxies

| Fonction | Statut |
|---|---|
| Proxy HTTP(S) (`-x/--proxy`), auth Basic proxy (`-U/--proxy-user`) | ✅ via `urllib.ProxyHandler` |
| SOCKS (`--socks4`, `--socks4a`, `--socks5`, `--socks5-hostname`) | ❌ signalés |
| `--proxy-digest`, `--proxy-ntlm`, `--noproxy` | ❌ / ⚪ |

## 7. Redirections, robustesse, temps

| Fonction | Statut |
|---|---|
| `-L`, `--location-trusted`, `--max-redirs`, `--post30x` | ✅ / 🟡 (sémantique urllib) |
| `-m/--max-time` → `timeout` de `urlopen` | ✅ |
| `--connect-timeout` | 🟡 approximé |
| `--retry`, `--retry-delay` (backoff exponentiel sur 408/429/5xx) | ✅ |
| `--retry-all-errors`, `--retry-max-time`, `--retry-connrefused` | ⚪ acceptées, non différenciées |
| Reprise de transfert (`-C/--continue-at`) | ❌ signalé |

## 8. Variables

Détail complet : [variables.md](variables.md).

| Fonction | Statut |
|---|---|
| `{{nom}}` (Postman) partout, `$VAR`/`${VAR}` selon le quoting shell | ✅ |
| Dynamiques `{{$guid}}`, `{{$randomUUID}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}` | ✅ |
| `--variable NOM=valeur`, `--variable %NOM[=défaut]`, `--expand-url/-data/-header` (curl 8.3+) | ✅ (notre substitution est globale, celle de curl se limite aux `--expand-*`) |
| `--variable NOM@fichier`, fonctions d'expansion (`{{nom:trim}}`, `{{nom:json}}`…) | ❌ signalés |

## 9. Transferts et performance

| Fonction | Statut |
|---|---|
| Upload HTTP (`-T` → PUT) | ✅ |
| Exécution parallèle (`-Z/--parallel`, `--parallel-max`) | 🟡 les requêtes sont toutes renvoyées ; l'orchestration (`Promise.all`) revient à l'application |
| Limitation de débit (`--limit-rate`, `--rate`), seuils (`--speed-limit/-time`) | ❌ / ⚪ |
| Taille maximale (`--max-filesize`) | ⚪ |
| HTTP/2, HTTP/3 (`--http2`, `--http3`) | ⚪ négociés par la plateforme |

## 10. Réseau avancé et DNS

| Fonction | Statut |
|---|---|
| `--resolve`, `--connect-to`, `--dns-servers`, `--doh-url` | ❌ signalés |
| `--interface`, `--local-port`, `--unix-socket`, `--abstract-unix-socket` | ❌ signalés |
| `-4`, `-6`, `--tcp-nodelay`, `--tcp-fastopen`, `--happy-eyeballs-timeout-ms`, `--keepalive-time` | ⚪ |

## 11. Fonctions CLI (sans objet dans un SDK)

Le SDK renvoie une `Response` : l'application décide quoi en faire. Toutes ces
options sont **acceptées sans erreur** pour qu'une commande copiée passe telle
quelle : `-o`, `-O`, `-J`, `-D`, `-i`, `-s`, `-S`, `-v`, `-#`, `-w/--write-out`,
`--trace*`, `--stderr`, `--styled-output`, `--output-dir`, `--create-dirs`,
`--remove-on-error`, `-f/--fail`, `--fail-with-body`, `--etag-save`,
`--help`, `--version`.

## 12. Divers

| Fonction | Statut |
|---|---|
| Requêtes conditionnelles (`-z/--time-cond`, `--etag-compare`) | ❌ signalées (posez `If-Modified-Since` / `If-None-Match` via `-H`) |
| Fichier de configuration (`-K/--config`), `--libcurl` | ❌ signalés |
| Caches HSTS / Alt-Svc (`--hsts`, `--alt-svc`) | ❌ / ⚪ |
| Lecture depuis stdin (`-d @-`) | ❌ signalée |

---

## En résumé

- **Tout le périmètre « appel HTTP applicatif » de curl est couvert** : requête,
  corps, auth (Basic/Bearer/Digest), cookies, variables, redirections, retries,
  timeout, globbing, multipart — plus l'import Postman.
- **Les principaux protocoles non-HTTP sont couverts** par des adaptateurs
  (SMTP, FTP/FTPS, SFTP, POP3, MQTT, TFTP, FILE, SMB, WebSocket) — voir
  [protocols.md](protocols.md). Le cœur reste
  compartimenté : les adaptateurs à dépendance ne sont chargés qu'à l'usage.
- **Restent hors périmètre** IMAP, LDAP, TELNET, DICT, GOPHER, RTSP, SCP… :
  signalés par `unsupported-protocol` avec une alternative.
- Quelques fonctions HTTP non couvertes (auth-int, certificats clients, SOCKS,
  conditionnelles `-z`) sont listées dans la
  [feuille de route](../README.md#feuille-de-route) ou signalées par warning.
