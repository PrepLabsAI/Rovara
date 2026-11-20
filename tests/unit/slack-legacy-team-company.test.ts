// #759 batch fix: the install's own Slack team (the deployment's SlackTeamId) belongs to the implicit company until the workspace backfill binds it. With the company check on and
// no workspace service (how the deployed broker runs company sign-in today), the implicit company keeps its channel projects exactly as before; another company never sees them.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { companyRouteHarness } from "../support/company-route-harness.js";

const OTHER = `org_${"b".repeat(20)}`;

describe("the install's own Slack team with the workspace service wired", () => {
  async function wired(companyId: string, boundTo?: string): Promise<unknown[]> {
    const { createSlackWorkspaceBindings } = await import("../../packages/broker/src/aws/slack-workspace-binding.js");
    const h = companyRouteHarness();
    h.deps.companies = { companyOf: async () => companyId };
    const db = h.deps.documentClient as unknown as { set(item: Record<string, unknown>): void };
    if (boundTo !== undefined) db.set({ pk: "SLACK_TEAM#T0SHARED", sk: "BINDING", entityType: "SLACK_WORKSPACE_BINDING", teamId: "T0SHARED", companyId: boundTo, boundAt: "2026-11-16T00:00:00.000Z", boundBy: "operator" });
    h.deps.workspaces = createSlackWorkspaceBindings({ client: h.deps.documentClient, tableName: h.deps.tableName, legacyTeamId: "T0SHARED" });
    h.project(undefined, "channel");
    const answer = await h.read("/v1/dev/projects");
    return (JSON.parse(answer.body) as { projects?: unknown[] }).projects ?? [answer.body];
  }

  it("gives the implicit company its team before the backfill binds it", async () => {
    expect(await wired(IMPLICIT_COMPANY_ID)).toHaveLength(1);
  });

});

describe("the install's own team stays inside the implicit company on every path (#759 REVIEW-GOLDEN-FIX H1, M1)", () => {
  async function setup(companyId: string, projectCompany?: string) {
    const h = companyRouteHarness();
    h.deps.companies = { companyOf: async () => companyId };
    h.project(projectCompany, "channel");
    return h;
  }
  const listed = async (h: Awaited<ReturnType<typeof setup>>, path: string) => JSON.stringify(JSON.parse((await h.read(path)).body));

  it("never lists another company's project on /v1/dev/workspaces or /v1/dev/projects, even through the install's team", async () => {
    const h = await setup(IMPLICIT_COMPANY_ID, OTHER);
    expect(await listed(h, "/v1/dev/projects")).not.toContain("shared-project");
    expect(await listed(h, "/v1/dev/workspaces")).not.toContain("shared-project");
  });

  it("gives /v1/dev/workspaces the implicit company's own channel project, and never another company's member", async () => {
    expect(await listed(await setup(IMPLICIT_COMPANY_ID), "/v1/dev/workspaces")).toContain("shared-project");
    expect(await listed(await setup(OTHER), "/v1/dev/workspaces")).not.toContain("shared-project");
  });

  it("lets the implicit company use its channel project through the access check (a channel start), and refuses another company", async () => {
    const { checkProjectAccess } = await import("../../packages/broker/src/aws/developer-routes.js");
    const caller = { developerId: "d".repeat(64), slackUserId: "U0SHARED" };
    const mine = await setup(IMPLICIT_COMPANY_ID);
    await expect(checkProjectAccess(mine.deps, caller, "shared-project")).resolves.toMatchObject({ access: "channel", channelIds: ["C0SHARED"] });
    const theirs = await setup(OTHER);
    await expect(checkProjectAccess(theirs.deps, caller, "shared-project")).rejects.toThrow();
    const slackThread = await setup(IMPLICIT_COMPANY_ID);
    slackThread.deps.workspace = { companyId: IMPLICIT_COMPANY_ID, teamId: "T0SHARED" };
    await expect(checkProjectAccess(slackThread.deps, caller, "shared-project")).resolves.toMatchObject({ access: "channel" });
    const foreignTeam = await setup(IMPLICIT_COMPANY_ID);
    foreignTeam.deps.workspace = { companyId: IMPLICIT_COMPANY_ID, teamId: "T0FOREIGN" };
    await expect(checkProjectAccess(foreignTeam.deps, caller, "shared-project")).rejects.toThrow();
  });
});
