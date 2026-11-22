import { describe, expect, it } from "vitest";
import { developerTaskPolicy } from "@agentx/contracts";
import { prepareCoreShare } from "../../packages/broker/src/aws/core-task-sharing.js";
import type { DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks.js";
import { definition } from "../support/task-flow-harness.js";
const policy = developerTaskPolicy(definition);
const caller = { developerId: "d".repeat(64), name: "Maya", amr: "oidc", sessionId: "core", slackUserId: "U0123456789" } as const;
const { slackUserId: _linkedAccount, ...unlinkedCaller } = caller;
void _linkedAccount;
function deps(isPrivate: boolean | undefined, member: boolean) {
  return { slackTeamId: "T0123456789", projectChannelIds: async () => ["C0123456789"], boundChannels: async () => [{ channelId: "C0123456789", name: "private-name", isPrivate }], channelMember: async () => member } as unknown as DeveloperTaskRouteDependencies;
}
describe("the retired share privacy rule on core", () => {
  it.each([true, undefined])("requires live membership for private/unknown privacy %s", async privacy => {
    await expect(prepareCoreShare(deps(privacy, false), caller, "payments", policy, { shareToChannel: true })).rejects.toMatchObject({ code: privacy ? "CHANNEL_REQUIRED" : "SLACK_UNAVAILABLE" });
    expect(await prepareCoreShare(deps(privacy, true), caller, "payments", policy, { shareToChannel: true })).toMatchObject({ channelId: "C0123456789" });
  });
  it("never reveals a private name and never lets an unlinked caller into it", async () => {
    const share = await prepareCoreShare(deps(true, true), caller, "payments", policy, { shareToChannel: true });
    expect(share).not.toHaveProperty("channelName");
    await expect(prepareCoreShare(deps(true, true), unlinkedCaller, "payments", policy, { shareToChannel: true })).rejects.toMatchObject({ code: "CHANNEL_REQUIRED" });
  });
  it("requires no membership for a public channel and strips its name for an unlinked caller", async () => {
    expect(await prepareCoreShare(deps(false, false), unlinkedCaller, "payments", policy, { shareToChannel: true })).not.toHaveProperty("channelName");
  });
  it("does no Slack lookup for a private task and shares when the latest project requires it", async () => {
    const unavailable = {} as DeveloperTaskRouteDependencies;
    expect(await prepareCoreShare(unavailable, caller, "payments", policy, { shareToChannel: false })).toBeUndefined();
    expect(await prepareCoreShare(deps(false, false), caller, "payments", { ...policy, share: "required" }, { shareToChannel: false })).toMatchObject({ sharedReason: "required" });
  });
});
