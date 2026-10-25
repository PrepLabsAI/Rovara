import { z } from "zod";
import { PlanQualityFindingSchema, planQualityFinding, type PlanDocument, type PlanQualityFinding } from "@agentx/contracts";
import type { PlanQualityContext } from "./plan-quality.js";

/**
 * Plan self-check wiring (the pure half): what the broker keeps of a plan's quality check, when it asks the planner to
 * write the plan again, and what it says to the planner. Everything here is a function of a parsed plan, the findings
 * `planQualityFindings` gave, and a small budget record; nothing reads storage. Findings carry fixed codes and plan IDs
 * only, so a revision prompt built from them (plus the fixed text here) holds no model text but those IDs.
 */

/** The most automatic revisions of one document version: unreadable-answer retries and finding revisions share it (owner decision Q1). */
export const PLAN_AUTO_REVISIONS_MAX = 1;

/** The worker feature whose image parses and answers the new plan members (`scenarioProves`, `expectOnBase`, built-in file checks); the planner is asked for them only from such a worker. */
export const PLAN_QUALITY_WORKER_FEATURE = "task.workflowPlanDryRun.v1";

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

export const PLAN_SELF_CHECK_NOTE_CODES = ["checks-not-tried"] as const;
const NOTE_SENTENCES: Record<(typeof PLAN_SELF_CHECK_NOTE_CODES)[number], string> = {
  "checks-not-tried": "Proposed checks were not tried on the current code.",
};
const PlanSelfCheckNoteSchema = z.object({ code: z.enum(PLAN_SELF_CHECK_NOTE_CODES), ownerSentence: z.string().min(1).max(300) }).strict();
export type PlanSelfCheckNote = z.infer<typeof PlanSelfCheckNoteSchema>;

/** What is stored beside a plan document (never inside it, so the digest the owner's approval binds does not move). */
export const PlanSelfCheckRecordSchema = z.object({
  schemaVersion: z.literal(1),
  artifactId: z.string().min(1).max(200),
  artifactSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  checkedAt: z.string().min(1).max(40),
  findings: z.array(PlanQualityFindingSchema).max(64),
  notes: z.array(PlanSelfCheckNoteSchema).max(8),
  /** Automatic revisions spent on this document version before this plan was shown. */
  autoRevisions: z.number().int().min(0).max(PLAN_AUTO_REVISIONS_MAX),
}).strict();
export type PlanSelfCheckRecord = z.infer<typeof PlanSelfCheckRecordSchema>;

/** The object key of a plan document's self-check record, given the document's own key prefix. */
export const planSelfCheckKey = (documentPrefix: string): string => `${documentPrefix}.quality.json`;

/** What the dry run found out about a proposed check on the unchanged code (a fixed class, never output). */
export type PlanDryRunClass = "passed" | "failed" | "broken";
export type PlanDryRunResults = Readonly<Record<string, PlanDryRunClass>>;

/** Findings from the dry run: a check that could not run, or that did the opposite of its `expectOnBase` prediction. */
export function dryRunFindings(plan: PlanDocument, results: PlanDryRunResults | undefined): PlanQualityFinding[] {
  if (results === undefined) return [];
  const proposed = plan.checks?.proposed ?? [];
  const broken = proposed.filter((check) => results[check.id] === "broken").map((check) => check.id);
  const mismatched = proposed.filter((check) => {
    const predicted = plan.checks?.expectOnBase?.[check.id];
    const found = results[check.id];
    return predicted !== undefined && ((predicted === "pass" && found === "failed") || (predicted === "fail" && found === "passed"));
  }).map((check) => check.id);
  return [
    ...(broken.length === 0 ? [] : [planQualityFinding({ code: "check-broken-on-base", checkIds: broken })]),
    ...(mismatched.length === 0 ? [] : [planQualityFinding({ code: "check-base-mismatch", checkIds: mismatched })]),
  ];
}

/** Notes for what the self-check could not do: today, trying the proposed checks on the unchanged code when no dry run reported. */
export function selfCheckNotes(plan: PlanDocument, input: { dryRun: PlanDryRunResults | undefined }): PlanSelfCheckNote[] {
  return input.dryRun === undefined && (plan.checks?.proposed.length ?? 0) > 0
    ? [{ code: "checks-not-tried", ownerSentence: NOTE_SENTENCES["checks-not-tried"] }] : [];
}

/** Findings that only a planner told about the new plan members (`scenarioProves`, `expectOnBase`) can fix. */
const NEEDS_NEW_MEMBERS = new Set<PlanQualityFinding["code"]>(["claim-not-covered", "claim-static-only", "check-base-mismatch", "scenario-base-mismatch"]);

/**
 * The findings an automatic revision may be spent on. A finding whose fix needs the new plan members counts only when the
 * plan shows its planner knew them (it used one) or the plan has no scenario to name them for; an older worker that was never
 * asked for them would only be sent a request it cannot answer. Everything else revisable counts.
 */
export function autoRevisableFindings(plan: PlanDocument, findings: readonly PlanQualityFinding[]): PlanQualityFinding[] {
  const aware = plan.scenarioProves !== undefined || plan.checks?.expectOnBase !== undefined || (plan.e2e?.scenarios.length ?? 0) === 0;
  return findings.filter((finding) => finding.revisable && (aware || !NEEDS_NEW_MEMBERS.has(finding.code)));
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

/** The categories an unreadable plan is put in for the owner (a fixed set; the validator's own words stay planner-only). */
export const PLAN_UNREADABLE_CATEGORIES = ["e2e-shape", "checks-shape", "claims-shape", "too-long", "wrong-e2e-version", "work-breakdown", "other"] as const;
export type PlanUnreadableCategory = (typeof PLAN_UNREADABLE_CATEGORIES)[number];

/** The category of an unreadable answer, from the validator's problems. The result is one of the fixed set; no problem text is kept. */
export function planUnreadableCategory(errors: readonly string[]): PlanUnreadableCategory {
  const text = errors.join("\n").toLowerCase();
  if (/too long/u.test(text)) return "too-long";
  if (/schemaversion|was not offered for this planning step/u.test(text)) return "wrong-e2e-version";
  if (/work breakdown|ordered work|workbreakdown/u.test(text)) return "work-breakdown";
  if (/\be2e\b|scenario|assertion|\bsteps?\b|target/u.test(text)) return "e2e-shape";
  if (/\bchecks?\b/u.test(text)) return "checks-shape";
  if (/claim|decision|evidence|\bwhy\b/u.test(text)) return "claims-shape";
  return "other";
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
