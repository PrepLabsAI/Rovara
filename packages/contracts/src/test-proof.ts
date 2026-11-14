// TESTPROOF: does the change's new or changed test fail on the original code? The worker writes test-proof.json at the end of a
// CHECKS run; the broker reads it at publication and shows one or two lines in the pull request. Informational only: it never
// changes a check result, never blocks and never sends the work back.
import { z } from "zod";
import { TEST_ID_MAX } from "./test-id.js";

export const TEST_PROOF_ARTIFACT = "test-proof.json";

/**
 * proves_change: failed with an assertion on the original code and passes now.
 * could_not_run_on_old: failed to load or compile on the original code (a missing file or symbol), or failed in a way AgentX could not tell.
 * does_not_prove: also passes on the original code (a warning).
 * not_checked: a timeout, a stop or an infrastructure fault, so nothing is known.
 * not_applicable: the check is not a test runner (a linter, a type check): it is neither counted nor warned about.
 */
export const TestProofVerdictSchema = z.enum(["proves_change", "could_not_run_on_old", "does_not_prove", "not_checked", "not_applicable"]);
export type TestProofVerdict = z.infer<typeof TestProofVerdictSchema>;

/** Fixed codes only: no command output or error text is ever stored here. */
export const TestProofReasonSchema = z.enum([
  "assertion_failed_on_old",
  "load_failure_on_old",
  "unrecognized_failure_on_old",
  "passed_on_old",
  "test_missing_on_old",
  "timed_out",
  "stopped",
  "budget",
  "infrastructure",
  "not_passed_on_new",
  "not_a_test_check",
]);
export type TestProofReason = z.infer<typeof TestProofReasonSchema>;

export const TestProofItemSchema = z.object({
  checkId: z.string().min(1).max(64),
  /** The check's label, redacted by the worker. */
  label: z.string().min(1).max(1_024),
  /** `check`: one verdict for the whole check. `test`: one per test, from a JUnit or JSON report the check already writes. */
  granularity: z.enum(["check", "test"]),
  /** The test's name, for a `test` item. */
  test: z.string().min(1).max(TEST_ID_MAX).optional(),
  verdict: TestProofVerdictSchema,
  reason: TestProofReasonSchema,
}).strict();
export type TestProofItem = z.infer<typeof TestProofItemSchema>;

export const TestProofSchema = z.object({
  schemaVersion: z.literal(1),
  /** The candidate digest of the code the checks passed on. A proof for any other digest is ignored. */
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  /** no_changed_tests: nothing was run. checked: the checks ran on the original code with the new tests. not_checked: the run could not be made. */
  status: z.enum(["no_changed_tests", "checked", "not_checked"]),
  note: z.enum(["no_changed_tests", "no_project_checks", "no_passing_checks", "no_test_checks", "budget", "completed", "timed_out", "stopped", "original_code_unavailable"]),
  changedTests: z.object({ added: z.number().int().nonnegative(), changed: z.number().int().nonnegative(), deleted: z.number().int().nonnegative() }).strict(),
  items: z.array(TestProofItemSchema).max(200),
  durationMs: z.number().int().nonnegative(),
}).strict();
export type TestProof = z.infer<typeof TestProofSchema>;

// ---- TE-B5: the change proof holds the draft (testing plan O2, O30, O43; DECISIONS 161)
//
// `proofHolds` is the pure ready rule: from the facts about one change it says whether the pull request stays a draft, and why. It never reads a store, a clock or a person. The broker's tracking pass supplies the facts
// (`core/merge/proof-hold.ts`) and the preset's mode. Only an assertion failure on the old code counts as proven (the verdicts above); a failed load, a timeout or no proof at all is "not proven" and never holds by itself,
// because a Rovara fault must not block a customer's merge. Proof shape by change type (TE-B10) is a later seam: `ProofHoldFacts` is where it will add what counts.
import { checkKindInfo, type ProofBasis } from "./check-kinds.js";
import type { EvidencePackV2 } from "./evidence.js";

/** Why a draft is held. Fixed codes: nothing a test, a repository or a model wrote is ever stored as a reason. */
export const PROOF_HOLD_REASONS = ["proof_failed", "changed_code_not_run", "test_absent_on_new", "flaky_on_change"] as const;
export type ProofHoldReason = (typeof PROOF_HOLD_REASONS)[number];
export const ProofHoldReasonSchema = z.enum(PROOF_HOLD_REASONS);

/** The words for each reason, in the order a person reads them on the task page and the pull request. Never a test's own name. */
export const PROOF_HOLD_WORDS: Readonly<Record<ProofHoldReason, string>> = Object.freeze({
  proof_failed: "the new tests pass on the old code too",
  changed_code_not_run: "no test ran the changed code",
  test_absent_on_new: "a test that ran on the old code is missing from the new code",
  flaky_on_change: "a test is flaky on this change but passed on the base",
});
/** "Held as a draft: the new tests pass on the old code too; no test ran the changed code." Empty for no reasons. */
export function proofHoldLine(reasons: readonly ProofHoldReason[]): string {
  const words = reasons.map((reason) => PROOF_HOLD_WORDS[reason]);
  return words.length === 0 ? "" : `Held as a draft: ${words.join("; ")}.`;
}

/**
 * Where the scripted replies a proving test ran against came from. DEC 192a removes the draft hold for every origin;
 * origins still qualify the proof as scripted. Whether the real model confirms a proof is a separate rule.
 */
export const REPLY_ORIGINS = ["before_task", "independent_agent", "coding_agent", "failure_pack", "unknown"] as const;
export type ReplyOrigin = (typeof REPLY_ORIGINS)[number];
/** The labels the pull request shows for each origin. Scripted replies are never "Real". */
export const REPLY_ORIGIN_WORDS: Readonly<Record<ReplyOrigin, string>> = Object.freeze({
  before_task: "scripted replies from before the task",
  independent_agent: "scripted replies written independently in this task",
  coding_agent: "scripted replies written in this task",
  failure_pack: "failure-pack replies (never proof)",
  unknown: "scripted replies of unknown origin (not counted)",
});

/** What the hold rule reads about one change. Everything is optional: what is unknown never holds. */
export interface ProofHoldFacts {
  /** The same-task before-run (`test-proof.json`), already checked to be for the current candidate. */
  proof?: TestProof | undefined;
  /** Each check's kind id, by check id: only a registered kind that counts toward the proof counts (check-kinds.ts `countsTowardProof`). A check with no entry here is a test check by construction. */
  checkKinds?: Readonly<Record<string, string>> | undefined;
  /** The checks whose proof rests on scripted AI replies, with where the replies came from. Absent for a check that ran against anything else. */
  scriptedReplies?: Readonly<Record<string, string>> | undefined;
  /** Changed source lines and how many of them a run executed (coverage). Unknown when no coverage report exists. */
  changedLines?: { changed: number; covered: number } | undefined;
  /** Tests that ran on the old code and are absent on the new (TE-B3's `absentOnNew`). Names are counted, never printed. */
  absentOnNew?: readonly string[] | undefined;
  /** Tests that are flaky on the change but passed on the base (TE-C6's rerun; not live until that lane lands). */
  flakyOnChange?: readonly string[] | undefined;
}

/** `off`: the gate is off, nothing is said. `warn`: say it, never hold (Lightweight). `hold`: hold the draft (Balanced, Careful). */
export type ProofHoldMode = "off" | "warn" | "hold";
/** O43: the window the hold rate is judged on, and the share above which the hold relaxes to a warning. */
export const PROOF_HOLD_WINDOW = 20;
export const PROOF_HOLD_RELAX_ABOVE = 0.1;
/** How many of a project's recent pull requests were held, out of how many were judged (at most `PROOF_HOLD_WINDOW`). */
export interface ProofHoldHistory {
  held: number;
  total: number;
}

/** Whether more than 10% of the project's last 20 pull requests were held. A project with fewer than 20 is judged against the whole window, so two early holds do not switch the rule off. Garbage history never relaxes. */
export function proofHoldRelaxes(recent: ProofHoldHistory | undefined): boolean {
  if (recent === undefined || !Number.isInteger(recent.held) || !Number.isInteger(recent.total)) return false;
  if (recent.held < 0 || recent.total < 0 || recent.total > PROOF_HOLD_WINDOW || recent.held > recent.total) return false;
  return recent.held / Math.max(recent.total, PROOF_HOLD_WINDOW) > PROOF_HOLD_RELAX_ABOVE;
}

export interface ProofHoldDecision {
  /** The draft stays a draft. */
  holds: boolean;
  /** The rule would hold but only says so (the preset is `warn`, or the hold relaxed). */
  warns: boolean;
  /** The rule's own verdict before the mode and the relaxation: what the hold history counts. */
  wouldHold: boolean;
  /** The hold turned into a warning because more than 10% of the project's recent pull requests were held. */
  relaxed: boolean;
  reasons: ProofHoldReason[];
  /** Proving tests for the hold rule: an assertion failure on the old code, from a check that counts, regardless of reply origin. */
  provenCount: number;
  /** Tests that could not load on the old code (for the pack's proof section). */
  loadFailureOnOld: number;
  /** Set when a counted proof rests on scripted AI replies: the label is "proven with scripted AI replies", never "Real". */
  proofBasis?: ProofBasis | undefined;
  /** The verdicts the decision read, as the pack's proof section lists them. */
  verdicts: Array<{ checkId: string; testId?: string; verdict: TestProofVerdict; reason: TestProofReason }>;
}

const OWN = (record: Readonly<Record<string, string>> | undefined, key: string): string | undefined => (record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined);
const finiteCount = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

/**
 * The ready rule: whether the draft is held. Pure. `mode` is the preset's (`off` when the gate is off); `recent` is the project's hold history, which relaxes `hold` to a warning above 10% (O43).
 * Hold reasons are `proof_failed` (every counted test also passes on the old code), `changed_code_not_run` (coverage says no test ran any changed line), `test_absent_on_new` and `flaky_on_change`.
 * Scripted reply origins never hold a draft (DEC 192a). Replaces: the proof being informational only (the file header's old words).
 */
export function proofHolds(input: { facts: ProofHoldFacts; mode: ProofHoldMode; recent?: ProofHoldHistory | undefined }): ProofHoldDecision {
  const { facts } = input;
  let provenCount = 0;
  let vacuous = 0;
  let loadFailureOnOld = 0;
  let scriptedProof = false;
  const proof = facts.proof;
  if (proof !== undefined && proof.status === "checked") {
    for (const entry of proof.items) {
      if (entry.verdict === "not_applicable" || entry.verdict === "not_checked") continue;
      const kind = OWN(facts.checkKinds, entry.checkId);
      // A check whose kind is registered and does not count toward the proof (a lint), or one this build does not know, never proves a change.
      if (kind !== undefined && checkKindInfo(kind)?.countsTowardProof !== true) continue;
      if (entry.verdict === "could_not_run_on_old") loadFailureOnOld += 1;
      else if (entry.verdict === "does_not_prove") vacuous += 1;
      else {
        const origin = OWN(facts.scriptedReplies, entry.checkId);
        provenCount += 1;
        if (origin !== undefined) scriptedProof = true;
      }
    }
  }
  const reasons: ProofHoldReason[] = [];
  if (proof?.status === "checked" && provenCount === 0 && vacuous > 0) reasons.push("proof_failed");
  const changed = finiteCount(facts.changedLines?.changed);
  if (changed > 0 && finiteCount(facts.changedLines?.covered) === 0) reasons.push("changed_code_not_run");
  if ((facts.absentOnNew?.length ?? 0) > 0) reasons.push("test_absent_on_new");
  if ((facts.flakyOnChange?.length ?? 0) > 0) reasons.push("flaky_on_change");

  const verdicts = (proof?.items ?? []).map((entry) => ({ checkId: entry.checkId, ...(entry.test === undefined ? {} : { testId: entry.test }), verdict: entry.verdict, reason: entry.reason }));
  const base = { reasons, provenCount, loadFailureOnOld, verdicts, ...(scriptedProof ? { proofBasis: "scripted_ai_replies" as const } : {}) };
  const wouldHold = input.mode !== "off" && reasons.length > 0;
  if (!wouldHold) return { holds: false, warns: false, wouldHold: false, relaxed: false, ...base, reasons: input.mode === "off" ? [] : reasons };
  if (input.mode === "warn") return { holds: false, warns: true, wouldHold: true, relaxed: false, ...base };
  const relaxed = proofHoldRelaxes(input.recent);
  return { holds: !relaxed, warns: relaxed, wouldHold: true, relaxed, ...base };
}

/** The part of a check (of a v1 pack, `checkId`, or a v2 pack, `id`) the hold rule reads. */
export interface ProofHoldCheck {
  id?: string | undefined;
  checkId?: string | undefined;
  kind?: string | undefined;
  coverage?: { linesChanged: number; linesCovered: number } | undefined;
  proofBasis?: string | undefined;
}

/**
 * The hold rule's facts from what the broker already has: the same-task before-run, the pack's checks (v1 or v2) and the v2 weakening list. Changed lines are summed over the checks that carry a coverage report; with none
 * the answer is "unknown" and never holds. A check whose proof rests on scripted AI replies gets the origin `replyOrigins` names for it, and `unknown` when nothing names one: the reply set that records where replies
 * came from is optional. Every origin counts for the hold rule, while the scripted basis remains visible (DEC 192a).
 */
export function proofHoldFactsOf(input: {
  proof?: TestProof | undefined;
  checks?: readonly ProofHoldCheck[] | undefined;
  absentOnNew?: readonly string[] | undefined;
  flakyOnChange?: readonly string[] | undefined;
  replyOrigins?: Readonly<Record<string, string>> | undefined;
}): ProofHoldFacts {
  const checkKinds: Record<string, string> = Object.create(null) as Record<string, string>;
  const scriptedReplies: Record<string, string> = Object.create(null) as Record<string, string>;
  let changed = 0;
  let covered = 0;
  let anyCoverage = false;
  for (const check of input.checks ?? []) {
    const id = check.id ?? check.checkId;
    if (id === undefined) continue;
    if (check.kind !== undefined) checkKinds[id] = check.kind;
    if (check.proofBasis !== undefined) scriptedReplies[id] = OWN(input.replyOrigins, id) ?? "unknown";
    if (check.coverage !== undefined) {
      anyCoverage = true;
      changed += finiteCount(check.coverage.linesChanged);
      covered += finiteCount(check.coverage.linesCovered);
    }
  }
  return {
    ...(input.proof === undefined ? {} : { proof: input.proof }),
    checkKinds,
    scriptedReplies,
    ...(anyCoverage ? { changedLines: { changed, covered } } : {}),
    ...(input.absentOnNew === undefined ? {} : { absentOnNew: input.absentOnNew }),
    ...(input.flakyOnChange === undefined ? {} : { flakyOnChange: input.flakyOnChange }),
  };
}

/** Who pressed "mark ready anyway", when, and why (the reason stays optional, O59). The pack's `proof.override`. */
export interface ProofOverride {
  actorId: string;
  at: string;
  reason?: string | undefined;
}

/** The v2 pack's proof section for a decision: the verdicts, the counts, whether the draft was held, and the override. For the pack writer (TE-A2b); nothing here stores anything. */
export function proofSectionOf(decision: ProofHoldDecision, override?: ProofOverride): NonNullable<EvidencePackV2["proof"]> {
  return {
    verdicts: decision.verdicts.map((entry) => ({ ...entry })),
    provenCount: decision.provenCount,
    loadFailureOnOld: decision.loadFailureOnOld,
    heldDraft: decision.holds,
    ...(override === undefined ? {} : { override: { actorId: override.actorId, at: override.at, ...(override.reason === undefined || override.reason === "" ? {} : { reason: override.reason }) } }),
  };
}
