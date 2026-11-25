// REDACT-BLOCK-REASON scopes 1 and 2. A task's block reason is redacted when it is written (the planning stop, the design review's planning stop, a worker's recorded end) and again when it is read
// (the task view, the task list, the pull request feedback view, the local app's facts, the MCP task and its next-step text). A reason stored before this change is redacted at read; the stored record is
// never rewritten. The words the engine writes itself pass through every one of these unchanged.
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_BLOCK_REASONS, WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE, WORKFLOW_HISTORY_REWRITTEN_MESSAGE, WORKFLOW_LEFTOVER_PROCESSES_MESSAGE,
  WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE, WORKFLOW_NO_CODE_CHANGE_MESSAGE, WORKFLOW_PULL_REQUEST_UPDATE_WORKER_OUTDATED, WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE, WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE,
  WORKFLOW_SETUP_CHANGED_FILES_MESSAGE, ROVARA_AI_PAUSED_MESSAGE, redactBlockReason, redactText, change,
} from "@agentx/contracts";
import { designResolveOutcome } from "../../packages/broker/src/core/design-review/resolve-run.js";
import { onOperationEnded } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { recordOperationResult, readOperation } from "../../packages/broker/src/core/task-flow/results.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { blockedReview, operationsOf, seed, seedPlain, taskOf, TASK_ID, WORKSPACE_ID } from "../support/task-actions-world.js";

// Built at run time: no key-shaped literal is in this file.
const token = (): string => ["ghp_", "Ab12".repeat(9)].join("");
const PASSWORD = "Tr0ub4dor&3";
const dirty = (): string => `git fetch failed for https://x-access-token:${token()}@github.com/org/repo (password ${PASSWORD})`;

function expectClean(text: string | undefined): void {
  expect(text).toBeDefined();
  expect(text).not.toContain(token());
  expect(text).not.toContain(token().slice(0, 12));
  expect(text).not.toContain(PASSWORD);
  expect(text).toContain("[REDACTED]");
}

describe("the block reason is redacted when it is written", () => {
  it("the planning stop (stage machine) stores the worker's error redacted", async () => {
    const { h } = await seedPlain({ first: "FAILED" });
    const operation = (await operationsOf(h))[0]!;
    await h.store.update({ key: taskKey(TASK_ID), ops: [change.set("workflow", toDocument(blockedReview({ stage: "PLAN", state: "RUNNING", blockReason: undefined })))] });
    await onOperationEnded(h.deps, { ...operation, workflowMode: "PLAN", workflowRevision: 6 }, { status: "FAILED", error: dirty() });
    const stored = (await taskOf(h)).workflow?.blockReason;
    expectClean(stored);
    expect(stored).toMatch(/^Rovara stopped while planning: git fetch failed for https:\/\/\[REDACTED\]@github\.com/u);
  });

  it("the reading stop says 'reading the request' with the same redaction", async () => {
    const { h } = await seedPlain({ first: "FAILED" });
    const operation = (await operationsOf(h))[0]!;
    await h.store.update({ key: taskKey(TASK_ID), ops: [change.set("workflow", toDocument(blockedReview({ stage: "UNDERSTAND", state: "RUNNING", blockReason: undefined })))] });
    await onOperationEnded(h.deps, { ...operation, workflowMode: "UNDERSTAND", workflowRevision: 6 }, { status: "FAILED", error: dirty() });
    const stored = (await taskOf(h)).workflow?.blockReason;
    expectClean(stored);
    expect(stored).toMatch(/^Rovara stopped while reading the request: /u);
  });

  it("redacts before it cuts: a secret that straddles the 500th character does not survive as a half", async () => {
    const { h } = await seedPlain({ first: "FAILED" });
    const operation = (await operationsOf(h))[0]!;
    await h.store.update({ key: taskKey(TASK_ID), ops: [change.set("workflow", toDocument(blockedReview({ stage: "PLAN", state: "RUNNING", blockReason: undefined })))] });
    // "Rovara stopped while planning: " is 31 characters; the secret starts at character 480, so a cut at 500 would keep its first 20.
    await onOperationEnded(h.deps, { ...operation, workflowMode: "PLAN", workflowRevision: 6 }, { status: "FAILED", error: `${"x".repeat(449)} ${token()} tail` });
    const stored = (await taskOf(h)).workflow?.blockReason ?? "";
    expect(stored.length).toBeLessThanOrEqual(500);
    expect(stored).not.toContain("ghp_");
    expect(stored).not.toContain(token().slice(4, 16));
  });

  it("keeps the words of an error that holds no secret as they were, still cut to 500", async () => {
    const { h } = await seedPlain({ first: "FAILED" });
    const operation = (await operationsOf(h))[0]!;
    await h.store.update({ key: taskKey(TASK_ID), ops: [change.set("workflow", toDocument(blockedReview({ stage: "PLAN", state: "RUNNING", blockReason: undefined })))] });
    const error = `MODEL_NOT_ALLOWED: The selected model is unavailable. ${"y".repeat(600)}`;
    await onOperationEnded(h.deps, { ...operation, workflowMode: "PLAN", workflowRevision: 6 }, { status: "FAILED", error });
    expect((await taskOf(h)).workflow?.blockReason).toBe(`Rovara stopped while planning: ${error}`.slice(0, 500));
  });

  it("the design review's planning stop (resolve run) stores the worker's error redacted and cut", async () => {
    const { h } = await seed({ workflow: blockedReview({ stage: "PLAN", state: "RUNNING", blockReason: undefined }) });
    const task = await taskOf(h) as Parameters<typeof designResolveOutcome>[2];
    const operation = (await operationsOf(h))[0] ?? ({ id: "op" } as never);
    const ports = { keySpend: async () => 0, closeKeys: async () => undefined };
    const next = await designResolveOutcome(h.deps, {} as never, task, operation, { status: "FAILED", error: dirty() }, "2026-11-25T10:00:00.000Z", ports);
    expect(next.state).toBe("BLOCKED");
    expectClean(next.blockReason);
    expect(next.blockReason).toMatch(/^Rovara stopped while planning: /u);
    const long = await designResolveOutcome(h.deps, {} as never, task, operation, { status: "FAILED", error: `${"z".repeat(470)} ${token()}` }, "2026-11-25T10:00:00.000Z", ports);
    expect((long.blockReason ?? "").length).toBeLessThanOrEqual(500);
    expect(long.blockReason).not.toContain("ghp_");
  });

  it("a worker's recorded end stores its error redacted at ingest, as it is sent to every reader of the operation", async () => {
    const { h } = await seedPlain({ first: "running" });
    const operation = (await operationsOf(h))[0]!;
    await recordOperationResult(h.deps, { workspaceId: WORKSPACE_ID, operationId: operation.id, fence: operation.fence, status: "FAILED", error: dirty() });
    const stored = (await readOperation(h.deps, WORKSPACE_ID, operation.id))?.error;
    expectClean(stored);
    expect(stored).toMatch(/^git fetch failed for /u);
  });

  it("an end whose words are the engine's own is stored exactly as sent (markers other code matches with includes)", async () => {
    const { h } = await seedPlain({ first: "running" });
    const operation = (await operationsOf(h))[0]!;
    const sent = `${WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE} (msg_0123456789abcdefghij, msg_abcdefghij0123456789)`;
    await recordOperationResult(h.deps, { workspaceId: WORKSPACE_ID, operationId: operation.id, fence: operation.fence, status: "FAILED", error: sent });
    expect((await readOperation(h.deps, WORKSPACE_ID, operation.id))?.error).toBe(sent);
  });
});

describe("the block reason is redacted when it is read", () => {
  it("the task view shows a reason stored raw redacted, and the stored record keeps what it holds", async () => {
    const raw = `Rovara stopped while planning: ${dirty()}`;
    const { h, caller } = await seed({ workflow: blockedReview({ stage: "PLAN", state: "BLOCKED", blockReason: raw }) });
    const view = await h.flow.get(caller, TASK_ID);
    expectClean(view.workflow?.blockReason);
    // (The task list rows carry no workflow reason; the detailed list is read in block-reason-read-sites.test.ts.)
    // Never rewrite history: the stored workflow still holds the raw words.
    expect((await taskOf(h)).workflow?.blockReason).toBe(raw);
  });

  it("the engine's own reasons read back unchanged", async () => {
    const { h, caller } = await seed({ workflow: blockedReview({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.fixChangedNothing }) });
    expect((await h.flow.get(caller, TASK_ID)).workflow?.blockReason).toBe(WORKFLOW_BLOCK_REASONS.fixChangedNothing);
  });
});

describe("redactBlockReason", () => {
  it("redacts, then cuts only when asked to", () => {
    expect(redactBlockReason(dirty())).not.toContain(token());
    expect(redactBlockReason(`${"a".repeat(600)} ${token()}`, 500).length).toBe(500);
    expect(redactBlockReason(`${"a".repeat(480)} ${token()}`, 500)).not.toContain("ghp_");
  });
  it("is the identity on every sentence the engine writes, so equality checks on stored reasons are unaffected", () => {
    const words: string[] = [
      ...Object.values(WORKFLOW_BLOCK_REASONS), WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE, WORKFLOW_HISTORY_REWRITTEN_MESSAGE, WORKFLOW_LEFTOVER_PROCESSES_MESSAGE,
      WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE, WORKFLOW_NO_CODE_CHANGE_MESSAGE, WORKFLOW_PULL_REQUEST_UPDATE_WORKER_OUTDATED, WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE, WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE,
      WORKFLOW_SETUP_CHANGED_FILES_MESSAGE, ROVARA_AI_PAUSED_MESSAGE,
    ].filter((value): value is string => typeof value === "string");
    expect(words.length).toBeGreaterThan(20);
    for (const sentence of words) expect(redactText(sentence), sentence).toBe(sentence);
  });
});
