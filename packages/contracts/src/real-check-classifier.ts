// Real check on the customer's staging, RC2 (design real-check-security-design.md, 4.3): the OPERATION CLASSIFIER. One pure function, `classifyRealCheckRequest`, says whether one outgoing request is a read the
// real check may make, and why not when it is not. It is the second of the three walls (the customer's IAM, this table, the method rules); RealCheckEgress (Cloud, a later lane) calls it on every request before
// it adds a credential, and the helper on the run network may call it first to fail fast. No credential, no network and no clock here.
//
// Fail closed, in this order:
//   1. the URL is read strictly (https, a plain host, no userinfo, no fragment, no odd characters, a path with no `.`/`..`, no `;`, no double or slash encoding); anything else is `unreadable`;
//   2. the host is never an AI model service (`model_host`), never production (`prod`: the company's list, a prod/live label, a vendor's production host, an empty list), and must be one of the connection's exact hosts
//      (`host_not_allowed`);
//   3. nothing that changes a method (a header, a `_method` or `$httpMethod` query) survives;
//   4. by host: a Google API host is read ONLY through the Google table (exact method + path shape + query names + body members; BigQuery is a SELECT with a forced bytes cap); any other host is plain HTTP:
//      GET/HEAD with no body, no action word in the path, no action value in an `?action=` style query, and (when the connection lists operations) a listed operation; or a POST to a declared GraphQL path whose
//      parsed document has only `query` operations. Every other method is refused: `write` for POST, PUT, PATCH and DELETE, `not_allowed` for the rest.
// The verdict carries a cleaned `operation` label for the ledger: the method, the host and a path in which every segment that is not a plain lower-case word is `{id}`. Never a query value, a body or a header.
import { z } from "zod";
import { hostProblem } from "./test-services-shared.js";
import { isTestAccountModelHost, normalizeModelHostCandidate } from "./test-account-model-hosts.js";
import { testAccountHostProblems } from "./test-account.js";
import { prodDenyIsEmpty, prodDenyMatchesHost, type TestEnvProdDeny } from "./test-environment-prod-deny.js";
import { parseGraphqlDocument, parseStrictJson } from "./real-check-graphql.js";
import {
  REAL_CHECK_ACTION_QUERY_NAMES,
  REAL_CHECK_ACTION_WORDS,
  REAL_CHECK_BIGQUERY_WRITE_WORDS,
  REAL_CHECK_GOOGLE_HOSTS,
  REAL_CHECK_GOOGLE_ROWS,
  REAL_CHECK_LIMIT_DEFAULTS,
  REAL_CHECK_LIMIT_MAXIMUMS,
  REAL_CHECK_METHOD_OVERRIDE_HEADERS,
  REAL_CHECK_METHOD_OVERRIDE_QUERY_NAMES,
  isGoogleApiHost,
  type RealCheckGoogleRow,
  type RealCheckLimits,
} from "./real-check-read-tables.js";

/** The company's production list for real checks: the shared list (hosts, AWS accounts, ARN prefixes) plus GCP project ids and numbers (owner decision R3-8). */
export type RealCheckProdDeny = TestEnvProdDeny & { gcpProjects?: readonly string[] };

export const REAL_CHECK_REFUSALS = ["write", "not_allowed", "host_not_allowed", "prod", "model_host", "unreadable"] as const;
export type RealCheckRefusal = (typeof REAL_CHECK_REFUSALS)[number];

export interface RealCheckRequest {
  /** The method exactly as sent (`GET`); anything not an upper-case token is unreadable. */
  method: string;
  /** The absolute URL the box asked for. */
  url: string;
  /** Request header NAMES with values (only the names are read here, to find a method override and a content type). */
  headers?: Readonly<Record<string, string>> | undefined;
  /** The request body as text (a JSON body); absent for a body-less request. */
  body?: string | undefined;
}

export interface RealCheckPolicy {
  /** The connection's exact hosts. */
  hosts: readonly string[];
  /** The connection's GCP project, by id and (when known) number: a Google request names one of these and no other. Absent for a connection that is not GCP. */
  gcpProjects?: readonly string[] | undefined;
  /** Exact paths of the connection's GraphQL endpoints (`/graphql`); a POST anywhere else is a write. */
  graphqlPaths?: readonly string[] | undefined;
  /** Approved plain-HTTP operations (`GET /v2/user/videos/{id}`); empty or absent means any GET on the allowed hosts. */
  operations?: readonly string[] | undefined;
  limits?: Pick<RealCheckLimits, "requestBytes" | "bigQueryBytesBilled"> | undefined;
  /** The company's production list. Required: an empty or missing list refuses every request (`prod`). */
  prodDeny: RealCheckProdDeny | undefined;
  /** The company's own model gateway hosts (also never a real-check host). */
  modelGatewayHosts?: readonly string[] | undefined;
}

export type RealCheckProtocol = "http" | "graphql" | "google";

export type RealCheckVerdict =
  | {
      allow: true;
      protocol: RealCheckProtocol;
      method: "GET" | "HEAD" | "POST";
      host: string;
      /** The cleaned label for the ledger. */
      operation: string;
      /** BigQuery: the bytes cap this query MUST carry (the request's own, lowered to the cap) and whether it is a dry run. */
      bigQuery?: { maximumBytesBilled: string; dryRun: boolean };
      /** The body to forward when the check rewrote it (BigQuery's forced cap). Otherwise the request's own body is forwarded unchanged. */
      forwardBody?: string;
    }
  | { allow: false; reason: RealCheckRefusal; operation: string };

const refuse = (reason: RealCheckRefusal, operation: string): RealCheckVerdict => ({ allow: false, reason, operation });

/** The two caps this classifier owns, from the policy or the defaults. A figure that is not a whole number from 1 up to Rovara's maximum is no cap: undefined, and every request is refused. */
function ownLimits(policy: RealCheckPolicy): { requestBytes: number; bigQueryBytesBilled: number } | undefined {
  const requestBytes: unknown = policy.limits === undefined ? REAL_CHECK_LIMIT_DEFAULTS.requestBytes : policy.limits.requestBytes;
  const bigQueryBytesBilled: unknown = policy.limits === undefined ? REAL_CHECK_LIMIT_DEFAULTS.bigQueryBytesBilled : policy.limits.bigQueryBytesBilled;
  const fine = (value: unknown, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max;
  return fine(requestBytes, REAL_CHECK_LIMIT_MAXIMUMS.requestBytes) && fine(bigQueryBytesBilled, REAL_CHECK_LIMIT_MAXIMUMS.bigQueryBytesBilled) ? { requestBytes, bigQueryBytesBilled } : undefined;
}

// ---- the URL, read strictly

interface ParsedUrl {
  host: string;
  /** Path segments, as sent (still percent-encoded) and decoded once. */
  segments: Array<{ raw: string; decoded: string }>;
  trailingSlash: boolean;
  query: Array<{ name: string; value: string }>;
  hasQuery: boolean;
}

const URL_SHAPE = /^https:\/\/([A-Za-z0-9.-]{1,253})(?::443)?(\/[^?#\s]*)?(?:\?([^#\s]*))?$/u;
const PATH_CHARS = /^\/[A-Za-z0-9._~!$&'()*+,=:@%/-]*$/u;
const MAX_QUERY_PAIRS = 40;

function decodeOnce(text: string): string | undefined {
  if (/%(?![0-9A-Fa-f]{2})/u.test(text)) return undefined;
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

/** The URL's parts, or undefined when it is not a plain https URL. `allowEncodedSlash`: an encoded slash is kept in a segment (Storage object names); otherwise it is a refusal. */
function parseUrl(url: unknown): ParsedUrl | undefined {
  if (typeof url !== "string" || url.length > 4_096) return undefined;
  const match = URL_SHAPE.exec(url);
  if (match === null) return undefined;
  const host = (match[1] as string).toLowerCase();
  const rawPath = match[2] ?? "/";
  if (!PATH_CHARS.test(rawPath)) return undefined;
  const parts = rawPath.split("/").slice(1);
  const trailingSlash = parts.length > 1 && parts[parts.length - 1] === "";
  const named = trailingSlash ? parts.slice(0, -1) : parts;
  const segments: Array<{ raw: string; decoded: string }> = [];
  for (const raw of named) {
    if (raw === "" && !(named.length === 1 && !trailingSlash)) return undefined;
    // `%25` (a literal percent) is refused: a double-encoded name is read one way here and another by the server.
    if (/%25/iu.test(raw)) return undefined;
    const decoded = decodeOnce(raw);
    if (decoded === undefined || decoded === "." || decoded === ".." || /[\p{Cc}\\]/u.test(decoded)) return undefined;
    segments.push({ raw, decoded });
  }
  const query: Array<{ name: string; value: string }> = [];
  const rawQuery = match[3];
  if (rawQuery !== undefined && rawQuery !== "") {
    const pairs = rawQuery.split("&");
    if (pairs.length > MAX_QUERY_PAIRS) return undefined;
    for (const pair of pairs) {
      if (pair === "") continue;
      const eq = pair.indexOf("=");
      const name = decodeOnce((eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/gu, " "));
      const value = decodeOnce((eq === -1 ? "" : pair.slice(eq + 1)).replace(/\+/gu, " "));
      if (name === undefined || value === undefined || /\p{Cc}/u.test(name + value)) return undefined;
      query.push({ name, value });
    }
  }
  return { host, segments, trailingSlash, query, hasQuery: rawQuery !== undefined };
}

// ---- the ledger label

const WORD_SEGMENT = /^[a-z][a-z_-]{0,23}$/u;
const VERSION_SEGMENT = /^v\d{1,2}(?:alpha\d*|beta\d*)?$/u;
const METHOD_TOKEN = /^[A-Z]{3,10}$/u;

/** A path as the ledger shows it: a plain lower-case word or a version is kept, every other segment (an id, a name, a number) is `{id}`; at most 8 segments. */
export function realCheckPathLabel(segments: readonly string[]): string {
  const kept = segments.slice(0, 8).map((segment) => (WORD_SEGMENT.test(segment) || VERSION_SEGMENT.test(segment) ? segment : "{id}"));
  return `/${kept.join("/")}${segments.length > 8 ? "/…" : ""}`;
}

const labelOf = (method: string, host: string | undefined, path: string): string => `${METHOD_TOKEN.test(method) ? method : "?"} ${host ?? "?"} ${path}`;

// ---- plain HTTP

const ACTION_PREFIXES = ["un", "re", "bulk", "batch", "mass"];
const ACTION_SUFFIXES = ["all", "many", "batch", "bulk", "now"];

/** A word is an action word when it is one, or one with a common prefix or suffix (`unpublish`, `resend`, `deleteall`). Whole words only otherwise: `sender` and `deleted` are reads. */
function isActionWord(word: string): boolean {
  if (REAL_CHECK_ACTION_WORDS.has(word)) return true;
  if (ACTION_PREFIXES.some((prefix) => word.startsWith(prefix) && REAL_CHECK_ACTION_WORDS.has(word.slice(prefix.length)))) return true;
  return ACTION_SUFFIXES.some((suffix) => word.endsWith(suffix) && REAL_CHECK_ACTION_WORDS.has(word.slice(0, -suffix.length)));
}

function actionWordIn(text: string): boolean {
  const words = text.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").split(/[^A-Za-z0-9]+/u);
  return words.some((word) => word !== "" && isActionWord(word.toLowerCase()));
}

/** A template is `GET /v2/user/videos/{id}`: the method, then literal segments and `{name}` for any one segment. */
const OPERATION_TEMPLATE = /^(GET|HEAD) (\/(?:[A-Za-z0-9._~-]+|\{[a-z][a-z0-9_]{0,23}\})(?:\/(?:[A-Za-z0-9._~-]+|\{[a-z][a-z0-9_]{0,23}\}))*)$/u;

/** Whether the text is a valid operation template of the connection. */
export function isRealCheckOperationTemplate(text: unknown): boolean {
  return typeof text === "string" && text.length <= 200 && OPERATION_TEMPLATE.test(text) && !text.split("/").some((segment) => segment === "." || segment === "..");
}

function operationAllowed(method: string, segments: readonly string[], operations: readonly string[]): boolean {
  return operations.some((template) => {
    const match = OPERATION_TEMPLATE.exec(template);
    if (match === null) return false;
    if (match[1] !== method && !(method === "HEAD" && match[1] === "GET")) return false;
    const parts = (match[2] as string).split("/").slice(1);
    return parts.length === segments.length && parts.every((part, index) => (part.startsWith("{") ? (segments[index] as string) !== "" : part === segments[index]));
  });
}

function queryProblem(url: ParsedUrl): "write" | undefined {
  for (const { name, value } of url.query) {
    const lower = name.toLowerCase();
    if (REAL_CHECK_METHOD_OVERRIDE_QUERY_NAMES.has(lower)) return "write";
    if (REAL_CHECK_ACTION_QUERY_NAMES.has(lower) && actionWordIn(value)) return "write";
    // A GraphQL document in a GET's query string: a mutation or a subscription is not a read, wherever the server routes it.
    if ((lower === "query" || lower === "mutation") && value.length > 0) {
      const verdict = parseGraphqlDocument(value);
      // A document that is not a plain query and names a mutation or a subscription (one this check reads as one, cannot read, or reads as no operation: a description in front, a type-system document) is refused: not readable is not "no mutation".
      if (!verdict.ok && /mutation|subscription/iu.test(value)) return "write";
    }
  }
  return undefined;
}

const JSON_TYPE = /^application\/(?:json|graphql-response\+json)\s*(?:;\s*charset=utf-8\s*)?$/iu;
const GRAPHQL_TYPE = /^application\/graphql\s*(?:;\s*charset=utf-8\s*)?$/iu;

function header(headers: RealCheckRequest["headers"], name: string): string | undefined {
  if (headers === undefined) return undefined;
  const key = Object.keys(headers).find((each) => each.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

/** Whether two header names differ only in case: a forwarder sends one of them and this check read the other, so the request is not read at all. */
function hasRepeatedHeaderName(headers: RealCheckRequest["headers"]): boolean {
  if (headers === undefined) return false;
  const names = Object.keys(headers).map((name) => name.toLowerCase());
  return new Set(names).size !== names.length;
}

function classifyGraphql(request: RealCheckRequest, url: ParsedUrl, host: string, operation: string, requestBytes: number): RealCheckVerdict {
  const allowed: RealCheckVerdict = { allow: true, protocol: "graphql", method: request.method as "GET" | "HEAD" | "POST", host, operation: `${request.method} ${host} ${realCheckPathLabel(url.segments.map((s) => s.decoded))} (query)` };
  let document: unknown;
  if (request.method === "POST") {
    // A query string on a POST is merged with the body by some servers: refused outright.
    if (url.hasQuery) return refuse("not_allowed", operation);
    const body = request.body ?? "";
    if (body.length === 0 || new TextEncoder().encode(body).length > requestBytes) return refuse("not_allowed", operation);
    const type = header(request.headers, "content-type");
    if (type !== undefined && GRAPHQL_TYPE.test(type)) document = body;
    else {
      if (type !== undefined && !JSON_TYPE.test(type)) return refuse("not_allowed", operation);
      const parsed = parseStrictJson(body);
      if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) return refuse("unreadable", operation);
      const members = parsed.value as Record<string, unknown>;
      // A persisted query (an id or `extensions` with no text), a batch and any other member are not read: only the text of the query can be checked.
      if (Object.keys(members).some((key) => key !== "query" && key !== "operationName" && key !== "variables")) return refuse("not_allowed", operation);
      if (members.operationName !== undefined && members.operationName !== null && typeof members.operationName !== "string") return refuse("unreadable", operation);
      if (members.variables !== undefined && members.variables !== null && (typeof members.variables !== "object" || Array.isArray(members.variables))) return refuse("unreadable", operation);
      document = members.query;
    }
  } else {
    if (request.body !== undefined && request.body !== "") return refuse("not_allowed", operation);
    if (url.query.some((pair) => pair.name !== "query" && pair.name !== "operationName" && pair.name !== "variables")) return refuse("not_allowed", operation);
    const queries = url.query.filter((pair) => pair.name === "query");
    if (queries.length !== 1) return refuse("unreadable", operation);
    document = (queries[0] as { value: string }).value;
  }
  const verdict = parseGraphqlDocument(document);
  if (verdict.ok) return allowed;
  return refuse(verdict.code === "mutation" ? "write" : verdict.code === "unreadable" ? "unreadable" : "not_allowed", operation);
}

function classifyHttp(request: RealCheckRequest, url: ParsedUrl, host: string, policy: RealCheckPolicy, limits: { requestBytes: number }): RealCheckVerdict {
  const decoded = url.segments.map((segment) => segment.decoded);
  const operation = labelOf(request.method, host, realCheckPathLabel(decoded));
  const { requestBytes } = limits;
  // An encoded slash is another path to the server: refused here.
  if (decoded.some((segment) => segment.includes("/"))) return refuse("unreadable", operation);
  const path = `/${decoded.join("/")}`;
  const isGraphql = (policy.graphqlPaths ?? []).includes(path);
  const { method } = request;
  if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
    // The only POST that can be a read is a GraphQL query to a declared GraphQL endpoint.
    if (method === "POST" && isGraphql) return classifyGraphql(request, url, host, operation, requestBytes);
    return refuse("write", operation);
  }
  if (method !== "GET" && method !== "HEAD") return refuse("not_allowed", operation);
  // A request that carries a body cannot be read: a GET with one is refused whatever the body says.
  if (request.body !== undefined && request.body !== "") return refuse("not_allowed", operation);
  if (url.segments.some((segment) => actionWordIn(segment.decoded))) return refuse("write", operation);
  const problem = queryProblem(url);
  if (problem !== undefined) return refuse(problem, operation);
  if (isGraphql) return classifyGraphql(request, url, host, operation, requestBytes);
  const operations = policy.operations ?? [];
  if (operations.length > 0 && !operationAllowed(method, decoded, operations)) return refuse("not_allowed", operation);
  return { allow: true, protocol: "http", method, host, operation };
}

// ---- Google APIs

interface GoogleMatch {
  row: RealCheckGoogleRow;
  vars: Record<string, string>;
}

const TEMPLATE_CACHE = new Map<string, RegExp>();

function templateRegExp(path: string): RegExp {
  const cached = TEMPLATE_CACHE.get(path);
  if (cached !== undefined) return cached;
  let source = "";
  let rest = path;
  while (rest.length > 0) {
    const open = rest.indexOf("{");
    if (open === -1) {
      source += rest.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      break;
    }
    source += rest.slice(0, open).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const close = rest.indexOf("}", open);
    const name = rest.slice(open + 1, close);
    source += name.endsWith("*") ? `(?<${name.slice(0, -1)}>[^/:]+(?:/[^/:]+)*)` : `(?<${name}>[^/:]+)`;
    rest = rest.slice(close + 1);
  }
  const compiled = new RegExp(`^${source}$`, "u");
  TEMPLATE_CACHE.set(path, compiled);
  return compiled;
}

function matchGoogle(method: "GET" | "POST", rawPath: string): GoogleMatch[] {
  const found: GoogleMatch[] = [];
  for (const row of REAL_CHECK_GOOGLE_ROWS) {
    if (row.method !== method) continue;
    const match = templateRegExp(row.path).exec(rawPath);
    if (match !== null) found.push({ row, vars: { ...(match.groups ?? {}) } });
  }
  return found;
}

const ALT_VALUES = new Set(["json", "media"]);
const PERMISSION = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+){1,4}$/u;
const BYTES_VALUE = /^(?:0|[1-9][0-9]{0,17})$/u;

/**
 * Words of a BigQuery statement, outside strings, comments and quoted names (a `;` is the word ";"), and the statement with its comments dropped and its string literals replaced by `'?'` (quoted names kept).
 * Undefined when a string, comment or quoted name is left open, and when the text holds a backslash anywhere: BigQuery's raw strings (`r'..'`) take no escapes while its other strings and quoted names do, so a
 * backslash is read one way here and another by BigQuery (a raw string ending in one closes early there). Refusing it leaves one reading of every quote.
 */
function bigQueryWords(sql: string): { words: string[]; cleaned: string } | undefined {
  if (sql.includes("\\")) return undefined;
  const words: string[] = [];
  let cleaned = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i] as string;
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n" && sql[i] !== "\r") i += 1;
      cleaned += " ";
    } else if (ch === "#") {
      while (i < n && sql[i] !== "\n" && sql[i] !== "\r") i += 1;
      cleaned += " ";
    } else if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return undefined;
      i = end + 2;
      cleaned += " ";
    } else if (ch === "'" || ch === '"' || ch === "`") {
      const triple = ch !== "`" && sql.startsWith(ch.repeat(3), i);
      const close = triple ? ch.repeat(3) : ch;
      let j = i + close.length;
      let closed = false;
      while (j < n) {
        if (sql.startsWith(close, j)) {
          closed = true;
          j += close.length;
          break;
        } else if (!triple && ch !== "`" && (sql[j] === "\n" || sql[j] === "\r")) return undefined;
        else j += 1;
      }
      if (!closed) return undefined;
      // A string or a quoted name stands as one opaque word, so `SELECT 'a' 'b'` cannot hide a keyword next to it.
      words.push("?");
      cleaned += ch === "`" ? sql.slice(i, j) : "'?'";
      i = j;
    } else if (/[A-Za-z0-9_]/u.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/u.test(sql[j] as string)) j += 1;
      words.push(sql.slice(i, j).toUpperCase());
      cleaned += sql.slice(i, j);
      i = j;
    } else {
      if (ch === ";") words.push(";");
      cleaned += ch;
      i += 1;
    }
  }
  return { words, cleaned };
}

/** A dotted name: unquoted words and quoted names joined by dots (`p.d.t`, `\`p-1.d.t\``, `p.\`d\`.t`). */
const NAME_CHAIN = /(?:`[^`]*`|[A-Za-z0-9_][A-Za-z0-9_-]*)(?:\s*\.\s*(?:`[^`]*`|[A-Za-z0-9_]+))*/gu;
/** Namespaces of BigQuery's own functions (`SAFE.PARSE_DATE(..)`): the only dotted names that may be called. */
const BUILTIN_NAMESPACES = new Set(["SAFE", "NET", "HLL_COUNT"]);

const CALL_PAREN = /\s*\(/uy;
const nameParts = (chain: string): string[] => chain.replace(/\s+/gu, "").match(/`[^`]*`|[^.`]+/gu)?.flatMap((part) => (part.startsWith("`") ? part.slice(1, -1).split(".") : [part])) ?? [];

/**
 * The project of every table-like name in a BigQuery statement that names one (`project.dataset.table`, quoted or not): the first part of every dotted name of three or more parts. A struct field read
 * (`t.col.field`) looks the same and is listed too, so a caller that checks them against the connection's project refuses it: fail closed. Undefined when the statement cannot be read.
 */
export function bigQueryProjectRefs(sql: unknown): string[] | undefined {
  if (typeof sql !== "string" || sql.length > 65_536) return undefined;
  const read = bigQueryWords(sql);
  if (read === undefined) return undefined;
  const refs: string[] = [];
  for (const match of read.cleaned.matchAll(NAME_CHAIN)) {
    const parts = nameParts(match[0]);
    if (parts.length >= 3) refs.push(parts[0] as string);
  }
  // A quoted name with a colon is the legacy `project:dataset.table` form wherever it stands in a chain: the part before the colon is its project. (A name with an empty first part, `.p.d.t`, has a project of "", which is none of the connection's.)
  for (const quoted of read.cleaned.matchAll(/`([^`]*)`/gu)) {
    const inner = quoted[1] as string;
    if (inner.includes(":")) refs.push(inner.slice(0, inner.indexOf(":")));
  }
  return refs;
}

/** Whether a BigQuery statement is one plain read: it starts with SELECT or WITH, is not a script, and holds no write, DDL, script or transaction word. */
export function bigQueryStatementIsRead(sql: unknown): "read" | "write" | "unreadable" {
  if (typeof sql !== "string" || sql.length === 0 || sql.length > 65_536) return "unreadable";
  const read = bigQueryWords(sql);
  if (read === undefined) return "unreadable";
  const { words, cleaned } = read;
  // A colon outside a quoted name is the legacy table form (`p:d.t`) or nothing GoogleSQL has: refused. A Cloud KMS key reference names a key in some project and the run's identity would call it: refused.
  if (cleaned.replace(/`[^`]*`/gu, "").includes(":") || /gcp-kms:/iu.test(sql)) return "write";
  // Organization- and folder-wide views list every project's jobs (with their query text): not this connection's project alone.
  if (/_BY_(?:ORGANIZATION|FOLDER)/iu.test(cleaned)) return "write";
  while (words.length > 0 && words[words.length - 1] === ";") words.pop();
  const first = words[0];
  if (first !== "SELECT" && first !== "WITH") return "write";
  if (words.includes(";")) return "write";
  const write = new Set<string>(REAL_CHECK_BIGQUERY_WRITE_WORDS);
  if (words.some((word) => write.has(word))) return "write";
  // A call to a dotted name that is not one of BigQuery's own namespaces is a user-defined or remote function (it can call out), or ML.* and AI.* (a paid model call).
  for (const match of cleaned.matchAll(NAME_CHAIN)) {
    const parts = nameParts(match[0]);
    const end = (match.index ?? 0) + match[0].length;
    // Any whitespace may sit between a function's name and its parenthesis: the sticky match reads from the end of the name, however long the gap.
    CALL_PAREN.lastIndex = end;
    if (parts.length >= 2 && CALL_PAREN.test(cleaned) && !BUILTIN_NAMESPACES.has((parts[0] as string).toUpperCase())) return "write";
  }
  return "read";
}

/** Request headers a Google API call may carry. Anything else is refused: `X-Goog-User-Project` names the project that is billed and charged quota (the `userProject` query name is refused, so its header twin must be), and the rest (`X-Goog-Request-Params`, `X-Goog-FieldMask` and kin) are other ways to steer a call. */
const GOOGLE_ALLOWED_HEADERS = new Set(["accept", "accept-encoding", "accept-language", "user-agent", "content-type", "content-length", "cache-control", "if-none-match", "range"]);
/** A Google POST carries JSON (or nothing): a form or protobuf body is read another way by the server. */
const GOOGLE_JSON_TYPE = /^application\/json\s*(?:;\s*charset=utf-8\s*)?$/iu;

function classifyGoogle(request: RealCheckRequest, url: ParsedUrl, host: string, policy: RealCheckPolicy, limits: { requestBytes: number; bigQueryBytesBilled: number }): RealCheckVerdict {
  const decoded = url.segments.map((segment) => segment.decoded);
  const operation = labelOf(request.method, host, realCheckPathLabel(decoded));
  const { requestBytes } = limits;
  const { method } = request;
  for (const name of Object.keys(request.headers ?? {})) if (!GOOGLE_ALLOWED_HEADERS.has(name.toLowerCase())) return refuse("not_allowed", operation);
  const contentType = header(request.headers, "content-type");
  if (contentType !== undefined && !GOOGLE_JSON_TYPE.test(contentType)) return refuse("not_allowed", operation);
  if (method === "PUT" || method === "PATCH" || method === "DELETE") return refuse("write", operation);
  if (method !== "GET" && method !== "HEAD" && method !== "POST") return refuse("not_allowed", operation);
  const rowMethod = method === "POST" ? "POST" : "GET";
  // The raw (still encoded) path decides which row matches; a Storage object name may carry an encoded slash, so no segment is decoded here.
  const rawPath = `/${url.segments.map((segment) => segment.raw).join("/")}${url.trailingSlash ? "/" : ""}`;
  const candidates = matchGoogle(rowMethod, rawPath);
  const hit = candidates.find((candidate) => REAL_CHECK_GOOGLE_HOSTS[candidate.row.api] === host);
  if (hit === undefined) return refuse(method === "POST" ? "write" : "not_allowed", operation);
  const { row, vars } = hit;
  const label = `${method} ${host} ${row.path}`;
  // The row's own variables: a project must be the connection's own, whatever else the path says.
  const project = vars.p;
  if (project !== undefined) {
    const deny = policy.prodDeny;
    if (deny?.gcpProjects?.some((entry) => entry.toLowerCase() === project.toLowerCase()) === true) return refuse("prod", label);
    if (!(policy.gcpProjects ?? []).includes(project)) return refuse("not_allowed", label);
  }
  // An encoded slash is accepted only in a Storage object name (the row's own `{o}`); an encoded colon is never accepted (it could read as a custom-method suffix).
  for (const segment of url.segments) {
    if (/%3a/iu.test(segment.raw)) return refuse("unreadable", label);
    if (segment.decoded.includes("/") && !(row.api === "storage" && vars.o === segment.raw)) return refuse("unreadable", label);
  }
  for (const { name, value } of url.query) {
    if (REAL_CHECK_METHOD_OVERRIDE_QUERY_NAMES.has(name.toLowerCase())) return refuse("write", label);
    if (!row.query.includes(name)) return refuse("not_allowed", label);
    if (name === "alt" && !ALT_VALUES.has(value)) return refuse("not_allowed", label);
    if (value.length > 1_024) return refuse("not_allowed", label);
  }
  if (url.query.length > 20) return refuse("not_allowed", label);
  if (row.method === "GET") {
    if (request.body !== undefined && request.body !== "") return refuse("not_allowed", label);
    return { allow: true, protocol: "google", method: method as "GET" | "HEAD", host, operation: label };
  }
  // A POST row: the body is a JSON object whose members are all the row's own.
  const body = request.body ?? "";
  if (new TextEncoder().encode(body).length > requestBytes) return refuse("not_allowed", label);
  const parsed = body === "" ? { ok: true as const, value: {} } : parseStrictJson(body);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) return refuse("unreadable", label);
  const members = parsed.value as Record<string, unknown>;
  const allowedMembers = row.body ?? [];
  if (Object.keys(members).some((key) => !allowedMembers.includes(key))) return refuse("not_allowed", label);
  if (row.kind === "test_iam") {
    const permissions = members.permissions;
    if (!Array.isArray(permissions) || permissions.length === 0 || permissions.length > 100 || !permissions.every((each) => typeof each === "string" && PERMISSION.test(each))) return refuse("unreadable", label);
    return { allow: true, protocol: "google", method: "POST", host, operation: label };
  }
  if (row.kind === "dry_run_query") return classifyBigQueryQuery(members, label, host, policy, limits.bigQueryBytesBilled);
  return { allow: true, protocol: "google", method: "POST", host, operation: label };
}

function classifyBigQueryQuery(members: Record<string, unknown>, label: string, host: string, policy: RealCheckPolicy, cap: number): RealCheckVerdict {
  const statement = bigQueryStatementIsRead(members.query);
  if (statement !== "read") return refuse(statement === "write" ? "write" : "unreadable", label);
  if (members.dryRun !== undefined && typeof members.dryRun !== "boolean") return refuse("unreadable", label);
  // Standard SQL only: legacy SQL names tables `[project:dataset.table]` (a form the project check does not read) and is BigQuery's default when the member is missing. An explicit request for it is refused, the flag is forced off in what is forwarded, and a `#legacySQL` first line (which overrides the flag) is refused.
  if (members.useLegacySql === true) return refuse("not_allowed", label);
  if (typeof members.query === "string" && /^\s*#\s*legacysql/iu.test(members.query)) return refuse("not_allowed", label);
  for (const flag of ["useLegacySql", "useQueryCache"]) if (members[flag] !== undefined && typeof members[flag] !== "boolean") return refuse("unreadable", label);
  const dataset = members.defaultDataset;
  if (dataset !== undefined) {
    if (typeof dataset !== "object" || dataset === null || Array.isArray(dataset)) return refuse("unreadable", label);
    // Exactly {projectId, datasetId}: another spelling of a member (`project_id`, which protobuf JSON also accepts) is a second way to name a project that this check does not read, so any other member is refused.
    const given = dataset as Record<string, unknown>;
    if (Object.keys(given).some((key) => key !== "projectId" && key !== "datasetId")) return refuse("not_allowed", label);
    const { projectId, datasetId } = given;
    if (projectId !== undefined && (typeof projectId !== "string" || !(policy.gcpProjects ?? []).includes(projectId))) return refuse("not_allowed", label);
    if (typeof datasetId !== "string" || !/^[A-Za-z0-9_]{1,1024}$/u.test(datasetId)) return refuse("unreadable", label);
  }
  // A table of another project (`p.d.t`), or one on the production list, is not this connection's: only its own project's tables are read.
  const refs = bigQueryProjectRefs(members.query) ?? [];
  const denied = policy.prodDeny?.gcpProjects ?? [];
  if (refs.some((ref) => denied.some((entry) => entry.toLowerCase() === ref.toLowerCase()))) return refuse("prod", label);
  if (refs.some((ref) => !(policy.gcpProjects ?? []).includes(ref))) return refuse("not_allowed", label);
  // The forced cap: the request's own figure when it has one and it is lower, else the connection's cap. A figure that is not a plain whole number is not read.
  let requested = cap;
  const given = members.maximumBytesBilled;
  if (given !== undefined) {
    const text = typeof given === "number" && Number.isSafeInteger(given) && given >= 0 ? String(given) : given;
    if (typeof text !== "string" || !BYTES_VALUE.test(text) || Number(text) < 1) return refuse("unreadable", label);
    requested = Math.min(Number(text), cap);
  }
  const maximumBytesBilled = String(requested);
  const forwarded = JSON.stringify({ ...members, maximumBytesBilled, useLegacySql: false });
  return { allow: true, protocol: "google", method: "POST", host, operation: label, bigQuery: { maximumBytesBilled, dryRun: members.dryRun === true }, forwardBody: forwarded };
}

// ---- the entry point

/** The headers that change a request's method, found by name in any case. */
function hasMethodOverrideHeader(headers: RealCheckRequest["headers"]): boolean {
  return headers !== undefined && Object.keys(headers).some((name) => REAL_CHECK_METHOD_OVERRIDE_HEADERS.has(name.toLowerCase()));
}

const RequestShape = z.object({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()).optional(), body: z.string().optional() });

/**
 * Whether one outgoing request is a read the real check may make. See the header for the order. Never throws: input that is not a request, or not readable, is `unreadable`. The verdict never holds a query value,
 * a body (except BigQuery's rewritten one, which is the caller's own query) or a header.
 */
export function classifyRealCheckRequest(request: RealCheckRequest, policy: RealCheckPolicy): RealCheckVerdict {
  const shape = RequestShape.safeParse(request);
  if (!shape.success) return refuse("unreadable", "? ? /");
  const method = request.method;
  const url = parseUrl(request.url);
  if (url === undefined) return refuse("unreadable", `${METHOD_TOKEN.test(method) ? method : "?"} ? /`);
  const host = url.host;
  const label = labelOf(method, host, realCheckPathLabel(url.segments.map((segment) => segment.decoded)));
  if (!METHOD_TOKEN.test(method)) return refuse("unreadable", label);
  // The host: never a model service, never production, and exactly one of the connection's.
  if (isTestAccountModelHost(host, { gatewayHosts: policy.modelGatewayHosts ?? [] }) || (policy.modelGatewayHosts ?? []).some((gateway) => normalizeModelHostCandidate(gateway) === host)) return refuse("model_host", label);
  const deny = policy.prodDeny;
  if (deny === undefined || (prodDenyIsEmpty(deny) && (deny.gcpProjects ?? []).length === 0)) return refuse("prod", label);
  if (prodDenyMatchesHost(deny, host) || testAccountHostProblems([host]).length > 0) return refuse("prod", label);
  if (hostProblem(host) !== undefined || !policy.hosts.some((allowed) => allowed === host)) return refuse("host_not_allowed", label);
  if (hasRepeatedHeaderName(request.headers)) return refuse("unreadable", label);
  if (hasMethodOverrideHeader(request.headers)) return refuse("write", label);
  // A cap that is not a plain number is not a cap: nothing is read under it.
  const limits = ownLimits(policy);
  if (limits === undefined) return refuse("unreadable", label);
  if (isGoogleApiHost(host)) return classifyGoogle(request, url, host, policy, limits);
  return classifyHttp(request, url, host, policy, limits);
}
