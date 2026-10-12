import { describe, expect, it } from "vitest";
import { taskGraphDigest, type TaskGraphV1 } from "@agentx/contracts";
import { assertWorkflowDependencyResumeTree, executeSerialWorkflowDependencies } from "../../packages/worker/src/workflow-dependencies.js";

const taskId = "8c330a74-b4c6-4f01-9356-5fe54fc55b19";
const operationId = "8c330a74-b4c6-4f01-9356-5fe54fc55b20";
const runId = "8c330a74-b4c6-4f01-9356-5fe54fc55b21";
const graph: TaskGraphV1 = {
  schemaVersion: 1, taskId, version: 1,
  items: [
    { id: "11111111-1111-4111-8111-111111111111", title: "Base", description: "Build base.", repository: "repo", dependsOn: [] },
    { id: "22222222-2222-4222-8222-222222222222", title: "Page", description: "Build page.", repository: "repo", dependsOn: ["11111111-1111-4111-8111-111111111111"] },
    { id: "33333333-3333-4333-8333-333333333333", title: "Docs", description: "Update docs.", repository: "repo", dependsOn: [] },
  ],
};
const initialTree = "a".repeat(40);
const candidate = (digit: string) => digit.repeat(40);

describe("executeSerialWorkflowDependencies", () => {
  it("rejects a retry whose current workspace tree differs from its retained checkpoint", () => {
    expect(() => assertWorkflowDependencyResumeTree(initialTree, "f".repeat(40))).toThrow(/workspace changed since the retained ordered-work checkpoint/);
    expect(() => assertWorkflowDependencyResumeTree(initialTree, initialTree)).not.toThrow();
  });

  it("runs topologically one at a time and binds each item to the previous tree", async () => {
    const calls: Array<{ id: string; base: string; predecessors: string[] }> = [];
    const progress: unknown[] = [];
    const result = await executeSerialWorkflowDependencies({
      graph, graphDigest: taskGraphDigest(graph), runId, operationId, initialTreeSha: initialTree,
      now: () => "2026-10-12T12:00:00.000Z",
      persist: async (entry) => { progress.push(entry); },
      execute: async (item, context) => {
        calls.push({ id: item.id, base: context.baseTreeSha, predecessors: context.predecessorOutcomes.map((entry) => entry.itemId) });
        return { treeSha: candidate(String(calls.length + 1)) };
      },
    });
    expect(calls.map((call) => call.id)).toEqual([
      "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333",
    ]);
    expect(calls.map((call) => call.base)).toEqual([initialTree, candidate("2"), candidate("3")]);
    expect(calls[1]?.predecessors).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(result.finalTreeSha).toBe(candidate("4"));
    expect(progress).toHaveLength(6);
  });

  it("pauses the whole graph when an item fails, including later independent work", async () => {
    const calls: string[] = [];
    const progress: Array<{ state: string; itemId: string }> = [];
    await expect(executeSerialWorkflowDependencies({
      graph, graphDigest: taskGraphDigest(graph), runId, operationId, initialTreeSha: initialTree,
      now: () => "2026-10-12T12:00:00.000Z",
      persist: async (entry) => { progress.push(entry); },
      execute: async (item) => {
        calls.push(item.id);
        if (item.title === "Page") throw new Error("model stopped before a result");
        return { treeSha: candidate("2") };
      },
    })).rejects.toThrow("paused after an uncertain item");
    expect(calls).toEqual(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
    expect(progress.at(-1)).toMatchObject({ state: "UNKNOWN", itemId: "22222222-2222-4222-8222-222222222222" });
  });

  it("does not start an item when its STARTED checkpoint cannot be persisted", async () => {
    let executed = false;
    await expect(executeSerialWorkflowDependencies({
      graph, graphDigest: taskGraphDigest(graph), runId, operationId, initialTreeSha: initialTree,
      now: () => "2026-10-12T12:00:00.000Z",
      persist: async () => { throw new Error("callback unavailable"); },
      execute: async () => { executed = true; return { treeSha: candidate("2") }; },
    })).rejects.toThrow("callback unavailable");
    expect(executed).toBe(false);
  });
});
