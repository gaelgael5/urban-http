/**
 * Modèle et interfaces pour les protocoles non-HTTP de curl.
 *
 * Tout ce module est volontairement compartimenté : le cœur HTTP du SDK
 * (parseCurl / toFetch / execute) ne dépend de rien d'ici. Chaque protocole
 * est un adaptateur optionnel, chargé à la demande côté Node, qui s'appuie
 * sur une bibliothèque éprouvée (nodemailer, basic-ftp, ssh2, mqtt.js…).
 *
 * Comme pour le reste du SDK, une requête est toujours PILOTÉE PAR LA COMMANDE
 * que l'utilisateur écrit : un adaptateur exécute une seule opération explicite
 * (envoyer ce mail, téléverser ce fichier, publier ce message), jamais de
 * découverte, de balayage ni d'itération implicite.
 */
import { ParseWarning } from "../model.js";

/** Les schémas non-HTTP pris en charge par les adaptateurs de référence. */
export type ProtocolScheme =
  | "smtp"
  | "smtps"
  | "ftp"
  | "ftps"
  | "sftp"
  | "pop3"
  | "pop3s"
  | "mqtt"
  | "mqtts"
  | "tftp"
  | "file"
  | "smb"
  | "smbs";

/** Sens du transfert déduit de la commande. */
export type TransferDirection =
  | "download" // récupérer (défaut)
  | "upload" // -T / --upload-file
  | "send" // SMTP : envoyer un mail
  | "list" // -l / --list-only
  | "publish" // MQTT : publier
  | "subscribe"; // MQTT : s'abonner (une lecture)

/** Référence à une charge utile : littérale, ou fichier résolu à l'exécution. */
export interface Payload {
  /** Contenu littéral (ex: -d "..."). */
  text?: string;
  /** Référence "@fichier" ou -T fichier, lue par le contexte d'exécution. */
  filePath?: string;
}

/**
 * Requête protocolaire structurée, produite par parseProtocolCommand.
 * Indépendante de la bibliothèque qui l'exécutera.
 */
export interface ProtocolRequest {
  scheme: ProtocolScheme;
  /** URL complète telle qu'écrite. */
  url: string;
  host: string;
  /** Port explicite, sinon le port par défaut du protocole. */
  port: number;
  /** Chemin après l'hôte (fichier FTP, topic MQTT, dossier POP3…). */
  path: string;
  direction: TransferDirection;

  username?: string;
  password?: string;

  /** TLS requis (schéma sécurisé, ou --ssl-reqd). */
  secure: boolean;
  /** TLS opportuniste (--ssl / STARTTLS si disponible). */
  tlsOpportunistic: boolean;
  /** -k / --insecure : ne pas vérifier le certificat. */
  insecure: boolean;

  /** Charge à envoyer (-T, -d, corps du mail…). */
  payload?: Payload;
  /** -o / --output : où écrire ce qui est récupéré. */
  output?: string;

  /** -m / --max-time, en millisecondes. */
  timeoutMs?: number;
  /** --connect-timeout, en millisecondes. */
  connectTimeoutMs?: number;

  /** Plage d'octets (-r/--range) pour un téléchargement partiel. */
  range?: string;

  /** Options spécifiques au protocole. */
  smtp?: {
    from?: string;
    recipients: string[];
    allowRcptFailures: boolean;
  };
  ftp?: {
    /** -Q / --quote : commandes brutes envoyées au serveur. */
    quote: string[];
    createDirs: boolean;
    /** -l / --list-only : ne lister que les noms. */
    listOnly: boolean;
  };
  mqtt?: {
    /** Niveau de qualité de service (par défaut 0). */
    qos: number;
    retain: boolean;
  };

  warnings: ParseWarning[];
}

/** Résultat normalisé d'une exécution protocolaire. */
export interface ProtocolResult {
  scheme: ProtocolScheme;
  /** true si l'opération a réussi côté serveur. */
  ok: boolean;
  /** Résumé lisible (ex: "250 message accepté", "226 transfert terminé"). */
  summary: string;
  /** Corps récupéré pour un download (fichier, message, liste…). */
  body?: Uint8Array;
  /** Métadonnées propres au protocole (taille, identifiants, codes serveur…). */
  meta: Record<string, unknown>;
  /** Problèmes non bloquants (fichier non résolu, option ignorée…). */
  issues: string[];
}

/** Lit/écrit des fichiers locaux ; injectable (tests, navigateur restreint). */
export interface ProtocolIO {
  readFile?: (path: string) => Uint8Array | string | Promise<Uint8Array | string>;
  writeFile?: (path: string, data: Uint8Array) => void | Promise<void>;
}

/**
 * Contexte d'exécution passé à un adaptateur.
 * `clientFactory` permet d'injecter un client simulé (tests) à la place de
 * la vraie bibliothèque réseau.
 */
export interface ProtocolContext extends ProtocolIO {
  /** Remplace la fabrique de client de l'adaptateur (tests, implémentation maison). */
  clientFactory?: unknown;
  /** Signal d'annulation (dérivé du timeout si absent). */
  signal?: AbortSignal;
}

/** Un adaptateur sait exécuter un ou plusieurs schémas. */
export interface ProtocolAdapter {
  /** Nom court (pour les messages). */
  name: string;
  /** Schémas gérés (ex: ["ftp", "ftps"]). */
  schemes: ProtocolScheme[];
  /** Exécute la requête. Doit rejeter sur échec réseau définitif. */
  execute(req: ProtocolRequest, ctx: ProtocolContext): Promise<ProtocolResult>;
}

/** Port par défaut de chaque schéma. */
export const DEFAULT_PORTS: Record<ProtocolScheme, number> = {
  smtp: 25,
  smtps: 465,
  ftp: 21,
  ftps: 990,
  sftp: 22,
  pop3: 110,
  pop3s: 995,
  mqtt: 1883,
  mqtts: 8883,
  tftp: 69,
  file: 0,
  smb: 445,
  smbs: 445,
};

/** true si le schéma implique TLS d'emblée. */
export function isSecureScheme(scheme: ProtocolScheme): boolean {
  return scheme === "smtps" || scheme === "ftps" || scheme === "pop3s" || scheme === "mqtts" || scheme === "smbs";
}
