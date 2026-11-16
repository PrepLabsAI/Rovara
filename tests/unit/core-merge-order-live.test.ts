// MR3b (TE-R3, the live half): the merge order reads the dependency facts TE-MR2 recorded for the task's code, from the evidence the broker keeps. Rovara never merges by itself (owner decision 1);
// only a person overrides the order (DEC 209). The facts are kept beside the pack, under the task's own evidence prefix, bound to the candidate digest and to the company (the blob store's own key).
import { describe, expect, it } from "vitest";
import { type CheckEntry } from "../../packages/contracts/src/index.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentEvidenceBlobStore } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { evidencePackKey, keepEvidence, loadRepositoryEdges, repositoryEdgesKey, type KeepEvidenceDeps } from "../../packages/broker/src/core/proof/evidence-keep.js";
import { eraseTaskEvidence } from "../../packages/broker/src/core/proof/evidence-erase.js";
import { createRepositoryEdgesSeam, createTaskRepositoryEdgesSeam, mergeOrderOf, prepareMerge, pressMerge, type MergeTask } from "../../packages/broker/src/core/merge/index.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { ORG, TASK_ID, mergeWorld } from "../support/merge-world.js";
import { scanTextForTests } from "../support/evidence-scan.js";

const DIGEST = "c".repeat(64);
const OTHER = "e".repeat(64);
const TASK = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: "task-1" };
const OP = "op-1";
const PREFIX = `private/${TASK.ownerKey}/${TASK.workspaceId}/${OP}/`;
const entry = (id: string, label: string): CheckEntry => ({ id, label, source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 700, exitCode: 0 });
const edge = (consumer: string, provider: string, language = "node", source = "both") => ({ consumer, provider, language, source });
const rawOf = (extra: Record<string, unknown> = {}, digest = DIGEST) => ({ schemaVersion: 1, candidateDigest: digest, checks: [{ checkId: "readiness:0", outputTail: "ok" }], selection: { method: "full", selected: 1, total: 1 }, ...extra });
const input = (over: Record<string, unknown> = {}) => ({ orgId: COMPANY_A.orgId, task: TASK, operationId: OP, candidateDigest: DIGEST, checks: [entry("readiness:0", "pytest -q")], ...over });

/** One document store shared by two companies' blob stores, and the worker's raw file served through the broker's artifact listing. */
function world(rawText: string | undefined, documents = new MemoryDocumentStore(), companyId: string = COMPANY_A.orgId) {
  const blobsOf = (companyId: string) => createDocumentEvidenceBlobStore(documents, { companyId });
  const blobs = blobsOf(companyId);
  const actions: KeepEvidenceDeps["actions"] = {
    async artifacts() { return rawText === undefined ? [] : [{ name: "evidence-raw.json", objectKey: `${PREFIX}evidence-raw.json` }]; },
    async readArtifact(key, max) { return key.startsWith(PREFIX) && rawText !== undefined ? rawText.slice(0, max) : ""; },
  };
  const marked: string[] = [];
  const deps: KeepEvidenceDeps = { scan: scanTextForTests, markStored: async (orgId) => { marked.push(orgId); }, actions, store: { blobs } };
  const keys = async (companyId: string): Promise<string[]> => (await documents.query({ pk: `ORG#${companyId}#EVIDENCE_BLOB` })).items.map((item) => item.sk as string).sort();
  return { documents, blobs, blobsOf, deps, marked, keys };
}
const edgesRecord = (edges: unknown[], notes: string[] = []) => ({ repositoryEdges: { edges, notes } });

describe("keeping the repository edges beside the pack", () => {
  it("keeps the edges for exactly this code, under the task's evidence prefix, and reads them back", async () => {
    const w = world(JSON.stringify(rawOf(edgesRecord([edge("app", "payments-lib")]))));
    expect(await keepEvidence(w.deps, input())).toMatchObject({ kept: true });
    expect(repositoryEdgesKey(TASK, DIGEST)).toBe(`private/owner-1/ws-1/evidence-pack/task-1/${DIGEST}.repository-edges.json`);
    expect(await loadRepositoryEdges(w.blobs, TASK, DIGEST)).toEqual({ kind: "edges", edges: [{ consumer: "app", provider: "payments-lib" }] });
    // Other code, another task and a malformed digest have none: facts never carry over to code they were not recorded for.
    expect(await loadRepositoryEdges(w.blobs, TASK, OTHER)).toEqual({ kind: "none" });
    expect(await loadRepositoryEdges(w.blobs, { ...TASK, taskId: "task-2" }, DIGEST)).toEqual({ kind: "none" });
    expect(await loadRepositoryEdges(w.blobs, TASK, "../../etc")).toEqual({ kind: "unreadable" });
    expect(await loadRepositoryEdges(w.blobs, TASK, "abc")).toEqual({ kind: "unreadable" });
    expect(await loadRepositoryEdges(w.blobs, { ...TASK, taskId: "bad id/with slash" }, DIGEST)).toEqual({ kind: "unreadable" });
    // The org is marked before the first object is stored (an erase never skips an org that holds evidence).
    expect(w.marked.length).toBeGreaterThan(0);
  });

  it("changes nothing for a raw file with no edges or an empty record: the same objects as before", async () => {
    const plain = world(JSON.stringify(rawOf()));
    await keepEvidence(plain.deps, input());
    const empty = world(JSON.stringify(rawOf(edgesRecord([], ["ambiguous"]))));
    await keepEvidence(empty.deps, input());
    const keysA = await plain.keys(COMPANY_A.orgId);
    expect(keysA.some((key) => key.includes("repository-edges"))).toBe(false);
    expect(await empty.keys(COMPANY_A.orgId)).toEqual(keysA);
    expect(await loadRepositoryEdges(plain.blobs, TASK, DIGEST)).toEqual({ kind: "none" });
  });

  it("keeps nothing for a raw file of other code", async () => {
    const other = world(JSON.stringify(rawOf(edgesRecord([edge("app", "lib")]), OTHER)));
    expect(await keepEvidence(other.deps, input())).toEqual({ kept: false, reason: "not_bound" });
    expect(await loadRepositoryEdges(other.blobs, TASK, DIGEST)).toEqual({ kind: "none" });
    expect(await loadRepositoryEdges(other.blobs, TASK, OTHER)).toEqual({ kind: "none" });
  });

  it("a fault while keeping the edges never fails the keep and leaves no facts", async () => {
    const w = world(JSON.stringify(rawOf(edgesRecord([edge("app", "lib")]))));
    const logged: string[] = [];
    const failing = { ...w.blobs, put: async (key: string, bytes: Uint8Array, meta: Parameters<typeof w.blobs.put>[2], options?: Parameters<typeof w.blobs.put>[3]) => { if (key.includes("repository-edges")) throw new Error("disk full secret-canary"); await w.blobs.put(key, bytes, meta, options); } };
    const result = await keepEvidence({ ...w.deps, store: { blobs: failing }, log: (event, fields) => { logged.push(`${event}:${JSON.stringify(fields)}`); } }, input());
    expect(result).toMatchObject({ kept: true });
    expect(logged.some((line) => line.startsWith("evidence.repository_edges_not_kept"))).toBe(true);
    expect(logged.join("\n")).not.toContain("secret-canary");
    expect(await loadRepositoryEdges(w.blobs, TASK, DIGEST)).toEqual({ kind: "none" });
  });

  it("keeps nothing after the callback's time ran out, and marks the org before the first object is stored", async () => {
    const w = world(JSON.stringify(rawOf(edgesRecord([edge("app", "lib")]))));
    await keepEvidence({ ...w.deps, late: () => true }, input());
    expect(await loadRepositoryEdges(w.blobs, TASK, DIGEST)).toEqual({ kind: "none" });
    // The order of the writes: the org is marked before the edges are stored.
    const events: string[] = [];
    const recording = { ...w.blobs, put: async (key: string, bytes: Uint8Array, meta: Parameters<typeof w.blobs.put>[2], options?: Parameters<typeof w.blobs.put>[3]) => { events.push(key.includes("repository-edges") ? "edges" : "other"); await w.blobs.put(key, bytes, meta, options); } };
    await keepEvidence({ ...w.deps, markStored: async () => { events.push("marked"); }, store: { blobs: recording } }, input());
    expect(events.indexOf("marked")).toBeLessThan(events.indexOf("edges"));
    expect(events.indexOf("marked")).toBe(0);
  });

  it("reads a kept record that cannot be trusted as unreadable, never as no facts", async () => {
    const w = world(undefined);
    const put = (text: string) => w.blobs.put(repositoryEdgesKey(TASK, DIGEST), Buffer.from(text, "utf8"), { contentType: "application/json", metadata: {}, retention: "evidence-std" }, { overwrite: true });
    const good = { schemaVersion: 1, candidateDigest: DIGEST, edges: [{ consumer: "app", provider: "lib", language: "node", source: "both" }] };
    for (const text of [
      "not json", "[]", JSON.stringify({ ...good, schemaVersion: 2 }), JSON.stringify({ ...good, candidateDigest: OTHER }), JSON.stringify({ ...good, extra: true }),
      JSON.stringify({ ...good, edges: [{ consumer: "app", provider: "app", language: "node", source: "both" }] }), JSON.stringify({ ...good, edges: [{ consumer: "bad\n", provider: "lib", language: "node", source: "both" }] }),
      JSON.stringify({ ...good, edges: [{ consumer: "app", provider: "lib", language: "rust", source: "both" }] }), JSON.stringify({ ...good, edges: [good.edges[0], good.edges[0]] }),
      JSON.stringify({ ...good, edges: Array.from({ length: 65 }, (_, index) => ({ consumer: `a${String(index)}`, provider: "lib", language: "node", source: "both" })) }),
    ]) {
      await put(text);
      expect(await loadRepositoryEdges(w.blobs, TASK, DIGEST), text.slice(0, 40)).toEqual({ kind: "unreadable" });
    }
    await put(JSON.stringify(good));
    expect(await loadRepositoryEdges(w.blobs, TASK, DIGEST)).toEqual({ kind: "edges", edges: [{ consumer: "app", provider: "lib" }] });
    // A record too large to read is unreadable, not absent.
    await put(JSON.stringify({ ...good, padding: "x".repeat(200_000) }));
    expect(await loadRepositoryEdges(w.blobs, TASK, DIGEST)).toEqual({ kind: "unreadable" });
    // A store that throws is unreadable.
    expect(await loadRepositoryEdges({ get: async () => { throw new Error("down"); }, stat: async () => undefined }, TASK, DIGEST)).toEqual({ kind: "unreadable" });
  });

  it("is erased with the task's evidence (it lives under the same prefix as the pack)", async () => {
    const w = world(JSON.stringify(rawOf(edgesRecord([edge("app", "lib")]))));
    await keepEvidence(w.deps, input());
    expect(await w.blobs.get(evidencePackKey(TASK, DIGEST), 1_000_000)).toBeDefined();
    expect(await eraseTaskEvidence(w.blobs, TASK)).toBe(true);
    expect(await loadRepositoryEdges(w.blobs, TASK, DIGEST)).toEqual({ kind: "none" });
  });
});

describe("two companies", () => {
  it("company B never reads company A's edges, even for the same owner, workspace, task and code", async () => {
    const w = world(JSON.stringify(rawOf(edgesRecord([edge("app", "lib")]))));
    await keepEvidence(w.deps, input());
    expect(await loadRepositoryEdges(w.blobsOf(COMPANY_A.orgId), TASK, DIGEST)).toMatchObject({ kind: "edges" });
    expect(await loadRepositoryEdges(w.blobsOf(COMPANY_B.orgId), TASK, DIGEST)).toEqual({ kind: "none" });
    expect(await w.keys(COMPANY_B.orgId)).toEqual([]);
  });
});

describe("the seam over a task flow's records", () => {
  const record = (companyId: string) => ({ ...taskKey(TASK_ID), entityType: "DEVELOPER_TASK", taskId: TASK_ID, companyId, ownerKey: TASK.ownerKey, workspaceId: TASK.workspaceId });
  const task = (orgId: string): MergeTask => ({ taskId: TASK_ID, orgId: orgId as never, project: "web", startingRevision: 1, workspaceId: "ws-1", ownerId: "o", ownerName: "n", workflow: { candidate: { digest: DIGEST } } as never });

  it("finds a task's evidence from its own record, and refuses a record of another company", async () => {
    const w = world(JSON.stringify(rawOf(edgesRecord([edge("app", "lib")]))));
    await keepEvidence(w.deps, input({ task: { ...TASK, taskId: TASK_ID } }));
    await w.documents.put({ item: record(COMPANY_A.orgId) as never });
    const seam = createTaskRepositoryEdgesSeam({ flow: { store: w.documents }, blobs: w.blobs, companyId: COMPANY_A.orgId as never });
    expect(await seam(task(COMPANY_A.orgId))).toEqual([{ consumer: "app", provider: "lib" }]);
    // The same task id with a record of company B: company A's seam does not place it, so it does not read.
    await w.documents.put({ item: record(COMPANY_B.orgId) as never });
    await expect(seam(task(COMPANY_A.orgId))).rejects.toThrow();
    // A task with no record at all is unreadable too.
    await w.documents.delete({ key: taskKey(TASK_ID) });
    await expect(seam(task(COMPANY_A.orgId))).rejects.toThrow();
  });
});

describe("the merge-order seam", () => {
  const taskOf = (over: Partial<MergeTask> = {}): MergeTask => ({
    taskId: TASK_ID, orgId: COMPANY_A.orgId as never, project: "web", startingRevision: 1, workspaceId: "ws-1", ownerId: "owner-1", ownerName: "Priya",
    workflow: { candidate: { digest: DIGEST } } as never, ...over,
  });
  const located = (task: MergeTask) => (task.taskId === TASK_ID ? { ownerKey: TASK.ownerKey, workspaceId: TASK.workspaceId } : undefined);
  const seamFor = (blobs: ReturnType<typeof world>["blobs"], companyId: string = COMPANY_A.orgId) => createRepositoryEdgesSeam({ blobs, companyId: companyId as never, locate: async (task) => located(task) });
  const kept = async (w: ReturnType<typeof world>) => { await keepEvidence(w.deps, input({ task: { ...TASK, taskId: TASK_ID } })); };

  it("answers the kept facts for the task's current code, no facts when none were recorded, and refuses what it cannot read", async () => {
    const w = world(JSON.stringify(rawOf(edgesRecord([edge("app", "payments-lib")]))));
    await kept(w);
    const seam = seamFor(w.blobs);
    expect(await seam(taskOf())).toEqual([{ consumer: "app", provider: "payments-lib" }]);
    // No candidate on the workflow, or none recorded for it: no facts (today's order).
    expect(await seam(taskOf({ workflow: {} as never }))).toBeUndefined();
    expect(await seam(taskOf({ workflow: { candidate: { digest: OTHER } } as never }))).toBeUndefined();
    // A task that cannot be placed (unknown to the host) is unreadable, never "no facts".
    await expect(seam(taskOf({ taskId: "99999999-9999-4999-8999-999999999999" }))).rejects.toThrow();
    // The facts feed the order.
    expect(mergeOrderOf(["app", "payments-lib"], await seam(taskOf()))).toMatchObject({ kind: "dependencies", repositories: ["payments-lib", "app"] });
  });

  it("refuses another company's task and another company's facts", async () => {
    const w = world(JSON.stringify(rawOf(edgesRecord([edge("app", "payments-lib")]))));
    await kept(w);
    // A seam of company B over A's evidence reads nothing from A; a task that carries A's id is refused by a seam of company B.
    expect(await seamFor(w.blobsOf(COMPANY_B.orgId), COMPANY_B.orgId)(taskOf({ orgId: COMPANY_B.orgId as never }))).toBeUndefined();
    await expect(seamFor(w.blobs, COMPANY_B.orgId)(taskOf())).rejects.toThrow();
    await expect(seamFor(w.blobs)(taskOf({ orgId: undefined }))).rejects.toThrow();
  });

  it("is the merge's dependency source: the library merges first, and an unreadable record refuses until a person overrides", async () => {
    const w = world(JSON.stringify(rawOf(edgesRecord([edge("app", "payments-lib")]))), new MemoryDocumentStore(), ORG);
    await keepEvidence(w.deps, input({ orgId: ORG, task: { ...TASK, taskId: TASK_ID } }));
    const merge = await mergeWorld({ pullRequests: [{ repositoryId: "app", number: 1 }, { repositoryId: "payments-lib", number: 1 }] });
    await merge.seedTracking();
    await merge.setWorkflow({ candidate: { digest: DIGEST } });
    merge.deps.repositoryEdges = createRepositoryEdgesSeam({ blobs: w.blobs, companyId: ORG, locate: async (task) => located(task) });
    const prepared = await merge.prepare();
    expect(prepared.mergeOrder).toEqual(["payments-lib", "app"]);
    expect((await pressMerge(merge.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: merge.proofFor(prepared) })).status).toBe("MERGED");
    // An unreadable record is "no safe order" until a person confirms.
    const broken = await mergeWorld({ pullRequests: [{ repositoryId: "app", number: 1 }, { repositoryId: "payments-lib", number: 1 }] });
    await broken.seedTracking();
    await broken.setWorkflow({ candidate: { digest: DIGEST } });
    await w.blobs.put(repositoryEdgesKey({ ...TASK, taskId: TASK_ID }, DIGEST), Buffer.from("garbage"), { contentType: "application/json", metadata: {}, retention: "evidence-std" }, { overwrite: true });
    broken.deps.repositoryEdges = createRepositoryEdgesSeam({ blobs: w.blobs, companyId: ORG, locate: async (task) => located(task) });
    await expect(broken.prepare()).rejects.toMatchObject({ code: "MERGE_NOT_READY" });
    const overridden = await prepareMerge(broken.deps, { taskId: TASK_ID, requestId: broken.requestId(), orderOverride: true });
    expect(overridden.orderOverride).toBe(true);
  });
});
