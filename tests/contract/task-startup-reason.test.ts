import { describe, expect, it } from "vitest";
import { DeveloperTaskDetailedListResponseSchema, DeveloperTaskListDetailSchema, DeveloperTaskViewSchema } from "@agentx/contracts";

const task = { taskId: "11111111-1111-4111-8111-111111111111", title: "t", project: "p", status: "STARTING", shared: false, createdAt: "2026-11-22T00:00:00.000Z", updatedAt: "2026-11-22T00:00:00.000Z", startingRevision: 1, client: "test", events: [] };

describe("DEC 254zzz382 startup reason contract", () => {
  it.each(["own-machine-starting", "unknown"])("accepts %s on a single read and detailed list row", (startupReason) => {
    expect(DeveloperTaskViewSchema.parse({ ...task, startupReason }).startupReason).toBe(startupReason);
    expect(DeveloperTaskDetailedListResponseSchema.parse({ tasks: [{ ...task, startupReason }] }).tasks[0]).toHaveProperty("startupReason", startupReason);
    expect(DeveloperTaskListDetailSchema.parse({ startupReason })).toEqual({ startupReason });
  });

  it("pins exactly two values; named limits need a real admission queue", () => {
    expect(DeveloperTaskViewSchema.shape.startupReason.unwrap().options).toEqual(["own-machine-starting", "unknown"]);
    for (const startupReason of ["daily-limit", "concurrency-limit", "ACCEPTED", "", null, 1]) {
      expect(DeveloperTaskViewSchema.safeParse({ ...task, startupReason }).success).toBe(false);
      expect(DeveloperTaskListDetailSchema.safeParse({ startupReason }).success).toBe(false);
    }
  });

  it("keeps old-server omission optional in both documented responses", () => {
    expect(DeveloperTaskViewSchema.parse(task)).not.toHaveProperty("startupReason");
    expect(DeveloperTaskDetailedListResponseSchema.parse({ tasks: [task] }).tasks[0]).not.toHaveProperty("startupReason");
    expect(DeveloperTaskListDetailSchema.parse({})).toEqual({});
  });
});
