// Port lane P2, review M2: a project whose external check names a provider nothing in this release runs is refused at task start with a clear sentence, before any machine; and if one still gets to the
// dispatcher the operation FAILS with the sentence instead of throwing and being redelivered until its attempts run out.
import { describe, expect, it } from "vitest";
import { UNRUNNABLE_EXTERNAL_CHECK_MESSAGE, type ProjectDefinition } from "@agentx/contracts";
import { createTaskFlow } from "../../packages/broker/src/core/task-flow/index.js";
import type { ProjectRevision } from "../../packages/broker/src/core/task-flow/deps.js";
import { operationKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createHarness, newRequestId, type Harness } from "../support/task-flow-harness.js";

const OTHER = { provider: "examplebuild", name: "q", reference: "pipeline/1", timeoutMinutes: 10 };
const withUnrunnable = (revision: ProjectRevision | undefined): ProjectRevision | undefined => revision === undefined ? undefined : {
  ...revision, definition: { ...revision.definition, repositories: revision.definition.repositories.map((repository) => ({ ...repository, externalChecks: [OTHER] })) } as ProjectDefinition,
};

/** A flow over a project source that answers the bad project for the revisions named. */
function flowOver(h: Harness, bad: { latest: boolean; revision: boolean }) {
  const real = h.deps.projects;
  const projects = {
    latest: async (name: string) => (bad.latest ? withUnrunnable : (value: ProjectRevision | undefined) => value)(await real.latest(name)),
    revision: async (name: string, revision: number) => (bad.revision ? withUnrunnable : (value: ProjectRevision | undefined) => value)(await real.revision(name, revision)),
  };
  return createTaskFlow({ ...h.deps, projects });
}

describe("an external check nothing runs", () => {
  it("is refused at task start with the clear sentence, before the budget, a workspace or a machine", async () => {
    const h = createHarness();
    await h.registerProject();
    const flow = flowOver(h, { latest: true, revision: true });
    await expect(flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Add a /health endpoint" })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining(UNRUNNABLE_EXTERNAL_CHECK_MESSAGE) as string });
    expect((await h.store.get({ pk: "DEVELOPER_LIMIT#local-owner", sk: "MEMBER" }))?.count ?? 0).toBe(0);
    expect(await h.flow.dispatchOnce({ maxMessages: 10 })).toMatchObject({ received: 0 });
    // The same project without the check starts.
    await expect(h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Add a /health endpoint" })).resolves.toBeDefined();
  });

  it("fails the operation with the sentence at dispatch, once, and never throws or redelivers to exhaustion (the backstop)", async () => {
    const h = createHarness();
    await h.registerProject();
    // Start sees a clean project; the revision the machine is prepared on is the bad one.
    const flow = flowOver(h, { latest: false, revision: true });
    const { task } = await flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Add a /health endpoint" });
    // The machine takes a try or two to be ready, as in the task flow's own tests: run the consumer until the queue is quiet, moving the clock past each retry delay.
    let delivered = 0;
    for (let round = 0; round < 12; round += 1) {
      const report = await flow.dispatchOnce({ maxMessages: 10 });
      delivered += report.delivered;
      if (report.received === 0) break;
      h.clock.advance(70);
    }
    expect(delivered).toBe(0);
    const operation = (await h.store.get(operationKey(task.workspaceId, (await h.store.query({ pk: `WORKSPACE#${task.workspaceId}`, sk: { op: "beginsWith", prefix: "OPERATION#" } })).items[0]!["id"] as string)))!;
    expect(operation["status"]).toBe("FAILED");
    expect(String(operation["error"] ?? operation["failure"] ?? JSON.stringify(operation))).toContain(UNRUNNABLE_EXTERNAL_CHECK_MESSAGE);
    // Nothing is left to redeliver.
    h.clock.advance(120);
    expect(await flow.dispatchOnce({ maxMessages: 10 })).toMatchObject({ received: 0 });
  });
});
