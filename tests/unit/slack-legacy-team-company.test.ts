// #759 batch fix: the install's own Slack team (the deployment's SlackTeamId) belongs to the implicit company until the workspace backfill binds it. With the company check on and
// no workspace service (how the deployed broker runs company sign-in today), the implicit company keeps its channel projects exactly as before; another company never sees them.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { companyRouteHarness } from "../support/company-route-harness.js";

const OTHER = `org_${"b".repeat(20)}`;

async function channelProjects(companyId: string, project: unknown = undefined): Promise<unknown[]> {
  const h = companyRouteHarness();
  h.deps.companies = { companyOf: async () => companyId };
  h.project(project, "channel");
  const answer = await h.read("/v1/dev/projects");
  return (JSON.parse(answer.body) as { projects: unknown[] }).projects;
}

describe("the install's own Slack team under the company check, without the workspace service", () => {
  it("lists the implicit company's channel project", async () => {
    expect(await channelProjects(IMPLICIT_COMPANY_ID)).toHaveLength(1);
  });

  it("never lists it for another company, even when the project row names that company", async () => {
    expect(await channelProjects(OTHER)).toEqual([]);
    expect(await channelProjects(OTHER, OTHER)).toEqual([]);
  });
});

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

  it("does not give it to the implicit company once it is bound to another company", async () => {
    expect(await wired(IMPLICIT_COMPANY_ID, OTHER)).toEqual([]);
  });
});
