// TE-F3 (part A): the hidden eval set rules (plan block R7, owner decision O44). A project may keep an eval set the coding agent never sees. The rules here are the whole of what keeps it hidden:
//   1. it is mounted ONLY in the sealed round (`check_sealed`); any other round (the working sandbox, the unsealed check, a round kind nobody knows) is told "not run: the hidden eval set needs the sealed round", and the set is not even opened;
//   2. what goes back to the coding agent is a score and a count per measure, by position, and nothing else: no case id, input, output, name, diff or path (`agentFeedbackFor`, the ONLY exit to the agent);
//   3. the runner's own words (measure names and units) never reach the evidence of a hidden-set round (eval-check.ts takes them from the base record, which Rovara's own base round wrote).
// The set itself is stored Rovara-side per project, never in the repository (O37, O40). This file holds the seam (`HiddenEvalSetSource`); no implementation of it reads a repository.
import type { EvalCheckResult } from "./eval-check.js";

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

/** What the coding agent is told about an eval: one entry per measure that was scored, by position. */
export interface EvalAgentFeedback {
  readonly measures: ReadonlyArray<{ readonly index: number; readonly score: number; readonly count: number }>;
}

/**
 * The ONLY thing a coding agent is told about an eval round: a score (rounded to two decimals, so the exact value is not handed out digit by digit) and a count per measure, by position. Built field by field from the checked
 * numbers of the result, so no other field of the result (a case id, a label, a sentence) can come along. A round that did not run answers an empty list: no score is invented.
 */
export function agentFeedbackFor(result: Pick<EvalCheckResult, "verdicts" | "notRun">): EvalAgentFeedback {
  if (result.notRun !== undefined) return { measures: [] };
  const measures: Array<{ index: number; score: number; count: number }> = [];
  for (const verdict of result.verdicts) {
    const { head, count } = verdict;
    if (typeof head !== "number" || !Number.isFinite(head) || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) continue;
    measures.push({ index: verdict.index, score: Number(head.toFixed(2)), count });
  }
  return { measures };
}
