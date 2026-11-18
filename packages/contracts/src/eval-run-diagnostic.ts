// L4-EVS: why a customer's eval could not run, in fixed words. The fresh eval sandbox used to drop the command's output (`--log-driver none`), so a missing package read
// as a generic "Not run". Now the worker reads a BOUNDED tail of the output, redacts it (worker/verification/eval-run-diagnostic.ts), names one fixed code and, for the code
// that needs one, ONE name (a package, a file, a command) that passed a strict allow-list shape. This file holds only the wire shape and the fixed sentences; it never
// echoes free text. Browser-safe and pure.
import { z } from "zod";
import { inertEvidenceText } from "./evidence-inert.js";

/** The fixed causes. `exited` is the catch-all: the command ended with a failing code and wrote no readable result. */
export const EVAL_RUN_FAILURE_CODES = ["missing_package", "missing_file", "command_not_found", "install_failed", "install_timed_out", "run_timed_out", "blocked_connection", "exited"] as const;
export type EvalRunFailureCode = (typeof EVAL_RUN_FAILURE_CODES)[number];
/** The phase the cause was seen in: the project's install step (network allowed to package registries only) or the sealed eval run. */
export const EVAL_RUN_FAILURE_PHASES = ["install", "run"] as const;

/** The most output characters kept after redaction (the last 4 KB the sandbox read). */
export const EVAL_RUN_TAIL_MAX_CHARS = 4_096;
/** One name: a module, package, file or command. A plain word shape only; anything else is dropped and the sentence says no name. */
export const EVAL_RUN_FAILURE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.+/-]{0,79}$/u;

/**
 * TH1: what a sealed eval tried to reach besides the model helper. FIXED words only: a kind, a database port, and a host NAME (a plain dotted or single-label name, at most 45 characters, never an address, a path, a query or a
 * credential). At most 3 items, so the sentence stays short; `more` says a longer list was cut. A database is named by its port alone (its host is the project's own private name).
 */
export const EVAL_BLOCKED_REACH_MAX_ITEMS = 3;
export const EVAL_BLOCKED_HOST_MAX_CHARS = 45;
/** A lower-case host name: letters, digits and hyphens in labels of 1 to 45 characters, never all digits at the end (so never an IPv4 address). */
export const EVAL_BLOCKED_HOST = /^(?!\d+(?:\.\d+)*$)(?=.{1,45}$)[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?)*$/u;
const BlockedReachItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("database"), port: z.number().int().min(1).max(65_535).optional() }).strict(),
  /** `host` is absent only in the public view's list (kinds only); the worker always names one. */
  z.object({ kind: z.literal("service"), host: z.string().regex(EVAL_BLOCKED_HOST).optional() }).strict(),
]);
export const EvalBlockedReachSchema = z.object({
  items: z.array(BlockedReachItemSchema).min(1).max(EVAL_BLOCKED_REACH_MAX_ITEMS),
  more: z.boolean().optional(),
}).strict();
export type EvalBlockedReach = z.infer<typeof EvalBlockedReachSchema>;

export const EvalRunDiagnosticSchema = z.object({
  code: z.enum(EVAL_RUN_FAILURE_CODES),
  phase: z.enum(EVAL_RUN_FAILURE_PHASES),
  name: z.string().regex(EVAL_RUN_FAILURE_NAME).optional(),
  exitCode: z.number().int().min(-1).max(255).optional(),
  /** TH1: only with `blocked_connection`: what the eval tried to reach. */
  blocked: EvalBlockedReachSchema.optional(),
  /** The redacted tail of the command's own output. Untrusted text: it is shown only through `inertEvidenceText`. */
  tail: z.string().max(EVAL_RUN_TAIL_MAX_CHARS),
}).strict().refine(d => (d.code === "missing_package" || d.code === "missing_file" || d.code === "command_not_found") || d.name === undefined, "a name belongs to the codes that name something")
  .refine(d => (d.code === "blocked_connection") === (d.blocked !== undefined), "a blocked connection names what it tried to reach, and only it does");
export type EvalRunDiagnostic = z.infer<typeof EvalRunDiagnosticSchema>;

/**
 * The fixed sentence for a cause, WITHOUT the "Not run: " lead. `named: false` is the public wording (counts-only views carry no name). A name is quoted only when it matches the allow-list shape.
 */
export function evalRunFailureSentence(diagnostic: Pick<EvalRunDiagnostic, "code" | "exitCode" | "name"> & { blocked?: EvalBlockedReach | undefined }, options: { named?: boolean } = {}): string {
  // The name is also made inert (belt and braces: the shape has no `@`, `[`, `<` or `:`).
  const name = options.named !== false && diagnostic.name !== undefined && EVAL_RUN_FAILURE_NAME.test(diagnostic.name) ? inertEvidenceText(diagnostic.name, 80) : undefined;
  const exit = diagnostic.exitCode !== undefined && Number.isInteger(diagnostic.exitCode) && diagnostic.exitCode >= -1 && diagnostic.exitCode <= 255 ? diagnostic.exitCode : undefined;
  switch (diagnostic.code) {
    case "missing_package": return name === undefined ? "the eval couldn't import a package that is not installed (missing package)" : `the eval couldn't import '${name}' (missing package)`;
    case "missing_file": return name === undefined ? "the eval couldn't find a file it needs (missing file)" : `the eval couldn't find the file '${name}' (missing file)`;
    case "command_not_found": return name === undefined ? "the eval command was not found in the sandbox" : `the eval command '${name}' was not found in the sandbox`;
    case "install_failed": return exit === undefined ? "the project's install step failed before the eval ran" : `the project's install step failed (exit ${String(exit)}) before the eval ran`;
    case "install_timed_out": return "the project's install step ran out of time before the eval ran";
    case "run_timed_out": return "the eval ran out of time";
    case "blocked_connection": return evalBlockedReachClause(diagnostic.blocked, options.named !== false);
    case "exited": return exit === undefined ? "the eval command stopped before it wrote results" : `the eval command stopped with exit code ${String(exit)} before it wrote results`;
  }
}

/**
 * TH1: the fixed clause for a blocked connection, WITHOUT the "Not run: " lead and WITHOUT a final full stop (callers add them): "your eval tried to reach a database (port 5432) and an outside service
 * (api.example.com). Rovara's sealed check can't reach those yet". `named: false` (the public view) says the kinds only: no port, no host. Anything that is not a valid list gets the kind-less sentence. Never
 * echoes free text: a port is an integer and a host passed the allow-list shape (and is made inert).
 */
export function evalBlockedReachClause(blocked: EvalBlockedReach | undefined, named = true): string {
  const read = EvalBlockedReachSchema.safeParse(blocked);
  if (!read.success) return "your eval tried to reach something other than the model. Rovara's sealed check can't reach that yet";
  const databases = read.data.items.filter((i): i is Extract<typeof i, { kind: "database" }> => i.kind === "database");
  const services = read.data.items.filter((i): i is Extract<typeof i, { kind: "service" }> => i.kind === "service");
  const hosts = named ? [...new Set(services.flatMap(i => (i.host === undefined ? [] : [inertEvidenceText(i.host, EVAL_BLOCKED_HOST_MAX_CHARS)])))] : [];
  const serviceCount = named ? hosts.length + services.filter(i => i.host === undefined).length : services.length;
  const ports = [...new Set(databases.flatMap(i => (i.port === undefined ? [] : [i.port])))];
  const parts: string[] = [];
  if (databases.length > 0) {
    const many = databases.length > 1;
    parts.push(`${many ? "databases" : "a database"}${named && ports.length > 0 ? ` (${ports.length > 1 ? "ports" : "port"} ${ports.join(", ")})` : ""}`);
  }
  if (serviceCount > 0) parts.push(`${serviceCount > 1 ? "outside services" : "an outside service"}${hosts.length > 0 ? ` (${hosts.join(", ")})` : ""}`);
  const plural = parts.length > 1 || databases.length > 1 || serviceCount > 1 || read.data.more === true;
  return `your eval tried to reach ${parts.join(" and ")}${read.data.more === true ? ", among others" : ""}. Rovara's sealed check can't reach ${plural ? "those" : "that"} yet`;
}
