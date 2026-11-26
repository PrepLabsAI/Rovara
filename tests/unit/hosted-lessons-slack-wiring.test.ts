// Lead 4 L4-HW8 (2): on a deployed install the lessons' Slack source reads a task's own thread through the signed webhook command path that already exists (the built-in Slack adapter's commands route,
// aws/channel-commands.ts -> aws/slack-adapter.ts), company-scoped and `thread_messages` only. Here the adapter's REAL command route runs over one fake Slack, and the reader and the capture are the real ones
// (core/channel/thread-replies.ts, core-host/app/lessons-sources.ts); only the deployment's secret store, workspace bindings and network are fakes.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { IMPLICIT_COMPANY_ID, OrgIdSchema, generateWebhookSecret, type JsonValue, type OrgId } from "@agentx/contracts";
import { hostedLessonsSlack, hostedSlackCompanyOf } from "../../packages/broker/src/aws/hosted-slack-thread.js";
import { createSlackChannelCommandsHandler } from "../../packages/broker/src/aws/slack-adapter.js";
import { bindChannelSpace, issueChannelLinkCode, recordTaskThread, redeemChannelLinkCode } from "../../packages/broker/src/core/channel/index.js";
import { taskSessionId } from "../../packages/broker/src/core/sessions/create.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import type { HostedLessonPeople } from "../../packages/broker/src/lessons/hosted-people.js";
import { slackThreadSource } from "../../packages/broker/src/lessons/slack-wiring.js";
import { InMemoryLessonStore } from "../../packages/broker/src/lessons/store.js";
import { createLocalLessonSources } from "../../packages/broker/src/core-host/app/lessons-sources.js";
import type { LessonRepositories } from "../../packages/broker/src/core-host/app/lessons-repos.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";

const A = OrgIdSchema.parse("org_aaaaaaaaaaaaaaaaaaaa");
const B = OrgIdSchema.parse("org_bbbbbbbbbbbbbbbbbbbb");
const TEAM_A = "T0123456789";
const TEAM_B = "T0999999999";
const SPACE = "C0123456789";
const THREAD = "1700000000.000100";
const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const SAY = "Use the shared retry helper instead of writing a new retry loop by hand.";
const SECRET = generateWebhookSecret();
const ENV = {
  SLACK_VIA_CHANNEL: "enabled", BUILT_IN_ADAPTER: "enabled", BUILT_IN_ADAPTER_CHANNEL: "slack",
  BUILT_IN_ADAPTER_CALLBACK_URL: "https://api.example.com/v1/slack/channel-events", BUILT_IN_ADAPTER_COMMANDS_URL: "https://api.example.com/v1/slack/channel-commands",
  BUILT_IN_ADAPTER_SECRET_NAME: "agentx/test/channel-adapter/slack",
} as NodeJS.ProcessEnv;
const urlOf = (url: string | URL | Request): string => (url instanceof Request ? url.url : url.toString());
const bound: Record<string, OrgId> = { [TEAM_A]: A, [TEAM_B]: B };
const workspaces = { requireCompany: async (team: string) => { const company = bound[team]; if (company === undefined) throw new Error("This Slack workspace is not available."); return company; } };

function wire(over: { env?: NodeJS.ProcessEnv; workspaces?: typeof workspaces | undefined; legacyTeamId?: string; secret?: string | undefined } = {}) {
  const slackCalls: string[] = [];
  let tenantNow = TEAM_A;
  const posts: Array<{ url: string; kind: string; signed: boolean; tenant?: string }> = [];
  const slack = vi.fn<typeof fetch>(async (url) => {
    const parsed = new URL(urlOf(url));
    slackCalls.push(parsed.pathname.replace("/api/", ""));
    if (parsed.pathname.endsWith("conversations.info")) return new Response(JSON.stringify({ ok: true, channel: { is_channel: true, is_private: false, is_im: false, is_mpim: false, is_shared: false, is_ext_shared: false, is_org_shared: false } }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, messages: [{ ts: "1700000001.000100", thread_ts: THREAD, user: "U0000000001", team: tenantNow, user_team: tenantNow, text: SAY }] }), { status: 200 });
  });
  const handler = createSlackChannelCommandsHandler({ secret: async () => SECRET, botToken: async () => "xoxb-test", fetch: slack, now: () => NOW });
  const secretsManager = { send: vi.fn(async (command: unknown) => {
    if (!(command instanceof GetSecretValueCommand)) throw new Error("only a secret read");
    if (over.secret === undefined && "secret" in over) throw new Error("ResourceNotFoundException");
    return { SecretString: over.secret ?? SECRET };
  }) };
  const network = vi.fn<typeof fetch>(async (url, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const parsed = JSON.parse(body) as { kind: string; tenant?: string };
    if (parsed.tenant !== undefined) tenantNow = parsed.tenant;
    posts.push({ url: urlOf(url), kind: parsed.kind, signed: Object.keys(init?.headers ?? {}).some((name) => name.toLowerCase() === "webhook-signature"), ...(parsed.tenant === undefined ? {} : { tenant: parsed.tenant }) });
    const response = await handler({ rawPath: new URL(urlOf(url)).pathname, body, headers: init?.headers as Record<string, string>, requestContext: { http: { method: "POST" } } });
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  });
  const factory = hostedLessonsSlack({ env: over.env ?? ENV, secretsManager, workspaces: "workspaces" in over ? over.workspaces : workspaces, legacyTeamId: over.legacyTeamId ?? TEAM_A, fetch: network, checkAddresses: async () => undefined, now: () => NOW });
  return { factory, slackCalls, posts, network, secretsManager };
}

function people(roster: Record<string, string[]>): HostedLessonPeople {
  return {
    async approvers() { return { complete: true, membershipVersion: 1, ownerIds: [], eligibleIds: [], lastEligibleLossAtMs: null }; },
    async onProjectRoster(c, project, person) { return (roster[`${c}/${project}`] ?? []).includes(person); },
    async linkedAccounts() { return []; }, async displayName() { return undefined; }, async isErased() { return false; },
  };
}

/** Two companies' ended tasks, each started in a thread of that company's own Slack workspace, bound to "payments"; the in-process registry has NO Slack adapter (as on the deployed install). */
async function world(factory: ReturnType<typeof wire>["factory"]) {
  const store = new MemoryDocumentStore();
  const lessonStore = new InMemoryLessonStore();
  const registry = { get: () => undefined } as never;
  const teamOf = (org: OrgId) => (org === A ? TEAM_A : TEAM_B);
  const deps = (org: OrgId) => ({ store, orgId: org, now: () => NOW });
  for (const org of [A, B]) {
    const taskId = `task-${org}`;
    await store.put({ item: { ...taskKey(taskId), entityType: "DEVTASK", taskId, companyId: org, project: "payments", developerId: "ann", startingRevision: 1, title: "t", requestText: "Add a retry to the sync",
      workflow: { revision: 3, artifacts: [], reviews: [], pullRequests: [], outcome: "MERGED", decisions: [] as JsonValue[] } } });
    await recordTaskThread(deps(org), { sessionId: taskSessionId(taskId), conversation: { channel: "slack", tenant: teamOf(org), space: SPACE, thread: THREAD }, personId: "ann" });
    await bindChannelSpace(deps(org), { channel: "slack", tenant: teamOf(org), space: SPACE }, "payments");
    const { code } = await issueChannelLinkCode(deps(org), { channel: "slack", tenant: teamOf(org), userId: "U0000000001" });
    await redeemChannelLinkCode(deps(org), "ann", code);
  }
  const roster = { [`${A}/payments`]: ["ann"], [`${B}/payments`]: ["ann"] };
  const wiring = (org: OrgId, as: OrgId = org) => {
    const slack = factory?.(as);
    return slackThreadSource({ store, companyId: org, registry, companyOf: slack?.companyOf, sendCommand: slack?.command, now: () => NOW, lessonStore: () => lessonStore });
  };
  const spansOf = async (org: OrgId, as: OrgId = org) => {
    const sources = createLocalLessonSources({ flow: { store, projects: undefined as never }, companyId: org, ownerId: "local-owner", repos: { ofProject: async () => [], ofTask: async () => undefined } as unknown as LessonRepositories, now: () => NOW,
      hosted: { people: people(roster) }, slack: wiring(org, as) });
    return ((await sources.source.read({ workspaceId: org, taskId: `task-${org}` }))?.facts.rest.spans ?? []).filter((span) => span.kind === "slack_reply");
  };
  return { spansOf, wiring };
}

describe("the deployed install reads a task's Slack thread through the signed command path", () => {

  it("company B's task reads company B's workspace; neither company's factory ever sends a command for the other's workspace", async () => {
    const w = wire();
    const world1 = await world(w.factory);
    expect(await world1.spansOf(B)).toHaveLength(1);
    expect(w.posts.map((post) => post.tenant)).toEqual([TEAM_B]);
    // Company A's command function asked about company B's workspace (a mistake upstream): refused before it is sent.
    const factory = w.factory!;
    await expect(factory(A).command({ tenant: TEAM_B, space: SPACE, thread: THREAD })).rejects.toThrow("not this company's");
    await expect(factory(B).command({ tenant: TEAM_A, space: SPACE, thread: THREAD })).rejects.toThrow("not this company's");
    expect(w.posts).toHaveLength(1);
  });

  it("an unbound workspace is nobody's: no command is sent and the task goes on with no Slack source", async () => {
    const w = wire({ workspaces: { requireCompany: async () => { throw new Error("This Slack workspace is not available."); } } });
    const world1 = await world(w.factory);
    expect(await world1.spansOf(A)).toEqual([]);
    expect(w.posts).toEqual([]);
    expect(w.network).not.toHaveBeenCalled();
  });

  it("an unreadable signing secret sends nothing and reads nothing from Slack; the task goes on with no Slack source", async () => {
    const w = wire({ secret: undefined });
    const world1 = await world(w.factory);
    await expect(w.factory!(A).command({ tenant: TEAM_A, space: SPACE, thread: THREAD })).rejects.toThrow();
    expect(await world1.spansOf(A)).toEqual([]);
    expect(w.posts).toEqual([]);
    expect(w.slackCalls).toEqual([]);
  });
});

describe("off by default, fail closed", () => {
  const without = (name: string): NodeJS.ProcessEnv => { const env = { ...ENV }; delete env[name]; return env; };
  it.each([
    ["Slack not through the channel API", without("SLACK_VIA_CHANNEL")],
    ["no built-in adapter", without("BUILT_IN_ADAPTER")],
    ["no commands URL", without("BUILT_IN_ADAPTER_COMMANDS_URL")],
    ["no secret name", without("BUILT_IN_ADAPTER_SECRET_NAME")],
    ["another channel", { ...ENV, BUILT_IN_ADAPTER_CHANNEL: "teams" }],
  ])("gives no command: %s", async (_name, env) => {
    const w = wire({ env });
    expect(w.factory).toBeUndefined();
    const world1 = await world(w.factory);
    expect(await world1.spansOf(A)).toEqual([]);
    expect(w.network).not.toHaveBeenCalled();
    expect(w.secretsManager.send).not.toHaveBeenCalled();
  });
});

describe("which company a Slack workspace is", () => {
  it("without company mode, only the install's own team, and it is the implicit company's; never every tenant", async () => {
    const companyOf = hostedSlackCompanyOf({ workspaces: undefined, legacyTeamId: TEAM_A });
    expect(await companyOf({ channel: "slack", tenant: TEAM_A })).toBe(IMPLICIT_COMPANY_ID);
    expect(await companyOf({ channel: "slack", tenant: TEAM_B })).toBeUndefined();
    expect(await hostedSlackCompanyOf({ workspaces: undefined, legacyTeamId: undefined })({ channel: "slack", tenant: TEAM_A })).toBeUndefined();
    expect(await hostedSlackCompanyOf({ workspaces: undefined, legacyTeamId: "bad" })({ channel: "slack", tenant: "bad" })).toBeUndefined();
  });
});

describe("the broker and the core root hand the Slack source over", () => {
  const brokerSource = readFileSync(new URL("../../packages/broker/src/aws/broker.ts", import.meta.url), "utf8");
  const call = brokerSource.slice(brokerSource.indexOf("const coreRoot = createBrokerCoreRoot({"));
  const body = call.slice(0, call.indexOf("builtCoreRoot = coreRoot;"));
  const rootSource = readFileSync(new URL("../../packages/broker/src/aws/core-engine-root.ts", import.meta.url), "utf8");
  it("the broker passes lessonsSlack from the deployment's adapter, its secrets client, the company-mode bindings and the install's team", () => {
    expect(body).toMatch(/lessonsSlack: slack[\s\S]*hostedLessonsSlack\(\{ env: process\.env, secretsManager, workspaces: slackCompany\?\.workspaces, legacyTeamId: process\.env\.SLACK_TEAM_ID \|\| process\.env\.SLACK_ADAPTER_TEAM_ID \}\)/u);
  });
  it("the core root gives each company's lessons its own company map and command", () => {
    expect(rootSource).toMatch(/channelCompanyOf: slack\.companyOf, slackThreadCommand: slack\.command \}\)\)\(inputs\.lessonsSlack\?\.\(companyId\)\)/u);
  });
});
