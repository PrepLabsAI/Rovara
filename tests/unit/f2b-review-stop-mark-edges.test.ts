// F2-B Opus review: the personStop mark must only read Stopped when the blocked step IS the stop's own block (cancel.ts's words), not any block within two revisions.
import { describe, expect, it } from "vitest";
import { WorkflowSnapshotSchema, type WorkflowSnapshot } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { standingFactsOf } from "../../packages/broker/src/core/task-view/index.js";
import { NOW, blockedReview, seed, taskOf } from "../support/task-actions-world.js";

const ownerRule = (): TaskFlowDeps["access"] => ({
  ...createOwnerTaskAccess(),
  canAct: async (principal: { personId: string }) => principal.personId === "local-owner",
  ownerActing: async (principal: { personId: string }, task: { ownerKey: string }) => (principal.personId === "local-owner" ? { actorId: task.ownerKey } : undefined),
});
const wf = (extra: Record<string, unknown>): WorkflowSnapshot => WorkflowSnapshotSchema.parse({ ...blockedReview(), blockReason: undefined, ...extra });

describe("F2-B review: a Stop pressed when nothing ran, then a retry that fails", () => {
  it("a later block for another reason within two revisions is not the person's Stop", async () => {
    // Stop pressed on an idle BLOCKED task at revision 5 (cancelTask: nothingRunning, no workflow change), then Retry (6, RUNNING) fails (7, BLOCKED).
    const world = await seed({ workflow: wf({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: "The fix changed nothing.", revision: 7 }), access: ownerRule(), task: { personStop: { at: NOW, revision: 5 } } });
    expect((await standingFactsOf(world.h.deps, await taskOf(world.h))).stoppedByPerson).toBeUndefined();
  });
  it("a stop that raced the step's own end (review findings at revision + 1) is not read as Stopped over the decision", async () => {
    const world = await seed({ workflow: wf({ stage: "REVIEW", state: "BLOCKED", revision: 6 }), access: ownerRule(), task: { personStop: { at: NOW, revision: 5 } } });
    expect((await standingFactsOf(world.h.deps, await taskOf(world.h))).stoppedByPerson).toBeUndefined();
  });
});
