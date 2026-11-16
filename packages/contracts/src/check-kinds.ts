// The registry of check kinds and the trust classes of an evidence pack (TE-A2, design testing-build-plan section 3.1; owner decisions O51 and DECISIONS 156).
// A check kind is an id, not a closed list: the v1 pack's eight kinds are registered here, and a new kind (an eval, a benchmark, a visual diff) is one more row. Each row has the words a reader prints,
// the result parts a check of that kind may carry, and whether a passing check of that kind counts toward the proof that the change works (`countsTowardProof`). A kind this build does not know is not an error
// for a READER (`checkKindInfo` gives undefined and `checkKindWords` gives generic words); only the pack WRITER's strict schema refuses it.
// Browser-safe and pure: the only module imported here is the scripted-reply provenance (`model-reply-provenance.ts`), which is itself pure and imports nothing.
import { replyCountsTowardProof } from "./model-reply-provenance.js";

/** The result parts a check can carry. The first four are v1's; `measures` and `pairs` are new in v2. */
export const CHECK_PARTS = ["tests", "coverage", "findings", "migrations", "measures", "pairs"] as const;
export type CheckPart = (typeof CHECK_PARTS)[number];

/** A kind id: lower-case words joined by underscores, so it is safe to print and to use as a key. */
export const CHECK_KIND_ID_PATTERN = /^[a-z][a-z0-9_]{0,39}$/u;

export interface CheckKindInfo {
  readonly id: string;
  /** The word a reader prints before the label ("Tests", "Lint"). */
  readonly words: string;
  /** The parts a check of this kind may carry. */
  readonly parts: readonly CheckPart[];
  /** Whether a passing check of this kind counts toward the proof that the change works. A lint, a type check, a scan, a build or a migration check passes whatever the change is, so it never proves one. */
  readonly countsTowardProof: boolean;
}

const ALL_PARTS: readonly CheckPart[] = CHECK_PARTS;
/** The parts a v1 pack's check can carry. The v1 builder attaches tests, coverage, findings and migrations by what the check's report held, whatever its kind (core/proof/evidence-pack.ts), so every v1 kind allows every one. */
const V1_PARTS: readonly CheckPart[] = ["tests", "coverage", "findings", "migrations"];

/** Replaces: the v1 pack's closed kind list (`CHECK_KINDS` in evidence.ts stays, and every one of its kinds is a row here). */
const REGISTRY_ROWS: CheckKindInfo[] = [
  { id: "test", words: "Tests", parts: [...V1_PARTS, "measures"], countsTowardProof: true },
  { id: "e2e", words: "End-to-end tests", parts: ["tests", "pairs", "measures"], countsTowardProof: true },
  // An eval is never "Proven" (DECISIONS 170): its own labels are "No regression measured (eval)" and "Improved on eval" (see `evalProofLabel`), so it never counts toward the change proof.
  { id: "eval", words: "Eval", parts: ["tests", "measures"], countsTowardProof: false },
  { id: "lint", words: "Lint", parts: V1_PARTS, countsTowardProof: false },
  { id: "typecheck", words: "Type check", parts: V1_PARTS, countsTowardProof: false },
  { id: "security", words: "Security scan", parts: V1_PARTS, countsTowardProof: false },
  { id: "migration", words: "Migrations", parts: V1_PARTS, countsTowardProof: false },
  { id: "build", words: "Build", parts: V1_PARTS, countsTowardProof: false },
  { id: "smoke", words: "Smoke test", parts: [...V1_PARTS, "pairs"], countsTowardProof: false },
  { id: "benchmark", words: "Benchmark", parts: ["measures"], countsTowardProof: false },
  { id: "visual", words: "Visual check", parts: ["pairs"], countsTowardProof: false },
  // TE-F10: old vs new prompt answers on the same inputs, judged by an independent judge. It shows a difference; it never proves that a change works.
  { id: "prompt_side_by_side", words: "Old vs new prompt", parts: ["pairs"], countsTowardProof: false },
  { id: "other", words: "Check", parts: ALL_PARTS, countsTowardProof: false },
];
export const CHECK_KIND_REGISTRY: readonly CheckKindInfo[] = Object.freeze(REGISTRY_ROWS.map((info) => Object.freeze(info)));

const BY_ID: ReadonlyMap<string, CheckKindInfo> = new Map(CHECK_KIND_REGISTRY.map((info) => [info.id, info]));

export function checkKindInfo(id: string): CheckKindInfo | undefined {
  return BY_ID.get(id);
}
export function isRegisteredCheckKind(id: string): boolean {
  return BY_ID.has(id);
}

/** What a reader that does not know the kind prints. */
export const UNKNOWN_CHECK_KIND_WORDS = "Newer check kind";
export function checkKindWords(id: string): string {
  return BY_ID.get(id)?.words ?? UNKNOWN_CHECK_KIND_WORDS;
}

/** The parts in `present` that a check of this kind does not carry. An unregistered kind has no rule, so none are outside it. */
export function partsOutsideKind(id: string, present: readonly string[]): string[] {
  const info = BY_ID.get(id);
  return info === undefined ? [] : present.filter((part) => !(info.parts as readonly string[]).includes(part));
}

// ---- trust classes (O51)

/**
 * How what answered a dependency, or a check, should be trusted. Real: a real service or a vendor test mode answered. Recorded: a recording of a real answer (with the day it was recorded).
 * Simulated: an in-process fake or scripted replies. Made by Rovara: a mock Rovara wrote. No outside calls: the tests called nothing outside the process. A recording is never Real (O11).
 */
export const EVIDENCE_TRUST_CLASSES = ["real", "recorded", "simulated", "made_by_rovara", "no_outside_calls"] as const;
export type EvidenceTrustClass = (typeof EVIDENCE_TRUST_CLASSES)[number];
export const EVIDENCE_TRUST_CLASS_WORDS: Record<EvidenceTrustClass, string> = {
  real: "Real",
  recorded: "Recorded",
  simulated: "Simulated",
  made_by_rovara: "Made by Rovara",
  no_outside_calls: "No outside calls",
};

/** What a change was proven with, when that is not the ordinary way (DECISIONS 156). */
export const PROOF_BASES = ["scripted_ai_replies"] as const;
export type ProofBasis = (typeof PROOF_BASES)[number];
/** An AI product's change counts as proven when the new tests fail on main and pass with the change against scripted model replies. The label is this and never "Real". */
export const AGENT_REPLIES_UNCONFIRMED_WORDS = "proven with scripted replies written in this task: check them";
export const AGENT_REPLIES_DISAGREED_WORDS = "scripted replies written in this task: the real model did not agree";
export const SCRIPTED_AI_PROOF_WORDS = "proven with scripted AI replies";
export const PROOF_BASIS_WORDS: Record<ProofBasis, string> = { scripted_ai_replies: SCRIPTED_AI_PROOF_WORDS };

/** The words for a check's or dependency's trust. A proof basis wins over the trust class, so scripted replies can never read as "Real". Undefined when there is nothing to say. */
export function trustLabelWords(trust: EvidenceTrustClass | undefined, proofBasis?: ProofBasis): string | undefined {
  if (proofBasis !== undefined) return PROOF_BASIS_WORDS[proofBasis];
  return trust === undefined ? undefined : EVIDENCE_TRUST_CLASS_WORDS[trust];
}

// ---- what counts toward the proof, and the words of the first line (TE-A3; O11, O31, O51, DECISIONS 156, 161 as amended by 192a, 169)

/** The first line's words when readiness found the project's CI running on fakes. Words only: the renderer prints them when the pack says so (the field comes with the readiness lane). */
export const CI_USES_FAKES_WORDS = "real check: your CI (uses fakes)";

/**
 * Whether scripted AI replies of this provenance can prove a change: the one rule the Proof table uses (DECISIONS 192a, `proof-table.ts` with `agent-replies.ts`), in the reply set's own words (`REPLY_PROVENANCES`).
 * It is `replyCountsTowardProof` (model-reply-provenance.ts), the one rule: `before_task` counts. `task_made` counts only when the same test also passed on the real model in the final check (`realModel` is "confirmed");
 * unconfirmed, or the real model did not agree, it does not (the Proof table then shows `AGENT_REPLIES_UNCONFIRMED_WORDS` or `AGENT_REPLIES_DISAGREED_WORDS`). `independent` never counts (DEC 192a parks that agent).
 * Any other value, or a status spelled otherwise, never counts (fail closed).
 */
export function scriptedRepliesCountTowardProof(provenance: unknown, realModel?: unknown): boolean {
  return replyCountsTowardProof(provenance, realModel);
}

/** Whether an answer of this trust class can stand behind a proof. A mock Rovara made, or an answer Rovara made up, never does (O31, DECISIONS 169). A class this build does not know, or none, does not count. */
export function trustClassCountsTowardProof(trust: string | undefined): boolean {
  return trust !== undefined && (EVIDENCE_TRUST_CLASSES as readonly string[]).includes(trust) && trust !== "made_by_rovara";
}

/**
 * Whether a passing check counts toward the proof that the change works: its kind proves (`countsTowardProof` of its row), the trust class of what answered it counts, and, when the check names the provenance of the
 * scripted replies it ran against (`replies`), those replies count by `scriptedRepliesCountTowardProof` with the real-model result (`realModel`). A check that names no provenance is judged as the Proof table judges it
 * today. A kind or a proof basis this build does not know does not count.
 */
export function checkCountsTowardProof(check: { kind: string; trust?: string | undefined; proofBasis?: string | undefined; replies?: string | undefined; realModel?: string | undefined }): boolean {
  if (BY_ID.get(check.kind)?.countsTowardProof !== true) return false;
  if (check.trust !== undefined && !trustClassCountsTowardProof(check.trust)) return false;
  if (check.proofBasis !== undefined && !(PROOF_BASES as readonly string[]).includes(check.proofBasis)) return false;
  // Replies whose provenance does not count never prove a change, whether or not the proof basis is stated.
  if (check.replies !== undefined && !scriptedRepliesCountTowardProof(check.replies, check.realModel)) return false;
  return true;
}

// ---- the proof labels (DECISIONS 170; contract only, TE-F3 does the gating)

/**
 * The words a change's proof can carry. "Proven" is a test that fails before the change and passes after. An eval can never yield it: a passing eval is "No regression measured (eval)" or "Improved on eval" (the last
 * shown with its effect size and noise range), and an eval result that does not qualify is shown with its score and a reason, never as a pass.
 */
export const CHANGE_PROOF_LABELS = ["proven", "no_regression_eval", "improved_eval", "worse_eval", "eval_not_qualified"] as const;
export type ChangeProofLabel = (typeof CHANGE_PROOF_LABELS)[number];
export const CHANGE_PROOF_LABEL_WORDS: Record<ChangeProofLabel, string> = {
  proven: "Proven",
  no_regression_eval: "No regression measured (eval)",
  improved_eval: "Improved on eval",
  // The shipped AI evidence label's own words (evidence-ai.ts). A gated, measured regression: a red check like a failing test (DECISIONS 192b).
  worse_eval: "Worse on eval",
  eval_not_qualified: "Eval not qualified",
};

/** Whether a label says the change was shown to work. Only "Proven": an eval label never does. A label this build does not know, or none, does not. */
export function changeProofLabelCountsAsProven(label: string | undefined): boolean {
  return label === "proven";
}
/** Whether a label is a qualified PASSING result (one that passed every guard of DECISIONS 170 A or B, or an ordinary proof). "Worse on eval" (a measured failure), "not qualified", and any label this build does not know, are not. */
export function changeProofLabelQualified(label: string | undefined): boolean {
  return label === "proven" || label === "no_regression_eval" || label === "improved_eval";
}

/** Whether a label fails the check: only "Worse on eval", which is red like a failing test (DECISIONS 192b). A label this build does not know, or none, is not read as a failure here (it is never a pass either). */
export function changeProofLabelFailsCheck(label: string | undefined): boolean {
  return label === "worse_eval";
}

/** Why an eval result does not qualify, in fixed words (never text from a repository or a provider). TE-F3 picks the reason; "not_gated" is what a result with no gate reads as. */
export const EVAL_NOT_QUALIFIED_REASONS = [
  "not_gated", "cannot_detect_drop", "too_few_questions", "cap_hit", "provider_outage", "questions_edited_by_change", "baseline_too_old", "no_coverage_evidence", "judge_not_pinned", "replies_not_independent",
] as const;
export type EvalNotQualifiedReason = (typeof EVAL_NOT_QUALIFIED_REASONS)[number];
export const EVAL_NOT_QUALIFIED_REASON_WORDS: Record<EvalNotQualifiedReason, string> = {
  not_gated: "the result was not gated",
  cannot_detect_drop: "the eval cannot detect the agreed drop",
  too_few_questions: "too few questions",
  cap_hit: "a cap was hit",
  provider_outage: "the provider was unavailable",
  questions_edited_by_change: "the change edited the eval questions, scoring or thresholds",
  baseline_too_old: "the baseline is too old or from another model version",
  no_coverage_evidence: "nothing shows the eval exercised the changed code",
  judge_not_pinned: "the judge is not pinned from before the task",
  replies_not_independent: "the questions or scoring are not independent of the change",
};

/**
 * The label of an eval result, from what the gate (TE-F3) says. A gated "no regression" or "improved" is its own label and never "Proven"; a gated, measured regression is "Worse on eval" (DECISIONS 192b: a red check),
 * never hidden as "not qualified". Anything else, including a result that claims "proven", an outcome this build does not know and a result with no gate, is "not qualified" with a fixed reason: the score is still
 * shown, but never as a pass. TE-F3 still owns the later variants (the "questions the agent could read" wording of DECISIONS 192c and 194(1)).
 */
export function evalProofLabel(input: { outcome?: string | undefined; reason?: string | undefined }): { label: ChangeProofLabel; words: string } {
  if (input.outcome === "no_regression_eval" || input.outcome === "improved_eval" || input.outcome === "worse_eval") return { label: input.outcome, words: CHANGE_PROOF_LABEL_WORDS[input.outcome] };
  const reason = (EVAL_NOT_QUALIFIED_REASONS as readonly string[]).includes(input.reason as string) ? (input.reason as EvalNotQualifiedReason) : "not_gated";
  return { label: "eval_not_qualified", words: `not qualified: ${EVAL_NOT_QUALIFIED_REASON_WORDS[reason]}` };
}
