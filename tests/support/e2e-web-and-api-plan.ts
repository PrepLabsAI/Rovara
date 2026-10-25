import { E2EApplicationPlanIntentSchema, type E2EScenario } from "@agentx/contracts";
import type { buildFeatureE2EPlanningContext } from "../../packages/broker/src/e2e/feature-plan-planning-context.js";

/** What the planner is shown of a repository whose setup was approved (`buildFeatureE2EPlanningContext`), when it is available. */
export type PlanningContext = Extract<ReturnType<typeof buildFeatureE2EPlanningContext>, { status: "available" }>;

/**
 * The plan of the web-and-api journey (Task 3.4), on the orders-web fixture: the owner of tenant-a, on one app that serves its page and its API. The web scenario asserts the orders table
 * shows only tenant-a's rows (`text` on its rows, and tenant-b's row not visible); the API scenario asks `GET /api/tenants/tenant-b/orders` and expects 403 (`http-status`).
 */
export function planOwnerWebAndApi(context: PlanningContext) {
  const owner = (kind: "web" | "api") => context.targets.find((item) => item.kind === kind && item.accountProfileId === "orders-owner");
  const web = owner("web");
  const api = owner("api");
  if (web === undefined || api === undefined) throw new Error(`the planning context lacks the owner's web or api target: ${JSON.stringify(context.targets)}`);
  if (web.applicationId !== api.applicationId) throw new Error("the web and api targets are not one application's");
  const base = { requirementId: "tenant-isolation", required: true, accountProfileId: "orders-owner", minimumEvidence: "runtime" as const, requiredRealComponentIds: [] as string[] };
  const scenarios: E2EScenario[] = [
    { ...base, scenarioId: "owner-sees-own-orders", requestedTargetIds: [web.targetId], steps: [{ kind: "navigate", path: "/" }],
      assertions: [{ kind: "text", testId: "order-row-a1", equals: "a1Ada12.5ready" }, { kind: "text", testId: "order-row-a2", equals: "a2Grace23ready" }, { kind: "visible", testId: "order-row-b1", equals: false }] },
    { ...base, scenarioId: "owner-refused-other-tenant-api", requestedTargetIds: [api.targetId],
      steps: [{ kind: "request", requestId: "other-tenant", path: "/api/tenants/tenant-b/orders", method: "GET", body: {} }],
      assertions: [{ kind: "http-status", path: "/api/tenants/tenant-b/orders", method: "GET", equals: 403 }] },
  ];
  const targets = [web, api];
  const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: targets.map((item) => item.targetId), portableOperationRefs: [], mockFixtureRefs: [],
    accountContextRefs: context.accountContextRefs.filter((ref) => ref.applicationId === web.applicationId && ref.profileId === "orders-owner"),
    scenarios, semanticExportDeltas: [],
    applicationRuntimeRefs: targets.flatMap((item) => context.runtimeRefs!.filter((ref) => ref.targetId === item.targetId).map((ref) => ({ ...ref, recipeDigest: ref.recipeDigest! }))),
    runtimeAccountRefs: context.runtimeAccountRefs!.filter((ref) => ref.applicationId === web.applicationId && ref.profileId === "orders-owner"), unavailableTargetRefs: [] });
  const { portableOperationRefs: _portable, mockFixtureRefs: _mocks, unavailableTargetRefs: _unavailable, ...plannerIntent } = intent;
  void _portable; void _mocks; void _unavailable;
  return { web, api, scenarios, intent, plannerIntent };
}
