import { describe, expect, it, vi } from "vitest";
import { createTaskAuthorityAdmission } from "../../packages/broker/src/aws/task-authority-admission.js";
import { evaluateProjectAuthority, readProjectAuthority, type ProjectAuthorityReader } from "../../packages/broker/src/developer/task-project-access.js";
import { DEFAULT_DEVELOPER_TASK_POLICY, developerTaskPolicy, type SlackChannelBinding } from "@agentx/contracts";

const binding = (channelId: string, projectName = "payments-api"): SlackChannelBinding & { pk: string; sk: string } => ({
  pk: "SLACK_BINDING#T0BSHLLUGBD", sk: `CHANNEL#${channelId}`,
  teamId: "T0BSHLLUGBD", channelId, projectName, updatedAt: "2026-01-01T00:00:00.000Z",
});
const revision = (definition: { developerTasks?: unknown }) => ({
  pk: "PROJECT#payments-api", sk: "REV#000000000007", revision: 7, definition,
});
const developerGrant = { pk: `MEMBER#${"a".repeat(64)}`, sk: "PROJECT#payments-api", projectName: "payments-api", role: "developer" };

describe("task project authority core", () => {
  it("counts only developer memberships as project grants", () => {
    const result = evaluateProjectAuthority({
      project: "payments-api",
      developerId: "a".repeat(64), teamId: "T0BSHLLUGBD",
      revision: revision({ developerTasks: { enabled: true, channelMembersMayUse: false } }),
      memberships: [{ ...developerGrant, role: "administrator" }],
      bindings: [],
      freshMemberOf: [],
      slackUserId: "U0123456789",
    });

    expect(result).toEqual({ kind: "denied", reason: "project-access", visibleChannelIds: [] });
  });

  it("allows a developer grant even without a Slack identity", () => {
    const result = evaluateProjectAuthority({
      project: "payments-api",
      developerId: "a".repeat(64), teamId: "T0BSHLLUGBD",
      revision: revision({}),
      memberships: [developerGrant],
      bindings: [binding("C0123456789")],
    });

    expect(result).toMatchObject({ kind: "allowed", revision: 7, access: "granted", channelIds: ["C0123456789"] });
  });

  it("keeps task-policy denial after access has been established", () => {
    const result = evaluateProjectAuthority({
      project: "payments-api",
      revision: revision({ developerTasks: { enabled: false } }),
      developerId: "a".repeat(64), teamId: "T0BSHLLUGBD",
      memberships: [developerGrant],
      bindings: [],
    });

    expect(result).toEqual({ kind: "denied", reason: "tasks-disabled", visibleChannelIds: [] });
  });

  it("returns unavailable when any bounded read is incomplete", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const reader: ProjectAuthorityReader = {
      latestRevision: vi.fn().mockResolvedValue({ revision: revision({}), complete: true }),
      memberships: vi.fn().mockResolvedValue({ items: [], complete: false }),
      bindings: vi.fn().mockResolvedValue({ items: [], complete: true }),
    };

    await expect(readProjectAuthority(reader, {
      project: "payments-api", developerId: "a".repeat(64), teamId: "T0BSHLLUGBD",
      admission,
    })).resolves.toEqual({ kind: "unavailable" });
    expect(admission.remainingStateReads()).toBe(126);
  });

  it("uses fresh membership and leaves channel-name decoration outside the evaluator", () => {
    const result = evaluateProjectAuthority({
      project: "payments-api",
      developerId: "a".repeat(64), teamId: "T0BSHLLUGBD",
      revision: revision({ developerTasks: { enabled: true, channelMembersMayUse: true } }),
      memberships: [],
      bindings: [binding("C0123456789")],
      freshMemberOf: ["C0123456789"],
      slackUserId: "U0123456789",
    });

    expect(result).toMatchObject({ kind: "allowed", access: "channel", channelIds: ["C0123456789"] });
    expect(result).not.toHaveProperty("name");
    expect(DEFAULT_DEVELOPER_TASK_POLICY.enabled).toBe(true);
    expect(developerTaskPolicy({ developerTasks: {} }).enabled).toBe(true);
  });
});
