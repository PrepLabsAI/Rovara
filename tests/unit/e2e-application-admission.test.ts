import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { E2E_HARD_LIMITS, WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX, WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX, WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX, canonicalJson,
  deriveE2EApplicationRuntimeAccountRef, deriveE2ESyntheticRuntimeAccountRef, e2eAnonymousRuntimeAccountRef, e2eApplicationAccountDefinitionDigest } from "@agentx/contracts";
import { registryFor } from "../support/e2e-account-registry-fixtures.js";
import { E2E_EXECUTOR_HOST_ENTRY_POINT_ID, E2E_EXECUTOR_HOST_PROFILE_ID, STALE_RUN_SWEEP_AGE_MS, decodeE2EApplicationExecutionAdmission, validateE2EApplicationExecutionAdmission } from "@agentx/verifier";
import { candidateBuildSourceAdmissionReference } from "../../packages/broker/src/aws/candidate-build-source.js";
import { buildApplicationExecutionAdmission, type ApplicationAdmissionInput } from "../../packages/broker/src/e2e/application-admission.js";
import { ApplicationDispatchRefusal } from "../../packages/broker/src/e2e/application-dispatch-check.js";
import { applicationIntentDigest, evaluateApplicationPlanApproval } from "../../packages/broker/src/e2e/application-plan-approval.js";
import { createRealCandidate, disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { anonymousScenario, anonymousTargetOf, binding, inferredSnapshot, ordersContractManifest, planFixture, shaCanonical, webAndApiFixture, webApiRow } from "../support/e2e-application-plan-fixtures.js";

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
    expect(built.kind).toBe("web");
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
    expect(built.kind).toBe("web");
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

  it("passes the verifier only the READY row of the kind in use (Ruling BF), so a profile's web and api rows are never ambiguous", async () => {
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
    expect(built.kind).toBe("api");
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
  it("refuses an intent whose executable targets span web and api (Ruling BF, defense in depth after approval)", async () => {
    const fixture = webAndApiFixture();
    const candidate = await candidateOf({ "package.json": ordersContractManifest, "api/package.json": Buffer.from(fixture.snapshot.sources.find((item) => item.path === "api/package.json")!.bytes).toString("utf8") });
    const input: ApplicationAdmissionInput = { taskId: "11111111-1111-4111-8111-111111111111", operationId: randomUUID(), operationFence: 2, workflowRevision: 4, roundId: randomUUID(),
      runId: randomUUID, intent: fixture.build({ web: true, api: true }), artifact: { id: "feature-plan", sha256: "1".repeat(64) }, snapshot: candidate.snapshot,
      setupProposal: fixture.setup.proposal, setupApproval: fixture.setup.setupApproval, policy: fixture.policy, registeredRuntimes: [webApiRow("web"), webApiRow("api")],
      runtimeCatalogId: "catalog", runtimeBinding: binding, buildSource: candidate.buildSource, planDigest: "d".repeat(64), now: Date.now(), accountEntries: fixture.registry, recordedSelection: webAndApiSelection(fixture) };
    expect(refusalOf(() => buildApplicationExecutionAdmission(input))).toContain("one runtime kind per plan in M1.2");
  });

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
