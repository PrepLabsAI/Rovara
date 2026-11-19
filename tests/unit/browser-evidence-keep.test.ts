// TE-H1 slice 2 (DEC 241): keeping browser evidence in the pack, and reading it back. A run with no browser evidence is the pack it always was (byte for byte, version 1); a run with it is a v2 pack with the `visual` check and its
// pairs, whose pictures live under the task and are served only when the CURRENT pack names them; the v1 view never shows a picture as a passed check; and a keep that writes no pack leaves no picture behind.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  EvidencePackV2Schema, browserEvidenceLines, browserEvidenceOutcomeOfPack, type BrowserEvidenceCaptured, type CheckEntry, type EvidencePackV2,
} from "../../packages/contracts/src/index.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentEvidenceBlobStore } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { evidenceArtifactKey, readEvidenceArtifact } from "../../packages/broker/src/core/proof/evidence-artifacts.js";
import { evidencePackKey, keepEvidence, loadEvidencePack, loadEvidenceRead, type KeepEvidenceDeps } from "../../packages/broker/src/core/proof/evidence-keep.js";
import { eraseTaskEvidence } from "../../packages/broker/src/core/proof/evidence-erase.js";
import { createLocalEvidence } from "../../packages/broker/src/local/app/evidence.js";
import { proofReportOf } from "../../packages/broker/src/local/app/proof-report.js";
import { scanTextForTests } from "../support/evidence-scan.js";

import { createWorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { IMPLICIT_COMPANY_ID, MODEL_HOSTS_ALLOWED_BY_SETTING_SENTENCE, encodeBrowserEvidenceUpload } from "@agentx/contracts";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { fromDocument, type OperationRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { handleBrowserEvidenceUpload } from "../../packages/broker/src/core/proof/browser-evidence-upload.js";

const DIGEST = "c".repeat(64);
const TASK = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: "task-1" };
const OP = "op-1";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const jpeg = (seed: string) => { const bytes = new Uint8Array(500); bytes.set([0xff, 0xd8, 0xff]); bytes.fill(seed.charCodeAt(0), 3); return bytes; };
const shot = (seed: string) => ({ bytes: jpeg(seed), sha256: sha(jpeg(seed)) });
const captured = (): BrowserEvidenceCaptured => ({ isolation: "sandbox", durationMs: 3_000, notShown: [], moreNotShown: 0,
  routes: [{ route: "/checkout", status: "shown", before: shot("a"), after: shot("b"), consoleErrors: { before: 0, after: 0 } }, { route: "/settings", status: "not_run", reason: "page_did_not_load" }] });
const entry = (id: string, label: string): CheckEntry => ({ id, label, source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 700, exitCode: 0 });

function world() {
  const blobs = createDocumentEvidenceBlobStore(new MemoryDocumentStore(), { companyId: "org_00000000000000000000" });
  const actions: KeepEvidenceDeps["actions"] = { async artifacts() { return []; }, async readArtifact() { return ""; } };
  const deps = { scan: scanTextForTests, actions, store: { blobs } } satisfies KeepEvidenceDeps;
  return { deps, blobs };
}
const input = (over: Record<string, unknown> = {}) => ({ orgId: "org-a", task: TASK, operationId: OP, candidateDigest: DIGEST, checks: [entry("readiness:0", "pytest -q")], ...over });
const storedPack = async (blobs: ReturnType<typeof world>["blobs"]) => JSON.parse(Buffer.from((await blobs.get(evidencePackKey(TASK, DIGEST), 4_194_304))!).toString("utf8")) as EvidencePackV2;
const held = (blobs: ReturnType<typeof world>["blobs"], seed: string) => blobs.get(evidenceArtifactKey(TASK.ownerKey, TASK.workspaceId, TASK.taskId, shot(seed).sha256), 1_000);

describe("keeping browser evidence", () => {
  it("absent: the pack is exactly the version 1 pack it always was", async () => {
    const without = world();
    await keepEvidence(without.deps, input());
    const pack = JSON.parse(Buffer.from((await without.blobs.get(evidencePackKey(TASK, DIGEST), 4_194_304))!).toString("utf8")) as { schemaVersion: number; checks: unknown[] };
    expect(pack.schemaVersion).toBe(1);
    expect(JSON.stringify(pack)).not.toContain("browser_evidence");
    const explicit = world();
    await keepEvidence(explicit.deps, input({ browserEvidence: undefined }));
    expect(Buffer.from((await explicit.blobs.get(evidencePackKey(TASK, DIGEST), 4_194_304))!).toString("utf8")).toBe(Buffer.from((await without.blobs.get(evidencePackKey(TASK, DIGEST), 4_194_304))!).toString("utf8"));
  });

  it("present: a v2 pack with the visual check, its pairs and its not-run rows, and the pictures stored under the task", async () => {
    const w = world();
    expect(await keepEvidence(w.deps, input({ browserEvidence: captured() }))).toMatchObject({ kept: true });
    const pack = await storedPack(w.blobs);
    expect(pack.schemaVersion).toBe(2);
    expect(EvidencePackV2Schema.safeParse(pack).success).toBe(true);
    expect(pack.producer).toEqual({ edition: "code", isolation: "sandbox" });
    const check = pack.checks.find((entry) => entry.id === "browser_evidence");
    expect(check).toMatchObject({ kind: "visual", runBy: "rovara", stage: "sandbox", class: "not_rerun" });
    expect(check?.pairs).toEqual([{ id: "/checkout", before: { kind: "jpeg", sha256: shot("a").sha256, bytes: 500, retentionClass: "evidence-std" }, after: { kind: "jpeg", sha256: shot("b").sha256, bytes: 500, retentionClass: "evidence-std" } }]);
    expect(pack.notTested.some((row) => row.what === "Browser evidence: /settings" && row.reason === "Not run: the page did not load")).toBe(true);
    expect(await held(w.blobs, "a")).toBeDefined();
    expect(await held(w.blobs, "b")).toBeDefined();
    // The project's own check is untouched, and the result is still the checks' own (a picture never moves it).
    expect(pack.checks.find((entry) => entry.id === "readiness:0")).toMatchObject({ after: "passed" });
    expect(pack.result).toBe("verified");
  });

  it("is read as the outcome the pull request's lines come from, and the v1 view never shows a picture as a passed check", async () => {
    const w = world();
    await keepEvidence(w.deps, input({ browserEvidence: captured() }));
    const read = await loadEvidenceRead(w.blobs, TASK, DIGEST);
    expect(read?.status).toBe("v2");
    const outcome = browserEvidenceOutcomeOfPack(read?.status === "v2" ? read.pack : undefined, DIGEST);
    expect(browserEvidenceLines(outcome, {})).toEqual([
      "Browser evidence: Run by Rovara in its sandbox. Visual evidence only: it does not count as change proof.",
      "- `/checkout`: before and after screenshots (on the task page, behind sign-in)",
      "- `/settings`: Not run: the page did not load",
    ]);
    const v1 = await loadEvidencePack(w.blobs, TASK, DIGEST);
    expect(v1?.checks.map((check) => check.checkId)).toEqual(["readiness:0"]);
    expect(JSON.stringify(v1)).not.toContain(shot("a").sha256);
    // The proof page's rows come from the v1 view: no row for the picture.
    const report = proofReportOf({ taskId: "t", title: "T", workspaceId: TASK.workspaceId } as never, { revision: 1 } as never, v1);
    expect(report.rows.map((row) => row.claim)).not.toContain("Browser evidence");
  });

  it("a run the check refuses stores nothing and the pack is the plain version 1 pack", async () => {
    const w = world();
    const bad = captured();
    const first = bad.routes[0];
    if (first?.status === "shown") first.before = { ...first.before, bytes: new Uint8Array(600_000) };
    expect(await keepEvidence(w.deps, input({ browserEvidence: bad }))).toMatchObject({ kept: true });
    expect((await storedPack(w.blobs)).schemaVersion).toBe(1);
    expect(await held(w.blobs, "a")).toBeUndefined();
  });

  it("erasing the task's evidence takes the pictures and the pack with it (every v2 reader and the eraser are in place before a v2 pack can exist)", async () => {
    const w = world();
    await keepEvidence(w.deps, input({ browserEvidence: captured() }));
    expect(await held(w.blobs, "a")).toBeDefined();
    expect(await eraseTaskEvidence(w.blobs, TASK)).toBe(true);
    expect(await held(w.blobs, "a")).toBeUndefined();
    expect(await held(w.blobs, "b")).toBeUndefined();
    expect(await w.blobs.get(evidencePackKey(TASK, DIGEST), 4_194_304)).toBeUndefined();
  });

  it("a keep that writes no pack leaves no picture behind", async () => {
    const w = world();
    let calls = 0;
    // The pack is the last write; the caller's time has run out just before it.
    expect(await keepEvidence({ ...w.deps, late: () => { calls += 1; return calls >= 2; } }, input({ browserEvidence: captured() }))).toEqual({ kept: false, reason: "fault" });
    expect(await held(w.blobs, "a")).toBeUndefined();
    expect(await held(w.blobs, "b")).toBeUndefined();
    expect(await w.blobs.get(evidencePackKey(TASK, DIGEST), 4_194_304)).toBeUndefined();
    // A pack that fails to be written does the same.
    const failing = world();
    const broken = { ...failing.blobs, async put(key: string, bytes: Uint8Array, meta: Parameters<typeof failing.blobs.put>[2], options?: Parameters<typeof failing.blobs.put>[3]) { if (key.includes("/evidence-pack/")) throw new Error("disk full"); return failing.blobs.put(key, bytes, meta, options); } };
    expect(await keepEvidence({ ...failing.deps, store: { blobs: broken } }, input({ browserEvidence: captured() }))).toEqual({ kept: false, reason: "fault" });
    expect(await held(failing.blobs, "a")).toBeUndefined();
  });

  it("a re-keep of the same code that fails does not delete pictures the earlier pack of that code names", async () => {
    const w = world();
    expect(await keepEvidence(w.deps, input({ browserEvidence: captured() }))).toMatchObject({ kept: true });
    let calls = 0;
    expect(await keepEvidence({ ...w.deps, late: () => { calls += 1; return calls >= 2; } }, input({ browserEvidence: captured() }))).toEqual({ kept: false, reason: "fault" });
    // The earlier pack is still there and its pictures are still served.
    expect(await held(w.blobs, "a")).toBeDefined();
    expect(await held(w.blobs, "b")).toBeDefined();
    expect((await storedPack(w.blobs)).checks.some((check) => check.id === "browser_evidence")).toBe(true);
  });

  it("a v2 writer that names another place than the outcome keeps the pack without the picture check, and the pictures go", async () => {
    const w = world();
    const laptop = { version: 2 as const, producer: { edition: "code" as const, isolation: "developer_machine" as const } };
    expect(await keepEvidence(w.deps, input({ browserEvidence: captured(), writer: laptop }))).toMatchObject({ kept: true });
    const pack = await storedPack(w.blobs);
    expect(pack.checks.some((check) => check.id === "browser_evidence")).toBe(false);
    expect(await held(w.blobs, "a")).toBeUndefined();
  });
});

describe("serving the pictures", () => {
  const read = async (w: ReturnType<typeof world>, sha256: string, over: { candidateDigest?: string | undefined; omitPack?: boolean; taskId?: string } = {}) => {
    const v2 = await loadEvidenceRead(w.blobs, TASK, DIGEST);
    return readEvidenceArtifact({ store: { blobs: w.blobs }, authorize: async () => ({ ...TASK, taskId: over.taskId ?? TASK.taskId, candidateDigest: "candidateDigest" in over ? over.candidateDigest : DIGEST, view: undefined, ...(v2?.status === "v2" && over.omitPack !== true ? { v2Pack: v2.pack } : {}) }) }, sha256);
  };
  it("serves a pair's picture inline as a JPEG, and nothing the current pack does not name", async () => {
    const w = world();
    await keepEvidence(w.deps, input({ browserEvidence: captured() }));
    const answer = await read(w, shot("a").sha256);
    expect(answer).toMatchObject({ status: 200, kind: "jpeg", contentType: "image/jpeg", disposition: "inline" });
    expect(await read(w, sha(jpeg("z")))).toEqual({ status: 404 });
    expect(await read(w, shot("a").sha256, { candidateDigest: "d".repeat(64) })).toEqual({ status: 404 });
    expect(await read(w, shot("a").sha256, { candidateDigest: undefined })).toEqual({ status: 404 });
    expect(await read(w, shot("a").sha256, { omitPack: true })).toEqual({ status: 404 });
    // The key names the task: another task's pack does not reach this task's object.
    expect(await read(w, shot("a").sha256, { taskId: "task-2" })).toEqual({ status: 404 });
  });
  it("is closed to a company other than the task's: the page's own check (a task of another company is not found) is the reader's, and the blob store is partitioned by company", async () => {
    const documents = new MemoryDocumentStore();
    const a = createDocumentEvidenceBlobStore(documents, { companyId: "org_00000000000000000000" });
    const b = createDocumentEvidenceBlobStore(documents, { companyId: "org_11111111111111111111" });
    await keepEvidence({ scan: scanTextForTests, actions: { async artifacts() { return []; }, async readArtifact() { return ""; } }, store: { blobs: a } }, input({ browserEvidence: captured() }));
    expect(await b.get(evidenceArtifactKey(TASK.ownerKey, TASK.workspaceId, TASK.taskId, shot("a").sha256), 1_000)).toBeUndefined();
    expect(await loadEvidenceRead(b, TASK, DIGEST)).toBeUndefined();
  });
});

describe("the local evidence reads", () => {
  it("gives the panel, the lines and the pictures for exactly this code, and nothing for another's", async () => {
    const documents = new MemoryDocumentStore();
    const blobs = createDocumentEvidenceBlobStore(documents, { companyId: "org_00000000000000000000" });
    await keepEvidence({ scan: scanTextForTests, actions: { async artifacts() { return []; }, async readArtifact() { return ""; } }, store: { blobs } }, input({ browserEvidence: captured() }));
    const evidence = createLocalEvidence({ flow: { store: documents, companyId: "org_00000000000000000000" }, blobs: blobs });
    const panel = await evidence.browserEvidencePanelOf(TASK, DIGEST);
    expect(panel?.pairs).toEqual([{ route: "/checkout", before: shot("a").sha256, after: shot("b").sha256 }]);
    expect(await evidence.browserEvidencePanelOf(TASK, "d".repeat(64))).toBeUndefined();
    expect(await evidence.browserEvidencePanelOf(TASK, undefined)).toBeUndefined();
    expect(await evidence.browserEvidenceLinesOf(TASK, DIGEST, {})).toHaveLength(3);
    expect(await evidence.browserEvidenceLinesOf(TASK, "d".repeat(64), {})).toEqual([]);
    expect(await evidence.browserEvidenceImageOf(TASK, DIGEST, shot("b").sha256)).toMatchObject({ status: 200, kind: "jpeg" });
    expect(await evidence.browserEvidenceImageOf(TASK, "d".repeat(64), shot("b").sha256)).toEqual({ status: 404 });
    // No browser evidence, no panel: a task with a v1 pack.
    const plain = createDocumentEvidenceBlobStore(new MemoryDocumentStore(), { companyId: "org_00000000000000000000" });
    await keepEvidence({ scan: scanTextForTests, actions: { async artifacts() { return []; }, async readArtifact() { return ""; } }, store: { blobs: plain } }, input());
    expect(await createLocalEvidence({ flow: { store: documents, companyId: "org_00000000000000000000" }, blobs: plain }).browserEvidencePanelOf(TASK, DIGEST)).toBeUndefined();
  });
});


it("keeps H1 evidence for the task's own company and follows its thin workspace pointer", async () => {
  const companyId = "org_bbbbbbbbbbbbbbbbbbbb";
  const h = createHarness({ companyId });
  await h.registerProject();
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Show checkout" });
  const task = (await readTask(h.deps, started.task.taskId))!;
  const key = workspaceKey(task.companyId, task.workspaceId);
  const base = fromDocument<OperationRecord>((await h.store.query({ pk: key.pk, sk: { op: "beginsWith", prefix: "OPERATION#" } })).items[0])!;
  const operation: OperationRecord = { ...base, kind: "task", workflowMode: "CHECKS", status: "RUNNING", dispatch: { ...base.dispatch, payload: { browserEvidence: { startCommand: "npm start", port: 4321, routes: [{ path: "/checkout", files: ["src/**"] }] } } } };
  const workspace = (await h.store.get(key))!;
  await h.store.put({ item: { ...workspace, machine: { machineId: "own-machine", machineKey: "own" } } });
  await h.store.put({ item: { ...workspace, ...workspaceKey(IMPLICIT_COMPANY_ID, task.workspaceId), companyId: IMPLICIT_COMPANY_ID, orgId: IMPLICIT_COMPANY_ID, machine: { machineId: "other-machine", machineKey: "other" } } });
  const blobs = createDocumentEvidenceBlobStore(h.store, { companyId });
  const bytes = Buffer.from(encodeBrowserEvidenceUpload(captured()));
  const digest = sha(bytes);
  const stores = { store: h.store, objects: blobs };
  const init = await handleBrowserEvidenceUpload(stores, operation, { stage: "init", totalBytes: bytes.length, chunkCount: 1, sha256: digest });
  await handleBrowserEvidenceUpload(stores, operation, { stage: "chunk", uploadId: init["uploadId"], index: 0, bytesBase64: bytes.toString("base64"), sha256: digest });
  await handleBrowserEvidenceUpload(stores, operation, { stage: "finalize", uploadId: init["uploadId"], sha256: digest });
  const sandboxModelHostsOf = vi.fn(async () => "allowed" as const);
  const evidence = createLocalEvidence({ flow: { store: h.store, companyId: IMPLICIT_COMPANY_ID }, blobs, sandboxModelHostsOf });
  expect(await evidence.keepAfterChecks({ task, operation, workflow: createWorkflowSnapshot({ taskId: task.taskId, ownerId: "a".repeat(64), now: new Date().toISOString() }), candidateDigest: DIGEST, checks: [entry("readiness:0", "pytest -q")] })).toMatchObject({ kept: true });
  expect(sandboxModelHostsOf).toHaveBeenCalledExactlyOnceWith("own-machine");
  const read = await loadEvidenceRead(blobs, task, DIGEST);
  expect(read?.status).toBe("v2");
  expect(JSON.stringify(read)).toContain(MODEL_HOSTS_ALLOWED_BY_SETTING_SENTENCE);
  expect((await evidence.browserEvidencePanelOf(task, DIGEST))?.pairs[0]).toMatchObject({ route: "/checkout" });
});
