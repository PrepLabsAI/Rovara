import { applicationIntentWithAccountRefs } from "../../packages/broker/src/e2e/application-plan-approval.js";
import { describe, expect, it } from "vitest";
import { WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX, WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX, WORKFLOW_APPLICATION_PLAN_NOT_APPROVABLE_PREFIX, canonicalJson, change, createWorkflowSnapshot, projectRevisionKey, type StoredDocument } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { createApplicationSelectionReader } from "../../packages/broker/src/core/e2e/application-readiness.js";
import { accountDefinitionRow, accountLatestRow } from "../../packages/broker/src/e2e/application-account-registry.js";
import { e2eRegisteredRuntimeKey } from "../../packages/broker/src/core/e2e/runtime-readiness.js";
import { NOW, binding, planFixture, sha, webApiRow } from "../support/e2e-application-plan-fixtures.js";
import type { ApplicationTask } from "../../packages/broker/src/core/e2e/application-seams.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import type { TaskRecord } from "../../packages/broker/src/core/task-flow/records.js";

const COMPANY = "org_11111111111111111111";
const TASK = "11111111-1111-4111-8111-111111111111";
async function world() {
  const fx = planFixture({});
  const store = new MemoryDocumentStore();
  const objects = createDocumentObjectStorage(store, { companyId: COMPANY });
  const artifact = { id: "plan", sha256: "a".repeat(64) };
  const setupBytes = Buffer.from(canonicalJson({ schemaVersion: "project-setup-source-proposal/v1", issuerOwnerKey: "registrar", repositoryUrl: "https://github.com/example/demo",
    identityMapping: { registeredRepositoryId: "demo" }, policy: fx.policy, proposal: fx.setup.proposal,
    snapshot: { ...fx.snapshot, sources: fx.snapshot.sources.map(({ bytes, ...source }) => ({ ...source, bytesBase64: Buffer.from(bytes).toString("base64") })) } }));
  await objects.put("setup/source", setupBytes, { contentType: "application/json", metadata: {}, retention: "e2e-approval" });
  const key = projectRevisionKey(COMPANY, "payments", 1);
  await store.put({ item: toDocument({ ...key, entityType: "PROJECT", registeredBy: "registrar", runtimeBinding: binding,
    setupApproval: { decision: "approve", proposalRef: "setup/source", proposalSha256: sha(setupBytes), candidateDigest: fx.snapshot.candidate.digest },
    definition: { name: "payments", revision: 1, repositories: [{ name: "demo", url: "https://github.com/example/demo", path: "repo/demo", defaultBranch: "main", credentialRef: "host" }],
      setup: [], readiness: [], orchestratorInstructions: "Build", e2e: fx.policy } }) });
  const row = webApiRow("web");
  await store.put({ item: { ...e2eRegisteredRuntimeKey("catalog", row.profileId, "web"), ...toDocument(row) } });
  for (const entry of fx.registry) {
    await store.put({ item: accountDefinitionRow(COMPANY, "payments", entry.definition) as StoredDocument });
    await store.put({ item: accountLatestRow(COMPANY, "payments", entry.definition.applicationId, entry.definition.profileId, entry.latest) as StoredDocument });
  }
  const task: ApplicationTask = { taskId: TASK, workspaceId: "22222222-2222-4222-8222-222222222222", companyId: COMPANY, developerId: "maya", project: "payments", startingRevision: 1,
    workflow: createWorkflowSnapshot({ taskId: TASK, ownerId: "a".repeat(64), now: new Date(NOW).toISOString() }) } as TaskRecord & ApplicationTask;
  const reader = createApplicationSelectionReader({ companyId: COMPANY, state: { store, now: () => new Date(NOW) }, objects, runtimeCatalogId: "catalog" });
  return { fx, store, reader, task, artifact, key, row };
}

describe("application selection before compute", () => {
  it("derives the approved source's selection, with default-on baseline and atomic row fences", async () => {
    const w = await world();
    const selected = await w.reader.selection(w.task, w.fx.intent, w.artifact, { mode: "approve", pinned: [] });
    expect(selected.selection.executableTargetIds).toEqual(["web-1"]);
    expect(selected.baselineWanted).toBe(true);
    expect(selected.items.length).toBeGreaterThanOrEqual(3);
    expect(await w.store.transact(selected.items)).toEqual({ applied: true });
    await w.store.update({ key: e2eRegisteredRuntimeKey("catalog", w.row.profileId, "web"), ops: [change.set("generation", 5)] });
    expect(await w.store.transact(selected.items)).toMatchObject({ applied: false });
  });

  it("does not read another company's same-named project or accounts", async () => {
    const w = await world();
    await expect(w.reader.selection({ ...w.task, companyId: "org_22222222222222222222" }, w.fx.intent, w.artifact, { mode: "approve", pinned: [] })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("refuses a replaced setup object and carries the project fence through approval", async () => {
    const w = await world();
    const selected = await w.reader.selection(w.task, w.fx.intent, w.artifact, { mode: "approve", pinned: [] });
    await w.store.update({ key: w.key, ops: [change.set(["setupApproval", "proposalSha256"], "f".repeat(64))] });
    expect(await w.store.transact(selected.items)).toMatchObject({ applied: false });
    await expect(w.reader.selection(w.task, w.fx.intent, w.artifact, { mode: "approve", pinned: [] })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("requires the exact approved runtime at dispatch, even after a successful requalification", async () => {
    const w = await world();
    const selected = await w.reader.selection(w.task, w.fx.intent, w.artifact, { mode: "approve", pinned: [] });
    w.task.workflow.e2e = { required: true, contractDigest: w.artifact.sha256, policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64),
      applicationSelection: selected.selection, currentGroupRunIds: [], resultRefs: [] };
    await w.store.update({ key: e2eRegisteredRuntimeKey("catalog", w.row.profileId, "web"), ops: [change.set("generation", 5)] });
    await expect(w.reader.current(w.task, w.fx.intent, w.artifact)).rejects.toThrow(/runtime|selection/iu);
  });
});

describe("a runtime that lacks the private-network probe is not one an application check can be approved or dispatched on", () => {
  /** The same world with the web row's probe list written as a qualification from before the probe wrote it. */
  async function staleWorld() {
    const w = await world();
    const ids = [...w.row.probeManifest.positiveProbeIds, ...w.row.probeManifest.negativeProbeIds].filter((id) => id !== "app-private-denial-v1");
    const { manifestDigest: _digest, ...content } = w.row.probeManifest; void _digest;
    const body = { ...content, positiveProbeIds: ids.slice(0, 2), negativeProbeIds: ids.slice(2) };
    await w.store.update({ key: e2eRegisteredRuntimeKey("catalog", w.row.profileId, "web"), ops: [change.set("probeManifest", { ...body, manifestDigest: sha(canonicalJson(body)) })] });
    return w;
  }
  it("approval refuses it, and a plan already approved refuses to dispatch on it (the row it was approved on went stale)", async () => {
    const fresh = await world();
    const selected = await fresh.reader.selection(fresh.task, fresh.fx.intent, fresh.artifact, { mode: "approve", pinned: [] });
    expect(selected.selection.executableTargetIds).toEqual(["web-1"]);
    const w = await staleWorld();
    await expect(w.reader.selection(w.task, w.fx.intent, w.artifact, { mode: "approve", pinned: [] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    // A plan approved while the runtime was current: the dispatch reads the rows again and finds no runtime.
    const approved = await fresh.reader.selection(fresh.task, fresh.fx.intent, fresh.artifact, { mode: "approve", pinned: [] });
    fresh.task.workflow.e2e = { required: true, contractDigest: fresh.artifact.sha256, policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64),
      applicationSelection: approved.selection, currentGroupRunIds: [], resultRefs: [] };
    const ids = [...fresh.row.probeManifest.positiveProbeIds, ...fresh.row.probeManifest.negativeProbeIds].filter((id) => id !== "app-private-denial-v1");
    const { manifestDigest: _digest, ...content } = fresh.row.probeManifest; void _digest;
    const body = { ...content, positiveProbeIds: ids.slice(0, 2), negativeProbeIds: ids.slice(2) };
    await fresh.store.update({ key: e2eRegisteredRuntimeKey("catalog", fresh.row.profileId, "web"), ops: [change.set("probeManifest", { ...body, manifestDigest: sha(canonicalJson(body)) })] });
    await expect(fresh.reader.current(fresh.task, fresh.fx.intent, fresh.artifact)).rejects.toThrow(WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX);
  });
});

describe("selection refusal classification", () => {
  it("requires a recorded selection before a current read", async () => {
    const w = await world();
    await expect(w.reader.current(w.task, w.fx.intent, w.artifact)).rejects.toThrow("The approved plan has no recorded application selection.");
  });
  for (const mode of ["approve", "current"] as const) for (const scope of ["runtime", "accounts", "plan"] as const) it(`classifies ${scope} refusal in ${mode} mode`, async () => {
    const w = await world();
    const selected = await w.reader.selection(w.task, w.fx.intent, w.artifact, { mode: "approve", pinned: [] });
    w.fx.intent = applicationIntentWithAccountRefs(w.fx.intent, selected.selection.accountRefs);
    if (scope === "runtime") await w.store.delete({ key: e2eRegisteredRuntimeKey("catalog", w.row.profileId, "web") });
    if (scope === "accounts") {
      const entry = w.fx.registry[0]!;
      await w.store.delete({ key: accountLatestRow(COMPANY, "payments", entry.definition.applicationId, entry.definition.profileId, entry.latest) as StoredDocument });
    }
    if (scope === "plan") w.fx.intent.scenarios[0]!.requestedTargetIds = ["missing-target"];
    const promise = w.reader.selection(w.task, w.fx.intent, w.artifact, { mode, pinned: selected.selection.accountRefs });
    if (mode === "approve") await expect(promise).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    else await expect(promise).rejects.toThrow(scope === "runtime" ? WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX : scope === "accounts" ? WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX : WORKFLOW_APPLICATION_PLAN_NOT_APPROVABLE_PREFIX);
  });
  for (const invalid of ["name", "revision"] as const) it(`refuses a pinned project with another ${invalid}`, async () => {
    const w = await world(); await w.store.update({ key: w.key, ops: [change.set(["definition", invalid], invalid === "name" ? "other" : 2)] });
    await expect(w.reader.selection(w.task, w.fx.intent, w.artifact, { mode: "approve", pinned: [] })).rejects.toThrow("The pinned application project revision is unavailable.");
  });
});

for (const invalid of ["declined", "issuer", "candidate"] as const) it(`refuses ${invalid} setup authority before deriving selection`, async () => {
  const w = await world(); const project = (await w.store.get(w.key))!;
  if (invalid === "declined") await w.store.update({ key: w.key, ops: [change.set(["setupApproval", "decision"], "decline")] });
  if (invalid === "candidate") await w.store.update({ key: w.key, ops: [change.set(["setupApproval", "candidateDigest"], "e".repeat(64))] });
  if (invalid === "issuer") await w.store.update({ key: w.key, ops: [change.set("registeredBy", "another-registrar")] });
  void project;
  await expect(w.reader.selection(w.task, w.fx.intent, w.artifact, { mode: "approve", pinned: [] })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
});

it("refuses corrupt registered accounts before the plan evaluator can treat them as absent", async () => {
  const w = await world(); const entry = w.fx.registry[0]!;
  const row = accountDefinitionRow(COMPANY, "payments", entry.definition) as StoredDocument;
  await w.store.put({ item: { ...row, definition: { invalid: true } } });
  await expect(w.reader.selection(w.task, w.fx.intent, w.artifact, { mode: "approve", pinned: [] })).rejects.toThrow("The registered test accounts cannot be read; register the project's setup again.");
});
