// L4-EVS: why a customer's eval could not run, from a BOUNDED tail of the command's own output (stdout and stderr: the eval sandbox now keeps a capped log until the container is removed, instead of
// `--log-driver none`). The output is the repository's own free text, so it is treated as hostile:
//   - bounded first: only the last `RAW_TAIL_CHARS` characters are looked at, cut at a line start, however much the command printed;
//   - the cause is named by one FIXED code (contracts `EVAL_RUN_FAILURE_CODES`), plus at most ONE name (a package, a file, a command) that passes a strict word shape and is not itself a secret;
//   - the tail kept for the evidence is REDACTED: every secret this run knows (the run's model token and the placeholder keys, raw and in their common encodings), then the shared `redactText`
//     (key shapes, bearer tokens, credentials in URLs and assignments), then URL credentials and secret-named query parameters, then opaque long tokens. A secret that survives all of that is
//     checked for once more and the tail is DROPPED whole rather than shown;
//   - TH1: a run that stopped because it tried to reach something other than the model helper (a refused port, a failed name lookup) is named by `blocked_connection` plus up to 3 FIXED-shape items: a database by its PORT,
//     an outside service by its HOST NAME. Hosts and ports are read from a closed list of error shapes (never from a URL, so a path, a query string and a credential are never even looked at), pass the strict host
//     shape, and are dropped when they carry a secret this run knows. Addresses, `localhost` and the model route's own names are never named;
//   - nothing here runs, reads a file or throws: any fault is a diagnostic with an empty tail.
import {
  EVAL_BLOCKED_HOST, EVAL_BLOCKED_REACH_MAX_ITEMS, EVAL_RUN_FAILURE_NAME, EVAL_RUN_TAIL_MAX_CHARS, redactText,
  type EvalBlockedReach, type EvalRunDiagnostic, type EvalRunFailureCode,
} from "@agentx/contracts";

/** The most raw characters looked at: the end of what the command printed. */
const RAW_TAIL_CHARS = 16_384;
const LINE_MAX_CHARS = 400;
const LINES_MAX = 80;
const MIN_SECRET_CHARS = 6;
// eslint-disable-next-line no-control-regex
const ANSI = new RegExp("\\u001b(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)|[@-Z\\\\-_])", "gu");
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff]", "gu");
const REDACTED = "[REDACTED]";

/** A secret in the forms a program might print it: raw, percent-encoded (once and twice), base64, base64url and hex. */
function secretForms(secret: string): string[] {
  const forms = new Set<string>([secret]);
  try { const once = encodeURIComponent(secret); forms.add(once); forms.add(encodeURIComponent(once)); } catch { /* a lone surrogate: the raw form stays */ }
  const bytes = Buffer.from(secret, "utf8");
  forms.add(bytes.toString("base64")); forms.add(bytes.toString("base64").replace(/=+$/u, ""));
  forms.add(bytes.toString("base64url")); forms.add(bytes.toString("hex"));
  forms.add(JSON.stringify(secret).slice(1, -1));
  return [...forms].filter(form => form.length >= MIN_SECRET_CHARS);
}

/** Cuts to the last `RAW_TAIL_CHARS`, then to the next line start (a half line is dropped), removes control and escape characters (line breaks stay) and carriage returns. */
function tidy(raw: string): string {
  let text = raw.length > RAW_TAIL_CHARS ? raw.slice(raw.length - RAW_TAIL_CHARS) : raw;
  if (text.length < raw.length) { const at = text.indexOf("\n"); text = at < 0 ? "" : text.slice(at + 1); }
  return text.replace(ANSI, "").replace(/\r\n?/gu, "\n").replace(CONTROL, "");
}

/**
 * The tail, redacted and bounded to `EVAL_RUN_TAIL_MAX_CHARS`. `secrets` are the values this run knows must never show (the model token, the placeholder keys). Pure, linear in the (capped) input.
 * An empty string when anything that looks like a known secret would remain.
 */
export function redactEvalTail(raw: unknown, secrets: readonly string[] = []): string {
  try {
    if (typeof raw !== "string" || raw === "") return "";
    const known = secrets.filter(secret => typeof secret === "string" && secret.length >= MIN_SECRET_CHARS).flatMap(secretForms);
    let text = tidy(raw);
    // Longest first, so a secret that contains another is removed whole.
    for (const form of [...known].sort((a, b) => b.length - a.length)) text = text.split(form).join(REDACTED);
    text = redactText(text);
    text = text
      // credentials in a URL, and the run's own path token (`/p/<row>/x/<token>`)
      .replace(/([A-Za-z][A-Za-z0-9+.-]{0,20}:\/\/)[^\s/@:]{1,200}:[^\s/@]{1,400}@/gu, `$1${REDACTED}@`)
      .replace(/(\/x\/)[A-Za-z0-9_-]{16,128}/gu, `$1${REDACTED}`)
      // a secret-named query or form parameter
      .replace(/([?&;](?:[A-Za-z0-9_-]{0,20}(?:key|token|secret|password|passwd|sig|signature|credential|auth)[A-Za-z0-9_-]{0,20})=)[^&\s"']{1,400}/giu, `$1${REDACTED}`)
      // an opaque long run of token characters (a key, a hash, a base64 blob)
      .replace(/(?<![A-Za-z0-9+_-])[A-Za-z0-9+_-]{32,}={0,2}(?![A-Za-z0-9+_-])/gu, REDACTED);
    const lines = text.split("\n").map(line => (line.length > LINE_MAX_CHARS ? `${line.slice(0, LINE_MAX_CHARS)} [line cut]` : line.trimEnd()));
    let out = lines.slice(-LINES_MAX).join("\n").replace(/\n{3,}/gu, "\n\n").trim();
    if (out.length > EVAL_RUN_TAIL_MAX_CHARS) { out = out.slice(out.length - EVAL_RUN_TAIL_MAX_CHARS); const at = out.indexOf("\n"); out = at < 0 ? out : out.slice(at + 1); }
    // The last check: nothing the run knows survives, in any form (a cut or a join above could have rebuilt one).
    for (const form of known) if (out.includes(form)) return "";
    return out;
  } catch {
    return "";
  }
}

/** One name from the output, or undefined: a plain word shape, not a path out of the checkout, and not changed by the redaction (so it is not secret-shaped). */
function cleanName(candidate: string | undefined, secrets: readonly string[]): string | undefined {
  if (candidate === undefined) return undefined;
  let name = candidate.trim().replace(/^@+/u, "").replace(/^(?:\.\/)+/u, "").replace(/^\/workspace\//u, "").replace(/\/+$/u, "");
  if (name.length > 80) name = name.slice(name.length - 80).replace(/^[^A-Za-z0-9_]+/u, "");
  if (!EVAL_RUN_FAILURE_NAME.test(name) || name.split("/").includes("..") || redactText(name) !== name || /[A-Za-z0-9+_-]{32,}/u.test(name)) return undefined;
  if (secrets.some(secret => secret.length >= MIN_SECRET_CHARS && secretForms(secret).some(form => name.includes(form)))) return undefined;
  return name;
}

interface Match { readonly code: EvalRunFailureCode; readonly name: string | undefined }
const PATTERNS: ReadonlyArray<{ readonly code: EvalRunFailureCode; readonly pattern: RegExp }> = [
  // Python: ModuleNotFoundError: No module named 'yaml' / ImportError: No module named yaml
  { code: "missing_package", pattern: /(?:ModuleNotFoundError|ImportError):\s*No module named ['"]?([A-Za-z0-9_.-]{1,80})/u },
  // Python: ImportError: cannot import name 'x' from 'pkg' stays "exited" (the package is there): not matched on purpose.
  // Node: Cannot find module 'x' (a bare name is a package; a relative one is a file) and ERR_MODULE_NOT_FOUND
  { code: "missing_package", pattern: /Cannot find (?:module|package) '([@A-Za-z0-9][A-Za-z0-9_.@/+-]{0,79})'/u },
  { code: "missing_file", pattern: /Cannot find module '(\.{1,2}\/[A-Za-z0-9_.@/+-]{1,79})'/u },
  { code: "missing_file", pattern: /FileNotFoundError:[^\n]*No such file or directory: ['"]([^'"\n]{1,200})['"]/u },
  { code: "missing_file", pattern: /ENOENT[^\n]*(?:open|stat|scandir|access) ['"]([^'"\n]{1,200})['"]/u },
  // A command that is not there: Go/Docker `executable file not found`, shells `foo: not found` / `command not found`, tini's exec failure
  { code: "command_not_found", pattern: /exec: ['"]?([A-Za-z0-9._+-]{1,80})['"]?: executable file not found/u },
  { code: "command_not_found", pattern: /(?:^|\n)(?:[A-Za-z0-9_.-]{1,20}: )?(?:line \d{1,5}: |\d{1,5}: )?([A-Za-z0-9._+-]{1,80}): (?:command )?not found(?:\n|$)/u },
  { code: "command_not_found", pattern: /tini[^\n]*exec ([A-Za-z0-9._/+-]{1,80}) failed: No such file or directory/u },
];

function match(text: string, secrets: readonly string[]): Match | undefined {
  for (const { code, pattern } of PATTERNS) {
    const found = pattern.exec(text);
    if (found === null) continue;
    let name = cleanName(found[1], secrets);
    // `Cannot find module 'x'` with a bare name is a package; a package named like a path out of the checkout has no name.
    if (code === "missing_package" && found[1] !== undefined && /^[@A-Za-z0-9]/u.test(found[1]) === false) name = undefined;
    return { code, name };
  }
  return undefined;
}

/** Ports of the common databases and caches: a connection to one is "a database", named by its port only. */
const DATABASE_PORTS: ReadonlySet<number> = new Set([5432, 5433, 5439, 3306, 3307, 6379, 27017, 1433, 1521, 9042, 11211]);
/** The model route's own names (the helper and every pinned model host): a connection to one is the model route, never "blocked". */
const MODEL_ROUTE_HOSTS: ReadonlySet<string> = new Set(["rovara-models", "metadata.google.internal", "generativelanguage.googleapis.com", "aiplatform.googleapis.com"]);
const MODEL_ROUTE_SUFFIX = "-aiplatform.googleapis.com";
/** Names that are this machine, not an outside service: never named (a database on one still counts as a database). */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "ip6-localhost", "host.docker.internal"]);
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

interface Reach { readonly host: string | undefined; readonly port: number | undefined; readonly database: boolean }
const HOST = "([A-Za-z0-9][A-Za-z0-9._-]{0,252})";
const PORT = "(\\d{1,5})";
/**
 * The closed list of error shapes that carry a host and/or a port of a connection that failed. Each regex captures ONLY a host and/or a port (never a URL, a path or a query), so nothing else of the line is ever read.
 * `db` marks the shapes only a database driver prints (so a name with no port is still "a database").
 */
const REACH_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly host?: number; readonly port?: number; readonly db?: boolean }> = [
  // Node: getaddrinfo ENOTFOUND api.example.com / EAI_AGAIN db
  { pattern: new RegExp(`getaddrinfo (?:ENOTFOUND|EAI_AGAIN|EAI_NODATA|EAI_FAIL) ${HOST}`, "gu"), host: 1 },
  // Node: connect ECONNREFUSED 127.0.0.1:5432 / ::1:5432 / ETIMEDOUT / EHOSTUNREACH / ENETUNREACH
  { pattern: new RegExp(`(?:ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET) \\[?([0-9A-Fa-f:.]{2,45}|[A-Za-z0-9][A-Za-z0-9._-]{0,252})\\]?:${PORT}\\b`, "gu"), host: 1, port: 2 },
  // Node error object: syscall: 'connect', address: '127.0.0.1', port: 5432
  { pattern: new RegExp(`syscall: 'connect',\\s*address: '([^'\\s]{1,253})',\\s*port: ${PORT}`, "gu"), host: 1, port: 2 },
  // Node error object of a failed lookup: code: 'ENOTFOUND', ... hostname: 'api.example.com'
  { pattern: new RegExp(`ENOTFOUND'?,?[^\\n]*\\n?[^\\n]{0,80}hostname: '${HOST}'`, "gu"), host: 1 },
  // undici: (attempted address: api.example.com:443, timeout: 10000ms)
  { pattern: new RegExp(`attempted address: \\[?([0-9A-Fa-f:.]{2,45}|[A-Za-z0-9][A-Za-z0-9._-]{0,252})\\]?:${PORT}`, "gu"), host: 1, port: 2 },
  // Python pymongo and friends: db:27017: [Errno -2] Name or service not known / [Errno 111] Connection refused
  { pattern: new RegExp(`${HOST}:${PORT}: \\[Errno -?\\d+\\] (?:Connection refused|Name or service not known|Temporary failure in name resolution|Network is unreachable|No route to host|Connection timed out)`, "gu"), host: 1, port: 2 },
  // Python requests / urllib3: HTTPSConnectionPool(host='api.example.com', port=443): Max retries exceeded ... (the URL after it is never captured)
  { pattern: new RegExp(`HTTPS?ConnectionPool\\(host='${HOST}', port=${PORT}\\)`, "gu"), host: 1, port: 2 },
  // urllib3: Failed to resolve 'api.example.com'
  { pattern: new RegExp(`Failed to resolve '${HOST}'`, "gu"), host: 1 },
  // aiohttp: Cannot connect to host api.example.com:443 ssl:default
  { pattern: new RegExp(`Cannot connect to host ${HOST}:${PORT}`, "gu"), host: 1, port: 2 },
  // asyncpg and asyncio: Connect call failed ('127.0.0.1', 5432)
  { pattern: new RegExp(`Connect call failed \\('([^'\\s]{1,253})', ${PORT}`, "gu"), host: 1, port: 2 },
  // psycopg: could not translate host name "db" to address
  { pattern: /could not translate host name "([A-Za-z0-9][A-Za-z0-9._-]{0,252})" to address/gu, host: 1, db: true },
  // psycopg 3 and libpq 14+: connection to server at "db" (172.18.0.2), port 5432 failed
  { pattern: new RegExp(`connection to server at "${HOST}"(?: \\([^)\\n]{0,60}\\))?, port ${PORT} failed`, "gu"), host: 1, port: 2, db: true },
  // older libpq: Is the server running on host "db" (172.18.0.2) and accepting TCP/IP connections on port 5432?
  { pattern: new RegExp(`server running on host "${HOST}"[^\\n]{0,80}\\n?[^\\n]{0,40}connections on port ${PORT}`, "gu"), host: 1, port: 2, db: true },
  // MySQL: Can't connect to MySQL server on 'db' (111) / on 'db:3306'
  { pattern: /Can't connect to MySQL server on '([A-Za-z0-9][A-Za-z0-9._-]{0,252})(?::(\d{1,5}))?'/gu, host: 1, port: 2, db: true },
  // redis-py: Error 111 connecting to redis:6379. Connection refused. / Error -2 connecting to ...
  { pattern: new RegExp(`Error (?:-?\\d+ )?(?:while )?connecting to ${HOST}:${PORT}\\b`, "gu"), host: 1, port: 2 },
  // Go: dial tcp 10.0.0.1:5432: connect: connection refused / i/o timeout
  { pattern: new RegExp(`dial tcp \\[?([0-9A-Fa-f:.]{2,45}|[A-Za-z0-9][A-Za-z0-9._-]{0,252})\\]?:${PORT}: `, "gu"), host: 1, port: 2 },
  // Go: dial tcp: lookup db on 127.0.0.11:53: no such host
  { pattern: new RegExp(`lookup ${HOST}(?: on [0-9A-Fa-f:.\\[\\]]{2,45})?: (?:no such host|server misbehaving|i/o timeout|connection refused)`, "gu"), host: 1 },
];

const bareHost = (raw: string): string => raw.trim().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
const normalHost = (raw: string): string => bareHost(raw).toLowerCase();

/** One outside host name, lower-cased, or undefined when it is an address, this machine, not the strict host shape, or carries a secret this run knows. */
function cleanHost(raw: string | undefined, secrets: readonly string[]): string | undefined {
  if (raw === undefined) return undefined;
  const written = bareHost(raw);
  const host = written.toLowerCase();
  if (host === "" || host.includes(":") || IPV4.test(host) || LOCAL_HOSTS.has(host) || host.endsWith(".localhost")) return undefined;
  // Redaction is judged on the name as the output wrote it AND lower-cased (a key shape is case-sensitive).
  if (!EVAL_BLOCKED_HOST.test(host) || host.includes("..") || redactText(written) !== written || redactText(host) !== host) return undefined;
  if (secrets.some(secret => secret.length >= MIN_SECRET_CHARS && secretForms(secret).some(form => host.includes(form.toLowerCase())))) return undefined;
  return host;
}

/** What the eval tried to reach, from the command's own output: up to 3 items (databases by port, outside services by host name), in the order the output names them. Undefined when nothing nameable was found. */
export function findBlockedReach(text: string, secrets: readonly string[] = []): EvalBlockedReach | undefined {
  try {
    const items: Array<EvalBlockedReach["items"][number]> = [];
    const seen = new Set<string>();
    const found: Array<{ at: number; reach: Reach }> = [];
    for (const { pattern, host, port, db } of REACH_PATTERNS) {
      pattern.lastIndex = 0;
      for (const m of text.matchAll(pattern)) {
        const p = port === undefined || m[port] === undefined ? undefined : Number(m[port]);
        found.push({ at: m.index ?? 0, reach: { host: host === undefined ? undefined : m[host], port: p !== undefined && Number.isInteger(p) && p >= 1 && p <= 65_535 ? p : undefined, database: db === true } });
        if (found.length >= 200) break;
      }
    }
    found.sort((a, b) => a.at - b.at);
    for (const { reach } of found) {
      const raw = reach.host === undefined ? "" : normalHost(reach.host);
      if (MODEL_ROUTE_HOSTS.has(raw) || raw.endsWith(MODEL_ROUTE_SUFFIX)) continue;
      const host = cleanHost(reach.host, secrets);
      // A database is named by its port alone (its host is the project's own private name); anything else needs a host name that passed the shape.
      const item: EvalBlockedReach["items"][number] | undefined = reach.database || (reach.port !== undefined && DATABASE_PORTS.has(reach.port))
        ? { kind: "database", ...(reach.port === undefined ? {} : { port: reach.port }) }
        : host === undefined ? undefined : { kind: "service", host };
      if (item === undefined) continue;
      const key = item.kind === "database" ? `d:${String(item.port ?? "")}` : `s:${item.host}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
    // A database seen with no port is the same one as a database seen with a port (a driver names the host in one line and the port in another).
    const withPort = items.some(item => item.kind === "database" && item.port !== undefined);
    const distinct = items.filter(item => !(withPort && item.kind === "database" && item.port === undefined));
    const more = distinct.length > EVAL_BLOCKED_REACH_MAX_ITEMS;
    const kept = distinct.slice(0, EVAL_BLOCKED_REACH_MAX_ITEMS);
    return kept.length === 0 ? undefined : { items: kept, ...(more ? { more: true } : {}) };
  } catch {
    return undefined;
  }
}

export interface EvalFailureInput {
  readonly phase: "install" | "run";
  /** The container's exit code, or undefined when it could not be read. */
  readonly exitCode?: number | undefined;
  readonly timedOut?: boolean | undefined;
  /** The command's own output (any amount; only its end is read). */
  readonly output: unknown;
  /** Values that must never show: the run's model token, the placeholder keys. */
  readonly secrets?: readonly string[] | undefined;
}

/** The diagnostic for a failed install step or a failed eval run. Never throws; an unreadable input still gives a fixed code with an empty tail. */
export function diagnoseEvalFailure(input: EvalFailureInput): EvalRunDiagnostic {
  const secrets = input.secrets ?? [];
  const exitCode = typeof input.exitCode === "number" && Number.isInteger(input.exitCode) && input.exitCode >= -1 && input.exitCode <= 255 ? input.exitCode : undefined;
  let tail: string;
  let found: Match | undefined;
  try {
    tail = redactEvalTail(input.output, secrets);
    // The cause is read from the cleaned text (control characters and escapes gone), before it is redacted: a name that a redaction would change is dropped by `cleanName`.
    found = typeof input.output === "string" ? match(tidy(input.output), secrets) : undefined;
  } catch { tail = ""; found = undefined; }
  const exit = exitCode === undefined ? {} : { exitCode };
  if (input.timedOut === true) return { code: input.phase === "install" ? "install_timed_out" : "run_timed_out", phase: input.phase, ...exit, tail };
  // An install step that failed is the cause; what it printed (a missing build tool, a refused registry) is in the tail, not reduced to a package name.
  if (input.phase === "install") return { code: "install_failed", phase: "install", ...exit, tail };
  if (found !== undefined) return { code: found.code, phase: "run", ...(found.name === undefined ? {} : { name: found.name }), ...exit, tail };
  // TH1: the eval tried to reach something other than the model helper. Read from the cleaned text, before redaction (like the names above); only fixed-shape hosts and ports are kept.
  const blocked = typeof input.output === "string" ? findBlockedReach(tidy(input.output), secrets) : undefined;
  if (blocked !== undefined) return { code: "blocked_connection", phase: "run", blocked, ...exit, tail };
  return { code: "exited", phase: "run", ...exit, tail };
}

/**
 * What the fresh sandbox throws when the project's install step or the eval command failed and left no readable result. It carries the diagnostic (fixed code, one allow-listed name, a redacted bounded
 * tail) and a FIXED message: nothing of the command's output is ever in `message`. The runner and the final check read `diagnostic`; anything that catches it without reading it sees an ordinary failed run.
 */
export class EvalSandboxRunFailure extends Error {
  readonly diagnostic: EvalRunDiagnostic;
  constructor(diagnostic: EvalRunDiagnostic) {
    super("eval run failed");
    this.name = "EvalSandboxRunFailure";
    this.diagnostic = diagnostic;
  }
}

/** The diagnostic an error carries, or undefined. */
export function runFailureOf(error: unknown): EvalRunDiagnostic | undefined {
  return error instanceof EvalSandboxRunFailure ? error.diagnostic : undefined;
}
