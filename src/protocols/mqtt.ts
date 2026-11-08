/**
 * Adaptateur MQTT / MQTTS : publier un message (mqtt://courtier/topic -d "...")
 * ou s'abonner et lire le premier message reçu (mqtt://courtier/topic), comme
 * curl. S'appuie sur mqtt.js (dépendance optionnelle). Un client peut être
 * injecté via ctx.clientFactory pour les tests.
 */
import { ProtocolAdapter, ProtocolContext, ProtocolRequest, ProtocolResult } from "./types.js";

/** Client MQTT minimal attendu par l'adaptateur. */
export interface MqttClient {
  connect(opts: {
    url: string;
    username?: string;
    password?: string;
    rejectUnauthorized?: boolean;
    connectTimeoutMs?: number;
  }): Promise<void>;
  publish(topic: string, payload: Uint8Array, opts: { qos: number; retain: boolean }): Promise<void>;
  /** S'abonne et résout au premier message, ou rejette au timeout. */
  subscribeOne(topic: string, qos: number, timeoutMs: number): Promise<Uint8Array>;
  end(): void;
}

export type MqttClientFactory = () => MqttClient | Promise<MqttClient>;

async function defaultFactory(): Promise<MqttClient> {
  const moduleName = "mqtt";
  const mqtt = (await import(/* @vite-ignore */ moduleName)) as {
    connect(url: string, opts: unknown): MqttJsClient;
  };
  let client: MqttJsClient;

  return {
    connect(opts) {
      return new Promise<void>((resolve, reject) => {
        client = mqtt.connect(opts.url, {
          username: opts.username,
          password: opts.password,
          rejectUnauthorized: opts.rejectUnauthorized,
          connectTimeout: opts.connectTimeoutMs ?? 30000,
        });
        client.on("connect", () => resolve());
        client.on("error", reject);
      });
    },
    publish(topic, payload, opts) {
      return new Promise<void>((resolve, reject) => {
        client.publish(topic, Buffer.from(payload), opts, (err?: Error) => (err ? reject(err) : resolve()));
      });
    },
    subscribeOne(topic, qos, timeoutMs) {
      return new Promise<Uint8Array>((resolve, reject) => {
        const timer = timeoutMs
          ? setTimeout(() => reject(new Error(`Aucun message MQTT reçu sur "${topic}" dans le délai imparti.`)), timeoutMs)
          : undefined;
        client.on("message", (_t: string, payload: Buffer) => {
          if (timer) clearTimeout(timer);
          resolve(new Uint8Array(payload));
        });
        client.subscribe(topic, { qos }, (err?: Error) => {
          if (err) {
            if (timer) clearTimeout(timer);
            reject(err);
          }
        });
      });
    },
    end() {
      client?.end();
    },
  };
}

export const mqttAdapter: ProtocolAdapter = {
  name: "mqtt",
  schemes: ["mqtt", "mqtts"],

  async execute(req: ProtocolRequest, ctx: ProtocolContext): Promise<ProtocolResult> {
    const issues: string[] = [];
    const topic = req.path.replace(/^\//, "");
    if (!topic) throw new Error("MQTT : aucun topic dans l'URL (mqtt://courtier/mon/topic).");

    const factory = (ctx.clientFactory as MqttClientFactory | undefined) ?? defaultFactory;
    const client = await factory();

    try {
      await client.connect({
        url: `${req.scheme}://${req.host}:${req.port}`,
        username: req.username,
        password: req.password,
        rejectUnauthorized: !req.insecure,
        connectTimeoutMs: req.connectTimeoutMs ?? req.timeoutMs,
      });

      if (req.direction === "publish") {
        const payload = req.payload?.text ? new TextEncoder().encode(req.payload.text) : new Uint8Array();
        await client.publish(topic, payload, { qos: req.mqtt?.qos ?? 0, retain: req.mqtt?.retain ?? false });
        return {
          scheme: req.scheme, ok: true,
          summary: `Message publié sur "${topic}" (${payload.byteLength} octets)`,
          meta: { topic, bytes: payload.byteLength, qos: req.mqtt?.qos ?? 0, retain: req.mqtt?.retain ?? false },
          issues,
        };
      }

      // subscribe : lire le premier message (curl lit en continu ; le SDK en lit un)
      issues.push("Abonnement : le SDK lit le premier message reçu puis se déconnecte.");
      const body = await client.subscribeOne(topic, req.mqtt?.qos ?? 0, req.timeoutMs ?? 30000);
      if (req.output && req.output !== "-" && ctx.writeFile) await ctx.writeFile(req.output, body);
      return {
        scheme: req.scheme, ok: true,
        summary: `Message reçu sur "${topic}" (${body.byteLength} octets)`,
        body, meta: { topic, bytes: body.byteLength }, issues,
      };
    } finally {
      client.end();
    }
  },
};

/* Type interne minimal de mqtt.js. */
interface MqttJsClient {
  on(event: "connect" | "error" | "message", cb: (...args: never[]) => void): void;
  publish(topic: string, payload: Buffer, opts: unknown, cb: (err?: Error) => void): void;
  subscribe(topic: string, opts: unknown, cb: (err?: Error) => void): void;
  end(): void;
}
