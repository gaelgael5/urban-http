/**
 * Lecture des fichiers de cookies au format Netscape (celui de curl -b/-c),
 * avec filtrage domaine / chemin / expiration / secure comme le fait curl.
 */

export interface CookieEntry {
  domain: string;
  includeSubdomains: boolean;
  path: string;
  secure: boolean;
  /** Timestamp Unix en secondes ; 0 = cookie de session (toujours envoyé). */
  expires: number;
  name: string;
  value: string;
}

/**
 * Parse le contenu d'un fichier de cookies Netscape.
 * Les lignes "#HttpOnly_domaine<TAB>..." sont prises en compte ;
 * les autres commentaires et lignes vides sont ignorés.
 * Tolérance : une ligne sans tabulation de la forme "nom=valeur" est
 * acceptée comme cookie applicable à tous les domaines.
 */
export function parseNetscapeCookies(text: string): CookieEntry[] {
  const entries: CookieEntry[] = [];
  for (let line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const httpOnly = line.startsWith("#HttpOnly_");
    if (httpOnly) line = line.slice("#HttpOnly_".length);
    else if (line.startsWith("#")) continue;

    const fields = line.split("\t");
    if (fields.length >= 7) {
      const [domain, flag, path, secure, expires, name, ...valueParts] = fields;
      entries.push({
        domain: (domain ?? "").replace(/^\./, ""),
        includeSubdomains: (domain ?? "").startsWith(".") || (flag ?? "").toUpperCase() === "TRUE",
        path: path || "/",
        secure: (secure ?? "").toUpperCase() === "TRUE",
        expires: parseInt(expires ?? "0", 10) || 0,
        name: name ?? "",
        value: valueParts.join("\t"),
      });
    } else if (fields.length === 1 && line.includes("=") && !line.includes(" ")) {
      const eq = line.indexOf("=");
      entries.push({
        domain: "",
        includeSubdomains: true,
        path: "/",
        secure: false,
        expires: 0,
        name: line.slice(0, eq),
        value: line.slice(eq + 1),
      });
    }
  }
  return entries;
}

/** Sélectionne les cookies applicables à une URL, au format "nom=valeur; ...". */
export function cookiesForUrl(entries: CookieEntry[], url: string, now: number = Date.now()): string {
  let host = "";
  let path = "/";
  let isHttps = false;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname || "/";
    isHttps = u.protocol === "https:";
  } catch {
    return "";
  }

  const selected: string[] = [];
  for (const e of entries) {
    if (e.expires !== 0 && e.expires * 1000 < now) continue;
    if (e.secure && !isHttps) continue;
    if (e.domain) {
      const domain = e.domain.toLowerCase();
      const matches = host === domain || (e.includeSubdomains && host.endsWith("." + domain));
      if (!matches) continue;
    }
    if (e.path && e.path !== "/") {
      if (!(path === e.path || path.startsWith(e.path.endsWith("/") ? e.path : e.path + "/"))) continue;
    }
    if (e.name) selected.push(`${e.name}=${e.value}`);
  }
  return selected.join("; ");
}
