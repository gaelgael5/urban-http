# Protocoles non-HTTP

curl ne se limite pas à HTTP : il envoie des mails (SMTP), transfère des
fichiers (FTP, SFTP, TFTP, SMB), lit des boîtes mail (POP3) et publie sur des
courtiers MQTT. urban-http couvre ces protocoles via un **sous-système
compartimenté** (`src/protocols/`) : le cœur HTTP n'en dépend pas, et chaque
protocole est un **adaptateur optionnel** qui s'appuie sur une bibliothèque
éprouvée, chargée seulement à la première exécution.

Protocoles couverts : **SMTP/SMTPS, FTP/FTPS, SFTP, POP3/POP3S, MQTT/MQTTS,
TFTP, FILE, SMB/SMBS, WS/WSS (WebSocket)**.

> **WebSocket est un cas à part** : il s'appuie sur l'API `WebSocket` standard,
> native dans le navigateur **et** dans Node ≥ 22. C'est donc le seul protocole
> non-HTTP qui s'exécute aussi côté navigateur, sans aucune dépendance. Le
> playground l'exécute réellement.

> Comme tout le SDK, une requête est **pilotée par la commande** que vous
> écrivez : un adaptateur exécute une seule opération explicite (envoyer ce
> mail, téléverser ce fichier, publier ce message), jamais de découverte ni
> d'itération implicite.

## Utilisation

```ts
import { run, registerDefaultNodeAdapters } from "urban-http";

registerDefaultNodeAdapters(); // une fois, au démarrage (Node)

// Envoi d'un mail
const { result } = await run(
  `curl smtp://mail.example.com --mail-from moi@example.com \
     --mail-rcpt toi@example.com -T message.eml`
);
console.log(result.summary); // "250 message accepté"
```

`run(commande)` détecte le protocole et route : `fetch` pour HTTP, l'adaptateur
enregistré sinon. Pour ne faire que l'analyse (sans exécuter) :

```ts
import { parseCommand } from "urban-http";

const parsed = parseCommand("curl ftp://bob@ftp.example.com/f.txt");
// { kind: "protocol", scheme: "ftp", request: { host, port, path, direction, ... } }
```

## Installation des bibliothèques

Les adaptateurs sont des **peer dependencies optionnelles** : installez seulement
celles dont vous avez besoin.

| Protocole | Bibliothèque | Install |
|---|---|---|
| SMTP / SMTPS | [nodemailer](https://www.npmjs.com/package/nodemailer) | `npm i nodemailer` |
| FTP / FTPS | [basic-ftp](https://www.npmjs.com/package/basic-ftp) | `npm i basic-ftp` |
| SFTP | [ssh2](https://www.npmjs.com/package/ssh2) | `npm i ssh2` |
| MQTT / MQTTS | [mqtt](https://www.npmjs.com/package/mqtt) | `npm i mqtt` |
| SMB / SMBS | [@marsaud/smb2](https://www.npmjs.com/package/@marsaud/smb2) | `npm i @marsaud/smb2` |
| POP3 / POP3S | — (node:net / node:tls) | aucune |
| TFTP | — (node:dgram) | aucune |
| FILE | — (node:fs) | aucune |
| WS / WSS | — (API WebSocket native) | aucune |

POP3, TFTP, FILE et WebSocket sont implémentés sans dépendance (modules natifs
de Node, ou API WebSocket standard).

## Correspondance commande → opération

| Commande curl | Opération |
|---|---|
| `curl smtp://h --mail-from a --mail-rcpt b -T msg` | envoi d'un mail (corps = `-T` ou `-d`) |
| `curl ftp://h/f` / `-T f ftp://h/` / `-l ftp://h/` | téléchargement / téléversement / listage |
| `curl -Q "CMD" ftp://h/f` | commande FTP brute avant le transfert |
| `curl sftp://u@h/f` / `-T f sftp://u@h/f` | téléchargement / téléversement SFTP |
| `curl pop3://u:p@h/` / `pop3://u:p@h/2` | liste des messages / message n°2 |
| `curl mqtt://h/topic -d "msg"` / `mqtt://h/topic` | publication / lecture du 1er message |
| `curl tftp://h/f` / `-T f tftp://h/f` | téléchargement / téléversement TFTP |
| `curl file:///chemin` / `-T src file:///dest` | lecture / écriture d'un fichier local |
| `curl smb://h/partage/f` / `-T f smb://h/partage/f` / `-l` | lecture / écriture / listage SMB |
| `curl ws://h/chemin -d "msg"` / `ws://h/chemin` | WebSocket : envoi de message(s) puis lecture de la réponse / lecture du 1er message (sous-protocole via `-H "Sec-WebSocket-Protocol: ..."`) |

Options communes reconnues : `-u user:pass` (ou `user:pass@hôte` dans l'URL),
`-k/--insecure`, `--ssl`/`--ssl-reqd` (TLS opportuniste / requis), `-o fichier`
(écrire le résultat), `-m`/`--connect-timeout`, `-r/--range` (FILE). Les
variables `{{...}}` et `$VAR` fonctionnent comme pour HTTP.

## Résultat

Chaque exécution renvoie un `ProtocolResult` normalisé :

```ts
interface ProtocolResult {
  scheme: string;
  ok: boolean;          // succès côté serveur
  summary: string;      // résumé lisible
  body?: Uint8Array;    // contenu récupéré (download, message, liste…)
  meta: Record<string, unknown>; // taille, codes serveur, identifiants…
  issues: string[];     // problèmes non bloquants
}
```

## Architecture — ajouter ou remplacer un adaptateur

Le registre est ouvert : un adaptateur est un objet `{ name, schemes, execute }`.

```ts
import { registerProtocol } from "urban-http";

registerProtocol({
  name: "mon-ftp",
  schemes: ["ftp", "ftps"],
  async execute(req, ctx) { /* ... */ return { scheme: req.scheme, ok: true, summary: "", meta: {}, issues: [] }; },
});
```

Chaque adaptateur de référence accepte aussi une **fabrique de client injectée**
via `ctx.clientFactory`, ce qui permet de le tester sans réseau et de brancher
une autre bibliothèque :

```ts
await run("curl ftp://h/f.txt", {
  clientFactory: () => monClientFtpSimulé, // au lieu de basic-ftp
});
```

## Côté navigateur

Le **parsing** protocolaire (`parseCommand`, `parseProtocolCommand`) est pur
texte et fonctionne dans le navigateur. Pour l'**exécution** :

- **HTTP** s'exécute via `fetch` ;
- **WebSocket** s'exécute aussi (API `WebSocket` native) — appelez
  `registerBrowserAdapters()` puis `run("curl ws://...")` ;
- les autres protocoles (sockets TCP/UDP) nécessitent Node.

Le playground illustre les trois : il analyse n'importe quelle commande, et
exécute celles en HTTP et en WebSocket.

## Hors périmètre

Les protocoles sans adaptateur (IMAP, LDAP, DICT, GOPHER, RTSP, SCP…) restent
signalés par le warning `unsupported-protocol`, comme décrit dans
[curl-coverage.md](curl-coverage.md) — pour IMAP, une bibliothèque dédiée
(imapflow) ; pour SCP, ssh2.
