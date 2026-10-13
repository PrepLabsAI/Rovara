import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { copyBoundedE2EJsonData } from "./e2e-safe-data.js";
import { aggregateE2EVerification, projectE2EVerification, E2EExecutionPlanSchema, E2EQualifiedResultSchema, E2ERoundSchema, type E2EExecutionPlan, type E2EQualifiedResult } from "./e2e.js";

export const E2ESharedSetupViewSchema = z.object({ status: z.enum(["unavailable", "proposed", "needs-input", "mock-ready", "mixed", "runtime-ready"]), selectedTargetIds: z.array(z.string()).max(12), executionPlanDigest: z.string().nullable(), blockingInputIds: z.array(z.string()).max(128), mockSubstitutableInputIds: z.array(z.string()).max(128) }).strict();
export const E2ESharedViewSchema = z.object({ schemaVersion: z.literal(1), setup: E2ESharedSetupViewSchema, e2e: z.object({ status: z.enum(["UNKNOWN", "FAILED", "PASS"]), label: z.string(), executionPlanDigest: z.string().nullable(), expectedGroups: z.number().int().nonnegative(), receivedGroups: z.number().int().nonnegative(), executedCases: z.number().int().nonnegative(), qualifiedCriteria: z.number().int().nonnegative(), requiredCriteria: z.number().int().nonnegative(), unavailableCriteria: z.number().int().nonnegative(), optionalUnavailableCriteria: z.number().int().nonnegative(), mockedComponentIds: z.array(z.string()).max(200), observedMockedComponentIds: z.array(z.string()).max(200), unexercisedBehaviors: z.array(z.string()).max(256), policyPresence: z.enum(["present", "absent"]), workflowPhase: z.string().max(120).nullable(), requiredUnexercisedCriteriaIds: z.array(z.string()).max(64) }).strict(), actions: z.array(z.enum(["review-setup", "retry-run", "connect-runtime"])).max(3) }).strict();
export type E2ESharedView = z.infer<typeof E2ESharedViewSchema>;

/** Pure read projection. It consumes the entire plan, authoritative current round, and accepted group results. */
export function buildE2ESharedView(input: { plan: unknown; currentRound: unknown; results: readonly unknown[]; setup: unknown; actor: "owner" | "viewer"; control?: { policyPresent: boolean; workflowPhase: string | null; ownerActionProposals: readonly ("review-setup" | "retry-run" | "connect-runtime")[] } }): E2ESharedView {
  const fallbackSetup = { status: "unavailable" as const, selectedTargetIds: [], executionPlanDigest: null, blockingInputIds: [], mockSubstitutableInputIds: [] };
  try { input = copyBoundedE2EJsonData(input, { maxBytes: 262_144, maxDepth: 64, maxNodes: 32_768 }) as typeof input; }
  catch { return empty(fallbackSetup); }
  let control: NonNullable<typeof input.control> = { policyPresent: false, workflowPhase: null, ownerActionProposals: [] };
  try {
    if (input.control) {
      const copied = copyBoundedE2EJsonData(input.control, { maxBytes: 4096, maxDepth: 8 }) as typeof control;
      const proposals: unknown = copied.ownerActionProposals;
      const allowed = ["review-setup", "retry-run", "connect-runtime"];
      if (typeof copied.policyPresent === "boolean" && (copied.workflowPhase === null || typeof copied.workflowPhase === "string") && Array.isArray(proposals) && proposals.every((action: unknown) => typeof action === "string" && allowed.includes(action))) control = { ...copied, ownerActionProposals: [...new Set(proposals)].slice(0, 3) as typeof control.ownerActionProposals };
    }
  } catch { /* absent policy and proposals are the safe projection */ }
  let setup: E2ESharedView["setup"] = fallbackSetup;
  try { setup = E2ESharedSetupViewSchema.parse(copyBoundedE2EJsonData(input.setup, { maxBytes: 262_144, maxDepth: 64 })); } catch { /* malformed projection inputs stay unavailable */ }
  let planParsed: ReturnType<typeof E2EExecutionPlanSchema.safeParse> | null = null;
  let roundParsed: ReturnType<typeof E2ERoundSchema.safeParse> | null = null;
  try { if (input.plan !== null) planParsed = E2EExecutionPlanSchema.safeParse(copyBoundedE2EJsonData(input.plan, { maxBytes: 262_144, maxDepth: 64 })); } catch { /* retain no untrusted plan */ }
  try { if (input.currentRound !== null) roundParsed = E2ERoundSchema.safeParse(copyBoundedE2EJsonData(input.currentRound, { maxBytes: 262_144, maxDepth: 64 })); } catch { /* no current round */ }
  const plan = planParsed?.success ? planParsed.data : null;
  const round = roundParsed?.success ? roundParsed.data : null;
  if (plan && (setup.executionPlanDigest !== plan.digest || canonicalJson([...setup.selectedTargetIds].sort()) !== canonicalJson(plan.effectiveTargets.map((target) => target.targetId).sort()))) setup = fallbackSetup;
  const parsedResults: E2EQualifiedResult[] = [];
  if (Array.isArray(input.results)) {
    for (const result of input.results.slice(0, 256)) {
      try { const safe = copyBoundedE2EJsonData(result, { maxBytes: 262_144, maxDepth: 64 }); const parsed = E2EQualifiedResultSchema.safeParse(safe); if (parsed.success) parsedResults.push(parsed.data); } catch { /* malformed individual deliveries do not erase the plan */ }
    }
  }
  if (!plan) return empty(setup, input.actor, control);
  const requiredCriteria = plan.criteria.filter((criterion) => criterion.required).length;
  const unavailableIds = new Set(plan.unavailableCriteria.map((item) => item.criterionId));
  if (!round || round.executionPlanDigest !== plan.digest) return partialEmpty(plan, setup, input.actor, control);
  const currentBindings = new Map(round.groupBindings.map((binding) => [binding.groupId, binding]));
  const selected: E2EQualifiedResult[] = [];
  const seen = new Map<string, E2EQualifiedResult>();
  const conflicts = new Set<string>();
  for (const result of parsedResults) {
    const binding = currentBindings.get(result.binding.groupId);
    if (!binding || canonicalJson(binding) !== canonicalJson(result.binding)) continue;
    const previous = seen.get(result.binding.runId);
    if (previous && canonicalJson(previous) !== canonicalJson(result)) { conflicts.add(result.binding.runId); continue; }
    seen.set(result.binding.runId, result);
  }
  for (const [runId, result] of seen) if (!conflicts.has(runId)) selected.push(result);
  const aggregate = aggregateE2EVerification(plan, selected, round);
  const aggregateStatus = aggregate.results.find((result) => result.checkId === "project-e2e")?.status ?? "UNKNOWN";
  const groups = new Set(selected.map((result) => result.binding.groupId));
  const executedCaseIds = new Set(selected.flatMap((result) => result.cases.filter((item) => item.status === "passed" || item.status === "failed" || item.status === "unstable" || item.status === "unavailable").map((item) => item.caseId)));
  const executedCases = executedCaseIds.size;
  const qualifiedCaseIds = new Set<string>();
  const observedMockedComponentIds = new Set<string>();
  const unexercisedBehaviors = new Set<string>();
  for (const result of selected) {
    const projected = projectE2EVerification(result).results.find((item) => item.checkId === "project-e2e")?.status;
    for (const observed of result.cases) {
      const expected = result.binding.expectedCases.find((item) => item.caseId === observed.caseId);
      const ranks = { source: 0, "mock-contract": 1, runtime: 2, "external-live": 3 } as const;
      const admissionTime = Date.parse(result.binding.admittedAt);
      const deadline = Date.parse(result.binding.deadlineAt);
      const startedAt = Date.parse(result.startedAt);
      const finishedAt = Date.parse(result.finishedAt);
      const receivedAt = Date.parse(result.receivedAt);
      const resultFresh = [admissionTime, deadline, startedAt, finishedAt, receivedAt].every(Number.isFinite) && startedAt >= admissionTime && finishedAt >= startedAt && finishedAt <= deadline && receivedAt >= finishedAt && receivedAt <= deadline;
      const caseQualified = resultFresh && result.status === "passed" && result.qualification === "trusted" && result.cleanup === "confirmed" && observed.status === "passed" && expected !== undefined && observed.attemptCount === 1 && observed.executionDescriptorDigest === expected.executionDescriptorDigest && observed.accountContextId === expected.accountContextId && observed.accountContextDigest === expected.accountContextDigest && observed.assertionDigest === expected.assertionDigest && observed.assertionReceipts.length === expected.assertionDigests.length && observed.assertionReceipts.every((receipt, index) => receipt.assertionIndex === index && receipt.assertionDigest === expected.assertionDigests[index] && receipt.status === "passed") && observed.coverage.subject === "candidate" && ranks[observed.coverage.observedScope] >= ranks[expected.minimumEvidence] && expected.requiredRealComponentIds.every((id) => observed.coverage.realComponentIds.includes(id)) && observed.coverage.unexercisedBehaviors.length === 0;
      if ((projected === "PASS" || caseQualified) && expected) qualifiedCaseIds.add(expected.caseId);
      for (const componentId of observed.coverage.observedMockedComponentIds) observedMockedComponentIds.add(componentId);
      for (const behavior of observed.coverage.unexercisedBehaviors) unexercisedBehaviors.add(behavior);
    }
  }
  const qualifiedCriteriaIds = new Set(plan.criteria.filter((criterion) => criterion.expectedCaseIds.length > 0 && criterion.expectedCaseIds.every((caseId) => qualifiedCaseIds.has(caseId))).map((criterion) => criterion.criterionId));
  const requiredUnexercisedCriteriaIds = plan.criteria.filter((criterion) => criterion.required && (unavailableIds.has(criterion.criterionId) || !criterion.expectedCaseIds.length)).map((criterion) => criterion.criterionId);
  const qualifiedCriteria = [...qualifiedCriteriaIds].filter((id) => plan.criteria.find((item) => item.criterionId === id)?.required).length;
  const mode = new Set(plan.groups.map((group) => group.mode));
  const label = aggregateStatus === "FAILED" ? "Checks failed" : aggregateStatus !== "PASS" ? "Checks incomplete" : mode.size > 1 ? "Mixed runtime and mock checks" : mode.has("mock-only") ? "Checks passed with mocks" : "Runtime checks passed";
  const actions: E2ESharedView["actions"] = input.actor === "owner" && control.policyPresent ? control.ownerActionProposals.filter((action) => action === "review-setup" ? control.workflowPhase === "setup" && setup.status === "needs-input" : action === "retry-run" ? control.workflowPhase === "e2e" && aggregateStatus === "UNKNOWN" && plan.groups.length > 0 : control.workflowPhase === "setup" && setup.status === "mock-ready") : [];
  return E2ESharedViewSchema.parse({ schemaVersion: 1, setup, e2e: { status: aggregateStatus, label, executionPlanDigest: plan.digest, expectedGroups: plan.groups.length, receivedGroups: groups.size, executedCases, qualifiedCriteria, requiredCriteria, unavailableCriteria: requiredCriteria - qualifiedCriteria, optionalUnavailableCriteria: plan.criteria.filter((criterion) => !criterion.required && unavailableIds.has(criterion.criterionId)).length, mockedComponentIds: [...new Set(plan.mocks.map((mock) => mock.componentId))].sort(), observedMockedComponentIds: [...observedMockedComponentIds].sort(), unexercisedBehaviors: [...unexercisedBehaviors].sort().slice(0, 256), policyPresence: control.policyPresent ? "present" : "absent", workflowPhase: control.workflowPhase, requiredUnexercisedCriteriaIds: [...new Set([...requiredUnexercisedCriteriaIds, ...plan.criteria.filter((item) => item.required && !qualifiedCriteriaIds.has(item.criterionId)).map((item) => item.criterionId)])].slice(0, 64) }, actions });
}
function partialEmpty(plan: E2EExecutionPlan, setup: E2ESharedView["setup"], actor: "owner" | "viewer", control: { policyPresent: boolean; workflowPhase: string | null; ownerActionProposals: readonly ("review-setup" | "retry-run" | "connect-runtime")[] }): E2ESharedView {
  const required = plan.criteria.filter((item) => item.required);
  return E2ESharedViewSchema.parse({ schemaVersion: 1, setup, e2e: { status: "UNKNOWN", label: "Checks incomplete", executionPlanDigest: plan.digest, expectedGroups: plan.groups.length, receivedGroups: 0, executedCases: 0, qualifiedCriteria: 0, requiredCriteria: required.length, unavailableCriteria: required.length, optionalUnavailableCriteria: plan.criteria.filter((item) => !item.required).length, mockedComponentIds: [...new Set(plan.mocks.map((item) => item.componentId))].sort(), observedMockedComponentIds: [], unexercisedBehaviors: [], policyPresence: control.policyPresent ? "present" : "absent", workflowPhase: control.workflowPhase, requiredUnexercisedCriteriaIds: required.map((item) => item.criterionId).slice(0, 64) }, actions: actionProposals(actor, setup, control, "UNKNOWN", plan.groups.length) });
}
function empty(setup: E2ESharedView["setup"], actor: "owner" | "viewer" = "viewer", control: { policyPresent: boolean; workflowPhase: string | null; ownerActionProposals: readonly ("review-setup" | "retry-run" | "connect-runtime")[] } = { policyPresent: false, workflowPhase: null, ownerActionProposals: [] }): E2ESharedView {
  return { schemaVersion: 1, setup, e2e: { status: "UNKNOWN", label: "Checks incomplete", executionPlanDigest: null, expectedGroups: 0, receivedGroups: 0, executedCases: 0, qualifiedCriteria: 0, requiredCriteria: 0, unavailableCriteria: 0, optionalUnavailableCriteria: 0, mockedComponentIds: [], observedMockedComponentIds: [], unexercisedBehaviors: [], policyPresence: control.policyPresent ? "present" : "absent", workflowPhase: control.workflowPhase, requiredUnexercisedCriteriaIds: [] }, actions: actionProposals(actor, setup, control, "UNKNOWN", 0) };
}
function actionProposals(actor: "owner" | "viewer", setup: E2ESharedView["setup"], control: { policyPresent: boolean; workflowPhase: string | null; ownerActionProposals: readonly ("review-setup" | "retry-run" | "connect-runtime")[] }, status: "UNKNOWN" | "FAILED" | "PASS", groups: number): E2ESharedView["actions"] {
  if (actor !== "owner" || !control.policyPresent) return [];
  return control.ownerActionProposals.filter((action) => action === "review-setup" ? control.workflowPhase === "setup" && setup.status === "needs-input" : action === "retry-run" ? control.workflowPhase === "e2e" && status === "UNKNOWN" && groups > 0 : control.workflowPhase === "setup" && setup.status === "mock-ready");
}
