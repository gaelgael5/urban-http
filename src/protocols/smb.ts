/**
 * Adaptateur SMB / SMBS : récupérer un fichier d'un partage
 * (smb://serveur/partage/dossier/fichier), en téléverser un (-T), ou lister un
 * dossier (-l), comme curl. S'appuie sur @marsaud/smb2 (dépendance optionnelle).
 * Un client peut être injecté via ctx.clientFactory pour les tests.
 */
import { ProtocolAdapter, ProtocolContext, ProtocolRequest, ProtocolResult } from "./types.js";

/** Client SMB minimal attendu par l'adaptateur. */
export interface SmbClient {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readdir(path: string): Promise<string[]>;
  disconnect(): void;
}

/** Fabrique recevant les coordonnées du partage (serveur, partage, identifiants). */
export type SmbClientFactory = (coords: {
  server: string;
  port: number;
  share: string;
  username?: string;
  password?: string;
  domain?: string;
}) => SmbClient | Promise<SmbClient>;

async function defaultFactory(coords: {
  server: string;
  port: number;
  share: string;
  username?: string;
  password?: string;
  domain?: string;
}): Promise<SmbClient> {
  const moduleName = "@marsaud/smb2";
  const SMB2 = ((await import(/* @vite-ignore */ moduleName)) as { default: new (opts: unknown) => Smb2Raw }).default;
  const smb = new SMB2({
    share: `\\\\${coords.server}\\${coords.share}`,
    domain: coords.domain ?? "WORKGROUP",
    username: coords.username ?? "guest",
    password: coords.password ?? "",
    port: coords.port,
  });
  const toWin = (p: string) => p.replace(/\//g, "\\").replace(/^\\+/, "");
  return {
    readFile: (path) => new Promise((res, rej) => smb.readFile(toWin(path), (e, d) => (e ? rej(e) : res(new Uint8Array(d))))),
    writeFile: (path, data) => new Promise((res, rej) => smb.writeFile(toWin(path), Buffer.from(data), (e) => (e ? rej(e) : res()))),
    readdir: (path) => new Promise((res, rej) => smb.readdir(toWin(path) || "", (e, l) => (e ? rej(e) : res(l)))),
    disconnect: () => smb.disconnect(),
  };
}

/** Sépare le chemin SMB en partage + chemin dans le partage. */
function splitSharePath(path: string): { share: string; filePath: string } {
  const clean = path.replace(/^\//, "");
  const slash = clean.indexOf("/");
  if (slash === -1) return { share: clean, filePath: "" };
  return { share: clean.slice(0, slash), filePath: clean.slice(slash + 1) };
}

export const smbAdapter: ProtocolAdapter = {
  name: "smb",
  schemes: ["smb", "smbs"],

  async execute(req: ProtocolRequest, ctx: ProtocolContext): Promise<ProtocolResult> {
    const issues: string[] = [];
    const { share, filePath } = splitSharePath(req.path);
    if (!share) throw new Error("SMB : URL sans partage (smb://serveur/partage/fichier).");

    const [domain, user] = (req.username ?? "").includes("\\")
      ? (req.username ?? "").split("\\")
      : [undefined, req.username];

    const factory = (ctx.clientFactory as SmbClientFactory | undefined) ?? defaultFactory;
    const client = await factory({
      server: req.host,
      port: req.port,
      share,
      username: user,
      password: req.password,
      domain,
    });

    try {
      if (req.direction === "list") {
        const names = await client.readdir(filePath);
        return {
          scheme: req.scheme, ok: true,
          summary: `${names.length} entrée(s) dans ${share}/${filePath}`,
          body: new TextEncoder().encode(names.join("\n")),
          meta: { share, path: filePath, entries: names }, issues,
        };
      }

      if (req.direction === "upload") {
        let data: Uint8Array;
        if (req.payload?.filePath) {
          const d = ctx.readFile
            ? await ctx.readFile(req.payload.filePath)
            : new Uint8Array(await (await import("node:fs/promises")).readFile(req.payload.filePath));
          data = typeof d === "string" ? new TextEncoder().encode(d) : d;
        } else {
          data = new TextEncoder().encode(req.payload?.text ?? "");
        }
        await client.writeFile(filePath, data);
        return {
          scheme: req.scheme, ok: true,
          summary: `${data.byteLength} octets écrits dans ${share}/${filePath}`,
          meta: { share, path: filePath, bytes: data.byteLength }, issues,
        };
      }

      const body = await client.readFile(filePath);
      if (req.output && req.output !== "-" && ctx.writeFile) await ctx.writeFile(req.output, body);
      return {
        scheme: req.scheme, ok: true,
        summary: `${body.byteLength} octets récupérés depuis ${share}/${filePath}`,
        body, meta: { share, path: filePath, bytes: body.byteLength }, issues,
      };
    } finally {
      client.disconnect();
    }
  },
};

/* Type interne minimal de @marsaud/smb2. */
interface Smb2Raw {
  readFile(path: string, cb: (err: Error | undefined, data: Buffer) => void): void;
  writeFile(path: string, data: Buffer, cb: (err?: Error) => void): void;
  readdir(path: string, cb: (err: Error | undefined, list: string[]) => void): void;
  disconnect(): void;
}
