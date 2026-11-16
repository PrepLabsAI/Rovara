import { describe, expect, it, vi } from "vitest";
import { ChannelMembersRequestSchema, SlackAuthCheckRequestSchema, TaskPersonProofRequestSchema } from "@agentx/contracts";
import * as tokens from "../../packages/broker/src/aws/slack-workspace-tokens.js";
import { slackTokens } from "../../packages/testing/src/channel/slack-world.js";

const A = { companyId: "org_aaaaaaaaaaaaaaaaaaaa", teamId: "T0AAAAAAA" };
const B = { companyId: "org_bbbbbbbbbbbbbbbbbbbb", teamId: "T0BBBBBBB" };
const refuse = "This Slack workspace is not available.";
describe("internal Slack caller scope", () => {
  it.each([
    [ChannelMembersRequestSchema, { kind: "channel-members", slackUserId: "U0SHARED", channelIds: ["C0SHARED"] }],
    [TaskPersonProofRequestSchema, { kind: "task-person-proof", slackUserId: "U0SHARED", channelIds: ["C0SHARED"] }],
    [SlackAuthCheckRequestSchema, { kind: "slack-auth-check" }],
  ] as const)("accepts additive scope and preserves legacy JSON", (schema, request) => {
    expect(JSON.stringify(schema.parse(request))).toBe(JSON.stringify(request));
    expect(schema.safeParse({ ...request, workspace: A }).success).toBe(true);
    for (const workspace of [null, {}, { ...A, teamId: "E0AAAAAAA" }, { ...A, companyId: 7 }, { ...A, token: "private" }]) {
      expect(schema.safeParse({ ...request, workspace }).success).toBe(false);
    }
  });
  it("rechecks the company binding before credentials and does not share raw identifiers", async () => {
    const read = vi.fn(async (company: string, team: string) => company === A.companyId && team === A.teamId ? slackTokens("a").bot : company === B.companyId && team === B.teamId ? slackTokens("b").bot : undefined);
    const workspaces = { requireCompany: async (team: string) => team === A.teamId ? A.companyId : B.companyId, tokenForCompany: read };
    const get = tokens.slackCallerToken;
    expect(typeof get).toBe("function");
    expect(await get(workspaces, A) === slackTokens("a").bot).toBe(true);
    expect(await get(workspaces, B) === slackTokens("b").bot).toBe(true);
    read.mockClear();
    for (const scope of [undefined, null, {}, { ...A, teamId: B.teamId }, { ...A, companyId: "private" }]) await expect(get(workspaces, scope)).rejects.toThrow(refuse);
    expect(read).not.toHaveBeenCalled();
    await expect(get({ ...workspaces, tokenForCompany: async () => { throw new Error("private cause"); } }, A)).rejects.toThrow(refuse);
  });
});
