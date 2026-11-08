/**
 * Exécution d'une requête parsée avec fetch, en appliquant
 * timeout, retries et (côté Node) l'option --insecure.
 */
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

/**
 * Exécute la requête. Lève une erreur si le réseau échoue définitivement ;
 * une réponse HTTP d'erreur (4xx/5xx) est renvoyée normalement, comme curl.
 */
export async function execute(req: HttpRequestModel, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
  const plan = toFetch(req, opts);
  const issues = [...plan.issues];
  const doFetch = opts.fetchImpl ?? fetch;

  await applyInsecure(req, plan, issues);

  const maxAttempts = 1 + Math.max(0, req.options.retry ?? 0);
  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      const response = await doFetch(plan.url, plan.init);
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

/** Applique -k/--insecure côté Node (via undici) ; signale la limite ailleurs. */
async function applyInsecure(req: HttpRequestModel, plan: FetchPlan, issues: string[]): Promise<void> {
  if (!req.options.insecure) return;
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  if (!proc?.versions?.node) {
    issues.push("-k/--insecure : impossible de désactiver la vérification TLS dans un navigateur.");
    return;
  }
  try {
    // Spécificateur dynamique pour que les bundlers navigateur n'essaient pas de résoudre undici
    const moduleName = "undici";
    const undici = await import(/* @vite-ignore */ moduleName);
    (plan.init as Record<string, unknown>).dispatcher = new undici.Agent({
      connect: { rejectUnauthorized: false },
    });
  } catch {
    issues.push("-k/--insecure : le module undici n'est pas disponible, la vérification TLS reste active.");
  }
}
