import { describe, expect, it, vi } from "vitest";
import type { ChannelMembersRequest, SlackChannelBinding } from "@agentx/contracts";
import { resolveDeveloperAccess } from "../../packages/broker/src/developer/access.js";

const binding = (channelId: string, projectName: string): SlackChannelBinding => ({ teamId: "T0TEAM1", channelId, projectName, updatedAt: "2026-09-27T00:00:00.000Z" });
const bindings = [binding("C0PAY0001", "payments-api"), binding("C0PAY0002", "payments-api"), binding("C0LEDGER1", "ledger"), binding("C0DOCS001", "docs")];

describe("project access (FR-013)", () => {
  it("counts an admin grant without asking Slack", async () => {
    const channelMembers = vi.fn();
    const access = await resolveDeveloperAccess({ grants: ["ledger"], bindings, channelMembersMayUse: () => true, channelMembers });
    expect([...access.projects]).toEqual([["ledger", { access: "granted", channels: ["C0LEDGER1"] }]]);
    expect(channelMembers).not.toHaveBeenCalled();
  });

  it("counts membership of any bound channel of a project, asking once for every candidate channel (US4 scenario 6)", async () => {
    const channelMembers = vi.fn(async (request: ChannelMembersRequest) => {
      expect(request).toEqual({ kind: "channel-members", slackUserId: "U0MAYA001", channelIds: ["C0DOCS001", "C0PAY0001", "C0PAY0002"] });
      return { ok: true as const, memberOf: ["C0PAY0002"] };
    });
    const access = await resolveDeveloperAccess({ grants: ["ledger"], bindings, slackUserId: "U0MAYA001", channelMembersMayUse: () => true, channelMembers });
    expect(Object.fromEntries(access.projects)).toEqual({
      ledger: { access: "granted", channels: ["C0LEDGER1"] },
      "payments-api": { access: "channel", channels: ["C0PAY0001", "C0PAY0002"] },
    });
    expect(channelMembers).toHaveBeenCalledTimes(1);
  });

  it("never asks Slack for a developer with no Slack link (a company user whose email matched nobody)", async () => {
    const channelMembers = vi.fn();
    const access = await resolveDeveloperAccess({ grants: [], bindings, channelMembersMayUse: () => true, channelMembers });
    expect(access.projects.size).toBe(0);
    expect(channelMembers).not.toHaveBeenCalled();
  });

  it("skips projects whose policy switches channel access off", async () => {
    const channelMembers = vi.fn(async () => ({ ok: true as const, memberOf: ["C0PAY0001", "C0DOCS001"] }));
    const access = await resolveDeveloperAccess({ grants: [], bindings, slackUserId: "U0MAYA001", channelMembersMayUse: (project) => project !== "docs", channelMembers });
    expect([...access.projects.keys()]).toEqual(["payments-api"]);
  });

  it("fails closed when Slack is unavailable, keeping grants (edge case: Slack down)", async () => {
    const access = await resolveDeveloperAccess({ grants: ["ledger"], bindings, slackUserId: "U0MAYA001", channelMembersMayUse: () => true, channelMembers: async () => ({ ok: false, error: "slack_unavailable" }) });
    expect([...access.projects.keys()]).toEqual(["ledger"]);
    expect(access.slackUnavailable).toBe(true);
  });

  it("splits the channel check into requests of at most 500 channels, the contract's cap", async () => {
    const many = Array.from({ length: 501 }, (_, index) => binding(`C0BIG${String(index).padStart(4, "0")}`, "big"));
    const requests: ChannelMembersRequest[] = [];
    const access = await resolveDeveloperAccess({
      grants: [], bindings: many, slackUserId: "U0MAYA001", channelMembersMayUse: () => true,
      channelMembers: async (request) => {
        requests.push(request);
        return { ok: true, memberOf: request.channelIds.includes("C0BIG0500") ? ["C0BIG0500"] : [] };
      },
    });
    expect(requests.map((request) => request.channelIds.length)).toEqual([500, 1]);
    expect(new Set(requests.flatMap((request) => request.channelIds)).size).toBe(501);
    expect(access.projects.get("big")?.access).toBe("channel");
  });

  it("fails closed when a later channel request fails", async () => {
    const many = Array.from({ length: 501 }, (_, index) => binding(`C0BIG${String(index).padStart(4, "0")}`, "big"));
    let calls = 0;
    const access = await resolveDeveloperAccess({
      grants: ["ledger"], bindings: many, slackUserId: "U0MAYA001", channelMembersMayUse: () => true,
      channelMembers: async () => (++calls === 1 ? { ok: true, memberOf: ["C0BIG0001"] } : { ok: false, error: "slack_unavailable" }),
    });
    expect([...access.projects.keys()]).toEqual(["ledger"]);
    expect(access.slackUnavailable).toBe(true);
  });

  it("fails closed on an invalid_request reply too", async () => {
    const access = await resolveDeveloperAccess({ grants: [], bindings, slackUserId: "U0MAYA001", channelMembersMayUse: () => true, channelMembers: async () => ({ ok: false, error: "invalid_request" }) });
    expect(access.projects.size).toBe(0);
    expect(access.slackUnavailable).toBe(true);
  });

  it("lists a granted project that has no bound channel", async () => {
    const access = await resolveDeveloperAccess({ grants: ["solo"], bindings, channelMembersMayUse: () => true, channelMembers: vi.fn() });
    expect(access.projects.get("solo")).toEqual({ access: "granted", channels: [] });
  });
});
