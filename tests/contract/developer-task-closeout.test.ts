import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runTaskCanvasCloseout, type CanvasCloseoutStore, type TaskCanvasCloseoutTask } from "../../packages/broker/src/aws/developer-task-closeout.js";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const bytes1 = "# Plan one\n";
const bytes2 = "# Plan two\n";
const artifact1 = { id: "plan-1", type: "plan" as const, version: 1, sha256: createHash("sha256").update(bytes1).digest("hex"),
  producer: "agentx", objectKey: `private/${taskId}/plan-1.md`, createdAt: "2026-10-05T12:00:00.000Z" };
const artifact2 = { ...artifact1, id: "plan-2", version: 2, sha256: createHash("sha256").update(bytes2).digest("hex"), objectKey: `private/${taskId}/plan-2.md` };
const task: TaskCanvasCloseoutTask = {
  taskId, closedAt: "2026-10-05T13:00:00.000Z",
  workflow: { taskId, revision: 4, stage: "CLOSED", state: "COMPLETE", outcome: "CLOSED", updatedAt: "2026-10-05T13:00:00.000Z", artifacts: [artifact1, artifact2],
    canvasLineage: [
      { key: "PLAN:2:plan-1", stage: "PLAN_REVIEW", workflowRevision: 2, artifactId: "plan-1", artifactRef: artifact1.objectKey,
        artifactDigest: artifact1.sha256, state: "CREATED", canvasId: "F12345678", permalink: "https://acme.slack.com/docs/T123/F12345678", createdAt: artifact1.createdAt },
      { key: "PLAN:3:plan-2", stage: "PLAN_REVIEW", workflowRevision: 3, artifactId: "plan-2", artifactRef: artifact2.objectKey,
        artifactDigest: artifact2.sha256, state: "CREATED", canvasId: "F22345678", permalink: "https://acme.slack.com/docs/T123/F22345678", createdAt: artifact2.createdAt },
    ] },
};

function storeFor(input: TaskCanvasCloseoutTask = task, options: { artifactBytes?: Map<string, string>; persistFails?: boolean; manifestWriteUncertain?: boolean } = {}) {
  let saved: TaskCanvasCloseoutTask = structuredClone(input);
  let manifest: { key: string; digest: string; bytes: string } | undefined;
  const calls: string[] = [];
  const state: Record<string, "deleted" | "unknown"> = {};
  let failedManifestWrite = false;
  const store: CanvasCloseoutStore = {
    async loadTask() { return structuredClone(saved); },
    async readArtifact(ref) { return options.artifactBytes === undefined
      ? ref.objectKey === artifact1.objectKey ? bytes1 : ref.objectKey === artifact2.objectKey ? bytes2 : undefined
      : options.artifactBytes.get(ref.objectKey); },
    async readManifest(key) { return manifest?.key === key ? manifest.bytes : undefined; },
    async putManifest(key, digest, bytes) {
      calls.push(`manifest:${digest}`);
      if (manifest?.digest !== undefined && manifest.digest !== digest) throw new Error("immutable manifest collision");
      manifest = { key, digest, bytes };
      if (options.manifestWriteUncertain && !failedManifestWrite) { failedManifestWrite = true; throw new Error("write outcome unknown"); }
    },
    async saveCloseout(_taskId, closeout, expectedRevision) {
      if (options.persistFails || saved.workflow?.revision !== expectedRevision) return false;
      const workflow = { ...saved.workflow };
      delete workflow.canvasCloseoutAttempt;
      saved = { ...saved, workflow: { ...workflow, canvasCloseout: structuredClone(closeout) } };
      calls.push("checkpoint"); return true;
    },
    async saveCloseoutAttempt(_taskId, attempt, expectedRevision) {
      if (saved.workflow?.revision !== expectedRevision) return false;
      saved = { ...saved, workflow: { ...saved.workflow, canvasCloseoutAttempt: structuredClone(attempt) } };
      calls.push(`attempt:${attempt.reason}`); return true;
    },
    async deleteCanvas(canvasId) { calls.push(`delete:${canvasId}`); return state[canvasId] === "unknown" ? "unknown" : "deleted"; },
    now: () => "2026-10-05T14:00:00.000Z",
  };
  return { store, calls, get saved() { return structuredClone(saved); }, get manifest() { return manifest; }, state };
}

describe("verified Slack Canvas closeout", () => {
  it("stores and verifies one immutable manifest before deleting every versioned Canvas", async () => {
    const h = storeFor();
    await expect(runTaskCanvasCloseout(h.store, { taskId })).resolves.toMatchObject({ status: "COMPLETE" });
    expect(h.calls[0]).toBe("attempt:manifest_preparation_pending");
    expect(h.calls[1]).toMatch(/^manifest:/);
    expect(h.calls.filter((call) => call.startsWith("delete:"))).toEqual(["delete:F12345678", "delete:F22345678"]);
    expect(h.manifest?.bytes).toContain("F12345678");
    expect(h.manifest?.bytes).toContain(artifact1.sha256);
    expect(h.saved.workflow?.canvasCloseout?.canvases.map((canvas) => canvas.status)).toEqual(["DELETED", "DELETED"]);
  });

  it("does not write a manifest or delete anything when an artifact is missing or altered", async () => {
    const missing = storeFor(task, { artifactBytes: new Map([[artifact1.objectKey, bytes1]]) });
    await expect(runTaskCanvasCloseout(missing.store, { taskId })).resolves.toMatchObject({ status: "ARCHIVE_PENDING" });
    expect(missing.calls.filter((call) => call.startsWith("delete:"))).toEqual([]);
    expect(missing.saved.workflow?.canvasCloseoutAttempt).toMatchObject({ reason: "artifact_unavailable", workflowRevision: 4 });
    const altered = storeFor(task, { artifactBytes: new Map([[artifact1.objectKey, "tampered"], [artifact2.objectKey, bytes2]]) });
    await expect(runTaskCanvasCloseout(altered.store, { taskId })).resolves.toMatchObject({ status: "ARCHIVE_PENDING" });
    expect(altered.calls.filter((call) => call.startsWith("delete:"))).toEqual([]);
  });

  it("rejects nonterminal tasks and unresolved Canvas creation intents without inferring IDs", async () => {
    const waiting = storeFor({ taskId, workflow: { ...task.workflow!, stage: "WAIT_FOR_MERGE", state: "WAITING" } });
    await expect(runTaskCanvasCloseout(waiting.store, { taskId })).resolves.toMatchObject({ status: "ARCHIVE_PENDING" });
    expect(waiting.calls.filter((call) => call.startsWith("delete:"))).toEqual([]);
    const unresolved = storeFor({ ...task, workflow: { ...task.workflow!, canvasLineage: [{ ...task.workflow!.canvasLineage![0]!, state: "CREATE_OUTCOME_UNKNOWN" }, task.workflow!.canvasLineage![1]!] } });
    await expect(runTaskCanvasCloseout(unresolved.store, { taskId })).resolves.toMatchObject({ status: "ARCHIVE_PENDING" });
    expect(unresolved.calls.filter((call) => call.startsWith("delete:"))).toEqual([]);
  });

  it("rejects lineage whose source reference or digest does not match the canonical workflow artifact", async () => {
    const invalid = storeFor({ ...task, workflow: { ...task.workflow!, canvasLineage: task.workflow!.canvasLineage!.map((entry, index) =>
      index === 0 ? { ...entry, artifactDigest: "f".repeat(64) } : entry) } });
    await expect(runTaskCanvasCloseout(invalid.store, { taskId })).resolves.toMatchObject({ status: "ARCHIVE_PENDING", reason: "canvas_artifact_binding_failed" });
    expect(invalid.calls.filter((call) => call.startsWith("delete:"))).toEqual([]);
  });

  it("resumes a partial delete after service recreation and reuses the same manifest", async () => {
    const h = storeFor();
    let interrupted = false;
    h.store.deleteCanvas = async (canvasId) => {
      if (!interrupted && canvasId === "F22345678") { interrupted = true; throw new Error("timeout"); }
      h.calls.push(`delete:${canvasId}`);
      return "deleted";
    };
    await expect(runTaskCanvasCloseout(h.store, { taskId })).resolves.toMatchObject({ status: "ARCHIVE_PENDING" });
    const manifestCount = h.calls.filter((call) => call.startsWith("manifest:")).length;
    const resumed = await runTaskCanvasCloseout(h.store, { taskId });
    expect(resumed.status).toBe("COMPLETE");
    expect(h.calls.filter((call) => call.startsWith("manifest:")).length).toBe(manifestCount);
    expect(h.calls.filter((call) => call === "delete:F12345678")).toHaveLength(1);
  });

  it("keeps canvas_not_found unknown and retryable because Slack does not prove absence", async () => {
    const h = storeFor();
    h.store.deleteCanvas = async () => "unknown";
    const result = await runTaskCanvasCloseout(h.store, { taskId });
    expect(result.status).toBe("ARCHIVE_PENDING");
    expect(h.saved.workflow).toMatchObject({ stage: "CLOSED", state: "COMPLETE", outcome: "CLOSED" });
    expect(h.saved.workflow?.canvasCloseout?.canvases.every((canvas) => canvas.status === "UNKNOWN" && canvas.errorCategory === "canvas_not_found")).toBe(true);
    const retry = await runTaskCanvasCloseout(h.store, { taskId });
    expect(retry.status).toBe("ARCHIVE_PENDING");
    expect(h.saved.workflow?.canvasCloseout?.status).toBe("ARCHIVE_PENDING");
    expect(h.saved.workflow?.canvasCloseout?.canvases.every((canvas) => canvas.status === "UNKNOWN" && canvas.errorCategory === "canvas_not_found")).toBe(true);
  });

  it("fences an owner re-drive to the exact persisted manifest digest", async () => {
    const h = storeFor();
    const first = await runTaskCanvasCloseout(h.store, { taskId });
    expect(first.status).toBe("COMPLETE");
    const pendingTask = { ...h.saved, workflow: { ...h.saved.workflow!, canvasCloseout: {
      ...h.saved.workflow!.canvasCloseout!, status: "ARCHIVE_PENDING" as const,
      completedAt: undefined,
      canvases: h.saved.workflow!.canvasCloseout!.canvases.map((canvas) => ({ ...canvas, status: "UNKNOWN" as const })),
    } } };
    const pending = storeFor(pendingTask);
    const result = await runTaskCanvasCloseout(pending.store, { taskId, expectedManifestDigest: "f".repeat(64) });
    expect(result).toMatchObject({ status: "ARCHIVE_PENDING", reason: "manifest_binding_changed" });
    expect(pending.calls).toEqual([]);
  });

  it("does not delete when the manifest pointer cannot be durably saved", async () => {
    const h = storeFor(task, { persistFails: true });
    await expect(runTaskCanvasCloseout(h.store, { taskId })).resolves.toMatchObject({ status: "ARCHIVE_PENDING" });
    expect(h.calls.filter((call) => call.startsWith("delete:"))).toEqual([]);
    expect(h.saved.workflow?.canvasCloseoutAttempt).toMatchObject({ reason: "manifest_pointer_write_failed", candidateManifestDigest: expect.any(String) as string });
  });

  it("reuses the exact manifest after an S3 write succeeds but its outcome is lost", async () => {
    const h = storeFor(task, { manifestWriteUncertain: true });
    await expect(runTaskCanvasCloseout(h.store, { taskId })).resolves.toMatchObject({ status: "ARCHIVE_PENDING" });
    const digest = h.saved.workflow?.canvasCloseoutAttempt?.candidateManifestDigest;
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(h.calls.filter((call) => call.startsWith("delete:"))).toEqual([]);
    const retried = await runTaskCanvasCloseout(h.store, { taskId, expectedManifestDigest: digest });
    expect(retried.status).toBe("COMPLETE");
    expect(h.calls.filter((call) => call.startsWith("manifest:")).map((call) => call.slice("manifest:".length))).toEqual([digest, digest]);
  });
});
