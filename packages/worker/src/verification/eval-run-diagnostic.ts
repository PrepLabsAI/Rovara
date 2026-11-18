// L4-EVS: why a customer's eval could not run, from a BOUNDED tail of the command's own output (stdout and stderr: the eval sandbox now keeps a capped log until the container is removed, instead of
// `--log-driver none`). The output is the repository's own free text, so it is treated as hostile:
//   - bounded first: only the last `RAW_TAIL_CHARS` characters are looked at, cut at a line start, however much the command printed;
//   - the cause is named by one FIXED code (contracts `EVAL_RUN_FAILURE_CODES`), plus at most ONE name (a package, a file, a command) that passes a strict word shape and is not itself a secret;
//   - the tail kept for the evidence is REDACTED: every secret this run knows (the run's model token and the placeholder keys, raw and in their common encodings), then the shared `redactText`
//     (key shapes, bearer tokens, credentials in URLs and assignments), then URL credentials and secret-named query parameters, then opaque long tokens. A secret that survives all of that is
//     checked for once more and the tail is DROPPED whole rather than shown;
//   - nothing here runs, reads a file or throws: any fault is a diagnostic with an empty tail.
import {
  EVAL_RUN_FAILURE_NAME, EVAL_RUN_TAIL_MAX_CHARS, redactText,
  type EvalRunDiagnostic, type EvalRunFailureCode,
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
