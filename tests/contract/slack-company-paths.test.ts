import { createHmac, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { orgChannelLinkKey, webhookHeaders } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createSlackIngressHandler } from "../../packages/broker/src/aws/slack-ingress.js";
import { createSlackInteractivityHandler } from "../../packages/broker/src/aws/slack-interactivity.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { slackTokens } from "../../packages/testing/src/channel/slack-world.js";
import { createBroker, loadSlackBroker, call, orchestratorPrincipal, SLACK_TEAM, SLACK_CHANNEL } from "../support/slack-broker.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const TEAM = "T0AAAAAAA", OTHER = "T0BBBBBBB", USER = "U0SHARED00", CHANNEL = "C0SHARED00", TS = "1700000000.000001";
const NOW = Date.parse("2026-11-15T12:00:00.000Z"), SECRET = "company-path-signature";
const WEB = "That needs a web sign-in. Open it in Rovara.";
const thread = { teamId: TEAM, channelId: CHANNEL, threadTs: TS };
const native = developerIdForSlackUser(USER), person = "a".repeat(64);
function signed(payload: unknown, form = false) {
  const body = form ? new URLSearchParams({ payload: JSON.stringify(payload) }).toString() : JSON.stringify(payload);
  const timestamp = String(NOW / 1000);
  return { body, headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${createHmac("sha256", SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}` }, requestContext: { http: { method: "POST" } } };
}
function world() {
  const store = new MemoryDocumentStore();
  const members = new Map([[native, A]]);
  const tokens = vi.fn(async (team: string) => ({ companyId: team === TEAM ? A : B, token: slackTokens(team).bot }));
  const workspaces = { store, getProject: async () => ({ companyId: A }), linkUrl: (code: string) => `https://example.test/review/link/${code}`,
    requireCompany: async (team: string): Promise<string> => { if (![TEAM, OTHER].includes(team)) throw Error("private-directory-cause"); return team === TEAM ? A : B; }, tokenForEvent: tokens };
  return { store, members, tokens, workspaces, companies: { companyOf: async (id: string) => members.get(id) } };
}
function ingress(w = world()) {
  const claim = vi.fn(async () => true), queue = vi.fn(async () => undefined), pending = vi.fn(async () => 1), notice = vi.fn<(input: { user: string; text: string }) => Promise<void>>(async () => undefined), post = vi.fn(async () => undefined);
  const deps = { ...w, secrets: async () => ({ signingSecret: SECRET, botToken: slackTokens("legacy").bot }), now: () => NOW,
    getBinding: async (teamId: string, channelId: string) => ({ teamId, channelId, projectName: "payments", updatedAt: new Date(NOW).toISOString() }),
    claimEvent: claim, releaseEvent: vi.fn(), changePending: pending, enqueue: queue, postMessage: post, postEphemeral: notice,
    stopTask: vi.fn(), chatgpt: vi.fn(async () => ({ ok: true as const, value: {} })), threadContinuation: async () => ({ assistant: true }) };
  // Optional company dependencies are deliberately present even before implementation.
  const handler = createSlackIngressHandler(deps as Parameters<typeof createSlackIngressHandler>[0]);
  const send = (text = "hello", team = TEAM, kind = "app_mention") => handler(signed({ type: "event_callback", event_id: "EvCOMPANYPATH", team_id: team,
    event: { type: kind, channel: CHANNEL, user: USER, ts: TS, thread_ts: TS, text } }));
  return { ...w, deps, claim, queue, pending, notice, post, send };
}

describe("company Slack entry points", () => {
  it("unknown workspace refuses before token, event claim, queue or diagnostic ids", async () => {
    const h = ingress(); const result = await h.send("hello", "T0UNKNOWN");
    expect(result.body).toBe('{"ok":true}');
    expect(h.tokens).not.toHaveBeenCalled(); expect(h.claim).not.toHaveBeenCalled(); expect(h.queue).not.toHaveBeenCalled();
  });
  it("foreign project refuses before event claim", async () => {
    const w = world(); w.workspaces.getProject = async () => ({ companyId: B }); const h = ingress(w);
    expect((await h.send()).body).toBe('{"ok":true}'); expect(h.claim).not.toHaveBeenCalled();
  });
  it.each(["hello", "stop", "connect chatgpt", "<@U0BOT0000> use fast"])("unlinked %s only gets one private link notice", async (text) => {
    const h = ingress(); h.members.clear();
    await h.send(text); await h.send(text);
    expect(h.claim).not.toHaveBeenCalled(); expect(h.queue).not.toHaveBeenCalled(); expect(h.pending).not.toHaveBeenCalled(); expect(h.post).not.toHaveBeenCalled();
    expect(h.notice).toHaveBeenCalledTimes(1); expect(h.notice.mock.calls[0]?.[0].user).toBe(USER); expect(h.notice.mock.calls[0]?.[0].text).toContain("link your account: Open in Rovara");
  });
  it("does not ask an unlinked person to link in an ordinary unrelated thread", async () => {
    const h = ingress(); h.members.clear(); h.deps.threadContinuation = async () => undefined as never;
    await h.send("ordinary unrelated conversation", TEAM, "message");
    expect(h.notice).not.toHaveBeenCalled(); expect(h.claim).not.toHaveBeenCalled();
  });
  it("linked member's ordinary request runs, but model/settings commands never queue", async () => {
    const h = ingress(); await h.send(); expect(h.queue).toHaveBeenCalledOnce();
    h.claim.mockClear(); h.queue.mockClear(); await h.send("use fast");
    expect(h.notice.mock.calls.at(-1)?.[0]).toMatchObject({ text: WEB }); expect(h.claim).not.toHaveBeenCalled(); expect(h.queue).not.toHaveBeenCalled();
  });
  it.each(["agentx_admin_change_confirm", "agentx_task_people", "unknown_private_marker"])("refuses company press %s before dispatch", async (actionId) => {
    const w = world(), press = vi.fn(), route = vi.fn(), notice = vi.fn();
    const handler = createSlackInteractivityHandler({ ...w, now: () => NOW, secrets: async () => ({ signingSecret: SECRET, botToken: slackTokens("legacy").bot }),
      handlers: [], adminChange: { press }, routePress: route, respondEphemeral: notice });
    await handler(signed({ type: "block_actions", team: { id: TEAM }, user: { id: USER, team_id: TEAM }, channel: { id: "D0DIRECT00" },
      actions: [{ action_id: actionId, value: "11111111-1111-4111-8111-111111111111" }], response_url: "https://hooks.slack.com/actions/example" }, true));
    expect(press).not.toHaveBeenCalled(); expect(route).not.toHaveBeenCalled(); expect(notice).toHaveBeenCalledWith(expect.any(String), WEB);
  });
  it("company settings form refuses before submission", async () => {
    const w = world(), submit = vi.fn();
    const handler = createSlackInteractivityHandler({ ...w, now: () => NOW, secrets: async () => ({ signingSecret: SECRET, botToken: slackTokens("legacy").bot }), handlers: [], routeSubmission: submit });
    const response = await handler(signed({ type: "view_submission", team: { id: TEAM }, user: { id: USER, team_id: TEAM }, view: { callback_id: "agentx_task_people_submission", blocks: [{ type: "input", block_id: "" }] } }, true));
    expect(JSON.parse(response.body)).toEqual({ response_action: "errors", errors: { form: WEB } }); expect(submit).not.toHaveBeenCalled();
  });
});

beforeAll(loadSlackBroker);
describe("broker execution checks", () => {
  it.each(["task-people-read", "task-people-change", "task-people-take-ownership", "task-people-confirm"])("refuses %s at its backend entry", async (action) => {
    const w = world(); const h = createBroker({ extra: { ...w } });
    const response = await h.handler({ source: "agentx.slack-ingress", action, thread, userId: USER, taskId: "11111111-1111-4111-8111-111111111111", requestId: "22222222-2222-4222-8222-222222222222", expectedPeopleRevision: 1, slackUserId: USER, role: "commenter" });
    expect(response.body).toContain(WEB); expect(h.db.commandNames()).toEqual([]);
  });
});

// The queue preserves only Slack coordinates. Execution must resolve today's person again.
import { bindSlackChannelInCompany, createDeveloperTaskBroker, grantProject } from "../support/developer-task-broker.js";
import { issueChannelLinkCode, redeemChannelLinkCode } from "../../packages/broker/src/core/channel/links.js";
import { createSlackChannelEventsHandler } from "../../packages/broker/src/aws/slack-adapter.js";

/**
 * DEC 254zzz98 (delta review H1): make the workflow's legacy revision of "payments" company A's own (pre-R2-F1 company data, stamped A). Unstamped, it is the built-in company's
 * same-named project, which A's Slack thread is refused before anything else (slack-company-layout-start.test.ts covers that refusal); tests of a later check stamp it.
 */
function legacyRevisionIsA(h: { db: { find(p: (item: Record<string, unknown>) => boolean): Array<Record<string, unknown>>; set(item: Record<string, unknown>): void } }): void {
  for (const row of h.db.find((item) => item.pk === "PROJECT#payments" && String(item.sk).startsWith("REV#"))) h.db.set({ ...row, companyId: A });
}

async function brokerWorld(installTeam = OTHER) {
  const h = await createDeveloperTaskBroker({ channelMembers: async (r) => ({ ok: true, memberOf: r.channelIds }) });
  const currentThread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: TS };
  const start = await h.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread: currentThread, userId: USER,
    instructions: "A local company fixture", workflowPath: "QUICK", requestId: randomUUID() });
  expect(start.statusCode).toBe(200);
  const taskId = String((JSON.parse(start.body) as { taskId: string }).taskId);
  const task = h.db.get(`DEVTASK#${taskId}`, "META")!;
  h.db.set({ ...task, companyId: A, developerId: person });
  // DEC 254zzz80: company A is a NAMED company: its channel binding lives in its own partition.
  bindSlackChannelInCompany(h.db, A);
  const w = world(); w.members.clear(); w.members.set(person, A);
  w.workspaces.requireCompany = async (team) => { if (team !== SLACK_TEAM) throw Error("private"); return A; };
  const actor = { channel: "slack", tenant: SLACK_TEAM, userId: USER };
  const code = await issueChannelLinkCode({ store: w.store, orgId: A, now: Date.now }, actor);
  await redeemChannelLinkCode({ store: w.store, orgId: A, now: Date.now }, person, code.code);
  const module = await loadSlackBroker();
  const handler = module.createAwsBrokerHandler({ ...h.brokerInput, ...w, developer: { ...h.brokerInput.developer!, slackTeamId: installTeam } } as never);
  const authorize = () => handler({ source: "agentx.slack-ingress", action: "task-people-authorize", thread: currentThread, taskId, userId: USER, taskAction: "feedback" });
  return { ...h, ...w, handler, authorize, currentThread, taskId, actor };
}

describe("company broker authority on execution", () => {
  it("linked web owner keeps exactly that person's task rights", async () => {
    const h = await brokerWorld();
    expect((await h.authorize()).statusCode).toBe(200);
    h.db.set({ ...h.db.get(`DEVTASK#${h.taskId}`, "META")!, developerId: "b".repeat(64) });
    expect((await h.authorize()).statusCode).not.toBe(200);
  });
  it.each(["revoke", "unlink"])("queued allowed request rechecks %s before execution", async (change) => {
    const h = await brokerWorld();
    expect((await h.authorize()).statusCode).toBe(200);
    const queued = () => h.authorize();
    if (change === "revoke") h.members.clear();
    else await h.store.delete({ key: orgChannelLinkKey(A, h.actor) });
    const response = await queued();
    expect(response.body).toContain(WEB); expect(response.statusCode).not.toBe(200);
  });
  it("a foreign task is byte-identical to a missing task", async () => {
    const h = await brokerWorld(); const task = h.db.get(`DEVTASK#${h.taskId}`, "META")!;
    h.db.set({ ...task, companyId: B }); const foreign = await h.authorize();
    h.db.delete(`DEVTASK#${h.taskId}`, "META"); const missing = await h.authorize();
    expect(foreign).toEqual(missing); expect(foreign.statusCode).not.toBe(200);
  });
  it("service model writer refuses with the fixed web sentence", async () => {
    const h = await brokerWorld(); legacyRevisionIsA(h);
    const result = await call(h.handler, { method: "PUT", path: "/v1/service/project/model", service: { principal: orchestratorPrincipal,
      thread: `${SLACK_TEAM}/${SLACK_CHANNEL}/${TS}`, slackUser: USER }, body: { provider: "amazon-bedrock", modelId: "private-model" } });
    expect(JSON.stringify(result.body)).toContain(WEB);
  });
  it("a queued service request rechecks membership and link before reading project models", async () => {
    const h = await brokerWorld();
    const execute = () => call(h.handler, { method: "GET", path: "/v1/service/project/models", service: { principal: orchestratorPrincipal,
      thread: `${SLACK_TEAM}/${SLACK_CHANNEL}/${TS}`, slackUser: USER } });
    const allowed = await execute(); expect(JSON.stringify(allowed.body)).not.toContain(WEB);
    h.members.clear(); expect(JSON.stringify((await execute()).body)).toContain(WEB);
  });
  it("workflow start resolves the web person before writing", async () => {
    const h = await brokerWorld(); h.members.clear();
    const result = await h.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread: { ...h.currentThread, threadTs: "1700000000.000002" },
      userId: USER, instructions: "must not run", workflowPath: "QUICK", requestId: randomUUID() });
    expect(result.body).toContain(WEB);
  });
});

describe("company adapter delivery", () => {
  const secret = ["whsec", Buffer.alloc(32, 9).toString("base64")].join("_");
  it("concurrent conversations use their own token and reject mismatched private audience", async () => {
    const w = world(); const legacy = vi.fn(async () => slackTokens("legacy").bot), calls: string[] = [];
    const handler = createSlackChannelEventsHandler({ ...w, secret: async () => secret, botToken: legacy, now: () => NOW,
      claim: async () => true, release: async () => undefined, messageTs: { get: async () => undefined, put: async () => undefined },
      fetch: async (_url, init) => { const body = JSON.parse(typeof init?.body === "string" ? init.body : "") as { text: string }; await Promise.resolve();
        const label = [TEAM, OTHER].find((t) => new Headers(init?.headers).get("authorization") === `Bearer ${slackTokens(t).bot}`);
        calls.push(`${body.text}:${label}`); return new Response(JSON.stringify({ ok: true, ts: TS })); } });
    const send = (team: string, audience = team) => {
      const payload = { version: 1, id: `evt_company${team}1234567890`, channel: "slack", type: "message", createdAt: new Date(NOW).toISOString(),
        conversation: { channel: "slack", tenant: team, space: CHANNEL, thread: TS },
        data: { text: team, audience: { kind: "ephemeral", actor: { channel: "slack", tenant: audience, userId: USER } } } };
      const body = JSON.stringify(payload);
      return handler({ body, headers: webhookHeaders({ secret, id: payload.id, timestamp: NOW / 1000, body }), requestContext: { http: { method: "POST" } } });
    };
    const results = await Promise.all([send(TEAM), send(OTHER)]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(calls.sort()).toEqual([`${TEAM}:${TEAM}`, `${OTHER}:${OTHER}`].sort()); expect(legacy).not.toHaveBeenCalled();
    calls.length = 0; const refused = await send(TEAM, OTHER);
    expect(refused.body).toContain("This Slack workspace is not available."); expect(calls).toEqual([]);
  });
});

import { createSlackLinkCodes } from "../../packages/broker/src/aws/slack-person.js";
import { createChannelLinkWeb } from "../../packages/broker/src/aws/channel-link-web.js";
import { SESSION_COOKIE, CSRF_COOKIE } from "../../packages/broker/src/aws/web-session.js";
import { createSlackAdapterFront } from "../../packages/broker/src/aws/slack-ingress.js";

describe("company link and front boundaries", () => {
  it("unlinked settings press gets only a rate-limited link notice", async () => {
    const w = world(); w.members.clear(); const notice = vi.fn(), press = vi.fn();
    const handler = createSlackInteractivityHandler({ ...w, now: () => NOW, secrets: async () => ({ signingSecret: SECRET, botToken: slackTokens("legacy").bot }), handlers: [], adminChange: { press }, respondEphemeral: notice });
    const event = signed({ type: "block_actions", team: { id: TEAM }, user: { id: USER, team_id: TEAM }, channel: { id: "D0DIRECT00" },
      actions: [{ action_id: "agentx_admin_change_confirm", value: "11111111-1111-4111-8111-111111111111" }], response_url: "https://hooks.slack.com/actions/example" }, true);
    await handler(event); await handler(event);
    expect(press).not.toHaveBeenCalled(); expect(notice).toHaveBeenCalledOnce();
    expect(notice.mock.calls[0]?.[1]).toContain("link your account: Open in Rovara");
  });
  it("adapter front refuses unlinked input before handing off", async () => {
    const w = world(); w.members.clear(); const handOff = vi.fn(), notice = vi.fn();
    const handler = createSlackAdapterFront({ ...w, secrets: async () => ({ signingSecret: SECRET }), now: () => NOW,
      getBinding: async () => ({ teamId: TEAM, channelId: CHANNEL, projectName: "payments", updatedAt: new Date(NOW).toISOString() }),
      isRovaraThread: async () => true, handOff, postEphemeral: notice });
    await handler(signed({ type: "event_callback", event_id: "EvFRONT1234", team_id: TEAM, event: { type: "app_mention", channel: CHANNEL, user: USER, ts: TS, text: "hello" } }));
    expect(handOff).not.toHaveBeenCalled(); expect(notice).toHaveBeenCalledOnce();
  });
  it("web preview receives authenticated person, then redeem checks that person's company", async () => {
    const w = world(); w.members.set(person, A);
    const codes = createSlackLinkCodes({ ...w, now: () => NOW });
    const { code } = await codes.issue({ teamId: TEAM, userId: USER });
    const web = createChannelLinkWeb({ origin: "https://example.test", authenticateSession: async () => ({ developerId: person, sessionId: "s", name: "Member", amr: "oidc" }),
      preview: (value, personId) => codes.preview(personId, value), redeem: (id, value) => codes.redeem(id, value) });
    const path = `/review/link/${code}`, csrf = "a".repeat(40);
    const headers = { cookie: `${SESSION_COOKIE}=s; ${CSRF_COOKIE}=${csrf}`, origin: "https://example.test" };
    expect((await web({ method: "GET", path, headers, requestId: "r" }, new URL(path, headers.origin))).statusCode).toBe(200);
    w.members.set(person, B);
    const refused = await web({ method: "POST", path: `${path}/confirm`, headers, requestId: "r", body: `csrf=${csrf}` }, new URL(`${path}/confirm`, headers.origin));
    expect(refused.statusCode).toBe(404); expect(refused.body).not.toContain(TEAM);
  });
});

import { slackCompanyActionSurface } from "../../packages/broker/src/aws/slack-channel-presses.js";
import { slackChannelTransport } from "../../packages/broker/src/aws/slack-channel-router.js";

describe("queued channel actions", () => {
  const action = { version: 1 as const, channel: "slack", eventId: "action-company-1", actor: { channel: "slack", tenant: TEAM, userId: USER },
    conversation: { channel: "slack", tenant: TEAM, space: CHANNEL, thread: TS }, actionId: "agentx_details", value: "details", receivedAt: new Date(NOW).toISOString() };
  it("rechecks membership after queueing and refuses settings and unknown actions at execution", async () => {
    const w = world(), next = vi.fn(async () => ({ statusCode: 200, body: "handled" }));
    const run = slackCompanyActionSurface(w, next);
    expect((await run(action, { projectName: "payments" }))?.body).toBe("handled");
    next.mockClear(); w.members.clear();
    expect((await run(action, { projectName: "payments" }))?.body).toContain("link your account"); expect(next).not.toHaveBeenCalled();
    w.members.set(native, A);
    for (const actionId of ["agentx_admin_change_confirm", "agentx_task_people", "unknown"]) {
      expect((await run({ ...action, actionId }, { projectName: "payments" }))?.body).toContain(WEB);
    }
    expect(next).not.toHaveBeenCalled();
  });
  it("refuses foreign project or actor workspace before dispatch", async () => {
    const w = world(), next = vi.fn(); const run = slackCompanyActionSurface(w, next);
    w.workspaces.getProject = async () => ({ companyId: B });
    expect((await run(action, { projectName: "payments" }))?.body).toContain("This Slack workspace is not available.");
    w.workspaces.getProject = async () => ({ companyId: A });
    expect((await run({ ...action, actor: { ...action.actor, tenant: OTHER } }, { projectName: "payments" }))?.body).toContain("This Slack workspace is not available.");
    expect(next).not.toHaveBeenCalled();
  });
  it("member cache never serves another team's raw user", async () => {
    let team = TEAM;
    const user = vi.fn(async () => ({ userId: USER, tenant: team, bot: team === OTHER, deleted: false }));
    const transport = slackChannelTransport({ notices: {} as never, user, enqueue: vi.fn(), changePending: async () => 1, projectName: () => "payments", teamId: () => team });
    expect(await transport.checkMember(USER)).toEqual({ outcome: "person" }); team = OTHER;
    expect(await transport.checkMember(USER)).toEqual({ outcome: "not_person" }); expect(user).toHaveBeenCalledTimes(2);
  });
});


describe("company execution seam controls", () => {
  it("queued workflow press refuses a revoked link before writing refusal records", async () => {
    const h = await brokerWorld(); h.members.clear();
    const before = structuredClone(h.db.find(() => true));
    const response = await h.handler({ source: "agentx.slack-ingress", action: "workflow-close", taskId: h.taskId, userId: USER, thread: h.currentThread, requestId: randomUUID() });
    expect(response.body).toContain(WEB); expect(h.db.find(() => true)).toEqual(before);
  });
  it("queued intake record rechecks membership before writing", async () => {
    const h = await brokerWorld(); h.members.clear(); const before = structuredClone(h.db.find(() => true));
    const response = await h.handler({ source: "agentx.slack-ingress", action: "intake-record", choiceId: randomUUID(), userId: USER, thread: h.currentThread, text: "must not save" });
    expect(response.body).toContain(WEB); expect(h.db.find(() => true)).toEqual(before);
  });
  it("service rechecks the company of an existing shared task", async () => {
    const h = await brokerWorld(); legacyRevisionIsA(h); h.db.set({ ...h.db.get(`DEVTASK#${h.taskId}`, "META")!, companyId: B });
    const response = await call(h.handler, { method: "GET", path: "/v1/service/project/models", service: { principal: orchestratorPrincipal, thread: `${SLACK_TEAM}/${SLACK_CHANNEL}/${TS}`, slackUser: USER } });
    expect(JSON.stringify(response.body)).toContain("no task here that you can see");
  });
  it("a current linked owner records a thread note through the task-access caller seam", async () => {
    const h = await brokerWorld();
    const response = await h.handler({ source: "agentx.slack-ingress", action: "thread-note", taskId: h.taskId, userId: USER, thread: h.currentThread,
      eventId: "EvNOTECOMPANY", messageTs: "1700000000.000003", text: "my note" });
    expect(JSON.parse(response.body)).toEqual({ outcome: "captured" });
    const note = h.db.find((row) => row.entityType === "WORKFLOW_THREAD_NOTE")[0];
    expect(note?.isOwner).toBe(true);
  });
  it("rejects a signed payload changed after signing before any company lookup", async () => {
    const w = world(); const lookup = vi.spyOn(w.workspaces, "requireCompany"), queue = vi.fn();
    const handler = createSlackIngressHandler({ ...w, secrets: async () => ({ signingSecret: SECRET, botToken: slackTokens("legacy").bot }), now: () => NOW,
      getBinding: async () => undefined, claimEvent: async () => true, releaseEvent: async () => undefined, changePending: async () => 1, enqueue: queue, postMessage: async () => undefined });
    const request = signed({ type: "event_callback", team_id: TEAM, event_id: "EvSIGNATURE", event: { type: "app_mention", channel: CHANNEL, user: USER, ts: TS, text: "hello" } });
    request.body = request.body.replace(TEAM, OTHER);
    expect((await handler(request)).statusCode).toBe(401); expect(lookup).not.toHaveBeenCalled(); expect(queue).not.toHaveBeenCalled();
  });
});


describe("company broker secondary workspace", () => {
  it("linked person never inherits install directory channel grants", async () => {
    const h = await brokerWorld(SLACK_TEAM); h.channelMembers.mockClear();
    const response = await h.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread: { ...h.currentThread, threadTs: "1700000000.000005" },
      userId: USER, instructions: "ungranted member", workflowPath: "QUICK", requestId: randomUUID() });
    expect(response.statusCode).not.toBe(200); expect(h.channelMembers).not.toHaveBeenCalled();
  });
  it.each(["thread-notes", "comments"])("secondary workspace reaches %s answer lookup", async (kind) => {
    const h = await brokerWorld();
    const response = await call(h.handler, { method: "POST", path: `/v1/service/tasks/${kind}/answered`, service: { principal: orchestratorPrincipal,
      thread: `${SLACK_TEAM}/${SLACK_CHANNEL}/${TS}`, slackUser: USER }, body: { taskId: h.taskId, thread: h.currentThread,
      ...(kind === "comments" ? { commentId: randomUUID(), outcome: "ANSWERED", text: "answer" } : { messageTs: "1700000000.000004" }) } });
    expect(JSON.stringify(response.body)).not.toContain("this thread is not that task's own thread");
    expect(JSON.stringify(response.body)).not.toContain("CONFIG_INVALID");
    expect(response.status).not.toBe(200);
  });
  it("secondary workspace owner reaches workflow close", async () => {
    const h = await brokerWorld();
    const response = await h.handler({ source: "agentx.slack-ingress", action: "workflow-close", taskId: h.taskId, userId: USER, thread: h.currentThread, requestId: randomUUID() });
    expect(JSON.parse(response.body)).toEqual({ refused: true, message: "AgentX is still working on the previous step. Try again when it posts.", requestId: "slack-ingress" });
  });
  it("secondary workspace owner reaches feedback lookup", async () => {
    const h = await brokerWorld();
    const response = await h.handler({ source: "agentx.slack-ingress", action: "feedback-note", taskId: h.taskId, userId: USER, thread: h.currentThread,
      eventId: "EvFEEDBACK", messageTs: "1700000000.000004", text: "feedback" });
    expect(response.body).not.toContain("Slack workspace is not enabled"); expect(response.body).not.toContain("only a current task owner");
  });
});

it("secondary workspace starts for a linked person with an explicit project grant", async () => {
  const h = await brokerWorld(); grantProject(h.db, { developerId: person, name: "Member", provider: "oidc", sessionId: "fixture" }, "payments", A);
  const response = await h.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread: { ...h.currentThread, threadTs: "1700000000.000006" },
    userId: USER, instructions: "explicit grant", workflowPath: "QUICK", requestId: randomUUID() });
  expect(response.statusCode, response.body).toBe(200);
  const task = h.db.get(`DEVTASK#${(JSON.parse(response.body) as { taskId: string }).taskId}`, "META");
  expect(task?.developerId).toBe(person); expect(task?.share).toMatchObject({ teamId: SLACK_TEAM });
});

it("queued stop rechecks membership before touching task state", async () => {
  const h = await brokerWorld(); h.members.clear(); const before = structuredClone(h.db.find(() => true));
  const response = await h.handler({ source: "agentx.slack-ingress", action: "stop-task", thread: h.currentThread, userId: USER });
  expect(response.body).toContain(WEB); expect(h.db.find(() => true)).toEqual(before);
});
it("broker refuses a channel binding to a foreign project on read and write", async () => {
  const h = await brokerWorld(); h.workspaces.getProject = async () => ({ companyId: B });
  // DEC 254zzz80 (R2-F1): company A is NAMED, so its binding is only its own row; the binding of this channel kept under company B's partition (and the legacy row naming a
  // project whose revision is B's) is not A's: not bound. This replaces the legacy row's foreign-project check for a named company.
  const own = h.db.get(`ORG#${A}#SLACK_BINDING#${SLACK_TEAM}`, `CHANNEL#${SLACK_CHANNEL}`)!;
  h.db.delete(String(own.pk), String(own.sk));
  h.db.set({ ...own, pk: `ORG#${B}#SLACK_BINDING#${SLACK_TEAM}` });
  // And the project is not A's: its revision is only in B's partition.
  const project = h.db.get(`ORG#${A}#PROJECT#payments`, "REV#000000000001")!;
  h.db.delete(String(project.pk), String(project.sk));
  h.db.set({ ...project, pk: `ORG#${B}#PROJECT#payments`, companyId: B });
  const read = await call(h.handler, { method: "GET", path: "/v1/service/project/models", service: { principal: orchestratorPrincipal,
    thread: `${SLACK_TEAM}/${SLACK_CHANNEL}/${TS}`, slackUser: USER } });
  expect(JSON.stringify(read.body)).toContain("Slack channel is not bound to a project");
  const write = await call(h.handler, { method: "PUT", path: `/v1/admin/slack/bindings/${SLACK_TEAM}/${SLACK_CHANNEL}`, user: { subject: "admin-subject", admin: true }, body: { projectName: "payments" } });
  expect(write.status).toBe(404); expect(JSON.stringify(write.body)).toContain("Slack channel binding not found");
});

import { slackDirectTransport } from "../../packages/broker/src/aws/slack-ingress.js";
import { slackRequestWorkspace } from "../../packages/broker/src/aws/slack-person.js";
it("real direct transport closures use only the verified workspace token", async () => {
  const w = world(), legacy = vi.fn(async () => ({ signingSecret: SECRET, botToken: slackTokens("legacy").bot }));
  const labels: boolean[] = [];
  vi.stubEnv("SLACK_REQUEST_QUEUE_URL", "https://example.test/queue"); vi.stubEnv("SLACK_THREADS_TABLE_NAME", "threads");
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
    labels.push(new Headers(init?.headers).get("authorization") === `Bearer ${slackTokens(TEAM).bot}`);
    return new Response(JSON.stringify({ ok: true, ts: TS, user: { id: USER, is_bot: false, deleted: false } }));
  }));
  try {
    const transport = slackDirectTransport(legacy, w);
    await slackRequestWorkspace.run({ teamId: TEAM, companyId: A, token: slackTokens(TEAM).bot }, async () => {
      await transport.postMessage({ channel: CHANNEL, threadTs: TS, text: "hello" });
      await transport.update({ channel: CHANNEL, ts: TS, text: "hello", blocks: [] });
      await transport.postEphemeral({ channel: CHANNEL, threadTs: TS, user: USER, text: "hello" });
      await transport.checkMember(USER);
    });
    expect(labels).toEqual([true, true, true, true]); expect(legacy).not.toHaveBeenCalled();
    await expect(transport.postMessage({ channel: CHANNEL, threadTs: TS, text: "outside context" })).rejects.toThrow("This Slack workspace is not available.");
    expect(labels).toHaveLength(4);
  } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
});

import { slackCompanyProject } from "../../packages/broker/src/aws/slack-person.js";
it.each([undefined, "", "invalid", 42])("project scope refuses malformed workspace company %s", async (value) => {
  const w = world(); w.workspaces.requireCompany = async () => value as string;
  expect(await slackCompanyProject(w, TEAM, "payments")).toBe(false);
});
it("direct member lookup never reuses another workspace's raw user cache", async () => {
  const w = world(); const seen: string[] = [];
  vi.stubEnv("SLACK_REQUEST_QUEUE_URL", "https://example.test/queue"); vi.stubEnv("SLACK_THREADS_TABLE_NAME", "threads");
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
    const own = new Headers(init?.headers).get("authorization") === `Bearer ${slackTokens(TEAM).bot}`; seen.push(own ? TEAM : OTHER);
    return new Response(JSON.stringify({ ok: true, user: { id: USER, is_bot: !own, deleted: false } }));
  }));
  try {
    const transport = slackDirectTransport(async () => ({ signingSecret: SECRET, botToken: slackTokens("legacy").bot }), w);
    const run = (teamId: string) => slackRequestWorkspace.run({ teamId, companyId: teamId === TEAM ? A : B, token: slackTokens(teamId).bot }, () => transport.checkMember(USER));
    expect(await run(TEAM)).toEqual({ outcome: "person" }); expect(await run(OTHER)).toEqual({ outcome: "not_person" });
    expect(seen).toEqual([TEAM, OTHER]);
  } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
});

it.each([
  { action: "admin-change-press", changeId: "11111111-1111-4111-8111-111111111111", click: "confirm", slackUserId: USER },
  { action: "chatgpt-command", command: "connect", userId: USER },
  { action: "chatgpt-finish", callbackUrl: "https://example.test/private", userId: USER },
])("backend company setting $action always requires web sign-in", async (input) => {
  const w = world(); w.members.clear(); const h = createBroker({ extra: w });
  const response = await h.handler({ source: "agentx.slack-ingress", teamId: TEAM, ...input });
  expect(response.body).toContain(WEB); expect(h.db.commandNames()).toEqual([]);
});

it("press-path missing and foreign tasks have identical status and sentence", async () => {
  const h = await brokerWorld(); const task = h.db.get(`DEVTASK#${h.taskId}`, "META")!;
  const request = { source: "agentx.slack-ingress", action: "workflow-close", taskId: h.taskId, userId: USER, thread: h.currentThread, requestId: randomUUID() };
  h.db.set({ ...task, companyId: B }); const foreign = await h.handler(request);
  h.db.delete(`DEVTASK#${h.taskId}`, "META"); const missing = await h.handler(request);
  expect(foreign).toEqual(missing);
});
it("binding PUT authenticates administrators before looking up a project company", async () => {
  const h = await brokerWorld(); const project = vi.fn(async () => ({ companyId: B })); h.workspaces.getProject = project;
  const write = await call(h.handler, { method: "PUT", path: `/v1/admin/slack/bindings/${SLACK_TEAM}/${SLACK_CHANNEL}`, user: { subject: "non-admin", admin: false }, body: { projectName: "payments" } });
  expect(write.status).toBe(403); expect(project).not.toHaveBeenCalled();
});
it.each([false, true])("front only gives link notices for a bound Rovara conversation (bound=%s)", async (bound) => {
  const w = world(); w.members.clear(); const notice = vi.fn(); const handOff = vi.fn();
  const handler = createSlackAdapterFront({ ...w, secrets: async () => ({ signingSecret: SECRET }), now: () => NOW,
    getBinding: async () => bound ? { teamId: TEAM, channelId: CHANNEL, projectName: "payments", updatedAt: new Date(NOW).toISOString() } : undefined,
    isRovaraThread: async () => false, handOff, postEphemeral: notice });
  await handler(signed({ type: "event_callback", event_id: "EvFRONT1234", team_id: TEAM, event: { type: bound ? "message" : "app_mention", channel: CHANNEL, user: USER, ts: TS, thread_ts: TS, text: "hello" } }));
  expect(notice).not.toHaveBeenCalled(); expect(handOff).not.toHaveBeenCalled();
});
