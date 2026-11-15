// TE-F2 part A (M2, release 0.5.19; DECISIONS 161): where a scripted model reply came from, and the one rule that says what counts toward "proven with scripted AI replies". TE-B5 and TE-A3 read this file.
//
// Three provenances:
//   `before_task`  the reply was in the project's reply set before the task started (customer-written, made by the setup agent from the customer's fakes, a few capped real recordings, or the prompt and expected shape).
//   `independent`  written during the task by the independent reply agent, which sees only the prompt, the expected answer shape and real examples, never the code change or the tests. It is accepted ONLY through a Rovara-side
//                  channel (a separate delivery, never a file in the sandbox); Part A only defines the value, no store or agent exists yet.
//   `task_made`    written or edited by the coding agent, or anything whose origin cannot be shown. Allowed, never counted.
// Plus two result classes that are not provenances: `failure_pack` (the pack never proves anything) and `unmatched` / `not_served` (no scripted reply was served).
//
// Who decides: the WORKER, from the task's base commit (Part B item 3). A value the sandbox could write never decides provenance: the author-side file form of a reply set has no provenance field at all
// (`model-reply-set.ts` refuses one), and a missing, unknown or oddly spelled value is `task_made` here: fail closed. Pure: no Node module, no network.
export const REPLY_PROVENANCES = ["before_task", "independent", "task_made"] as const;
export type ReplyProvenance = (typeof REPLY_PROVENANCES)[number];
/** What a served call is classed as in the ledger and the evidence. */
export const REPLY_RESULT_CLASSES = ["before_task", "independent", "task_made", "failure_pack", "unmatched", "not_served"] as const;
export type ReplyResultClass = (typeof REPLY_RESULT_CLASSES)[number];
/** The sub-origin of a `before_task` reply (kept as a field: the plan's O71 and DECISIONS 161 list the first four). `repo_file_at_base`: the reply is in a repo file of the task's BASE COMMIT and nothing more is known of who wrote it (the honest default of Part B's loader: a repo file cannot say whether the customer or an earlier task wrote it). */
export const BEFORE_TASK_ORIGINS = ["customer_written", "setup_agent_from_fakes", "real_recording_capped", "prompt_and_expected_shape", "repo_file_at_base"] as const;
export type BeforeTaskOrigin = (typeof BEFORE_TASK_ORIGINS)[number];

const PROVENANCE_SET: ReadonlySet<string> = new Set(REPLY_PROVENANCES);
const CLASS_SET: ReadonlySet<string> = new Set(REPLY_RESULT_CLASSES);

/** Whether a value is exactly one of the three provenances (a string with an exact spelling; nothing inherited, nothing coerced). */
export function isReplyProvenance(value: unknown): value is ReplyProvenance {
  return typeof value === "string" && PROVENANCE_SET.has(value);
}
/** Whether a value is exactly one of the result classes. */
export function isReplyResultClass(value: unknown): value is ReplyResultClass {
  return typeof value === "string" && CLASS_SET.has(value);
}

/**
 * Whether a reply of this provenance or class counts toward "proven with scripted AI replies": `before_task` and `independent` ONLY. `task_made`, `failure_pack`, `unmatched`, `not_served` and any unknown, missing or
 * mis-spelled value are false: fail closed. The failure pack never proves a change, whatever else is true of the call.
 */
export function replyCountsTowardProof(value: unknown): boolean {
  return value === "before_task" || value === "independent";
}

/** The fixed words the evidence and the PR use (code, never data). Nothing scripted is ever called "Real" (DECISIONS 161); recorded real calls have their own label in TE-F8. */
export const REPLY_PROVENANCE_LABELS: Readonly<Record<ReplyResultClass, string>> = {
  before_task: "scripted replies from the project's reply set (written before the task)",
  independent: "scripted replies written independently in this task",
  task_made: "scripted replies added in this task (not counted)",
  failure_pack: "failure pack: informational only, never proof (not counted)",
  unmatched: "not run: no scripted reply for this request (not counted)",
  not_served: "not served by the model helper (not counted)",
};

/** The label of a class; anything unknown gets the `task_made` words (not counted). */
export function replyLabelOf(value: unknown): string {
  return isReplyResultClass(value) ? REPLY_PROVENANCE_LABELS[value] : REPLY_PROVENANCE_LABELS.task_made;
}
