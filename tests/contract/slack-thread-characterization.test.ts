// Pins the thread workspace behaviour that phase 14b must keep for threads that have compute.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { SLACK_CHANNEL, SLACK_TEAM, createBroker, ensureWorkspace, finishOperation, loadSlackBroker, registerSlackProject, serviceCall } from "../support/slack-broker.js";

const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const pratik = "U0123456789";

beforeAll(async () => {
  await loadSlackBroker();
});

describe("thread workspaces before lazy preparation (characterization)", () => {

  it("retries a failed preparation at the next request without charging the limit again", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const first = await ensureWorkspace(handler, thread, pratik);
    const workspaceId = first.body.workspaceId as string;
    await finishOperation(handler, db, workspaceId, first.body.operationId as string, "FAILED");
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED", fence: 1 });

    const retried = await ensureWorkspace(handler, thread, pratik);
    expect(retried.body).toMatchObject({ outcome: "WORKSPACE", workspaceId, status: "PREPARING", created: false });
    expect(retried.body.operationId).not.toBe(first.body.operationId);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARING", fence: 2 });
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "prepare")).toHaveLength(2);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${pratik}`)).toMatchObject({ count: 1 });
  });

  it("refuses to close a workspace that is still being prepared", async () => {
    const { handler } = createBroker();
    await registerSlackProject(handler);
    await ensureWorkspace(handler, thread, pratik);
    const close = await serviceCall(handler, thread, pratik, "POST", "/v1/service/threads/workspace/close", { requestId: randomUUID() });
    expect(close.status).toBe(409);
    expect(close.body.error).toEqual({ code: "WORKSPACE_BUSY", message: "workspace is PREPARING; wait for active work before closing it" });
  });

});
