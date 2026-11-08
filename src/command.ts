/**
 * Point d'entrée unifié : parser une commande curl quel que soit son protocole,
 * et l'exécuter via le bon moteur (fetch pour HTTP, adaptateur pour le reste).
 */
import { parseCurl, CurlParseOptions } from "./parse.js";
import { HttpRequestModel, ParseWarning } from "./model.js";
import { execute, ExecuteOptions, ExecuteResult } from "./execute.js";
import { parseProtocolCommand } from "./protocols/parse.js";
import { executeProtocol } from "./protocols/registry.js";
import { ProtocolContext, ProtocolRequest, ProtocolResult } from "./protocols/types.js";

export type ParsedCommand =
  | { kind: "http"; requests: HttpRequestModel[]; warnings: ParseWarning[] }
  | { kind: "protocol"; scheme: string; request?: ProtocolRequest; warnings: ParseWarning[] };

/**
 * Parse une commande curl de n'importe quel protocole.
 * - http/https → { kind: "http", requests } (comme parseCurl)
 * - smtp, ftp, sftp, pop3, mqtt, tftp, file, smb → { kind: "protocol", request }
 */
export function parseCommand(command: string, options: CurlParseOptions = {}): ParsedCommand {
  const probe = parseProtocolCommand(command, options);
  if (probe.isHttp) {
    const { requests, warnings } = parseCurl(command, options);
    return { kind: "http", requests, warnings };
  }
  return { kind: "protocol", scheme: probe.scheme, request: probe.request, warnings: probe.warnings };
}

export type RunResult =
  | { kind: "http"; result: ExecuteResult }
  | { kind: "protocol"; result: ProtocolResult };

/** Options d'exécution, valables pour HTTP comme pour les autres protocoles. */
export type RunOptions = ExecuteOptions & ProtocolContext & CurlParseOptions;

/**
 * Parse et exécute une commande. Pour un protocole non-HTTP, l'adaptateur
 * correspondant doit avoir été enregistré (registerDefaultNodeAdapters()).
 */
export async function run(command: string, options: RunOptions = {}): Promise<RunResult> {
  const parsed = parseCommand(command, options);
  if (parsed.kind === "http") {
    if (parsed.requests.length === 0) throw new Error("Aucune requête HTTP à exécuter.");
    return { kind: "http", result: await execute(parsed.requests[0]!, options) };
  }
  if (!parsed.request) {
    const blocker = parsed.warnings.find((w) => w.level === "error");
    throw new Error(blocker?.message ?? `Commande "${parsed.scheme}://" non exécutable.`);
  }
  return { kind: "protocol", result: await executeProtocol(parsed.request, options) };
}
