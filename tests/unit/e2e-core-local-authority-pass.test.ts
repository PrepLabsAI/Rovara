// The passing path of the local authority, with every fence it hands the build step. A round that ran on a real admission (the one the broker builds for an approved plan) is judged against records
// that still match; the rows it stands on come back as conditions, and a change to any one of them voids the pass at the transaction that would record the verdict.
// Runs on the pinned Node (22.23.2), like every suite built on the application evidence fixture, which signs the toolchain version into the evidence: run it with `vt`, not under another patch version.
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { E2EApplicationPlanIntentSchema, IMPLICIT_COMPANY_ID, OrgIdSchema, change, deriveE2EApplicationRuntimeAccountRef, e2eApplicationMetadataSourceRefs, orgProjectCatalogKey, projectRevisionKey, type E2EScenario, type StoredDocument, type TransactItem } from "@rovara-code/contracts";
import { decodeE2EApplicationExecutionAdmission } from "@agentx/verifier";
import { applicationApprovedPlanDigest, buildApplicationExecutionAdmission } from "../../packages/core/src/e2e/application-admission.js";
import { evaluateApplicationPlanApproval } from "../../packages/core/src/e2e/application-plan-approval.js";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";
import { createDocumentObjectStorage } from "../../packages/core/src/core/proof/evidence-blob-store.js";
import { e2eAccountLatestKey } from "../../packages/core/src/e2e/application-account-registry.js";
import { e2eRegisteredRuntimeKey } from "../../packages/core/src/core/e2e/runtime-readiness.js";
import { candidateSourceObjectKey } from "../../packages/core/src/core/e2e/uploads.js";
import { createLocalE2EAuthority, localOwnerAuthority, type CurrentSelection, type LocalAuthorityDeps } from "../../packages/core/src/core/e2e/local-authority.js";
import type { E2EVerificationDiagnostic } from "../../packages/core/src/core/e2e/authority.js";
import { createRealCandidate, disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { ordersManifestWith, registryFor } from "../support/e2e-account-registry-fixtures.js";
import { PROFILE, approvedSetup, binding, csvScenario, snapshotOf, webApiRow } from "../support/e2e-application-plan-fixtures.js";

// The approved plan's document and the owner's decision are the plan lane's; here they are handed over as already read, so the test is about what the authority does with them.
const plan: { intent: unknown } = vi.hoisted(() => ({ intent: undefined }));
vi.mock("../../packages/core/src/developer/plan-document-reader.js", () => ({ loadWorkflowDocument: async () => ({ format: "structured", plan: { e2e: plan.intent } }) }));
vi.mock("../../packages/core/src/aws/workflow-e2e-current-authority.js", () => ({ resolveWorkflowE2ECanonicalApproval: () => ({ artifactId: "feature-plan", artifactDigest: "1".repeat(64), graphDigest: null, runId: null, workflowRevision: 3, actorId: "owner-1" }) }));

afterEach(disposeRealCandidates);

const COMPANY = OrgIdSchema.parse(IMPLICIT_COMPANY_ID);
const TASK = "11111111-1111-4111-8111-111111111111";
const PROJECT = "payments";
const ARTIFACT = { id: "feature-plan", sha256: "1".repeat(64) };
const asDocument = (value: unknown): StoredDocument => JSON.parse(JSON.stringify(value)) as StoredDocument;
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

async function setup() {
  const manifest = ordersManifestWith(() => undefined);
  const snapshot = snapshotOf({ "package.json": manifest });
  const approved = approvedSetup(snapshot, [{ kind: "web", profileId: PROFILE }]);
  const registry = registryFor(snapshot, Date.now());
  const web = approved.proposal.targets.find((item) => item.kind === "web")!;
  const application = approved.inspection.applications.find((item) => item.applicationId === web.applicationId)!;
  const sourceRefs = e2eApplicationMetadataSourceRefs(snapshot, application.applicationId, application.sourcePaths);
  const accountRef = deriveE2EApplicationRuntimeAccountRef(registry.find((entry) => entry.definition.applicationId === application.applicationId && entry.definition.profileId === web.accountProfileId)!.definition);
  const scenario: E2EScenario = { ...csvScenario, minimumEvidence: "runtime", requiredRealComponentIds: [], required: true, requestedTargetIds: [web.targetId], accountProfileId: web.accountProfileId };
  const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: [web.targetId], portableOperationRefs: [], mockFixtureRefs: [],
    accountContextRefs: [{ applicationId: application.applicationId, profileId: web.accountProfileId, sourcePath: sourceRefs[0]!.path, sourceSha256: sourceRefs[0]!.sha256 }],
    scenarios: [scenario], semanticExportDeltas: [],
    applicationRuntimeRefs: [{ targetId: web.targetId, applicationId: application.applicationId, recipeDigest: application.recipe!.recipeDigest, sourceRefs, runtimeProfileId: web.runtimeProfileId, accountProfileId: web.accountProfileId }],
    runtimeAccountRefs: [accountRef], unavailableTargetRefs: [] });
  plan.intent = intent;
  const policy = { ...approved.policy, baselineScenarioIds: [scenario.scenarioId], modelRouteRevision: null };
  const rows = [webApiRow("web")];
  const candidate = await createRealCandidate({ "package.json": manifest });
  const approve = evaluateApplicationPlanApproval({ intent, taskId: TASK, artifact: ARTIFACT, snapshot, setupProposal: approved.proposal, setupApproval: approved.setupApproval, policy,
    registeredRuntimes: rows, runtimeCatalogId: "catalog", runtimeBinding: binding, now: Date.now(), accounts: { entries: registry, mode: "approve", pinned: [] } });
  if (!approve.ok) throw new Error(approve.reason);
  const built = buildApplicationExecutionAdmission({ taskId: TASK, operationId: randomUUID(), operationFence: 3, workflowRevision: 7, roundId: randomUUID(), runId: randomUUID, intent, artifact: ARTIFACT,
    snapshot: candidate.snapshot, setupProposal: approved.proposal, setupApproval: approved.setupApproval, policy, registeredRuntimes: rows, runtimeCatalogId: "catalog", runtimeBinding: binding,
    buildSource: candidate.buildSource, now: Date.now(), accountEntries: registry, recordedSelection: approve.selection, planDigest: applicationApprovedPlanDigest(TASK, { artifactId: ARTIFACT.id, artifactDigest: ARTIFACT.sha256, graphDigest: "2".repeat(64), runId: "33333333-3333-4333-8333-333333333333", workflowRevision: 5, actorId: "owner-1" }) });
  const admission = { ...decodeE2EApplicationExecutionAdmission(built.bytes), creatorAuthority: localOwnerAuthority("maya", PROJECT) };
  type BaseAdmission = typeof admission;
  const store = new MemoryDocumentStore();
  const objects = createDocumentObjectStorage(store, { companyId: COMPANY });
  const exportBytes = Buffer.from(JSON.stringify(candidate.source), "utf8");
  const sourceRef = { key: candidateSourceObjectKey(sha(exportBytes)), sha256: sha(exportBytes), byteLength: exportBytes.byteLength, candidateDigest: candidate.source.candidate.digest };
  await objects.put(sourceRef.key, exportBytes, { contentType: "application/json", metadata: {}, retention: "task-document" });
  const definition = { name: PROJECT, revision: 1, e2e: policy } as never;
  const revisionRow = { entityType: "PROJECT", registeredBy: "owner-1", definition: { name: PROJECT, revision: 1, e2e: policy }, runtimeBinding: binding, setupApproval: approved.setupApproval };
  await store.put({ item: asDocument({ ...projectRevisionKey(COMPANY, PROJECT, 1), ...revisionRow }) });
  await store.put({ item: { ...orgProjectCatalogKey(COMPANY, PROJECT), entityType: "PROJECT_CATALOG", name: PROJECT, latestRevision: 1 } });
  for (const row of rows) await store.put({ item: asDocument({ ...e2eRegisteredRuntimeKey(row.runtimeCatalogId, row.profileId, "web"), ...row }) });
  for (const entry of registry) await store.put({ item: asDocument({ ...e2eAccountLatestKey(COMPANY, PROJECT, entry.definition.applicationId, entry.definition.profileId), entityType: "E2E_ACCOUNT_LATEST", ...entry.latest }) });
  const task = { taskId: TASK, project: PROJECT, developerId: "maya", startingRevision: 1, workspaceId: "ws-1",
    workflow: { e2e: { required: true, contractDigest: ARTIFACT.sha256, applicationSelection: approve.selection }, candidate: admission.sourceSnapshot.candidate, artifacts: [{ type: "plan", id: ARTIFACT.id, sha256: ARTIFACT.sha256, objectKey: "plans/p", format: "structured" }], decisions: [] } } as never;
  const operation = { id: randomUUID(), kind: "task", workflowMode: "IMPLEMENT", createdAt: "2026-11-10T10:00:00.000Z", candidateSourceRef: sourceRef } as never;
  const selection: CurrentSelection = { ok: true, selection: approve.selection, rows, accountEntries: registry };
  const revision = { definition, archived: false } as never;
  const deps = (over: Partial<LocalAuthorityDeps> = {}): LocalAuthorityDeps => ({ companyId: COMPANY, state: { store }, objects, projects: { latest: async () => revision, revision: async () => revision },
    access: { checkStep: async () => ({ allowed: true }) }, operationsOf: async () => [operation], currentSelection: async () => selection, ...over });
  const judge = async (over: Partial<LocalAuthorityDeps> = {}, edit: (value: BaseAdmission) => BaseAdmission = (value) => value) => {
    const diagnostic: E2EVerificationDiagnostic = {};
    const ok = await createLocalE2EAuthority(deps(over)).application({ task, candidate: admission.sourceSnapshot.candidate, admission: edit(admission) }, diagnostic);
    return { ok, diagnostic };
  };
  const fencedAccounts = approve.selection.accountRefs.map((ref) => ({ applicationId: ref.applicationId, profileId: ref.profileId, revision: ref.revision }));
  return { store, judge, rows, registry, task, admission, selection, fencedAccounts };
}

const apply = async (store: MemoryDocumentStore, items: readonly TransactItem[] | undefined) => (await store.transact([...(items ?? [])])).applied;

describe("the local authority, when everything it is asked still holds", () => {
  it("passes, and hands back a fence on the catalog, the project's revision, every runtime row the round ran on and each account, all of which hold now", async () => {
    const w = await setup();
    const { ok, diagnostic } = await w.judge();
    expect(diagnostic.reason).toBeUndefined();
    expect(ok).toBe(true);
    const keys = (diagnostic.authorityChecks ?? []).map((item) => (item.kind === "check" ? `${item.key.pk}|${item.key.sk}` : "?"));
    expect(keys).toContain(`${orgProjectCatalogKey(COMPANY, PROJECT).pk}|${orgProjectCatalogKey(COMPANY, PROJECT).sk}`);
    expect(keys).toContain(`${projectRevisionKey(COMPANY, PROJECT, 1).pk}|${projectRevisionKey(COMPANY, PROJECT, 1).sk}`);
    for (const row of w.rows) expect(keys).toContain(`${e2eRegisteredRuntimeKey(row.runtimeCatalogId, row.profileId, "web").pk}|${e2eRegisteredRuntimeKey(row.runtimeCatalogId, row.profileId, "web").sk}`);
    // The accounts the plan runs as are fenced (the others of the registry are not the round's).
    expect(w.fencedAccounts.length).toBeGreaterThan(0);
    for (const ref of w.fencedAccounts) expect(keys).toContain(`${e2eAccountLatestKey(COMPANY, PROJECT, ref.applicationId, ref.profileId).pk}|${e2eAccountLatestKey(COMPANY, PROJECT, ref.applicationId, ref.profileId).sk}`);
    expect(await apply(w.store, diagnostic.authorityChecks)).toBe(true);
  });

  /** One field of one fenced row moves after the verdict was judged: the fences no longer hold, so the verdict cannot be recorded. */
  const moves: Array<[string, (w: Awaited<ReturnType<typeof setup>>) => Promise<void>]> = [
    ["the catalog's latest revision", async (w) => { await w.store.update({ key: orgProjectCatalogKey(COMPANY, PROJECT), ops: [change.set("latestRevision", 2)] }); }],
    ["the project's E2E policy", async (w) => { await w.store.update({ key: projectRevisionKey(COMPANY, PROJECT, 1), ops: [change.set(["definition", "e2e"], { changed: true })] }); }],
    ["the project's setup approval", async (w) => { await w.store.update({ key: projectRevisionKey(COMPANY, PROJECT, 1), ops: [change.set("setupApproval", { changed: true })] }); }],
    ["the project's runtime binding", async (w) => { await w.store.update({ key: projectRevisionKey(COMPANY, PROJECT, 1), ops: [change.set("runtimeBinding", { changed: true })] }); }],
    ["who registered the project", async (w) => { await w.store.update({ key: projectRevisionKey(COMPANY, PROJECT, 1), ops: [change.set("registeredBy", "someone-else")] }); }],
    ["a runtime row's generation", async (w) => { const row = w.rows[0]!; await w.store.update({ key: e2eRegisteredRuntimeKey(row.runtimeCatalogId, row.profileId, "web"), ops: [change.set("generation", row.generation + 1)] }); }],
    ["a runtime row's state", async (w) => { const row = w.rows[0]!; await w.store.update({ key: e2eRegisteredRuntimeKey(row.runtimeCatalogId, row.profileId, "web"), ops: [change.set("state", "EXPIRED")] }); }],
    ["a runtime row's capabilities", async (w) => { const row = w.rows[0]!; await w.store.update({ key: e2eRegisteredRuntimeKey(row.runtimeCatalogId, row.profileId, "web"), ops: [change.set("capabilityDigest", "f".repeat(64))] }); }],
    ["an account's revision", async (w) => { const ref = w.fencedAccounts[0]!; await w.store.update({ key: e2eAccountLatestKey(COMPANY, PROJECT, ref.applicationId, ref.profileId), ops: [change.set("revision", ref.revision + 1)] }); }],
    ["an account's definition", async (w) => { const ref = w.fencedAccounts[0]!; await w.store.update({ key: e2eAccountLatestKey(COMPANY, PROJECT, ref.applicationId, ref.profileId), ops: [change.set("definitionDigest", "e".repeat(64))] }); }],
  ];
  for (const [name, move] of moves) {
    it(`is voided when ${name} moves before the verdict is recorded`, async () => {
      const w = await setup();
      const { ok, diagnostic } = await w.judge();
      expect(ok).toBe(true);
      await move(w);
      expect(await apply(w.store, diagnostic.authorityChecks)).toBe(false);
    });
  }
});

describe("the local authority refuses what it cannot fence or what moved", () => {
  it("refuses a project whose catalog row is gone, whose latest revision holds no setup approval, or whose pinned and latest revisions differ in runtime binding", async () => {
    const gone = await setup();
    await gone.store.delete({ key: orgProjectCatalogKey(COMPANY, PROJECT) });
    expect((await gone.judge()).diagnostic.reason).toBe("current-project-latest-revision-unavailable");
    const noSetup = await setup();
    await noSetup.store.update({ key: projectRevisionKey(COMPANY, PROJECT, 1), ops: [change.remove("setupApproval")] });
    expect((await noSetup.judge()).diagnostic.reason).toBe("current-project-setup-approval-unavailable");
    const moved = await setup();
    const policyOf = ((await moved.store.get(projectRevisionKey(COMPANY, PROJECT, 1)))!["definition"] as { e2e: unknown }).e2e;
    await moved.store.put({ item: { ...projectRevisionKey(COMPANY, PROJECT, 2), entityType: "PROJECT", definition: { name: PROJECT, revision: 2, e2e: policyOf as never }, setupApproval: { a: 1 }, runtimeBinding: { other: true } } });
    await moved.store.update({ key: orgProjectCatalogKey(COMPANY, PROJECT), ops: [change.set("latestRevision", 2)] });
    const other = { definition: { name: PROJECT, revision: 2, e2e: policyOf } } as never;
    const revision1 = { definition: { name: PROJECT, revision: 1, e2e: policyOf } } as never;
    const judged = await moved.judge({ projects: { latest: async () => other, revision: async () => revision1 } });
    expect(judged.ok).toBe(false);
    expect(judged.diagnostic.reason).toBe("current-project-policy-or-runtime-changed");
  });

  it("refuses a round whose runtime row is not among the rows read now, whatever the seam says", async () => {
    const w = await setup();
    const judged = await w.judge({ currentSelection: async () => ({ ...w.selection, rows: [] }) });
    expect(judged.ok).toBe(false);
    expect(judged.diagnostic.reason).toContain("is not ready now");
  });

  it("refuses a round whose runtime row was requalified since it was admitted (same kind and profile, another generation), naming what moved", async () => {
    const w = await setup();
    const requalified = { ...w.rows[0]!, generation: w.rows[0]!.generation + 1 };
    const judged = await w.judge({ currentSelection: async () => ({ ...w.selection, rows: [requalified] }) });
    expect(judged.ok).toBe(false);
    expect(judged.diagnostic.runtimeChange).toBe("requalified");
    expect(judged.diagnostic.reason).toContain("was requalified during the round (generation");
    expect(judged.diagnostic.authorityChecks).toBeUndefined();
  });

  it("refuses when the creator's proof is not the local owner's, or the install has no runtime registration to ask", async () => {
    const w = await setup();
    expect((await w.judge({}, (value) => ({ ...value, creatorAuthority: localOwnerAuthority("someone-else", PROJECT) }))).diagnostic.reason).toBe("creator-membership-proof-changed-or-unavailable");
    expect((await w.judge({ currentSelection: undefined })).diagnostic.reason).toBe("no-current-authority-source");
  });
});
