// TE-F3-b: a LOCAL MIRROR of A3-2's label contract (branch pr/te-a3-trust-classes-2 @ 7b440ce01, `check-kinds.ts`: `CHANGE_PROOF_LABELS`, `CHANGE_PROOF_LABEL_WORDS`, `EVAL_NOT_QUALIFIED_REASONS`, `EVAL_NOT_QUALIFIED_REASON_WORDS`,
// `evalProofLabel`). A3-2 is not in this lane's base, so the same names, the same words and the same function are copied here, and NOTHING in the package index re-exports this file (so the day A3 merges there is no duplicate
// export). A DEFERRED row says: after both merge, delete this file and import A3's. An eval NEVER yields "proven": the only outcomes this file turns into labels are `no_regression_eval` and `improved_eval`.

export const CHANGE_PROOF_LABELS = ["proven", "no_regression_eval", "improved_eval", "eval_not_qualified"] as const;
export type ChangeProofLabel = (typeof CHANGE_PROOF_LABELS)[number];
export const CHANGE_PROOF_LABEL_WORDS: Record<ChangeProofLabel, string> = {
  proven: "Proven",
  no_regression_eval: "No regression measured (eval)",
  improved_eval: "Improved on eval",
  eval_not_qualified: "Eval not qualified",
};

/** Whether a label says the change was shown to work. Only "Proven": an eval label never does. */
export function changeProofLabelCountsAsProven(label: string | undefined): boolean {
  return label === "proven";
}
/** Whether a label is a qualified result (one that passed every guard of DECISIONS 170 A or B, or an ordinary proof). "Not qualified", and any label this build does not know, is not. */
export function changeProofLabelQualified(label: string | undefined): boolean {
  return label === "proven" || label === "no_regression_eval" || label === "improved_eval";
}

/** Why an eval result does not qualify, in fixed words (never text from a repository or a provider). */
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

/** The label of an eval result, from what the gate says. Anything but a gated "no regression" or "improved" is "not qualified" with a fixed reason. */
export function evalProofLabel(input: { outcome?: string | undefined; reason?: string | undefined }): { label: ChangeProofLabel; words: string } {
  if (input.outcome === "no_regression_eval" || input.outcome === "improved_eval") return { label: input.outcome, words: CHANGE_PROOF_LABEL_WORDS[input.outcome] };
  const reason = (EVAL_NOT_QUALIFIED_REASONS as readonly string[]).includes(input.reason as string) ? (input.reason as EvalNotQualifiedReason) : "not_gated";
  return { label: "eval_not_qualified", words: `not qualified: ${EVAL_NOT_QUALIFIED_REASON_WORDS[reason]}` };
}
