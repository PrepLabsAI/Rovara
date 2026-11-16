// Real workspace directory, core links, ingress and adapter delivery over in-process doubles.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, SlackTeamIdSchema, SlackChannelIdSchema, SlackUserIdSchema } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B, assertSurfacesIsolated, assertFailsClosed, attempt, createCompanySecretStore, type IsolationSurface } from "../../packages/testing/src/isolation/index.js";
import { slackTokens } from "../../packages/testing/src/channel/slack-world.js";
import { createSlackWorkspaceBindings } from "../../packages/broker/src/aws/slack-workspace-binding.js";
import { createSlackWorkspaceTokens } from "../../packages/broker/src/aws/slack-workspace-tokens.js";
import { createSlackPersonResolver } from "../../packages/broker/src/aws/slack-person.js";
import { issueChannelLinkCode, redeemChannelLinkCode } from "../../packages/broker/src/core/channel/links.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { dynamoWorld } from "../support/ports/dynamodb-harness.js";
const TEAMS = { A: "T0AAAAAAA", B: "T0BBBBBBB" };
const SHARED = { channel: "C0SHARED00", user: "U0SHARED00", thread: "1700000000.000001" };
const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const companies = [COMPANY_A, COMPANY_B] as const;
async function surfaces(leakToken = false): Promise<IsolationSurface[]> {
  const bindings = createSlackWorkspaceBindings({ client: new FakeDynamoDb(), tableName: "state", now: () => NOW });
  await bindings.backfill();
  const secrets = createCompanySecretStore();
  for (const company of companies) {
    await bindings.bind(company.orgId, TEAMS[company.label], "operator");
    secrets.set(company.orgId, { env: TEAMS[company.label] }, JSON.stringify({ botToken: slackTokens(company.label).bot }));
  }
  const tokens = createSlackWorkspaceTokens({ bindings, environment: "test", now: () => NOW, readSecret: async (name) => {
    const parts = name.split("/");
    const secret = await secrets.read(parts[3]!, { env: parts[4]! });
    return secret?.reveal();
  } });
  const { store } = dynamoWorld();
  const people = new Map<string, string>();
  const resolve = createSlackPersonResolver({ workspaces: bindings, store, now: () => NOW, companies: { companyOf: async (person) => people.get(person) } });
  const marker = (token: string | undefined) => companies.find((company) => token === slackTokens(company.label).bot)?.canary;
  return [
    { name: "operator claims one workspace once", kind: "write", plant: async (me) => ({ handle: TEAMS[me.label], markers: [me.orgId] }), observe: async (me, pair) => ({ own: await bindings.requireCompany(String(pair.own)), claimOther: await attempt(() => bindings.bind(me.orgId, String(pair.other), "operator")) }) },
    { name: "per-workspace secret and cache", kind: "secret", plant: async (me) => ({ handle: TEAMS[me.label] }), observe: (me, pair) => secrets.actingFor(me.orgId, async () => ({ own: marker(await tokens.tokenForCompany(me.orgId, String(pair.own))), other: marker(leakToken ? (await tokens.tokenForEvent(String(pair.other)))?.token : await tokens.tokenForCompany(me.orgId, String(pair.other))) })) },
    { name: "shared Slack user links remain in their workspace", kind: "read", plant: async (me) => {
      people.set(me.canary, me.orgId);
      const actor = { channel: "slack", tenant: TEAMS[me.label], userId: SHARED.user };
      const code = await issueChannelLinkCode({ store, orgId: me.orgId, now: () => NOW }, actor);
      await redeemChannelLinkCode({ store, orgId: me.orgId, now: () => NOW }, me.canary, code.code);
      return { handle: actor };
    }, observe: (me) => resolve({ teamId: TEAMS[me.label], userId: SHARED.user }) },
  ];
}

describe("T4a primitive isolation through real stores and core links", () => {
  it("uses Slack-valid ids shared across companies except their bound teams", () => {
    for (const team of Object.values(TEAMS)) expect(SlackTeamIdSchema.safeParse(team).success).toBe(true);
    expect(SlackChannelIdSchema.safeParse(SHARED.channel).success).toBe(true);
    expect(SlackUserIdSchema.safeParse(SHARED.user).success).toBe(true);
  });
  it("keeps conditional claims, secrets and core links separate", async () => { await assertSurfacesIsolated(await surfaces()); });
  it("detects a token reader that ignores the asking company (kit self-proof)", async () => {
    // Prime both caches before observing cross-reads: even when no remote read occurs, a leaked cached token fails.
    const set = await surfaces(true);
    const secret = set[1]!;
    await secret.observe(COMPANY_A, { own: TEAMS.A, other: TEAMS.A, byCompany: TEAMS });
    await secret.observe(COMPANY_B, { own: TEAMS.B, other: TEAMS.B, byCompany: TEAMS });
    await expect(assertSurfacesIsolated(set)).rejects.toThrow(/marker/);
  });
  it("detects a company resolver that turns failure into the implicit company (kit self-proof)", async () => {
    const probe = (fallback: boolean) => [{ name: "implicit fallback", prepare: async () => undefined, attempt: async (mode: "throws" | "undefined") => {
      const tokens = createSlackWorkspaceTokens({ environment: "test", bindings: { requireCompany: async () => {
        if (fallback) return IMPLICIT_COMPANY_ID;
        if (mode === "throws") throw new Error("private cause");
        return undefined as unknown as string;
      } }, readSecret: async () => JSON.stringify({ botToken: slackTokens("A").bot }) });
      return (await tokens.tokenForEvent(TEAMS.A)) === undefined ? undefined : COMPANY_A.canary;
    } }];
    await assertFailsClosed(probe(false));
    await expect(assertFailsClosed(probe(true))).rejects.toThrow(/marker/);
  });
  it("fails closed on an unavailable company lookup or secret", async () => {
    await assertFailsClosed([{ name: "workspace token", prepare: async () => undefined, attempt: async (mode) => {
      const token = createSlackWorkspaceTokens({ environment: "test", bindings: { requireCompany: async () => { if (mode === "throws") throw new Error("private cause"); return undefined as unknown as string; } }, readSecret: async () => JSON.stringify({ botToken: slackTokens("A").bot }) });
      return (await token.tokenForEvent(TEAMS.A)) === undefined ? undefined : COMPANY_A.canary;
    } }]);
  });
});

import { createHmac } from "node:crypto";
import { createSlackIngressHandler } from "../../packages/broker/src/aws/slack-ingress.js";
import { slackCompanyToken } from "../../packages/broker/src/aws/slack-person.js";

async function hostedSurfaces(wrongEnvelope = false): Promise<IsolationSurface[]> {
  const bindings = createSlackWorkspaceBindings({ client: new FakeDynamoDb(), tableName: "state", now: () => NOW });
  await bindings.backfill();
  const { store } = dynamoWorld(); const members = new Map<string, string>(); const secrets = createCompanySecretStore();
  for (const me of companies) {
    await bindings.bind(me.orgId, TEAMS[me.label], "operator");
    secrets.set(me.orgId, { env: TEAMS[me.label] }, JSON.stringify({ botToken: slackTokens(me.label).bot }));
    members.set(me.canary, me.orgId);
    const actor = { channel: "slack", tenant: TEAMS[me.label], userId: SHARED.user };
    const issued = await issueChannelLinkCode({ store, orgId: me.orgId, now: () => NOW }, actor);
    await redeemChannelLinkCode({ store, orgId: me.orgId, now: () => NOW }, me.canary, issued.code);
  }
  const tokens = createSlackWorkspaceTokens({ bindings, environment: "test", now: () => NOW, readSecret: async (name) => {
    const parts = name.split("/"); return (await secrets.read(parts[3]!, { env: parts[4]! }))?.reveal();
  } });
  await tokens.tokenForEvent(TEAMS.A); await tokens.tokenForEvent(TEAMS.B);
  const deps = { workspaces: { ...bindings, ...tokens, store, linkUrl: () => "https://example.test/link", getProject: async (name: string) => ({ companyId: name === "project-a" ? COMPANY_A.orgId : COMPANY_B.orgId }) }, companies: { companyOf: async (id: string) => members.get(id) } };
  return [{ name: "signed ingress routes and replies to only the owning company", kind: "read", plant: async (me) => ({ handle: TEAMS[me.label] }), observe: (me, pair) => secrets.actingFor(me.orgId, async () => {
    const sent: string[] = [], queued: string[] = [], projects: string[] = [];
    const handler = createSlackIngressHandler({ ...deps, secrets: async () => ({ signingSecret: "hosted-signature", botToken: slackTokens("legacy").bot }), now: () => NOW,
      getBinding: async (teamId, channelId) => { const owner = companies.find((c) => TEAMS[c.label] === teamId)!; projects.push(owner.canary); return { teamId, channelId, projectName: owner.label === "A" ? "project-a" : "project-b", updatedAt: new Date(NOW).toISOString() }; },
      claimEvent: async () => true, releaseEvent: async () => undefined, changePending: async () => 1,
      enqueue: async (message) => { queued.push(message.thread.teamId); },
      postMessage: async () => { const token = await slackCompanyToken(deps, async () => slackTokens("legacy").bot); sent.push(companies.find((c) => token === slackTokens(c.label).bot)!.canary); },
    });
    // wrongEnvelope simulates a router replacing the verified team with a foreign event-body team.
    const payload = { type: "event_callback", team_id: wrongEnvelope ? pair.other : pair.own, event_id: "EvSHAREDHOSTED", event: { type: "app_mention", channel: SHARED.channel, user: SHARED.user, ts: SHARED.thread, text: "hello" } };
    const body = JSON.stringify(payload), timestamp = String(NOW / 1000);
    const response = await handler({ body, headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${createHmac("sha256", "hosted-signature").update(`v0:${timestamp}:${body}`).digest("hex")}` } });
    return { response, sent, queued, projects };
  }) }];
}
it("isolates real signed ingress, channel binding and reply tokens with shared raw ids", async () => {
  await assertSurfacesIsolated(await hostedSurfaces());
});
it("detects an ingress that substitutes the nested event team for the verified envelope (kit self-proof)", async () => {
  await expect(assertSurfacesIsolated(await hostedSurfaces(true))).rejects.toThrow();
});
