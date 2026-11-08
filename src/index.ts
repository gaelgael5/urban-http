/**
 * urban-http : transformer une commande curl en appel HTTP exécutable.
 *
 * Usage typique :
 * ```ts
 * import { parseCurl, execute, toFetch, toFetchCode } from "urban-http";
 *
 * const { requests, warnings } = parseCurl(`curl -X POST https://api.example.com -d '{"a":1}'`);
 * const result = await execute(requests[0]);
 * console.log(result.response.status);
 * ```
 */
export { parseCurl } from "./parse.js";
export { tokenize } from "./tokenize.js";
export { toFetch, toFetchCode, authHeader } from "./to-fetch.js";
export type { FetchPlan, ToFetchOptions } from "./to-fetch.js";
export { execute } from "./execute.js";
export type { ExecuteOptions, ExecuteResult } from "./execute.js";
export type {
  AuthSpec,
  BodyKind,
  BodySpec,
  DataItem,
  FileReader,
  FormField,
  HttpRequestModel,
  ParseResult,
  ParseWarning,
  RequestOptions,
  WarningLevel,
} from "./model.js";
