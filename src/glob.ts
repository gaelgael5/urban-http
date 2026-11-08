/**
 * Globbing d'URL façon curl :
 *   {a,b,c}         alternatives
 *   [1-10]          plage numérique (avec zéro-padding si [01-10])
 *   [1-10:2]        plage avec pas
 *   [a-z] / [a-z:3] plage alphabétique
 *
 * Les motifs se combinent en produit cartésien, comme curl.
 */

export class GlobError extends Error {}

/** Nombre maximal d'URLs générées par une expansion (garde-fou du SDK). */
export const GLOB_LIMIT = 500;

/** Développe les motifs de globbing d'une URL. Lève GlobError si le motif est invalide ou trop large. */
export function expandCurlGlobs(url: string, limit: number = GLOB_LIMIT): string[] {
  // Chaque segment est soit un littéral, soit une liste d'alternatives
  const segments: string[][] = [];
  let literal = "";
  let i = 0;

  const flushLiteral = () => {
    if (literal) {
      segments.push([literal]);
      literal = "";
    }
  };

  while (i < url.length) {
    const c = url[i]!;
    if (c === "{") {
      const end = url.indexOf("}", i + 1);
      if (end === -1) throw new GlobError(`accolade "{" non fermée dans l'URL`);
      flushLiteral();
      segments.push(url.slice(i + 1, end).split(","));
      i = end + 1;
    } else if (c === "[") {
      const end = url.indexOf("]", i + 1);
      if (end === -1) throw new GlobError(`crochet "[" non fermé dans l'URL`);
      flushLiteral();
      segments.push(expandRange(url.slice(i + 1, end)));
      i = end + 1;
    } else if (c === "}" || c === "]") {
      throw new GlobError(`"${c}" sans ouvrant correspondant dans l'URL`);
    } else {
      literal += c;
      i++;
    }
  }
  flushLiteral();

  // Taille du produit cartésien
  let total = 1;
  for (const seg of segments) total *= seg.length;
  if (total > limit) {
    throw new GlobError(`le globbing produirait ${total} URLs (limite du SDK : ${limit})`);
  }

  let results = [""];
  for (const seg of segments) {
    const next: string[] = [];
    for (const prefix of results) for (const choice of seg) next.push(prefix + choice);
    results = next;
  }
  return results;
}

function expandRange(spec: string): string[] {
  const numeric = /^(\d+)-(\d+)(?::(\d+))?$/.exec(spec);
  if (numeric) {
    const [, startStr, endStr, stepStr] = numeric;
    const start = parseInt(startStr!, 10);
    const end = parseInt(endStr!, 10);
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    if (step <= 0 || end < start) throw new GlobError(`plage numérique invalide : [${spec}]`);
    const width = startStr!.startsWith("0") ? startStr!.length : 0;
    const out: string[] = [];
    for (let v = start; v <= end; v += step) {
      out.push(width > 0 ? String(v).padStart(width, "0") : String(v));
    }
    return out;
  }

  const alpha = /^([a-zA-Z])-([a-zA-Z])(?::(\d+))?$/.exec(spec);
  if (alpha) {
    const start = alpha[1]!.charCodeAt(0);
    const end = alpha[2]!.charCodeAt(0);
    const step = alpha[3] ? parseInt(alpha[3], 10) : 1;
    if (step <= 0 || end < start) throw new GlobError(`plage alphabétique invalide : [${spec}]`);
    const out: string[] = [];
    for (let v = start; v <= end; v += step) out.push(String.fromCharCode(v));
    return out;
  }

  throw new GlobError(`plage invalide : [${spec}] (attendu [1-10], [01-10], [a-z], avec :pas optionnel)`);
}
