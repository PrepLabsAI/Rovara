import { z } from "zod";

/**
 * The lighter flow's stored record (decisions 178/179), READERS ONLY in 0.5.18: nothing writes it yet. A workflow snapshot may hold one `flow`, and a review
 * finding may hold one `scale`; every field is optional and every row stored before them still reads. The shapes live here, in one place, so the writers
 * that follow (P1-P5) and Cloud's mirror share them. Unknown keys inside `flow` are refused: a later addition comes through the readers first.
 */

/** How far a change reaches. "small" skips planning; "risky" always gets the full care. */
export const FLOW_TIER_LEVELS = ["small", "standard", "risky"] as const;
export const FlowTierLevelSchema = z.enum(FLOW_TIER_LEVELS);
export type FlowTierLevel = z.infer<typeof FlowTierLevelSchema>;

/** What kind of change a file or a diff is (the quick check that runs is chosen by kind). */
export const FLOW_TIER_KINDS = ["docs", "code_config", "dependency", "install_link", "ci_file"] as const;
export const FlowTierKindSchema = z.enum(FLOW_TIER_KINDS);
export type FlowTierKind = z.infer<typeof FlowTierKindSchema>;

/** The steps a small change may skip. */
export const FLOW_SKIPPABLE_STEPS = ["plan_check", "design_review", "requirements_approval", "design_approval", "plan_approval"] as const;
export const FlowSkippableStepSchema = z.enum(FLOW_SKIPPABLE_STEPS);
export type FlowSkippableStep = z.infer<typeof FlowSkippableStepSchema>;

/** How serious a review finding is, in three words: it must be fixed, it should be fixed, or it is a remark. Kept beside `severity`, which stays as it is. */
export const FINDING_SCALES = ["must_fix", "should_fix", "note"] as const;
export const FindingScaleSchema = z.enum(FINDING_SCALES);
export type FindingScale = z.infer<typeof FindingScaleSchema>;

export const FLOW_TIER_KINDS_MAX = 5;
export const FLOW_TIER_REASONS_MAX = 50;
export const FLOW_REASON_CODE_MAX = 64;
export const FLOW_REASON_PATH_MAX = 500;
export const FLOW_TIER_HISTORY_MAX = 20;
export const FLOW_QUICK_CHECKS_MAX = 10;
export const FLOW_QUICK_CHECK_DETAIL_MAX = 500;
export const FLOW_CATCH_COUNTERS_MAX = 20;
export const FLOW_CATCH_STEP_MAX = 40;
/** The whole `flow` record, as JSON, stays under this many bytes so the snapshot item stays small. */
export const FLOW_MAX_BYTES = 8192;

const Sha40 = z.string().regex(/^[a-f0-9]{40}$/);
const Count = z.number().int().min(0);

export const FlowTierSchema = z.object({
  level: FlowTierLevelSchema,
  kinds: z.array(FlowTierKindSchema).max(FLOW_TIER_KINDS_MAX).refine((kinds) => new Set(kinds).size === kinds.length, "kinds must be unique"),
  /** Where the tier came from: an estimate before coding, the diff after it, or the merge result. */
  source: z.enum(["estimate", "diff", "merge"]),
  reasons: z.array(z.object({
    code: z.string().min(1).max(FLOW_REASON_CODE_MAX).regex(/^[a-z0-9_]+$/),
    path: z.string().min(1).max(FLOW_REASON_PATH_MAX).optional(),
  }).strict()).max(FLOW_TIER_REASONS_MAX),
  headSha: Sha40.optional(),
  mergeBase: Sha40.optional(),
  at: z.string().datetime(),
}).strict();
export type FlowTier = z.infer<typeof FlowTierSchema>;

export const FlowQuickCheckSchema = z.object({
  kind: FlowTierKindSchema,
  outcome: z.enum(["passed", "failed", "not_run"]),
  detail: z.string().max(FLOW_QUICK_CHECK_DETAIL_MAX).optional(),
  at: z.string().datetime(),
}).strict();
export type FlowQuickCheck = z.infer<typeof FlowQuickCheckSchema>;

export const FlowCatchCounterSchema = z.object({
  step: z.string().min(1).max(FLOW_CATCH_STEP_MAX),
  findings: Count,
  mustFix: Count,
  changedCode: Count,
}).strict();
export type FlowCatchCounter = z.infer<typeof FlowCatchCounterSchema>;

/** The bytes of JSON a `flow` record takes against `FLOW_MAX_BYTES`. One definition, so a writer can measure a record before adding it. */
export function flowRecordBytes(flow: unknown): number {
  return new TextEncoder().encode(JSON.stringify(flow)).length;
}

export const WorkflowFlowSchema = z.object({
  /** The version of the rules that decided the tier; required, so a record always says which rules wrote it. */
  rulesVersion: z.number().int().min(0),
  tier: FlowTierSchema.optional(),
  /** Earlier tiers, oldest first: a tier only goes up, and this is the record of it. */
  tierHistory: z.array(FlowTierSchema).max(FLOW_TIER_HISTORY_MAX).optional(),
  skippedSteps: z.array(FlowSkippableStepSchema).max(FLOW_SKIPPABLE_STEPS.length)
    .refine((steps) => new Set(steps).size === steps.length, "skipped steps must be unique").optional(),
  quickChecks: z.array(FlowQuickCheckSchema).max(FLOW_QUICK_CHECKS_MAX).optional(),
  grewAfterBuild: z.object({ from: FlowTierLevelSchema, to: FlowTierLevelSchema, at: z.string().datetime() }).strict().optional(),
  reviewDoubt: z.object({ open: Count }).strict().optional(),
  moments: z.object({ used: Count, budget: Count }).strict().optional(),
  catchCounters: z.array(FlowCatchCounterSchema).max(FLOW_CATCH_COUNTERS_MAX).optional(),
}).strict().refine((flow) => flowRecordBytes(flow) <= FLOW_MAX_BYTES, `the flow record must stay under ${String(FLOW_MAX_BYTES)} bytes`);
export type WorkflowFlow = z.infer<typeof WorkflowFlowSchema>;
