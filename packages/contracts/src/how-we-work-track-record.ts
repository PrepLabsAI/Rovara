// Track record (v1.2, slice 1): how the earned record of a stage is worded. One record is the count of what happened to one kind of claim in the last 30 days (outcomes.ts): it shows on the How we
// work stage cards, next to a less-safe change in a confirmation, and (for the PR risk claim alone, and only to the task's owner) as the early signal on the task page.
// Browser-safe: nothing here imports a Node module, and every text is plain text that a reader escapes for its own markup.
import { z } from "zod";
import { OUTCOME_READ_CAP } from "./outcomes.js";
import type { EarlyRiskSignal } from "./early-risk-signal.js";
export { EarlyRiskSignalSchema, EarlyRiskSignalReadSchema, type EarlyRiskSignal } from "./early-risk-signal.js";

/** The claims a stage card shows. The PR risk claim is no part of it: it is private to the task's owner (`EarlyRiskSignalSchema`). */
export const HOW_WE_WORK_TRACK_CLAIMS = ["plan_ready", "review_pass:CRITIC", "review_pass:SECURITY", "proves_change"] as const;
export type HowWeWorkTrackClaim = (typeof HOW_WE_WORK_TRACK_CLAIMS)[number];

// A reader must not fail a whole view over a number: a newer server may count more, or over another window. So the counts and the window are plain integers here (not the limits of today's server), and
// the record is read tolerantly (a field this version does not know is ignored, and a record it cannot read is dropped, never the view).
const Count = z.number().int().min(0);
const WindowDays = z.number().int().positive();

/** What one stage card says of one claim: counts only (no task names, no people). `held` and `notHeld` are the rate; the rest are the limits that go beside it. */
export const HowWeWorkTrackRecordSchema = z.object({
  claim: z.enum(HOW_WE_WORK_TRACK_CLAIMS),
  held: Count,
  notHeld: Count,
  closedUnmerged: Count,
  noOutcome: Count,
  unreviewedMerges: Count,
  windowDays: WindowDays,
  /** The read stopped at its cap: the figures are for the newest samples. */
  capped: z.boolean(),
  /** At least ten samples were held or not held. */
  enough: z.boolean(),
});
export type HowWeWorkTrackRecord = z.infer<typeof HowWeWorkTrackRecordSchema>;

/** The most records a stage is read with (the review stage has two). */
const RECORDS_READ_MAX = 8;

/**
 * The records of a stage: one per claim (the review stage carries two, one for code review and one for security review). Each is read on its own: one that this version cannot read (a claim it does
 * not know, a field of the wrong kind) is dropped, and the rest of the view loads. A value that is not a list reads as no records.
 */
export const HowWeWorkTrackRecordsSchema = z.unknown().transform((value): HowWeWorkTrackRecord[] =>
  Array.isArray(value) ? value.slice(0, RECORDS_READ_MAX).flatMap((item: unknown) => { const read = HowWeWorkTrackRecordSchema.safeParse(item); return read.success ? [read.data] : []; }) : []);

/** The claims a stage of this kind is scored on, and the stage the samples are kept under (the stage kinds a card shows). */
export const HOW_WE_WORK_STAGE_CLAIMS = {
  plan_critic: { stage: "plan_critic", claims: ["plan_ready"] },
  review: { stage: "review", claims: ["review_pass:CRITIC", "review_pass:SECURITY"] },
  check: { stage: "check", claims: ["proves_change"] },
} as const satisfies Record<string, { stage: "plan_critic" | "review" | "check"; claims: readonly HowWeWorkTrackClaim[] }>;

export const hasTrackRecord = (kind: string): kind is keyof typeof HOW_WE_WORK_STAGE_CLAIMS => Object.hasOwn(HOW_WE_WORK_STAGE_CLAIMS, kind);

/** What every line about a review says it cannot see yet. */
export const REVERTS_NOT_TRACKED = "Reverts after merge aren't tracked yet";
const TESTS_CI_NOTE = "CI failures unrelated to the change also count";

const TITLES: Record<HowWeWorkTrackClaim, string> = {
  plan_ready: "Plan check",
  "review_pass:CRITIC": "Code review",
  "review_pass:SECURITY": "Security review",
  proves_change: "Tests",
};

export interface TrackRecordLines {
  /** What the record is about: "Plan check", "Code review", "Security review" or "Tests". */
  title: string;
  /** Line 1: the rate, or "Not enough history yet (N so far)". */
  rate: string;
  /** Line 2: the limits (counts that are not 0, and what Rovara can't see). Absent when there is nothing to say. */
  limits?: string;
}

const times = (count: number) => (count === 1 ? "time" : "times");
const prs = (count: number) => (count === 1 ? "PR" : "PRs");

interface Limits { closedUnmerged: number; noOutcome: number; unreviewedMerges: number }

/** The limits that go beside a rate, as parts: the counts that are not 0, then what Rovara can't see (or count) yet. `reviews`: whether a person's review and reverts matter to the claim. */
function limitParts(limits: Limits, kind: "plan" | "review" | "tests" | "risk", options: { reverts?: boolean } = {}): string[] {
  const parts: string[] = [];
  if (limits.closedUnmerged > 0) parts.push(`${String(limits.closedUnmerged)} ${prs(limits.closedUnmerged)} closed unmerged`);
  if ((kind === "review" || kind === "risk") && limits.unreviewedMerges > 0) parts.push(`${String(limits.unreviewedMerges)} merged without a person's review`);
  if (limits.noOutcome > 0) parts.push(`${String(limits.noOutcome)} with no result to check`);
  if ((kind === "review" || kind === "risk") && options.reverts !== false) parts.push(REVERTS_NOT_TRACKED);
  if (kind === "tests") parts.push(TESTS_CI_NOTE);
  return parts;
}

/** The two lines of a record, in plain words. A claim this build does not know (a newer server's) is dropped on reading, so every record that gets here has words. */
export function trackRecordLines(record: HowWeWorkTrackRecord): TrackRecordLines {
  const total = record.held + record.notHeld;
  const window = `last ${String(record.windowDays)} days`;
  const review = record.claim.startsWith("review_pass:");
  let rate: string;
  if (!record.enough) rate = `Not enough history yet (${String(total)} so far)`;
  else if (record.claim === "plan_ready") rate = `The person approved the plan ${String(record.held)} of ${String(total)} ${times(total)} (${window})`;
  else if (record.claim === "proves_change") rate = `CI passed on ${String(record.held)} of ${String(total)} PRs where tests said they prove the change (${window})`;
  else rate = `No changes requested by a person on ${String(record.held)} of ${String(total)} merged PRs (${window})`;
  // Code review and security review are kept under one stage, so they are read together and share the cap.
  if (record.capped) rate += ` (based on the latest ${String(OUTCOME_READ_CAP)}${review ? " reviews" : ""})`;
  const parts = limitParts(record, review ? "review" : record.claim === "proves_change" ? "tests" : "plan");
  return { title: TITLES[record.claim], rate, ...(parts.length === 0 ? {} : { limits: parts.join(" · ") }) };
}

/** Whether a record read from a server is one this build can word (a newer server's claim reads as "unknown" and is left out). */
export const isWordedRecord = (record: { claim: string }): record is HowWeWorkTrackRecord => Object.hasOwn(TITLES, record.claim);

/**
 * The stage a less-safe change is about, so its record can be shown beside it. Only a change about who reviews or checks at a stage, or about removing or weakening it, has one: it says "the plan check" or
 * "the review step" (a model, a vendor, fewer reviewers, findings no longer sent back, the instructions, taking the step out). A change about a tool, a time or spending limit, a connector or data sent
 * to an AI company has none, even when it quotes the step's name. The stage is found by its kind (never by its name alone): a step of the project's own that has the same name is not it.
 */
export function stageOfLessSafeReason(reason: string, stages: ReadonlyArray<{ id: string; name: string; kind: string }>): string | undefined {
  return stepOfLessSafeReason(reason, stages)?.id;
}

/** The same, as the step itself (its id and its kind): a step that reuses a stage's id with another kind is not that stage. */
export function stepOfLessSafeReason<T extends { id: string; name: string; kind: string }>(reason: string, stages: ReadonlyArray<T>): T | undefined {
  const words = /\bthe (plan check|review step)\b/i.exec(reason)?.[1]?.toLowerCase();
  if (words === undefined || !CHECKING_CHANGE.test(reason)) return undefined;
  const kind = words === "plan check" ? "plan_critic" : "review";
  const named = [...reason.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const ofKind = stages.filter((stage) => stage.kind === kind);
  // The first quoted name is the step the change is about (later ones name the step it is compared with).
  if (named.length > 0) return ofKind.find((stage) => stage.name === named[0]);
  return ofKind[0];
}

/** The ways a change can weaken who checks: what it does to the plan check or the review step. */
const CHECKING_CHANGE = /^(?:Changes the instructions of|Removes|Gives|Moves|Makes|Stops|Lowers how many times) the (?:plan check|review step)\b/;

// ---- the early signal for the task's owner (PR risk "low")

/** The words of the early signal. The sample count is always there; below ten samples it says "Early signal, few samples". The limits are the card's: what was closed unmerged, merged unreviewed, and what is not tracked. */
export function earlyRiskSignalText(signal: EarlyRiskSignal): string {
  const total = signal.held + signal.notHeld;
  const lead = signal.enough ? "Early signal" : "Early signal, few samples";
  const window = `last ${String(signal.windowDays)} days`;
  const cap = signal.capped ? ` (based on the latest ${String(OUTCOME_READ_CAP)})` : "";
  if (total === 0) {
    const counts = limitParts(signal, "risk", { reverts: false });
    return `${lead}: no PRs this project rated low risk have been scored yet (${window}).${counts.length === 0 ? "" : ` ${counts.join(" · ")}.`}`;
  }
  return `${lead}: PRs this project rated low risk were merged with no changes requested by a person ${String(signal.held)} of ${String(total)} times (${window})${cap}. ${limitParts(signal, "risk").join(" · ")}.`;
}
