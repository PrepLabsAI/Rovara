import { z } from "zod";
import { PLAN_DRY_RUN_CLASSES, PlanQualityFindingSchema, type PlanDryRunClass, type PlanQualityFinding } from "@agentx/contracts";
import type { PlanDryRunOutcome } from "./plan-dry-run-results.js";
import { planDryRunWarnings } from "./plan-dry-run-results.js";
import type { PlanQualityContext } from "./plan-quality.js";

/**
 * Plan self-check wiring (the pure half): what the broker keeps of a plan's quality check, when it asks the planner to
 * write the plan again, and what it says to the planner. Everything here is a function of a parsed plan, the findings
 * `planQualityFindings` gave, and a small budget record; nothing reads storage. Findings carry fixed codes and plan IDs
 * only, so a revision prompt built from them (plus the fixed text here) holds no model text but those IDs.
 */

/** The most automatic revisions of one document version: unreadable-answer retries and finding revisions share it (owner decision Q1). */
export const PLAN_AUTO_REVISIONS_MAX = 1;

const ARTIFACT_TYPES = ["requirements", "design", "plan"] as const;
export type PlanSelfCheckArtifactType = (typeof ARTIFACT_TYPES)[number];

/** Kept on the task record: which document version the automatic revision budget is for, and how much of it is spent. */
export const PlanSelfCheckStateSchema = z.object({
  artifactType: z.enum(ARTIFACT_TYPES),
  /** The version the planner is writing (the number of documents of that type already stored, plus one). */
  version: z.number().int().min(1).max(1_000),
  used: z.number().int().min(0).max(PLAN_AUTO_REVISIONS_MAX),
}).strict();
export type PlanSelfCheckState = z.infer<typeof PlanSelfCheckStateSchema>;

/** The automatic revisions already spent on the version being written. A budget for another version (or none) is unspent. */
export function planRevisionsUsed(state: unknown, artifactType: PlanSelfCheckArtifactType, version: number): number {
  const parsed = PlanSelfCheckStateSchema.safeParse(state);
  return parsed.success && parsed.data.artifactType === artifactType && parsed.data.version === version ? parsed.data.used : 0;
}

export const PLAN_SELF_CHECK_NOTE_CODES = ["checks-not-tried", "grounding-not-checked", "grounding-undecided"] as const;
const PlanSelfCheckNoteSchema = z.object({ code: z.enum(PLAN_SELF_CHECK_NOTE_CODES), ownerSentence: z.string().min(1).max(300) }).strict();
export type PlanSelfCheckNote = z.infer<typeof PlanSelfCheckNoteSchema>;

/** Why a document was stored without its checks having run: shown to the owner as "not checked", never as "no problems". */
export const PLAN_SELF_CHECK_SKIP_REASONS = ["disabled", "not-a-coding-plan", "checks-not-read", "rules-failed"] as const;
export type PlanSelfCheckSkipReason = (typeof PLAN_SELF_CHECK_SKIP_REASONS)[number];

/**
 * What is stored beside every document the planner's answer became (never inside it, so the digest the owner's approval binds does not move).
 * Object key: `planSelfCheckKey(prefix)`, i.e. the document's own object key with `.json` replaced by `.quality.json`.
 * `status: "checked"`: the rules ran; `findings` (possibly empty) and `notes` are the result. `status: "not-checked"`: they did not (`reason` says why);
 * `findings` and `notes` are empty and mean nothing. A document with no such object at all (stored before this existed, or the write failed) is also "not checked".
 */
export const PlanSelfCheckRecordSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(["checked", "not-checked"]),
  reason: z.enum(PLAN_SELF_CHECK_SKIP_REASONS).optional(),
  artifactId: z.string().min(1).max(200),
  artifactSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  checkedAt: z.string().min(1).max(40),
  findings: z.array(PlanQualityFindingSchema).max(64),
  notes: z.array(PlanSelfCheckNoteSchema).max(8),
  /** Automatic revisions spent on this document version before this plan was shown. */
  autoRevisions: z.number().int().min(0).max(PLAN_AUTO_REVISIONS_MAX),
  /** What the worker's dry run found for each proposed check on the unchanged code (a fixed class, never output or a duration); absent when nothing was tried. */
  tried: z.array(z.object({ checkId: z.string().min(1).max(64), class: z.enum(PLAN_DRY_RUN_CLASSES) }).strict()).max(16).optional(),
}).strict();
export type PlanSelfCheckRecord = z.infer<typeof PlanSelfCheckRecordSchema>;

/** What a reader says when a document has no usable record: never "no problems". */
export const NOT_CHECKED_SENTENCE = "Not checked by AgentX's plan check.";

/** What the owner sees of a stored record: whether the rules ran, the fixed sentences to show (most serious first), and what the dry run found per check. */
export interface PlanSelfCheckView {
  checked: boolean;
  sentences: string[];
  /** Only the classes that say something about the check on the unchanged code; `not-run` and `not-checked` are left out. */
  tried: Readonly<Record<string, Extract<PlanDryRunClass, "passed" | "failed" | "broken">>>;
}

/** For a document the plan check never judges (requirements, a design): nothing to say, and not "not checked". */
export const SELF_CHECK_NOT_APPLICABLE: PlanSelfCheckView = Object.freeze({ checked: true, sentences: [], tried: Object.freeze({}) });

const NOT_CHECKED_VIEW = (): PlanSelfCheckView => ({ checked: false, sentences: [NOT_CHECKED_SENTENCE], tried: {} });
/** The most a record may be: well over any real one (64 findings of a few hundred characters). */
const SELF_CHECK_RECORD_MAX_CHARS = 64 * 1024;

/**
 * T4's reader rules for T5's record. No text, unparsable text, a record that is not this document's (its digest differs from the workflow artifact's) and a
 * `not-checked` record all read as "not checked". A checked record gives each finding's and note's fixed sentence, the ones only a person can settle first.
 */
export function readPlanSelfCheck(raw: string | undefined, artifactSha256: string): PlanSelfCheckView {
  if (raw === undefined || raw.length === 0 || raw.length > SELF_CHECK_RECORD_MAX_CHARS) return NOT_CHECKED_VIEW();
  let parsed: ReturnType<typeof PlanSelfCheckRecordSchema.safeParse>;
  try { parsed = PlanSelfCheckRecordSchema.safeParse(JSON.parse(raw)); } catch { return NOT_CHECKED_VIEW(); }
  if (!parsed.success || parsed.data.artifactSha256 !== artifactSha256 || parsed.data.status !== "checked") return NOT_CHECKED_VIEW();
  const { findings, notes, tried } = parsed.data;
  const sentences = [...findings.filter((finding) => !finding.revisable), ...findings.filter((finding) => finding.revisable)].map((finding) => finding.ownerSentence)
    .concat(notes.map((note) => note.ownerSentence));
  return {
    checked: true, sentences: [...new Set(sentences)],
    tried: Object.fromEntries((tried ?? []).flatMap((entry) => (entry.class === "passed" || entry.class === "failed" || entry.class === "broken" ? [[entry.checkId, entry.class] as const] : []))),
  };
}

/** The record's own object key, from the document's: `.json` becomes `.quality.json`. Undefined for a document that is not stored as `.json`. */
export function planSelfCheckKeyOf(objectKey: string): string | undefined {
  return objectKey.endsWith(".json") && !objectKey.endsWith(".quality.json") ? planSelfCheckKey(objectKey.slice(0, -".json".length)) : undefined;
}

/** Reads the record beside a stored document; a record that cannot be found, read or trusted is "not checked". */
export async function loadPlanSelfCheck(read: (objectKey: string) => Promise<string | undefined>, artifact: { objectKey: string; sha256: string }): Promise<PlanSelfCheckView> {
  const key = planSelfCheckKeyOf(artifact.objectKey);
  if (key === undefined) return NOT_CHECKED_VIEW();
  try { return readPlanSelfCheck(await read(key), artifact.sha256); } catch { return NOT_CHECKED_VIEW(); }
}

/** The object key of a plan document's self-check record, given the document's own key prefix. */
export const planSelfCheckKey = (documentPrefix: string): string => `${documentPrefix}.quality.json`;

/**
 * The notes for what the self-check could not do, from the dry run's outcome (`readPlanDryRunOutcome`): the proposed checks were not tried on the unchanged code, or some of
 * them were not. The sentences are T6's fixed ones; nothing the worker or a command said is kept.
 */
export function selfCheckNotes(outcome: PlanDryRunOutcome): PlanSelfCheckNote[] {
  return planDryRunWarnings(outcome).map((ownerSentence) => ({ code: "checks-not-tried" as const, ownerSentence }));
}

/** Findings that only a planner told about the new plan members (`scenarioProves`, `expectOnBase`) can fix. */
const NEEDS_NEW_MEMBERS = new Set<PlanQualityFinding["code"]>(["claim-not-covered", "claim-static-only", "check-command-lint", "check-base-mismatch", "scenario-base-mismatch"]);

/**
 * The findings an automatic revision may be spent on. A finding whose fix names the new plan members (`scenarioProves`, `expectOnBase`,
 * built-in file checks) counts only for a run whose planner was asked for them (`planQualityAsked`, which delivery clears for an older
 * worker): its strict parser would reject a plan that followed the advice. Everything else revisable counts.
 */
export function autoRevisableFindings(findings: readonly PlanQualityFinding[], planQualityAsked: boolean): PlanQualityFinding[] {
  return findings.filter((finding) => finding.revisable && (planQualityAsked || !NEEDS_NEW_MEMBERS.has(finding.code)));
}

/** The most findings named in a revision prompt. */
const PROMPT_FINDINGS_MAX = 8;

/** What the planner is told when a plan that parsed is sent back for the findings: fixed text and plan IDs only. */
export function planRevisionPrompt(findings: readonly PlanQualityFinding[]): string {
  const lines = findings.slice(0, PROMPT_FINDINGS_MAX).map((finding) => `- ${finding.plannerLine}`);
  const more = findings.length > PROMPT_FINDINGS_MAX ? [`- and ${findings.length - PROMPT_FINDINGS_MAX} more problems of the same kinds`] : [];
  return [
    "Your last coding plan could be read, but AgentX checked it before showing it to the owner and found problems. The IDs below are from your plan:",
    ...lines, ...more,
    "Fix each problem and return the complete coding plan again, ending with the same fenced block as before. Do not edit files.",
  ].join("\n");
}

/** The part of the planning context the rules read, as the broker keeps it on the planning operation. */
export const PlanQualityContextSchema = z.object({
  targets: z.array(z.object({ targetId: z.string().max(200), kind: z.string().max(40) }).strict()).max(64),
  mockFixtures: z.array(z.object({ componentId: z.string().max(200), requestedTargetIds: z.array(z.string().max(200)).max(64) }).strict()).max(64),
  executableKinds: z.array(z.object({ kind: z.string().max(40), steps: z.array(z.string().max(60)).max(64), assertions: z.array(z.string().max(60)).max(64) }).strict()).max(8).optional(),
  unavailableReasons: z.array(z.object({ targetId: z.string().max(200), reason: z.string().max(80) }).strict()).max(64).optional(),
}).strict();

/** The planning context as the rules read it, or undefined when the planner was given none (no E2E policy, or its context was unknown). */
export function planQualityContextOf(context: {
  status: string;
  targets?: ReadonlyArray<{ targetId: string; kind: string }>;
  mockFixtures?: ReadonlyArray<{ componentId: string; requestedTargetIds: readonly string[] }>;
  executableKinds?: ReadonlyArray<{ kind: string; steps: readonly string[]; assertions: readonly string[] }> | undefined;
  unavailableReasons?: ReadonlyArray<{ targetId: string; reason: string }> | undefined;
} | undefined): PlanQualityContext | undefined {
  if (context === undefined || context.status !== "available" || context.targets === undefined || context.mockFixtures === undefined) return undefined;
  const parsed = PlanQualityContextSchema.safeParse({
    targets: context.targets.map((target) => ({ targetId: target.targetId, kind: target.kind })),
    mockFixtures: context.mockFixtures.map((fixture) => ({ componentId: fixture.componentId, requestedTargetIds: [...fixture.requestedTargetIds] })),
    ...(context.executableKinds === undefined ? {} : { executableKinds: context.executableKinds.map((entry) => ({ kind: entry.kind, steps: [...entry.steps], assertions: [...entry.assertions] })) }),
    ...(context.unavailableReasons === undefined ? {} : { unavailableReasons: context.unavailableReasons.map((entry) => ({ targetId: entry.targetId, reason: entry.reason })) }),
  });
  return parsed.success ? parsed.data : undefined;
}

/** The context a planning operation recorded, read back; anything that does not parse reads as "unknown" (the rules that need it are skipped). */
export function recordedPlanQualityContext(value: unknown): PlanQualityContext | undefined {
  const parsed = PlanQualityContextSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** T7c: how long a plan is held back for its check on the current app, from the moment it is held. */
export const PLAN_GROUNDING_HOLD_MS = 15 * 60_000;

/** The coding plan a task holds back while its must-not-change checks run on the current app (kept on the task row until the one finish clears it). */
export interface PlanGroundingHold {
  artifactId: string; artifactSha256: string; artifactCreatedAt: string; version: number; attempt: number;
  /** The planning run whose answer is held (its operation holds the exported unchanged code). */
  planOperationId: string;
  heldAt: string; deadlineAt: string;
  /** The owner closed the task: the finish clears the hold and asks nobody anything. */
  abandoned?: true;
}

const GROUNDING_REASON_WORDS: Readonly<Record<string, string>> = {
  "worker-too-old": "the runner is too old for this check",
  "not-exported": "the current code was not available to the runner",
  "runtime-not-ready": "the test environment was not ready",
  "accounts-not-ready": "the test accounts were not ready",
  "refused": "the check was refused for this plan",
  "start-failed": "the check could not be started",
  "run-failed": "the check run failed",
  "unverified": "its result could not be verified",
  "timed-out": "it ran out of time",
  "ai-only": "these checks use AI navigation, which is not run before approval",
  "disabled": "it is turned off",
  "stopped": "it was stopped",
};

/** The note for a plan whose current-app check did not give a result: a fixed sentence per fixed reason. */
export function groundingNotCheckedNote(reason: string): PlanSelfCheckNote {
  return { code: "grounding-not-checked", ownerSentence: `Not checked against the current app: ${GROUNDING_REASON_WORDS[reason] ?? "it could not be run"}.` };
}

/** The note for scenarios that ran on the current app but could not be decided either way. */
export function groundingUndecidedNote(count: number): PlanSelfCheckNote {
  return { code: "grounding-undecided", ownerSentence: `${count === 1 ? "One check" : `${count} checks`} on the current app could not be decided either way.` };
}

/** What a held plan's check on the current app came to: scenarios that failed on the unchanged app (as findings) and ones undecided, or a fixed reason it gave no result. */
export type GroundingOutcome =
  | { kind: "checked"; findings: PlanQualityFinding[]; undecided: number }
  | { kind: "unavailable"; reason: string };
