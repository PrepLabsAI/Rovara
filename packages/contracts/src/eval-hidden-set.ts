// Private-set boundary: only a sealed check may open the source and obtain its read-only mount.
// Public repo questions return inert question/answer evidence. A private round returns one fixed
// pass/fail (or Not run), with no identities, positions, scores, counts, answers or extra fields.
// The source is Rovara-side; this module never discovers a hidden slice inside a repository.
import { canonicalJson } from "./canonical-json.js";
import type { EvalCheckResult } from "./eval-check.js";
import { sha256HexOf } from "./service-catalog-verify.js";

/** The rounds an eval check can run in (the same words as the model-call ledger's round kinds). Only `check_sealed` has no route out. */
export const EVAL_ROUND_KINDS = ["working", "check_unsealed", "check_sealed"] as const;
export type EvalRoundKind = (typeof EVAL_ROUND_KINDS)[number];

export const HIDDEN_EVAL_NEEDS_SEALED_SENTENCE = "not run: the hidden eval set needs the sealed round";
/** Where the sealed check sandbox sees the hidden set, read-only. */
export const HIDDEN_EVAL_MOUNT_PATH = "/rovara/hidden-eval";

/** Where Rovara keeps a project's hidden set. `exists` tells that a set is kept (it opens nothing); `open` is called only for the sealed round, and answers a host path and the set's SHA-256, never its contents. */
export interface HiddenEvalSetSource {
  exists(): Promise<boolean>;
  open(): Promise<{ readonly hostPath: string; readonly hash: string }>;
}

export interface HiddenEvalMount {
  readonly hostPath: string;
  readonly containerPath: typeof HIDDEN_EVAL_MOUNT_PATH;
  readonly readOnly: true;
}
export type HiddenEvalSetAnswer =
  | { readonly status: "none" }
  | { readonly status: "needs_sealed_round"; readonly sentence: typeof HIDDEN_EVAL_NEEDS_SEALED_SENTENCE }
  | { readonly status: "unavailable" }
  | { readonly status: "mounted"; readonly hash: string; readonly mount: HiddenEvalMount };

const PLAIN_HOST_PATH = /^\/[A-Za-z0-9_./-]{1,500}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const plainPath = (path: unknown): path is string => typeof path === "string" && PLAIN_HOST_PATH.test(path) && path.split("/").every((part) => part !== ".." && part !== ".");

/**
 * What a round does about a project's hidden set. Only the exact word `check_sealed` opens it; everything else (a working sandbox, an unsealed check, a misspelt or missing kind) answers `needs_sealed_round` when a set is kept
 * and without opening it. In the sealed round a source that fails, or answers a path that is not a plain absolute path or a hash that is not a SHA-256, is `unavailable`: nothing is mounted on a guess.
 */
export async function hiddenEvalSetFor(roundKind: EvalRoundKind, source: HiddenEvalSetSource): Promise<HiddenEvalSetAnswer> {
  try {
    if (!(await source.exists())) return { status: "none" };
    if (roundKind !== "check_sealed") return { status: "needs_sealed_round", sentence: HIDDEN_EVAL_NEEDS_SEALED_SENTENCE };
    const opened = await source.open();
    if (!plainPath(opened.hostPath) || typeof opened.hash !== "string" || !SHA256_HEX.test(opened.hash)) return { status: "unavailable" };
    return { status: "mounted", hash: opened.hash, mount: { hostPath: opened.hostPath, containerPath: HIDDEN_EVAL_MOUNT_PATH, readOnly: true } };
  } catch {
    return { status: "unavailable" };
  }
}

/** Public questions carry inert answers; private results expose one fixed pass/fail only. */
export type EvalAgentFeedback = { readonly pass: boolean } | { readonly questions: EvalCheckResult["questions"] } | { readonly notRun: true };
export function agentFeedbackFor(result: EvalCheckResult): EvalAgentFeedback {
  if (result.outcome === "not_run") return { notRun: true };
  if (result.usedHiddenSet) return { pass: result.label !== "Worse on eval" };
  return { questions: result.questions.map(q => ({ id: q.id, change: q.change, oldAnswers: [...q.oldAnswers], newAnswers: [...q.newAnswers] })) };
}

const EVAL_SET_HASH_DOMAIN = "rovara-eval-set/v1\n";
const EVAL_SET_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0\\]{1,500}$/u;

/**
 * Rovara's OWN hash of an eval set: SHA-256 over a fixed domain and the sorted (path, SHA-256 of content) pairs of the eval files. The hash is computed by Rovara from the files, never read from a value the runner wrote (a runner
 * could claim any hash). Throws RangeError on a path that is absolute, has `..` or `.` parts, or is listed twice, or on no files at all.
 */
export function evalSetHashOf(files: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>): string {
  if (files.length === 0) throw new RangeError("an eval set has at least one file");
  const rows = files.map((file) => {
    if (typeof file.path !== "string" || !EVAL_SET_PATH.test(file.path)) throw new RangeError("an eval file path is relative and plain");
    return [file.path, sha256HexOf(file.bytes)] as const;
  }).sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  for (let index = 1; index < rows.length; index += 1) if (rows[index]![0] === rows[index - 1]![0]) throw new RangeError("an eval file is listed twice");
  return sha256HexOf(new TextEncoder().encode(`${EVAL_SET_HASH_DOMAIN}${canonicalJson(rows)}`));
}
