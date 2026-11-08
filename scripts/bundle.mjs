// Bundle navigateur : expose le SDK en global `UrbanHttp` pour le site de démo.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "iife",
  globalName: "UrbanHttp",
  outfile: "demo/urban-http.browser.js",
  target: ["es2020"],
  external: ["undici"],
  logLevel: "info",
});
