// The test-account registry, the runtime fences and the files of the browser and API checks on the document store and the object-storage port: the rows are at the keys Cloud stores,
// a registration that races another writes one revision between them, and a fence refuses once the row it stands on moved.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { E2E_DISPLAY_SCREENSHOT_MAX_BYTES, IMPLICIT_COMPANY_ID, change, OrgIdSchema, projectPk, type E2EWorkflowAdmissionRef, type StoredDocument } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { accountRegistryFences, planSetupAccountWrites, readAccountRegistryEntries } from "../../packages/broker/src/core/e2e/account-registry.js";
import { E2EAccountRegistryError, e2eAccountDefinitionKey, e2eAccountLatestKey } from "../../packages/broker/src/e2e/application-account-registry.js";
import {
  applicationRuntimeRowFences, e2eRegisteredRuntimeKey, readProjectAdmittedE2ERuntimes, readProjectReadyE2ERuntimes, runtimeRowReader,
} from "../../packages/broker/src/core/e2e/runtime-readiness.js";
import {
  createWorkflowE2EAdmissionAgentStepsReader, createWorkflowE2EAdmissionNeedsModelFreeLimitsReader, createWorkflowE2EAdmissionSchemaReader, loadWorkflowE2EArtifact,
  readStoredAdmission, storeWorkflowE2EAdmission, storeWorkflowE2EArtifacts,
} from "../../packages/broker/src/core/e2e/artifacts.js";
import { workflowE2EArtifactKey } from "../../packages/broker/src/aws/workflow-e2e-notifier-projection.js";
import { ORDERS_APPLICATION_ID, ordersManifestWith, withOwnerB, withViewerRole } from "../support/e2e-account-registry-fixtures.js";
import { NOW, PROFILE, binding, snapshotOf, webApiRow } from "../support/e2e-application-plan-fixtures.js";

const ORG = OrgIdSchema.parse(IMPLICIT_COMPANY_ID);
const COMPANY_PK = projectPk(ORG, "payments");
const T1 = "2026-10-01T00:00:00.000Z";
const T2 = "2026-10-02T00:00:00.000Z";
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const PROFILES = ["synthetic", "orders-owner", "orders-viewer", "orders-owner-b"];
const snapshotWith = (...edits: Array<(e2e: Parameters<typeof withOwnerB>[0]) => void>) => snapshotOf({ "package.json": ordersManifestWith((e2e) => { withOwnerB(e2e); for (const edit of edits) edit(e2e); }) });
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

describe("the account registry on the document store", () => {
  const plan = (deps: { store: MemoryDocumentStore }, snapshot = snapshotWith(), approvedAt = T1, now = T0) =>
    planSetupAccountWrites(deps, { orgId: ORG, projectId: "payments", snapshot, setup: { approvedAt, proposalSha256: "a".repeat(64) }, now });
  const latestRevisions = async (store: MemoryDocumentStore) => {
    const revisions: Record<string, number> = {};
    for (const profile of PROFILES) revisions[profile] = Number((await store.get(e2eAccountLatestKey(ORG, "payments", ORDERS_APPLICATION_ID, profile)))?.["revision"] ?? 0);
    return revisions;
  };

  it("writes revision 1 of every synthetic profile under the company's project partition, and nothing when planned again", async () => {
    const store = new MemoryDocumentStore();
    const first = await plan({ store });
    expect(first.written).toBe(4);
    expect(await store.transact(first.items)).toEqual({ applied: true });
    expect(await latestRevisions(store)).toEqual({ synthetic: 1, "orders-owner": 1, "orders-viewer": 1, "orders-owner-b": 1 });
    const pointer = await store.get({ pk: COMPANY_PK, sk: `E2E_ACCOUNT_LATEST#${ORDERS_APPLICATION_ID}#orders-viewer` });
    expect(pointer).toMatchObject({ entityType: "E2E_ACCOUNT_LATEST", revision: 1, setupApprovedAt: T1, setupProposalSha256: "a".repeat(64) });
    expect(await store.get({ pk: COMPANY_PK, sk: `E2E_ACCOUNT#${ORDERS_APPLICATION_ID}#orders-viewer#REV#1` })).toMatchObject({ entityType: "E2E_ACCOUNT" });
    expect((await plan({ store })).written).toBe(0);
  });

  it("lets one of two racing registrations win; the loser's transaction fails whole and its next plan finds nothing left to write", async () => {
    const store = new MemoryDocumentStore();
    const winner = await plan({ store });
    const loser = await plan({ store });
    expect(await store.transact(winner.items)).toEqual({ applied: true });
    expect(await store.transact(loser.items)).toMatchObject({ applied: false, reason: "condition_failed" });
    expect(await latestRevisions(store)).toEqual({ synthetic: 1, "orders-owner": 1, "orders-viewer": 1, "orders-owner-b": 1 });
    expect((await plan({ store })).written).toBe(0);
  });

  it("writes the next revision only over the revision it read, and a planner that read an older pointer cannot overwrite a newer one", async () => {
    const store = new MemoryDocumentStore();
    await store.transact((await plan({ store })).items);
    const stale = await plan({ store }, snapshotWith(withViewerRole("auditor")), T2);
    const fresh = await plan({ store }, snapshotWith(withViewerRole("auditor")), T2);
    // The newer setup approval raises the three unchanged pointers and writes revision 2 of the changed one.
    expect(stale.written).toBe(4);
    expect(stale.items.filter((item) => item.kind === "put" && String(item.item.sk).startsWith("E2E_ACCOUNT#"))).toHaveLength(1);
    expect(await store.transact(stale.items)).toEqual({ applied: true });
    expect((await latestRevisions(store))["orders-viewer"]).toBe(2);
    // The other writer read revision 1 as well: its write names revision 1 as the one it replaces, which is gone.
    expect(await store.transact(fresh.items)).toMatchObject({ applied: false });
    expect((await latestRevisions(store))["orders-viewer"]).toBe(2);
  });

  it("does not let a pointer that was only raised overwrite a revision another writer wrote meanwhile", async () => {
    const store = new MemoryDocumentStore();
    await store.transact((await plan({ store })).items);
    const raise = await plan({ store }, snapshotWith(), "2026-10-05T00:00:00.000Z");
    expect(raise.items.every((item) => item.kind === "put" && String(item.item.sk).startsWith("E2E_ACCOUNT_LATEST#"))).toBe(true);
    await store.transact((await plan({ store }, snapshotWith(withViewerRole("auditor")), T2)).items);
    expect(await store.transact(raise.items)).toMatchObject({ applied: false, reason: "condition_failed" });
    expect((await latestRevisions(store))["orders-viewer"]).toBe(2);
  });

  it("lets only one of two racing repairs of the same account write its definition", async () => {
    const store = new MemoryDocumentStore();
    await store.transact((await plan({ store })).items);
    await store.put({ item: { ...e2eAccountLatestKey(ORG, "payments", ORDERS_APPLICATION_ID, "orders-viewer"), entityType: "E2E_ACCOUNT_LATEST", revision: "garbage" } });
    const first = await plan({ store });
    const second = await plan({ store });
    expect(await store.transact(first.items)).toEqual({ applied: true });
    const definition = await store.get(e2eAccountDefinitionKey(ORG, "payments", ORDERS_APPLICATION_ID, "orders-viewer", 2));
    expect(definition).toBeDefined();
    expect(await store.transact(second.items)).toMatchObject({ applied: false });
    expect(await store.get(e2eAccountDefinitionKey(ORG, "payments", ORDERS_APPLICATION_ID, "orders-viewer", 2))).toEqual(definition);
  });

  it("refuses, as superseded, a setup approved earlier than the one that wrote the current definition", async () => {
    const store = new MemoryDocumentStore();
    await store.transact((await plan({ store })).items);
    await store.transact((await plan({ store }, snapshotWith(withViewerRole("auditor")), T2)).items);
    await expect(plan({ store }, snapshotWith(withViewerRole("operator")), T1)).rejects.toMatchObject({ code: "setup-superseded" });
    expect((await latestRevisions(store))["orders-viewer"]).toBe(2);
  });

  it("repairs an account whose pointer cannot be read, writing over it at the revision after the highest one it can find, and leaves the others alone", async () => {
    const store = new MemoryDocumentStore();
    await store.transact((await plan({ store })).items);
    await store.transact((await plan({ store }, snapshotWith(withViewerRole("auditor")), T2)).items);
    const key = e2eAccountLatestKey(ORG, "payments", ORDERS_APPLICATION_ID, "orders-viewer");
    await store.put({ item: { ...key, entityType: "E2E_ACCOUNT_LATEST", revision: "garbage", setupApprovedAt: T2 } });
    const read = await readAccountRegistryEntries({ store }, ORG, "payments", PROFILES.map((profileId) => ({ applicationId: ORDERS_APPLICATION_ID, profileId })));
    expect(read.corrupt).toEqual([{ applicationId: ORDERS_APPLICATION_ID, profileId: "orders-viewer", setupApprovedAt: T2 }]);
    expect(read.entries.map((entry) => entry.definition.profileId).sort()).toEqual(["orders-owner", "orders-owner-b", "synthetic"]);
    const repair = await plan({ store }, snapshotWith(withViewerRole("auditor")), "2026-10-03T00:00:00.000Z");
    expect(repair.items.filter((item) => item.kind === "put" && String(item.item.sk).startsWith("E2E_ACCOUNT#"))).toHaveLength(1);
    expect(await store.transact(repair.items)).toEqual({ applied: true });
    expect((await latestRevisions(store))["orders-viewer"]).toBe(3);
    expect((await latestRevisions(store))["orders-owner"]).toBe(1);
  });

  it("raises a pointer without writing a definition when only the setup approval is newer", async () => {
    const store = new MemoryDocumentStore();
    await store.transact((await plan({ store })).items);
    const touched = await plan({ store }, snapshotWith(), "2026-10-05T00:00:00.000Z");
    expect(touched.items.every((item) => item.kind === "put" && String(item.item.sk).startsWith("E2E_ACCOUNT_LATEST#"))).toBe(true);
    expect(await store.transact(touched.items)).toEqual({ applied: true });
    expect(await store.get(e2eAccountLatestKey(ORG, "payments", ORDERS_APPLICATION_ID, "synthetic"))).toMatchObject({ revision: 1, setupApprovedAt: "2026-10-05T00:00:00.000Z" });
  });

  it("keeps two companies' same-named projects apart", async () => {
    const store = new MemoryDocumentStore();
    const other = OrgIdSchema.parse("org_zzzzzzzzzzzzzzzzzzzz");
    await store.transact((await plan({ store })).items);
    const read = await readAccountRegistryEntries({ store }, other, "payments", [{ applicationId: ORDERS_APPLICATION_ID, profileId: "synthetic" }]);
    expect(read.entries).toEqual([]);
    const otherPlan = await planSetupAccountWrites({ store }, { orgId: other, projectId: "payments", snapshot: snapshotWith(), setup: { approvedAt: T1, proposalSha256: "a".repeat(64) }, now: T0 });
    expect(otherPlan.written).toBe(4);
  });

  it("holds the accounts an approval stands on with fences that refuse once a pointer moved", async () => {
    const store = new MemoryDocumentStore();
    await store.transact((await plan({ store })).items);
    const pairs = PROFILES.map((profileId) => ({ applicationId: ORDERS_APPLICATION_ID, profileId }));
    const { entries } = await readAccountRegistryEntries({ store }, ORG, "payments", pairs);
    const refs = entries.map((entry) => ({ applicationId: entry.definition.applicationId, profileId: entry.definition.profileId, revision: entry.latest.revision, definitionDigest: entry.latest.definitionDigest })) as never;
    const fences = accountRegistryFences({ orgId: ORG, projectId: "payments", refs, entries });
    expect(fences).toHaveLength(4);
    expect(await store.transact(fences)).toEqual({ applied: true });
    // A ref with no registered account has nothing to fence.
    expect(accountRegistryFences({ orgId: ORG, projectId: "payments", refs: [{ applicationId: "other", profileId: "x", revision: 1, definitionDigest: "d" }] as never, entries })).toEqual([]);
    const pointerKey = e2eAccountLatestKey(ORG, "payments", ORDERS_APPLICATION_ID, "orders-viewer");
    // Either half of what the approval read moving, on its own, is enough to refuse.
    await store.update({ key: pointerKey, ops: [change.set("definitionDigest", "f".repeat(64))] });
    expect(await store.transact(fences)).toMatchObject({ applied: false });
    await store.update({ key: pointerKey, ops: [change.set("definitionDigest", entries.find((entry) => entry.definition.profileId === "orders-viewer")!.latest.definitionDigest)] });
    expect(await store.transact(fences)).toEqual({ applied: true });
    await store.update({ key: pointerKey, ops: [change.set("revision", 2)] });
    expect(await store.transact(fences)).toMatchObject({ applied: false });
    await store.update({ key: pointerKey, ops: [change.set("revision", 1)] });
    await store.transact((await plan({ store }, snapshotWith(withViewerRole("auditor")), T2)).items);
    const moved = await store.transact(fences);
    expect(moved).toMatchObject({ applied: false, reason: "condition_failed" });
    expect(moved.applied === false && moved.failed.length).toBe(1);
  });

  it("reads the older revisions too when the latest is for another contract, and reads none otherwise", async () => {
    const store = new MemoryDocumentStore();
    await store.transact((await plan({ store })).items);
    await store.transact((await plan({ store }, snapshotWith(withViewerRole("auditor")), T2)).items);
    const pair = [{ applicationId: ORDERS_APPLICATION_ID, profileId: "orders-viewer" }];
    expect((await readAccountRegistryEntries({ store }, ORG, "payments", pair)).entries[0]?.earlier).toBeUndefined();
    const withEarlier = await readAccountRegistryEntries({ store }, ORG, "payments", pair, { earlierFor: () => true });
    expect(withEarlier.entries[0]?.earlier?.map((definition) => definition.revision)).toEqual([1]);
    // An unreadable definition behind a readable pointer is a corrupt account, not an exception.
    await store.delete({ key: e2eAccountDefinitionKey(ORG, "payments", ORDERS_APPLICATION_ID, "orders-viewer", 2) });
    expect((await readAccountRegistryEntries({ store }, ORG, "payments", pair)).corrupt).toHaveLength(1);
  });

  it("rethrows what is not an account problem", async () => {
    const store = new MemoryDocumentStore();
    store.injectFault({ code: "unavailable", name: "DocumentStoreError", message: "down", retryable: true } as never);
    await expect(readAccountRegistryEntries({ store }, ORG, "payments", [{ applicationId: ORDERS_APPLICATION_ID, profileId: "synthetic" }])).rejects.toBeTruthy();
    expect(E2EAccountRegistryError).toBeTypeOf("function");
  });
});

describe("the runtime catalog rows on the document store", () => {
  const rowDocument = (kind: "web" | "api", overrides: Record<string, unknown> = {}) => {
    const row = webApiRow(kind, overrides);
    return { row, document: { ...e2eRegisteredRuntimeKey(row.runtimeCatalogId, row.profileId, kind), ...row } as unknown as StoredDocument };
  };

  it("admits READY rows from the store at Cloud's catalog key, and reads none that moved, expired or hold the other kind", async () => {
    const store = new MemoryDocumentStore();
    const web = rowDocument("web");
    await store.put({ item: web.document });
    const input = { runtimeCatalogId: "catalog", profileId: PROFILE, binding, now: NOW, read: runtimeRowReader(store) };
    expect(web.document.pk).toBe("E2E_FEATURE_VERIFIER#catalog");
    expect(web.document.sk).toBe(`PROFILE#${PROFILE}#web`);
    expect((await readProjectReadyE2ERuntimes(input)).map((runtime) => runtime.kind)).toEqual(["web"]);
    expect((await readProjectAdmittedE2ERuntimes(input)).map((runtime) => runtime.profileId)).toEqual([PROFILE]);
    // A row of another binding is not READY for this project.
    expect(await readProjectReadyE2ERuntimes({ ...input, binding: { ...binding, volumeSizeGiB: 64 } })).toEqual([]);
    expect(await readProjectReadyE2ERuntimes({ ...input, now: NOW + 24 * 3_600_000 })).toEqual([]);
  });

  it("fences the exact rows an approval selected, and refuses once a requalification changed any of them", async () => {
    const store = new MemoryDocumentStore();
    const web = rowDocument("web");
    await store.put({ item: web.document });
    const fences = applicationRuntimeRowFences({ rows: [web.row], selected: [{ kind: "web", profileId: PROFILE }] });
    expect(fences).toHaveLength(1);
    expect(await store.transact(fences)).toEqual({ applied: true });
    const changed: Array<Record<string, string | number>> = [{ generation: 5 }, { catalogRevision: 4 }, { endpoint: "http://10.0.0.9:8080" }, { state: "PARKED" }, { expiresAt: new Date(NOW + 7_200_000).toISOString() },
      { transportCorrelationId: "22222222-2222-4222-8222-222222222222" }];
    for (const edit of changed) {
      await store.put({ item: { ...web.document, ...edit } });
      expect(await store.transact(fences), JSON.stringify(edit)).toMatchObject({ applied: false });
      await store.put({ item: web.document });
    }
    expect(await store.transact(fences)).toEqual({ applied: true });
  });

  it("throws, never skips, for a selected runtime that is not among the rows read", () => {
    const web = rowDocument("web");
    expect(() => applicationRuntimeRowFences({ rows: [web.row], selected: [{ kind: "api", profileId: PROFILE }] })).toThrow(/not among the runtime rows/);
  });
});

describe("the files of the checks on the object-storage port", () => {
  const objectsOf = () => createDocumentObjectStorage(new MemoryDocumentStore(), { companyId: IMPLICIT_COMPANY_ID });
  const jpeg = (size = 64) => { const bytes = Buffer.alloc(size, 7); bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff; return bytes; };
  const owner = { ownerKey: "developer:maya", workspaceId: "ws-1" };

  it("stores a JPEG under its digest at Cloud's key and skips what is not what it says", async () => {
    const objects = objectsOf();
    const good = jpeg();
    const stored = await storeWorkflowE2EArtifacts({ objects }, owner, [
      { sha256: sha256(good), bytes: good, contentType: "image/jpeg" },
      { sha256: sha256(jpeg(32)), bytes: jpeg(33), contentType: "image/jpeg" },
      { sha256: sha256("not a jpeg"), bytes: Buffer.from("not a jpeg"), contentType: "image/jpeg" },
      { sha256: sha256(jpeg(E2E_DISPLAY_SCREENSHOT_MAX_BYTES + 1)), bytes: jpeg(E2E_DISPLAY_SCREENSHOT_MAX_BYTES + 1), contentType: "image/jpeg" },
      { sha256: sha256(Buffer.alloc(0)), bytes: Buffer.alloc(0), contentType: "image/jpeg" },
    ]);
    expect([...stored]).toEqual([sha256(good)]);
    const key = workflowE2EArtifactKey(owner.ownerKey, owner.workspaceId, sha256(good));
    expect(key).toBe(`private/developer:maya/ws-1/workflow-e2e-artifacts/${sha256(good)}`);
    expect(Buffer.from((await objects.get(key, 1_000))!).equals(good)).toBe(true);
    expect(await objects.stat(key)).toMatchObject({ metadata: { sha256: sha256(good) } });
    // Storing the same bytes again changes nothing and is still stored.
    expect([...await storeWorkflowE2EArtifacts({ objects }, owner, [{ sha256: sha256(good), bytes: good, contentType: "image/jpeg" }])]).toEqual([sha256(good)]);
  });

  it("does not count an object as stored when a different one already holds its key", async () => {
    const objects = objectsOf();
    const good = jpeg();
    await objects.put(workflowE2EArtifactKey(owner.ownerKey, owner.workspaceId, sha256(good)), Buffer.from("something else"), { contentType: "image/jpeg", metadata: {}, retention: "task-document" });
    expect((await storeWorkflowE2EArtifacts({ objects }, owner, [{ sha256: sha256(good), bytes: good, contentType: "image/jpeg" }])).size).toBe(0);
  });

  it("serves a screenshot only when a row of the baseline names it and the stored object is exactly those bytes", async () => {
    const objects = objectsOf();
    const good = jpeg();
    await storeWorkflowE2EArtifacts({ objects }, owner, [{ sha256: sha256(good), bytes: good, contentType: "image/jpeg" }]);
    const task = { ...owner, workflow: {} } as never;
    const baseline = { status: "PASSED", scenarios: [{ screenshotRef: { sha256: sha256(good), bytes: good.byteLength, contentType: "image/jpeg" } }] } as never;
    expect(await loadWorkflowE2EArtifact({ objects }, task, sha256(good))).toBeUndefined();
    expect(Buffer.from((await loadWorkflowE2EArtifact({ objects }, task, sha256(good), { baseline }))!.bytes).equals(good)).toBe(true);
    expect(await loadWorkflowE2EArtifact({ objects }, task, "f".repeat(64), { baseline })).toBeUndefined();
    expect(await loadWorkflowE2EArtifact({ objects }, task, "not-a-digest", { baseline })).toBeUndefined();
    // An object that is the right size and a JPEG but has another digest than the one that names it is not served.
    const other = jpeg(good.byteLength); other[10] = 9;
    await objects.delete(workflowE2EArtifactKey(owner.ownerKey, owner.workspaceId, sha256(good)));
    await objects.put(workflowE2EArtifactKey(owner.ownerKey, owner.workspaceId, sha256(good)), other, { contentType: "image/jpeg", metadata: {}, retention: "e2e-screenshot" });
    expect(await loadWorkflowE2EArtifact({ objects }, task, sha256(good), { baseline })).toBeUndefined();
    // A row that claims other bytes than the object holds is not served.
    const lying = { status: "PASSED", scenarios: [{ screenshotRef: { sha256: sha256(good), bytes: good.byteLength + 1, contentType: "image/jpeg" } }] } as never;
    expect(await loadWorkflowE2EArtifact({ objects }, task, sha256(good), { baseline: lying })).toBeUndefined();
  });

  const admissionRef = (bytes: Buffer, overrides: Record<string, unknown> = {}) => ({ schemaVersion: 1, taskId: "task-1", workflowRevision: 2, candidateDigest: "c".repeat(64), roundId: "r", groupRunIds: [],
    admissionRef: { key: `workflow-e2e-admissions/sha256/${sha256(bytes)}.json`, sha256: sha256(bytes), byteLength: bytes.byteLength, ...overrides } }) as unknown as E2EWorkflowAdmissionRef;

  it("stores an admission under its content address, holds a reader to its reference, and refuses a changed or oversized object", async () => {
    const objects = objectsOf();
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: "workflow-e2e-admission/v2", bundle: { scenarios: [{ steps: [{ kind: "agent" }] }, { steps: [{ kind: "navigate" }] }] }, policy: { modelRouteRevision: "rev-1" } }));
    const ref = admissionRef(bytes);
    await storeWorkflowE2EAdmission({ objects }, { key: ref.admissionRef.key, sha256: ref.admissionRef.sha256, bytes, taskId: "task-1", candidateDigest: "c".repeat(64) });
    // Storing the same admission again is fine; a digest that does not match the bytes is refused before anything is written.
    await storeWorkflowE2EAdmission({ objects }, { key: ref.admissionRef.key, sha256: ref.admissionRef.sha256, bytes, taskId: "task-1", candidateDigest: "c".repeat(64) });
    await expect(storeWorkflowE2EAdmission({ objects }, { key: "workflow-e2e-admissions/sha256/x.json", sha256: "0".repeat(64), bytes, taskId: "t", candidateDigest: "c" })).rejects.toThrow(/digest/);
    expect((await readStoredAdmission({ objects }, ref))?.text).toBe(bytes.toString("utf8"));
    expect(await createWorkflowE2EAdmissionSchemaReader({ objects })(ref)).toBe("workflow-e2e-admission/v2");
    expect(await createWorkflowE2EAdmissionAgentStepsReader({ objects })(ref)).toBe(true);
    expect(await createWorkflowE2EAdmissionNeedsModelFreeLimitsReader({ objects })(ref)).toBe(true);
    // A reference that names another size or digest than the object holds reads as nothing.
    expect(await readStoredAdmission({ objects }, admissionRef(bytes, { byteLength: bytes.byteLength + 1 }))).toBeUndefined();
    expect(await readStoredAdmission({ objects }, admissionRef(bytes, { sha256: "0".repeat(64) }))).toBeUndefined();
    expect(await createWorkflowE2EAdmissionSchemaReader({ objects })(admissionRef(Buffer.from("missing")))).toBeUndefined();
  });

  it("reads an audit replay as needing no agent-steps feature, and an admission that is not JSON as nothing", async () => {
    const objects = objectsOf();
    const replay = Buffer.from(JSON.stringify({ bundle: { scenarios: [{ steps: [{ kind: "agent" }] }] }, replay: {} }));
    const junk = Buffer.from("{ not json");
    for (const bytes of [replay, junk]) await storeWorkflowE2EAdmission({ objects }, { key: `workflow-e2e-admissions/sha256/${sha256(bytes)}.json`, sha256: sha256(bytes), bytes, taskId: "t", candidateDigest: "c" });
    expect(await createWorkflowE2EAdmissionAgentStepsReader({ objects })(admissionRef(replay))).toBe(false);
    expect(await createWorkflowE2EAdmissionAgentStepsReader({ objects })(admissionRef(junk))).toBeUndefined();
    expect(await createWorkflowE2EAdmissionSchemaReader({ objects })(admissionRef(junk))).toBeUndefined();
  });
});
