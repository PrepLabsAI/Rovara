// The hosted and local GET task view (developerTaskView) used to spread the stored workflow raw: a reason stored raw must be shown redacted (found by the Sonnet pre-review of REDACT-BLOCK-REASON).
import { describe, expect, it } from "vitest";
import { developerTaskView } from "../../packages/broker/src/core-host/app/task-view.js";
import { taskViewOf } from "../../packages/broker/src/core/task-flow/reads.js";
import { blockedReview, seed, taskOf, TASK_ID } from "../support/task-actions-world.js";

const token = (): string => ["ghp_", "Ab12".repeat(9)].join("");
describe("the task GET view", () => {
  it("shows a reason stored raw redacted", async () => {
    const raw = `Rovara stopped while planning: clone failed https://x-access-token:${token()}@github.com/o/r`;
    const { h } = await seed({ workflow: blockedReview({ stage: "PLAN", state: "BLOCKED", blockReason: raw }) });
    const task = await taskOf(h);
    const view = await taskViewOf(h.deps, task);
    const out = await developerTaskView(task, view, { get: async () => undefined } as never, undefined, undefined, false);
    const shown = (out.workflow as { blockReason?: string }).blockReason;
    expect(shown).not.toContain(token());
    expect(shown).toContain("[REDACTED]");
    expect((await taskOf(h)).workflow?.blockReason).toBe(raw);
    expect(TASK_ID).toBeDefined();
  });
});
