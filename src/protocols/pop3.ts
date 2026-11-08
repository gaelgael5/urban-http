/**
 * Adaptateur POP3 / POP3S : lister les messages (pop3://hôte/) ou en récupérer
 * un (pop3://hôte/1), comme curl. POP3 est un protocole en lignes simple ;
 * l'implémentation par défaut tient sur node:net / node:tls. Un client peut
 * être injecté via ctx.clientFactory pour les tests.
 */
import { ProtocolAdapter, ProtocolContext, ProtocolRequest, ProtocolResult } from "./types.js";

/** Client POP3 minimal : une commande → la réponse texte complète. */
export interface Pop3Client {
  connect(opts: { host: string; port: number; secure: boolean; insecure: boolean; timeoutMs?: number }): Promise<string>;
  /** Envoie USER/PASS et renvoie la bannière finale. */
  login(user: string, pass: string): Promise<string>;
  /** LIST (sans argument) : renvoie la liste brute. */
  list(): Promise<string>;
  /** RETR n : renvoie le message complet. */
  retrieve(msg: number): Promise<string>;
  quit(): Promise<void>;
}

export type Pop3ClientFactory = () => Pop3Client | Promise<Pop3Client>;

export const pop3Adapter: ProtocolAdapter = {
  name: "pop3",
  schemes: ["pop3", "pop3s"],

  async execute(req: ProtocolRequest, ctx: ProtocolContext): Promise<ProtocolResult> {
    const issues: string[] = [];
    const factory = (ctx.clientFactory as Pop3ClientFactory | undefined) ?? (() => createSocketPop3Client());
    const client = await factory();

    try {
      await client.connect({
        host: req.host,
        port: req.port,
        secure: req.secure,
        insecure: req.insecure,
        timeoutMs: req.connectTimeoutMs ?? req.timeoutMs,
      });
      if (req.username) await client.login(req.username, req.password ?? "");

      // Un chemin numérique (/1) = RETR ce message ; sinon LIST.
      const msgNum = /^\/?(\d+)$/.exec(req.path.replace(/^\//, ""))?.[1];
      if (msgNum) {
        const message = await client.retrieve(parseInt(msgNum, 10));
        const body = new TextEncoder().encode(message);
        if (req.output && req.output !== "-" && ctx.writeFile) await ctx.writeFile(req.output, body);
        return {
          scheme: req.scheme, ok: true,
          summary: `Message ${msgNum} récupéré (${body.byteLength} octets)`,
          body, meta: { message: Number(msgNum), bytes: body.byteLength }, issues,
        };
      }

      const list = await client.list();
      return {
        scheme: req.scheme, ok: true,
        summary: "Liste des messages récupérée",
        body: new TextEncoder().encode(list),
        meta: { list }, issues,
      };
    } finally {
      await client.quit().catch(() => {});
    }
  },
};

/**
 * Implémentation par défaut sur socket. POP3 répond par des lignes ;
 * une réponse commence par "+OK" ou "-ERR", et les réponses multi-lignes
 * se terminent par une ligne ".".
 */
async function createSocketPop3Client(): Promise<Pop3Client> {
  const net = await import("node:net");
  const tls = await import("node:tls");

  let socket: import("node:net").Socket;
  let buffer = "";
  const waiters: Array<{ multiline: boolean; resolve: (s: string) => void; reject: (e: Error) => void }> = [];

  const onData = (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    while (waiters.length > 0) {
      const w = waiters[0]!;
      const end = w.multiline ? findMultilineEnd(buffer) : buffer.indexOf("\r\n");
      if (end === -1) break;
      const resp = buffer.slice(0, end);
      buffer = buffer.slice(w.multiline ? end + 5 : end + 2);
      waiters.shift();
      if (!w.multiline && resp.startsWith("-ERR")) w.reject(new Error(resp));
      else if (w.multiline && resp.startsWith("-ERR")) w.reject(new Error(resp));
      else w.resolve(resp);
    }
  };

  const expect = (multiline: boolean) =>
    new Promise<string>((resolve, reject) => {
      waiters.push({ multiline, resolve, reject });
    });

  const send = (line: string, multiline = false) => {
    socket.write(line + "\r\n");
    return expect(multiline);
  };

  return {
    connect(opts) {
      return new Promise<string>((resolve, reject) => {
        const onError = (e: Error) => reject(e);
        if (opts.secure) {
          socket = tls.connect(
            { host: opts.host, port: opts.port, rejectUnauthorized: !opts.insecure },
            () => {}
          );
        } else {
          socket = net.connect({ host: opts.host, port: opts.port });
        }
        if (opts.timeoutMs) socket.setTimeout(opts.timeoutMs, () => socket.destroy(new Error("timeout POP3")));
        socket.on("data", onData);
        socket.on("error", onError);
        // Bannière de bienvenue (+OK ...)
        expect(false).then(resolve, reject);
      });
    },
    async login(user, pass) {
      await send(`USER ${user}`);
      return send(`PASS ${pass}`);
    },
    list() {
      return send("LIST", true);
    },
    retrieve(msg) {
      return send(`RETR ${msg}`, true);
    },
    async quit() {
      try {
        await send("QUIT");
      } finally {
        socket?.end();
      }
    },
  };
}

/** Fin d'une réponse POP3 multi-lignes : la séquence CRLF "." CRLF. */
function findMultilineEnd(buf: string): number {
  const idx = buf.indexOf("\r\n.\r\n");
  return idx; // -1 si incomplet
}
