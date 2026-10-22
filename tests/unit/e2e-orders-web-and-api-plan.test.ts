import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { E2E_APPLICATION_ADMISSION_SCHEMA_V2, canonicalJson, e2eRuntimeBindingKey } from "@agentx/contracts";
import { decodeE2EApplicationExecutionAdmission, e2eCompiledRuntime, validateE2EApplicationExecutionAdmission } from "@agentx/verifier";
import { buildApplicationExecutionAdmission } from "../../packages/broker/src/e2e/application-admission.js";
import { evaluateApplicationPlanApproval } from "../../packages/broker/src/e2e/application-plan-approval.js";
import { buildFeatureE2EPlanningContext } from "../../packages/broker/src/e2e/feature-plan-planning-context.js";
import { webApiRuntimeCapabilities } from "../../packages/broker/src/aws/e2e-feature-verifier-catalog.js";
import { createRealCandidate, disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { NOW, PROFILE, approvedSetup, binding, snapshotOf, webApiRow } from "../support/e2e-application-plan-fixtures.js";
import { registryFor } from "../support/e2e-account-registry-fixtures.js";
import { planOwnerWebAndApi } from "../support/e2e-web-and-api-plan.js";

// The web-and-api journey (tests/e2e/m1-3-journeys.test.ts) needs Docker; its plan does not. This runs everything the journey does before a container starts: the orders-web fixture's
// repository as the project's setup approval reads it, the planning context the planner is shown, the plan the journey writes, its approval, and the admission dispatch builds,
// validated by the worker's own validator. A scenario the descriptor of its kind cannot run, or a target the contract does not give, fails here and not on the CI runner.
afterEach(disposeRealCandidates);

const FIXTURE = join(import.meta.dirname, "../fixtures/orders-web-m13");
const PLANNING_FILES = ["package.json"];
const filesUnder = (directory: string): string[] => readdirSync(directory).flatMap((name) => {
  const path = join(directory, name);
  return statSync(path).isDirectory() ? filesUnder(path) : [relative(FIXTURE, path)];
});

describe("the orders-web fixture planned as a web scenario and an API scenario on one app (Task 3.4)", () => {
  it("is planned from what the setup approval read, approved with a row of each kind, and admitted as one version 2 admission with a group per kind", async () => {
    const snapshot = snapshotOf(Object.fromEntries(PLANNING_FILES.map((path) => [path, readFileSync(join(FIXTURE, path), "utf8")])));
    const setup = approvedSetup(snapshot, [{ kind: "web", profileId: PROFILE }, { kind: "api", profileId: PROFILE }]);
    const registry = registryFor(snapshot, NOW);
    const ready = (kind: "web" | "api") => ({ kind, profileId: PROFILE, supportedSteps: webApiRuntimeCapabilities(kind, "a".repeat(64)).supportedSteps, supportedAssertions: webApiRuntimeCapabilities(kind, "a".repeat(64)).supportedAssertions });
    const context = buildFeatureE2EPlanningContext(setup.policy, snapshot, { origin: "approved-setup", preparedCommitSha: null, readyRuntimes: [ready("web"), ready("api")], accountRegistry: registry });
    if (context.status !== "available") throw new Error(context.reason);
    const planned = planOwnerWebAndApi(context);
    expect(planned.web.applicationId).toBe(planned.api.applicationId);
    expect(planned.intent.applicationRuntimeRefs.map((ref) => ref.targetId).sort()).toEqual([planned.web.targetId, planned.api.targetId].sort());

    const policy = { ...setup.policy, baselineScenarioIds: planned.scenarios.map((scenario) => scenario.scenarioId) };
    const rows = [webApiRow("web"), webApiRow("api")];
    const artifact = { id: "feature-plan", sha256: "1".repeat(64) };
    const taskId = "11111111-1111-4111-8111-111111111111";
    const approved = evaluateApplicationPlanApproval({ intent: planned.intent, taskId, artifact, snapshot, setupProposal: setup.proposal, setupApproval: setup.setupApproval, policy,
      registeredRuntimes: rows, runtimeCatalogId: "catalog", runtimeBinding: binding, now: Date.now(), accounts: { entries: registry, mode: "approve", pinned: [] } });
    if (!approved.ok) throw new Error(approved.reason);
    expect(approved.selection.runtimeRows.map((row) => row.kind).sort()).toEqual(["api", "web"]);

    // The candidate: the whole fixture app, as the coder's run would leave it.
    const candidate = await createRealCandidate(Object.fromEntries(filesUnder(FIXTURE).map((path) => [path, readFileSync(join(FIXTURE, path), "utf8")])));
    const built = buildApplicationExecutionAdmission({ taskId, operationId: randomUUID(), operationFence: 3, workflowRevision: 7, roundId: randomUUID(), runId: randomUUID, intent: planned.intent, artifact,
      snapshot: candidate.snapshot, setupProposal: setup.proposal, setupApproval: setup.setupApproval, policy, registeredRuntimes: rows, runtimeCatalogId: "catalog", runtimeBinding: binding,
      buildSource: candidate.buildSource, planDigest: "c".repeat(64), now: Date.now(), accountEntries: registry, recordedSelection: approved.selection });
    const admission = decodeE2EApplicationExecutionAdmission(built.bytes);
    expect(admission.schemaVersion).toBe(E2E_APPLICATION_ADMISSION_SCHEMA_V2);
    expect(admission.runtimeBindings.map((item) => item.key)).toEqual([e2eRuntimeBindingKey(PROFILE, "api"), e2eRuntimeBindingKey(PROFILE, "web")]);
    expect(admission.applicationBindings).toHaveLength(1);
    const validated = validateE2EApplicationExecutionAdmission(admission);
    expect(validated.applicationSuites).toHaveLength(2);
    const byKind = Object.fromEntries(validated.applicationSuites.map((suite) => [suite.runtimeKind, suite]));
    expect(e2eCompiledRuntime(byKind.api!)?.capabilities.kind).toBe("api");
    expect(e2eCompiledRuntime(byKind.web!)?.capabilities.kind).toBe("web");
    // Each group runs its own scenario: the API request in the API group, the table in the web group, and the targets of each group are of its kind.
    expect(byKind.api!.expectedCases.map((expected) => expected.scenarioId)).toEqual(["owner-refused-other-tenant-api"]);
    expect(byKind.web!.expectedCases.map((expected) => expected.scenarioId)).toEqual(["owner-sees-own-orders"]);
    expect(byKind.api!.expectedCases[0]!.targetId).toBe(planned.api.targetId);
    expect(byKind.web!.expectedCases[0]!.targetId).toBe(planned.web.targetId);
    // Both groups run as the owner's one account.
    expect(new Set(validated.applicationSuites.flatMap((suite) => suite.expectedCases.map((expected) => expected.accountProfileId)))).toEqual(new Set(["orders-owner"]));
  });

  // PLANCTX (Ruling DE): the source-backed mock of the inventory service is listed once, with every target that may use it, so the fixture as the live demo has it (its inventory contract and
  // mock in the repository, ten targets: a web and an API target for each of three accounts, the base and the signed-out visitor) fits the planner's 12,000-byte bound. It was listed once per
  // target and came to about 16,800 bytes, so planning was unavailable for the demo.
  it("plans the whole fixture, with the inventory mock listed once for all ten targets and the context inside its bound", () => {
    const files = ["package.json", "inventory/openapi.json", "e2e/mocks/inventory-v1.json"];
    const snapshot = snapshotOf(Object.fromEntries(files.map((path) => [path, readFileSync(join(FIXTURE, path), "utf8")])));
    const setup = approvedSetup(snapshot, [{ kind: "web", profileId: PROFILE }, { kind: "api", profileId: PROFILE }]);
    const ready = (kind: "web" | "api") => ({ kind, profileId: PROFILE, supportedSteps: webApiRuntimeCapabilities(kind, "a".repeat(64)).supportedSteps, supportedAssertions: webApiRuntimeCapabilities(kind, "a".repeat(64)).supportedAssertions });
    const context = buildFeatureE2EPlanningContext(setup.policy, snapshot, { origin: "approved-setup", preparedCommitSha: null, readyRuntimes: [ready("web"), ready("api")], accountRegistry: registryFor(snapshot, NOW) });
    if (context.status !== "available") throw new Error(context.reason);
    expect(Buffer.byteLength(canonicalJson(context), "utf8")).toBeLessThanOrEqual(12_000);
    expect(context.targets).toHaveLength(10);
    // The mock once, and every target still learns it may use it.
    expect(context.mockFixtures).toHaveLength(1);
    expect(context.mockFixtures[0]).toMatchObject({ contractPath: "inventory/openapi.json", sourcePath: "e2e/mocks/inventory-v1.json" });
    expect([...context.mockFixtures[0]!.requestedTargetIds].sort()).toEqual(context.targets.map((target) => target.targetId).sort());
    expect(canonicalJson(context).split(context.mockFixtures[0]!.sourceSha256)).toHaveLength(2);
    // The plan of the journey is still made from this context.
    expect(planOwnerWebAndApi(context).intent.requestedTargetIds).toHaveLength(2);
  });
});
