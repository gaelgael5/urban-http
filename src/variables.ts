/**
 * Gestion des variables, partagée entre parseCurl et parsePostman :
 * - placeholders {{nom}} (syntaxe Postman)
 * - variables dynamiques {{$guid}}, {{$timestamp}}, {{$isoTimestamp}},
 *   {{$randomInt}}, {{$randomUUID}} (générées à chaque occurrence, comme Postman)
 * - import d'un export d'environnement Postman
 *
 * Une variable non résolue est laissée telle quelle et signalée par un warning,
 * jamais remplacée par du vide.
 */
import { ParseWarning } from "./model.js";

export interface VariableContext {
  values: Map<string, string>;
  /** Noms {{...}} rencontrés sans valeur. */
  unresolved: Set<string>;
  /** Variables dynamiques {{$...}} non prises en charge. */
  unsupportedDynamic: Set<string>;
}

/**
 * Crée un contexte de substitution. Les sources sont appliquées dans l'ordre :
 * les dernières sont prioritaires (ex: variables de collection, puis d'environnement).
 */
export function createVariableContext(
  ...sources: Array<Record<string, string> | Map<string, string> | undefined>
): VariableContext {
  const values = new Map<string, string>();
  for (const source of sources) {
    if (!source) continue;
    const entries = source instanceof Map ? source.entries() : Object.entries(source);
    for (const [k, v] of entries) values.set(k, v);
  }
  return { values, unresolved: new Set(), unsupportedDynamic: new Set() };
}

/** Remplace les {{...}} d'une chaîne à partir du contexte. */
export function substitutePlaceholders(s: string, ctx: VariableContext): string {
  return s.replace(/\{\{([^{}]+)\}\}/g, (whole, name: string) => {
    if (name.startsWith("$")) {
      const generated = dynamicValue(name);
      if (generated !== undefined) return generated;
      ctx.unsupportedDynamic.add(name);
      return whole;
    }
    if (ctx.values.has(name)) return ctx.values.get(name)!;
    ctx.unresolved.add(name);
    return whole;
  });
}

/** Les warnings à émettre pour ce qui n'a pas pu être résolu. */
export function variableWarnings(ctx: VariableContext): ParseWarning[] {
  const warnings: ParseWarning[] = [];
  for (const name of ctx.unresolved) {
    warnings.push({
      code: "unresolved-variable",
      message: `Variable {{${name}}} non résolue : passez sa valeur via options.variables.`,
      level: "warning",
    });
  }
  for (const name of ctx.unsupportedDynamic) {
    warnings.push({
      code: "unsupported-dynamic-variable",
      message: `Variable dynamique {{${name}}} non prise en charge (supportées : $guid, $randomUUID, $timestamp, $isoTimestamp, $randomInt).`,
      level: "warning",
    });
  }
  return warnings;
}

function dynamicValue(name: string): string | undefined {
  switch (name) {
    case "$guid":
    case "$randomUUID":
      return randomUUID();
    case "$timestamp":
      return String(Math.floor(Date.now() / 1000));
    case "$isoTimestamp":
      return new Date().toISOString();
    case "$randomInt":
      return String(Math.floor(Math.random() * 1001));
    default:
      return undefined;
  }
}

function randomUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Repli : UUID v4 à partir de getRandomValues / Math.random
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Lit un export d'environnement Postman ({ values: [{key, value, enabled}] })
 * et le transforme en Record utilisable dans options.variables.
 * Tolérance : un objet { clé: valeur } est renvoyé tel quel.
 */
export function parsePostmanEnvironment(input: string | unknown): Record<string, string> {
  const obj = (typeof input === "string" ? JSON.parse(input) : input) as {
    values?: Array<{ key?: string; value?: unknown; enabled?: boolean }>;
  } | null;
  const out: Record<string, string> = {};
  if (!obj || typeof obj !== "object") return out;

  if (Array.isArray(obj.values)) {
    for (const v of obj.values) {
      if (!v || v.key === undefined || v.enabled === false) continue;
      out[v.key] = v.value === undefined || v.value === null ? "" : String(v.value);
    }
    return out;
  }

  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
