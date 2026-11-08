import { describe, expect, it } from "vitest";
import { parseProtocolCommand } from "../src/protocols/parse.js";
import { wsAdapter } from "../src/protocols/ws.js";
import type { WebSocketLike } from "../src/protocols/ws.js";

const dec = (b?: Uint8Array) => (b ? new TextDecoder().decode(b) : undefined);
const reqOf = (cmd: string) => {
  const r = parseProtocolCommand(cmd);
  if (!r.request) throw new Error("pas de requête: " + JSON.stringify(r.warnings));
  return r.request;
};

/** Faux WebSocket piloté à la main pour les tests (API standard addEventListener). */
class FakeWebSocket implements WebSocketLike {
  sent: string[] = [];
  closed = false;
  private handlers: Record<string, Array<(ev: unknown) => void>> = {};
  constructor(public url: string, public protocols: string[]) {}
  send(data: string | Uint8Array) { this.sent.push(typeof data === "string" ? data : new TextDecoder().decode(data)); }
  close() { this.closed = true; }
  addEventListener(type: string, handler: (ev: unknown) => void) {
    (this.handlers[type] ??= []).push(handler);
  }
  emit(type: string, ev?: unknown) { for (const h of this.handlers[type] ?? []) h(ev); }
}

describe("parseProtocolCommand — WebSocket", () => {
  it("ws:// et wss:// avec ports par défaut", () => {
    expect(reqOf("curl ws://echo.e.com/socket").port).toBe(80);
    const s = reqOf("curl wss://echo.e.com/socket");
    expect(s.port).toBe(443);
    expect(s.secure).toBe(true);
  });

  it("messages -d et sous-protocole via en-tête", () => {
    const r = reqOf(`curl ws://echo.e.com/s -d "salut" -d "monde" -H "Sec-WebSocket-Protocol: chat, superchat"`);
    expect(r.direction).toBe("publish");
    expect(r.ws?.messages).toEqual(["salut", "monde"]);
    expect(r.ws?.subprotocols).toEqual(["chat", "superchat"]);
    // le header Sec-WebSocket-Protocol est retiré des headers de poignée de main
    expect(r.headers?.some(([n]) => n.toLowerCase() === "sec-websocket-protocol")).toBe(false);
  });

  it("sans -d : direction subscribe", () => {
    expect(reqOf("curl ws://echo.e.com/s").direction).toBe("subscribe");
  });
});

describe("wsAdapter (WebSocket simulé)", () => {
  it("envoie les messages à l'ouverture et renvoie la première réponse", async () => {
    let fake: FakeWebSocket | undefined;
    const p = wsAdapter.execute(reqOf(`curl ws://echo.e.com/s -d "ping"`), {
      clientFactory: (url, protocols) => (fake = new FakeWebSocket(url, protocols)),
    });
    // Simule le cycle de vie du serveur
    await Promise.resolve();
    fake!.emit("open");
    expect(fake!.sent).toEqual(["ping"]);
    fake!.emit("message", { data: "pong" });

    const res = await p;
    expect(res.ok).toBe(true);
    expect(dec(res.body)).toBe("pong");
    expect(res.meta.messagesSent).toBe(1);
    expect(fake!.closed).toBe(true);
  });

  it("passe les sous-protocoles à la fabrique", async () => {
    let seenProtocols: string[] = [];
    const p = wsAdapter.execute(reqOf(`curl ws://e.com/s -H "Sec-WebSocket-Protocol: chat" -d "x"`), {
      clientFactory: (_url, protocols) => {
        seenProtocols = protocols;
        const f = new FakeWebSocket(_url, protocols);
        queueMicrotask(() => { f.emit("open"); f.emit("message", { data: "ok" }); });
        return f;
      },
    });
    await p;
    expect(seenProtocols).toEqual(["chat"]);
  });

  it("gère un message binaire (ArrayBuffer)", async () => {
    const bytes = new TextEncoder().encode("binaire");
    const p = wsAdapter.execute(reqOf("curl ws://e.com/s"), {
      clientFactory: () => {
        const f = new FakeWebSocket("ws://e.com/s", []);
        queueMicrotask(() => { f.emit("open"); f.emit("message", { data: bytes.buffer }); });
        return f;
      },
    });
    const res = await p;
    expect(dec(res.body)).toBe("binaire");
  });

  it("erreur de connexion → rejet", async () => {
    const p = wsAdapter.execute(reqOf("curl ws://injoignable.e.com/s"), {
      clientFactory: () => {
        const f = new FakeWebSocket("ws://injoignable.e.com/s", []);
        queueMicrotask(() => f.emit("error", new Error("refus")));
        return f;
      },
    });
    await expect(p).rejects.toThrow(/WebSocket/);
  });
});
