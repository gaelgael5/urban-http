/**
 * Adaptateur SFTP : téléchargement, téléversement (-T), listage (-l),
 * comme `curl sftp://utilisateur@serveur/chemin`.
 *
 * S'appuie sur ssh2 (dépendance optionnelle), enrobé dans une petite interface
 * promesse. Une fabrique de client peut être injectée via ctx.clientFactory.
 */
import { ProtocolAdapter, ProtocolContext, ProtocolRequest, ProtocolResult } from "./types.js";

/** Client SFTP minimal attendu par l'adaptateur. */
export interface SftpClient {
  connect(opts: {
    host: string;
    port: number;
    username?: string;
    password?: string;
    readyTimeout?: number;
  }): Promise<void>;
  get(remotePath: string): Promise<Uint8Array>;
  put(data: Uint8Array, remotePath: string): Promise<void>;
  list(path: string): Promise<Array<{ filename: string; size?: number }>>;
  end(): void;
}

export type SftpClientFactory = () => SftpClient | Promise<SftpClient>;

/** Enrobe ssh2 (API à callbacks/événements) dans l'interface SftpClient. */
async function defaultFactory(): Promise<SftpClient> {
  const moduleName = "ssh2";
  const ssh2 = (await import(/* @vite-ignore */ moduleName)) as { Client: new () => Ssh2Client };
  const conn = new ssh2.Client();
  let sftp: Ssh2Sftp;

  return {
    connect(opts) {
      return new Promise<void>((resolve, reject) => {
        conn
          .on("ready", () => {
            conn.sftp((err, s) => {
              if (err) return reject(err);
              sftp = s;
              resolve();
            });
          })
          .on("error", reject)
          .connect(opts);
      });
    },
    get(remotePath) {
      return new Promise<Uint8Array>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const stream = sftp.createReadStream(remotePath);
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
        stream.on("error", reject);
      });
    },
    put(data, remotePath) {
      return new Promise<void>((resolve, reject) => {
        const stream = sftp.createWriteStream(remotePath);
        stream.on("close", () => resolve());
        stream.on("error", reject);
        stream.end(Buffer.from(data));
      });
    },
    list(path) {
      return new Promise((resolve, reject) => {
        sftp.readdir(path || ".", (err, entries) => {
          if (err) return reject(err);
          resolve(entries.map((e) => ({ filename: e.filename, size: e.attrs?.size })));
        });
      });
    },
    end() {
      conn.end();
    },
  };
}

async function readBytes(req: ProtocolRequest, ctx: ProtocolContext): Promise<Uint8Array> {
  const p = req.payload;
  if (!p) return new Uint8Array();
  if (p.filePath) {
    if (ctx.readFile) {
      const d = await ctx.readFile(p.filePath);
      return typeof d === "string" ? new TextEncoder().encode(d) : d;
    }
    const fs = await import("node:fs/promises");
    return new Uint8Array(await fs.readFile(p.filePath));
  }
  return new TextEncoder().encode(p.text ?? "");
}

export const sftpAdapter: ProtocolAdapter = {
  name: "sftp",
  schemes: ["sftp"],

  async execute(req: ProtocolRequest, ctx: ProtocolContext): Promise<ProtocolResult> {
    const issues: string[] = [];
    const factory = (ctx.clientFactory as SftpClientFactory | undefined) ?? defaultFactory;
    const client = await factory();

    try {
      await client.connect({
        host: req.host,
        port: req.port,
        username: req.username,
        password: req.password,
        readyTimeout: req.connectTimeoutMs ?? req.timeoutMs,
      });

      if (req.direction === "list") {
        const entries = await client.list(req.path);
        return {
          scheme: "sftp", ok: true,
          summary: `${entries.length} entrée(s) listée(s)`,
          body: new TextEncoder().encode(entries.map((e) => e.filename).join("\n")),
          meta: { entries }, issues,
        };
      }

      if (req.direction === "upload") {
        const bytes = await readBytes(req, ctx);
        await client.put(bytes, req.path);
        return {
          scheme: "sftp", ok: true,
          summary: `${bytes.byteLength} octets téléversés vers ${req.path}`,
          meta: { path: req.path, bytes: bytes.byteLength }, issues,
        };
      }

      const body = await client.get(req.path);
      if (req.output && req.output !== "-" && ctx.writeFile) await ctx.writeFile(req.output, body);
      return {
        scheme: "sftp", ok: true,
        summary: `${body.byteLength} octets récupérés depuis ${req.path}`,
        body, meta: { path: req.path, bytes: body.byteLength }, issues,
      };
    } finally {
      client.end();
    }
  },
};

/* Types internes minimaux de ssh2 (pour éviter une dépendance de types). */
interface Ssh2Client {
  on(event: "ready" | "error", cb: (arg?: unknown) => void): Ssh2Client;
  sftp(cb: (err: Error | undefined, sftp: Ssh2Sftp) => void): void;
  connect(opts: unknown): void;
  end(): void;
}
interface Ssh2Sftp {
  createReadStream(path: string): NodeJS.ReadableStream & { on(e: string, cb: (a: Buffer) => void): void };
  createWriteStream(path: string): NodeJS.WritableStream & { on(e: string, cb: () => void): void; end(b: Buffer): void };
  readdir(path: string, cb: (err: Error | undefined, list: Array<{ filename: string; attrs?: { size?: number } }>) => void): void;
}
