import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { type E2EScenario, E2EApplicationPlanIntentSchema, E2E_APPLICATION_ADMISSION_SCHEMA_V1, E2E_APPLICATION_ADMISSION_SCHEMA_V2, E2E_HARD_LIMITS, WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX, WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX, WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX, canonicalJson,
  deriveE2EApplicationRuntimeAccountRef, deriveE2ESyntheticRuntimeAccountRef, e2eAnonymousRuntimeAccountRef, e2eApplicationAccountDefinitionDigest, e2eRuntimeBindingKey, E2ESetupProposalSchema, createCandidateManifest, inspectE2ERepository, proposeE2ESetup, verifyE2ESetupProposal } from "@agentx/contracts";
import { registryFor } from "../support/e2e-account-registry-fixtures.js";
import { E2E_EXECUTOR_HOST_ENTRY_POINT_ID, E2E_EXECUTOR_HOST_PROFILE_ID, STALE_RUN_SWEEP_AGE_MS, decodeE2EApplicationExecutionAdmission, e2eCompiledRuntime, validateE2EApplicationExecutionAdmission } from "@agentx/verifier";
import { candidateBuildSourceAdmissionReference } from "../../packages/broker/src/aws/candidate-build-source.js";
import { buildApplicationExecutionAdmission, type ApplicationAdmissionInput } from "../../packages/broker/src/e2e/application-admission.js";
import { ApplicationDispatchRefusal } from "../../packages/broker/src/e2e/application-dispatch-check.js";
import { applicationIntentDigest, applicationIntentWithAccountRefs, applicationRoundIntent, evaluateApplicationPlanApproval } from "../../packages/broker/src/e2e/application-plan-approval.js";
import { createRealCandidate, disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { builtWebAndApiAdmission } from "../support/e2e-web-and-api-admission.js";
import { PROFILE, anonymousScenario, anonymousTargetOf, binding, csvScenario, inferredSnapshot, ordersContractManifest, planFixture, shaCanonical, webAndApiFixture, webApiRow } from "../support/e2e-application-plan-fixtures.js";
import { createWorkflowE2EAdmissionAgentStepsReader } from "../../packages/broker/src/aws/workflow-e2e-admission-schema.js";

afterEach(disposeRealCandidates);
const candidateOf = createRealCandidate;

const ordersTree = { "package.json": ordersContractManifest, "src/orders.js": "export const orders = [];\n" };

/** The selection the Owner approved: derived against the approved setup snapshot, as plan APPROVE records it. */
function approvedSelection(fx: ReturnType<typeof planFixture>, rows = [webApiRow("web")], snapshot = fx.snapshot, intent = fx.intent, registry = fx.registry) {
  const result = evaluateApplicationPlanApproval({ intent, taskId: "11111111-1111-4111-8111-111111111111", artifact: { id: "feature-plan", sha256: "1".repeat(64) }, snapshot,
    setupProposal: fx.setup.proposal, setupApproval: fx.setup.setupApproval, policy: fx.policy, registeredRuntimes: rows, runtimeCatalogId: "catalog", runtimeBinding: binding, now: Date.now(),
    accounts: { entries: registry, mode: "approve", pinned: [] } });
  if (!result.ok) throw new Error(result.reason);
  return result.selection;
}

function webAndApiSelection(fixture: ReturnType<typeof webAndApiFixture>) {
  const result = evaluateApplicationPlanApproval({ intent: fixture.build({ web: false, api: true }), taskId: "11111111-1111-4111-8111-111111111111", artifact: { id: "feature-plan", sha256: "1".repeat(64) },
    snapshot: fixture.snapshot, setupProposal: fixture.setup.proposal, setupApproval: fixture.setup.setupApproval, policy: fixture.policy,
    registeredRuntimes: [webApiRow("api")], runtimeCatalogId: "catalog", runtimeBinding: binding, now: Date.now(),
    accounts: { entries: fixture.registry, mode: "approve", pinned: [] } });
  if (!result.ok) throw new Error(result.reason);
  return result.selection;
}

async function inputs(overrides: Partial<ApplicationAdmissionInput> = {}, tree: Record<string, string> = ordersTree) {
  const fx = planFixture({});
  const candidate = await candidateOf(tree);
  const base: ApplicationAdmissionInput = { taskId: "11111111-1111-4111-8111-111111111111", operationId: randomUUID(), operationFence: 3, workflowRevision: 7, roundId: randomUUID(),
    runId: randomUUID, intent: fx.intent, artifact: { id: "feature-plan", sha256: "1".repeat(64) }, snapshot: candidate.snapshot, setupProposal: fx.setup.proposal,
    setupApproval: fx.setup.setupApproval, policy: fx.policy, registeredRuntimes: [webApiRow("web")], runtimeCatalogId: "catalog", runtimeBinding: binding,
    buildSource: candidate.buildSource, planDigest: "c".repeat(64), now: Date.now(), accountEntries: fx.registry, recordedSelection: approvedSelection(fx) };
  return { fx, candidate, input: { ...base, ...overrides } };
}
const refusalOf = (build: () => unknown): string => {
  try { build(); } catch (error) {
    expect(error).toBeInstanceOf(ApplicationDispatchRefusal);
    return (error as Error).message;
  }
  throw new Error("expected the builder to refuse");
};

describe("the application admission built for a single-kind round", () => {
  it("decodes and validates in the worker's own decoder for a web-only approved plan, with the export's commit and tree", async () => {
    const { input, candidate } = await inputs();
    const built = buildApplicationExecutionAdmission(input);
    // Exactly what the worker does with the stored bytes.
    const decoded = decodeE2EApplicationExecutionAdmission(built.bytes);
    const validated = validateE2EApplicationExecutionAdmission(decoded);
    expect(decoded.candidateCommitSha).toBe(candidate.identity.commitSha);
    expect(decoded.candidateTreeSha).toBe(candidate.identity.treeSha);
    expect(decoded.sourceSnapshot).toMatchObject({ commitSha: candidate.identity.commitSha, treeSha: candidate.identity.treeSha });
    expect(decoded.selectionInput.sourceSnapshot).toMatchObject({ commitSha: candidate.identity.commitSha, treeSha: candidate.identity.treeSha });
    expect(decoded.candidateDigest).toBe(candidate.source.candidate.digest);
    expect(built.sha256).toBe(createHash("sha256").update(built.bytes).digest("hex"));
    expect(Buffer.from(canonicalJson(decoded), "utf8").equals(built.bytes)).toBe(true);
    expect(validated.applicationSuites).toHaveLength(1);
    expect(validated.executionPlan.groups).toHaveLength(1);
    expect(decoded.portableProjection).toBeNull();
    expect(decoded.groups.every((group) => group.protocol === "trusted-e2e-application/v1")).toBe(true);
    // One server-owned identity for the whole round: the operation, its fence and revision, the task and the candidate.
    expect(decoded).toMatchObject({ taskId: input.taskId, operationId: input.operationId, operationFence: 3, workflowRevision: 7 });
    expect(decoded.round).toMatchObject({ roundId: input.roundId, taskId: input.taskId, operationId: input.operationId, operationFence: 3, workflowRevision: 7 });
    expect(decoded.round.groupBindings.every((item) => item.candidateDigest === candidate.source.candidate.digest && item.planDigest === input.planDigest)).toBe(true);
  });

  it("admits the signed-out scenarios of an app with no project contract (Ruling AZ): the worker's decoder reads them back, bound to the fixed anonymous reference, with the lockfile in the build identity", async () => {
    const target = anonymousTargetOf(inferredSnapshot);
    const fx = planFixture({ snapshot: inferredSnapshot, targetId: target, scenario: anonymousScenario(target) });
    // The candidate holds the very manifest and lockfile the setup was approved on, and the app itself.
    const candidate = await candidateOf({ "package.json": inferredSnapshot.sources[0]!.bytes.toString(), "package-lock.json": "{}", "server.js": "// the app\n" });
    const recorded = approvedSelection(fx, [webApiRow("web")], fx.snapshot, fx.intent, []);
    const input: ApplicationAdmissionInput = { taskId: "11111111-1111-4111-8111-111111111111", operationId: randomUUID(), operationFence: 3, workflowRevision: 7, roundId: randomUUID(),
      runId: randomUUID, intent: fx.intent, artifact: { id: "feature-plan", sha256: "1".repeat(64) }, snapshot: candidate.snapshot, setupProposal: fx.setup.proposal,
      setupApproval: fx.setup.setupApproval, policy: fx.policy, registeredRuntimes: [webApiRow("web")], runtimeCatalogId: "catalog", runtimeBinding: binding,
      buildSource: candidate.buildSource, planDigest: "c".repeat(64), now: Date.now(), accountEntries: [], recordedSelection: recorded };
    const built = buildApplicationExecutionAdmission(input);
    const decoded = decodeE2EApplicationExecutionAdmission(built.bytes);
    const validated = validateE2EApplicationExecutionAdmission(decoded);
    expect(validated.applicationSuites).toHaveLength(1);
    const application = fx.application.applicationId;
    expect(recorded.accountRefs).toEqual([e2eAnonymousRuntimeAccountRef(application)]);
    expect(validated.applicationSuites[0]!.expectedCases.map((item) => item.accountProfileId)).toEqual(["rovara-anonymous"]);
    expect(validated.applicationSuites[0]!.expectedCases[0]!.targetId).toBe(target);
    expect(decoded.selectionInput.runtimeAccountRefs).toEqual([e2eAnonymousRuntimeAccountRef(application)]);
    // The inferred recipe carries `npm ci`, and the build identity names the lockfile it installs from.
    const { approval, build } = decoded.applicationBindings[0]!.value;
    expect(approval.applications[0]!.recipe.build.map((command) => [command.program, ...command.args])).toEqual([["npm", "ci"]]);
    expect(build.lockfileRefs.map((ref) => ref.path)).toEqual(["package-lock.json"]);
    expect(built.kinds).toEqual(["web"]);
  });

  it("returns the per-group run ids and the admission digest that verification of the round needs", async () => {
    const { input } = await inputs();
    const built = buildApplicationExecutionAdmission(input);
    const decoded = decodeE2EApplicationExecutionAdmission(built.bytes);
    expect(built.roundId).toBe(input.roundId);
    expect(built.groupRunIds).toEqual(decoded.round.groupBindings.map((item) => item.runId));
    expect(built.groupRunIds).toEqual(decoded.groups.map((group) => group.outerBinding.runId));
    expect(built.groupRunIds.length).toBeGreaterThan(0);
    expect(new Set(built.groupRunIds).size).toBe(built.groupRunIds.length);
    expect(built.admissionDigest).toBe(decoded.admissionDigest);
    expect(built.kinds).toEqual(["web"]);
  });

  it("carries the exported build source reference and manifest, bound to the exported commit and tree", async () => {
    const { input, candidate } = await inputs();
    const decoded = decodeE2EApplicationExecutionAdmission(buildApplicationExecutionAdmission(input).bytes);
    expect(decoded.applicationBindings).toHaveLength(1);
    const { buildSource } = decoded.applicationBindings[0]!.value;
    expect(buildSource.reference).toEqual(candidateBuildSourceAdmissionReference(candidate.stored));
    expect(buildSource.reference.artifactId).toBe(`unstored-archive-sha256-${candidate.manifest.archive.sha256}`);
    expect(buildSource.manifest).toEqual(candidate.manifest);
    expect(buildSource.manifest.repository).toMatchObject({ commitSha: candidate.identity.commitSha, treeSha: candidate.identity.treeSha });
    const build = decoded.applicationBindings[0]!.value.build;
    expect(build.repository).toMatchObject({ commitSha: candidate.identity.commitSha, treeSha: candidate.identity.treeSha });
    expect(build.candidateDigest).toBe(candidate.source.candidate.digest);
  });

  it("keeps every deadline below the stale-run sweep and inside the policy and hard run limit", async () => {
    const { input, fx } = await inputs();
    const decoded = decodeE2EApplicationExecutionAdmission(buildApplicationExecutionAdmission(input).bytes);
    const admitted = Date.parse(decoded.round.admittedAt);
    const deadline = Date.parse(decoded.round.deadlineAt);
    expect(admitted).toBe(input.now);
    expect(deadline - admitted).toBeLessThanOrEqual(Math.min(fx.policy.limits.runTimeoutMs, E2E_HARD_LIMITS.runTimeoutMs));
    expect(deadline - admitted).toBeLessThan(STALE_RUN_SWEEP_AGE_MS);
    for (const group of decoded.round.groupBindings) {
      expect(group.deadlineAt).toBe(decoded.round.deadlineAt);
      expect(Date.parse(group.deadlineAt) - Date.parse(group.admittedAt)).toBeLessThan(STALE_RUN_SWEEP_AGE_MS);
    }
  });

  it("clamps a policy whose run timeout is longer than the hard limit's sweep margin to the hard limit", async () => {
    const fx = planFixture({});
    const longPolicy = { ...fx.policy, limits: { ...fx.policy.limits, runTimeoutMs: E2E_HARD_LIMITS.runTimeoutMs } };
    const { input } = await inputs({ policy: longPolicy });
    const decoded = decodeE2EApplicationExecutionAdmission(buildApplicationExecutionAdmission(input).bytes);
    const span = Date.parse(decoded.round.deadlineAt) - Date.parse(decoded.round.admittedAt);
    expect(span).toBe(E2E_HARD_LIMITS.runTimeoutMs);
    expect(span + 15_000).toBeLessThan(STALE_RUN_SWEEP_AGE_MS);
  });

  it("uses the executor's one registered CLI host for the qualified profile, and a launch target the validator accepts", async () => {
    const { input } = await inputs();
    const decoded = decodeE2EApplicationExecutionAdmission(buildApplicationExecutionAdmission(input).bytes);
    expect(decoded.cliHosts).toHaveLength(1);
    expect(decoded.cliHosts[0]).toMatchObject({ profileId: E2E_EXECUTOR_HOST_PROFILE_ID, descriptor: { entryPointId: E2E_EXECUTOR_HOST_ENTRY_POINT_ID } });
    expect(decoded.launchTargets).toHaveLength(1);
    expect(decoded.launchTargets[0]).toMatchObject({ targetId: "web-1", profileId: E2E_EXECUTOR_HOST_PROFILE_ID, app: { url: "http://127.0.0.1:4317", environment: "test" } });
    expect(decoded.modelRoute).toBeNull();
  });

  it("carries the route the project's policy pinned (Task 4.2), identical in the run binding, and the worker's own validator accepts it", async () => {
    const fx = planFixture({});
    const { input } = await inputs({ policy: { ...fx.policy, modelRouteRevision: "r1-0123456789ab" } });
    const built = buildApplicationExecutionAdmission(input);
    const decoded = decodeE2EApplicationExecutionAdmission(built.bytes);
    expect(decoded.modelRoute).toEqual({ routeId: "rovara-e2e-default", routeRevision: "r1-0123456789ab" });
    expect(decoded.groups.every((group) => group.outerBinding.modelRouteRevision === "r1-0123456789ab")).toBe(true);
    expect(() => validateE2EApplicationExecutionAdmission(decoded)).not.toThrow();
  });

  it("passes the verifier only the READY rows of the kinds in use, so a web-only plan carries no api row of its profile", async () => {
    const { input } = await inputs({ registeredRuntimes: [webApiRow("web"), webApiRow("api")] });
    const decoded = decodeE2EApplicationExecutionAdmission(buildApplicationExecutionAdmission(input).bytes);
    expect(decoded.selectionInput.registeredRuntimes).toHaveLength(1);
    expect(decoded.selectionInput.registeredRuntimes[0]).toMatchObject({ profileId: E2E_EXECUTOR_HOST_PROFILE_ID, capabilities: { kind: "web" } });
    expect(decoded.runtimeBindings.map((item) => item.value.capabilities.kind)).toEqual(["web"]);
    expect(() => validateE2EApplicationExecutionAdmission(decoded)).not.toThrow();
  });

  it("builds an api round from the api row alone", async () => {
    const fixture = webAndApiFixture();
    const candidate = await candidateOf({ "package.json": ordersContractManifest, "api/package.json": Buffer.from(fixture.snapshot.sources.find((item) => item.path === "api/package.json")!.bytes).toString("utf8") });
    const input: ApplicationAdmissionInput = { taskId: "11111111-1111-4111-8111-111111111111", operationId: randomUUID(), operationFence: 2, workflowRevision: 4, roundId: randomUUID(),
      runId: randomUUID, intent: fixture.build({ web: false, api: true }), artifact: { id: "feature-plan", sha256: "1".repeat(64) }, snapshot: candidate.snapshot,
      setupProposal: fixture.setup.proposal, setupApproval: fixture.setup.setupApproval, policy: fixture.policy, registeredRuntimes: [webApiRow("web"), webApiRow("api")],
      runtimeCatalogId: "catalog", runtimeBinding: binding, buildSource: candidate.buildSource, planDigest: "d".repeat(64), now: Date.now(), accountEntries: fixture.registry, recordedSelection: webAndApiSelection(fixture) };
    const built = buildApplicationExecutionAdmission(input);
    expect(built.kinds).toEqual(["api"]);
    const decoded = decodeE2EApplicationExecutionAdmission(built.bytes);
    expect(decoded.launchTargets[0]).toMatchObject({ targetId: fixture.api.targetId, app: null });
    expect(decoded.selectionInput.registeredRuntimes.map((item) => item.capabilities.kind)).toEqual(["api"]);
    expect(() => validateE2EApplicationExecutionAdmission(decoded)).not.toThrow();
  });

  it("is the same bytes for the same inputs", async () => {
    const { input } = await inputs();
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    let next = 0;
    const once = () => buildApplicationExecutionAdmission({ ...input, runId: () => ids[next++ % ids.length]! });
    next = 0;
    const first = once();
    next = 0;
    expect(once().sha256).toBe(first.sha256);
  });
});

describe("the builder refuses with a specific reason, never a portable fallback", () => {
  it("refuses a manifest exported for another tree", async () => {
    const { input } = await inputs();
    const other = await candidateOf({ ...ordersTree, "src/extra.js": "export const extra = 1;\n" });
    expect(refusalOf(() => buildApplicationExecutionAdmission({ ...input, buildSource: other.buildSource }))).toMatch(/build source.*(another|different).*(commit|tree|candidate)/i);
  });

  it("refuses a manifest that names another candidate even when its commit and tree match", async () => {
    const { input, candidate } = await inputs();
    const manifest = { ...candidate.manifest, candidateDigest: "9".repeat(64) };
    expect(refusalOf(() => buildApplicationExecutionAdmission({ ...input, buildSource: { manifest, reference: input.buildSource.reference } }))).toMatch(/build source.*(another|different).*(commit|tree|candidate)/i);
  });

  it("refuses a reference that is not the manifest's own archive identity", async () => {
    const { input } = await inputs();
    expect(refusalOf(() => buildApplicationExecutionAdmission({ ...input, buildSource: { manifest: input.buildSource.manifest,
      reference: { ...input.buildSource.reference, manifestDigest: "8".repeat(64) } } }))).toMatch(/build source/i);
  });

  it("refuses a candidate whose application metadata changed since the setup was approved, saying the plan must be made again", async () => {
    const changed = JSON.stringify({ ...(JSON.parse(ordersContractManifest) as Record<string, unknown>), description: "changed after setup approval" });
    const { input } = await inputs({}, { ...ordersTree, "package.json": changed });
    expect(refusalOf(() => buildApplicationExecutionAdmission(input))).toMatch(/changed since setup approval|replan|metadata|source/i);
  });

  it("refuses a candidate that added a lockfile the approved setup did not have, since lockfiles are authority-bearing source", async () => {
    const { input } = await inputs({}, { ...ordersTree, "package-lock.json": "{}\n" });
    expect(refusalOf(() => buildApplicationExecutionAdmission(input))).toMatch(/changed since setup approval/);
  });

  it("refuses when the READY row of the plan's kind is missing, even if the other kind's row is there", async () => {
    const { input } = await inputs({ registeredRuntimes: [webApiRow("api")] });
    expect(refusalOf(() => buildApplicationExecutionAdmission(input))).toMatch(/web runtime.*READY/i);
  });

  it("refuses a runtime row that would expire before the round could end", async () => {
    const soon = webApiRow("web", { expiresAt: new Date(Date.now() + 30_000).toISOString() });
    const { input } = await inputs({ registeredRuntimes: [soon], recordedSelection: approvedSelection(planFixture({}), [soon]) });
    expect(refusalOf(() => buildApplicationExecutionAdmission(input))).toMatch(/web runtime of profile linux-arm64-web-api-v1 expires at .* before this round could end/);
    // A row that outlives the round's deadline is fine.
    const later = webApiRow("web", { expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(() => buildApplicationExecutionAdmission({ ...input, registeredRuntimes: [later], recordedSelection: approvedSelection(planFixture({}), [later]) })).not.toThrow();
  });

  describe("compares the selection it derived for the candidate with the one the Owner approved (Fix round 1, M5)", () => {
    it("builds when they agree", async () => {
      const { input } = await inputs();
      expect(() => buildApplicationExecutionAdmission(input)).not.toThrow();
    });

    const edits: Array<[string, (record: ReturnType<typeof approvedSelection>) => ReturnType<typeof approvedSelection>, RegExp]> = [
      ["other executable targets", (record) => ({ ...record, executableTargetIds: ["web-1", "web-9"] }), /executable targets/],
      ["another runtime row", (record) => ({ ...record, runtimeRows: record.runtimeRows.map((row) => ({ ...row, generation: row.generation + 1 })) }), /runtime row/],
      ["another intent", (record) => ({ ...record, intentDigest: "9".repeat(64) }), /intent/],
    ];
    for (const [name, edit, reason] of edits) {
      it(`blocks on ${name}`, async () => {
        const { input } = await inputs();
        const message = refusalOf(() => buildApplicationExecutionAdmission({ ...input, recordedSelection: edit(input.recordedSelection) }));
        expect(message).toMatch(/differs from the one that was approved/);
        expect(message).toMatch(reason);
      });
    }
  });

  describe("runs with the account refs the Owner approved, and refuses when the registry no longer holds exactly them (Task 3.1)", () => {
    it("pins the approved ref into the admitted intent and the selection input", async () => {
      const { input, fx } = await inputs();
      const built = buildApplicationExecutionAdmission(input);
      const decoded = decodeE2EApplicationExecutionAdmission(built.bytes);
      expect(input.recordedSelection.accountRefs).toEqual([fx.accountRef]);
      expect(decoded.selectionInput.runtimeAccountRefs).toEqual([fx.accountRef]);
      expect(decoded.intent.runtimeAccountRefs).toEqual([fx.accountRef]);
    });

    it("refuses with the accounts-changed text when the account has a newer revision, whatever the plan still carries", async () => {
      const { input, fx } = await inputs();
      const bumped = fx.registry.map((entry) => {
        const definition = { ...entry.definition, revision: 2 };
        return { definition, latest: { revision: 2, definitionDigest: e2eApplicationAccountDefinitionDigest(definition) } };
      });
      const message = refusalOf(() => buildApplicationExecutionAdmission({ ...input, accountEntries: bumped }));
      expect(message).toContain(WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX);
      expect(message).toContain("accounts-changed-reapprove");
      expect(message).not.toMatch(/send the task back/i);
    });

    it("refuses when the registry holds nothing for an account that was approved from it", async () => {
      const { input } = await inputs();
      expect(refusalOf(() => buildApplicationExecutionAdmission({ ...input, accountEntries: [] }))).toContain(WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX);
    });

    it("refuses a registered definition that has expired by the time of dispatch", async () => {
      const { input } = await inputs();
      const message = refusalOf(() => buildApplicationExecutionAdmission({ ...input, now: Date.now() + 91 * 86_400_000 }));
      expect(message).toContain(WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX);
      expect(message).toMatch(/expired/);
    });

    it("refuses a definition whose tenant digest is not the contract's, although it is the latest and the one the Owner approved (registry tampering at dispatch)", async () => {
      const fx = planFixture({});
      const tampered = fx.registry.map((entry) => {
        const definition = { ...entry.definition, tenantIdDigest: "f".repeat(64) };
        return { definition, latest: { revision: definition.revision, definitionDigest: e2eApplicationAccountDefinitionDigest(definition) } };
      });
      const ref = deriveE2EApplicationRuntimeAccountRef(tampered[0]!.definition);
      const { input } = await inputs({ accountEntries: tampered, recordedSelection: { ...approvedSelection(fx), accountRefs: [ref] } });
      const message = refusalOf(() => buildApplicationExecutionAdmission(input));
      expect(message).toContain(WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX);
      expect(message).toContain("accounts-changed-reapprove");
    });

    it("refuses an account that expires before the round could end, as it does a runtime row, and builds once it outlives the round", async () => {
      const soon = Date.now() - 90 * 86_400_000 + 30_000;
      const short = registryFor(planFixture({}).snapshot, soon);
      const ref = deriveE2EApplicationRuntimeAccountRef(short[0]!.definition);
      const fx = planFixture({ accountRef: { definitionDigest: ref.definitionDigest } });
      const { input } = await inputs({ intent: fx.intent, accountEntries: short, recordedSelection: approvedSelection(fx, [webApiRow("web")], fx.snapshot, fx.intent, short) });
      const message = refusalOf(() => buildApplicationExecutionAdmission(input));
      expect(message).toContain(WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX);
      expect(message).toMatch(/expires at .* before this round could end at .*register the project's setup again to renew it/);
      const later = registryFor(planFixture({}).snapshot, Date.now() - 86_400_000);
      const fxLater = planFixture({ accountRef: { definitionDigest: deriveE2EApplicationRuntimeAccountRef(later[0]!.definition).definitionDigest } });
      const { input: ok } = await inputs({ intent: fxLater.intent, accountEntries: later, recordedSelection: approvedSelection(fxLater, [webApiRow("web")], fxLater.snapshot, fxLater.intent, later) });
      expect(() => buildApplicationExecutionAdmission(ok)).not.toThrow();
    });

    it("reads an M1.2 record as it is: the recipe-derived ref in the plan, nothing pinned, nothing registered", async () => {
      const fx = planFixture({ accountRef: deriveE2ESyntheticRuntimeAccountRef({ applicationId: planFixture({}).application.applicationId, accountProfileId: "synthetic",
        recipeDigest: planFixture({}).application.recipe!.recipeDigest }) });
      const { input } = await inputs({ intent: fx.intent, accountEntries: [], recordedSelection: { ...approvedSelection(planFixture({})), accountRefs: [], intentDigest: applicationIntentDigest(fx.intent) } });
      const built = buildApplicationExecutionAdmission(input);
      expect(decodeE2EApplicationExecutionAdmission(built.bytes).selectionInput.runtimeAccountRefs).toEqual([fx.accountRef]);
    });
  });

  it("states the right remedy for each refusal: the runtime's state asks for an administrator and retry, the candidate's problems for sending it back", async () => {
    const soon = webApiRow("web", { expiresAt: new Date(Date.now() + 30_000).toISOString() });
    const { input: expiringInput } = await inputs({ registeredRuntimes: [soon], recordedSelection: approvedSelection(planFixture({}), [soon]) });
    const expiring = refusalOf(() => buildApplicationExecutionAdmission(expiringInput));
    expect(expiring).toContain(WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX);
    expect(expiring).not.toMatch(/send the task back/i);
    const { input } = await inputs({ registeredRuntimes: [webApiRow("api")] });
    const noRow = refusalOf(() => buildApplicationExecutionAdmission(input));
    expect(noRow).toContain(WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX);
    expect(noRow).not.toMatch(/send the task back/i);
    const other = await candidateOf({ ...ordersTree, "src/extra.js": "export const extra = 1;\n" });
    const candidateProblem = refusalOf(() => buildApplicationExecutionAdmission({ ...input, registeredRuntimes: [webApiRow("web")], buildSource: other.buildSource }));
    expect(candidateProblem).toContain(WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX);
    expect(candidateProblem).toMatch(/Send the task back to coding/);
  });

  it("refuses a runtime profile with no installed CLI host", async () => {
    const { input } = await inputs();
    const foreign = planFixture({});
    const policy = { ...foreign.policy, targets: foreign.policy.targets.map((target) => ({ ...target, runtimeProfileId: "linux-arm64-web-api-v2" })) };
    expect(refusalOf(() => buildApplicationExecutionAdmission({ ...input, policy }))).toMatch(/runtime profile|qualified|cannot run application/i);
  });

  it("refuses an intent with no executable target", async () => {
    const fx = planFixture({ executable: false, setupReady: [] });
    const { input } = await inputs({ intent: fx.intent, setupProposal: fx.setup.proposal, setupApproval: fx.setup.setupApproval, policy: fx.policy, registeredRuntimes: [] });
    expect(refusalOf(() => buildApplicationExecutionAdmission(input))).toMatch(/no executable|nothing to run|executable/i);
  });

  it("hashes what it signed: the admission digest is the canonical content's", async () => {
    const { input } = await inputs();
    const built = buildApplicationExecutionAdmission(input);
    const { admissionDigest, ...body } = built.admission;
    expect(admissionDigest).toBe(shaCanonical(body));
  });
});

// Ruling CY (review F1): a setup proposal stored before the signed-out variants existed (`tests/fixtures/setup-proposals-before-task-3-3.json`, written by the code at ccee79e1 over
// the fixture apps) keeps verifying and keeps dispatching. The variants are derived from the base targets whenever targets are read; none is stored.
describe("setup proposals stored before Task 3.3", () => {
  type Stored = { files: string[]; proposal: unknown; setupApproval: { artifactId: string; digest: string } };
  const stored = JSON.parse(readFileSync(new URL("../fixtures/setup-proposals-before-task-3-3.json", import.meta.url), "utf8")) as Record<"inferred-web-app" | "orders-contract-app", Stored>;
  const rootOf = { "inferred-web-app": "../fixtures/e2e-inferred-web-app/", "orders-contract-app": "../fixtures/e2e-web-api-app/" } as const;
  const snapshotFor = (name: keyof typeof stored) => {
    const candidate = createCandidateManifest([{ repositoryId: "example/demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
    const sources = stored[name].files.map((path) => { const bytes = readFileSync(new URL(`${rootOf[name]}${path}`, import.meta.url)); return { path, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), kind: "blob" as const }; });
    return { candidate, commitSha: "a".repeat(40), treeSha: "b".repeat(40), treeComplete: true as const, treePaths: sources.map((item) => item.path).sort(), sources };
  };

  it.each(["inferred-web-app", "orders-contract-app"] as const)("verifies unchanged for the %s fixture, and the proposal made now is the stored one, byte for byte", (name) => {
    const snapshot = snapshotFor(name);
    const proposal = E2ESetupProposalSchema.parse(stored[name].proposal);
    expect(verifyE2ESetupProposal(proposal, snapshot, snapshot.candidate)).toEqual(proposal);
    expect(stored[name].setupApproval.digest).toBe(createHash("sha256").update(canonicalJson(proposal)).digest("hex"));
    // The proposal made now holds the base targets alone and the recipe it always had.
    const made = proposeE2ESetup({ inspection: inspectE2ERepository(snapshot, snapshot.candidate).inspection, snapshot, expectedCandidate: snapshot.candidate, readyProfiles: [{ kind: "web", profileId: PROFILE }] });
    expect(canonicalJson(made)).toBe(canonicalJson(proposal));
    expect(proposal.targets.map((target) => target.accountProfileId)).not.toContain("rovara-anonymous");
  });

  it("keeps an already-approved plan approvable and dispatchable on the stored proposal and the policy built from it", async () => {
    const proposal = E2ESetupProposalSchema.parse(stored["orders-contract-app"].proposal);
    const fx = planFixture({});
    const policy = { ...fx.policy, targets: proposal.targets };
    const setupApproval = stored["orders-contract-app"].setupApproval;
    const approved = evaluateApplicationPlanApproval({ intent: fx.intent, taskId: "11111111-1111-4111-8111-111111111111", artifact: { id: "feature-plan", sha256: "1".repeat(64) }, snapshot: fx.snapshot,
      setupProposal: proposal, setupApproval, policy, registeredRuntimes: [webApiRow("web")], runtimeCatalogId: "catalog", runtimeBinding: binding, now: Date.now(),
      accounts: { entries: fx.registry, mode: "approve", pinned: [] } });
    if (!approved.ok) throw new Error(approved.reason);
    const { input } = await inputs({ setupProposal: proposal, setupApproval, policy, recordedSelection: approved.selection });
    const decoded = decodeE2EApplicationExecutionAdmission(buildApplicationExecutionAdmission(input).bytes);
    expect(validateE2EApplicationExecutionAdmission(decoded).applicationSuites).toHaveLength(1);
    // The stored policy has no variant; the admission's carries the one derived from the base, on the base's runtime profile.
    expect(policy.targets.map((target) => target.accountProfileId)).not.toContain("rovara-anonymous");
    const admitted = decoded.selectionInput.policy.targets;
    expect(admitted.map((target) => target.targetId)).toEqual([...policy.targets.map((target) => target.targetId), "web-1-anonymous"]);
    expect(admitted.find((target) => target.targetId === "web-1-anonymous")).toMatchObject({ accountProfileId: "rovara-anonymous", runtimeProfileId: PROFILE });
  });
});

// Ruling CX (the M1.3 -> M1.4 merge): a baseline round never runs agent steps and carries no model route, even where the project's policy pins one; a candidate round keeps it.
describe("a baseline round's admission on a project whose policy pins a model route", () => {
  const ROUTE = "r1-0123456789ab";
  const agentScenario: E2EScenario = { ...csvScenario, scenarioId: "agent-orders", steps: [{ kind: "agent", goal: "open the orders page", maxActions: 3 }],
    assertions: [{ kind: "visible", testId: "orders", equals: true }] };
  const agentRow = () => webApiRow("web", {}, (value) => ({ ...value, supportedSteps: [...value.supportedSteps, "agent" as const] }));
  async function routed(options: { baseline: boolean; agent?: boolean }) {
    const fx = planFixture({ modelRouteRevision: ROUTE, ...(options.agent === true ? { extraScenarios: [agentScenario] } : {}) });
    const candidate = await candidateOf(ordersTree);
    const rows = [agentRow()];
    const input: ApplicationAdmissionInput = { taskId: "11111111-1111-4111-8111-111111111111", operationId: randomUUID(), operationFence: 3, workflowRevision: 7, roundId: randomUUID(),
      runId: randomUUID, intent: fx.intent, artifact: { id: "feature-plan", sha256: "1".repeat(64) }, snapshot: candidate.snapshot, setupProposal: fx.setup.proposal,
      setupApproval: fx.setup.setupApproval, policy: fx.policy, registeredRuntimes: rows, runtimeCatalogId: "catalog", runtimeBinding: binding,
      buildSource: candidate.buildSource, planDigest: "c".repeat(64), now: Date.now(), accountEntries: fx.registry, recordedSelection: approvedSelection(fx, rows),
      ...(options.baseline ? { baseline: { baseCommitSha: candidate.snapshot.commitSha, attempt: 1 } } : {}) };
    return () => buildApplicationExecutionAdmission(input);
  }
  const agentStepsOf = (built: ReturnType<typeof buildApplicationExecutionAdmission>) => createWorkflowE2EAdmissionAgentStepsReader({
    s3: { send: async () => ({ Body: { transformToString: async () => built.bytes.toString("utf8") } }) }, bucket: "b" })({ schemaVersion: 1, kind: "application",
    taskId: "11111111-1111-4111-8111-111111111111", workflowRevision: 7, candidateDigest: built.admission.candidateDigest, roundId: built.roundId, groupRunIds: built.groupRunIds,
    admissionRef: { key: `workflow-e2e-admissions/sha256/${built.sha256}.json`, sha256: built.sha256, byteLength: built.bytes.byteLength } });

  it("the candidate round carries the pinned route, and with an agent step its reference must say agentSteps (the positive controls)", async () => {
    const decoded = decodeE2EApplicationExecutionAdmission((await routed({ baseline: false }))().bytes);
    expect(decoded.modelRoute).toEqual({ routeId: "rovara-e2e-default", routeRevision: ROUTE });
    expect(decoded.round.groupBindings.every((item) => item.modelRouteRevision === ROUTE)).toBe(true);
    const withAgent = (await routed({ baseline: false, agent: true }))();
    expect(decodeE2EApplicationExecutionAdmission(withAgent.bytes).executionPlan.unavailableCriteria).toEqual([]);
    await expect(agentStepsOf(withAgent)).resolves.toBe(true);
  });

  it("the baseline round carries modelRoute null and group bindings with modelRouteRevision null, the worker's validator accepts it, and it has no agent step (agentSteps false)", async () => {
    const built = (await routed({ baseline: true }))();
    const decoded = decodeE2EApplicationExecutionAdmission(built.bytes);
    expect(decoded.baseline).toMatchObject({ purpose: "baseline" });
    expect(decoded.modelRoute).toBeNull();
    expect(decoded.policy.modelRouteRevision).toBeNull();
    expect(decoded.round.groupBindings.length).toBeGreaterThan(0);
    expect(decoded.round.groupBindings.every((item) => item.modelRouteRevision === null)).toBe(true);
    expect(() => validateE2EApplicationExecutionAdmission(decoded)).not.toThrow();
    await expect(agentStepsOf(built)).resolves.toBe(false);
  });

  it("a baseline of a plan with an agent step is refused with agent-route-not-approved: it never runs the agent step (the baseline is then unavailable, and never gates)", async () => {
    expect(refusalOf(await routed({ baseline: true, agent: true }))).toMatch(/scenario agent-orders on target web-1: agent-route-not-approved/);
  });
});

describe("an admission for a plan that runs web and API checks together (Task 3.4)", () => {
  const BOTH_ROWS = () => [webApiRow("web"), webApiRow("api")];
  const sha256Of = (value: string) => createHash("sha256").update(value).digest("hex");
  /** The approval of a plan on one app's web and API targets, and the admission dispatch builds for it from the candidate. */
  async function oneApp() {
    const { fx, intent, approved, candidate, input } = await builtWebAndApiAdmission();
    return { fx, intent, approved, candidate, input };
  }
  /** The same admission re-signed with an edit, as the broker's own writer would have written it (the digest is over everything else); the bytes are not checked by the schema on the way out. */
  function resigned(admission: ReturnType<typeof decodeE2EApplicationExecutionAdmission>, edit: (body: Record<string, unknown>) => void): Buffer {
    const { admissionDigest: _digest, ...body } = admission;
    void _digest;
    const edited = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    edit(edited);
    return Buffer.from(canonicalJson({ ...edited, admissionDigest: sha256Of(canonicalJson(edited)) }), "utf8");
  }
  /** What the previous code wrote for a plan of one kind: schema version 1, and each runtime row keyed by its profile alone. */
  const asWrittenByVersion1 = (admission: ReturnType<typeof decodeE2EApplicationExecutionAdmission>) => resigned(admission, (body) => {
    body.schemaVersion = E2E_APPLICATION_ADMISSION_SCHEMA_V1;
    body.runtimeBindings = admission.runtimeBindings.map((item) => ({ key: item.value.profileId, value: item.value }));
  });

  it("builds one admission for an app with a web and an API target: schema version 2, a runtime row per kind, and a group for each kind", async () => {
    const { input, intent, approved } = await oneApp();
    const built = buildApplicationExecutionAdmission(input);
    const decoded = decodeE2EApplicationExecutionAdmission(built.bytes);
    expect(decoded.schemaVersion).toBe(E2E_APPLICATION_ADMISSION_SCHEMA_V2);
    expect(built.kinds).toEqual(["api", "web"]);
    expect(decoded.runtimeBindings.map((item) => item.key)).toEqual([e2eRuntimeBindingKey(PROFILE, "api"), e2eRuntimeBindingKey(PROFILE, "web")]);
    expect(decoded.runtimeBindings.map((item) => item.value.capabilities.kind)).toEqual(["api", "web"]);
    expect(decoded.selectionInput.registeredRuntimes.map((item) => item.capabilities.kind).sort()).toEqual(["api", "web"]);
    // One application, built once for both kinds.
    expect(decoded.applicationBindings).toHaveLength(1);
    expect(decoded.applicationBindings[0]!.value.build.outputs.map((output) => output.platform).sort()).toEqual(["api", "web"]);
    // Two groups (a group never mixes kinds), each compiled against the row of its own kind, and the worker's own validator accepts the whole.
    const validated = validateE2EApplicationExecutionAdmission(decoded);
    expect(validated.applicationSuites).toHaveLength(2);
    expect(decoded.groups).toHaveLength(2);
    expect(built.groupRunIds).toHaveLength(2);
    expect(validated.applicationSuites.map((suite) => suite.runtimeKind).sort()).toEqual(["api", "web"]);
    for (const suite of validated.applicationSuites) {
      expect(e2eCompiledRuntime(suite)?.capabilities.kind, suite.group.groupId).toBe(suite.runtimeKind);
      const kindsOfTargets = new Set(suite.group.targetIds.map((targetId) => validated.executionPlan.effectiveTargets.find((target) => target.targetId === targetId)!.kind));
      expect([...kindsOfTargets]).toEqual([suite.runtimeKind]);
    }
    expect(decoded.launchTargets.map((target) => target.app === null)).toContain(true);
    expect(decoded.launchTargets.map((target) => target.app === null)).toContain(false);
    // The FX3 lesson: the parsed approved intent is the admission's intent (with the approval's pinned account refs), and the digest the approval recorded is the plan's.
    expect(canonicalJson(decoded.intent)).toBe(canonicalJson(applicationIntentWithAccountRefs(applicationRoundIntent(E2EApplicationPlanIntentSchema.parse(JSON.parse(JSON.stringify(intent)))), approved.accountRefs)));
    expect(decoded.intentDigest).toBe(sha256Of(canonicalJson(decoded.intent)));
    expect(applicationIntentDigest(intent)).toBe(approved.selection.intentDigest);
  });

  it("builds one admission for a web app and an API app, each with its own row", async () => {
    const fixture = webAndApiFixture();
    const candidate = await candidateOf({ "package.json": ordersContractManifest, "api/package.json": Buffer.from(fixture.snapshot.sources.find((item) => item.path === "api/package.json")!.bytes).toString("utf8") });
    const intent = fixture.build({ web: true, api: true });
    const approved = evaluateApplicationPlanApproval({ intent, taskId: "11111111-1111-4111-8111-111111111111", artifact: { id: "feature-plan", sha256: "1".repeat(64) }, snapshot: fixture.snapshot,
      setupProposal: fixture.setup.proposal, setupApproval: fixture.setup.setupApproval, policy: fixture.policy, registeredRuntimes: BOTH_ROWS(), runtimeCatalogId: "catalog", runtimeBinding: binding,
      now: Date.now(), accounts: { entries: fixture.registry, mode: "approve", pinned: [] } });
    if (!approved.ok) throw new Error(approved.reason);
    const built = buildApplicationExecutionAdmission({ taskId: "11111111-1111-4111-8111-111111111111", operationId: randomUUID(), operationFence: 2, workflowRevision: 4, roundId: randomUUID(),
      runId: randomUUID, intent, artifact: { id: "feature-plan", sha256: "1".repeat(64) }, snapshot: candidate.snapshot, setupProposal: fixture.setup.proposal, setupApproval: fixture.setup.setupApproval,
      policy: fixture.policy, registeredRuntimes: BOTH_ROWS(), runtimeCatalogId: "catalog", runtimeBinding: binding, buildSource: candidate.buildSource, planDigest: "d".repeat(64), now: Date.now(),
      accountEntries: fixture.registry, recordedSelection: approved.selection });
    const decoded = decodeE2EApplicationExecutionAdmission(built.bytes);
    expect(built.kinds).toEqual(["api", "web"]);
    expect(decoded.applicationBindings).toHaveLength(2);
    expect(decoded.runtimeBindings.map((item) => item.key)).toEqual([e2eRuntimeBindingKey(PROFILE, "api"), e2eRuntimeBindingKey(PROFILE, "web")]);
    expect(validateE2EApplicationExecutionAdmission(decoded).applicationSuites.map((suite) => suite.runtimeKind).sort()).toEqual(["api", "web"]);
  });

  it("refuses a web group handed the API row of its profile: the key says one kind and the row is the other", async () => {
    const { input } = await oneApp();
    const decoded = decodeE2EApplicationExecutionAdmission(buildApplicationExecutionAdmission(input).bytes);
    const apiRow = decoded.runtimeBindings.find((item) => item.value.capabilities.kind === "api")!.value;
    const swapped = (key: string) => resigned(decoded, (body) => {
      body.runtimeBindings = decoded.runtimeBindings.map((item) => item.key === key ? { key, value: apiRow } : item);
    });
    // The schema reads the key against the row it holds, so the swap does not even decode...
    expect(() => decodeE2EApplicationExecutionAdmission(swapped(e2eRuntimeBindingKey(PROFILE, "web")))).toThrow(/runtime binding keys/);
    // ...and a row that is not the one the selection approved, under an honest key, is refused by the verifier's exact comparison.
    const requalified = resigned(decoded, (body) => {
      body.runtimeBindings = decoded.runtimeBindings.map((item) => item.value.capabilities.kind === "web" ? { key: item.key, value: { ...item.value, generation: item.value.generation + 1 } } : item);
    });
    expect(() => validateE2EApplicationExecutionAdmission(decodeE2EApplicationExecutionAdmission(requalified))).toThrow(/runtime binding differs from the exact selected registered runtime row/);
  });

  it("reads an admission the previous code wrote (version 1, rows keyed by the profile), for a web round and for an API round", async () => {
    const web = decodeE2EApplicationExecutionAdmission(buildApplicationExecutionAdmission((await inputs()).input).bytes);
    const asV1 = decodeE2EApplicationExecutionAdmission(asWrittenByVersion1(web));
    expect(asV1.schemaVersion).toBe(E2E_APPLICATION_ADMISSION_SCHEMA_V1);
    expect(asV1.runtimeBindings.map((item) => item.key)).toEqual([PROFILE]);
    const validated = validateE2EApplicationExecutionAdmission(asV1);
    expect(validated.applicationSuites).toHaveLength(1);
    expect(e2eCompiledRuntime(validated.applicationSuites[0]!)?.capabilities.kind).toBe("web");
    // The binding the stored round carries is the same digest the row of its own kind gives.
    expect(validated.admission.round.groupBindings[0]!.runtimeManifestDigest).toBe(e2eCompiledRuntime(validated.applicationSuites[0]!)!.manifestDigest);

    const fixture = webAndApiFixture();
    const candidate = await candidateOf({ "package.json": ordersContractManifest, "api/package.json": Buffer.from(fixture.snapshot.sources.find((item) => item.path === "api/package.json")!.bytes).toString("utf8") });
    const apiAdmission = decodeE2EApplicationExecutionAdmission(buildApplicationExecutionAdmission({ taskId: "11111111-1111-4111-8111-111111111111", operationId: randomUUID(), operationFence: 2, workflowRevision: 4,
      roundId: randomUUID(), runId: randomUUID, intent: fixture.build({ web: false, api: true }), artifact: { id: "feature-plan", sha256: "1".repeat(64) }, snapshot: candidate.snapshot,
      setupProposal: fixture.setup.proposal, setupApproval: fixture.setup.setupApproval, policy: fixture.policy, registeredRuntimes: BOTH_ROWS(), runtimeCatalogId: "catalog", runtimeBinding: binding,
      buildSource: candidate.buildSource, planDigest: "d".repeat(64), now: Date.now(), accountEntries: fixture.registry, recordedSelection: webAndApiSelection(fixture) }).bytes);
    const apiV1 = validateE2EApplicationExecutionAdmission(decodeE2EApplicationExecutionAdmission(asWrittenByVersion1(apiAdmission)));
    expect(apiV1.applicationSuites.map((suite) => suite.runtimeKind)).toEqual(["api"]);
    expect(e2eCompiledRuntime(apiV1.applicationSuites[0]!)?.capabilities.kind).toBe("api");
  });

  it("refuses runtime keys that do not fit the admission's version: a v2 key without its kind, a v1 key with one, and two kinds of one profile under the profile alone", async () => {
    const { input } = await oneApp();
    const both = decodeE2EApplicationExecutionAdmission(buildApplicationExecutionAdmission(input).bytes);
    const profileAlone = resigned(both, (body) => { body.runtimeBindings = both.runtimeBindings.map((item) => ({ key: item.value.profileId, value: item.value })); });
    expect(() => decodeE2EApplicationExecutionAdmission(profileAlone)).toThrow(/runtime binding keys/);
    const v1WithKinds = resigned(both, (body) => { body.schemaVersion = E2E_APPLICATION_ADMISSION_SCHEMA_V1; });
    expect(() => decodeE2EApplicationExecutionAdmission(v1WithKinds)).toThrow(/runtime binding keys/);
    const v1BothUnderProfile = resigned(both, (body) => {
      body.schemaVersion = E2E_APPLICATION_ADMISSION_SCHEMA_V1;
      body.runtimeBindings = both.runtimeBindings.map((item) => ({ key: item.value.profileId, value: item.value }));
    });
    expect(() => decodeE2EApplicationExecutionAdmission(v1BothUnderProfile)).toThrow();
  });
});
