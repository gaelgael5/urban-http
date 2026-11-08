/**
 * Transformation d'un HttpRequestModel en paramètres fetch(),
 * et génération d'un extrait de code JavaScript équivalent.
 */
import { FileReader, HttpRequestModel } from "./model.js";

export interface ToFetchOptions {
  /** Lecteur de fichiers pour résoudre les références "@fichier". */
  readFile?: FileReader;
}

export interface FetchPlan {
  url: string;
  init: RequestInit;
  /** Problèmes rencontrés pendant la construction (fichiers non résolus, etc.). */
  issues: string[];
}

function toBase64(s: string): string {
  // btoa ne gère que latin1 : on encode d'abord en UTF-8.
  // btoa existe dans les navigateurs et dans Node >= 16.
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Construit l'en-tête Authorization si le modèle contient une authentification. */
export function authHeader(req: HttpRequestModel): [string, string] | undefined {
  if (!req.auth) return undefined;
  if (req.auth.kind === "basic") {
    const cred = `${req.auth.username ?? ""}:${req.auth.password ?? ""}`;
    return ["Authorization", `Basic ${toBase64(cred)}`];
  }
  if (req.auth.kind === "bearer") {
    return ["Authorization", `Bearer ${req.auth.token ?? ""}`];
  }
  return undefined; // digest / ntlm / negotiate : non applicables en un seul aller
}

/**
 * Prépare l'appel fetch : URL + RequestInit.
 * Ne déclenche aucune E/S réseau ; lit les fichiers référencés si readFile est fourni.
 */
export function toFetch(req: HttpRequestModel, opts: ToFetchOptions = {}): FetchPlan {
  const issues: string[] = [];
  const headers = new Headers();
  for (const [n, v] of req.headers) headers.append(n, v);

  const auth = authHeader(req);
  if (auth && !headers.has("authorization")) headers.set(auth[0], auth[1]);

  const read = (path: string): Uint8Array | string | undefined => {
    if (!opts.readFile) {
      issues.push(`Fichier "${path}" non résolu : fournissez options.readFile pour le lire.`);
      return undefined;
    }
    try {
      return opts.readFile(path);
    } catch (e) {
      issues.push(`Lecture du fichier "${path}" impossible : ${(e as Error).message}`);
      return undefined;
    }
  };

  let body: BodyInit | undefined;
  const b = req.body;

  if (b) {
    if (b.kind === "multipart") {
      const fd = new FormData();
      for (const part of b.parts ?? []) {
        if (part.filePath) {
          const content = read(part.filePath);
          const fileName = part.fileName ?? part.filePath.split(/[\\/]/).pop() ?? "file";
          if (content !== undefined) {
            const blob = new Blob([typeof content === "string" ? content : (content as unknown as BlobPart)], {
              type: part.contentType ?? "application/octet-stream",
            });
            fd.append(part.name, blob, fileName);
          } else {
            fd.append(part.name, new Blob([], { type: part.contentType ?? "application/octet-stream" }), fileName);
          }
        } else if (part.contentFromFile) {
          const content = read(part.contentFromFile);
          fd.append(part.name, content === undefined ? "" : typeof content === "string" ? content : new TextDecoder().decode(content));
        } else {
          fd.append(part.name, part.value ?? "");
        }
      }
      body = fd;
    } else if (b.kind === "file") {
      const content = b.filePath ? read(b.filePath) : undefined;
      if (content !== undefined) {
        body = typeof content === "string" ? content : (content as unknown as BodyInit);
      }
    } else if (b.items && b.items.some((it) => it.filePath)) {
      // Fragments -d avec fichiers : résolution maintenant
      const parts: string[] = [];
      for (const item of b.items) {
        if (item.filePath) {
          const content = read(item.filePath);
          let text = content === undefined ? "" : typeof content === "string" ? content : new TextDecoder().decode(content);
          if (item.mode === "data") {
            // curl --data supprime CR/LF des fichiers lus
            text = text.replace(/[\r\n]/g, "");
          }
          if (item.mode === "urlencode") {
            text = encodeURIComponent(text).replace(/%20/g, "+");
            parts.push(item.name !== undefined ? `${item.name}=${text}` : text);
          } else {
            parts.push(text);
          }
        } else if (item.mode === "urlencode") {
          const enc = encodeURIComponent(item.value ?? "").replace(/%20/g, "+");
          parts.push(item.name !== undefined ? `${item.name}=${enc}` : enc);
        } else {
          parts.push(item.value ?? "");
        }
      }
      body = parts.join("&");
    } else {
      body = b.text ?? "";
    }
  }

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: req.options.followRedirects ? "follow" : "manual",
  };
  if (body !== undefined) init.body = body;
  if (req.options.timeoutMs) init.signal = AbortSignal.timeout(req.options.timeoutMs);

  return { url: req.url, init, issues };
}

/* ------------------------------------------------------------------ */
/* Génération de code                                                  */
/* ------------------------------------------------------------------ */

const js = (s: string) => JSON.stringify(s);

/** Génère un extrait de code fetch() lisible, équivalent à la requête. */
export function toFetchCode(req: HttpRequestModel): string {
  const lines: string[] = [];
  const headers: Array<[string, string]> = [...req.headers];
  const auth = authHeader(req);
  if (auth && !headers.some(([n]) => n.toLowerCase() === "authorization")) headers.push(auth);

  lines.push(`const response = await fetch(${js(req.url)}, {`);
  lines.push(`  method: ${js(req.method)},`);

  if (headers.length > 0) {
    lines.push(`  headers: {`);
    for (const [n, v] of headers) lines.push(`    ${js(n)}: ${js(v)},`);
    lines.push(`  },`);
  }

  const b = req.body;
  if (b) {
    if (b.kind === "multipart") {
      const pre: string[] = [`const form = new FormData();`];
      for (const part of b.parts ?? []) {
        if (part.filePath) {
          pre.push(`form.append(${js(part.name)}, fileInput.files[0]); // fichier : ${part.filePath}`);
        } else if (part.contentFromFile) {
          pre.push(`form.append(${js(part.name)}, contenuDe(${js(part.contentFromFile)}));`);
        } else {
          pre.push(`form.append(${js(part.name)}, ${js(part.value ?? "")});`);
        }
      }
      lines.unshift(...pre, "");
      lines.push(`  body: form,`);
    } else if (b.kind === "file") {
      lines.push(`  body: contenuDe(${js(b.filePath ?? "")}), // -T / --upload-file`);
    } else if (b.text !== undefined) {
      lines.push(`  body: ${js(b.text)},`);
    }
  }

  lines.push(`  redirect: ${js(req.options.followRedirects ? "follow" : "manual")},`);
  if (req.options.timeoutMs) {
    lines.push(`  signal: AbortSignal.timeout(${req.options.timeoutMs}),`);
  }
  lines.push(`});`);
  return lines.join("\n");
}
