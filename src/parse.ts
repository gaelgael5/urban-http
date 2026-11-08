/**
 * Parser principal : transforme les tokens d'une commande curl
 * en un ou plusieurs HttpRequestModel.
 */
import { tokenize } from "./tokenize.js";
import {
  AuthSpec,
  DataItem,
  FormField,
  HttpRequestModel,
  ParseResult,
  ParseWarning,
  defaultOptions,
} from "./model.js";

/** État interne accumulé pendant le parsing d'un groupe d'arguments. */
interface ParseState {
  urls: string[];
  explicitMethod?: string;
  headMethod: boolean; // -I
  get: boolean; // -G
  headers: Array<[string, string]>;
  removedHeaders: string[]; // -H "Name:" (suppression)
  dataItems: DataItem[];
  formFields: FormField[];
  formIsMultipart: boolean;
  uploadFile?: string; // -T
  auth?: AuthSpec;
  authKindOverride?: AuthSpec["kind"];
  cookies: string[];
  userAgent?: string;
  referer?: string;
  range?: string;
  jsonMode: boolean;
  options: ReturnType<typeof defaultOptions>;
  warnings: ParseWarning[];
}

function newState(): ParseState {
  return {
    urls: [],
    headMethod: false,
    get: false,
    headers: [],
    removedHeaders: [],
    dataItems: [],
    formFields: [],
    formIsMultipart: false,
    cookies: [],
    jsonMode: false,
    options: defaultOptions(),
    warnings: [],
  };
}

function warn(st: ParseState, code: string, message: string, option?: string, level: ParseWarning["level"] = "warning") {
  st.warnings.push({ code, message, option, level });
}

type Handler = (st: ParseState, value: string) => void;

interface OptDef {
  takesValue: boolean;
  handler: Handler;
}

/* ------------------------------------------------------------------ */
/* Table des options curl                                              */
/* ------------------------------------------------------------------ */

const noop: Handler = () => {};
const noopInfo = (label: string): Handler => (st) =>
  warn(st, "cli-only-option", `${label} : option de ligne de commande sans effet sur la requête HTTP, ignorée.`, label, "info");

/** Options longues. Clé = nom sans les tirets. */
const LONG_OPTIONS: Record<string, OptDef> = {
  // --- URL et méthode -------------------------------------------------
  "url": { takesValue: true, handler: (st, v) => st.urls.push(v) },
  "request": { takesValue: true, handler: (st, v) => (st.explicitMethod = v.toUpperCase()) },
  "head": { takesValue: false, handler: (st) => (st.headMethod = true) },
  "get": { takesValue: false, handler: (st) => (st.get = true) },

  // --- En-têtes ---------------------------------------------------------
  "header": { takesValue: true, handler: handleHeader },
  "user-agent": { takesValue: true, handler: (st, v) => (st.userAgent = v) },
  "referer": {
    takesValue: true,
    handler: (st, v) => {
      if (v === ";auto" || v.endsWith(";auto")) {
        warn(st, "partial-option", "--referer ;auto : le mode automatique n'est pas reproduit, seule la valeur explicite est envoyée.", "--referer", "info");
        v = v.replace(/;auto$/, "");
        if (!v) return;
      }
      st.referer = v;
    },
  },
  "range": { takesValue: true, handler: (st, v) => (st.range = v) },
  "compressed": { takesValue: false, handler: (st) => (st.options.compressed = true) },

  // --- Corps de requête ---------------------------------------------------
  "data": { takesValue: true, handler: (st, v) => pushData(st, "data", v) },
  "data-ascii": { takesValue: true, handler: (st, v) => pushData(st, "data", v) },
  "data-raw": { takesValue: true, handler: (st, v) => st.dataItems.push({ mode: "raw", value: v }) },
  "data-binary": { takesValue: true, handler: (st, v) => pushData(st, "binary", v) },
  "data-urlencode": { takesValue: true, handler: handleDataUrlencode },
  "json": {
    takesValue: true,
    handler: (st, v) => {
      st.jsonMode = true;
      pushData(st, "binary", v);
    },
  },
  "form": { takesValue: true, handler: (st, v) => handleForm(st, v, false) },
  "form-string": { takesValue: true, handler: (st, v) => handleForm(st, v, true) },
  "upload-file": { takesValue: true, handler: (st, v) => (st.uploadFile = v) },

  // --- Authentification ----------------------------------------------------
  "user": { takesValue: true, handler: handleUser },
  "oauth2-bearer": { takesValue: true, handler: (st, v) => (st.auth = { kind: "bearer", token: v }) },
  "basic": { takesValue: false, handler: (st) => (st.authKindOverride = "basic") },
  "digest": {
    takesValue: false,
    handler: (st) => {
      st.authKindOverride = "digest";
      warn(st, "unsupported-auth", "--digest : l'authentification Digest nécessite une négociation challenge/réponse non prise en charge par fetch.", "--digest");
    },
  },
  "ntlm": {
    takesValue: false,
    handler: (st) => {
      st.authKindOverride = "ntlm";
      warn(st, "unsupported-auth", "--ntlm : authentification NTLM non prise en charge.", "--ntlm");
    },
  },
  "negotiate": {
    takesValue: false,
    handler: (st) => {
      st.authKindOverride = "negotiate";
      warn(st, "unsupported-auth", "--negotiate : authentification Negotiate/Kerberos non prise en charge.", "--negotiate");
    },
  },
  "anyauth": { takesValue: false, handler: noop },
  "aws-sigv4": {
    takesValue: true,
    handler: (st, v) => {
      st.auth = { kind: "aws-sigv4", token: v };
      warn(st, "unsupported-auth", "--aws-sigv4 : la signature AWS n'est pas calculée par le SDK.", "--aws-sigv4");
    },
  },

  // --- Cookies -----------------------------------------------------------
  "cookie": { takesValue: true, handler: handleCookie },
  "cookie-jar": {
    takesValue: true,
    handler: (st) =>
      warn(st, "cli-only-option", "--cookie-jar : l'écriture d'un fichier de cookies est propre au CLI, ignorée.", "--cookie-jar", "info"),
  },
  "junk-session-cookies": { takesValue: false, handler: noop },

  // --- Redirections --------------------------------------------------------
  "location": { takesValue: false, handler: (st) => (st.options.followRedirects = true) },
  "location-trusted": {
    takesValue: false,
    handler: (st) => {
      st.options.followRedirects = true;
      warn(st, "partial-option", "--location-trusted : les identifiants ne seront pas renvoyés aux hôtes de redirection (limitation fetch).", "--location-trusted", "info");
    },
  },
  "max-redirs": { takesValue: true, handler: (st, v) => (st.options.maxRedirs = parseInt(v, 10)) },

  // --- TLS / réseau ----------------------------------------------------------
  "insecure": { takesValue: false, handler: (st) => (st.options.insecure = true) },
  "cacert": { takesValue: true, handler: unsupported("--cacert", "certificat CA personnalisé") },
  "cert": { takesValue: true, handler: unsupported("--cert", "certificat client") },
  "key": { takesValue: true, handler: unsupported("--key", "clé privée cliente") },
  "proxy": {
    takesValue: true,
    handler: (st, v) => {
      st.options.proxy = v;
      warn(st, "unsupported-option", "--proxy : fetch ne permet pas de configurer un proxy par requête (possible côté Node via undici.ProxyAgent).", "--proxy");
    },
  },
  "proxy-user": { takesValue: true, handler: unsupported("--proxy-user", "authentification proxy") },
  "noproxy": { takesValue: true, handler: noop },
  "http1.0": { takesValue: false, handler: setHttpVersion("1.0") },
  "http1.1": { takesValue: false, handler: setHttpVersion("1.1") },
  "http2": { takesValue: false, handler: setHttpVersion("2") },
  "http2-prior-knowledge": { takesValue: false, handler: setHttpVersion("2") },
  "http3": { takesValue: false, handler: setHttpVersion("3") },
  "ipv4": { takesValue: false, handler: noop },
  "ipv6": { takesValue: false, handler: noop },
  "tlsv1.2": { takesValue: false, handler: noop },
  "tlsv1.3": { takesValue: false, handler: noop },
  "resolve": { takesValue: true, handler: unsupported("--resolve", "résolution DNS personnalisée") },
  "connect-to": { takesValue: true, handler: unsupported("--connect-to", "redirection de connexion") },
  "interface": { takesValue: true, handler: unsupported("--interface", "interface réseau") },
  "unix-socket": { takesValue: true, handler: unsupported("--unix-socket", "socket Unix") },

  // --- Timeouts / retries -------------------------------------------------------
  "max-time": { takesValue: true, handler: (st, v) => (st.options.timeoutMs = Math.round(parseFloat(v) * 1000)) },
  "connect-timeout": {
    takesValue: true,
    handler: (st, v) => {
      st.options.connectTimeoutMs = Math.round(parseFloat(v) * 1000);
      warn(st, "partial-option", "--connect-timeout : fetch n'a pas de timeout de connexion distinct, approximé par un timeout global.", "--connect-timeout", "info");
    },
  },
  "retry": { takesValue: true, handler: (st, v) => (st.options.retry = parseInt(v, 10)) },
  "retry-delay": { takesValue: true, handler: (st, v) => (st.options.retryDelayMs = Math.round(parseFloat(v) * 1000)) },
  "retry-max-time": { takesValue: true, handler: noop },
  "retry-all-errors": { takesValue: false, handler: noop },
  "limit-rate": { takesValue: true, handler: unsupported("--limit-rate", "limitation de débit") },
  "speed-limit": { takesValue: true, handler: noop },
  "speed-time": { takesValue: true, handler: noop },
  "keepalive-time": { takesValue: true, handler: noop },
  "no-keepalive": { takesValue: false, handler: noop },

  // --- Sortie / affichage (sans effet sur la requête) ----------------------------
  "output": { takesValue: true, handler: noopInfo("--output") },
  "remote-name": { takesValue: false, handler: noopInfo("--remote-name") },
  "remote-header-name": { takesValue: false, handler: noopInfo("--remote-header-name") },
  "dump-header": { takesValue: true, handler: noopInfo("--dump-header") },
  "include": { takesValue: false, handler: noop },
  "silent": { takesValue: false, handler: noop },
  "show-error": { takesValue: false, handler: noop },
  "verbose": { takesValue: false, handler: noop },
  "progress-bar": { takesValue: false, handler: noop },
  "no-progress-meter": { takesValue: false, handler: noop },
  "write-out": { takesValue: true, handler: noopInfo("--write-out") },
  "trace": { takesValue: true, handler: noopInfo("--trace") },
  "trace-ascii": { takesValue: true, handler: noopInfo("--trace-ascii") },
  "fail": { takesValue: false, handler: noop },
  "fail-with-body": { takesValue: false, handler: noop },
  "styled-output": { takesValue: false, handler: noop },

  // --- Divers -------------------------------------------------------------------
  "globoff": { takesValue: false, handler: noop },
  "config": { takesValue: true, handler: unsupported("--config", "fichier de configuration curl") },
  "next": { takesValue: false, handler: noop }, // géré en amont (séparateur de groupes)
  "help": { takesValue: false, handler: noopInfo("--help") },
  "version": { takesValue: false, handler: noopInfo("--version") },
  "raw": { takesValue: false, handler: noop },
  "path-as-is": { takesValue: false, handler: noop },
  "post301": { takesValue: false, handler: partialRedirect("--post301") },
  "post302": { takesValue: false, handler: partialRedirect("--post302") },
  "post303": { takesValue: false, handler: partialRedirect("--post303") },
};

/** Options courtes -> option longue correspondante. */
const SHORT_OPTIONS: Record<string, string> = {
  "X": "request",
  "H": "header",
  "d": "data",
  "F": "form",
  "G": "get",
  "I": "head",
  "u": "user",
  "b": "cookie",
  "c": "cookie-jar",
  "j": "junk-session-cookies",
  "A": "user-agent",
  "e": "referer",
  "r": "range",
  "L": "location",
  "k": "insecure",
  "x": "proxy",
  "m": "max-time",
  "T": "upload-file",
  "o": "output",
  "O": "remote-name",
  "J": "remote-header-name",
  "D": "dump-header",
  "i": "include",
  "s": "silent",
  "S": "show-error",
  "v": "verbose",
  "#": "progress-bar",
  "f": "fail",
  "g": "globoff",
  "K": "config",
  "4": "ipv4",
  "6": "ipv6",
  "w": "write-out",
  "E": "cert",
  "U": "proxy-user",
  "Z": "parallel",
};

function unsupported(option: string, label: string): Handler {
  return (st) =>
    warn(st, "unsupported-option", `${option} (${label}) : non pris en charge par le SDK, option ignorée.`, option);
}

function setHttpVersion(v: string): Handler {
  return (st) => {
    st.options.httpVersion = v;
    warn(st, "cli-only-option", `--http${v} : la version HTTP est négociée par la plateforme, indication conservée à titre informatif.`, `--http${v}`, "info");
  };
}

function partialRedirect(option: string): Handler {
  return (st) =>
    warn(st, "partial-option", `${option} : fetch suit la sémantique standard des redirections, ce réglage fin n'est pas appliqué.`, option, "info");
}

/* ------------------------------------------------------------------ */
/* Handlers spécifiques                                                */
/* ------------------------------------------------------------------ */

function handleHeader(st: ParseState, v: string) {
  // "@file" : en-têtes depuis un fichier -> non supporté
  if (v.startsWith("@")) {
    warn(st, "unsupported-option", `-H ${v} : lecture d'en-têtes depuis un fichier non prise en charge.`, "-H");
    return;
  }
  const colon = v.indexOf(":");
  const semi = v.indexOf(";");
  if (colon === -1 && semi !== -1 && semi === v.length - 1) {
    // "Header;" -> en-tête avec valeur vide
    st.headers.push([v.slice(0, semi).trim(), ""]);
    return;
  }
  if (colon === -1) {
    warn(st, "invalid-header", `-H "${v}" : format d'en-tête invalide (attendu "Nom: valeur"), ignoré.`, "-H");
    return;
  }
  const name = v.slice(0, colon).trim();
  const value = v.slice(colon + 1).trim();
  if (value === "") {
    // "Header:" -> suppression de l'en-tête (généré par défaut)
    st.removedHeaders.push(name.toLowerCase());
    return;
  }
  st.headers.push([name, value]);
}

function pushData(st: ParseState, mode: "data" | "binary", v: string) {
  if (v.startsWith("@")) {
    st.dataItems.push({ mode, filePath: v.slice(1) });
  } else {
    st.dataItems.push({ mode, value: v });
  }
}

function handleDataUrlencode(st: ParseState, v: string) {
  // Formes : "contenu", "=contenu", "nom=contenu", "@fichier", "nom@fichier"
  if (v.startsWith("@")) {
    st.dataItems.push({ mode: "urlencode", filePath: v.slice(1) });
    return;
  }
  const eq = v.indexOf("=");
  const at = v.indexOf("@");
  if (eq === -1 && at > 0) {
    st.dataItems.push({ mode: "urlencode", name: v.slice(0, at), filePath: v.slice(at + 1) });
    return;
  }
  if (eq === 0) {
    st.dataItems.push({ mode: "urlencode", value: v.slice(1) });
    return;
  }
  if (eq > 0) {
    st.dataItems.push({ mode: "urlencode", name: v.slice(0, eq), value: v.slice(eq + 1) });
    return;
  }
  st.dataItems.push({ mode: "urlencode", value: v });
}

/** Parse "name=value;type=...;filename=..." d'un -F. */
function handleForm(st: ParseState, v: string, literal: boolean) {
  st.formIsMultipart = true;
  const eq = v.indexOf("=");
  if (eq === -1) {
    warn(st, "invalid-form", `-F "${v}" : format invalide (attendu nom=valeur), ignoré.`, "-F");
    return;
  }
  const name = v.slice(0, eq);
  let rest = v.slice(eq + 1);

  const field: FormField = { name };

  if (!literal) {
    // Découpe des attributs ;type= ;filename= (en respectant les valeurs entre quotes)
    const segments = splitFormSegments(rest);
    rest = segments.shift() ?? "";
    for (const seg of segments) {
      const [attr, ...valParts] = seg.split("=");
      const val = unquote(valParts.join("="));
      const attrName = (attr ?? "").trim().toLowerCase();
      if (attrName === "type") field.contentType = val;
      else if (attrName === "filename") field.fileName = val;
      else if (attrName === "headers") {
        warn(st, "partial-option", `-F ;headers= : en-têtes de partie multipart non pris en charge, ignorés.`, "-F", "info");
      }
    }
    rest = unquote(rest);
    if (rest.startsWith("@")) {
      field.filePath = rest.slice(1);
    } else if (rest.startsWith("<")) {
      field.contentFromFile = rest.slice(1);
    } else {
      field.value = rest;
    }
  } else {
    field.value = rest;
  }
  st.formFields.push(field);
}

function splitFormSegments(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"') inQuotes = !inQuotes;
    if (c === ";" && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function unquote(s: string): string {
  s = s.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"');
  }
  return s;
}

function handleUser(st: ParseState, v: string) {
  const colon = v.indexOf(":");
  if (colon === -1) {
    st.auth = { kind: "basic", username: v, password: "" };
  } else {
    st.auth = { kind: "basic", username: v.slice(0, colon), password: v.slice(colon + 1) };
  }
}

function handleCookie(st: ParseState, v: string) {
  if (v.includes("=")) {
    st.cookies.push(v);
  } else {
    warn(st, "unsupported-option", `-b ${v} : lecture d'un fichier de cookies non prise en charge (passez les cookies sous forme "nom=valeur").`, "-b");
  }
}

/* ------------------------------------------------------------------ */
/* Boucle principale                                                   */
/* ------------------------------------------------------------------ */

/**
 * Parse une commande curl complète.
 *
 * @param command La commande telle que copiée depuis un terminal ou Postman
 *                (le mot "curl" initial est optionnel).
 */
export function parseCurl(command: string): ParseResult {
  const tokens = tokenize(command);

  // --next sépare des requêtes indépendantes
  const groups: string[][] = [[]];
  for (const t of tokens) {
    if (t === "--next" || t === "-:") {
      groups.push([]);
    } else {
      groups[groups.length - 1]!.push(t);
    }
  }

  const requests: HttpRequestModel[] = [];
  const globalWarnings: ParseWarning[] = [];

  for (const group of groups) {
    if (group.length === 0) continue;
    const st = parseGroup(group);
    if (st.urls.length === 0) {
      // Pas d'URL dans ce groupe : les warnings remontent au niveau global
      globalWarnings.push(...st.warnings);
      continue;
    }
    requests.push(...buildRequests(st));
  }

  if (requests.length === 0) {
    globalWarnings.push({
      code: "no-url",
      message: "Aucune URL trouvée dans la commande.",
      level: "error",
    });
  }

  return { requests, warnings: globalWarnings };
}

function parseGroup(tokens: string[]): ParseState {
  const st = newState();
  let i = 0;

  const nextValue = (option: string): string | undefined => {
    const v = tokens[i + 1];
    if (v === undefined) {
      warn(st, "missing-value", `${option} attend une valeur mais la commande se termine.`, option, "error");
      return undefined;
    }
    i++;
    return v;
  };

  while (i < tokens.length) {
    const tok = tokens[i]!;

    if (tok === "-") {
      // "-" seul = stdin, pas une option
      warn(st, "unsupported-option", `"-" (lecture depuis stdin) non pris en charge.`, "-");
      i++;
      continue;
    }

    if (tok.startsWith("--")) {
      let name = tok.slice(2);
      let inlineValue: string | undefined;

      // Forme --option=valeur (tolérée même si curl ne l'accepte pas)
      const eq = name.indexOf("=");
      if (eq !== -1 && !LONG_OPTIONS[name]) {
        inlineValue = name.slice(eq + 1);
        name = name.slice(0, eq);
      }

      // Préfixe --no-xxx (négation des booléens)
      let negated = false;
      if (!LONG_OPTIONS[name] && name.startsWith("no-") && LONG_OPTIONS[name.slice(3)]) {
        negated = true;
        name = name.slice(3);
      }

      const def = LONG_OPTIONS[name];
      if (!def) {
        warn(st, "unknown-option", `--${name} : option inconnue, ignorée.`, `--${name}`);
        i++;
        continue;
      }
      if (negated) {
        applyNegation(st, name);
        i++;
        continue;
      }
      if (def.takesValue) {
        const v = inlineValue !== undefined ? inlineValue : nextValue(`--${name}`);
        if (v !== undefined) def.handler(st, v);
      } else {
        def.handler(st, "");
      }
      i++;
      continue;
    }

    if (tok.startsWith("-") && tok.length > 1) {
      // Options courtes, éventuellement groupées (-sSL) ou collées (-XPOST)
      let j = 1;
      while (j < tok.length) {
        const ch = tok[j]!;
        const longName = SHORT_OPTIONS[ch];
        const def = longName ? LONG_OPTIONS[longName] : undefined;
        if (!def) {
          warn(st, "unknown-option", `-${ch} : option inconnue, ignorée.`, `-${ch}`);
          j++;
          continue;
        }
        if (def.takesValue) {
          const glued = tok.slice(j + 1);
          const v = glued !== "" ? glued : nextValue(`-${ch}`);
          if (v !== undefined) def.handler(st, v);
          j = tok.length;
        } else {
          def.handler(st, "");
          j++;
        }
      }
      i++;
      continue;
    }

    // Argument positionnel = URL
    st.urls.push(tok);
    i++;
  }

  return st;
}

function applyNegation(st: ParseState, name: string) {
  switch (name) {
    case "location":
      st.options.followRedirects = false;
      break;
    case "insecure":
      st.options.insecure = false;
      break;
    case "compressed":
      st.options.compressed = false;
      break;
    default:
      // Les autres négations n'ont pas d'effet sur le modèle
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Construction du modèle final                                        */
/* ------------------------------------------------------------------ */

function buildRequests(st: ParseState): HttpRequestModel[] {
  return st.urls.map((rawUrl) => buildOne(st, rawUrl, [...st.warnings]));
}

function buildOne(st: ParseState, rawUrl: string, warnings: ParseWarning[]): HttpRequestModel {
  const options = { ...st.options };
  const headers: Array<[string, string]> = [];
  const query: Array<[string, string]> = [];

  // URL : schéma par défaut + détection de globbing
  let url = rawUrl;
  if (url && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
    url = "http://" + url;
    pushWarn(warnings, "default-scheme", `Pas de schéma dans l'URL : "http://" ajouté (comme curl).`, undefined, "info");
  }
  if (/[{}[\]]/.test(rawUrl)) {
    pushWarn(warnings, "url-globbing", "L'URL contient des caractères de globbing curl ({...} ou [...]) : le globbing n'est pas développé.", undefined, "warning");
  }

  // Corps
  let body: HttpRequestModel["body"];
  let bodyContentType: string | undefined;

  if (st.formFields.length > 0) {
    body = { kind: "multipart", parts: st.formFields };
    // Pas de Content-Type explicite : fetch génère le boundary
  } else if (st.uploadFile) {
    body = { kind: "file", filePath: st.uploadFile };
  } else if (st.dataItems.length > 0 && !st.get) {
    const resolved = resolveDataItems(st.dataItems, warnings);
    body = resolved.hasFiles
      ? { kind: st.jsonMode ? "raw" : "urlencoded", items: st.dataItems, text: resolved.text }
      : { kind: st.jsonMode ? "raw" : "urlencoded", text: resolved.text };
    bodyContentType = st.jsonMode ? "application/json" : "application/x-www-form-urlencoded";
  }

  // -G : les données passent en query string
  if (st.get && st.dataItems.length > 0) {
    const resolved = resolveDataItems(st.dataItems, warnings);
    if (resolved.text) {
      for (const pair of resolved.text.split("&")) {
        const eq = pair.indexOf("=");
        if (eq === -1) query.push([pair, ""]);
        else query.push([pair.slice(0, eq), pair.slice(eq + 1)]);
      }
      url = appendQuery(url, resolved.text);
    }
  }

  // Méthode
  let method: string;
  if (st.explicitMethod) {
    method = st.explicitMethod;
    if (st.headMethod) {
      pushWarn(warnings, "method-conflict", `-I et -X ${st.explicitMethod} utilisés ensemble : -X l'emporte (comme curl).`, undefined, "info");
    }
  } else if (st.headMethod) {
    method = "HEAD";
  } else if (st.uploadFile) {
    method = "PUT";
  } else if (body && !st.get) {
    method = "POST";
  } else {
    method = "GET";
  }

  // En-têtes générés
  const userHeaderNames = new Set(st.headers.map(([n]) => n.toLowerCase()));
  const removed = new Set(st.removedHeaders);

  const addGenerated = (name: string, value: string) => {
    const lower = name.toLowerCase();
    if (userHeaderNames.has(lower) || removed.has(lower)) return;
    headers.push([name, value]);
  };

  if (bodyContentType) addGenerated("Content-Type", bodyContentType);
  if (st.jsonMode) addGenerated("Accept", "application/json");
  if (st.userAgent !== undefined) addGenerated("User-Agent", st.userAgent);
  if (st.referer) addGenerated("Referer", st.referer);
  if (st.range) addGenerated("Range", st.range.includes("-") ? `bytes=${st.range}` : `bytes=${st.range}-`);
  if (st.cookies.length > 0) addGenerated("Cookie", st.cookies.join("; "));
  if (st.options.compressed) addGenerated("Accept-Encoding", "gzip, deflate, br");

  // En-têtes utilisateur (après les générés, dans l'ordre de la ligne de commande)
  for (const [n, v] of st.headers) {
    if (removed.has(n.toLowerCase())) continue;
    headers.push([n, v]);
  }

  // Auth
  let auth = st.auth ? { ...st.auth } : undefined;
  if (auth && st.authKindOverride && auth.kind === "basic") {
    auth.kind = st.authKindOverride;
  }

  return {
    method,
    url,
    query,
    headers,
    body,
    auth,
    options,
    warnings,
  };
}

function pushWarn(warnings: ParseWarning[], code: string, message: string, option?: string, level: ParseWarning["level"] = "warning") {
  warnings.push({ code, message, option, level });
}

/**
 * Concatène les fragments -d en un corps (ou une query string pour -G),
 * en appliquant l'encodage de --data-urlencode.
 * Les références de fichiers ne sont pas lues ici (résolution à l'exécution).
 */
function resolveDataItems(items: DataItem[], warnings: ParseWarning[]): { text: string; hasFiles: boolean } {
  const parts: string[] = [];
  let hasFiles = false;
  for (const item of items) {
    if (item.filePath !== undefined) {
      hasFiles = true;
      const placeholder = item.name !== undefined ? `${item.name}=@${item.filePath}` : `@${item.filePath}`;
      parts.push(placeholder);
      pushWarn(
        warnings,
        "file-reference",
        `Le corps référence le fichier "${item.filePath}" : il sera lu au moment de l'exécution (Node) ou doit être fourni via l'option readFile.`,
        undefined,
        "info"
      );
      continue;
    }
    const value = item.value ?? "";
    if (item.mode === "urlencode") {
      const encoded = encodeURIComponent(value).replace(/%20/g, "+");
      parts.push(item.name !== undefined ? `${item.name}=${encoded}` : encoded);
    } else {
      parts.push(value);
    }
  }
  return { text: parts.join("&"), hasFiles };
}

function appendQuery(url: string, qs: string): string {
  if (!qs) return url;
  if (!url) return url;
  return url + (url.includes("?") ? "&" : "?") + qs;
}
