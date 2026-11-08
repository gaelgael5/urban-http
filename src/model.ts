/**
 * Modèle de données : le résultat du parsing d'une commande curl,
 * indépendant de l'environnement d'exécution (Node ou navigateur).
 */

/** Niveau d'un avertissement émis pendant le parsing. */
export type WarningLevel = "info" | "warning" | "error";

export interface ParseWarning {
  /** Code stable, utilisable par programme (ex: "unsupported-option"). */
  code: string;
  /** L'option curl concernée, si applicable (ex: "--proxy"). */
  option?: string;
  /** Message lisible, en français. */
  message: string;
  level: WarningLevel;
}

/** Un fragment de données fourni par -d / --data-* (il peut y en avoir plusieurs). */
export interface DataItem {
  mode: "data" | "raw" | "binary" | "urlencode";
  /** Valeur littérale (absente si le fragment vient d'un fichier). */
  value?: string;
  /** Nom du champ pour --data-urlencode "name=..." ou "name@file". */
  name?: string;
  /** Référence de fichier pour "@fichier" (résolue au moment de l'exécution). */
  filePath?: string;
}

/** Un champ multipart fourni par -F / --form. */
export interface FormField {
  name: string;
  /** Valeur littérale (champ texte). */
  value?: string;
  /** "@fichier" : pièce jointe. */
  filePath?: string;
  /** "<fichier" : contenu du fichier envoyé comme champ texte. */
  contentFromFile?: string;
  /** Attribut ;type=... */
  contentType?: string;
  /** Attribut ;filename=... */
  fileName?: string;
}

export type BodyKind = "raw" | "urlencoded" | "multipart" | "file";

export interface BodySpec {
  kind: BodyKind;
  /**
   * Corps textuel déjà résolu, quand aucun fichier n'est référencé.
   * Pour kind="urlencoded" c'est la chaîne encodée finale.
   */
  text?: string;
  /** Fragments -d bruts (présents quand des fichiers sont référencés). */
  items?: DataItem[];
  /** Champs multipart pour kind="multipart". */
  parts?: FormField[];
  /** Fichier à envoyer tel quel pour kind="file" (-T / --upload-file). */
  filePath?: string;
}

export interface AuthSpec {
  kind: "basic" | "bearer" | "digest" | "ntlm" | "negotiate" | "aws-sigv4";
  username?: string;
  password?: string;
  token?: string;
}

export interface RequestOptions {
  /** -L / --location : suivre les redirections (curl ne les suit pas par défaut). */
  followRedirects: boolean;
  /** --max-redirs */
  maxRedirs?: number;
  /** -k / --insecure */
  insecure: boolean;
  /** --compressed */
  compressed: boolean;
  /** -m / --max-time, converti en millisecondes. */
  timeoutMs?: number;
  /** --connect-timeout, converti en millisecondes (approximé au timeout global). */
  connectTimeoutMs?: number;
  /** --retry */
  retry?: number;
  /** --retry-delay, en millisecondes. */
  retryDelayMs?: number;
  /** -x / --proxy (appliqué côté Node via undici.ProxyAgent). */
  proxy?: string;
  /** -U / --proxy-user "user:pass" (Basic sur le proxy, côté Node). */
  proxyUser?: string;
  /** --http1.1 / --http2 / --http3 (informatif). */
  httpVersion?: string;
}

/** Une requête HTTP prête à être transformée en appel fetch. */
export interface HttpRequestModel {
  /** Nom de la requête (renseigné par l'import Postman). */
  name?: string;
  method: string;
  /** URL complète, query string incluse. */
  url: string;
  /** Paires de query string ajoutées par -G à partir des -d. */
  query: Array<[string, string]>;
  /** En-têtes dans l'ordre de la ligne de commande. */
  headers: Array<[string, string]>;
  body?: BodySpec;
  auth?: AuthSpec;
  /** Fichiers de cookies (-b fichier), lus au moment de l'exécution (format Netscape). */
  cookieFiles?: string[];
  options: RequestOptions;
  /** Avertissements propres à cette requête. */
  warnings: ParseWarning[];
}

/** Résultat complet du parsing d'une commande (une commande peut produire plusieurs requêtes). */
export interface ParseResult {
  requests: HttpRequestModel[];
  /** Avertissements globaux (options inconnues, etc.). */
  warnings: ParseWarning[];
}

/** Lecteur de fichier injectable, pour résoudre les références "@fichier". */
export type FileReader = (path: string) => Uint8Array | string;

export function defaultOptions(): RequestOptions {
  return {
    followRedirects: false,
    insecure: false,
    compressed: false,
  };
}
