/**
 * Parsing d'une commande curl vers une ProtocolRequest, pour les schémas
 * non-HTTP. Réutilise le tokenizer et la substitution de variables du cœur,
 * mais possède sa propre lecture d'options (compartimenté : ne touche pas la
 * table d'options HTTP de parse.ts).
 */
import { tokenizeFull } from "../tokenize.js";
import { createVariableContext, substitutePlaceholders, variableWarnings } from "../variables.js";
import { ParseWarning } from "../model.js";
import { DEFAULT_PORTS, Payload, ProtocolRequest, ProtocolScheme, TransferDirection, isSecureScheme } from "./types.js";

export interface ProtocolParseOptions {
  variables?: Record<string, string>;
}

export interface ProtocolParseResult {
  /** Schéma détecté, en minuscules. */
  scheme: string;
  /** true si c'est http/https (à router vers parseCurl). */
  isHttp: boolean;
  /** La requête structurée, pour un schéma non-HTTP pris en charge. */
  request?: ProtocolRequest;
  warnings: ParseWarning[];
}

/** Options non-HTTP qui attendent une valeur (pour avancer de 2 tokens). */
const VALUE_OPTIONS = new Set([
  "-T", "--upload-file",
  "-o", "--output",
  "-u", "--user",
  "-d", "--data", "--data-raw", "--data-binary", "--data-ascii",
  "-H", "--header",
  "-Q", "--quote",
  "-r", "--range",
  "-m", "--max-time",
  "--connect-timeout",
  "--mail-from", "--mail-rcpt", "--mail-auth",
  "--ftp-method", "-P", "--ftp-port",
  "--url",
]);

const KNOWN_SCHEMES = new Set<ProtocolScheme>([
  "smtp", "smtps", "ftp", "ftps", "sftp", "pop3", "pop3s", "mqtt", "mqtts", "tftp", "file", "smb", "smbs", "ws", "wss",
]);

/**
 * Parse une commande curl non-HTTP.
 * Pour http/https, renvoie { isHttp: true } sans requête (utilisez parseCurl).
 */
export function parseProtocolCommand(command: string, options: ProtocolParseOptions = {}): ProtocolParseResult {
  const { tokens: rawTokens } = tokenizeFull(command, { shellVariables: options.variables });
  const varCtx = createVariableContext(options.variables);
  const tokens = rawTokens.map((t) => substitutePlaceholders(t, varCtx));
  const warnings: ParseWarning[] = [];

  // 1. Trouver l'URL (--url, ou premier argument positionnel non-option)
  let rawUrl: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok === "--url") {
      rawUrl = tokens[i + 1];
      break;
    }
    if (!tok.startsWith("-")) {
      rawUrl = tok;
      break;
    }
    if (VALUE_OPTIONS.has(tok)) i++; // sauter la valeur de l'option
  }

  if (!rawUrl) {
    return { scheme: "", isHttp: false, warnings: [{ code: "no-url", message: "Aucune URL dans la commande.", level: "error" }] };
  }

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(rawUrl);
  const scheme = (schemeMatch?.[1] ?? "http").toLowerCase();

  if (scheme === "http" || scheme === "https") {
    return { scheme, isHttp: true, warnings };
  }

  if (!KNOWN_SCHEMES.has(scheme as ProtocolScheme)) {
    return {
      scheme,
      isHttp: false,
      warnings: [
        {
          code: "unsupported-protocol",
          message: `Protocole "${scheme}://" sans adaptateur dans le SDK.`,
          level: "error",
        },
      ],
    };
  }

  const request = buildProtocolRequest(scheme as ProtocolScheme, rawUrl, tokens, varCtx, warnings);
  return { scheme, isHttp: false, request, warnings };
}

interface ScannedOptions {
  user?: string;
  upload?: string;
  output?: string;
  data: string[];
  headers: Array<[string, string]>;
  quote: string[];
  range?: string;
  maxTimeMs?: number;
  connectTimeoutMs?: number;
  insecure: boolean;
  ssl: boolean;
  sslReqd: boolean;
  listOnly: boolean;
  ftpCreateDirs: boolean;
  mailFrom?: string;
  mailRcpt: string[];
  mailRcptAllowFails: boolean;
  mqttQos?: number;
  mqttRetain: boolean;
}

function buildProtocolRequest(
  scheme: ProtocolScheme,
  rawUrl: string,
  tokens: string[],
  varCtx: ReturnType<typeof createVariableContext>,
  warnings: ParseWarning[]
): ProtocolRequest {
  const opts = scanOptions(tokens, warnings);

  // Décomposition de l'URL (hôte, port, chemin, userinfo)
  const { host, port, path, userFromUrl, passFromUrl } = dissectUrl(scheme, rawUrl);

  let username = opts.user ? opts.user.split(":")[0] : userFromUrl;
  let password = opts.user ? opts.user.slice((opts.user.indexOf(":") + 1) || opts.user.length) : passFromUrl;
  if (opts.user && !opts.user.includes(":")) password = undefined;

  const secure = isSecureScheme(scheme) || opts.sslReqd;

  // Sens du transfert
  let direction: TransferDirection = "download";
  if (scheme === "smtp" || scheme === "smtps") direction = "send";
  else if (opts.upload !== undefined) direction = "upload";
  else if (opts.listOnly) direction = "list";
  else if ((scheme === "mqtt" || scheme === "mqtts") && opts.data.length > 0) direction = "publish";
  else if (scheme === "mqtt" || scheme === "mqtts") direction = "subscribe";
  else if ((scheme === "ws" || scheme === "wss") && opts.data.length > 0) direction = "publish";
  else if (scheme === "ws" || scheme === "wss") direction = "subscribe";

  const payload = resolvePayload(opts, scheme, direction);

  const req: ProtocolRequest = {
    scheme,
    url: rawUrl,
    host,
    port: port ?? DEFAULT_PORTS[scheme],
    path,
    direction,
    username,
    password,
    secure,
    tlsOpportunistic: opts.ssl && !secure,
    insecure: opts.insecure,
    payload,
    output: opts.output,
    timeoutMs: opts.maxTimeMs,
    connectTimeoutMs: opts.connectTimeoutMs,
    range: opts.range,
    warnings,
  };

  if (scheme === "smtp" || scheme === "smtps") {
    req.smtp = {
      from: opts.mailFrom,
      recipients: opts.mailRcpt,
      allowRcptFailures: opts.mailRcptAllowFails,
    };
    if (opts.mailRcpt.length === 0) {
      warnings.push({
        code: "missing-recipient",
        message: "SMTP : aucun --mail-rcpt fourni, le mail n'aura pas de destinataire.",
        level: "warning",
      });
    }
  }
  if (scheme === "ftp" || scheme === "ftps") {
    req.ftp = { quote: opts.quote, createDirs: opts.ftpCreateDirs, listOnly: opts.listOnly };
  }
  if (scheme === "mqtt" || scheme === "mqtts") {
    req.mqtt = { qos: opts.mqttQos ?? 0, retain: opts.mqttRetain };
  }
  if (scheme === "ws" || scheme === "wss") {
    const subprotocols: string[] = [];
    const otherHeaders: Array<[string, string]> = [];
    for (const [n, v] of opts.headers) {
      if (n.toLowerCase() === "sec-websocket-protocol") subprotocols.push(...v.split(",").map((s) => s.trim()).filter(Boolean));
      else otherHeaders.push([n, v]);
    }
    req.ws = { subprotocols, messages: opts.data };
    req.headers = otherHeaders;
  }

  warnings.push(...variableWarnings(varCtx));
  return req;
}

function scanOptions(tokens: string[], warnings: ParseWarning[]): ScannedOptions {
  const o: ScannedOptions = {
    data: [],
    headers: [],
    quote: [],
    insecure: false,
    ssl: false,
    sslReqd: false,
    listOnly: false,
    ftpCreateDirs: false,
    mailRcpt: [],
    mailRcptAllowFails: false,
    mqttRetain: false,
  };

  const next = (i: number): string | undefined => tokens[i + 1];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    switch (t) {
      case "-u": case "--user": o.user = next(i); i++; break;
      case "-T": case "--upload-file": o.upload = next(i); i++; break;
      case "-o": case "--output": o.output = next(i); i++; break;
      case "-d": case "--data": case "--data-raw": case "--data-binary": case "--data-ascii": {
        const v = next(i); if (v !== undefined) o.data.push(v); i++; break;
      }
      case "-H": case "--header": {
        const v = next(i); i++;
        if (v !== undefined) {
          const colon = v.indexOf(":");
          if (colon > 0) o.headers.push([v.slice(0, colon).trim(), v.slice(colon + 1).trim()]);
        }
        break;
      }
      case "-Q": case "--quote": { const v = next(i); if (v !== undefined) o.quote.push(v); i++; break; }
      case "-r": case "--range": o.range = next(i); i++; break;
      case "-m": case "--max-time": { const v = next(i); if (v) o.maxTimeMs = Math.round(parseFloat(v) * 1000); i++; break; }
      case "--connect-timeout": { const v = next(i); if (v) o.connectTimeoutMs = Math.round(parseFloat(v) * 1000); i++; break; }
      case "-k": case "--insecure": o.insecure = true; break;
      case "--ssl": o.ssl = true; break;
      case "--ssl-reqd": o.sslReqd = true; break;
      case "-l": case "--list-only": o.listOnly = true; break;
      case "--ftp-create-dirs": o.ftpCreateDirs = true; break;
      case "--mail-from": o.mailFrom = next(i); i++; break;
      case "--mail-rcpt": { const v = next(i); if (v !== undefined) o.mailRcpt.push(v); i++; break; }
      case "--mail-rcpt-allowfails": o.mailRcptAllowFails = true; break;
      case "--retain": o.mqttRetain = true; break;
      case "--qos": { const v = next(i); if (v) o.mqttQos = parseInt(v, 10); i++; break; }
      case "--url": i++; break; // déjà pris en compte
      default:
        // Les options HTTP connues qui n'ont pas de sens ici sont ignorées
        // silencieusement ; une valeur attendue est sautée.
        if (VALUE_OPTIONS.has(t)) i++;
        break;
    }
  }
  return o;
}

function resolvePayload(opts: ScannedOptions, scheme: ProtocolScheme, direction: TransferDirection): Payload | undefined {
  if (opts.upload !== undefined) {
    return opts.upload.startsWith("@") ? { filePath: opts.upload.slice(1) } : { filePath: opts.upload };
  }
  // WebSocket porte ses messages dans ws.messages, pas dans payload.
  if (scheme === "ws" || scheme === "wss") return undefined;
  if (opts.data.length > 0 && (direction === "send" || direction === "publish" || scheme === "tftp")) {
    const joined = opts.data.map((d) => (d.startsWith("@") ? `\u0000FILE\u0000${d.slice(1)}` : d)).join("\n");
    const fileMatch = /^\u0000FILE\u0000(.+)$/.exec(joined);
    if (fileMatch) return { filePath: fileMatch[1] };
    return { text: opts.data.join("") };
  }
  return undefined;
}

/** Découpe une URL protocolaire en hôte / port / chemin / identifiants. */
function dissectUrl(
  scheme: ProtocolScheme,
  rawUrl: string
): { host: string; port?: number; path: string; userFromUrl?: string; passFromUrl?: string } {
  if (scheme === "file") {
    // file:///chemin ou file://host/chemin
    const m = /^file:\/\/([^/]*)(\/.*)?$/.exec(rawUrl);
    const host = m?.[1] ?? "";
    const path = m?.[2] ?? (rawUrl.startsWith("file:") ? rawUrl.slice("file:".length) : rawUrl);
    return { host: host === "localhost" ? "" : host, path };
  }

  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/]*)(\/.*)?$/.exec(rawUrl);
  const authority = m?.[1] ?? "";
  const path = m?.[2] ?? "";

  let userinfo = "";
  let hostport = authority;
  const at = authority.lastIndexOf("@");
  if (at !== -1) {
    userinfo = authority.slice(0, at);
    hostport = authority.slice(at + 1);
  }

  let host = hostport;
  let port: number | undefined;
  // IPv6 littéral [::1]:port
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostport);
  if (v6) {
    host = v6[1]!;
    port = v6[2] ? parseInt(v6[2], 10) : undefined;
  } else {
    const colon = hostport.lastIndexOf(":");
    if (colon !== -1 && /^\d+$/.test(hostport.slice(colon + 1))) {
      host = hostport.slice(0, colon);
      port = parseInt(hostport.slice(colon + 1), 10);
    }
  }

  let userFromUrl: string | undefined;
  let passFromUrl: string | undefined;
  if (userinfo) {
    const c = userinfo.indexOf(":");
    userFromUrl = decodeURIComponent(c === -1 ? userinfo : userinfo.slice(0, c));
    if (c !== -1) passFromUrl = decodeURIComponent(userinfo.slice(c + 1));
  }

  return { host, port, path, userFromUrl, passFromUrl };
}
