import { expect, it, vi } from "vitest";
import { developerTaskRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { companyProjectRow } from "../support/company-layout-projects.js";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
it("broker People directory sends only task-record scope and rejects foreign task before transport", async () => {
  for (const [companyId, teamId] of [[A, "T0AAAAAAA"], [B, "T0BBBBBBB"]] as const) {
    const db = new FakeDynamoDb();
    const task = { taskId: "11111111-1111-4111-8111-111111111111", project: "payments", companyId, share: { teamId, channelId: "C0SHARED" } };
    db.set({ pk: `SLACK_BINDING#${teamId}`, sk: "CHANNEL#C0SHARED", teamId, channelId: "C0SHARED", projectName: "payments", updatedAt: "2026-11-15T00:00:00.000Z" });
    const directory = vi.fn(async () => ({ ok: false as const, error: "slack_unavailable" as const }));
    const deps = developerTaskRouteDependencies({ documentClient: db, tableName: "state", now: Date.now, tasks: {} as never,
      companies: { companyOf: async () => companyId }, workspaces: { requireCompany: async (team: string) => team === "T0AAAAAAA" ? A : B },
      developer: { slackTeamId: "T0INSTALL", taskPersonProof: vi.fn(), taskPeopleDisplayRead: vi.fn() } as never,
    }, { developerId: "a".repeat(64) } as never);
    await expect(deps.listTaskPeople!(task as never, { directory, proof: vi.fn(), assertOpen: () => undefined } as never)).rejects.toThrow("the complete task People directory is unavailable");
    expect(directory).toHaveBeenCalledExactlyOnceWith({ kind: "task-channel-people", channelIds: ["C0SHARED"], workspace: { companyId, teamId } });
    directory.mockClear();
    await expect(deps.listTaskPeople!({ ...task, companyId: companyId === A ? B : A } as never, { directory, proof: vi.fn(), assertOpen: () => undefined } as never)).rejects.toThrow("This Slack workspace is not available.");
    expect(directory).not.toHaveBeenCalled();
    const foreign = { ...task, companyId: companyId === A ? B : A, share: { ...task.share, teamId: teamId === "T0AAAAAAA" ? "T0BBBBBBB" : "T0AAAAAAA" } };
    await expect(deps.listTaskPeople!(foreign as never, { directory, proof: vi.fn(), assertOpen: () => undefined } as never)).rejects.toThrow("This Slack workspace is not available.");
    expect(directory).not.toHaveBeenCalled();
  }
});

it("broker company mode cannot use an installation callback when workspace dependencies are missing", async () => {
  const channelMembers = vi.fn(async () => ({ ok: true as const, memberOf: ["C0SHARED"] }));
  const deps = developerTaskRouteDependencies({ documentClient: new FakeDynamoDb(), tableName: "state", now: Date.now,
    companies: { companyOf: async () => A }, developer: { slackTeamId: "T0INSTALL", channelMembers } as never,
  }, { developerId: "a".repeat(64) } as never);
  await expect(deps.channelMember!("U0SHARED", "C0SHARED")).rejects.toThrow("This Slack workspace is not available.");
  expect(channelMembers).not.toHaveBeenCalled();
});

it("project senders retain the verified thread; a named company's project is the one in its own partition (DEC 254zzz80), whatever the legacy lookup says", async () => {
  for (const [companyId, teamId] of [[A, "T0AAAAAAA"], [B, "T0BBBBBBB"]] as const) {
    const db = new FakeDynamoDb();
    db.set(companyProjectRow(companyId, "payments", 1));
    // DEC 254zzz98: a named company's channel binding lives in its own partition (the layout the Slack link writer uses); a legacy row on its team is not its binding.
    db.set({ pk: `ORG#${companyId}#SLACK_BINDING#${teamId}`, sk: "CHANNEL#C0SHARED", teamId, channelId: "C0SHARED", projectName: "payments", updatedAt: "2026-11-15T00:00:00.000Z" });
    const getProject = vi.fn(async () => ({ companyId }));
    const deps = developerTaskRouteDependencies({ documentClient: db, tableName: "state", now: Date.now, tasks: {} as never,
      companies: { companyOf: async () => companyId }, workspaces: { requireCompany: async () => companyId, getProject },
      developer: { slackTeamId: "T0INSTALL" } as never,
    }, { developerId: "a".repeat(64) } as never, { teamId, channelId: "C0SHARED", threadTs: "1700000000.000001" });
    expect(await deps.workspaceForProject!("payments")).toEqual({ companyId, teamId });
    // A legacy binding row on the company's team is never the company's (review M1): with only that row, the project has no channel.
    const own = db.get(`ORG#${companyId}#SLACK_BINDING#${teamId}`, "CHANNEL#C0SHARED")!;
    db.delete(String(own.pk), String(own.sk));
    db.set({ ...own, pk: `SLACK_BINDING#${teamId}` });
    await expect(deps.workspaceForProject!("payments")).rejects.toThrow("This Slack workspace is not available.");
    db.delete(`SLACK_BINDING#${teamId}`, "CHANNEL#C0SHARED");
    // A row in the company's own partition that names another company is drift, never this company's binding (delta review L3).
    db.set({ ...own, companyId: companyId === A ? B : A });
    await expect(deps.workspaceForProject!("payments")).rejects.toThrow("This Slack workspace is not available.");
    db.set(own);
    // The legacy lookup (T4a's, `PROJECT#<name>`) is not this company's partition: what it says no longer decides.
    getProject.mockResolvedValue({ companyId: companyId === A ? B : A });
    expect(await deps.workspaceForProject!("payments")).toEqual({ companyId, teamId });
    // Only the company's own revision does: without it the project is not the company's.
    db.delete(`ORG#${companyId}#PROJECT#payments`, "REV#000000000001");
    await expect(deps.workspaceForProject!("payments")).rejects.toThrow("This Slack workspace is not available.");
  }
});


it.each(["missing dependencies", "no binding", "ambiguous binding"])("project access maps %s to a fixed AgentX refusal", async (kind) => {
  const db = new FakeDynamoDb();
  db.set(companyProjectRow(A, "payments", 1));
  if (kind === "ambiguous binding") for (const teamId of ["T0AAAAAAA", "T0BBBBBBB"]) {
    db.set({ pk: `ORG#${A}#SLACK_WORKSPACES`, sk: `TEAM#${teamId}`, entityType: "COMPANY_SLACK_WORKSPACE_VIEW", companyId: A, teamId, boundAt: "2026-11-15T00:00:00.000Z", boundBy: "operator" });
    db.set({ pk: `ORG#${A}#SLACK_BINDING#${teamId}`, sk: "CHANNEL#C0SHARED", teamId, channelId: "C0SHARED", projectName: "payments", updatedAt: "2026-11-15T00:00:00.000Z" });
  }
  const deps = developerTaskRouteDependencies({ documentClient: db, tableName: "state", now: Date.now,
    companies: { companyOf: async () => A }, developer: {} as never,
    ...(kind === "missing dependencies" ? {} : { workspaces: { requireCompany: async () => A, getProject: async () => ({ companyId: A }) } }),
  }, { developerId: "a".repeat(64) } as never);
  await expect(deps.checkAccess("payments")).rejects.toMatchObject({ name: "AgentXError", code: "SLACK_UNAVAILABLE", message: "SLACK_UNAVAILABLE: This Slack workspace is not available." });
});
