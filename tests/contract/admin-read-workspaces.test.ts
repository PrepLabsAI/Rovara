// Spec 025 A10: workspaces by project and status, with their owners, the limits and the counts.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { MAYA } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, ensureWorkspace } from "../support/slack-broker.js";

describe("GET /v1/admin/workspaces (FR-030, A10)", () => {
  it("lists a Slack thread's and a developer task's workspaces with their owners, and the limits", async () => {
    const harness = await createAdminReadBroker();
    await ensureWorkspace(harness.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000200`, "U0PRIYA001");
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
    const taskId = (started.body.task as { taskId: string }).taskId;
    const answer = await harness.admin("GET", "/v1/admin/workspaces");
    const rows = answer.body.workspaces as Array<{ origin: string; owner: Record<string, unknown>; status: string; busy: boolean }>;
    expect(rows.map((row) => row.origin).sort()).toEqual(["ai_tool", "slack"]);
    expect(rows.find((row) => row.origin === "ai_tool")?.owner).toEqual({ taskId, developerName: "Maya Chen" });
    expect(rows.find((row) => row.origin === "slack")?.owner).toEqual({ threadUrl: `https://slack.com/archives/${SLACK_CHANNEL}/p1695500000000200` });
    expect(answer.body.limits).toEqual({ perPerson: 3, perOrganization: 20, source: "parameters" });
    expect(answer.body.counts).toMatchObject({ organization: 2 });
    expect(answer.body.truncated).toBe(false);
    // D22's privacy holds for admins' tool results too: no task title here.
    expect(JSON.stringify(answer.body)).not.toContain("Fix it");
  });

  it("reads the admin's limits setting when there is one (FR-053)", async () => {
    const { db, admin } = await createAdminReadBroker();
    db.set({ pk: "SETTINGS", sk: "WORKSPACE_LIMITS", perPerson: 5, perOrganization: 40 });
    expect((await admin("GET", "/v1/admin/workspaces")).body.limits).toEqual({ perPerson: 5, perOrganization: 40, source: "setting" });
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
