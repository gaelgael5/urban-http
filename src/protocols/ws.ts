/**
 * Adaptateur WebSocket (ws:// et wss://), comme `curl ws://hôte/chemin`.
 *
 * Particularité : il s'appuie sur l'API WebSocket standard, disponible nativement
 * dans le navigateur ET dans Node ≥ 22 — aucun paquet à installer. C'est donc le
 * seul adaptateur de protocole qui fonctionne aussi côté navigateur.
 *
 * Opération, pilotée par la commande :
 *   - ouvre la connexion (sous-protocoles via -H "Sec-WebSocket-Protocol: ..."),
 *   - envoie chaque message -d,
 *   - lit le premier message reçu (ou attend la fermeture / le timeout),
 *   - referme la connexion.
 */
import { ProtocolAdapter, ProtocolContext, ProtocolRequest, ProtocolResult } from "./types.js";

/** Sous-ensemble de l'API WebSocket standard réellement utilisé. */
export interface WebSocketLike {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", handler: () => void): void;
  addEventListener(type: "message", handler: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", handler: (ev: { code?: number; reason?: string }) => void): void;
  addEventListener(type: "error", handler: (ev: unknown) => void): void;
}

export type WebSocketFactory = (url: string, subprotocols: string[]) => WebSocketLike;

/** Fabrique par défaut : l'objet WebSocket global (navigateur / Node ≥ 22). */
function defaultFactory(url: string, subprotocols: string[]): WebSocketLike {
  const WS = (globalThis as { WebSocket?: new (u: string, p?: string[]) => WebSocketLike }).WebSocket;
  if (!WS) {
    throw new Error(
      "WebSocket indisponible : Node ≥ 22 expose un WebSocket global, sinon installez 'ws' et passez un clientFactory."
    );
  }
  return subprotocols.length > 0 ? new WS(url, subprotocols) : new WS(url);
}

/** Normalise un message WebSocket (texte ou binaire) en octets. */
async function messageToBytes(data: unknown): Promise<Uint8Array> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  // Blob (navigateur)
  if (typeof (data as { arrayBuffer?: unknown }).arrayBuffer === "function") {
    return new Uint8Array(await (data as Blob).arrayBuffer());
  }
  return new TextEncoder().encode(String(data));
}

export const wsAdapter: ProtocolAdapter = {
  name: "ws",
  schemes: ["ws", "wss"],

  async execute(req: ProtocolRequest, ctx: ProtocolContext): Promise<ProtocolResult> {
    const issues: string[] = [];
    if (req.headers && req.headers.length > 0) {
      issues.push("En-têtes de poignée de main ignorés : l'API WebSocket standard n'accepte que les sous-protocoles.");
    }

    const factory = (ctx.clientFactory as WebSocketFactory | undefined) ?? defaultFactory;
    const subprotocols = req.ws?.subprotocols ?? [];
    const messages = req.ws?.messages ?? [];
    const timeoutMs = req.timeoutMs ?? 30000;

    const socket = factory(req.url, subprotocols);

    const body = await new Promise<Uint8Array | undefined>((resolve, reject) => {
      let settled = false;
      const received: Uint8Array[] = [];

      const finish = (value: Uint8Array | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.close(1000); } catch { /* déjà fermé */ }
        resolve(value);
      };

      const timer = setTimeout(() => {
        if (messages.length > 0 && received.length === 0) {
          issues.push("Aucune réponse reçue dans le délai imparti après l'envoi.");
          finish(undefined);
        } else {
          issues.push("Délai d'attente atteint.");
          finish(received[0]);
        }
      }, timeoutMs);

      socket.addEventListener("open", () => {
        for (const m of messages) socket.send(m);
        if (messages.length === 0) issues.push("Connexion ouverte sans message à envoyer : lecture du premier message reçu.");
      });

      socket.addEventListener("message", (ev) => {
        messageToBytes(ev.data).then((bytes) => {
          received.push(bytes);
          finish(bytes); // premier message reçu = réponse
        });
      });

      socket.addEventListener("close", () => {
        if (!settled) finish(received[0]);
      });

      socket.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Échec de la connexion WebSocket à ${req.url}.`));
      });
    });

    if (body && req.output && req.output !== "-" && ctx.writeFile) await ctx.writeFile(req.output, body);

    return {
      scheme: req.scheme,
      ok: true,
      summary: body
        ? `Réponse reçue (${body.byteLength} octets)${messages.length ? ` après ${messages.length} message(s) envoyé(s)` : ""}`
        : `${messages.length} message(s) envoyé(s), aucune réponse`,
      body,
      meta: { messagesSent: messages.length, subprotocols, received: body ? 1 : 0 },
      issues,
    };
  },
};
