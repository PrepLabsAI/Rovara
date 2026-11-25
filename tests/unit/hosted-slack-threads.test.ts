// L4-U5b: the hosted Slack thread. A Slack mention that starts a workflow for a company the core serves starts the task on the core and REMEMBERS the Slack thread, company-scoped; the thread notices the laptop already has
// (a pause at Build for a broken setup, the pull request with its setup evidence line, the end) then post on a hosted install through the company's own workspace token. Mutants are listed in the PR body with the test that
// kills each. No real Slack call is made: the web API is a fake fetch that records every call.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, SLACK_CHANNEL, orgScoped, type ActorRef, type ChannelEvent, type CodeMilestone, type ConversationRef, type DocumentStore, type OrgId, type Principal, type StoredDocument } from "@agentx/contracts";
import { startSlackWorkflowOnCore } from "../../packages/broker/src/aws/slack-core-start.js";
import { hostedSlackThreads } from "../../packages/broker/src/aws/slack-thread-channel.js";
import { coreTaskEntryFrom, type CoreEntryCaller, type CoreTaskEntry } from "../../packages/broker/src/aws/engine-boundary.js";
import { recordChatThread } from "../../packages/broker/src/core-host/chat-thread-record.js";
import type { DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { channelThreadHandler } from "../../packages/broker/src/core/channel/thread-notices.js";
import { readTaskThread, taskThreadKey } from "../../packages/broker/src/core/channel/threads.js";
import { taskSessionId } from "../../packages/broker/src/core/sessions/create.js";
import { driftTaskKey, recheckRowKey, setupNotRecheckedWords, type RecheckState } from "../../packages/broker/src/core/setup-agent/recheck.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createHarness, newRequestId, type Harness } from "../support/task-flow-harness.js";

const COMPANY = IMPLICIT_COMPANY_ID as OrgId;
const COMPANY_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const TEAM_A = "T0AAAAAAAAA";
const TEAM_B = "T0BBBBBBBBB";
const CHANNEL = "C0123456789";
const TS = "1700000000.000100";
const USER = "U0123456789";
const STEP = "setup: npm ci - setup step 0 (npm ci) failed: exit 1";
const KEY = "a".repeat(48);
/** A token of the right shape, built here so no real-looking key is in the source. */
const tokenOf = (label: string): string => ["xoxb", "1111111111", label].join("-");
const TOKEN_A = tokenOf("aaaaaaaaaa");
const TOKEN_B = tokenOf("bbbbbbbbbb");

const CONVERSATION: ConversationRef = { channel: SLACK_CHANNEL, tenant: TEAM_A, space: CHANNEL, thread: TS };
const ACTOR: ActorRef = { channel: SLACK_CHANNEL, tenant: TEAM_A, userId: USER };

/** Slack's web API as a fake: who the bot is (the workspace the token belongs to) and every post, with the token it carried. */
function fakeSlack(tokenTeams: Record<string, string> = { [TOKEN_A]: TEAM_A, [TOKEN_B]: TEAM_B }) {
  const posts: Array<{ token: string; channel: string; thread_ts?: string; text: string }> = [];
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).replace("https://slack.com/api/", "");
    calls.push(method);
    const token = String((init?.headers as Record<string, string>)["authorization"]).replace("Bearer ", "");
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    if (method === "auth.test") return new Response(JSON.stringify({ ok: true, team_id: tokenTeams[token] ?? "T0UNKNOWN00", user_id: "U0BOT000000" }), { status: 200 });
    if (method === "chat.postMessage") {
      posts.push({ token, channel: String(body["channel"]), ...(typeof body["thread_ts"] === "string" ? { thread_ts: body["thread_ts"] } : {}), text: String(body["text"]) });
      return new Response(JSON.stringify({ ok: true, ts: "1700000001.000200" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, error: "unsupported" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { posts, calls, fetchImpl };
}

/** The company-scoped workspace seam: which company each team belongs to, and that company's token. */
function workspaces(map: Record<string, { company: OrgId; token?: string }>) {
  return {
    requireCompany: async (team: string): Promise<string> => { const found = map[team]; if (found === undefined) throw new Error("no such workspace"); return found.company; },
    tokenForCompany: async (company: string, team: string): Promise<string | undefined> => (map[team]?.company === company ? map[team]?.token : undefined),
  };
}

const eventOf = (conversation: ConversationRef, text = "hello"): ChannelEvent => ({ version: 1, id: `evt_${"x".repeat(20)}`, channel: SLACK_CHANNEL, conversation, createdAt: new Date().toISOString(), type: "progress", data: { text } });

describe("the hosted Slack adapter: one company's workspaces, with that company's own token", () => {
  it("maps a workspace to its company (and only Slack's, and a failing lookup is nobody's)", async () => {
    const threads = hostedSlackThreads({ workspaces: workspaces({ [TEAM_A]: { company: COMPANY, token: TOKEN_A }, [TEAM_B]: { company: COMPANY_B, token: TOKEN_B } }) });
    expect(await threads.companyOf({ channel: SLACK_CHANNEL, tenant: TEAM_A })).toBe(COMPANY);
    expect(await threads.companyOf({ channel: SLACK_CHANNEL, tenant: TEAM_B })).toBe(COMPANY_B);
    expect(await threads.companyOf({ channel: SLACK_CHANNEL, tenant: "T0NOBODY000" })).toBeUndefined();
    expect(await threads.companyOf({ channel: "examplechat", tenant: TEAM_A })).toBeUndefined();
    expect(threads.adapterFor(COMPANY, "examplechat")).toBeUndefined();
    expect(threads.adapterFor(COMPANY, SLACK_CHANNEL)).toBeDefined();
  });

  it("two companies: company A's adapter never reaches company B's workspace (no token is given, so nothing is sent), and the reverse", async () => {
    const slack = fakeSlack();
    const threads = hostedSlackThreads({ workspaces: workspaces({ [TEAM_A]: { company: COMPANY, token: TOKEN_A }, [TEAM_B]: { company: COMPANY_B, token: TOKEN_B } }), fetch: slack.fetchImpl });
    await expect(threads.adapterFor(COMPANY, SLACK_CHANNEL)!.deliver(eventOf({ ...CONVERSATION, tenant: TEAM_B }))).rejects.toThrow();
    await expect(threads.adapterFor(COMPANY_B, SLACK_CHANNEL)!.deliver(eventOf(CONVERSATION))).rejects.toThrow();
    expect(slack.calls).toEqual([]);
    // Each company's own thread still works, with its own token.
    await threads.adapterFor(COMPANY_B, SLACK_CHANNEL)!.deliver(eventOf({ ...CONVERSATION, tenant: TEAM_B }, "for B"));
    expect(slack.posts.map((post) => [post.token, post.text])).toEqual([[TOKEN_B, "for B"]]);
  });

  it("a token that belongs to another workspace than the conversation's posts nothing (the adapter checks whose bot it is)", async () => {
    const slack = fakeSlack({ [TOKEN_A]: TEAM_B });
    const threads = hostedSlackThreads({ workspaces: workspaces({ [TEAM_A]: { company: COMPANY, token: TOKEN_A } }), fetch: slack.fetchImpl });
    await expect(threads.adapterFor(COMPANY, SLACK_CHANNEL)!.deliver(eventOf(CONVERSATION))).rejects.toThrow();
    expect(slack.posts).toEqual([]);
  });

  it("a person-to-person message and another channel's event are refused (only a Slack conversation is this adapter's)", async () => {
    const slack = fakeSlack();
    const adapter = hostedSlackThreads({ workspaces: workspaces({ [TEAM_A]: { company: COMPANY, token: TOKEN_A } }), fetch: slack.fetchImpl }).adapterFor(COMPANY, SLACK_CHANNEL)!;
    await expect(adapter.deliver({ version: 1, id: `evt_${"y".repeat(20)}`, channel: SLACK_CHANNEL, createdAt: new Date().toISOString(), type: "direct", to: ACTOR, data: { text: "psst" } })).rejects.toThrow();
    await expect(adapter.deliver({ ...eventOf(CONVERSATION), channel: "examplechat" })).rejects.toThrow();
    expect(slack.calls).toEqual([]);
  });
});

// ---- the start on the core

const CALLER: CoreEntryCaller = { developerId: "d".repeat(64), sessionId: "s1", name: "Rovara member" };
const START = { caller: CALLER, companyId: COMPANY, thread: { teamId: TEAM_A, channelId: CHANNEL, threadTs: TS }, userId: USER, requestId: newRequestId(), project: "payments", instructions: "Add a retry", workflowPath: "QUICK" as const };
const TASK_ID = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";

function entryWith(options: { route?: CoreTaskEntry["route"]; record?: CoreTaskEntry["recordThread"] } = {}): { entry: CoreTaskEntry; requests: Array<{ path: string; body: Record<string, unknown> }> } {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const entry: CoreTaskEntry = {
    route: options.route ?? (async (request) => { requests.push({ path: request.path, body: JSON.parse(request.body ?? "{}") as Record<string, unknown> }); return { statusCode: 200, headers: {}, body: JSON.stringify({ task: { taskId: TASK_ID } }) }; }),
    ...(options.record === undefined ? {} : { recordThread: options.record }),
  };
  return { entry, requests };
}

describe("a Slack mention that starts a workflow for a company the core serves", () => {

  it("not the core's (no entry, or a company the switch does not send to the core): undefined, nothing is recorded", async () => {
    expect(await startSlackWorkflowOnCore(undefined, START)).toBeUndefined();
    const record = vi.fn(async () => true);
    const { entry } = entryWith({ route: async () => undefined, record });
    expect(await startSlackWorkflowOnCore(entry, START)).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
  });

  it("a refusal by the core is the start's refusal (nothing is recorded)", async () => {
    const record = vi.fn(async () => true);
    const { entry } = entryWith({ route: async () => ({ statusCode: 403, headers: {}, body: JSON.stringify({ error: { code: "FORBIDDEN", message: "tasks from AI tools are turned off for this project" } }) }), record });
    await expect(startSlackWorkflowOnCore(entry, START)).rejects.toThrow(/turned off/u);
    expect(record).not.toHaveBeenCalled();
  });

  it("a thread that could not be remembered (false, or a throw) does not undo the start, and says so in fixed words", async () => {
    for (const record of [async () => false, async () => { throw new Error("store down"); }]) {
      const logs: Array<Record<string, unknown>> = [];
      const { entry } = entryWith({ record });
      expect(await startSlackWorkflowOnCore(entry, START, (line) => logs.push(line))).toEqual({ taskId: TASK_ID });
      expect(logs).toEqual([{ event: "slack_core_start.thread_not_recorded" }]);
    }
    // An entry that keeps no thread at all: the same.
    const logs: Array<Record<string, unknown>> = [];
    expect(await startSlackWorkflowOnCore(entryWith().entry, START, (line) => logs.push(line))).toEqual({ taskId: TASK_ID });
    expect(logs).toEqual([{ event: "slack_core_start.thread_not_recorded" }]);
  });

  it("an answer without a task id (anything but a UUID) is a fixed refusal, never a fall back to the old start: nothing is recorded", async () => {
    const record = vi.fn(async () => true);
    const { entry } = entryWith({ route: async () => ({ statusCode: 200, headers: {}, body: JSON.stringify({ task: { taskId: "../../x" } }) }), record });
    await expect(startSlackWorkflowOnCore(entry, START)).rejects.toThrow(/could not be read/u);
    expect(record).not.toHaveBeenCalled();
  });

  it("the entry the deployment builds passes the caller as the core knows them, answers false for a caller it cannot map, and never throws", async () => {
    const seen: DeployedCaller[] = [];
    const routes = { route: async () => undefined };
    const principal: Principal = { companyId: COMPANY, personId: CALLER.developerId, displayName: "x", roles: ["member"], provider: "hosted" };
    const entry = coreTaskEntryFrom(routes, async (caller) => (caller.developerId === CALLER.developerId ? { principal } : undefined), async (deployed) => { seen.push(deployed); return true; });
    expect(await entry.recordThread!(CALLER, { taskId: TASK_ID, conversation: CONVERSATION, actor: ACTOR })).toBe(true);
    expect(seen).toEqual([{ principal }]);
    expect(await entry.recordThread!({ ...CALLER, developerId: "e".repeat(64) }, { taskId: TASK_ID, conversation: CONVERSATION, actor: ACTOR })).toBe(false);
    const broken = coreTaskEntryFrom(routes, async () => { throw new Error("membership down"); }, async () => true);
    expect(await broken.recordThread!(CALLER, { taskId: TASK_ID, conversation: CONVERSATION, actor: ACTOR })).toBe(false);
    const throwing = coreTaskEntryFrom(routes, async () => ({ principal }), async () => { throw new Error("store down"); });
    expect(await throwing.recordThread!(CALLER, { taskId: TASK_ID, conversation: CONVERSATION, actor: ACTOR })).toBe(false);
    expect(Object.hasOwn(coreTaskEntryFrom(routes, async () => ({ principal })), "recordThread")).toBe(false);
  });
});

// ---- remembering the thread

interface Hosted { h: Harness; owner: Principal; taskId: string; sessionId: string; threads: ReturnType<typeof hostedSlackThreads>; slack: ReturnType<typeof fakeSlack>; record(deployed: DeployedCaller, input?: Partial<{ conversation: ConversationRef; actor: ActorRef }>): Promise<boolean> }
async function hosted(options: { companyId?: OrgId; backend?: NonNullable<Parameters<typeof createHarness>[0]>["backend"]; teams?: Record<string, { company: OrgId; token?: string }> } = {}): Promise<Hosted> {
  const h = createHarness({ understandFirst: false, ...(options.companyId === undefined ? {} : { companyId: options.companyId }), ...(options.backend === undefined ? {} : { backend: options.backend }) });
  await h.registerProject();
  const started = (await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Add a retry", workflow: true, workflowPath: "QUICK" })).task;
  const slack = fakeSlack();
  const threads = hostedSlackThreads({ workspaces: workspaces(options.teams ?? { [TEAM_A]: { company: h.deps.companyId, token: TOKEN_A }, [TEAM_B]: { company: COMPANY_B, token: TOKEN_B } }), fetch: slack.fetchImpl });
  const record: Hosted["record"] = (deployed, input = {}) => recordChatThread({ chatThreads: threads, runtimeFor: async () => ({ flow: { deps: h.deps } }), now: () => h.clock.now }, deployed,
    { taskId: started.taskId, conversation: input.conversation ?? CONVERSATION, actor: input.actor ?? ACTOR });
  return { h, owner: h.owner.principal, taskId: started.taskId, sessionId: taskSessionId(started.taskId), threads, slack, record };
}

describe("remembering the Slack thread of a hosted core task", () => {
  it("writes the row under the company, for the task's own session, with who started it and who asked; a repeat changes nothing", async () => {
    const w = await hosted();
    expect(await w.record({ principal: w.owner })).toBe(true);
    const row = await readTaskThread(w.h.store, w.h.deps.companyId, w.sessionId);
    expect(row).toEqual({ conversation: CONVERSATION, personId: w.owner.personId, actor: ACTOR });
    expect((await w.h.store.get(taskThreadKey(w.h.deps.companyId, w.sessionId)))!["pk"]).toBe(orgScoped(w.h.deps.companyId, `CHANNEL_THREAD#${w.sessionId}`));
    expect(await w.record({ principal: w.owner })).toBe(true);
    expect(await readTaskThread(w.h.store, w.h.deps.companyId, w.sessionId)).toEqual(row);
    // The same task asked about with another thread: the first one is kept (written once).
    await w.record({ principal: w.owner }, { conversation: { ...CONVERSATION, thread: "1700000009.000900" } });
    expect((await readTaskThread(w.h.store, w.h.deps.companyId, w.sessionId))!.conversation.thread).toBe(TS);
  });

  it("a workspace of ANOTHER company is never remembered, and neither is one nobody owns or one whose actor is from another workspace", async () => {
    const w = await hosted();
    expect(await w.record({ principal: w.owner }, { conversation: { ...CONVERSATION, tenant: TEAM_B }, actor: { ...ACTOR, tenant: TEAM_B } })).toBe(false);
    expect(await w.record({ principal: w.owner }, { conversation: { ...CONVERSATION, tenant: "T0NOBODY000" }, actor: { ...ACTOR, tenant: "T0NOBODY000" } })).toBe(false);
    expect(await w.record({ principal: w.owner }, { actor: { ...ACTOR, tenant: TEAM_B } })).toBe(false);
    expect(await readTaskThread(w.h.store, w.h.deps.companyId, w.sessionId)).toBeUndefined();
  });

  it("only the task's own people: another member of the company, another company's person and a task that does not exist record nothing", async () => {
    const w = await hosted();
    const stranger: Principal = { ...localOwnerPrincipal({ companyId: w.h.deps.companyId }), personId: "someone-else", roles: ["member"] };
    expect(await w.record({ principal: stranger })).toBe(false);
    expect(await w.record({ principal: { ...w.owner, companyId: COMPANY_B } })).toBe(false);
    expect(await recordChatThread({ chatThreads: w.threads, runtimeFor: async () => ({ flow: { deps: w.h.deps } }), now: () => 1 }, { principal: w.owner }, { taskId: "00000000-0000-4000-8000-000000000000", conversation: CONVERSATION, actor: ACTOR })).toBe(false);
    expect(await readTaskThread(w.h.store, w.h.deps.companyId, w.sessionId)).toBeUndefined();
  });
});

// ---- the thread notices, on a hosted install

const STEP_ROW = (orgId: OrgId, project: string, key: string, state: RecheckState, now: string) => ({
  ...recheckRowKey(orgId, project, key), entityType: "SETUP_RECHECK", orgId, project, key, setupRevision: 1, commits: { demo: "c1" }, classes: ["lockfile"], state, attempt: 1,
  check: { workspaceId: "ws-1", revision: 1, startedAt: now, startedBy: "system" }, startedAt: now, ...(state === "broken" ? { failedStep: STEP } : {}),
});
async function seedRecheck(store: DocumentStore, orgId: OrgId, taskId: string, state: RecheckState, key = KEY): Promise<void> {
  const now = new Date().toISOString();
  await store.put({ item: JSON.parse(JSON.stringify(STEP_ROW(orgId, "payments", key, state, now))) as StoredDocument });
  await store.put({ item: JSON.parse(JSON.stringify({ ...driftTaskKey(orgId, "payments", taskId), entityType: "SETUP_DRIFT_TASK", orgId, project: "payments", taskId, recheckKey: key, state: "pending", at: now })) as StoredDocument });
}

function handlerOf(w: Hosted, options: { isMember?: (orgId: OrgId, personId: string) => boolean } = {}) {
  const companyId = w.h.deps.companyId;
  return channelThreadHandler({
    store: w.h.store, registry: { get: ((point: string, name: string) => (point === "channel" ? w.threads.adapterFor(companyId, name) : undefined)) as never },
    now: () => w.h.clock.now, companyOf: w.threads.companyOf, isMember: async (orgId, personId) => options.isMember?.(orgId, personId) ?? true,
  });
}
const paused = (w: Hosted): CodeMilestone => ({ kind: "setup_paused", orgId: w.h.deps.companyId, taskId: w.taskId, at: new Date().toISOString(), text: "x" });
const prReady = (w: Hosted): CodeMilestone => ({ kind: "pr_ready", orgId: w.h.deps.companyId, taskId: w.taskId, at: new Date().toISOString(), text: "ready", pullRequests: [{ repository: "demo", number: 7, url: "https://github.com/example/demo/pull/7" }] });

describe("a hosted Slack-started task is told in its thread", () => {

  it("the pull request line carries the setup evidence line when the setup could not be re-checked, and a pass keeps the plain pull request line", async () => {
    const unclear = await hosted();
    await unclear.record({ principal: unclear.owner });
    await seedRecheck(unclear.h.store, unclear.h.deps.companyId, unclear.taskId, "unclear");
    await handlerOf(unclear).on(prReady(unclear));
    expect(unclear.slack.posts).toHaveLength(1);
    expect(unclear.slack.posts[0]!.text).toContain("https://github.com/example/demo/pull/7");
    expect(unclear.slack.posts[0]!.text).toContain(setupNotRecheckedWords(["lockfile"]));
    const passed = await hosted();
    await passed.record({ principal: passed.owner });
    await seedRecheck(passed.h.store, passed.h.deps.companyId, passed.taskId, "passed");
    await handlerOf(passed).on(prReady(passed));
    expect(passed.slack.posts).toHaveLength(1);
    expect(passed.slack.posts[0]!.text).toContain("Pull request:");
    expect(passed.slack.posts[0]!.text).not.toContain(setupNotRecheckedWords(["lockfile"]));
  });

  it("a Slack post that fails does not claim the notice: the hook's retry posts it again, and a success is never repeated", async () => {
    const w = await hosted();
    await w.record({ principal: w.owner });
    await seedRecheck(w.h.store, w.h.deps.companyId, w.taskId, "broken");
    let failing = true;
    const slack = w.slack;
    const flaky = hostedSlackThreads({ workspaces: workspaces({ [TEAM_A]: { company: w.h.deps.companyId, token: TOKEN_A } }), fetch: (async (url: string | URL, init?: RequestInit) => (failing && String(url).endsWith("chat.postMessage") ? new Response("{}", { status: 500 }) : slack.fetchImpl(url, init))) as never });
    const handler = channelThreadHandler({ store: w.h.store, registry: { get: ((point: string, name: string) => (point === "channel" ? flaky.adapterFor(w.h.deps.companyId, name) : undefined)) as never }, now: () => w.h.clock.now, companyOf: flaky.companyOf });
    await expect(handler.on(paused(w))).rejects.toThrow();
    failing = false;
    await handler.on(paused(w));
    await handler.on(paused(w));
    expect(slack.posts).toHaveLength(1);
  });
});

describe("the wiring (guards on the source, beside the behaviour above)", () => {
  const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

  it("a Slack start asks the core first, with the Slack person's own caller, and the old start still follows", () => {
    const source = read("packages/broker/src/aws/broker.ts");
    expect(source).toMatch(/dependencies\.workspaces === undefined \|\| company === undefined \? undefined : await startSlackWorkflowOnCore\(dependencies\.developer\.coreTasks, \{ caller, companyId: company, thread, userId, requestId, project: binding\.projectName, instructions, workflowPath: event\.workflowPath \}/u);
    expect(source).toMatch(/if \(onCore !== undefined\) return \{ task: \{ taskId: onCore\.taskId \} \};\n\s+const developer = /u);
    expect(source).toContain("shareToChannel: true, channel: thread.channelId");
  });

  it("the hosted core root builds the Slack seam from the company workspaces only in company mode, and registers the thread handler on the company's milestones beside the ticket write-back", () => {
    const source = read("packages/broker/src/aws/broker.ts");
    expect(source).toMatch(/\.\.\.\(slackCompany === undefined \? \{\} : \{ chatThreads: hostedSlackThreads\(\{ workspaces: slackCompany\.workspaces/u);
    const root = read("packages/broker/src/aws/core-engine-root.ts");
    expect(root).toMatch(/if \(inputs\.chatThreads !== undefined\) \{[\s\S]{0,400}milestones\.register\(hostedThreadHandler\(\{/u);
    expect(root).toContain("isMember: async (orgId, personId) => (await membershipOf(personId))?.companyId === orgId");
    expect(root).toContain("coreTaskEntryFrom(routes, deployedCallerOf, chatThreads === undefined ? undefined : (deployed, input) => recordChatThread(");
  });

  it("the thread's own tenant is the company's before anything is written, and the task must be one the caller may act on", () => {
    const source = read("packages/broker/src/core-host/chat-thread-record.ts");
    expect(source).toContain("(await deps.chatThreads.companyOf({ channel: input.conversation.channel, tenant: input.conversation.tenant })) !== companyId");
    expect(source).toContain("!(await flowDeps.access.canAct(deployed.principal, task))");
  });
});
