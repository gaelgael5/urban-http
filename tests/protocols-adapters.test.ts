import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProtocolCommand } from "../src/protocols/parse.js";
import {
  executeProtocol,
  getProtocolAdapter,
  registeredSchemes,
  registerDefaultNodeAdapters,
  registerProtocol,
  unregisterProtocol,
} from "../src/protocols/index.js";
import { fileAdapter } from "../src/protocols/file.js";
import { smtpAdapter } from "../src/protocols/smtp.js";
import { ftpAdapter } from "../src/protocols/ftp.js";
import { sftpAdapter } from "../src/protocols/sftp.js";
import { pop3Adapter } from "../src/protocols/pop3.js";
import { mqttAdapter } from "../src/protocols/mqtt.js";
import { tftpAdapter } from "../src/protocols/tftp.js";
import { smbAdapter } from "../src/protocols/smb.js";

const dec = (b?: Uint8Array) => (b ? new TextDecoder().decode(b) : "");
const reqOf = (cmd: string) => {
  const r = parseProtocolCommand(cmd);
  if (!r.request) throw new Error("pas de requête: " + JSON.stringify(r.warnings));
  return r.request;
};

describe("registre", () => {
  afterEach(() => {
    for (const s of registeredSchemes()) unregisterProtocol(s);
  });

  it("registerDefaultNodeAdapters enregistre tous les schémas", () => {
    registerDefaultNodeAdapters();
    for (const s of ["file", "smtp", "ftp", "sftp", "pop3", "mqtt", "tftp", "smb"] as const) {
      expect(getProtocolAdapter(s)).toBeDefined();
    }
  });

  it("executeProtocol sans adaptateur : erreur explicite", async () => {
    await expect(executeProtocol(reqOf("curl ftp://e.com/f"))).rejects.toThrow(/Aucun adaptateur/);
  });
});

describe("FILE (bout en bout, vrai système de fichiers)", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "urban-file-")); });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("lit un fichier", async () => {
    const p = join(dir, "lu.txt");
    writeFileSync(p, "bonjour fichier");
    const res = await fileAdapter.execute(reqOf(`curl file://${p}`), {});
    expect(res.ok).toBe(true);
    expect(dec(res.body)).toBe("bonjour fichier");
  });

  it("écrit un fichier via -T avec contenu depuis readFile injecté", async () => {
    const out = join(dir, "ecrit.txt");
    const res = await fileAdapter.execute(reqOf(`curl -T src.txt file://${out}`), {
      readFile: () => "contenu téléversé",
    });
    expect(res.ok).toBe(true);
    expect(readFileSync(out, "utf8")).toBe("contenu téléversé");
  });

  it("plage -r sur un fichier", async () => {
    const p = join(dir, "plage.txt");
    writeFileSync(p, "0123456789");
    const r = reqOf(`curl -r 2-5 file://${p}`);
    const res = await fileAdapter.execute(r, {});
    expect(dec(res.body)).toBe("2345");
  });
});

describe("SMTP (transport simulé)", () => {
  it("envoie le message brut au bon enveloppe", async () => {
    let captured: { envelope: { from?: string; to: string[] }; raw: string | Uint8Array } | undefined;
    const res = await smtpAdapter.execute(
      reqOf("curl smtp://mail.e.com --mail-from moi@e.com --mail-rcpt toi@e.com -T message.txt"),
      {
        readFile: () => "Subject: Test\r\n\r\nCorps du message",
        clientFactory: () => ({
          async sendMail(msg) {
            captured = msg;
            return { accepted: msg.envelope.to, rejected: [], response: "250 OK", messageId: "<id@e.com>" };
          },
        }),
      }
    );
    expect(res.ok).toBe(true);
    expect(captured?.envelope).toEqual({ from: "moi@e.com", to: ["toi@e.com"] });
    expect(String(captured?.raw)).toContain("Corps du message");
    expect(res.summary).toBe("250 OK");
  });

  it("sans destinataire : rejet", async () => {
    await expect(smtpAdapter.execute(reqOf("curl smtp://mail.e.com --mail-from m@e.com"), {})).rejects.toThrow(/destinataire/);
  });
});

describe("FTP (client simulé)", () => {
  const mkClient = (calls: string[]) => () => ({
    async access() { calls.push("access"); },
    async list() { calls.push("list"); return [{ name: "a.txt" }, { name: "b.txt" }]; },
    async uploadFrom(_s: unknown, p: string) { calls.push("upload:" + p); },
    async downloadTo(dest: { end?: (b: Buffer) => void; write?: (b: Buffer) => void }, p: string) {
      calls.push("download:" + p);
      // le sink est un PassThrough : on y écrit des octets
      (dest as { write: (b: Buffer) => void; end: () => void }).write(Buffer.from("contenu distant"));
      (dest as { end: () => void }).end();
    },
    async send(cmd: string) { calls.push("quote:" + cmd); return { code: 200, message: "OK" }; },
    close() { calls.push("close"); },
  });

  it("téléchargement", async () => {
    const calls: string[] = [];
    const res = await ftpAdapter.execute(reqOf("curl ftp://e.com/pub/f.txt"), { clientFactory: mkClient(calls) });
    expect(dec(res.body)).toBe("contenu distant");
    expect(calls).toContain("download:/pub/f.txt");
    expect(calls).toContain("close");
  });

  it("listage -l", async () => {
    const res = await ftpAdapter.execute(reqOf("curl -l ftp://e.com/pub/"), { clientFactory: mkClient([]) });
    expect(dec(res.body)).toBe("a.txt\nb.txt");
  });

  it("quote -Q exécuté avant le transfert", async () => {
    const calls: string[] = [];
    await ftpAdapter.execute(reqOf(`curl -Q "DELE old" ftp://e.com/f`), { clientFactory: mkClient(calls) });
    expect(calls.indexOf("quote:DELE old")).toBeLessThan(calls.indexOf("download:/f"));
  });
});

describe("SFTP (client simulé)", () => {
  const client = (store: Record<string, string>) => () => ({
    async connect() {},
    async get(p: string) { return new TextEncoder().encode(store[p] ?? ""); },
    async put(data: Uint8Array, p: string) { store[p] = new TextDecoder().decode(data); },
    async list() { return Object.keys(store).map((filename) => ({ filename })); },
    end() {},
  });

  it("téléchargement et téléversement", async () => {
    const store: Record<string, string> = { "/remote/in.txt": "données" };
    const dl = await sftpAdapter.execute(reqOf("curl sftp://u@e.com/remote/in.txt"), { clientFactory: client(store) });
    expect(dec(dl.body)).toBe("données");

    await sftpAdapter.execute(reqOf("curl -T local.txt sftp://u@e.com/remote/out.txt"), {
      clientFactory: client(store),
      readFile: () => "à écrire",
    });
    expect(store["/remote/out.txt"]).toBe("à écrire");
  });
});

describe("POP3 (client simulé)", () => {
  const client = () => () => ({
    async connect() { return "+OK prêt"; },
    async login() { return "+OK connecté"; },
    async list() { return "+OK 2 messages\r\n1 500\r\n2 1200\r\n."; },
    async retrieve(n: number) { return `+OK\r\nSubject: msg ${n}\r\n\r\ncorps ${n}\r\n.`; },
    async quit() {},
  });

  it("liste les messages", async () => {
    const res = await pop3Adapter.execute(reqOf("curl pop3://u:p@mail.e.com/"), { clientFactory: client() });
    expect(dec(res.body)).toContain("1 500");
  });

  it("récupère un message précis", async () => {
    const res = await pop3Adapter.execute(reqOf("curl pop3://u:p@mail.e.com/2"), { clientFactory: client() });
    expect(dec(res.body)).toContain("corps 2");
    expect(res.meta.message).toBe(2);
  });
});

describe("MQTT (client simulé)", () => {
  it("publie un message", async () => {
    let published: { topic: string; payload: string; qos: number; retain: boolean } | undefined;
    const res = await mqttAdapter.execute(reqOf(`curl mqtt://courtier/capteurs/t -d "21.5" --qos 1 --retain`), {
      clientFactory: () => ({
        async connect() {},
        async publish(topic, payload, opts) {
          published = { topic, payload: new TextDecoder().decode(payload), qos: opts.qos, retain: opts.retain };
        },
        async subscribeOne() { return new Uint8Array(); },
        end() {},
      }),
    });
    expect(res.ok).toBe(true);
    expect(published).toEqual({ topic: "capteurs/t", payload: "21.5", qos: 1, retain: true });
  });

  it("s'abonne et lit le premier message", async () => {
    const res = await mqttAdapter.execute(reqOf("curl mqtt://courtier/capteurs/t"), {
      clientFactory: () => ({
        async connect() {},
        async publish() {},
        async subscribeOne() { return new TextEncoder().encode("22.1"); },
        end() {},
      }),
    });
    expect(dec(res.body)).toBe("22.1");
  });
});

describe("TFTP (client simulé)", () => {
  it("téléchargement et téléversement", async () => {
    const store: Record<string, Uint8Array> = { firmware: new TextEncoder().encode("binaire") };
    const factory = () => ({
      async download(opts: { filename: string }) { return store[opts.filename] ?? new Uint8Array(); },
      async upload(data: Uint8Array, opts: { filename: string }) { store[opts.filename] = data; return data.byteLength; },
    });
    const dl = await tftpAdapter.execute(reqOf("curl tftp://10.0.0.1/firmware"), { clientFactory: factory });
    expect(dec(dl.body)).toBe("binaire");

    const up = await tftpAdapter.execute(reqOf("curl -T cfg tftp://10.0.0.1/cfg"), {
      clientFactory: factory,
      readFile: () => "config",
    });
    expect(up.ok).toBe(true);
    expect(dec(store["cfg"])).toBe("config");
  });
});

describe("SMB (client simulé)", () => {
  const factory = (store: Record<string, string>) => () => ({
    async readFile(p: string) { return new TextEncoder().encode(store[p] ?? ""); },
    async writeFile(p: string, d: Uint8Array) { store[p] = new TextDecoder().decode(d); },
    async readdir() { return Object.keys(store); },
    disconnect() {},
  });

  it("lit un fichier d'un partage", async () => {
    // L'adaptateur passe le chemin au client injecté tel quel (séparateurs /) ;
    // la conversion en \ est l'affaire de la vraie fabrique @marsaud/smb2.
    const store = { "dossier/f.txt": "depuis smb" };
    const res = await smbAdapter.execute(reqOf("curl smb://serveur/partage/dossier/f.txt"), {
      clientFactory: factory(store),
    });
    expect(dec(res.body)).toBe("depuis smb");
    expect(res.meta.share).toBe("partage");
  });

  it("écrit un fichier via -T", async () => {
    const store: Record<string, string> = {};
    await smbAdapter.execute(reqOf("curl -T local.txt smb://serveur/partage/out.txt"), {
      clientFactory: factory(store),
      readFile: () => "contenu smb",
    });
    expect(store["out.txt"]).toBe("contenu smb");
  });
});
