import { describe, expect, it } from "vitest";
import { ChannelMembersRequestSchema, SlackAuthCheckRequestSchema, TaskPersonProofRequestSchema } from "@agentx/contracts";

const A = { companyId: "org_aaaaaaaaaaaaaaaaaaaa", teamId: "T0AAAAAAA" };
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
});
