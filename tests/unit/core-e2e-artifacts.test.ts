import { describe, expect, it } from "vitest";
import { buildE2ESharedView, createCandidateManifest, createWorkflowSnapshot, type ObjectStorage } from "@agentx/contracts";
import { createWorkflowE2EDisplayObject, workflowE2EArtifactKey } from "../../packages/broker/src/aws/workflow-e2e-notifier-projection.js";
import { loadStoredScenarioResults, loadWorkflowE2EArtifact, storeWorkflowE2EArtifacts } from "../../packages/broker/src/core/e2e/artifacts.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { failedBaseline, row, SHOT, SHOT_SHA, OTHER_SHOT, OTHER_SHOT_SHA } from "../support/e2e-scenario-results.js";

const AT = "2026-11-21T12:00:00.000Z";
const d = (char: string) => char.repeat(64);
async function world() {
  const store = new MemoryDocumentStore();
  const objects = createDocumentObjectStorage(store, { companyId: "org_00000000000000000000" });
  const workflow = createWorkflowSnapshot({ taskId: "44444444-4444-4444-8444-444444444444", ownerId: d("a"), now: AT });
  workflow.stage = "VERIFY";
  workflow.candidate = createCandidateManifest([{ repositoryId: "example/demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
  const current = { candidateDigest: workflow.candidate.digest, roundId: "11111111-1111-4111-8111-111111111111", groupRunIds: ["22222222-2222-4222-8222-222222222222"], admissionSha256: d("b"), evidenceSha256: d("c") };
  workflow.e2e = { required: true, contractDigest: d("a"), policyDigest: d("b"), bundleDigest: d("c"), executionPlanDigest: d("d"), currentRoundId: current.roundId, currentGroupRunIds: current.groupRunIds, resultRefs: [] };
  const task = { ownerKey: "owner", workspaceId: "workspace", workflow };
  const display = createWorkflowE2EDisplayObject({ ...task, current, capturedAt: AT, view: buildE2ESharedView({ plan: null, currentRound: null, results: [], setup: null, actor: "viewer" }),
    scenarioResults: { scenarios: [row({ screenshotRef: { sha256: SHOT_SHA, bytes: SHOT.byteLength, contentType: "image/jpeg" } })] } })!;
  await objects.put(display.ref.key, display.bytes, { contentType: "application/json", metadata: {}, retention: "task-document" });
  task.workflow.e2e!.displayRef = display.ref;
  return { objects, task, current };
}

describe("core E2E artifacts", () => {
  it("serves only JPEGs named by the current display, and a stored unknown digest stays unavailable", async () => {
    const w = await world();
    const kept = await storeWorkflowE2EArtifacts(w, w.task, [{ sha256: SHOT_SHA, bytes: SHOT, contentType: "image/jpeg" }, { sha256: OTHER_SHOT_SHA, bytes: OTHER_SHOT, contentType: "image/jpeg" }]);
    expect(kept.size).toBe(2);
    expect(await loadWorkflowE2EArtifact(w, w.task, SHOT_SHA)).toEqual({ contentType: "image/jpeg", bytes: new Uint8Array(SHOT) });
    expect(await loadWorkflowE2EArtifact(w, w.task, OTHER_SHOT_SHA)).toBeUndefined();
    expect(await loadWorkflowE2EArtifact(w, w.task, "../other-owner")).toBeUndefined();
  });

  it("retains baseline screenshots during coding when the candidate display is suppressed", async () => {
    const w = await world();
    await storeWorkflowE2EArtifacts(w, w.task, [{ sha256: OTHER_SHOT_SHA, bytes: OTHER_SHOT, contentType: "image/jpeg" }]);
    w.task.workflow.stage = "IMPLEMENT";
    expect(await loadStoredScenarioResults(w, w.task)).toBeUndefined();
    expect(await loadWorkflowE2EArtifact(w, w.task, OTHER_SHOT_SHA, { baseline: failedBaseline() })).toEqual({ contentType: "image/jpeg", bytes: new Uint8Array(OTHER_SHOT) });
  });

  it("refuses a changed JPEG even if its length and magic bytes still match", async () => {
    const w = await world();
    await storeWorkflowE2EArtifacts(w, w.task, [{ sha256: SHOT_SHA, bytes: SHOT, contentType: "image/jpeg" }]);
    const changed = Uint8Array.from(SHOT);
    changed[changed.length - 1] = 0;
    const original = w.objects.get.bind(w.objects);
    const objects: ObjectStorage = { ...w.objects, get: (key, max) => key === workflowE2EArtifactKey(w.task.ownerKey, w.task.workspaceId, SHOT_SHA) ? Promise.resolve(changed) : original(key, max) };
    expect(await loadWorkflowE2EArtifact({ objects }, w.task, SHOT_SHA)).toBeUndefined();
  });

  it("does not replace conflicting content or store bytes under a false digest", async () => {
    const w = await world();
    await w.objects.put(workflowE2EArtifactKey(w.task.ownerKey, w.task.workspaceId, SHOT_SHA), OTHER_SHOT, { contentType: "image/jpeg", metadata: {}, retention: "e2e-screenshot" });
    expect(await storeWorkflowE2EArtifacts(w, w.task, [{ sha256: SHOT_SHA, bytes: SHOT, contentType: "image/jpeg" }, { sha256: d("f"), bytes: OTHER_SHOT, contentType: "image/jpeg" }])).toEqual(new Set());
    expect(await loadWorkflowE2EArtifact(w, w.task, SHOT_SHA)).toBeUndefined();
  });

  it("rejects a stale display before reading private objects", async () => {
    const w = await world();
    w.task.workflow.e2e!.currentRoundId = "33333333-3333-4333-8333-333333333333";
    let reads = 0;
    const objects: ObjectStorage = { ...w.objects, get: async () => { reads += 1; return undefined; } };
    expect(await loadStoredScenarioResults({ objects }, w.task)).toBeUndefined();
    expect(reads).toBe(0);
  });
});

it("does not read private history for a closed task without a recorded outcome", async () => {
  const w = await world(); let reads = 0;
  const objects: ObjectStorage = { ...w.objects, get: async (...args) => { reads++; return w.objects.get(...args); } };
  expect(await loadStoredScenarioResults({ objects }, { ...w.task, closedAt: AT })).toBeUndefined();
  expect(reads).toBe(0);
});
