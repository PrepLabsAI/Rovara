// TE-F8 (release 0.5.19, additive, no callers): which model call is worth recording, by F4's own identity of "a changed prompt".
//
// PURE. Input: a report from F4 (`detectPromptChanges`), strict-parsed here. A request is matched to a changed item by FINGERPRINT: each of its system and prompt text segments is fingerprinted with F4's `fingerprint`
// (normalise whitespace, drop format characters, SHA-256) and compared with the item's `fingerprintAfter` (never `fingerprintBefore`: the old text is not the change). A `model_name` item matches a request whose model equals
// its `after`. Items of the kinds `model_setting`, `tool_schema` and `model_endpoint` are not about an answer and are not planned.
//
//   record    the first call per changed item (the call's key is not stored and one of its items has no recording)
//   replay    a call whose key is already stored
//   scripted  a call matching no changed item, or only items that already have a recording under another key: never a real call
//   miss      (replay-only rounds) a call that matches a changed item and has no recording: "not run: no recording for this request"
//
// A report that is not complete (status `incomplete`, or coverage short of complete) or does not parse records NOTHING: the fixed sentence below, a plan with no calls (fail closed on money).
import { capSentence } from "./model-egress/classify.js";
import { PromptChangeReportSchema, type PromptChangeKind } from "./prompt-change.js";
import { fingerprint, newWork } from "./prompt-change-internal.js";
import { modelPromptSegments, type ModelRequestView } from "./model-record-key.js";

export const RECORDING_NOT_RUN_INCOMPLETE = "not run: the prompt changes could not be read fully";
export const RECORDING_NOT_RUN_UNREADABLE = "not run: the prompt changes could not be read";
export const RECORDING_NOT_RUN_ENDED = "not run: this task has ended, so its recordings are gone";
export const RECORDING_NOT_RUN_MISS = "not run: no recording for this request";
export const RECORDING_NOT_RUN_SCOPE = "not run: the recording scope could not be read";
export const RECORDING_NOT_RUN_STORE = "not run: the recording store could not be read";
export const RECORDING_NOT_RECORDED_NO_CALL = "not recorded: no call matched this changed prompt";
export const RECORDING_NOT_RECORDED_FAILED = "not recorded: the call did not return an answer";
export const RECORDING_NOT_RECORDED_UNSAVED = "not recorded: the recording could not be saved";
export const RECORDING_NOT_RECORDED_WITHHELD = "not recorded: the answer was withheld";
export const RECORDING_NOT_RECORDED_INCOMPLETE = "not recorded: the answer may be incomplete";
export const RECORDING_NOT_RECORDED_TOO_LARGE = "not recorded: the answer was too large to record";
export const recordingLimitSentence = (limit: number): string => `not run: the recording limit for this task was reached (${String(limit)})`;
/** `not run: test model budget reached ($2.00 per task)`, F1-a's sentence. */
export const recordingBudgetSentence = capSentence;

/** The kinds of change whose answer is worth recording. */
export const RECORDABLE_KINDS = ["prompt_text", "system_prompt", "prompt_file", "model_name"] as const satisfies readonly PromptChangeKind[];
export type RecordableKind = (typeof RECORDABLE_KINDS)[number];

export interface PlannedItem {
  /** F4's item id (a hash). */
  readonly id: string;
  readonly kind: RecordableKind;
  /** `fingerprintAfter` for the three prompt kinds. */
  readonly fingerprint?: string;
  /** `after` of a `model_name` item. */
  readonly model?: string;
}
export type RecordingPlan =
  | { readonly status: "ready"; readonly items: readonly PlannedItem[]; /** F4 listed fewer items than changed: the rest are never matched. */ readonly itemsOmitted: boolean }
  | { readonly status: "not_run"; readonly reason: "incomplete" | "unreadable"; readonly sentence: string };

const isRecordable = (kind: string): kind is RecordableKind => (RECORDABLE_KINDS as readonly string[]).includes(kind);

/** The plan for a report. Never throws. */
export function planRecording(report: unknown): RecordingPlan {
  const parsed = PromptChangeReportSchema.safeParse(report);
  if (!parsed.success) return { status: "not_run", reason: "unreadable", sentence: RECORDING_NOT_RUN_UNREADABLE };
  const value = parsed.data;
  if (value.status === "incomplete" || value.coverage !== "complete") return { status: "not_run", reason: "incomplete", sentence: RECORDING_NOT_RUN_INCOMPLETE };
  const items: PlannedItem[] = [];
  for (const item of value.items) {
    if (!isRecordable(item.kind)) continue;
    if (item.kind === "model_name") {
      if (item.after !== undefined) items.push({ id: item.id, kind: item.kind, model: item.after });
    } else if (item.fingerprintAfter !== null) {
      items.push({ id: item.id, kind: item.kind, fingerprint: item.fingerprintAfter });
    }
  }
  return { status: "ready", items, itemsOmitted: value.itemsTruncated };
}

/** The ids of the planned items a request matches, sorted. A `system_prompt` item matches system segments only; the other prompt kinds match any segment. */
export function matchChangedItems(plan: RecordingPlan, view: ModelRequestView): readonly string[] {
  if (plan.status !== "ready" || plan.items.length === 0) return [];
  const segments = modelPromptSegments(view);
  const work = newWork();
  const systemPrints = new Set(segments.system.map((text) => fingerprint(text, work)));
  const anyPrints = new Set([...systemPrints, ...segments.prompt.map((text) => fingerprint(text, work))]);
  const matched = new Set<string>();
  for (const item of plan.items) {
    if (item.kind === "model_name") {
      if (view.model !== undefined && view.model === item.model) matched.add(item.id);
    } else if (item.fingerprint !== undefined && (item.kind === "system_prompt" ? systemPrints : anyPrints).has(item.fingerprint)) {
      matched.add(item.id);
    }
  }
  return [...matched].sort();
}

export type RecordingMode = "record" | "replay_only";
export type RecordDecision =
  | { readonly action: "record"; readonly itemIds: readonly string[] }
  | { readonly action: "replay"; readonly itemIds: readonly string[] }
  | { readonly action: "scripted"; readonly itemIds: readonly string[] }
  | { readonly action: "miss"; readonly itemIds: readonly string[] };

/** What the store already holds, as hashes only. */
export interface StoredRecordings {
  readonly keys: ReadonlySet<string>;
  readonly itemIds: ReadonlySet<string>;
}

/** The decision for one request: see the file comment. Pure. */
export function decideRecording(args: { readonly matched: readonly string[]; readonly key: string; readonly stored: StoredRecordings; readonly mode: RecordingMode }): RecordDecision {
  const { matched, key, stored, mode } = args;
  if (matched.length === 0) return { action: "scripted", itemIds: matched };
  if (stored.keys.has(key)) return { action: "replay", itemIds: matched };
  if (mode === "replay_only") return { action: "miss", itemIds: matched };
  return matched.some((id) => !stored.itemIds.has(id)) ? { action: "record", itemIds: matched } : { action: "scripted", itemIds: matched };
}
