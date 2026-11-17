// Failure causes (TE-A6 Parts B and C, DEC 254zt): the wire form of what `attributeFailures` (failure-attribution.ts) says about a check's failing tests, and the words a pull request or report carries for it.
// The worker joins each failing test to the change (file and commit) that most likely broke it, or says "unknown", and writes the result as its own small file (`failure-causes.json`) beside `evidence-raw.json`. The broker
// reads the file as UNTRUSTED input (bound to the candidate's digest and to the check's own failing tests, every text redacted again) and keeps a check's causes in its `tests` part (`failureCauses`).
// A pack without the field reads and renders exactly as it always did: the per-check line is the fallback whenever there is no per-test data.
// Only fixed words, test ids and changed file paths and commit ids ever appear: nothing from a failure's own text. Browser-safe: nothing here imports a Node module.
import { z } from "zod";
import { FAILURE_ATTRIBUTION_LIMITS, FAILURE_SIGNALS, FAILURE_UNKNOWN_REASONS, FAILURE_UNKNOWN_WORDS } from "./failure-attribution.js";
import { TEST_ID_MAX } from "./test-id.js";

export const FAILURE_CAUSES_ARTIFACT = "failure-causes.json";
export const FAILURE_CAUSES_FILE_MAX_BYTES = 256 * 1024;
/** The most checks one file carries causes for (a pack has at most 64 checks). */
export const FAILURE_CAUSES_CHECKS_MAX = 64;

const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
const line = (max: number) => z.string().min(1).max(max).regex(NO_HIDDEN, "one plain line");

export const FailureCauseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("change"),
    /** The changed files the failure points at (at most `pathsShown`), sorted. */
    paths: z.array(line(FAILURE_ATTRIBUTION_LIMITS.pathMax)).min(1).max(FAILURE_ATTRIBUTION_LIMITS.pathsShown),
    /** How many files in all (at least those listed). */
    pathsCount: z.number().int().min(1).max(FAILURE_ATTRIBUTION_LIMITS.changesMax),
    commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u, "a commit id").optional(),
    basis: z.array(z.enum(FAILURE_SIGNALS)).min(1).max(FAILURE_SIGNALS.length),
  }).strict().refine((cause) => cause.pathsCount >= cause.paths.length, "the count is at least the files listed"),
  z.object({ kind: z.literal("unknown"), reason: z.enum(FAILURE_UNKNOWN_REASONS) }).strict(),
]);
export type FailureCauseWire = z.infer<typeof FailureCauseSchema>;

/** One failing test and the cause found for it. At most `failuresMax` in a check: past that the worker writes none (the check keeps its per-check line). */
export const FailureCausesSchema = z.array(z.object({ testId: line(TEST_ID_MAX), cause: FailureCauseSchema }).strict()).max(FAILURE_ATTRIBUTION_LIMITS.failuresMax);
export type FailureCauses = z.infer<typeof FailureCausesSchema>;

/** The file the worker writes. Bound to the digest of the code the checks ran on; the broker ignores a file for any other code. */
export const FailureCausesFileSchema = z.object({
  schemaVersion: z.literal(1),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  checks: z.array(z.object({ checkId: line(64), causes: FailureCausesSchema.min(1) }).strict()).max(FAILURE_CAUSES_CHECKS_MAX),
}).strict().refine((file) => new Set(file.checks.map((check) => check.checkId)).size === file.checks.length, "a check has one entry");
export type FailureCausesFile = z.infer<typeof FailureCausesFileSchema>;

/**
 * The part of a pull request line for one failing test, from a cause: the test id and then the change that most likely broke it, or "unknown" and why. `inert` makes every repository-written word safe (the renderer's own
 * `inertEvidenceText`); the commit is shown as its first 7 characters. The words are fixed here.
 */
export function failureCauseWords(cause: FailureCauseWire, inert: (text: string, max: number) => string): string {
  if (cause.kind === "unknown") return `unknown (${Object.hasOwn(FAILURE_UNKNOWN_WORDS, cause.reason) ? FAILURE_UNKNOWN_WORDS[cause.reason] : "not known"})`;
  const files = cause.paths.map((path) => inert(path, 120)).join(", ");
  const more = cause.pathsCount - cause.paths.length;
  const where = `${files}${more > 0 ? ` and ${String(more)} more ${more === 1 ? "file" : "files"}` : ""}`;
  return `likely broken by a change${cause.commit === undefined ? "" : ` (commit ${cause.commit.slice(0, 7)})`} to ${where}`;
}
