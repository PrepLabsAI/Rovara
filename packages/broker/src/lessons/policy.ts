// The learning mode, the approval policy and the edition caps.
import { z } from "zod";
import { approversRequired as sharedApproversRequired } from "./approval-rules.js";
import type { LessonAuditEvent, LessonAuditSink } from "./ports.js";
import { learnedLessonsOn } from "./switch.js";
import type { Tier } from "./types.js";

/** Off: nothing is captured or loaded. Collect: the record is filled, nothing is loaded. Suggest: lessons are made and every one needs a person. On: lessons are made and loaded; a tier-0 lesson goes live by itself ONLY if the project sets `tier0Approval: "auto"`, otherwise one person approves it first. */
export const LEARNING_MODES = ["Off", "Collect", "Suggest", "On"] as const;
export type LearningMode = (typeof LEARNING_MODES)[number];
export const LearningModeSchema = z.enum(LEARNING_MODES);
export type ModeAction = "capture" | "reflect" | "load" | "auto_apply";
const ALLOWED: Record<LearningMode, readonly ModeAction[]> = {
  Off: [], Collect: ["capture"], Suggest: ["capture", "reflect", "load"], On: ["capture", "reflect", "load", "auto_apply"],
};
export const modeAllows = (mode: LearningMode, action: ModeAction): boolean => ALLOWED[mode].includes(action);

/**
 * Approval by tier, as a policy a project (or a company, on Enterprise) can change. The pilot default is that a
 * person approves every lesson: tier 0 and tier 1 need one maintainer, reviewer, check and security lessons (tier 2) need a second maintainer or admin.
 * Tier 0 can go live by itself only when `tier0Approval` is set to "auto". Tier 2 can never go below two people: the schema has no value for it.
 */
export const ApprovalPolicySchema = z.object({
  /** "auto": goes live by itself (mode On only). "one" or "two": a person, or two, must approve it first. */
  tier0: z.enum(["auto", "one", "two"]),
  tier1: z.enum(["one", "two"]),
  /** Enterprise: a named group that must be among the approvers of tier 1 and tier 2 lessons. */
  requiredGroup: z.string().min(1).max(100).optional(),
}).strict();
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;
/**
 * THE switch for the pilot: how a tier-0 lesson (a cited, rendered, corroborated fact) goes live. "auto": by itself, audited. "one": only after one
 * person approves it, on every path (ingest, rollback, resume). A project or company can set `tier0Approval` in its learning settings; this is the default when it does not.
 */
export type Tier0Approval = "auto" | "one" | "two";
export const TIER0_APPROVAL_DEFAULT: Tier0Approval = "one";
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = { tier0: TIER0_APPROVAL_DEFAULT, tier1: "one" };
/** What the project runs with when nothing is set: lessons are made and loaded, and every one waits for a person (no trial, no automatic go-live). A company lock or a project setting may choose another mode. */
export const DEFAULT_LEARNING_MODE: LearningMode = "Suggest";

/** The rule is shared with the design review stage; lessons call it from here. */
export const approversRequired: (tier: Tier, policy: ApprovalPolicy) => 0 | 1 | 2 = sharedApproversRequired;

/**
 * The company learning preset. Standard (the default): a low-risk lesson drafted from a project member's own correction goes live ON TRIAL with no approval. Regulated: no
 * trial at all, every lesson needs a person first. A company's preset is a floor like the mode lock: it can only make projects stricter, and a project can choose Regulated for itself.
 */
export const LEARNING_PRESETS = ["standard", "regulated"] as const;
export type LearningPreset = (typeof LEARNING_PRESETS)[number];
export const LearningPresetSchema = z.enum(LEARNING_PRESETS);
export const DEFAULT_LEARNING_PRESET: LearningPreset = "standard";
/** The stricter preset: Regulated wins. */
export const stricterPreset = (a: LearningPreset, b: LearningPreset): LearningPreset => (a === "regulated" || b === "regulated" ? "regulated" : "standard");

export type Edition = "enterprise" | "public";
/** Spend caps for learning. Enterprise has none: only the customer's own spend limits apply. Public keeps the caps. An absent value is no cap. */
export interface LearningCaps { perTaskUsd?: number; perNightUsd?: number }
export function learningCaps(edition: Edition, override?: LearningCaps): LearningCaps {
  if (edition === "enterprise") return {};
  return { perTaskUsd: 0.15, perNightUsd: 2, ...override };
}
/**
 * No flat caps on lessons, in either edition. Every candidate is collected and queued, never dropped. What guards the queue
 * is per-source spike detection: a source whose daily count reaches SPIKE_MULTIPLE times its own learned baseline (and at least SPIKE_MINIMUM that day) is
 * paused alone, and the maintainer is alerted. Other sources carry on.
 */
export const SPIKE = { multiple: 10, minimum: 10, baselineDays: 14, baselineFloor: 1, projectMinimum: 30 } as const;

/**
 * Two brakes on tier-0 AUTO-APPLY (controller default, owner may change; they matter only where automatic go-live is on, which it is not by default):
 * - project brake: after the project's volume alert fires, a tier-0 lesson goes to the one-tap queue (a person decides) for the next `brakeMs`. No source is paused by it.
 * - cold start: a source (a member, a channel, CI) with fewer than `coldStartLessons` lessons that a PERSON approved cannot auto-apply a lesson; its first nine wait for a person.
 */
export const AUTO_APPLY_GUARDS = { brakeMs: 86_400_000, coldStartLessons: 9 } as const;

export const MIN_EXPIRY_DAYS = 14;
export const MAX_EXPIRY_DAYS = 365;
export const DEFAULT_EXPIRY_DAYS = 90;

/**
 * How much a stage may be told (from the evidence that long context files cost more and help little): by default at most 5 lessons and 2 KB per stage. A project may ask for more or less within
 * the existing caps (`LEARNED_CONTEXT_MAX_LESSONS`, `LEARNED_CONTEXT_MAX_BYTES`); a value outside them, or one that is not a whole number, is ignored and the default stands.
 */
export const LOAD_DEFAULT_LESSONS = 5;
export const LOAD_DEFAULT_BYTES = 2 * 1024;
export interface LoadBudget { lessons: number; bytes: number }
export const LOAD_BUDGET_MIN: LoadBudget = { lessons: 1, bytes: 512 };
export interface LoadBudgetSetting { lessons?: number; bytes?: number }
/** The budget a stage loads with: the default, with each part replaced by the project's own value when it is a whole number inside the caps. */
export function resolveLoadBudget(setting: LoadBudgetSetting | undefined, caps: LoadBudget): LoadBudget {
  const pick = (value: unknown, fallback: number, min: number, max: number): number => (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback);
  return {
    lessons: pick(setting?.lessons, Math.min(LOAD_DEFAULT_LESSONS, caps.lessons), LOAD_BUDGET_MIN.lessons, caps.lessons),
    bytes: pick(setting?.bytes, Math.min(LOAD_DEFAULT_BYTES, caps.bytes), LOAD_BUDGET_MIN.bytes, caps.bytes),
  };
}

/**
 * While lessons delivery is switched off for the install (`ll`, LEARNED_LESSONS_ENABLED not exactly "1"), learning makes NO model call, whatever a project chose. The effective mode is then capped at
 * Collect (evidence is captured; nothing is reflected, loaded or auto-applied, so no model or embedder is used). The cap is applied in `resolveLearning` only; the stored project and company modes are never touched, so turning
 * `ll` on gives every project its own mode back. The switch is read at every resolve and FAILS CLOSED: a read that throws counts as off. Tests swap the reader with `setLearnedLessonsGate`.
 */
export const OFF_SWITCH_CAP: LearningMode = "Collect";
let lessonsSwitchGate: () => boolean = () => learnedLessonsOn(process.env);
export function setLearnedLessonsGate(gate: (() => boolean) | undefined): void { lessonsSwitchGate = gate ?? (() => learnedLessonsOn(process.env)); }
/** Whether the install's lessons switch is on now; an unreadable switch is off. */
export function learnedLessonsSwitchOn(): boolean { try { return lessonsSwitchGate() === true; } catch { return false; } }

export interface LearningSettings {
  /** The project's own choice; absent means the default. */
  mode?: LearningMode;
  /** The company's lock: it can only make the project stricter. The effective mode is the more restrictive of the lock and the project's own choice. */
  companyLock?: LearningMode;
  /** The company's approval floor: a project can ask for more approvers than this, never fewer, and cannot drop a required group set here. */
  companyApproval?: Partial<ApprovalPolicy>;
  approval?: Partial<ApprovalPolicy>;
  /** The named switch for tier-0 approval ("auto" | "one"); `approval.tier0` still wins when set. Unset: TIER0_APPROVAL_DEFAULT. A company floor can only make it "one". */
  tier0Approval?: Tier0Approval;
  /** The project's own preset; absent means Standard. */
  preset?: LearningPreset;
  /** The company's preset floor: the effective preset is the stricter of this and the project's own. */
  companyPreset?: LearningPreset;
  expiryDays?: number;
  /** The project's own load budget, within the caps. Absent: the default (5 lessons, 2 KB). */
  loadBudget?: LoadBudgetSetting;
}
export interface LearningSettingsReader { read(workspaceId: string, project: string): Promise<LearningSettings> }

/** `requiredGroups` holds every group that must be among the approvers: the company floor's and the project's own, both. */
export interface ResolvedLearning {
  /** The mode the pipeline runs with: the project's own choice (after the company's lock), capped at Collect while the install's lessons switch is off. Every model path asks THIS. */
  mode: LearningMode;
  /** The project's own choice after the company's lock, before the install's switch caps it. For showing the setting, and for decisions people make (approve, promote): they call no model. */
  chosenMode: LearningMode;
  /** True while the install's lessons switch is off (or unreadable): `mode` is then capped at Collect. */
  switchedOff: boolean;
  approval: ApprovalPolicy; requiredGroups: string[]; expiryDays: number | undefined;
  /** The preset in force: the stricter of the company's and the project's. A setting that does not read gives Regulated (and mode Off). */
  preset: LearningPreset;
  /**
   * Whether a lesson may be live on trial under these settings: Standard preset AND mode On AND no stricter approval setting asks for a person (a company approval floor, a required group, a two-person
   * requirement for tier 0 or tier 1). Every one of those means "a person decides", so a trial lesson, which has no person, would go around it. False when the settings do not read.
   */
  trialAllowed: boolean;
  /** The project's own load budget (how many lessons and bytes a stage may be told), within the caps. */
  loadBudget?: LoadBudgetSetting | undefined;
}
const MODE_ORDER: readonly LearningMode[] = ["Off", "Collect", "Suggest", "On"];
/** The more restrictive mode: Off is the strictest, On the loosest. */
export const stricterMode = (a: LearningMode, b: LearningMode): LearningMode => (MODE_ORDER.indexOf(a) <= MODE_ORDER.indexOf(b) ? a : b);
const LEVEL: Record<ApprovalPolicy["tier0"], number> = { auto: 0, one: 1, two: 2 };
const NAMES = ["auto", "one", "two"] as const;
function stricterApproval(project: ApprovalPolicy, floor: ApprovalPolicy, hasFloor: boolean): ApprovalPolicy {
  if (!hasFloor) return project;
  const tier0 = NAMES[Math.max(LEVEL[project.tier0], LEVEL[floor.tier0])]!;
  const tier1 = NAMES[Math.max(LEVEL[project.tier1], LEVEL[floor.tier1], 1)] as ApprovalPolicy["tier1"];
  const requiredGroup = floor.requiredGroup ?? project.requiredGroup;
  return { tier0, tier1, ...(requiredGroup === undefined ? {} : { requiredGroup }) };
}
/**
 * THE gate on automatic go-live (review, tidy). While it says no (the default, and the state for the whole pilot) a tier-0 "auto" is never honoured, whatever wrote it
 * (an old row, a hand edit, a bug, a future reader): `resolveLearning`, which every consumer of the settings goes through, reads it as "one". The broker sets the gate once at start-up
 * (`setAutoApplyGate`) with the broker's auto-apply switch; it is asked at every resolve, so turning it off takes effect at once.
 */
let autoApplyGate: () => boolean = () => false;
export function setAutoApplyGate(gate: () => boolean): void { autoApplyGate = gate; }
/** Whether the install's auto-apply switch is on now; an unreadable switch is off. */
export function autoApplyOn(): boolean { try { return autoApplyGate() === true; } catch { return false; } }
const clampAuto = <T extends string | undefined>(level: T): T | "one" => (level === "auto" ? "one" : level);
/** The settings with every tier-0 "auto" read as "one". Pure. */
export function clampAutoApply(settings: LearningSettings): LearningSettings {
  return {
    ...settings,
    ...(settings.tier0Approval === undefined ? {} : { tier0Approval: clampAuto(settings.tier0Approval) }),
    ...(settings.approval === undefined ? {} : { approval: { ...settings.approval, ...(settings.approval.tier0 === undefined ? {} : { tier0: clampAuto(settings.approval.tier0) }) } }),
    ...(settings.companyApproval === undefined ? {} : { companyApproval: { ...settings.companyApproval, ...(settings.companyApproval.tier0 === undefined ? {} : { tier0: clampAuto(settings.companyApproval.tier0) }) } }),
  };
}

/** Reads the settings and fails closed: a reader that throws, or settings that do not parse, give mode Off. */
export async function resolveLearning(reader: LearningSettingsReader, workspaceId: string, project: string): Promise<ResolvedLearning> {
  const switchedOff = !learnedLessonsSwitchOn();
  const off: ResolvedLearning = { mode: "Off", chosenMode: "Off", switchedOff, approval: DEFAULT_APPROVAL_POLICY, requiredGroups: [], expiryDays: undefined, preset: "regulated", trialAllowed: false };
  let settings: LearningSettings;
  // No settings row is the default (an undefined result), not a failure; a reader that throws fails closed.
  try { settings = (await reader.read(workspaceId, project)) ?? {}; } catch { return off; }
  if (!autoApplyGate()) settings = clampAutoApply(settings);
  const own = LearningModeSchema.safeParse(settings.mode ?? DEFAULT_LEARNING_MODE);
  const lock = settings.companyLock === undefined ? undefined : LearningModeSchema.safeParse(settings.companyLock);
  if (!own.success || (lock !== undefined && !lock.success)) return off;
  const mode = { success: true as const, data: lock === undefined ? own.data : stricterMode(own.data, lock.data) };
  const projectApproval = ApprovalPolicySchema.safeParse({ ...DEFAULT_APPROVAL_POLICY, tier0: settings.tier0Approval ?? TIER0_APPROVAL_DEFAULT, ...(settings.approval ?? {}) });
  const floor = ApprovalPolicySchema.safeParse({ ...DEFAULT_APPROVAL_POLICY, ...(settings.companyApproval ?? {}) });
  if (!projectApproval.success || !floor.success) return off;
  const ownPreset = LearningPresetSchema.safeParse(settings.preset ?? DEFAULT_LEARNING_PRESET);
  const companyPreset = settings.companyPreset === undefined ? undefined : LearningPresetSchema.safeParse(settings.companyPreset);
  if (!ownPreset.success || (companyPreset !== undefined && !companyPreset.success)) return off;
  const approval = { success: true as const, data: stricterApproval(projectApproval.data, floor.data, settings.companyApproval !== undefined) };
  const days = settings.expiryDays;
  if (days !== undefined && (!Number.isInteger(days) || days < MIN_EXPIRY_DAYS || days > MAX_EXPIRY_DAYS)) return off;
  const requiredGroups = [...new Set([floor.data.requiredGroup, projectApproval.data.requiredGroup].filter((g): g is string => g !== undefined))];
  const preset = companyPreset?.success === true ? stricterPreset(ownPreset.data, companyPreset.data) : ownPreset.data;
  // A trial lesson has no person behind it, so it is allowed only where nothing asks for one: Standard, mode On (Suggest and the company's lock say "every lesson needs a person"), no company approval floor,
  // no required group, and no two-person requirement.
  const trialAllowed = preset === "standard" && modeAllows(mode.data, "auto_apply") && settings.companyApproval === undefined && requiredGroups.length === 0
    && approval.data.tier0 !== "two" && approval.data.tier1 !== "two";
  // The install's switch is off, so the pipeline runs as Collect at most. `trialAllowed` above is read from the chosen mode on purpose: it is a fact about the settings (nightly promotion of lessons already on trial
  // makes no model call), not a licence to draft new lessons, which `mode` now forbids.
  return { mode: switchedOff ? stricterMode(mode.data, OFF_SWITCH_CAP) : mode.data, chosenMode: mode.data, switchedOff, approval: approval.data, requiredGroups, expiryDays: days, preset, trialAllowed, ...(settings.loadBudget === undefined ? {} : { loadBudget: settings.loadBudget }) };
}

/**
 * Why `resolveLearning` said Off, for the one read that tells the person: "off" (the project's own choice, with no company lock on Off), "locked" (the company's lock is Off, whatever the project's own choice is),
 * or "unreadable" (the setting could not be read or does not parse: turning learning on would change nothing, so the person is told to retry). Only asked after `resolveLearning` already answered Off.
 */
export async function whyLearningOff(reader: LearningSettingsReader, workspaceId: string, project: string): Promise<"off" | "locked" | "unreadable"> {
  let settings: LearningSettings;
  try { settings = (await reader.read(workspaceId, project)) ?? {}; } catch { return "unreadable"; }
  const own = LearningModeSchema.safeParse(settings.mode ?? DEFAULT_LEARNING_MODE);
  const lock = settings.companyLock === undefined ? undefined : LearningModeSchema.safeParse(settings.companyLock);
  if (!own.success || (lock !== undefined && !lock.success)) return "unreadable";
  // The company's lock is Off: turning the project's own switch on would change nothing, so say so, whether or not the project's own choice is Off too (Minor B of the re-review).
  if (lock?.success === true && lock.data === "Off") return "locked";
  return own.data === "Off" ? "off" : "unreadable";
}

const SAFE_FACT = /^[A-Za-z0-9:_\-.#@/]{1,128}$/u;
/** Writes an audit event whose facts hold ids, counts and fixed codes only: a string value that is not id-shaped is dropped. */
function safeFacts(event: LessonAuditEvent): LessonAuditEvent {
  const facts: LessonAuditEvent["facts"] = {};
  for (const [key, value] of Object.entries(event.facts)) if (typeof value !== "string" || SAFE_FACT.test(value)) facts[key] = value;
  return { ...event, facts };
}
/** Best-effort audit, for bookkeeping that grants nothing (counters, candidates, refusals, retire). An outage never blocks learning. */
export async function emitAudit(sink: LessonAuditSink, event: LessonAuditEvent): Promise<void> {
  try { await sink.emit(safeFacts(event)); } catch { /* bookkeeping only */ }
}
/**
 * Audit that must succeed before a change that GRANTS something (an approval, a go-live, a promotion, a rollback). The event is written before the change,
 * and a failed write returns false so the caller refuses the change (fail closed). The kill switches (retire) use `emitAudit`, so they always work.
 */
export async function requireAudit(sink: LessonAuditSink, event: LessonAuditEvent): Promise<boolean> {
  try { await sink.emit(safeFacts(event), { required: true }); return true; } catch { return false; }
}
