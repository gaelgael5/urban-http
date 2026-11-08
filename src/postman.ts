/**
 * Import du format Postman Collection v2.0 / v2.1 (JSON) :
 * transforme chaque requête de la collection en HttpRequestModel,
 * le même modèle que celui produit par parseCurl.
 */
import {
  AuthSpec,
  FormField,
  HttpRequestModel,
  ParseResult,
  ParseWarning,
  defaultOptions,
} from "./model.js";

export interface PostmanParseOptions {
  /**
   * Valeurs des variables {{...}} (en plus de celles définies dans la collection).
   * Prioritaires sur les variables de la collection — typiquement l'export
   * d'un environnement Postman aplati en { clé: valeur }.
   */
  variables?: Record<string, string>;
}

/* Types minimaux du format Postman (champs réellement utilisés). */
interface PmKeyValue {
  key?: string;
  value?: string;
  disabled?: boolean;
  type?: string;
  src?: string | string[];
  contentType?: string;
}
interface PmUrl {
  raw?: string;
  protocol?: string;
  host?: string | string[];
  port?: string;
  path?: string | string[];
  query?: PmKeyValue[];
}
interface PmAuth {
  type?: string;
  [kind: string]: unknown;
}
interface PmBody {
  mode?: string;
  raw?: string;
  options?: { raw?: { language?: string } };
  urlencoded?: PmKeyValue[];
  formdata?: PmKeyValue[];
  file?: { src?: string };
  graphql?: { query?: string; variables?: string };
  disabled?: boolean;
}
interface PmRequest {
  method?: string;
  url?: string | PmUrl;
  header?: PmKeyValue[] | string;
  body?: PmBody;
  auth?: PmAuth;
}
interface PmItem {
  name?: string;
  item?: PmItem[];
  request?: PmRequest | string;
  auth?: PmAuth;
  event?: Array<{ listen?: string; script?: { exec?: string[] | string } }>;
  protocolProfileBehavior?: { followRedirects?: boolean };
}
interface PmCollection {
  info?: { name?: string; schema?: string };
  item?: PmItem[];
  variable?: PmKeyValue[];
  auth?: PmAuth;
  event?: PmItem["event"];
}

/** Vérifie qu'un JSON (ou objet) ressemble à une collection Postman. */
export function isPostmanCollection(input: string | unknown): boolean {
  try {
    const obj = (typeof input === "string" ? JSON.parse(input) : input) as PmCollection;
    return !!obj && typeof obj === "object" && !!obj.info && Array.isArray(obj.item);
  } catch {
    return false;
  }
}

/**
 * Parse une collection Postman v2.0 / v2.1.
 * Accepte le JSON sous forme de chaîne ou l'objet déjà parsé.
 */
export function parsePostman(input: string | unknown, opts: PostmanParseOptions = {}): ParseResult {
  const globalWarnings: ParseWarning[] = [];
  let collection: PmCollection;

  try {
    collection = (typeof input === "string" ? JSON.parse(input) : input) as PmCollection;
  } catch (e) {
    return {
      requests: [],
      warnings: [{ code: "invalid-json", message: `JSON invalide : ${(e as Error).message}`, level: "error" }],
    };
  }

  if (!collection || typeof collection !== "object" || !Array.isArray(collection.item)) {
    return {
      requests: [],
      warnings: [{ code: "not-a-collection", message: "Ce JSON n'est pas une collection Postman (champs info/item absents).", level: "error" }],
    };
  }

  if (collection.info?.schema && !/collection\/v2\./.test(collection.info.schema)) {
    globalWarnings.push({
      code: "unknown-schema",
      message: `Schéma "${collection.info.schema}" inattendu : seul le format Collection v2.x est pris en charge, l'import continue au mieux.`,
      level: "warning",
    });
  }

  // Variables : collection d'abord, puis celles passées en option (prioritaires)
  const vars = new Map<string, string>();
  for (const v of collection.variable ?? []) {
    if (v.key !== undefined && !v.disabled) vars.set(v.key, v.value ?? "");
  }
  for (const [k, v] of Object.entries(opts.variables ?? {})) vars.set(k, v);

  const unresolved = new Set<string>();
  const substitute = (s: string): string =>
    s.replace(/\{\{([^{}]+)\}\}/g, (whole, name: string) => {
      if (vars.has(name)) return vars.get(name)!;
      unresolved.add(name);
      return whole;
    });

  const requests: HttpRequestModel[] = [];
  walkItems(collection.item, collection.auth, collection, substitute, requests);

  for (const name of unresolved) {
    globalWarnings.push({
      code: "unresolved-variable",
      message: `Variable {{${name}}} non résolue : passez sa valeur via options.variables.`,
      level: "warning",
    });
  }

  if (requests.length === 0) {
    globalWarnings.push({ code: "no-request", message: "La collection ne contient aucune requête.", level: "error" });
  }

  return { requests, warnings: globalWarnings };
}

function walkItems(
  items: PmItem[],
  inheritedAuth: PmAuth | undefined,
  collection: PmCollection,
  substitute: (s: string) => string,
  out: HttpRequestModel[]
): void {
  for (const item of items) {
    const auth = item.auth ?? (typeof item.request === "object" ? item.request?.auth : undefined) ?? inheritedAuth;
    if (Array.isArray(item.item)) {
      walkItems(item.item, auth, collection, substitute, out);
    }
    if (item.request !== undefined) {
      out.push(buildRequest(item, auth, substitute));
    }
  }
}

function buildRequest(item: PmItem, auth: PmAuth | undefined, substitute: (s: string) => string): HttpRequestModel {
  const warnings: ParseWarning[] = [];
  const options = defaultOptions();
  // Postman suit les redirections par défaut (contrairement à curl)
  options.followRedirects = item.protocolProfileBehavior?.followRedirects !== false;

  // Forme courte : "request" est directement l'URL
  const req: PmRequest = typeof item.request === "string" ? { method: "GET", url: item.request } : (item.request ?? {});

  const method = (req.method ?? "GET").toUpperCase();
  const headers: Array<[string, string]> = [];
  const query: Array<[string, string]> = [];

  // --- URL -----------------------------------------------------------
  let url = "";
  if (typeof req.url === "string") {
    url = substitute(req.url);
  } else if (req.url) {
    const u = req.url;
    if (u.raw) {
      url = substitute(u.raw);
    } else {
      const host = Array.isArray(u.host) ? u.host.join(".") : (u.host ?? "");
      const path = Array.isArray(u.path) ? u.path.join("/") : (u.path ?? "");
      url = substitute(`${u.protocol ?? "http"}://${host}${u.port ? ":" + u.port : ""}${path ? "/" + path : ""}`);
    }
    // Les paramètres désactivés dans Postman ne partent pas sur le réseau :
    // on reconstruit la query string depuis la liste plutôt que depuis raw.
    if (Array.isArray(u.query) && u.query.length > 0) {
      const active = u.query.filter((q) => !q.disabled && q.key !== undefined);
      const base = url.split("?")[0] ?? url;
      const qs = active
        .map((q) => `${substitute(q.key!)}${q.value !== undefined ? "=" + substitute(q.value) : ""}`)
        .join("&");
      for (const q of active) query.push([substitute(q.key!), substitute(q.value ?? "")]);
      url = qs ? `${base}?${qs}` : base;
    }
  }

  // --- En-têtes --------------------------------------------------------
  if (typeof req.header === "string") {
    // Forme texte brut "Nom: valeur\n..."
    for (const line of req.header.split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon > 0) headers.push([substitute(line.slice(0, colon).trim()), substitute(line.slice(colon + 1).trim())]);
    }
  } else {
    for (const h of req.header ?? []) {
      if (h.disabled || h.key === undefined) continue;
      headers.push([substitute(h.key), substitute(h.value ?? "")]);
    }
  }
  const hasHeader = (name: string) => headers.some(([n]) => n.toLowerCase() === name.toLowerCase());

  // --- Corps ------------------------------------------------------------
  let body: HttpRequestModel["body"];
  const b = req.body;
  if (b && !b.disabled && b.mode) {
    switch (b.mode) {
      case "raw": {
        const text = substitute(b.raw ?? "");
        body = { kind: "raw", text };
        const lang = b.options?.raw?.language;
        const ct =
          lang === "json" ? "application/json"
          : lang === "xml" ? "application/xml"
          : lang === "html" ? "text/html"
          : lang === "javascript" ? "application/javascript"
          : lang === "text" ? "text/plain"
          : undefined;
        if (ct && !hasHeader("content-type")) headers.push(["Content-Type", ct]);
        break;
      }
      case "urlencoded": {
        const pairs = (b.urlencoded ?? [])
          .filter((p) => !p.disabled && p.key !== undefined)
          .map((p) => `${encodeForm(substitute(p.key!))}=${encodeForm(substitute(p.value ?? ""))}`);
        body = { kind: "urlencoded", text: pairs.join("&") };
        if (!hasHeader("content-type")) headers.push(["Content-Type", "application/x-www-form-urlencoded"]);
        break;
      }
      case "formdata": {
        const parts: FormField[] = [];
        for (const p of b.formdata ?? []) {
          if (p.disabled || p.key === undefined) continue;
          if (p.type === "file") {
            const srcs = Array.isArray(p.src) ? p.src : p.src ? [p.src] : [];
            if (srcs.length === 0) parts.push({ name: substitute(p.key), filePath: "" });
            for (const src of srcs) parts.push({ name: substitute(p.key), filePath: src, contentType: p.contentType });
          } else {
            parts.push({ name: substitute(p.key), value: substitute(p.value ?? ""), contentType: p.contentType });
          }
        }
        body = { kind: "multipart", parts };
        break;
      }
      case "file": {
        body = { kind: "file", filePath: b.file?.src ?? "" };
        break;
      }
      case "graphql": {
        let variables: unknown = undefined;
        const rawVars = b.graphql?.variables;
        if (rawVars) {
          try { variables = JSON.parse(substitute(rawVars)); }
          catch { variables = substitute(rawVars); }
        }
        body = {
          kind: "raw",
          text: JSON.stringify({ query: substitute(b.graphql?.query ?? ""), ...(variables !== undefined ? { variables } : {}) }),
        };
        if (!hasHeader("content-type")) headers.push(["Content-Type", "application/json"]);
        break;
      }
      default:
        warnings.push({
          code: "unsupported-body-mode",
          message: `Mode de corps Postman "${b.mode}" non pris en charge.`,
          level: "warning",
        });
    }
  }

  // --- Authentification ---------------------------------------------------
  const authSpec = convertAuth(auth, substitute, headers, query, warnings);

  // --- Scripts --------------------------------------------------------------
  const hasScript = (item.event ?? []).some((e) => {
    const exec = e.script?.exec;
    const text = Array.isArray(exec) ? exec.join("") : (exec ?? "");
    return text.trim().length > 0;
  });
  if (hasScript) {
    warnings.push({
      code: "scripts-not-executed",
      message: "Cette requête a des scripts Postman (pre-request/tests) : ils ne sont pas exécutés par le SDK.",
      level: "info",
    });
  }

  return {
    name: item.name,
    method,
    url,
    query,
    headers,
    body,
    auth: authSpec,
    options,
    warnings,
  };
}

/** Lit un paramètre d'auth Postman : forme tableau [{key, value}] ou objet direct. */
function authParam(section: unknown, key: string): string | undefined {
  if (Array.isArray(section)) {
    const entry = (section as PmKeyValue[]).find((p) => p.key === key);
    return entry?.value !== undefined ? String(entry.value) : undefined;
  }
  if (section && typeof section === "object") {
    const v = (section as Record<string, unknown>)[key];
    return v !== undefined ? String(v) : undefined;
  }
  return undefined;
}

function convertAuth(
  auth: PmAuth | undefined,
  substitute: (s: string) => string,
  headers: Array<[string, string]>,
  query: Array<[string, string]>,
  warnings: ParseWarning[]
): AuthSpec | undefined {
  if (!auth?.type || auth.type === "noauth") return undefined;
  const section = auth[auth.type];
  const get = (key: string) => {
    const v = authParam(section, key);
    return v !== undefined ? substitute(v) : undefined;
  };

  switch (auth.type) {
    case "basic":
      return { kind: "basic", username: get("username") ?? "", password: get("password") ?? "" };
    case "bearer":
      return { kind: "bearer", token: get("token") ?? "" };
    case "apikey": {
      const key = get("key") ?? "";
      const value = get("value") ?? "";
      if ((get("in") ?? "header") === "query") {
        query.push([key, value]);
        warnings.push({
          code: "apikey-query",
          message: `Auth "apikey" en query string : pensez à vérifier que l'URL finale contient bien ${key}=...`,
          level: "info",
        });
      } else if (key) {
        headers.push([key, value]);
      }
      return undefined; // déjà matérialisée en en-tête/query
    }
    case "digest":
      warnings.push({
        code: "digest-handshake",
        message: "Auth Digest : la négociation challenge/réponse (MD5/SHA-256, qop=auth) est gérée par execute() en deux requêtes.",
        level: "info",
      });
      return { kind: "digest", username: get("username"), password: get("password") };
    case "ntlm":
      warnings.push({ code: "unsupported-auth", message: "Auth NTLM : non prise en charge.", level: "warning" });
      return { kind: "ntlm", username: get("username"), password: get("password") };
    default:
      warnings.push({
        code: "unsupported-auth",
        message: `Type d'auth Postman "${auth.type}" non pris en charge : ajoutez l'en-tête correspondant manuellement.`,
        level: "warning",
      });
      return undefined;
  }
}

function encodeForm(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, "+");
}
