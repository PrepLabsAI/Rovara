import { describe, expect, it } from "vitest";
import { agentXError } from "@agentx/contracts";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";

describe("core start leaves People to the owner view", () => {
  it("keeps the adapter and Slack link, creates no People rows, and replays once", async () => {
    const h = createHarness();
    await h.registerProject();
    Object.assign(h.owner, { slackUserId: "U0OWNER01" });
    Object.assign(h.owner.principal, { provider: "rovara-sign-in" });
    const request = { requestId: newRequestId(), project: "payments", instructions: "Fix it", workflow: true, workflowPath: "QUICK" };
    const result = await h.flow.start(h.owner, request);
    const rows = (await h.store.query({ pk: `DEVTASK#${result.task.taskId}` })).items;
    expect(rows.find(row => row.sk === "META")).toMatchObject({ provider: "rovara-sign-in", slackUserId: "U0OWNER01" });
    expect(rows.filter(row => /^(PEOPLE|PERSON#|PERSON_SUBJECT#)/u.test(row.sk))).toEqual([]);
    expect((await h.flow.start(h.owner, request)).duplicate).toBe(true);
  });

  it("starts even when an obsolete People hook would refuse proof", async () => {
    const h = createHarness();
    await h.registerProject();
    Object.assign(h.owner.principal, { provider: "rovara-sign-in" });
    Object.assign(h.deps, { taskPeopleStart: async () => { throw agentXError("TASK_ACCESS_DENIED", "task access could not be verified"); } });
    const { task } = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Fix it", workflow: true, workflowPath: "QUICK" });
    expect(task.status).toBe("STARTING");
    expect((await h.flow.list(h.owner)).tasks).toHaveLength(1);
  });
});
