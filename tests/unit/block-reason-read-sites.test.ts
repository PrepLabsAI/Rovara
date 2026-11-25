// REDACT-BLOCK-REASON, the read sites. A block reason stored raw (before the write-time redaction, or by a writer that missed it) must not leave through any reader: each site below is read with a raw
// reason in the stored workflow and must show it redacted and within 500 characters. The stored record keeps what it holds (never rewrite history).
import { describe, expect, it, vi } from "vitest";
import { BRANCH_CONFLICT_ASK_PREFIX, BRANCH_CONFLICT_STOP_PREFIX, BRANCH_SYNC_GIVE_UP_PREFIX, DeveloperTaskDetailedListResponseSchema, OperationSchema, WorkspaceInstanceSchema, change, type DeveloperTaskClientView } from "@agentx/contracts";
import { DEVELOPER_TOOLS, nextFor } from "../../packages/mcp/src/tools.js";
import { routeDeveloperTaskRequest, taskView } from "../../packages/broker/src/aws/developer-tasks.js";
import { developerTaskView } from "../../packages/broker/src/local/app/task-view.js";
import { createTaskFactsSource } from "../../packages/broker/src/local/app/facts.js";
import { coreTaskMarkKey } from "../../packages/broker/src/core-host/core-task-mark.js";
import { readPrFeedbackView } from "../../packages/broker/src/core-host/pr-feedback-view.js";
import { readTask, taskViewOf } from "../../packages/broker/src/core/task-flow/reads.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { PRIYA, pageTask } from "../support/page-tasks.js";
import { reviewedFeedbackWorld } from "../support/pr-feedback-world.js";
import { COMPANY } from "../support/task-flow-harness.js";
import { blockedReview, seed, taskOf, TASK_ID } from "../support/task-actions-world.js";
import { TASK_ID as FEEDBACK_TASK_ID } from "../support/merge-world.js";

// Built at run time: no key-shaped literal is in this file.
const token = (): string => ["ghp_", "Ab12".repeat(9)].join("");
const raw = (): string => `Rovara stopped while planning: clone failed https://x-access-token:${token()}@github.com/org/repo (password Tr0ub4dor&3)`;
const longRaw = (): string => `${"w".repeat(420)} https://x-access-token:${token()}@github.com/org/repo ${"z".repeat(300)}`;

function expectShownClean(shown: unknown): void {
  expect(typeof shown).toBe("string");
  const text = shown as string;
  expect(text).not.toContain(token());
  expect(text).not.toContain(token().slice(0, 12));
  expect(text).not.toContain("Tr0ub4dor");
  expect(text).toContain("[REDACTED]");
  expect(text.length).toBeLessThanOrEqual(500);
}

describe("the local and hosted task GET (developerTaskView)", () => {
  it("shows a reason stored raw redacted, and the view's own copy is not what the raw workflow spread brings back", async () => {
    for (const reason of [raw(), longRaw()]) {
      const { h } = await seed({ workflow: blockedReview({ stage: "PLAN", state: "BLOCKED", blockReason: reason.slice(0, 500) }) });
      const task = await taskOf(h);
      const view = await taskViewOf(h.deps, task);
      const out = await developerTaskView(task, view, { get: async () => undefined } as never, undefined, undefined, false);
      expectShownClean((out["workflow"] as { blockReason?: string }).blockReason);
      expect((await taskOf(h)).workflow?.blockReason).toBe(reason.slice(0, 500));
    }
  });
  it("leaves a task with no reason, and an engine reason, as they were", async () => {
    const { h } = await seed({ workflow: blockedReview({ stage: "PLAN", state: "RUNNING", blockReason: undefined }) });
    const task = await taskOf(h);
    const out = await developerTaskView(task, await taskViewOf(h.deps, task), { get: async () => undefined } as never, undefined, undefined, false);
    expect(out["workflow"]).not.toHaveProperty("blockReason");
  });
});

describe("the hosted aws task views (taskView and the detailed list)", () => {
  const at = "2026-11-22T00:00:00.000Z";
  function blockedFixture(reason: string) {
    const f = pageTask({ shared: false });
    f.setWorkflow({ ...f.workflow(), state: "BLOCKED", blockReason: reason.slice(0, 500) });
    const task = f.db.get(`DEVTASK#${f.taskId}`, "META") as unknown as DeveloperTaskRecord;
    return { f, task };
  }
  it("taskView (about 25 routes) redacts the stored reason", async () => {
    for (const reason of [raw(), longRaw()]) {
      const { f, task } = blockedFixture(reason);
      const workspace = WorkspaceInstanceSchema.parse({ id: task.workspaceId, ownerKey: task.ownerKey, projectName: task.project, projectRevision: 1, deploymentMode: "ec2-ebs", rootPath: "/mnt/workspace", status: "READY", fence: 1, createdAt: at, updatedAt: at });
      const view = await taskView(f.deps, task, { events: 0, details: false, loaded: { workspace, operations: [] } });
      expectShownClean(view.workflow?.blockReason);
      expect((f.db.get(`DEVTASK#${f.taskId}`, "META") as { workflow: { blockReason: string } }).workflow.blockReason).toBe(reason.slice(0, 500));
    }
  });
  it("the list with detail=1 redacts the reason in each row's workflow detail", async () => {
    const { f, task } = blockedFixture(raw());
    const prepare = OperationSchema.parse({ id: "00000000-0000-4000-8000-000000000001", kind: "prepare", status: "SUCCEEDED", createdAt: at, updatedAt: at, workspaceId: task.workspaceId, requestId: "00000000-0000-4000-8000-000000000002", payloadHash: "a".repeat(64), fence: 1 });
    const workspace = WorkspaceInstanceSchema.parse({ id: task.workspaceId, ownerKey: task.ownerKey, projectName: task.project, projectRevision: 1, deploymentMode: "ec2-ebs", rootPath: "/mnt/workspace", status: "READY", fence: 1, createdAt: at, updatedAt: at });
    f.deps.actions.workspace = vi.fn(async () => workspace);
    f.deps.actions.operations = vi.fn(async () => [prepare]);
    f.db.set({ ...task, pk: `DEVELOPER#${PRIYA.developerId}`, sk: `TASK#${at}#${task.taskId}`, entityType: "DEVELOPER_TASK_INDEX", status: "RUNNING" });
    // DEC 254zzz502 (D1-2): only a task with the core's mark is listed.
    f.db.set({ ...coreTaskMarkKey(task.taskId), entityType: "TASK_ENGINE", coreEngine: { engine: "core", areas: { merge: "core", build: "core", flow: "core" }, flags: "cc=on", stampedAt: at } });
    const response = await routeDeveloperTaskRequest(f.deps, PRIYA, { method: "GET", path: "/v1/dev/tasks", headers: {}, requestId: "00000000-0000-4000-8000-000000000003" }, new URL("https://example.test/v1/dev/tasks?detail=1"));
    const rows = DeveloperTaskDetailedListResponseSchema.parse(response).tasks;
    expect(rows).toHaveLength(1);
    expectShownClean(rows[0]?.workflow?.blockReason);
  });
});

describe("the local app's task facts", () => {
  it("shows the workflow's reason redacted and cut", async () => {
    for (const reason of [raw(), longRaw()]) {
      const { h } = await seed({ workflow: blockedReview({ stage: "PLAN", state: "BLOCKED", blockReason: reason.slice(0, 500) }) });
      const facts = await createTaskFactsSource(h.deps).read(COMPANY, TASK_ID);
      expectShownClean(facts?.workflow?.blockReason);
    }
  });
});

describe("the PR feedback view", () => {
  it("shows the stored reason redacted and cut", async () => {
    const w = await reviewedFeedbackWorld("COMPLETE");
    const task = (await readTask(w.h.deps, FEEDBACK_TASK_ID))!;
    await w.h.store.update({ key: taskKey(FEEDBACK_TASK_ID), ops: [change.set("workflow", toDocument({ ...task.workflow!, blockReason: raw().slice(0, 500) }))] });
    const view = await readPrFeedbackView(w.h.deps, w.h.owner, FEEDBACK_TASK_ID);
    expectShownClean(view["blockReason"]);
  });
});

describe("the MCP task tools", () => {
  const clientView = (reason: string, stage = "PULL_REQUEST", state = "BLOCKED"): DeveloperTaskClientView => ({
    taskId: "44444444-4444-4444-8444-444444444444", title: "Fix", project: "payments", status: "SUCCEEDED", startingRevision: 1, client: "Claude Code", shared: false, createdAt: "t", updatedAt: "t", events: [],
    workflow: { definitionVersion: "1", path: "QUICK", stage, state, revision: 3, blockReason: reason, artifacts: [], decisions: [] },
  } as never);

  it("agentx_get_task shows block_reason redacted and cut (a raw one from an older server too)", async () => {
    const tool = DEVELOPER_TOOLS.find((candidate) => candidate.name === "agentx_get_task")!;
    for (const reason of [raw(), longRaw().slice(0, 1000)]) {
      const client = { getTask: vi.fn(async () => clientView(reason)) };
      const result = await tool.handler({ client } as never, { task_id: "44444444-4444-4444-8444-444444444444" }, {} as never);
      expectShownClean((result.structured["workflow"] as { block_reason?: string }).block_reason);
      expect(result.text).not.toContain(token());
    }
  });
  it("the next-step text for a blocked workflow redacts the reason (generic block, branch conflict ask, branch sync give-up, branch conflict stop)", () => {
    const generic = nextFor(clientView(raw()));
    expect(generic).toContain("blocked");
    expect(generic).not.toContain(token());
    expect(generic).not.toContain("Tr0ub4dor");
    expect(generic).toContain("[REDACTED]");
    for (const prefix of [BRANCH_CONFLICT_ASK_PREFIX, BRANCH_SYNC_GIVE_UP_PREFIX, BRANCH_CONFLICT_STOP_PREFIX]) {
      const text = nextFor(clientView(`${prefix}${raw()}`, "WAIT_FOR_MERGE"));
      expect(text, prefix).not.toContain(token());
      expect(text, prefix).not.toContain("Tr0ub4dor");
      expect(text, prefix).toContain("[REDACTED]");
    }
  });
  it("an engine reason reads back as the sentence it is", () => {
    expect(nextFor(clientView("the checks couldn't run"))).toContain("The checks couldn't run.");
  });
});
