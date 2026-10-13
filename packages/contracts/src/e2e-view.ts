import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { aggregateE2EVerification, E2EExecutionPlanSchema, E2EQualifiedResultSchema, E2ERoundSchema, type E2EExecutionPlan, type E2EQualifiedResult, type E2ERound } from "./e2e.js";

export const E2ESharedSetupViewSchema = z.object({ status: z.enum(["unavailable", "proposed", "needs-input", "mock-ready", "mixed", "runtime-ready"]), selectedTargetIds: z.array(z.string()).max(12), executionPlanDigest: z.string().nullable(), blockingInputIds: z.array(z.string()).max(128), mockSubstitutableInputIds: z.array(z.string()).max(128) }).strict();
export const E2ESharedViewSchema = z.object({ schemaVersion: z.literal(1), setup: E2ESharedSetupViewSchema, e2e: z.object({ status: z.enum(["UNKNOWN", "FAILED", "PASS"]), label: z.string(), executionPlanDigest: z.string().nullable(), expectedGroups: z.number().int().nonnegative(), receivedGroups: z.number().int().nonnegative(), executedCases: z.number().int().nonnegative(), qualifiedCriteria: z.number().int().nonnegative(), requiredCriteria: z.number().int().nonnegative(), unavailableCriteria: z.number().int().nonnegative(), optionalUnavailableCriteria: z.number().int().nonnegative(), mockedComponentIds: z.array(z.string()).max(200), requiredUnexercisedCriteriaIds: z.array(z.string()).max(64) }).strict(), actions: z.array(z.enum(["review-setup", "retry-run", "connect-runtime"])).max(3) }).strict();
export type E2ESharedView = z.infer<typeof E2ESharedViewSchema>;

/** Pure read projection. It consumes the entire plan, authoritative current round, and accepted group results. */
export function buildE2ESharedView(input: { plan: unknown; currentRound: unknown; results: readonly unknown[]; setup: unknown; actor: "owner" | "viewer" }): E2ESharedView {
  const setup = input.setup === null ? E2ESharedSetupViewSchema.parse({ status: "unavailable", selectedTargetIds: [], executionPlanDigest: null, blockingInputIds: [], mockSubstitutableInputIds: [] }) : E2ESharedSetupViewSchema.parse(input.setup);
  const planParsed = input.plan === null ? null : E2EExecutionPlanSchema.safeParse(input.plan);
  const roundParsed = input.currentRound === null ? null : E2ERoundSchema.safeParse(input.currentRound);
  const resultsParsed = input.results.map((result) => E2EQualifiedResultSchema.safeParse(result));
  const valid = planParsed?.success === true && roundParsed?.success === true && resultsParsed.every((result) => result.success);
  if (!valid) return empty(setup, input.actor);
  const plan: E2EExecutionPlan = planParsed.data;
  const round: E2ERound = roundParsed.data;
  const results = resultsParsed.map((result) => result.success ? result.data : null).filter((result): result is E2EQualifiedResult => result !== null);
  const aggregate = aggregateE2EVerification(plan, results, round);
  const aggregateStatus = aggregate.results.find((result) => result.checkId === "project-e2e")?.status ?? "UNKNOWN";
  const groups = new Set(results.filter((result) => round.groupBindings.some((binding) => binding.groupId === result.binding.groupId && canonicalJson(binding) === canonicalJson(result.binding))).map((result) => result.binding.groupId));
  const executedCases = results.filter((result) => groups.has(result.binding.groupId)).reduce((count, result) => count + result.cases.length, 0);
  const requiredCriteria = plan.criteria.filter((criterion) => criterion.required).length;
  const unavailableIds = new Set(plan.unavailableCriteria.map((item) => item.criterionId));
  const requiredUnexercisedCriteriaIds = plan.criteria.filter((criterion) => criterion.required && (unavailableIds.has(criterion.criterionId) || !criterion.expectedCaseIds.length)).map((criterion) => criterion.criterionId);
  const qualifiedCriteria = aggregateStatus === "PASS" ? requiredCriteria : 0;
  const mode = new Set(plan.groups.map((group) => group.mode));
  const label = aggregateStatus === "FAILED" ? "Checks failed" : aggregateStatus !== "PASS" ? "Checks incomplete" : mode.size > 1 ? "Mixed runtime and mock checks" : mode.has("mock-only") ? "Checks passed with mocks" : "Runtime checks passed";
  const actions: E2ESharedView["actions"] = input.actor === "owner" ? (setup.status === "needs-input" ? ["review-setup"] : aggregateStatus === "UNKNOWN" && plan.groups.length > 0 ? ["retry-run"] : []) : [];
  return E2ESharedViewSchema.parse({ schemaVersion: 1, setup, e2e: { status: aggregateStatus, label, executionPlanDigest: plan.digest, expectedGroups: plan.groups.length, receivedGroups: groups.size, executedCases, qualifiedCriteria, requiredCriteria, unavailableCriteria: requiredCriteria - qualifiedCriteria, optionalUnavailableCriteria: plan.criteria.filter((criterion) => !criterion.required && unavailableIds.has(criterion.criterionId)).length, mockedComponentIds: [...new Set(plan.mocks.map((mock) => mock.componentId))].sort(), requiredUnexercisedCriteriaIds }, actions });
}
function empty(setup: E2ESharedView["setup"], actor: "owner" | "viewer"): E2ESharedView {
  return { schemaVersion: 1, setup, e2e: { status: "UNKNOWN", label: "Checks incomplete", executionPlanDigest: null, expectedGroups: 0, receivedGroups: 0, executedCases: 0, qualifiedCriteria: 0, requiredCriteria: 0, unavailableCriteria: 0, optionalUnavailableCriteria: 0, mockedComponentIds: [], requiredUnexercisedCriteriaIds: [] }, actions: actor === "owner" && setup.status === "needs-input" ? ["review-setup"] : [] };
}
