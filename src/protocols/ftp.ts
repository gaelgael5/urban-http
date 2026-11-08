/**
 * Adaptateur FTP / FTPS : téléchargement, téléversement (-T), listage (-l),
 * commandes brutes (-Q/--quote), comme `curl ftp://...`.
 *
 * S'appuie sur basic-ftp (dépendance optionnelle). Une fabrique de client peut
 * être injectée via ctx.clientFactory pour les tests.
 */
import { ProtocolAdapter, ProtocolContext, ProtocolRequest, ProtocolResult } from "./types.js";

/** Sous-ensemble de l'API basic-ftp réellement utilisé. */
export interface FtpClient {
  access(opts: {
    host: string;
    port: number;
    user?: string;
    password?: string;
    secure?: boolean | "implicit";
    secureOptions?: { rejectUnauthorized?: boolean };
  }): Promise<unknown>;
  list(path?: string): Promise<Array<{ name: string; size?: number; type?: unknown }>>;
  /** Envoie des octets vers un chemin distant. */
  uploadFrom(source: unknown, remotePath: string): Promise<unknown>;
  /** Récupère un chemin distant ; dest est un flux ou un collecteur. */
  downloadTo(dest: unknown, remotePath: string): Promise<unknown>;
  /** Commande FTP brute (pour -Q/--quote). */
  send(command: string): Promise<{ code: number; message: string }>;
  ensureDir?(path: string): Promise<unknown>;
  close(): void;
}

export type FtpClientFactory = () => FtpClient | Promise<FtpClient>;

async function defaultFactory(): Promise<FtpClient> {
  const moduleName = "basic-ftp";
  const ftp = (await import(/* @vite-ignore */ moduleName)) as { Client: new () => FtpClient };
  return new ftp.Client();
}

async function readBytes(req: ProtocolRequest, ctx: ProtocolContext): Promise<Uint8Array> {
  const p = req.payload;
  if (!p) return new Uint8Array();
  if (p.filePath) {
    if (ctx.readFile) {
      const data = await ctx.readFile(p.filePath);
      return typeof data === "string" ? new TextEncoder().encode(data) : data;
    }
    const fs = await import("node:fs/promises");
    return new Uint8Array(await fs.readFile(p.filePath));
  }
  return new TextEncoder().encode(p.text ?? "");
}

export const ftpAdapter: ProtocolAdapter = {
  name: "ftp",
  schemes: ["ftp", "ftps"],

  async execute(req: ProtocolRequest, ctx: ProtocolContext): Promise<ProtocolResult> {
    const issues: string[] = [];
    const factory = (ctx.clientFactory as FtpClientFactory | undefined) ?? defaultFactory;
    const client = await factory();

    try {
      await client.access({
        host: req.host,
        port: req.port,
        user: req.username,
        password: req.password,
        secure: req.scheme === "ftps" ? "implicit" : req.tlsOpportunistic ? true : false,
        secureOptions: req.insecure ? { rejectUnauthorized: false } : undefined,
      });

      // Commandes brutes -Q/--quote avant l'opération principale
      const quoteResults: Array<{ command: string; code: number; message: string }> = [];
      for (const command of req.ftp?.quote ?? []) {
        const res = await client.send(command);
        quoteResults.push({ command, code: res.code, message: res.message });
      }

      if (req.direction === "list") {
        const entries = await client.list(req.path || undefined);
        const names = entries.map((e) => e.name);
        return {
          scheme: req.scheme, ok: true,
          summary: `${entries.length} entrée(s) listée(s)`,
          body: new TextEncoder().encode(names.join("\n")),
          meta: { entries, quote: quoteResults }, issues,
        };
      }

      if (req.direction === "upload") {
        if (req.ftp?.createDirs && client.ensureDir) {
          const dir = req.path.slice(0, req.path.lastIndexOf("/"));
          if (dir) await client.ensureDir(dir);
        }
        const bytes = await readBytes(req, ctx);
        await client.uploadFrom(await toReadable(bytes), req.path);
        return {
          scheme: req.scheme, ok: true,
          summary: `${bytes.byteLength} octets téléversés vers ${req.path}`,
          meta: { path: req.path, bytes: bytes.byteLength, quote: quoteResults }, issues,
        };
      }

      // download
      const sink = await createByteSink();
      await client.downloadTo(sink.writable, req.path);
      const body = sink.collect();
      if (req.output && req.output !== "-" && ctx.writeFile) await ctx.writeFile(req.output, body);
      return {
        scheme: req.scheme, ok: true,
        summary: `${body.byteLength} octets récupérés depuis ${req.path}`,
        body,
        meta: { path: req.path, bytes: body.byteLength, quote: quoteResults }, issues,
      };
    } finally {
      client.close();
    }
  },
};

/** Flux lisible à partir d'octets (node:stream), pour uploadFrom. */
async function toReadable(bytes: Uint8Array): Promise<unknown> {
  const { Readable } = await import("node:stream");
  return Readable.from(Buffer.from(bytes));
}

/** Collecteur d'octets exposant un Writable, pour downloadTo. */
async function createByteSink(): Promise<{ writable: unknown; collect: () => Uint8Array }> {
  const { PassThrough } = await import("node:stream");
  const chunks: Buffer[] = [];
  const pass = new PassThrough();
  pass.on("data", (c: Buffer) => chunks.push(c));
  return { writable: pass, collect: () => new Uint8Array(Buffer.concat(chunks)) };
}
