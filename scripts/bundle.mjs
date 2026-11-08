// Bundle navigateur : expose le SDK en global `UrbanHttp` pour le site de démo.
import { build } from "esbuild";

// Les modules Node et les bibliothèques de protocole sont chargés en import
// dynamique paresseux, uniquement à l'exécution d'un adaptateur côté Node.
// Dans le navigateur, seuls le parsing HTTP/Postman/protocole et l'exécution
// HTTP (fetch) servent ; ces modules ne sont jamais exécutés. On les marque
// externes pour qu'esbuild ne tente pas de les résoudre.
const external = [
  "undici",
  "node:fs", "node:fs/promises", "node:stream", "node:net", "node:tls",
  "node:dgram", "node:os", "node:path",
  "nodemailer", "basic-ftp", "ssh2", "mqtt", "@marsaud/smb2",
];

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "iife",
  globalName: "UrbanHttp",
  outfile: "demo/urban-http.browser.js",
  target: ["es2020"],
  external,
  logLevel: "info",
});
