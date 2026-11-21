// Spec 025 A10: workspaces by project and status, with their owners, the limits and the counts.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, ensureWorkspace, orchestratorPrincipal } from "../support/slack-broker.js";

describe("GET /v1/admin/workspaces (FR-030, A10)", () => {

  it("keeps the charged starter as owner when another member uses the thread", async () => {
    const harness = await createAdminReadBroker();
    const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000201`;
    await ensureWorkspace(harness.handler, thread, "U0PRIYA001");
    await ensureWorkspace(harness.handler, thread, "U0MAYA001");
    const rows = (await harness.admin("GET", "/v1/admin/workspaces")).body.workspaces as Array<{ owner: Record<string, unknown> }>;
    expect(rows[0]?.owner).toMatchObject({ slackUserId: "U0PRIYA001", slackTeamId: SLACK_TEAM });
  });

  it("shows the creator of an unprepared Slack workspace without charging them", async () => {
    const harness = await createAdminReadBroker();
    await call(harness.handler, { method: "POST", path: "/v1/service/threads/workspace", service: { principal: orchestratorPrincipal, thread: `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000202`, slackUser: "U0PRIYA001" }, headers: { "x-agentx-slack-user-name": "Priya%20Shah" }, body: { requestId: randomUUID(), lazyPreparation: true } });
    const answer = await harness.admin("GET", "/v1/admin/workspaces");
    expect(answer.body.workspaces).toMatchObject([{ status: "UNPREPARED", owner: { slackUserId: "U0PRIYA001", slackName: "Priya Shah" } }]);
    expect(answer.body.counts).toMatchObject({ organization: 0 });
  });

  it("does not invent a legacy unprepared owner from a later participant", async () => {
    const harness = await createAdminReadBroker();
    const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000203`;
    await call(harness.handler, { method: "POST", path: "/v1/service/threads/workspace", service: { principal: orchestratorPrincipal, thread, slackUser: "U0PRIYA001" }, body: { requestId: randomUUID(), lazyPreparation: true } });
    const [record] = harness.db.find((item) => item.entityType === "SLACK_THREAD");
    const legacy = { ...record! }; delete legacy.creator;
    harness.db.set(legacy);
    await call(harness.handler, { method: "POST", path: "/v1/service/threads/workspace", service: { principal: orchestratorPrincipal, thread, slackUser: "U0MAYA001" }, body: { requestId: randomUUID(), lazyPreparation: true } });
    expect((await harness.admin("GET", "/v1/admin/workspaces")).body.workspaces).toMatchObject([{ owner: { threadUrl: `https://slack.com/archives/${SLACK_CHANNEL}/p1695500000000203` } }]);
    const rows = (await harness.admin("GET", "/v1/admin/workspaces")).body.workspaces as Array<{ owner: Record<string, unknown> }>;
    expect(rows[0]?.owner).not.toHaveProperty("slackUserId");
  });

  it("filters by project and status, leaves closed ones out by default, and honours limit", async () => {
    const harness = await createAdminReadBroker();
    for (const ts of ["1695500000.000301", "1695500000.000302", "1695500000.000303"]) await ensureWorkspace(harness.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/${ts}`, "U0PRIYA001");
    const [first] = harness.db.find((item) => item.entityType === "WORKSPACE");
    // WorkspaceInstanceSchema requires closedAt on a closed workspace, as the close path writes it.
    harness.db.set({ ...first!, status: "CLOSED", closedAt: new Date().toISOString() });
    expect((await harness.admin("GET", "/v1/admin/workspaces")).body.workspaces).toHaveLength(2);
    expect((await harness.admin("GET", "/v1/admin/workspaces?status=CLOSED")).body.workspaces).toHaveLength(1);
    expect((await harness.admin("GET", "/v1/admin/workspaces?project=ledger")).body.workspaces).toEqual([]);
    expect((await harness.admin("GET", "/v1/admin/workspaces?limit=1")).body).toMatchObject({ truncated: true });
    expect((await harness.admin("GET", "/v1/admin/workspaces?status=ASLEEP")).body.error).toMatchObject({ code: "CONFIG_INVALID" });
  });

});

it("admin workspace lists omit discovery pointers even if a stale index carries workspace fields", async () => {
  const h = await createAdminReadBroker();
  await ensureWorkspace(h.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000905`, "U0PRIYA001");
  const [workspace] = h.db.find((row) => row.entityType === "WORKSPACE");
  h.db.set({ ...workspace!, entityType: "WORKSPACE_COMPANY_POINTER" });
  expect((await h.admin("GET", "/v1/admin/workspaces")).body.workspaces).toEqual([]);
});
