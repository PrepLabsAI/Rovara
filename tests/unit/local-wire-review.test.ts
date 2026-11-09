// Lane L9-wire, review round 1: the lower-level cases (plan feedback, keys, the state folder lock, the message limit, the start transaction).
import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { PLAN_FEEDBACK_MAX, planFeedbackKey, planFeedbackOf } from "../../packages/broker/src/core/task-flow/stage-machine.js";

const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";

describe("M1: the planner is told the newest changes the owner asked for", () => {
  it("keeps the latest words after more than the cap of send-backs, oldest of the kept first", async () => {
    const store = new MemoryDocumentStore();
    for (let round = 1; round <= PLAN_FEEDBACK_MAX + 5; round += 1) await store.put({ item: { ...planFeedbackKey(TASK, round), entityType: "PLAN_FEEDBACK", text: `change ${round}`, createdAt: "2026-11-09T10:00:00.000Z" } });
    const feedback = await planFeedbackOf({ store }, TASK);
    expect(feedback).toHaveLength(PLAN_FEEDBACK_MAX);
    expect(feedback.at(-1)).toBe(`change ${PLAN_FEEDBACK_MAX + 5}`);
    expect(feedback[0]).toBe("change 6");
    expect(feedback).not.toContain("change 1");
  });
});
