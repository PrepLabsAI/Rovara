// The reference a task view carries for the error it shows (what Fix with agent is about): codes and ids only, never text, and none for a task with no error to fix.
import { describe, expect, it } from "vitest";
import { errorRefKey } from "@agentx/contracts";
import { taskViewErrorRef } from "../../packages/broker/src/core/diagnosis/error-ref.js";

const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const OPERATION = "6c1f2f3a-4d5e-4f60-8a71-92b3c4d5e6f7";
const AT = "2026-11-10T10:00:00.000Z";
const base = { taskId: TASK, status: "RUNNING" as const, workflow: undefined, failure: undefined, operationId: undefined, creatorRemoved: false, at: AT };

describe("taskViewErrorRef", () => {

  it("is a failed or interrupted task's category and stage, with the failed operation's id when it is one", () => {
    const failure = { category: "runtime", stage: "plan", message: "the machine was lost" } as never;
    expect(taskViewErrorRef({ ...base, status: "FAILED", failure, operationId: OPERATION })).toMatchObject({ kind: "operation_failed", code: "RUNTIME_PLAN", operationId: OPERATION, subject: { taskId: TASK } });
    expect(taskViewErrorRef({ ...base, status: "INTERRUPTED", failure, operationId: "not-a-uuid" })).toMatchObject({ kind: "operation_failed", code: "RUNTIME_PLAN" });
    expect(taskViewErrorRef({ ...base, status: "INTERRUPTED", failure, operationId: "not-a-uuid" })?.operationId).toBeUndefined();
    expect(errorRefKey(taskViewErrorRef({ ...base, status: "FAILED", failure, operationId: OPERATION })!)).not.toBe(errorRefKey(taskViewErrorRef({ ...base, status: "FAILED", failure })!));
  });

  it("is nothing for a task with no error, one that finished or was closed, or whose creator was removed", () => {
    expect(taskViewErrorRef(base)).toBeUndefined();
    for (const status of ["SUCCEEDED", "CLOSED", "CANCELLED"] as const) expect(taskViewErrorRef({ ...base, status, workflow: { state: "BLOCKED", blockReason: undefined } })).toBeUndefined();
    expect(taskViewErrorRef({ ...base, status: "FAILED", failure: { category: "runtime", message: "x" } as never, creatorRemoved: true })).toBeUndefined();
    expect(taskViewErrorRef({ ...base, status: "FAILED" })).toBeUndefined();
  });
});
