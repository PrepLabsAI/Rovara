// Lead 4 J2: the broker's own mapping from the verified Slack identity to the answer call (`askSlackAnswerForIdentity`, aws/slack-answers.ts, called by the broker): a thread that holds a task is never answered, the project is the channel's
// binding, the person is the verified requester's linked person, and a caller that is not a Slack thread is refused. The core is a recorder.
import { describe, expect, it } from "vitest";
import { COMPANY_A } from "../../packages/testing/src/isolation/index.js";
import { askSlackAnswerForIdentity } from "../../packages/broker/src/aws/slack-answers.js";
import { createSlackWorkspaceBindings } from "../../packages/broker/src/aws/slack-workspace-binding.js";
import { issueChannelLinkCode, redeemChannelLinkCode } from "../../packages/broker/src/core/channel/links.js";
import type { SlackThreadAnswerInput } from "../../packages/broker/src/core-host/dev-routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { dynamoWorld } from "../support/ports/dynamodb-harness.js";

const TEAM = "T0AAAAAAA";
const USER = "U0ASKER000";
const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const REQUEST = "11111111-1111-4111-8111-111111111111";
const THREAD = { teamId: TEAM, channelId: "C0BOUND000", threadTs: "1700000000.000100" };

async function world() {
  const bindings = createSlackWorkspaceBindings({ client: new FakeDynamoDb(), tableName: "state", now: () => NOW });
  await bindings.backfill();
  await bindings.bind(COMPANY_A.orgId, TEAM, "operator");
  const { store } = dynamoWorld();
  const issued = await issueChannelLinkCode({ store, orgId: COMPANY_A.orgId, now: () => NOW }, { channel: "slack", tenant: TEAM, userId: USER });
  await redeemChannelLinkCode({ store, orgId: COMPANY_A.orgId, now: () => NOW }, "dev-ada", issued.code);
  const asked: SlackThreadAnswerInput[] = [];
  const dependencies = {
    company: {
    workspaces: { ...bindings, store, linkUrl: () => "https://example.test/link", getProject: async (name: string) => (name === "alpha" || name === "gamma" ? { companyId: COMPANY_A.orgId } : undefined) },
    companies: { companyOf: async (person: string) => (person === "dev-ada" ? COMPANY_A.orgId : undefined) },
    now: () => NOW,
    } as never,
    core: { answerForSlackThread: async (input: SlackThreadAnswerInput) => { asked.push(input); return undefined; } },
  };
  const identity = (over: Record<string, unknown> = {}) => ({
    issuer: "slack", subject: "s", ownerKey: "k", isAdministrator: false, claims: {},
    slack: { thread: THREAD, requester: { teamId: TEAM, userId: USER }, binding: { teamId: TEAM, channelId: THREAD.channelId, projectName: "alpha", updatedAt: new Date(NOW).toISOString() } },
    ...over,
  }) as never;
  const body = { requestId: REQUEST, question: "How long do refunds last?" };
  return { dependencies, identity, asked, body };
}

describe("the broker's answer call from the verified Slack identity", () => {

  it("the project is the channel's binding, whatever the body says", async () => {
    const w = await world();
    const bound = w.identity({ slack: { thread: THREAD, requester: { teamId: TEAM, userId: USER }, binding: { teamId: TEAM, channelId: THREAD.channelId, projectName: "gamma", updatedAt: new Date(NOW).toISOString() } } });
    await askSlackAnswerForIdentity(w.dependencies, bound, { ...w.body, project: "alpha" });
    expect(w.asked).toEqual([]);
    await askSlackAnswerForIdentity(w.dependencies, bound, w.body);
    expect(w.asked.map((input) => input.project)).toEqual(["gamma"]);
  });

  it("a caller that is not a Slack thread (no Slack context) is refused before anything is read", async () => {
    const w = await world();
    await expect(askSlackAnswerForIdentity(w.dependencies, w.identity({ slack: undefined }), w.body)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.asked).toEqual([]);
  });

});
