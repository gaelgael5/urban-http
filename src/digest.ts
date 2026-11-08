/**
 * Authentification HTTP Digest (RFC 2617 / RFC 7616) :
 * parsing du challenge WWW-Authenticate et construction
 * de l'en-tête Authorization en réponse.
 *
 * Algorithmes pris en charge : MD5, MD5-sess, SHA-256, SHA-256-sess,
 * avec qop="auth" ou sans qop (mode RFC 2069). qop="auth-int" n'est
 * pas pris en charge (nécessite le hachage du corps).
 */

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
  stale?: boolean;
}

export interface DigestCredentials {
  username: string;
  password: string;
}

/**
 * Extrait le challenge Digest d'un en-tête WWW-Authenticate
 * (qui peut contenir plusieurs schémas, ex: "Basic ..., Digest ...").
 */
export function parseDigestChallenge(header: string): DigestChallenge | undefined {
  const idx = header.search(/(^|[,\s])digest\s/i);
  if (idx === -1) return undefined;
  const rest = header.slice(header.toLowerCase().indexOf("digest", idx) + "digest".length);

  const params: Record<string, string> = {};
  // k="valeur avec, virgules" | k=valeur
  const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    const key = m[1]!.toLowerCase();
    const value = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : (m[3] ?? "");
    // Un nouveau schéma commence (ex: "Basic realm=...") : on s'arrête au premier token sans '='
    params[key] = value;
  }

  if (!params["realm"] && !params["nonce"]) return undefined;
  return {
    realm: params["realm"] ?? "",
    nonce: params["nonce"] ?? "",
    qop: params["qop"],
    opaque: params["opaque"],
    algorithm: params["algorithm"],
    stale: params["stale"]?.toLowerCase() === "true",
  };
}

export interface DigestOptions {
  /** Client nonce : généré aléatoirement par défaut (injectable pour les tests). */
  cnonce?: string;
  /** Compteur de nonce, "00000001" par défaut. */
  nc?: string;
}

/**
 * Construit la valeur de l'en-tête Authorization en réponse au challenge.
 * Renvoie undefined si l'algorithme ou le qop n'est pas pris en charge.
 */
export async function buildDigestAuthorization(
  challenge: DigestChallenge,
  creds: DigestCredentials,
  method: string,
  uri: string,
  opts: DigestOptions = {}
): Promise<string | undefined> {
  const algorithm = (challenge.algorithm ?? "MD5").toUpperCase();
  const sess = algorithm.endsWith("-SESS");
  const base = sess ? algorithm.slice(0, -5) : algorithm;

  let hash: (s: string) => Promise<string>;
  if (base === "MD5") hash = async (s) => md5Hex(s);
  else if (base === "SHA-256") hash = sha256Hex;
  else return undefined;

  // Choix du qop : "auth" si proposé ; auth-int non pris en charge
  let qop: string | undefined;
  if (challenge.qop) {
    const offered = challenge.qop.split(",").map((q) => q.trim().toLowerCase());
    if (offered.includes("auth")) qop = "auth";
    else return undefined;
  }

  const cnonce = opts.cnonce ?? randomCnonce();
  const nc = opts.nc ?? "00000001";

  let ha1 = await hash(`${creds.username}:${challenge.realm}:${creds.password}`);
  if (sess) ha1 = await hash(`${ha1}:${challenge.nonce}:${cnonce}`);
  const ha2 = await hash(`${method.toUpperCase()}:${uri}`);

  const response = qop
    ? await hash(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : await hash(`${ha1}:${challenge.nonce}:${ha2}`);

  const parts = [
    `username="${escapeQuoted(creds.username)}"`,
    `realm="${escapeQuoted(challenge.realm)}"`,
    `nonce="${escapeQuoted(challenge.nonce)}"`,
    `uri="${uri}"`,
  ];
  if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`);
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  parts.push(`response="${response}"`);
  if (challenge.opaque) parts.push(`opaque="${escapeQuoted(challenge.opaque)}"`);

  return `Digest ${parts.join(", ")}`;
}

function escapeQuoted(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function randomCnonce(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return toHex(bytes);
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/* ------------------------------------------------------------------ */
/* SHA-256 : via WebCrypto (navigateurs et Node >= 18)                  */
/* ------------------------------------------------------------------ */

async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(digest));
}

/* ------------------------------------------------------------------ */
/* MD5 : implémentation pure (WebCrypto ne fournit pas MD5)             */
/* Suit le pseudo-code de la RFC 1321 ; les constantes T sont générées  */
/* par leur définition mathématique (T[i] = floor(|sin(i+1)| * 2^32)).  */
/* ------------------------------------------------------------------ */

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);

export function md5Hex(input: string): string {
  const msg = new TextEncoder().encode(input);
  const bitLen = msg.length * 8;

  // Padding : 0x80 puis des zéros jusqu'à 56 mod 64, puis la longueur sur 64 bits little-endian
  const padded = new Uint8Array((((msg.length + 8) >> 6) + 1) << 6);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLen >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLen / 2 ** 32), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);

  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(block + i * 4, true);

    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      const tmp = D;
      D = C;
      C = B;
      const sum = (A + F + MD5_K[i]! + M[g]!) | 0;
      const s = MD5_S[i]!;
      B = (B + ((sum << s) | (sum >>> (32 - s)))) | 0;
      A = tmp;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0 >>> 0, true);
  outView.setUint32(4, b0 >>> 0, true);
  outView.setUint32(8, c0 >>> 0, true);
  outView.setUint32(12, d0 >>> 0, true);
  return toHex(out);
}
