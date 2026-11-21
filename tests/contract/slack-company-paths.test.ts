import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { webhookHeaders } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createSlackIngressHandler } from "../../packages/broker/src/aws/slack-ingress.js";
import { createSlackInteractivityHandler } from "../../packages/broker/src/aws/slack-interactivity.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { slackTokens } from "../../packages/testing/src/channel/slack-world.js";
import { createBroker, loadSlackBroker } from "../support/slack-broker.js";

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
  it.each(["hello"])("unlinked %s only gets one private link notice", async (text) => {
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
  it("company settings form refuses before submission", async () => {
    const w = world(), submit = vi.fn();
    const handler = createSlackInteractivityHandler({ ...w, now: () => NOW, secrets: async () => ({ signingSecret: SECRET, botToken: slackTokens("legacy").bot }), handlers: [], routeSubmission: submit });
    const response = await handler(signed({ type: "view_submission", team: { id: TEAM }, user: { id: USER, team_id: TEAM }, view: { callback_id: "agentx_task_people_submission", blocks: [{ type: "input", block_id: "" }] } }, true));
    expect(JSON.parse(response.body)).toEqual({ response_action: "errors", errors: { form: WEB } }); expect(submit).not.toHaveBeenCalled();
  });
});

beforeAll(loadSlackBroker);
describe("broker execution checks", () => {
  it.each([ "task-people-change", "task-people-take-ownership"])("refuses %s at its backend entry", async (action) => {
    const w = world(); const h = createBroker({ extra: { ...w } });
    const response = await h.handler({ source: "agentx.slack-ingress", action, thread, userId: USER, taskId: "11111111-1111-4111-8111-111111111111", requestId: "22222222-2222-4222-8222-222222222222", expectedPeopleRevision: 1, slackUserId: USER, role: "commenter" });
    expect(response.body).toContain(WEB); expect(h.db.commandNames()).toEqual([]);
  });
});

import { createSlackChannelEventsHandler } from "../../packages/broker/src/aws/slack-adapter.js";




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
  it("rejects a signed payload changed after signing before any company lookup", async () => {
    const w = world(); const lookup = vi.spyOn(w.workspaces, "requireCompany"), queue = vi.fn();
    const handler = createSlackIngressHandler({ ...w, secrets: async () => ({ signingSecret: SECRET, botToken: slackTokens("legacy").bot }), now: () => NOW,
      getBinding: async () => undefined, claimEvent: async () => true, releaseEvent: async () => undefined, changePending: async () => 1, enqueue: queue, postMessage: async () => undefined });
    const request = signed({ type: "event_callback", team_id: TEAM, event_id: "EvSIGNATURE", event: { type: "app_mention", channel: CHANNEL, user: USER, ts: TS, text: "hello" } });
    request.body = request.body.replace(TEAM, OTHER);
    expect((await handler(request)).statusCode).toBe(401); expect(lookup).not.toHaveBeenCalled(); expect(queue).not.toHaveBeenCalled();
  });
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

it.each([
  { action: "admin-change-press", changeId: "11111111-1111-4111-8111-111111111111", click: "confirm", slackUserId: USER },
  { action: "chatgpt-finish", callbackUrl: "https://example.test/private", userId: USER },
])("backend company setting $action always requires web sign-in", async (input) => {
  const w = world(); w.members.clear(); const h = createBroker({ extra: w });
  const response = await h.handler({ source: "agentx.slack-ingress", teamId: TEAM, ...input });
  expect(response.body).toContain(WEB); expect(h.db.commandNames()).toEqual([]);
});

it.each([false])("front only gives link notices for a bound Rovara conversation (bound=%s)", async (bound) => {
  const w = world(); w.members.clear(); const notice = vi.fn(); const handOff = vi.fn();
  const handler = createSlackAdapterFront({ ...w, secrets: async () => ({ signingSecret: SECRET }), now: () => NOW,
    getBinding: async () => bound ? { teamId: TEAM, channelId: CHANNEL, projectName: "payments", updatedAt: new Date(NOW).toISOString() } : undefined,
    isRovaraThread: async () => false, handOff, postEphemeral: notice });
  await handler(signed({ type: "event_callback", event_id: "EvFRONT1234", team_id: TEAM, event: { type: bound ? "message" : "app_mention", channel: CHANNEL, user: USER, ts: TS, thread_ts: TS, text: "hello" } }));
  expect(notice).not.toHaveBeenCalled(); expect(handOff).not.toHaveBeenCalled();
});
