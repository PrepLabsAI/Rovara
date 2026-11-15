// The lighter flow's stage selection: the change tier picks the planning steps. One pure function decides which of the skippable steps a task skips, and the helpers here keep the lighter flow's own
// quick-check entries on the `flow` record without ever touching (or imitating) the records the review steps and the reviewer floor leave there.
//
// The rules:
//   - only an install with the lighter flow switched on skips anything, and only for a change whose CURRENT estimate is exactly small, when every estimate written for the task before it was small too
//     (the merge gate reads the first estimate as the level the planning steps were chosen at, so a task that was ever estimated higher keeps today's steps);
//   - small skips every planning step today's flow would still run for the task (plan check, design review, the requirements, design and plan approvals), except what a person asked for themselves;
//   - standard and risky keep today's steps.
import {
  FLOW_QUICK_CHECK_DETAIL_MAX, FLOW_QUICK_CHECKS_MAX, WorkflowSnapshotSchema, advanceStage, type FlowQuickCheck, type FlowSkippableStep, type FlowTier, type FlowTierKind, type IntentAssessment, type PlanDocument, type WorkflowFlow, type WorkflowSnapshot,
} from "@agentx/contracts";
import { estimateTier, fitFlow, recordTier, TIER_RULES_VERSION } from "../decisions/change-tier.js";
import { pathsIn, planFiles } from "../decisions/plan-facts.js";
import { DECISION_PLAN_COST_MEDIUM_USD } from "../decisions/risk-tier.js";

export interface StageSelectionInput {
  /** The estimate of the CURRENT plan (or of the request and Understand's reading, before a plan exists). Undefined: nothing is known, nothing is skipped. */
  estimate: Pick<FlowTier, "level" | "kinds" | "source"> | undefined;
  /** Every tier already on the task's record (`flow.tierHistory` and `flow.tier`), oldest first. */
  recorded: ReadonlyArray<Pick<FlowTier, "level" | "source">>;
  /** The skippable steps today's flow would still run for this task from here, in order. */
  planned: readonly FlowSkippableStep[];
  /** The install's switch. */
  lighterFlow: boolean;
  /** Steps a person asked for themselves (`design first:`): never skipped. */
  asked?: readonly FlowSkippableStep[] | undefined;
}

export interface StageSelection {
  run: FlowSkippableStep[];
  skip: FlowSkippableStep[];
  /** The quick checks the finished change gets, by what it touches (the estimate's kinds; the diff's kinds replace them after the build). */
  quickChecks: FlowTierKind[];
}

/** Which of the planned steps run and which are skipped. Only `level === "small"`, from an estimate, with the switch on and no earlier estimate above small, skips anything. */
export function selectStages(input: StageSelectionInput): StageSelection {
  const estimate = input.estimate;
  const everSmall = input.recorded.every((tier) => tier.source !== "estimate" || tier.level === "small") && input.recorded.every((tier) => tier.source === "estimate");
  const small = input.lighterFlow && estimate !== undefined && estimate.source === "estimate" && estimate.level === "small" && everSmall;
  if (!small) return { run: [...input.planned], skip: [], quickChecks: [] };
  const asked = new Set(input.asked ?? []);
  return {
    run: input.planned.filter((step) => asked.has(step)),
    skip: input.planned.filter((step) => !asked.has(step)),
    quickChecks: estimate.kinds.length === 0 ? ["code_config"] : [...estimate.kinds],
  };
}

/** The skipped steps after this selection: the ones already skipped and the new ones, in the contract's order, never fewer. */
export function withSkipped(flow: WorkflowFlow | undefined, skip: readonly FlowSkippableStep[]): WorkflowFlow | undefined {
  if (skip.length === 0) return flow;
  const order: readonly FlowSkippableStep[] = ["plan_check", "design_review", "requirements_approval", "design_approval", "plan_approval"];
  const all = new Set([...(flow?.skippedSteps ?? []), ...skip]);
  return fitFlow({ ...(flow ?? { rulesVersion: TIER_RULES_VERSION }), skippedSteps: order.filter((step) => all.has(step)) });
}

/** The files the request and Understand's reading name (never the agent's words about the change: only the paths in them, which the classifier judges by name). */
export function namedPaths(requestText: string | undefined, assessment: IntentAssessment | undefined): string[] {
  const texts = [requestText ?? "", ...(assessment?.kind === "ready" ? [assessment.restatement, ...assessment.assumptions] : [])];
  return [...new Set(texts.flatMap((text) => pathsIn(text)))];
}

// ---- the lighter flow's own quick-check entries

/** Every detail the lighter flow writes starts with this word, so none can ever read as a record of the review steps or of the floor (theirs start `tier_`). */
const OWN_PREFIX = "check ";
/** The most entries of its own the lighter flow keeps: one per kind (five) and one for the last review it ran itself (the grown tier's, or the code review of a head no review step saw). The review steps and the floor keep at most four (the questions, one per tier), so all fit in ten. */
export const OWN_QUICK_CHECKS_MAX = FLOW_QUICK_CHECKS_MAX - 4;

/** Whether an entry is one the review steps or the floor left (never read as a quick check, never replaced here). */
export const isTierRecord = (check: Pick<FlowQuickCheck, "detail">): boolean => (check.detail ?? "").startsWith("tier_");

/** A quick-check entry as the lighter flow writes it: its detail one plain line, cut, and always under its own prefix. */
export function quickCheckEntry(input: { kind: FlowTierKind; outcome: FlowQuickCheck["outcome"]; detail?: string | undefined; at: string }): FlowQuickCheck {
  const plain = (input.detail ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/gu, " ").trim();
  const detail = `${OWN_PREFIX}${plain}`.slice(0, FLOW_QUICK_CHECK_DETAIL_MAX);
  return { kind: input.kind, outcome: input.outcome, detail, at: input.at };
}

/** The slot an own entry fills (its first word after the prefix): a new entry of the same slot replaces the old one. */
const slotOf = (check: Pick<FlowQuickCheck, "detail">): string => (check.detail ?? "").slice(OWN_PREFIX.length).split(" ")[0] ?? "";

/** The `flow` record with the lighter flow's entries written: the records of the review steps and the floor are kept as they are, own entries replace those of the same slot, and own entries never pass their cap. */
export function withQuickChecks(flow: WorkflowFlow | undefined, entries: readonly FlowQuickCheck[]): WorkflowFlow {
  const base = flow ?? { rulesVersion: TIER_RULES_VERSION };
  const records = (base.quickChecks ?? []).filter(isTierRecord);
  const fresh = entries.map((entry) => (entry.detail?.startsWith(OWN_PREFIX) === true ? entry : quickCheckEntry(entry)));
  const slots = new Set(fresh.map(slotOf));
  const own = [...(base.quickChecks ?? []).filter((check) => !isTierRecord(check) && !slots.has(slotOf(check))), ...fresh].slice(-OWN_QUICK_CHECKS_MAX);
  return fitFlow({ ...base, rulesVersion: TIER_RULES_VERSION, quickChecks: [...own, ...records] });
}

/** The lighter flow's own entries (never the records of the review steps or of the floor). */
export const ownQuickChecks = (flow: WorkflowFlow | undefined): FlowQuickCheck[] => (flow?.quickChecks ?? []).filter((check) => !isTierRecord(check));

/** An own entry for exactly this head that failed: the merge stays refused while one stands. */
export const failedQuickCheck = (flow: WorkflowFlow | undefined, headSha: string): FlowQuickCheck | undefined =>
  ownQuickChecks(flow).find((check) => check.outcome === "failed" && (check.detail ?? "").includes(`head=${headSha}`));

// ---- where the tier picks: after Understand, and when a coding plan is submitted

/** The tiers on a record, oldest first (the merge gate reads the first estimate among them as the planning level). */
const tiersOf = (flow: WorkflowFlow | undefined): FlowTier[] => [...(flow?.tierHistory ?? []), ...(flow?.tier === undefined ? [] : [flow.tier])];

/**
 * After Understand (lighter flow on): the estimate from the request and the files it and Understand's reading name. When those name files and the estimate is exactly small, the design review the mode would have
 * switched on is not switched on (it forced the Full path, so its requirements and design approvals go with it), and a Full path Understand chose (not a person) becomes Quick. What a person asked for stays
 * (`design first:`, a path they named). The skip and its record are in the returned workflow, which the caller commits in one write. `assessed` is the workflow before the design review was considered, `considered` after.
 */
export function afterUnderstand(input: {
  assessed: WorkflowSnapshot; considered: WorkflowSnapshot; requestText: string | undefined; assessment: IntentAssessment; explicitPath: boolean; at: string;
}): WorkflowSnapshot {
  const { assessed, considered, assessment } = input;
  if (assessment.kind !== "ready" || considered.stage !== "PLAN" || considered.state !== "READY" || considered.definitionVersion !== "1.1.0") return considered;
  const paths = namedPaths(input.requestText, assessment);
  // Nothing named: nothing is known of the size yet; the plan's estimate decides (an unknown here is not written as the level planning was chosen at).
  if (paths.length === 0) return considered;
  const estimate = wordsRaised(estimateTier({ plannedPaths: paths, requestText: input.requestText }, { at: input.at }), [input.requestText, assessment.restatement, ...assessment.assumptions]);
  const reviewOn = considered.designReview !== undefined && assessed.designReview === undefined;
  const fullPath = (reviewOn ? assessed : considered).path === "FULL";
  const planned: FlowSkippableStep[] = [...(reviewOn ? ["design_review" as const] : []), ...(reviewOn || fullPath ? ["requirements_approval" as const, "design_approval" as const] : [])];
  const personDesign = considered.designReview?.decidedBy === "person";
  const asked: FlowSkippableStep[] = [...(personDesign ? ["design_review" as const, "requirements_approval" as const, "design_approval" as const] : []), ...(input.explicitPath && fullPath ? ["requirements_approval" as const, "design_approval" as const] : [])];
  const selection = selectStages({ estimate, recorded: tiersOf(considered.flow), planned, lighterFlow: true, asked });
  const recorded = recordTier(considered.flow, estimate).flow;
  if (selection.skip.length === 0) return { ...considered, flow: recorded };
  // The design review is not switched on, and the Full path it (or Understand) chose becomes Quick: the plan comes next.
  const base = selection.skip.includes("design_review") ? assessed : considered;
  const quick = selection.skip.includes("requirements_approval") ? toQuick(base) : base;
  return { ...quick, flow: withSkipped(recorded, selection.skip) };
}

/** The workflow on the Quick path: a coding plan comes next, with no requirements or design. */
function toQuick(workflow: WorkflowSnapshot): WorkflowSnapshot {
  if (workflow.path !== "FULL") return workflow;
  const { reviewPhase: _phase, ...rest } = workflow;
  void _phase;
  const intent = workflow.intent;
  const assessment = intent?.assessment?.kind === "ready" ? { ...intent.assessment, path: "QUICK" as const } : intent?.assessment;
  return WorkflowSnapshotSchema.parse({ ...rest, path: "QUICK", ...(intent === undefined ? {} : { intent: { ...intent, ...(assessment === undefined ? {} : { assessment }) } }) });
}

/**
 * When a coding plan is submitted (lighter flow on): the plan's estimate, from the files the plan names and the files the request and Understand's reading name, replaces the one before it. When it is exactly small
 * (and every estimate before it was small), the plan check and the plan approval are skipped: the workflow goes straight to coding, with no decision, no approval and no critique recorded. The review step after the build
 * runs as today (code and security: the contract requires both before a pull request step). The skip and its record are in the returned workflow, committed in one write by the caller.
 * Returns undefined when nothing is skipped (today's steps run).
 */
export function smallPlanRoute(input: {
  submitted: WorkflowSnapshot; plan: PlanDocument | undefined; requestText: string | undefined; noChangeNeeded: boolean; at: string;
  /** The plan as text (its Markdown, or the structured plan's rendering). Undefined: it could not be read, and nothing is skipped. */
  planText: string | undefined;
  /** The run's expected cost, high end (dollars). Over the medium line the plan still goes to a person. */
  costHighUsd: number | undefined;
}): { workflow: WorkflowSnapshot; skipped: FlowSkippableStep[] } | undefined {
  const { submitted } = input;
  const waiting = (submitted.stage === "PLAN_CRITIQUE" && submitted.state === "READY") || (submitted.stage === "PLAN_REVIEW" && submitted.state === "WAITING");
  if (!waiting || input.noChangeNeeded || submitted.definitionVersion !== "1.1.0" || submitted.path !== "QUICK" || submitted.designReview !== undefined) return undefined;
  if ((input.plan?.workBreakdown?.items.length ?? 0) > 0) return undefined;
  const assessment = submitted.intent?.assessment;
  const paths = [...new Set([...(input.plan === undefined ? [] : planFiles(input.plan)), ...namedPaths(input.requestText, assessment)])];
  // The plan's own words count against it, never for it: its sensitive words (the classifier's list, read over the plan as over the request), a path it names that the estimate's files do not hold, and, for
  // a documents-only estimate, words for code. What the plan says about itself ("docs only") is never read as a reason to lower anything.
  const estimate = wordsRaised(planRaised(estimateTier({ plannedPaths: paths, requestText: [input.requestText ?? "", input.planText ?? ""].join("\n") }, { at: input.at }), paths, input.planText, input.requestText), [input.requestText, input.planText]);
  const before = tiersOf(submitted.flow);
  const recorded = recordTier(submitted.flow, estimate).flow;
  const planned: FlowSkippableStep[] = [...(submitted.stage === "PLAN_CRITIQUE" ? ["plan_check" as const] : []), "plan_approval"];
  // A run expected to cost more than the medium line goes to a person, whatever its size (the cost-graded plan approval); a plan that could not be read skips nothing.
  // An estimate that could not be made (a store that did not answer) keeps the approval too: unknown is never cheap.
  if (input.planText === undefined || input.costHighUsd === undefined || input.costHighUsd > DECISION_PLAN_COST_MEDIUM_USD) return { workflow: { ...submitted, flow: recorded }, skipped: [] };
  const selection = selectStages({ estimate, recorded: before, planned, lighterFlow: true });
  if (selection.skip.length === 0) return { workflow: { ...submitted, flow: recorded }, skipped: [] };
  const advance = advanceStage(submitted, "IMPLEMENT");
  if (advance.stage !== "IMPLEMENT") return { workflow: { ...submitted, flow: recorded }, skipped: [] };
  const { critique: _critique, ...rest } = submitted;
  void _critique;
  // The review step keeps both reviewers: the workflow's contract requires a code and a security review before a pull request step, so the security reviewer cannot be dropped without a readers release.
  const workflow = WorkflowSnapshotSchema.parse({
    ...rest, stage: "IMPLEMENT", state: "READY", ...(advance.programStepId === undefined ? {} : { programStepId: advance.programStepId }),
    flow: withSkipped(recorded, selection.skip),
  });
  return { workflow, skipped: selection.skip };
}

/** Words for code in a request or plan of a documents-only change: such a change is not documents only, whatever its files. */
const CODE_WORDS = /\b(?:cli|parser|loader|config(?:uration)? (?:file|loader|option)|environment variables?|endpoints?|functions?|class(?:es)?|methods?|api|scripts?|database|schema|server|handlers?|modules?|packages?|dependenc(?:y|ies)|source code|entry point|arguments?)\b/iu;

/** The estimate raised to at least standard by the plan's words (only up): a path the estimate's files do not hold, or words for code in a documents-only change. */
export function planRaised(estimate: FlowTier, paths: readonly string[], planText: string | undefined, requestText: string | undefined): FlowTier {
  if (estimate.level !== "small") return estimate;
  const known = new Set(paths.map((path) => path.replace(/^\.\//u, "")));
  const other = pathsIn(planText ?? "").filter((path) => !known.has(path));
  const reasons: FlowTier["reasons"] = [];
  if (other.length > 0) reasons.push({ code: "plan_names_other_files", path: other[0]!.slice(0, 200) });
  if (estimate.kinds.length > 0 && estimate.kinds.every((kind) => kind === "docs") && CODE_WORDS.test(`${planText ?? ""}\n${requestText ?? ""}`)) reasons.push({ code: "plan_names_code" });
  return reasons.length === 0 ? estimate : { ...estimate, level: "standard", reasons: [...reasons, ...estimate.reasons].slice(0, 50) };
}

/** Whether the current coding plan went to coding without its approval (the lighter flow skipped it): it is then never called approved. */
export function planApprovalSkipped(workflow: Pick<WorkflowSnapshot, "flow" | "decisions" | "artifacts">, planSha256?: string): boolean {
  if (workflow.flow?.skippedSteps?.includes("plan_approval") !== true) return false;
  const digest = planSha256 ?? workflow.artifacts.filter((artifact) => artifact.type === "plan").at(-1)?.sha256;
  return !workflow.decisions.some((decision) => decision.decision === "APPROVE" && decision.artifactDigest === digest);
}

/** The planning steps Understand skipped (the design review, the requirements and design approvals): restored when the plan's estimate is above small. */
export const UNDERSTAND_SKIPS: readonly FlowSkippableStep[] = ["design_review", "requirements_approval", "design_approval"];

/**
 * The workflow ready to plan again on today's path, when Understand skipped steps for a change the plan shows is not small: `before` is the workflow as it stood before the plan was submitted (planning,
 * no plan yet). The steps it gives back are dropped from `skippedSteps` (they will run), the estimate stays on the record, and the restore is noted. The caller then switches the design review on again
 * when it was the step skipped, else the Full path (`toFull`) brings back the requirements and design approvals.
 */
export function restoredForPlanning(before: WorkflowSnapshot, estimated: WorkflowFlow | undefined, at: string): { workflow: WorkflowSnapshot; restored: FlowSkippableStep[] } | undefined {
  const skipped = estimated?.skippedSteps ?? [];
  const restored = skipped.filter((step) => UNDERSTAND_SKIPS.includes(step));
  if (restored.length === 0 || before.stage !== "PLAN" || before.state !== "RUNNING") return undefined;
  const left = skipped.filter((step) => !restored.includes(step));
  const { skippedSteps: _skipped, ...flowRest } = estimated!;
  void _skipped;
  const noted = withQuickChecks({ ...flowRest, ...(left.length === 0 ? {} : { skippedSteps: left }) }, [quickCheckEntry({ kind: "code_config", outcome: "not_run", at,
    detail: `restored ${restored.join(", ")}: the plan's estimate is ${estimated?.tier?.level ?? "unknown"}, so the steps a small change skips run as today` })]);
  return { workflow: WorkflowSnapshotSchema.parse({ ...before, revision: before.revision + 1, state: "READY", flow: noted, updatedAt: at }), restored };
}

/** The workflow on the Full path: requirements first, then the design, then the plan (each approved by a person). */
export function toFull(workflow: WorkflowSnapshot): WorkflowSnapshot {
  if (workflow.path === "FULL") return workflow;
  const intent = workflow.intent;
  const assessment = intent?.assessment?.kind === "ready" ? { ...intent.assessment, path: "FULL" as const } : intent?.assessment;
  return WorkflowSnapshotSchema.parse({ ...workflow, path: "FULL", reviewPhase: "REQUIREMENTS", ...(intent === undefined ? {} : { intent: { ...intent, ...(assessment === undefined ? {} : { assessment }) } }) });
}

/** Words of a sensitive area the classifier's own list does not hold yet (sessions, roles, admin, tokens in cookies, cross-origin rules, access guards): a request or plan that says one is at least standard. */
const MORE_SENSITIVE_WORDS = /\b(?:sessions?|roles?|admins?|administrators?|jwts?|cookies?|cors|permissions?|authori[sz]\w*|guards?|verif(?:y|ies|ied|ication)|csrf|xsrf)\b/iu;

/** The estimate raised to at least standard by those words (only up). */
export function wordsRaised(estimate: FlowTier, texts: ReadonlyArray<string | undefined>): FlowTier {
  if (estimate.level !== "small" || !texts.some((text) => text !== undefined && MORE_SENSITIVE_WORDS.test(text))) return estimate;
  return { ...estimate, level: "standard", reasons: [{ code: "request_mentions_sensitive_area" }, ...estimate.reasons].slice(0, 50) };
}
