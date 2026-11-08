/**
 * Registre des adaptateurs de protocole.
 *
 * Le cœur du SDK ne connaît aucun protocole : les adaptateurs s'enregistrent
 * ici (par défaut ceux de référence côté Node), et `executeProtocol` route une
 * requête vers le bon adaptateur selon son schéma.
 */
import { ProtocolAdapter, ProtocolContext, ProtocolRequest, ProtocolResult, ProtocolScheme } from "./types.js";

const registry = new Map<string, ProtocolAdapter>();

/** Enregistre un adaptateur pour tous les schémas qu'il déclare. */
export function registerProtocol(adapter: ProtocolAdapter): void {
  for (const scheme of adapter.schemes) registry.set(scheme, adapter);
}

/** Retire l'adaptateur d'un schéma (surtout utile aux tests). */
export function unregisterProtocol(scheme: ProtocolScheme): void {
  registry.delete(scheme);
}

/** L'adaptateur enregistré pour un schéma, s'il existe. */
export function getProtocolAdapter(scheme: ProtocolScheme): ProtocolAdapter | undefined {
  return registry.get(scheme);
}

/** Schémas pour lesquels un adaptateur est actuellement enregistré. */
export function registeredSchemes(): ProtocolScheme[] {
  return [...registry.keys()] as ProtocolScheme[];
}

/**
 * Exécute une requête protocolaire via l'adaptateur enregistré.
 * Applique un timeout global (−m) via AbortSignal si l'adaptateur le respecte.
 */
export async function executeProtocol(req: ProtocolRequest, ctx: ProtocolContext = {}): Promise<ProtocolResult> {
  const adapter = registry.get(req.scheme);
  if (!adapter) {
    throw new Error(
      `Aucun adaptateur enregistré pour "${req.scheme}://". ` +
        `Appelez registerDefaultNodeAdapters() (Node) ou enregistrez un adaptateur pour ce schéma.`
    );
  }

  let signal = ctx.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (!signal && req.timeoutMs) {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), req.timeoutMs);
    signal = controller.signal;
  }

  try {
    return await adapter.execute(req, { ...ctx, signal });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
