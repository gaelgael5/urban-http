/**
 * Exécution d'une requête parsée avec fetch, en appliquant
 * timeout, retries, authentification Digest et, côté Node,
 * les options --insecure et --proxy (via undici).
 */
import { buildDigestAuthorization, parseDigestChallenge } from "./digest.js";
import { HttpRequestModel } from "./model.js";
import { FetchPlan, ToFetchOptions, toFetch } from "./to-fetch.js";

export interface ExecuteOptions extends ToFetchOptions {
  /** fetch à utiliser (par défaut le fetch global). */
  fetchImpl?: typeof fetch;
}

export interface ExecuteResult {
  response: Response;
  /** Nombre de tentatives effectuées (1 = pas de retry). */
  attempts: number;
  /** Problèmes non bloquants rencontrés (fichiers non résolus, options ignorées...). */
  issues: string[];
}

/** Codes HTTP que curl considère comme "transitoires" pour --retry. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function isNode(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return !!proc?.versions?.node;
}

/**
 * Exécute la requête. Lève une erreur si le réseau échoue définitivement ;
 * une réponse HTTP d'erreur (4xx/5xx) est renvoyée normalement, comme curl.
 */
export async function execute(req: HttpRequestModel, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
  // Sous Node, résoudre les références de fichiers (-d @f, -F, -b f, -T) sans configuration
  if (!opts.readFile && isNode()) {
    try {
      const moduleName = "node:fs";
      const fs = await import(/* @vite-ignore */ moduleName);
      opts = { ...opts, readFile: (path: string) => fs.readFileSync(path) as Uint8Array };
    } catch {
      // fs indisponible : les références de fichiers seront signalées par toFetch
    }
  }

  const plan = toFetch(req, opts);
  const issues = [...plan.issues];
  const doFetch = opts.fetchImpl ?? fetch;

  await applyDispatcher(req, plan, issues);

  const maxAttempts = 1 + Math.max(0, req.options.retry ?? 0);
  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      let response = await doFetch(plan.url, plan.init);

      // Authentification Digest : répondre au challenge 401 par une seconde requête
      if (response.status === 401 && req.auth?.kind === "digest" && req.auth.username !== undefined) {
        const retried = await answerDigestChallenge(req, plan, response, doFetch, issues);
        if (retried) response = retried;
      }

      if (attempt < maxAttempts && RETRYABLE_STATUS.has(response.status)) {
        await delay(retryDelayMs(req, attempt));
        continue;
      }
      return { response, attempts: attempt, issues };
    } catch (e) {
      lastError = e;
      if (attempt < maxAttempts) {
        await delay(retryDelayMs(req, attempt));
        continue;
      }
      throw e;
    }
  }
  throw lastError ?? new Error("exécution impossible");
}

function retryDelayMs(req: HttpRequestModel, attempt: number): number {
  if (req.options.retryDelayMs) return req.options.retryDelayMs;
  // Comme curl : backoff exponentiel 1s, 2s, 4s... plafonné à 10 min
  return Math.min(1000 * 2 ** (attempt - 1), 600_000);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ */
/* Digest                                                              */
/* ------------------------------------------------------------------ */

async function answerDigestChallenge(
  req: HttpRequestModel,
  plan: FetchPlan,
  response: Response,
  doFetch: typeof fetch,
  issues: string[]
): Promise<Response | undefined> {
  let challengeHeader: string | null = null;
  try {
    challengeHeader = response.headers.get("www-authenticate");
  } catch {
    /* ignore */
  }
  if (!challengeHeader) {
    issues.push(
      "Digest : challenge WWW-Authenticate illisible. Dans un navigateur, le serveur doit l'exposer via Access-Control-Expose-Headers (CORS)."
    );
    return undefined;
  }

  const challenge = parseDigestChallenge(challengeHeader);
  if (!challenge) {
    issues.push("Digest : le serveur n'a pas renvoyé de challenge Digest exploitable.");
    return undefined;
  }

  let uri: string;
  try {
    const u = new URL(plan.url);
    uri = u.pathname + u.search;
  } catch {
    uri = plan.url;
  }

  const authorization = await buildDigestAuthorization(
    challenge,
    { username: req.auth?.username ?? "", password: req.auth?.password ?? "" },
    req.method,
    uri
  );
  if (!authorization) {
    issues.push(
      `Digest : algorithme "${challenge.algorithm ?? "MD5"}" / qop "${challenge.qop ?? ""}" non pris en charge (supportés : MD5, SHA-256, qop=auth).`
    );
    return undefined;
  }

  const headers = new Headers(plan.init.headers);
  headers.set("Authorization", authorization);
  return doFetch(plan.url, { ...plan.init, headers });
}

/* ------------------------------------------------------------------ */
/* Proxy et TLS (Node, via undici)                                      */
/* ------------------------------------------------------------------ */

/** Applique -x/--proxy et -k/--insecure côté Node ; signale la limite ailleurs. */
async function applyDispatcher(req: HttpRequestModel, plan: FetchPlan, issues: string[]): Promise<void> {
  const needsProxy = !!req.options.proxy;
  const needsInsecure = req.options.insecure;
  if (!needsProxy && !needsInsecure) return;

  if (!isNode()) {
    if (needsProxy) issues.push("-x/--proxy : un navigateur ne permet pas de choisir un proxy par requête.");
    if (needsInsecure) issues.push("-k/--insecure : impossible de désactiver la vérification TLS dans un navigateur.");
    return;
  }

  let undici: {
    Agent: new (o: object) => unknown;
    ProxyAgent: new (o: object) => unknown;
  };
  try {
    // Spécificateur dynamique pour que les bundlers navigateur n'essaient pas de résoudre undici
    const moduleName = "undici";
    undici = await import(/* @vite-ignore */ moduleName);
  } catch {
    issues.push("Le paquet undici n'est pas installé : --proxy et --insecure sont ignorés (npm install undici).");
    return;
  }

  if (needsProxy) {
    let uri = req.options.proxy!;
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(uri)) uri = "http://" + uri;
    const options: Record<string, unknown> = { uri };
    if (req.options.proxyUser) {
      options.token = "Basic " + toBase64(req.options.proxyUser);
    }
    if (needsInsecure) {
      options.requestTls = { rejectUnauthorized: false };
    }
    (plan.init as Record<string, unknown>).dispatcher = new undici.ProxyAgent(options);
    return;
  }

  (plan.init as Record<string, unknown>).dispatcher = new undici.Agent({
    connect: { rejectUnauthorized: false },
  });
}

function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
