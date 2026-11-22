import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createWorkflowSnapshot, type ObjectStorage, type StoredDocument, type WorkflowSnapshot } from "@agentx/contracts";
import { threadCanvasCloseout, threadDocumentLink, type ThreadDocumentDeps } from "../../packages/broker/src/core-host/thread-documents.js";
import { hostedSlackThreads } from "../../packages/broker/src/aws/slack-thread-channel.js";
import { createTaskPlanCanvas } from "../../packages/broker/src/aws/slack-web.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createFakeWorld, FAKE_COMPANY } from "../support/core-host-fakes.js";

async function world() {
  const fake = createFakeWorld();
  const taskId = randomUUID();
  let bytes = "# Plan\n\nAdd the health endpoint.\n";
  const artifact = { id: "plan-v1", type: "plan" as const, version: 1, producer: "agentx-planner" as const, format: "markdown" as const, objectKey: `private/owner/workspace/plan.md`, sha256: createHash("sha256").update(bytes).digest("hex"), createdAt: new Date(fake.clock.now).toISOString() };
  const workflow = { ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now: artifact.createdAt, definitionVersion: "1.1.0" }), stage: "PLAN_REVIEW", state: "WAITING", revision: 4, artifacts: [artifact] } as WorkflowSnapshot;
  await fake.store.put({ item: JSON.parse(JSON.stringify({ ...taskKey(taskId), entityType: "DEVELOPER_TASK", companyId: FAKE_COMPANY, taskId, workflow })) as StoredDocument });
  const objects = new Map<string, Uint8Array>();
  const blobs: ObjectStorage = { async get(key) { return objects.get(key); }, async put(key, value) { objects.set(key, value); }, async stat() { return undefined; }, async delete() {}, async deletePrefix() { return true; } };
  const create = vi.fn<NonNullable<ThreadDocumentDeps["createPlanCanvas"]>>(async (_company, _tenant, _input, onCreated) => { await onCreated("F0123456789"); return { canvasId: "F0123456789", permalink: "https://example.slack.com/docs/F0123456789" }; });
  const threads = hostedSlackThreads({ workspaces: { requireCompany: async () => FAKE_COMPANY, tokenForCompany: async () => undefined } });
  const deps: ThreadDocumentDeps = { documentFailure: (error) => threads.documentFailure!(error), store: fake.store, blobs, artifacts: { get: async () => new TextEncoder().encode(bytes) }, companyId: FAKE_COMPANY, now: () => fake.clock.now, createPlanCanvas: create };
  const current = async () => (await fake.store.get(taskKey(taskId)))!["workflow"] as unknown as WorkflowSnapshot;
  const link = async () => threadDocumentLink(deps, { taskId, title: "Health" }, await current(), "C0123456789", "T0123456789", "https://app.example/app/sessions/task");
  const deletes: string[] = [];
  const command = { channel: "slack", orgId: FAKE_COMPANY, companyOf: async () => FAKE_COMPANY, now: () => fake.clock.now,
    adapter: { capabilities: { documents: true, threads: true, buttons: 5, edits: true, maxTextLength: 40000, proactive: true }, async command(input: { kind: string; documentId?: string }) { if (input.kind !== "delete_document") throw new Error("unexpected command"); deletes.push(input.documentId!); return { ok: true, result: { deleted: true } }; } } };
  const close = () => threadCanvasCloseout(deps, command, "T0123456789", taskId);
  const terminal = async () => { const task = (await fake.store.get(taskKey(taskId)))!; await fake.store.put({ item: { ...task, closedAt: new Date(fake.clock.now).toISOString() } }); };
  return { fake, deps, taskId, create, current, link, close, terminal, deletes, objects, corrupt: () => { bytes = "changed"; } };
}

describe("core thread plan Canvas port", () => {
  it("records the exact ID before sharing and reuses the same Canvas on a repeat", async () => {
    const w = await world();
    w.create.mockImplementationOnce(async (_company, _tenant, _input, onCreated) => { await onCreated("F0123456789"); expect((await w.current()).canvasLineage?.[0]).toMatchObject({ state: "CREATED", canvasId: "F0123456789" }); return { canvasId: "F0123456789", permalink: "https://example.slack.com/docs/F0123456789" }; });
    expect((await w.link()).url).toContain("slack.com"); await w.link();
    expect(w.create).toHaveBeenCalledTimes(1);
  });
  it("does not publish a document with a mismatched digest", async () => {
    const w = await world(); w.corrupt(); expect(await w.link()).toEqual({}); expect(w.create).not.toHaveBeenCalled();
  });
  it("never duplicates a Canvas whose creation outcome is unknown", async () => {
    const w = await world(); w.create.mockImplementationOnce(async () => createTaskPlanCanvas("test", { channel: "C0123456789", taskId: w.taskId, title: "Plan", version: 1, markdown: "Plan" }, async () => { throw new Error("unanswered"); }));
    await expect(w.link()).rejects.toThrow("unanswered");
    expect((await w.link()).url).toContain("app.example"); expect(w.create).toHaveBeenCalledTimes(1);
    await w.terminal(); expect((await w.close()).status).toBe("ARCHIVE_PENDING"); expect(w.deletes).toEqual([]);
  });
  it("verifies a private manifest before deleting only recorded IDs, and resumes closeout", async () => {
    const w = await world(); await w.link(); await w.terminal();
    expect((await w.close()).status).toBe("COMPLETE");
    expect(w.objects.size).toBe(1); expect(w.deletes).toEqual(["F0123456789"]);
    expect((await w.close()).status).toBe("COMPLETE"); expect(w.deletes).toEqual(["F0123456789"]);
  });
  it("refuses cleanup when the artifact changed, or when the task belongs to another company", async () => {
    const w = await world(); await w.link(); await w.terminal(); w.corrupt();
    expect((await w.close()).status).toBe("ARCHIVE_PENDING"); expect(w.deletes).toEqual([]);
    const task = (await w.fake.store.get(taskKey(w.taskId)))!;
    await w.fake.store.put({ item: { ...task, companyId: "org_bbbbbbbbbbbbbbbbbbbb" } });
    expect((await w.close()).status).toBe("ARCHIVE_PENDING"); expect(w.deletes).toEqual([]);
  });
});
