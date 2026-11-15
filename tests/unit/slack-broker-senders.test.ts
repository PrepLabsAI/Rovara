import { expect, it, vi } from "vitest";
import { developerTaskRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
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

it("project senders retain the verified thread and use T4a project ownership for an unstamped policy projection", async () => {
  for (const [companyId, teamId] of [[A, "T0AAAAAAA"], [B, "T0BBBBBBB"]] as const) {
    const db = new FakeDynamoDb();
    db.set({ pk: "PROJECT#payments", sk: "REV#000001", definition: { revision: 1 } });
    db.set({ pk: `SLACK_BINDING#${teamId}`, sk: "CHANNEL#C0SHARED", teamId, channelId: "C0SHARED", projectName: "payments", updatedAt: "2026-11-15T00:00:00.000Z" });
    const getProject = vi.fn(async () => ({ companyId }));
    const deps = developerTaskRouteDependencies({ documentClient: db, tableName: "state", now: Date.now, tasks: {} as never,
      companies: { companyOf: async () => companyId }, workspaces: { requireCompany: async () => companyId, getProject },
      developer: { slackTeamId: "T0INSTALL" } as never,
    }, { developerId: "a".repeat(64) } as never, { teamId, channelId: "C0SHARED", threadTs: "1700000000.000001" });
    expect(await deps.workspaceForProject!("payments")).toEqual({ companyId, teamId });
    getProject.mockResolvedValue({ companyId: companyId === A ? B : A });
    await expect(deps.workspaceForProject!("payments")).rejects.toThrow("This Slack workspace is not available.");
  }
});
