/**
 * Adaptateur TFTP : récupérer un fichier (tftp://hôte/fichier) ou en envoyer
 * un (-T), comme curl. TFTP est un protocole UDP par blocs de 512 octets ;
 * l'implémentation par défaut tient sur node:dgram (mode octet). Un client
 * peut être injecté via ctx.clientFactory pour les tests.
 */
import { ProtocolAdapter, ProtocolContext, ProtocolRequest, ProtocolResult } from "./types.js";

export interface TftpClient {
  download(opts: { host: string; port: number; filename: string; timeoutMs: number }): Promise<Uint8Array>;
  upload(data: Uint8Array, opts: { host: string; port: number; filename: string; timeoutMs: number }): Promise<number>;
}

export type TftpClientFactory = () => TftpClient | Promise<TftpClient>;

const BLOCK_SIZE = 512;
const OP_RRQ = 1, OP_WRQ = 2, OP_DATA = 3, OP_ACK = 4, OP_ERROR = 5;

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

export const tftpAdapter: ProtocolAdapter = {
  name: "tftp",
  schemes: ["tftp"],

  async execute(req: ProtocolRequest, ctx: ProtocolContext): Promise<ProtocolResult> {
    const issues: string[] = [];
    const filename = req.path.replace(/^\//, "");
    if (!filename) throw new Error("TFTP : aucun nom de fichier dans l'URL.");
    const timeoutMs = req.timeoutMs ?? 10000;

    const factory = (ctx.clientFactory as TftpClientFactory | undefined) ?? (() => createDgramTftpClient());
    const client = await factory();

    if (req.direction === "upload") {
      const bytes = await readBytes(req, ctx);
      const sent = await client.upload(bytes, { host: req.host, port: req.port, filename, timeoutMs });
      return {
        scheme: "tftp", ok: true,
        summary: `${sent} octets envoyés vers ${filename}`,
        meta: { filename, bytes: sent }, issues,
      };
    }

    const body = await client.download({ host: req.host, port: req.port, filename, timeoutMs });
    if (req.output && req.output !== "-" && ctx.writeFile) await ctx.writeFile(req.output, body);
    return {
      scheme: "tftp", ok: true,
      summary: `${body.byteLength} octets récupérés depuis ${filename}`,
      body, meta: { filename, bytes: body.byteLength }, issues,
    };
  },
};

/** Trame RRQ/WRQ : opcode + filename + 0 + "octet" + 0. */
function requestPacket(opcode: number, filename: string): Buffer {
  return Buffer.concat([
    Buffer.from([0, opcode]),
    Buffer.from(filename, "ascii"),
    Buffer.from([0]),
    Buffer.from("octet", "ascii"),
    Buffer.from([0]),
  ]);
}

function ackPacket(block: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt16BE(OP_ACK, 0);
  b.writeUInt16BE(block, 2);
  return b;
}

function dataPacket(block: number, chunk: Uint8Array): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(OP_DATA, 0);
  header.writeUInt16BE(block, 2);
  return Buffer.concat([header, Buffer.from(chunk)]);
}

function tftpError(msg: Buffer): string {
  // 05 | code (2) | message | 0
  const code = msg.readUInt16BE(2);
  const text = msg.subarray(4, msg.indexOf(0, 4)).toString("ascii");
  return `erreur TFTP ${code} : ${text}`;
}

/** Client TFTP par défaut sur node:dgram (mode octet). */
async function createDgramTftpClient(): Promise<TftpClient> {
  const dgram = await import("node:dgram");

  function run<T>(
    build: () => Buffer,
    handle: (
      socket: import("node:dgram").Socket,
      msg: Buffer,
      rinfo: { address: string; port: number },
      done: (result: T) => void,
      fail: (e: Error) => void
    ) => void,
    timeoutMs: number,
    host: string,
    port: number
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const socket = dgram.createSocket("udp4");
      let serverTid = 0;
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("timeout TFTP"));
      }, timeoutMs);
      const done = (r: T) => { clearTimeout(timer); socket.close(); resolve(r); };
      const fail = (e: Error) => { clearTimeout(timer); socket.close(); reject(e); };

      socket.on("error", fail);
      socket.on("message", (msg, rinfo) => {
        if (msg.readUInt16BE(0) === OP_ERROR) return fail(new Error(tftpError(msg)));
        if (serverTid === 0) serverTid = rinfo.port; // premier paquet = TID serveur
        handle(socket, msg, rinfo, done, fail);
      });
      socket.send(build(), port, host);
    });
  }

  return {
    download(opts) {
      const chunks: Buffer[] = [];
      let expected = 1;
      return run<Uint8Array>(
        () => requestPacket(OP_RRQ, opts.filename),
        (socket, msg, rinfo, done) => {
          if (msg.readUInt16BE(0) !== OP_DATA) return;
          const block = msg.readUInt16BE(2);
          if (block === expected) {
            const data = msg.subarray(4);
            chunks.push(data);
            socket.send(ackPacket(block), rinfo.port, rinfo.address);
            expected++;
            if (data.byteLength < BLOCK_SIZE) done(new Uint8Array(Buffer.concat(chunks)));
          }
        },
        opts.timeoutMs, opts.host, opts.port
      );
    },
    upload(data, opts) {
      const total = data.byteLength;
      // Nombre de blocs DATA, bloc terminal (0–511 octets) compris.
      const totalBlocks = Math.floor(total / BLOCK_SIZE) + 1;
      let lastSent = 0; // 0 = seul le WRQ a été envoyé
      return run<number>(
        () => requestPacket(OP_WRQ, opts.filename),
        (socket, msg, rinfo, done) => {
          if (msg.readUInt16BE(0) !== OP_ACK) return;
          const acked = msg.readUInt16BE(2);
          if (acked !== lastSent) return; // ignore doublons / désordre
          if (acked === totalBlocks) return done(total); // bloc terminal acquitté
          const nextBlock = acked + 1;
          const start = (nextBlock - 1) * BLOCK_SIZE;
          socket.send(dataPacket(nextBlock, data.subarray(start, start + BLOCK_SIZE)), rinfo.port, rinfo.address);
          lastSent = nextBlock;
        },
        opts.timeoutMs, opts.host, opts.port
      );
    },
  };
}
