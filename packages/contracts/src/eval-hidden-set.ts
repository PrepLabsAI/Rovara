// TE-F3 (part A): the hidden eval set rules (plan block R7, owner decision O44). A project may keep an eval set the coding agent never sees. The rules here are the whole of what keeps it hidden:
//   1. it is mounted ONLY in the sealed round (`check_sealed`); any other round (the working sandbox, the unsealed check, a round kind nobody knows) is told "not run: the hidden eval set needs the sealed round", and the set is not even opened;
//   2. what goes back to the coding agent from a hidden-set round is PASS OR FAIL per measure, by position, and nothing numeric (a score, even rounded, is a channel a hostile runner could encode hidden cases in): no score, no count, no case id,
//      input, output, name, diff or path (`agentFeedbackFor`, the ONLY exit to the agent). Other rounds get a score and a count of the cases that ran;
//   3. the runner's own words and values never reach the evidence of a hidden-set round: eval-check.ts keeps only measures Rovara's own base round knows, takes their labels from the base record, and keeps no value;
//   4. the mount (check-sandbox.ts) exists only in a round on its own throwaway copy of the workspace, with the working sandbox paused and confirmed; nothing the runner printed in that round goes back to the agent.
// The set itself is stored Rovara-side per project, never in the repository (O37, O40). This file holds the seam (`HiddenEvalSetSource`); no implementation of it reads a repository.
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

/** One measure's entry in the feedback. A round that used a hidden eval set tells pass or fail only; any other round tells a score and a count (the cases that ran, from Rovara's own facts). */
export type EvalFeedbackEntry = { readonly index: number; readonly score: number; readonly count: number } | { readonly index: number; readonly pass: boolean };
/** What the coding agent is told about an eval. */
export interface EvalAgentFeedback {
  readonly measures: ReadonlyArray<EvalFeedbackEntry>;
}

/**
 * The ONLY thing a coding agent is told about an eval round, built field by field from checked values, so no other field of the result (a case id, a label, a sentence) can come along.
 *   - A hidden-set round: PASS OR FAIL per measure, nothing numeric. (A score, even rounded, is a numeric channel: with many measures a hostile runner could encode hidden cases in it.) A measure that was not judged has no entry.
 *   - Any other round: a score (two decimals) and a count per measure, by position. The count is always the number of cases that RAN, from Rovara's facts, never a number the runner wrote.
 * A round that did not run answers an empty list: no score is invented.
 */
export function agentFeedbackFor(result: Pick<EvalCheckResult, "verdicts" | "notRun" | "usedHiddenSet" | "casesRun">): EvalAgentFeedback {
  if (result.notRun !== undefined) return { measures: [] };
  const entries: EvalFeedbackEntry[] = [];
  for (const verdict of result.verdicts) {
    if (result.usedHiddenSet === true) {
      if (verdict.verdict === "no_detectable_change" || verdict.verdict === "better") entries.push({ index: verdict.index, pass: true });
      else if (verdict.verdict === "worse") entries.push({ index: verdict.index, pass: false });
      continue;
    }
    const { head } = verdict;
    if (typeof head !== "number" || !Number.isFinite(head) || !Number.isSafeInteger(result.casesRun) || result.casesRun < 0) continue;
    entries.push({ index: verdict.index, score: Number(head.toFixed(2)), count: result.casesRun });
  }
  return { measures: entries };
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
