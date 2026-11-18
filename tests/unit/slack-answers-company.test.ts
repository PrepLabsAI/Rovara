// Lead 4 J2: how the Slack answer route finds the company, the person and the project: the same real workspace directory, core links and company check the rest of hosted Slack uses (aws/slack-person.ts),
// with two companies that share raw Slack ids. Nothing but the verified Slack workspace and member picks a company or a person; a project another company owns is not reachable.
import { describe, expect, it } from "vitest";
import { slackAnswerThreadId } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/index.js";
import { createSlackWorkspaceBindings } from "../../packages/broker/src/aws/slack-workspace-binding.js";
import { issueChannelLinkCode, redeemChannelLinkCode } from "../../packages/broker/src/core/channel/links.js";
import { askSlackAnswer, slackAnswerDeps } from "../../packages/broker/src/aws/slack-answers.js";
import type { SlackThreadAnswerInput } from "../../packages/broker/src/core-host/dev-routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { dynamoWorld } from "../support/ports/dynamodb-harness.js";

const TEAM = { A: "T0AAAAAAA", B: "T0BBBBBBB" };
const SHARED_USER = "U0SHARED00";
const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const REQUEST = "11111111-1111-4111-8111-111111111111";

async function world() {
  const bindings = createSlackWorkspaceBindings({ client: new FakeDynamoDb(), tableName: "state", now: () => NOW });
  await bindings.backfill();
  await bindings.bind(COMPANY_A.orgId, TEAM.A, "operator");
  await bindings.bind(COMPANY_B.orgId, TEAM.B, "operator");
  const { store } = dynamoWorld();
  const members = new Map<string, string>();
  const asked: SlackThreadAnswerInput[] = [];
  const link = async (company: typeof COMPANY_A, team: string, person: string) => {
    members.set(person, company.orgId);
    const actor = { channel: "slack", tenant: team, userId: SHARED_USER };
    const issued = await issueChannelLinkCode({ store, orgId: company.orgId, now: () => NOW }, actor);
    await redeemChannelLinkCode({ store, orgId: company.orgId, now: () => NOW }, person, issued.code);
  };
  const company = {
    workspaces: { ...bindings, store, linkUrl: () => "https://example.test/link", getProject: async (name: string) => (name === "alpha" ? { companyId: COMPANY_A.orgId } : name === "beta" ? { companyId: COMPANY_B.orgId } : undefined) } as never,
    companies: { companyOf: async (person: string) => members.get(person) },
    now: () => NOW,
  };
  const deps = slackAnswerDeps({ company, core: { answerForSlackThread: async (input) => { asked.push(input); return undefined; } } });
  return { deps, link, asked, company };
}

describe("the Slack answer route finds the company and the person from the verified workspace and member", () => {
  it("a linked member is their own company's person, and the same raw Slack id in another workspace is nobody until linked there", async () => {
    const w = await world();
    await w.link(COMPANY_A, TEAM.A, "dev-ada");
    expect(await w.deps.person(TEAM.A, SHARED_USER)).toEqual({ companyId: COMPANY_A.orgId, personId: "dev-ada" });
    expect(await w.deps.person(TEAM.B, SHARED_USER)).toBeUndefined();
    await w.link(COMPANY_B, TEAM.B, "dev-bea");
    expect(await w.deps.person(TEAM.B, SHARED_USER)).toEqual({ companyId: COMPANY_B.orgId, personId: "dev-bea" });
    expect(await w.deps.person(TEAM.A, SHARED_USER)).toEqual({ companyId: COMPANY_A.orgId, personId: "dev-ada" });
  });

  it("an unknown workspace, an unlinked member and a malformed id are nobody, and nothing throws", async () => {
    const w = await world();
    for (const [team, user] of [["T0ZZZZZZZ", SHARED_USER], [TEAM.A, "U0NOBODY00"], ["not-a-team", SHARED_USER], [TEAM.A, "bad id"]] as const) expect(await w.deps.person(team, user)).toBeUndefined();
  });

  it("a project is reachable only through its own company's workspace", async () => {
    const w = await world();
    expect(await w.deps.projectInCompany(TEAM.A, "alpha")).toBe(true);
    expect(await w.deps.projectInCompany(TEAM.A, "beta")).toBe(false);
    expect(await w.deps.projectInCompany(TEAM.B, "alpha")).toBe(false);
    expect(await w.deps.projectInCompany(TEAM.A, "ghost")).toBe(false);
  });

  it("an answer asked in one company's workspace is asked as that company, that person and the bound project, in the Slack thread's own id", async () => {
    const w = await world();
    await w.link(COMPANY_A, TEAM.A, "dev-ada");
    const thread = { teamId: TEAM.A, channelId: "C0BOUND000", threadTs: "1700000000.000100" };
    const result = await askSlackAnswer(w.deps, { thread, userId: SHARED_USER, boundProject: "alpha", taskThread: false, body: { requestId: REQUEST, question: "How long do refunds last?" } });
    expect(result).toEqual({ status: "declined", reason: "not_available" });
    expect(w.asked).toEqual([{ companyId: COMPANY_A.orgId, personId: "dev-ada", project: "alpha", threadId: slackAnswerThreadId(thread), requestId: REQUEST, question: "How long do refunds last?" }]);
  });

  it("a member of company A in a channel bound to company B's project is never asked as either company", async () => {
    const w = await world();
    await w.link(COMPANY_A, TEAM.A, "dev-ada");
    const thread = { teamId: TEAM.A, channelId: "C0BOUND000", threadTs: "1700000000.000100" };
    const result = await askSlackAnswer(w.deps, { thread, userId: SHARED_USER, boundProject: "beta", taskThread: false, body: { requestId: REQUEST, question: "q" } });
    expect(result).toEqual({ status: "declined", reason: "not_available" });
    expect(w.asked).toEqual([]);
  });

  it("with no core answer seam the route declines without asking anyone", async () => {
    const w = await world();
    await w.link(COMPANY_A, TEAM.A, "dev-ada");
    const deps = slackAnswerDeps({ company: w.company, core: undefined });
    const thread = { teamId: TEAM.A, channelId: "C0BOUND000", threadTs: "1700000000.000100" };
    expect(await askSlackAnswer(deps, { thread, userId: SHARED_USER, boundProject: "alpha", taskThread: false, body: { requestId: REQUEST, question: "q" } })).toEqual({ status: "declined", reason: "not_available" });
  });
});
