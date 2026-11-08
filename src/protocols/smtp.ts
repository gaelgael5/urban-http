/**
 * Adaptateur SMTP / SMTPS : envoi d'un mail, comme
 * `curl smtp://serveur --mail-from a@x --mail-rcpt b@y -T message.txt`.
 *
 * S'appuie sur nodemailer (dépendance optionnelle). Le message (-T / -d) est
 * envoyé tel quel comme source brute RFC 822. Une fabrique de transport peut
 * être injectée via ctx.clientFactory pour les tests.
 */
import { ProtocolAdapter, ProtocolContext, ProtocolRequest, ProtocolResult } from "./types.js";

/** Ce que l'adaptateur attend d'un transport mail (sous-ensemble de nodemailer). */
export interface MailTransport {
  sendMail(message: {
    envelope: { from?: string; to: string[] };
    raw: string | Uint8Array;
  }): Promise<{ accepted?: string[]; rejected?: string[]; response?: string; messageId?: string }>;
}

export type MailTransportFactory = (req: ProtocolRequest) => MailTransport | Promise<MailTransport>;

async function defaultFactory(req: ProtocolRequest): Promise<MailTransport> {
  const moduleName = "nodemailer";
  const nodemailer = (await import(/* @vite-ignore */ moduleName)) as {
    createTransport(opts: unknown): MailTransport;
  };
  return nodemailer.createTransport({
    host: req.host,
    port: req.port,
    secure: req.secure, // smtps / port 465
    requireTLS: req.tlsOpportunistic, // --ssl-reqd / --ssl → STARTTLS
    auth: req.username ? { user: req.username, pass: req.password ?? "" } : undefined,
    tls: req.insecure ? { rejectUnauthorized: false } : undefined,
    connectionTimeout: req.connectTimeoutMs ?? req.timeoutMs,
  });
}

async function readPayload(req: ProtocolRequest, ctx: ProtocolContext): Promise<string | Uint8Array> {
  if (!req.payload) return "";
  if (req.payload.filePath) {
    if (!ctx.readFile) {
      const fs = await import("node:fs/promises");
      return new Uint8Array(await fs.readFile(req.payload.filePath));
    }
    return ctx.readFile(req.payload.filePath);
  }
  return req.payload.text ?? "";
}

export const smtpAdapter: ProtocolAdapter = {
  name: "smtp",
  schemes: ["smtp", "smtps"],

  async execute(req: ProtocolRequest, ctx: ProtocolContext): Promise<ProtocolResult> {
    const issues: string[] = [];
    const recipients = req.smtp?.recipients ?? [];
    if (recipients.length === 0) {
      throw new Error("SMTP : aucun destinataire (--mail-rcpt) fourni.");
    }

    const raw = await readPayload(req, ctx);
    if (!raw || (typeof raw === "string" && raw.trim() === "")) {
      issues.push("Corps du mail vide : fournissez -T message.txt ou -d.");
    }

    const factory = (ctx.clientFactory as MailTransportFactory | undefined) ?? defaultFactory;
    const transport = await factory(req);

    const info = await transport.sendMail({
      envelope: { from: req.smtp?.from, to: recipients },
      raw,
    });

    const rejected = info.rejected ?? [];
    if (rejected.length > 0 && !req.smtp?.allowRcptFailures) {
      issues.push(`Destinataires rejetés : ${rejected.join(", ")}`);
    }

    return {
      scheme: req.scheme,
      ok: rejected.length === 0 || !!req.smtp?.allowRcptFailures,
      summary: info.response ?? `Mail envoyé à ${(info.accepted ?? recipients).join(", ")}`,
      meta: {
        from: req.smtp?.from,
        accepted: info.accepted ?? recipients,
        rejected,
        messageId: info.messageId,
      },
      issues,
    };
  },
};
