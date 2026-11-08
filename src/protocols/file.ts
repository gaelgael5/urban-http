/**
 * Adaptateur FILE : lecture/écriture de fichiers locaux, comme `curl file://`.
 *
 * Entièrement autonome (aucune bibliothèque réseau). Utilise l'E/S injectée
 * via le contexte si présente, sinon node:fs. Une seule opération explicite :
 * lire le fichier de l'URL (download) ou y écrire le contenu de -T (upload).
 */
import { ProtocolAdapter, ProtocolContext, ProtocolRequest, ProtocolResult } from "./types.js";

async function defaultRead(path: string): Promise<Uint8Array> {
  const fs = await import("node:fs/promises");
  return new Uint8Array(await fs.readFile(path));
}

async function defaultWrite(path: string, data: Uint8Array): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.writeFile(path, data);
}

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

export const fileAdapter: ProtocolAdapter = {
  name: "file",
  schemes: ["file"],

  async execute(req: ProtocolRequest, ctx: ProtocolContext): Promise<ProtocolResult> {
    const issues: string[] = [];
    const read = ctx.readFile ?? defaultRead;
    const write = ctx.writeFile ?? defaultWrite;

    if (req.direction === "upload") {
      if (!req.payload) {
        throw new Error("file:// en upload sans contenu (-T) : rien à écrire.");
      }
      let data: Uint8Array;
      if (req.payload.filePath) {
        data = toBytes(await read(req.payload.filePath));
      } else {
        data = toBytes(req.payload.text ?? "");
      }
      await write(req.path, data);
      return {
        scheme: "file",
        ok: true,
        summary: `${data.byteLength} octets écrits dans ${req.path}`,
        meta: { path: req.path, bytes: data.byteLength },
        issues,
      };
    }

    // download (défaut)
    let body: Uint8Array;
    try {
      body = toBytes(await read(req.path));
    } catch (e) {
      throw new Error(`file:// lecture impossible de ${req.path} : ${(e as Error).message}`);
    }

    if (req.range) {
      const sliced = applyRange(body, req.range, issues);
      body = sliced;
    }

    if (req.output && req.output !== "-") {
      await write(req.output, body);
      issues.push(`Contenu écrit dans ${req.output} (-o).`);
    }

    return {
      scheme: "file",
      ok: true,
      summary: `${body.byteLength} octets lus depuis ${req.path}`,
      body,
      meta: { path: req.path, bytes: body.byteLength },
      issues,
    };
  },
};

/** Applique une plage d'octets "début-fin" (bornes incluses), comme curl -r. */
function applyRange(body: Uint8Array, range: string, issues: string[]): Uint8Array {
  const m = /^(\d*)-(\d*)$/.exec(range.trim());
  if (!m) {
    issues.push(`Plage "${range}" ignorée (format attendu : début-fin).`);
    return body;
  }
  const hasStart = m[1] !== "";
  const hasEnd = m[2] !== "";
  if (hasStart && hasEnd) return body.subarray(parseInt(m[1]!, 10), parseInt(m[2]!, 10) + 1);
  if (hasStart) return body.subarray(parseInt(m[1]!, 10));
  if (hasEnd) return body.subarray(Math.max(0, body.byteLength - parseInt(m[2]!, 10))); // -N derniers octets
  return body;
}
