import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ChannelCommandSchema, IMPLICIT_COMPANY_ID, webhookHeaders, type SlackRequestMessage } from "@agentx/contracts";
import { slackTokens } from "../../packages/testing/src/channel/slack-world.js";
import { createSlackIngressHandler, postSlackMessage } from "../../packages/broker/src/aws/slack-ingress.js";
import { chatPostEphemeral } from "../../packages/broker/src/aws/slack-web.js";
import { createSlackInteractivityHandler, respondEphemeral } from "../../packages/broker/src/aws/slack-interactivity.js";
import { createSlackChannelEventsHandler, createSlackChannelCommandsHandler } from "../../packages/broker/src/aws/slack-adapter.js";
import { processSlackRequest, type ProcessorDependencies } from "../../packages/slack-service/src/slack-processor.js";
import { createBroker, loadSlackBroker, registerSlackProject, SLACK_TEAM, SLACK_CHANNEL, issuer } from "../support/slack-broker.js";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const TEAM = SLACK_TEAM;
const CHANNEL = SLACK_CHANNEL;
const USER = "U0SHARED00";
const TS = "1700000000.000001";
const signingSecret = "workspace-golden-signing-secret";
const adapterSecret = ["whsec", Buffer.alloc(32, 7).toString("base64")].join("_");
const token = slackTokens("golden").bot;
const thread = { teamId: TEAM, channelId: CHANNEL, threadTs: TS };
const conversation = { channel: "slack", tenant: TEAM, space: CHANNEL, thread: TS };

/** Assert the actual credential first, then persist only its label. No token is written to disk or test output. */
function network() {
  const calls: unknown[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    const isWeb = url.pathname.startsWith("/api/");
    if (isWeb) expect(authorization === `Bearer ${token}`).toBe(true);
    const raw = typeof init?.body === "string" ? init.body : "";
    const body: unknown = raw.startsWith("{") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    calls.push({ method: url.pathname.replace("/api/", ""), token: isWeb ? "legacy-bot" : null, body, query: Object.fromEntries(url.searchParams) });
    return new Response(JSON.stringify({ ok: true, ts: TS, channel: CHANNEL,
      user: { id: USER, team_id: TEAM, is_bot: false, deleted: false, profile: { display_name: "Person" } }, channels: [], response_metadata: { next_cursor: "" } }), { status: 200 });
  };
  return { calls, fetchFn };
}

function signed(payload: unknown, form = false) {
  const body = form ? new URLSearchParams({ payload: JSON.stringify(payload) }).toString() : JSON.stringify(payload);
  const timestamp = String(NOW / 1000);
  return { body, headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}` }, requestContext: { http: { method: "POST" } } };
}
function adapterRequest<T extends { id: string }>(payload: T, path: string) {
  const body = JSON.stringify(payload);
  return { body, rawPath: path, headers: webhookHeaders({ secret: adapterSecret, id: payload.id, timestamp: NOW / 1000, body }), requestContext: { http: { method: "POST" } } };
}
function golden(name: string, value: unknown) {
  const bytes = JSON.stringify(value);
  const directory = "tests/fixtures/slack-workspace-goldens";
  const file = `${directory}/${name}.json`;
  // Captured on unchanged R4; the oracle is never updated by a test run.
  expect(bytes).toBe(readFileSync(file, "utf8").trimEnd());
}

beforeAll(async () => { await loadSlackBroker(); });
afterEach(() => vi.useRealTimers());

describe.each([false, true])("Slack workspace byte goldens company=%s", (enabled) => {
  it.each(["accepted", "unbound", "duplicate", "malformed-team", "foreign-team", "thread-reply"])("ingress %s", async (name) => {
    const web = network();
    const claimed = new Set<string>();
    const queue: SlackRequestMessage[] = [];
    const handler = createSlackIngressHandler({
      ...await companyDependencies(enabled),
      secrets: async () => ({ signingSecret, botToken: token }), now: () => NOW,
      getBinding: async (teamId, channelId) => name === "unbound" || teamId !== TEAM ? undefined : { teamId, channelId, projectName: "payments", updatedAt: new Date(NOW).toISOString() },
      claimEvent: async (id) => { if (claimed.has(id)) return false; claimed.add(id); return true; },
      releaseEvent: async (id) => { claimed.delete(id); }, changePending: async () => 1,
      enqueue: async (message) => { queue.push(message); },
      postMessage: async (input) => { await postSlackMessage(token, input, web.fetchFn); },
      postEphemeral: async (input) => { await chatPostEphemeral(token, input, web.fetchFn); },
      threadContinuation: async () => ({ assistant: true }),
    });
    const request = signed({ type: "event_callback", event_id: "EvGOLDEN001", team_id: name === "malformed-team" ? "invalid" : name === "foreign-team" ? "T0FOREIGN" : TEAM,
      event: { type: name === "thread-reply" ? "message" : "app_mention", channel: CHANNEL, user: USER, ts: TS, text: "hello", ...(name === "thread-reply" ? { thread_ts: TS } : {}) } });
    if (name === "duplicate") { await handler(request); web.calls.length = 0; queue.length = 0; }
    const response = await handler(request);
    golden(name, { response, calls: web.calls, queue });
  });

  it.each(["confirm", "cancel"] as const)("admin change %s with admin changes enabled", async (click) => {
    const web = network();
    const presses: unknown[] = [];
    const handler = createSlackInteractivityHandler({ ...await companyDependencies(enabled), secrets: async () => ({ signingSecret, botToken: token }), now: () => NOW, handlers: [],
      adminChange: { press: async (press) => { presses.push(press); } },
      respondEphemeral: (url, text) => respondEphemeral(url, text, web.fetchFn),
    });
    const response = await handler(signed({ type: "block_actions", team: { id: TEAM }, user: { id: USER, team_id: TEAM }, channel: { id: "D0DIRECT00" },
      actions: [{ action_id: `agentx_admin_change_${click}`, value: "11111111-1111-4111-8111-111111111111" }], response_url: "https://hooks.slack.com/actions/T0EXAMPLE/1/example" }, true));
    golden(`${enabled ? "enabled-" : ""}admin-${click}`, { response, calls: web.calls, presses });
  });

  it("model selection", async () => {
    const web = network();
    if (enabled) {
      const selected: unknown[] = [], queue: unknown[] = [];
      const handler = createSlackIngressHandler({ ...await companyDependencies(true), secrets: async () => ({ signingSecret, botToken: token }), now: () => NOW,
        getBinding: async (teamId, channelId) => ({ teamId, channelId, projectName: "payments", updatedAt: new Date(NOW).toISOString() }),
        claimEvent: async () => true, releaseEvent: async () => undefined, changePending: async () => 1, enqueue: async (message) => { queue.push(message); },
        postMessage: async () => undefined, postEphemeral: (input) => chatPostEphemeral(token, input, web.fetchFn) });
      const response = await handler(signed({ type: "event_callback", event_id: "EvGOLDENMODEL", team_id: TEAM,
        event: { type: "app_mention", channel: CHANNEL, user: USER, ts: TS, text: "use fast" } }));
      golden("enabled-use-model", { response, calls: web.calls, selected, queue });
      return;
    }
    const selected: unknown[] = [];
    const options = { projectName: "payments", approved: [{ provider: "amazon-bedrock", modelId: "fast", label: "Fast" }], current: { provider: "amazon-bedrock", modelId: "fast", label: "Fast" }, source: "selection" as const };
    const deps = { api: () => ({ listProjectModels: async () => options, selectProjectModel: async (model: unknown) => { selected.push(model); return options; } }),
      threads: { finish: async () => undefined }, post: async (_thread: unknown, text: string) => { await postSlackMessage(token, { channel: CHANNEL, threadTs: TS, text }, web.fetchFn); },
      runTurn: async () => { throw new Error("unexpected turn"); },
    } as unknown as ProcessorDependencies;
    await processSlackRequest({ version: 1, eventId: "EvGOLDENMODEL", thread, userId: USER, text: "<@U0BOT0000> use fast", receivedAt: new Date(NOW).toISOString() }, deps, { finalAttempt: false });
    golden("use-model", { calls: web.calls, selected });
  });

  it("admin binding PUT", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const { handler } = createBroker({ extra: await companyDependencies(enabled) });
    await registerSlackProject(handler, { bind: false });
    const response = await handler({ version: "2.0", rawPath: `/v1/admin/slack/bindings/${TEAM}/${CHANNEL}`, headers: {}, body: JSON.stringify({ projectName: "payments" }),
      requestContext: { requestId: "golden-binding", http: { method: "PUT" }, authorizer: { jwt: { claims: { iss: issuer, sub: "admin-subject", groups: ["admins"] } } } } });
    golden("binding-put", { response, calls: [] });
  });

  it.each([false, true])("adapter message ephemeral=%s", async (ephemeral) => {
    const web = network();
    const handler = createSlackChannelEventsHandler({ ...await companyDependencies(enabled), secret: async () => adapterSecret, botToken: async () => token, now: () => NOW, fetch: web.fetchFn,
      claim: async () => true, release: async () => undefined, messageTs: { get: async () => undefined, put: async () => undefined } });
    const response = await handler(adapterRequest({ version: 1, id: "evt_goldens1234567890", channel: "slack", type: "message", conversation, createdAt: new Date(NOW).toISOString(),
      data: { text: "Hello from Rovara", ...(ephemeral ? { audience: { kind: "ephemeral", actor: { channel: "slack", tenant: TEAM, userId: USER } } } : {}) } }, "/v1/slack/channel-events"));
    golden(ephemeral ? "adapter-ephemeral" : "adapter-message", { response, calls: web.calls });
  });

  it.each(["user", "spaces"] as const)("adapter command %s", async (kind) => {
    const web = network();
    const handler = createSlackChannelCommandsHandler({ ...await companyDependencies(enabled), secret: async () => adapterSecret, botToken: async () => token, now: () => NOW, fetch: web.fetchFn });
    const response = await handler(adapterRequest({ version: 1, id: "cmd_goldens1234567890", channel: "slack", createdAt: new Date(NOW).toISOString(), kind, tenant: TEAM, ...(kind === "user" ? { userId: USER } : {}) }, "/v1/slack/channel-commands"));
    golden(`command-${kind}`, { response, calls: web.calls });
  });
});


describe("Slack workspace operator events", () => {
  const company = "org_aaaaaaaaaaaaaaaaaaaa";
  const other = "org_bbbbbbbbbbbbbbbbbbbb";
  const bind = { source: "agentx.slack-workspace-bind", teamId: TEAM, companyId: company, by: "operator" };
  it("requires backfill, claims once, and refuses a competing company with fixed bytes", async () => {
    const { handler, db } = createBroker();
    const before = await handler(bind);
    expect(before.statusCode).toBe(404);
    expect(before.body).toBe(JSON.stringify({ outcome: "refused", requestId: "slack-workspace" }));
    expect(await handler({ source: "agentx.slack-workspace-backfill" })).toMatchObject({ statusCode: 200, body: JSON.stringify({ outcome: "backfilled", teamsRead: 0, requestId: "slack-workspace" }) });
    expect(await handler(bind)).toMatchObject({ statusCode: 200, body: JSON.stringify({ outcome: "bound", requestId: "slack-workspace" }) });
    const writes = db.commandNames().filter((name) => name === "PutCommand").length;
    expect((await handler(bind)).statusCode).toBe(200);
    expect(db.commandNames().filter((name) => name === "PutCommand")).toHaveLength(writes);
    expect(await handler({ ...bind, companyId: other })).toEqual(before);
    expect(db.get(`SLACK_TEAM#${TEAM}`, "BINDING")?.companyId).toBe(company);
  });
  it("rejects malformed operator events before storage and never echoes fields", async () => {
    for (const event of [
      { ...bind, teamId: null }, { ...bind, companyId: "private-company" }, { ...bind, by: "private operator text" },
      { ...bind, extra: "private-marker" }, { source: bind.source },
      { source: "agentx.slack-workspace-backfill", extra: "private-marker" },
    ]) {
      const { handler, db } = createBroker();
      expect(await handler(event)).toMatchObject({ statusCode: 404, body: JSON.stringify({ outcome: "refused", requestId: "slack-workspace" }) });
      expect(db.commandNames()).toHaveLength(0);
    }
  });
  it("returns the same fixed refusal on storage failure without logging its cause", async () => {
    const { handler, db } = createBroker();
    vi.spyOn(db, "send").mockRejectedValue(new Error("private-storage-cause"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await handler({ source: "agentx.slack-workspace-backfill" })).toMatchObject({ statusCode: 404, body: JSON.stringify({ outcome: "refused", requestId: "slack-workspace" }) });
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it("acknowledges a verified app_uninstalled / tokens_revoked with 200 and touches no storage while the install is not wired; a malformed one is still refused", async () => {
    for (const reason of ["app_uninstalled", "tokens_revoked"] as const) {
      const { handler, db } = createBroker();
      const event = { source: "agentx.slack-workspace-removed", teamId: TEAM, reason, eventTime: 1_800_000_000 };
      expect(await handler(event)).toMatchObject({ statusCode: 200, body: JSON.stringify({ outcome: "ignored", requestId: "slack-workspace" }) });
      expect(db.commandNames()).toHaveLength(0);
      expect(await handler({ ...event, extra: "x" })).toMatchObject({ statusCode: 404, body: JSON.stringify({ outcome: "refused", requestId: "slack-workspace" }) });
      expect(await handler({ ...event, teamId: null })).toMatchObject({ statusCode: 404 });
    }
  });
  it("uses the configured legacy team for operator backfill", async () => {
    const { handler, db } = createBroker({ extra: { slackWorkspaceLegacyTeamId: TEAM } });
    expect(await handler({ source: "agentx.slack-workspace-backfill" })).toMatchObject({ statusCode: 200, body: JSON.stringify({ outcome: "backfilled", teamsRead: 1, requestId: "slack-workspace" }) });
    expect(db.get(`SLACK_TEAM#${TEAM}`, "BINDING")?.companyId).toBe(IMPLICIT_COMPANY_ID);
  });
});


describe("workspace-bearing channel commands", () => {
  const commands = [
    { kind: "update_form", handle: "V0FORM", form: { title: "Connect", submitLabel: "Save", formId: "connect", parts: [] } },
    { kind: "delete_document", documentId: "F0123456789" },
    { kind: "check" },
  ];
  const base = { version: 1, id: "cmd_workspace123456789", channel: "slack", createdAt: new Date(NOW).toISOString() };
  it.each(commands)("accepts optional tenant with the existing schema: $kind", (command) => {
    expect(ChannelCommandSchema.safeParse({ ...base, ...command }).success).toBe(true);
    expect(ChannelCommandSchema.safeParse({ ...base, ...command, tenant: TEAM }).success).toBe(true);
    for (const tenant of [null, 1, {}, "", "x".repeat(257), "bad\nteam"]) {
      const reference = ChannelCommandSchema.safeParse({ ...base, kind: "update_message", tenant, space: CHANNEL, messageId: TS, message: { text: "hi" } }).success;
      expect(ChannelCommandSchema.safeParse({ ...base, ...command, tenant }).success).toBe(reference);
    }
  });
  it.each(commands)("refuses missing/unknown workspace without legacy token: $kind", async (command) => {
    const legacy = vi.fn(async () => token);
    const web = network();
    const workspaces = { requireCompany: async (team: string) => { if (team !== TEAM) throw Error("private"); return IMPLICIT_COMPANY_ID; },
      tokenForEvent: async (team: string) => team === TEAM ? { companyId: IMPLICIT_COMPANY_ID, token } : undefined };
    const handler = createSlackChannelCommandsHandler({ secret: async () => adapterSecret, botToken: legacy, now: () => NOW, fetch: web.fetchFn, ...{ workspaces } });
    for (const tenant of [undefined, "T0FOREIGN"]) {
      const response = await handler(adapterRequest({ ...base, ...command, ...(tenant === undefined ? {} : { tenant }) }, "/v1/slack/channel-commands"));
      expect(JSON.parse(response.body)).toEqual({ ok: false, error: { code: "workspace_unavailable", message: "This Slack workspace is not available." } });
    }
    for (const result of [{ companyId: "org_bbbbbbbbbbbbbbbbbbbb", token }, { companyId: IMPLICIT_COMPANY_ID, token: "malformed" }]) {
      const mismatched = createSlackChannelCommandsHandler({ secret: async () => adapterSecret, botToken: legacy, now: () => NOW, fetch: web.fetchFn,
        workspaces: { ...workspaces, tokenForEvent: async () => result } });
      const response = await mismatched(adapterRequest({ ...base, ...command, tenant: TEAM }, "/v1/slack/channel-commands"));
      expect(JSON.parse(response.body)).toEqual({ ok: false, error: { code: "workspace_unavailable", message: "This Slack workspace is not available." } });
    }
    expect(legacy).not.toHaveBeenCalled(); expect(web.calls).toEqual([]);
  });
});

import { createSlackWorkspaceBindings } from "../../packages/broker/src/aws/slack-workspace-binding.js";
import { createSlackWorkspaceTokens } from "../../packages/broker/src/aws/slack-workspace-tokens.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
async function companyDependencies(enabled: boolean) {
  if (!enabled) return {};
  const bindings = createSlackWorkspaceBindings({ client: new FakeDynamoDb(), tableName: "state", legacyTeamId: TEAM, now: () => NOW });
  await bindings.backfill();
  const tokens = createSlackWorkspaceTokens({ bindings, environment: "test", legacyTeamId: TEAM, legacyToken: async () => token, readSecret: async () => undefined, now: () => NOW });
  return { workspaces: { ...bindings, ...tokens, store: new MemoryDocumentStore(), getProject: async () => ({}), linkUrl: (code: string) => `https://example.test/review/link/${code}` },
    companies: { companyOf: async (id: string) => id === developerIdForSlackUser(USER) ? IMPLICIT_COMPANY_ID : undefined } };
}

it("company check refuses a token's mismatched Slack workspace with fixed words", async () => {
  const web = network(), legacy = vi.fn(async () => token);
  const handler = createSlackChannelCommandsHandler({ ...await companyDependencies(true), secret: async () => adapterSecret, botToken: legacy, now: () => NOW,
    fetch: async () => new Response(JSON.stringify({ ok: true, team_id: "T0FOREIGN" })) });
  const response = await handler(adapterRequest({ version: 1, id: "cmd_workspace123456789", channel: "slack", createdAt: new Date(NOW).toISOString(), kind: "check", tenant: TEAM }, "/v1/slack/channel-commands"));
  expect(JSON.parse(response.body)).toEqual({ ok: false, error: { code: "workspace_unavailable", message: "This Slack workspace is not available." } });
  expect(legacy).not.toHaveBeenCalled(); expect(web.calls).toEqual([]);
});

it.each([
  { kind: "update_form", handle: "V0FORM", form: { title: "Connect", submitLabel: "Save", formId: "connect", parts: [] } },
  { kind: "delete_document", documentId: "F0123456789" },
  { kind: "check" },
])("absent tenant retains command bytes: $kind", async (command) => {
  const calls: unknown[] = [];
  const handler = createSlackChannelCommandsHandler({ secret: async () => adapterSecret, botToken: async () => token, now: () => NOW,
    fetch: async (url, init) => { expect(new Headers(init?.headers).get("authorization") === `Bearer ${token}`).toBe(true);
      calls.push({ method: new URL(url instanceof Request ? url.url : url.toString()).pathname, body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown, token: "legacy-bot" });
      return new Response(JSON.stringify({ ok: true, team_id: TEAM })); } });
  const response = await handler(adapterRequest({ version: 1, id: "cmd_workspace123456789", channel: "slack", createdAt: new Date(NOW).toISOString(), ...command }, "/v1/slack/channel-commands"));
  golden(`absent-${command.kind}`, { response, calls });
});
