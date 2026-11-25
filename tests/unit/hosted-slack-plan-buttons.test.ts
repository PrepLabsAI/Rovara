// L4-HW5b (owner decision 2026-11-18): the hosted Slack plan card matches the laptop's. A low or medium risk plan's card has Approve and Request changes in Slack; a high risk plan keeps "Open the task". Everything below runs the REAL
// pieces over the memory store: the hosted approvers with their `chat-slack` method, the company's decision gate (`hostedDecisionService`), the hosted Slack seam over a fake web API, the person resolver over real link rows, the core entry
// (`coreTaskEntryFrom` -> `chatDecision`), the broker's route (`slackCorePress`) and the interactivity handlers (`corePlanPressHandler`, `corePlanSubmission`). Mutants are listed in the PR body with the test that kills each.
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  SLACK_CHANNEL, WORKFLOW_STOP_ACTION, taskActionButtonId, taskActionOfButtonId, canonicalPlanJson, createWorkflowSnapshot, orgChannelLinkKey, orgProjectCatalogKey, projectRevisionKey, submitWorkflowArtifact,
  type ActorRef, type AdapterRegistry, type ConversationRef, type JsonValue, type OrgId, type OrgRole, type Principal, type ProjectDefinition, type WorkflowSnapshot,
} from "@agentx/contracts";
import type { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createCoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { coreAdapter } from "../../packages/broker/src/core-host/registry.js";
import { HOSTED_IDENTITY_PROVIDER, createHostedIdentity } from "../../packages/broker/src/core-host/hosted-modules.js";
import { chatApprovalMethod, createHostedApprovers, approvalProofKeyOf } from "../../packages/broker/src/core-host/hosted-approvers.js";
import { hostedChatApproval, hostedDecisionService, type DeployedPeople } from "../../packages/broker/src/core-host/deployed-decisions.js";
import { decideFromChat } from "../../packages/broker/src/core-host/chat-decision.js";
import { createTaskActionRoutes, relinkedBefore } from "../../packages/broker/src/core-host/task-action-routes.js";
import { chatPressToken } from "../../packages/broker/src/core-host/hosted-chat-approval.js";
import { hostedThreadHandler } from "../../packages/broker/src/core-host/thread-notification.js";
import { coreTaskEntryFrom, type CoreEntryCaller, type CoreTaskEntry } from "../../packages/broker/src/aws/engine-boundary.js";
import { deployedCallerFromMembership, hostedTaskAccess } from "../../packages/broker/src/aws/core-engine-root.js";
import { hostedSlackThreads } from "../../packages/broker/src/aws/slack-thread-channel.js";
import { createSlackPersonResolver } from "../../packages/broker/src/aws/slack-person.js";
import { isSlackCorePressEvent, slackCorePress, type SlackCorePressEvent } from "../../packages/broker/src/aws/slack-core-decision.js";
import { APPROVED_CARD_WORDS, CHANGES_CARD_WORDS, CORE_APPROVE_ACTION, CORE_CHANGES_ACTION, corePlanPressHandler, corePlanSubmission, type CorePlanPressDeps } from "../../packages/broker/src/aws/slack-core-plan-press.js";
import { SLACK_ACTION_CLASSES, slackActionClass } from "../../packages/broker/src/aws/slack-action-classes.js";
import { createSlackInteractivityHandler, createSlackPressDispatcher, type SlackBlockAction } from "../../packages/broker/src/aws/slack-interactivity.js";
import { cardKey, readApprovalCard } from "../../packages/broker/src/core/channel/cards.js";
import { issueChannelLinkCode, redeemChannelLinkCode } from "../../packages/broker/src/core/channel/links.js";
import { recordTaskThread } from "../../packages/broker/src/core/channel/threads.js";
import { decisionRefusalWords } from "../../packages/broker/src/core/channel/sink.js";
import { WORKFLOW_DOCUMENT_KIND } from "../../packages/broker/src/core/decisions/workflow-subject.js";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { taskSessionId } from "../../packages/broker/src/core/sessions/index.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { CHANGES_CALLBACK, CHANGES_INPUT } from "../../packages/broker/src/plugins/channel/slack/index.js";
import { TASK_ACTION_FORM } from "../../packages/broker/src/plugins/channel/slack/task-actions.js";
import { channelActionOfPress, channelActionOfSubmission } from "../../packages/broker/src/aws/slack-press-routing.js";
import { FAKE_COMPANY, createFakeWorld } from "../support/core-host-fakes.js";
import { planDocument } from "../support/plan-documents.js";

const ORG = FAKE_COMPANY as OrgId;
const OTHER = "org_corehost00000000000b" as OrgId;
const TEAM_A = "T0AAAAAAAAA";
const TEAM_B = "T0BBBBBBBBB";
const CHANNEL = "C0123456789";
const TS = "1700000000.000100";
const CARD_TS = "1700000001.000200";
const OWNER = "U0OWNER0001";
const PEER = "U0PEER00001";
const STRANGER = "U0STRANGER1";
const LEFT = "U0LEFT000001";
const OTHERCO = "U0OTHERCO01";
const ORIGIN = "https://app.example";
const tokenOf = (label: string): string => ["xoxb", "1111111111", label].join("-");
const TOKEN_A = tokenOf("aaaaaaaaaa");
const TOKEN_B = tokenOf("bbbbbbbbbb");
const RESPONSE_URL = "https://hooks.slack.com/actions/T0AAAAAAAAA/1/x";
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const CONVERSATION: ConversationRef = { channel: SLACK_CHANNEL, tenant: TEAM_A, space: CHANNEL, thread: TS };
const ACTOR = (userId: string, tenant: string = TEAM_A): ActorRef => ({ channel: SLACK_CHANNEL, tenant, userId });
const principalOf = (personId: string, companyId: string = ORG): Principal => ({ companyId, personId, displayName: personId, roles: ["member"], provider: HOSTED_IDENTITY_PROVIDER });
const PROOF_KEY = approvalProofKeyOf("k".repeat(32));
const proved = { proposed: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 60 } }], proves: { unit: ["1", "2"] } };

type Kind = "low" | "medium" | "high";
/** What the plan is, so its risk is the core's own grade: a structured plan with a plain file and every claim proved is low; a Markdown plan is unread (medium); one that names an infrastructure file is high. */
function planFor(kind: Kind): { text: string; format: "markdown" | "structured" } {
  if (kind === "medium") return { text: "# Plan\n\nChange src/health.ts to answer 200.\n", format: "markdown" };
  if (kind === "high") return { text: "# Plan\n\nChange infra/iam/policy.json.\n", format: "markdown" };
  const claims = [{ id: "1", text: "Retry in src/retry/backoff.ts." }, { id: "2", text: "A retry is never charged twice." }];
  return { text: canonicalPlanJson(planDocument({ title: "Retry failed calls", claims, decisions: [], checks: proved, why: [{ text: "Retries are missing.", author: "Priya" }], risks: ["A slow gateway."] })), format: "structured" };
}

/** Slack's web API as a fake: who the bot is (the workspace the token belongs to), every post and every update, with the token that made it. */
function fakeSlack() {
  const posts: Array<{ token: string; channel: string; thread_ts?: string; text: string; blocks?: Array<Record<string, unknown>> }> = [];
  const updates: Array<{ token: string; channel: string; ts: string; text: string; blocks: Array<Record<string, unknown>> }> = [];
  const views: Array<{ token: string; trigger_id: string; view: Record<string, unknown> }> = [];
  const tokenTeams: Record<string, string> = { [TOKEN_A]: TEAM_A, [TOKEN_B]: TEAM_B };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).replace("https://slack.com/api/", "");
    const token = String((init?.headers as Record<string, string>)["authorization"]).replace("Bearer ", "");
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    if (method === "auth.test") return new Response(JSON.stringify({ ok: true, team_id: tokenTeams[token] ?? "T0UNKNOWN00", user_id: "U0BOT000000" }), { status: 200 });
    if (method === "canvases.create") return Response.json({ ok: true, canvas_id: "F0123456789" });
    if (method === "canvases.access.set" || method === "canvases.delete") return Response.json({ ok: true });
    if (method.startsWith("files.info")) return Response.json({ ok: true, file: { permalink: "https://example.slack.com/docs/F0123456789" } });
    if (method === "chat.postMessage") {
      posts.push({ token, channel: String(body["channel"]), ...(typeof body["thread_ts"] === "string" ? { thread_ts: body["thread_ts"] } : {}), text: String(body["text"]), ...(Array.isArray(body["blocks"]) ? { blocks: body["blocks"] as Array<Record<string, unknown>> } : {}) });
      return new Response(JSON.stringify({ ok: true, ts: CARD_TS }), { status: 200 });
    }
    if (method === "chat.update") { updates.push({ token, channel: String(body["channel"]), ts: String(body["ts"]), text: String(body["text"]), blocks: body["blocks"] as Array<Record<string, unknown>> }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }
    if (method === "views.open") { views.push({ token, trigger_id: String(body["trigger_id"]), view: body["view"] as Record<string, unknown> }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }
    return new Response(JSON.stringify({ ok: false, error: "unsupported" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { posts, updates, views, fetchImpl };
}
const buttonsOf = (post: { blocks?: Array<Record<string, unknown>> } | undefined): Array<Record<string, unknown>> =>
  (post?.blocks ?? []).flatMap((block) => (block["type"] === "actions" ? (block["elements"] as Array<Record<string, unknown>>) : []));

/**
 * The company's world, wired as the broker wires it: ORG has dev-a (the task's own person; Slack OWNER is linked to them), dev-b (a member who owns nothing here; PEER is linked to them), and dev-gone (their membership ended; LEFT is
 * linked to them); company OTHER has dev-x (OTHERCO, in TEAM_B). STRANGER is linked to nobody. The task waits on a plan of the given kind, and its card has been posted to its thread.
 */
async function world(options: { kind?: Kind; post?: boolean; withChat?: boolean; taskOwner?: NonNullable<Parameters<typeof createHostedApprovers>[0]["taskOwner"]> } = {}) {
  const kind = options.kind ?? "medium";
  const fake = createFakeWorld({ without: ["approvers", "identity"] });
  const memberships = new Map<string, { companyId: OrgId; role: OrgRole }>([["dev-a", { companyId: ORG, role: "member" }], ["dev-b", { companyId: ORG, role: "member" }], ["dev-gone", { companyId: ORG, role: "member" }], ["dev-x", { companyId: OTHER, role: "owner" }]]);
  const grants = new Map<string, "developer" | "administrator">([["dev-a", "developer"], ["dev-b", "developer"], ["dev-x", "administrator"]]);
  const people: DeployedPeople = { membershipOf: async (personId) => memberships.get(personId), projectGrantRole: async (personId) => grants.get(personId) };
  const identity = createHostedIdentity({ membershipOf: people.membershipOf, displayNameOf: async (personId) => personId });
  const slack = fakeSlack();
  const teams: Record<string, { company: OrgId; token: string }> = { [TEAM_A]: { company: ORG, token: TOKEN_A }, [TEAM_B]: { company: OTHER, token: TOKEN_B } };
  const companies = { companyOf: async (personId: string) => memberships.get(personId)?.companyId };
  const bindings = { requireCompany: async (team: string): Promise<string> => { const found = teams[team]; if (found === undefined) throw new Error("no such workspace"); return found.company; } };
  const threads = hostedSlackThreads({
    workspaces: { requireCompany: bindings.requireCompany, tokenForCompany: async (company: string, team: string) => (teams[team]?.company === company ? teams[team]?.token : undefined) },
    fetch: slack.fetchImpl,
    person: createSlackPersonResolver({ workspaces: bindings, store: fake.store, companies, now: () => fake.clock.now }),
  });
  const approvers = (): ReturnType<typeof createHostedApprovers> => createHostedApprovers({
    store: fake.store, identity, key: PROOF_KEY, now: () => new Date(fake.clock.now),
    ...(options.withChat === false ? {} : { chat: hostedChatApproval(threads, people, PROOF_KEY) }),
    ...(options.taskOwner === undefined ? {} : { taskOwner: options.taskOwner }),
  });
  fake.modules.push(coreAdapter({ point: "identity", name: HOSTED_IDENTITY_PROVIDER, owner: "fake", create: () => identity }));
  fake.modules.push(coreAdapter({ point: "approvers", name: "deployed", owner: "fake", create: () => approvers() }));
  for (const companyId of [ORG, OTHER]) {
    await fake.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
    await fake.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
  }
  const app = createCoreHostApp({
    modules: fake.modules, context: () => fake.context(), nowMs: () => fake.clock.now,
    runtime: (_registry, companyId) => ({
      callbackSigningKey: Buffer.alloc(32, 7), access: hostedTaskAccess({ companyId, membershipOf: people.membershipOf, projectGrant: async () => true }),
      repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(fake.clock.now), log: () => undefined,
      services: () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } }),
      ciReporting: { honest: true as const, ciMode: () => "their_ci_fix" as const },
    }),
  });
  // The approval cards that exist (written, and not removed because their send failed): by request id.
  const cards = new Set<string>();
  const put = fake.store.put.bind(fake.store);
  fake.store.put = async (input) => { const written = await put(input); const item = input.item as Record<string, unknown>; if (written.applied && item["entityType"] === "CHANNEL_CARD" && typeof item["requestId"] === "string") cards.add(item["requestId"]); return written; };
  const registry: AdapterRegistry = await app.registry();
  const storage = registry.require("storage");
  const runtime = await app.runtimeFor(ORG);
  const deps = runtime.flow.deps;
  // A structured plan's work breakdown is read back from the company's stored documents when it is approved (the deployed root gives the flow its artifact reader; this fake runtime has none).
  Object.assign(deps, { artifacts: registry.require("object-storage") });
  const { task } = await runtime.flow.start({ principal: principalOf("dev-a"), client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
  const stored = (await fake.store.get(taskKey(task.taskId)))!;
  const ownerKey = stored["ownerKey"] as string;
  const objectKey = `private/${ownerKey}/${stored["workspaceId"] as string}/plan-v1.${planFor(kind).format === "structured" ? "json" : "md"}`;
  const plan = planFor(kind);
  await registry.require("object-storage").put(objectKey, new TextEncoder().encode(plan.text), { contentType: "text/markdown", metadata: {}, retention: "evidence-std" });
  const initial = createWorkflowSnapshot({ taskId: task.taskId, ownerId: ownerKey, now: "2026-11-15T09:59:00.000Z", definitionVersion: "1.1.0" });
  const workflow = submitWorkflowArtifact(initial, {
    expectedRevision: initial.revision, now: "2026-11-15T10:00:00.000Z",
    artifact: { id: "plan-v1", type: "plan", version: 1, sha256: createHash("sha256").update(plan.text).digest("hex"), producer: "agentx-planner", objectKey, createdAt: "2026-11-15T10:00:00.000Z", format: plan.format },
  });
  const sessionId = taskSessionId(task.taskId);
  await fake.store.put({ item: { ...stored, sessionId, workflow: JSON.parse(JSON.stringify(workflow)) as JsonValue } });
  await recordTaskThread({ store: storage, orgId: ORG, now: () => fake.clock.now }, { sessionId, conversation: CONVERSATION, personId: "dev-a", actor: ACTOR(OWNER) });
  // The links the chat people made (real rows, company-scoped), as `redeemChannelLinkCode` writes them.
  const link = async (org: OrgId, actor: ActorRef, personId: string): Promise<void> => {
    const linkDeps = { store: fake.store, orgId: org, now: () => fake.clock.now };
    const { code } = await issueChannelLinkCode(linkDeps, actor);
    await redeemChannelLinkCode(linkDeps, personId, code);
  };
  await link(ORG, ACTOR(OWNER), "dev-a");
  await link(ORG, ACTOR(PEER), "dev-b");
  await link(ORG, ACTOR(LEFT), "dev-gone");
  await link(OTHER, ACTOR(OTHERCO, TEAM_B), "dev-x");
  memberships.delete("dev-gone");
  const handler = hostedThreadHandler({
    threads, registry, companyId: ORG, deps, now: () => fake.clock.now, clock: () => new Date(fake.clock.now), origin: () => ORIGIN,
    isMember: async (orgId, personId) => (await people.membershipOf(personId))?.companyId === orgId, log: () => undefined,
  });
  const milestone = { kind: "plan_ready", orgId: ORG, taskId: task.taskId, at: new Date(fake.clock.now).toISOString(), text: "x" } as never;
  if (options.post !== false) await handler.on(milestone);
  const gateOf = (companyId: OrgId = ORG) => hostedDecisionService({ deps: runtime.flow.deps, registry, companyId, now: () => new Date(fake.clock.now) }).gate;
  // The core entry, as the root builds it: the caller's live membership, then `decideFromChat` over the company's own store and gate.
  const decisionLog: Array<Record<string, unknown>> = [];
  const entry: CoreTaskEntry = coreTaskEntryFrom(
    { route: async () => undefined }, deployedCallerFromMembership(people.membershipOf), undefined, undefined,
    (deployed, press) => decideFromChat({
      chatThreads: threads, proofKey: PROOF_KEY, now: () => fake.clock.now, log: (entry) => decisionLog.push(entry),
      companyFor: async (companyId) => ({ store: (await app.runtimeFor(companyId)).flow.deps.store, gate: hostedDecisionService({ deps: (await app.runtimeFor(companyId)).flow.deps, registry, companyId, now: () => new Date(fake.clock.now) }).gate }),
    }, deployed, press),
  );
  // The broker's own mapping of a Slack account to a caller (`companySlackCaller`): a linked member of the workspace's company, or a refusal.
  const resolve = createSlackPersonResolver({ workspaces: bindings, store: fake.store, companies, now: () => fake.clock.now });
  const callerOf = (teamId: string, userId: string) => async () => {
    const person = await resolve({ teamId, userId });
    if (person.kind !== "linked") throw new Error("not linked");
    return { developerId: person.personId, sessionId: "s", name: "Rovara member" };
  };
  const post = slack.posts[0];
  const button = (id: string): Record<string, unknown> | undefined => buttonsOf(post).find((entryButton) => entryButton["action_id"] === id);
  const calls: string[] = [];
  const ephemerals: string[] = [];
  const pressDeps: CorePlanPressDeps = {
    async ask(press) {
      calls.push(`${press.decision}:${press.actor.userId}`);
      const teamId = press.conversation.tenant;
      const event: SlackCorePressEvent = { source: "agentx.slack-ingress", action: "core-plan-press", press };
      expect(isSlackCorePressEvent(event)).toBe(true);
      return await slackCorePress(entry, event, { caller: callerOf(teamId, press.actor.userId) });
    },
    openView: async (triggerId, view) => { slack.views.push({ token: TOKEN_A, trigger_id: triggerId, view }); },
    respondEphemeral: async (_url, text) => { ephemerals.push(text); },
    update: async (input) => { slack.updates.push({ token: TOKEN_A, channel: input.channel, ts: input.ts, text: input.text, blocks: input.blocks as Array<Record<string, unknown>> }); },
    now: () => fake.clock.now, log: () => undefined,
  };
  const action = (userId: string, id: string, extra: Partial<SlackBlockAction> = {}): SlackBlockAction => ({
    actionId: id, value: String((button(id)?.["value"] as string | undefined) ?? ""), userId, userTeamId: TEAM_A, workspaceTeamId: TEAM_A, enterpriseId: "", userEnterpriseId: "", requestStartedAt: Date.now(),
    thread: { teamId: TEAM_A, channelId: CHANNEL, threadTs: TS }, messageTs: CARD_TS, messageText: post?.text ?? "", responseUrl: RESPONSE_URL, triggerId: `trig-${randomUUID().slice(0, 8)}`, actionTs: "1700000002.000300", ...extra,
  });
  const stepWorkflow = async (): Promise<WorkflowSnapshot> => (await fake.store.get(taskKey(task.taskId)))!["workflow"] as unknown as WorkflowSnapshot;
  const cardId = async (): Promise<string | undefined> => [...cards][0];
  /** Every row of the store, whole: what "nothing was written" is compared against. */
  const snapshot = async (): Promise<string> => {
    const rows: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = await (fake.store as MemoryDocumentStore).scanPage({ limit: 500, ...(cursor === undefined ? {} : { cursor }) });
      rows.push(...page.items);
      cursor = page.cursor;
    } while (cursor !== undefined);
    return JSON.stringify(rows.map((row) => JSON.stringify(row)).sort());
  };
  return { fake, cards, bindings, companies, teams, app, registry, storage, runtime, deps, memberships, grants, people, task, sessionId, slack, threads, handler, milestone, approvers, entry, decisionLog, callerOf, post, button, pressDeps, action, calls, ephemerals, stepWorkflow, cardId, gateOf, snapshot, link };
}
type World = Awaited<ReturnType<typeof world>>;

const decisionsOf = async (w: World): Promise<string[]> => (await w.stepWorkflow()).decisions.map((entry) => entry.decision);
const approvedAudit = (w: World) => w.fake.audit.filter((event) => String(event.action).startsWith("decision."));

describe("the plan card on a hosted Slack thread (HW5b)", () => {

  it.each(["low", "medium"] as const)("%s risk: the task's own person approves with a press: the plan is approved, the card is updated in place (no buttons left), the audit event is written with the decision", async (kind) => {
    const w = await world({ kind });
    const dispatch = createSlackPressDispatcher({ handlers: [corePlanPressHandler(w.pressDeps)], respondEphemeral: async () => undefined });
    await dispatch(w.action(OWNER, CORE_APPROVE_ACTION));
    expect(await decisionsOf(w)).toEqual(["APPROVE"]);
    expect((await w.stepWorkflow()).stage).not.toBe("PLAN_REVIEW");
    expect(w.slack.updates).toHaveLength(1);
    expect(w.slack.updates[0]).toMatchObject({ channel: CHANNEL, ts: CARD_TS });
    expect(w.slack.updates[0]!.text).toContain(APPROVED_CARD_WORDS);
    expect(JSON.stringify(w.slack.updates[0]!.blocks)).not.toContain("rovara_decide");
    const audit = approvedAudit(w);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ companyId: ORG, action: "decision.approved" });
    expect(w.ephemerals).toEqual([]);
  });

  it("Request changes opens the same box the laptop opens; the words typed in it are the reason of the request, and the card is updated in place", async () => {
    const w = await world({ kind: "medium" });
    const pressed = w.action(OWNER, CORE_CHANGES_ACTION);
    await corePlanPressHandler(w.pressDeps).handle(pressed);
    // Nothing is decided by the press itself.
    expect(await decisionsOf(w)).toEqual([]);
    expect(w.slack.views).toHaveLength(1);
    const view = w.slack.views[0]!.view as { callback_id: string; private_metadata: string; blocks: Array<{ block_id: string }> };
    expect(view.callback_id).toBe(CHANGES_CALLBACK);
    expect(view.blocks[0]!.block_id).toBe(CHANGES_INPUT);
    const submit = corePlanSubmission(w.pressDeps);
    const submission = (userId: string, typed: string, overrides: Record<string, unknown> = {}) => ({
      type: "view_submission", user: { id: userId, team_id: TEAM_A }, team: { id: TEAM_A },
      view: { id: "V0BOX00001", callback_id: CHANGES_CALLBACK, private_metadata: view.private_metadata, state: { values: { [CHANGES_INPUT]: { text: { value: typed } } } }, ...overrides },
    });
    // Nothing typed: the box shows an error and stays open; nothing is decided.
    expect(await submit(submission(OWNER, "   "))).toEqual({ response_action: "errors", errors: { [CHANGES_INPUT]: "Say what should change." } });
    expect(await decisionsOf(w)).toEqual([]);
    // Another person sending the opener's box: closed, nothing decided.
    expect(await submit(submission(PEER, "Use a queue"))).toEqual({ response_action: "clear" });
    expect(await decisionsOf(w)).toEqual([]);
    expect(await submit(submission(OWNER, "Use <@U0OWNER0001> a queue\nplease"))).toEqual({ response_action: "clear" });
    expect(await decisionsOf(w)).toEqual(["REQUEST_CHANGES"]);
    const record = (await w.stepWorkflow()).decisions[0]!;
    // The reason is made safe the way the laptop makes it: no mention, one line.
    expect(record.reason).toBe("Use @member a queue please");
    expect(w.slack.updates).toHaveLength(1);
    expect(w.slack.updates[0]!.text).toContain(CHANGES_CARD_WORDS);
    expect(w.slack.updates[0]).toMatchObject({ channel: CHANNEL, ts: CARD_TS });
    expect(approvedAudit(w).map((event) => event.action)).toEqual(["decision.changes_requested"]);
  });

  it("the box's metadata stays within Slack's limit and still reads back, even for a quote-heavy card text", async () => {
    const w = await world({ kind: "medium" });
    const long = '"\\'.repeat(750);
    await corePlanPressHandler(w.pressDeps).handle(w.action(OWNER, CORE_CHANGES_ACTION, { messageText: long }));
    const metadata = (w.slack.views[0]!.view as { private_metadata: string }).private_metadata;
    expect(metadata.length).toBeLessThanOrEqual(2_800);
    const submission = { type: "view_submission", user: { id: OWNER, team_id: TEAM_A }, team: { id: TEAM_A }, view: { id: "V0BOX00009", callback_id: CHANGES_CALLBACK, private_metadata: metadata, state: { values: { [CHANGES_INPUT]: { text: { value: "Use a queue" } } } } } };
    expect(await corePlanSubmission(w.pressDeps)(submission)).toEqual({ response_action: "clear" });
    expect(await decisionsOf(w)).toEqual(["REQUEST_CHANGES"]);
  });

  it("a forged press for a HIGH risk plan (a button the card never had) is refused at every layer, and nothing is written", async () => {
    const w = await world({ kind: "high" });
    const before = await w.stepWorkflow();
    const rowsBefore = await w.snapshot();
    // The approvers' own rule: a chat press is never accepted above medium (the gate refuses it before that: the method is not offered).
    const gate = w.gateOf();
    const requirement = await gate.requirement(ORG, WORKFLOW_DOCUMENT_KIND, w.task.taskId);
    expect(requirement?.risk).toBe("high");
    expect(requirement?.requirement.methods).toEqual(["rovara-step-up"]);
    for (const outcome of ["approve", "request_changes", "reject"] as const) {
      const result = await gate.decide({
        companyId: ORG, kind: WORKFLOW_DOCUMENT_KIND, subjectId: w.task.taskId, requestId: randomUUID(), outcome, seen: { revision: requirement!.revision, artifactDigest: requirement!.artifactDigest },
        credentials: [{ method: chatApprovalMethod("slack"), token: "forged", claimedAccount: { provider: SLACK_CHANNEL, tenant: TEAM_A, accountId: OWNER } }], reason: "Pressed in chat.",
      });
      expect(result.status).toBe("refused");
    }
    // The press through the whole path: a made-up card (a card is Rovara's own record; there is none for this plan with a button) is "not open".
    const forged = { actionId: CORE_APPROVE_ACTION, value: JSON.stringify({ r: randomUUID(), v: requirement!.revision, d: requirement!.artifactDigest, o: "APPROVE" }) };
    await corePlanPressHandler(w.pressDeps).handle(w.action(OWNER, CORE_APPROVE_ACTION, forged));
    expect(w.ephemerals).toEqual([decisionRefusalWords("not_open")]);
    // Even the real high-risk card's own record: the core's rule says it is never decided in a chat.
    const card = (await readApprovalCard({ store: w.storage, orgId: ORG, now: () => w.fake.clock.now }, [...(await cardIds(w))][0]!))!;
    expect(card.risk).toBe("high");
    expect(card.offered).toEqual([]);
    const real = { actionId: CORE_APPROVE_ACTION, value: JSON.stringify({ r: card.requestId, v: card.revision, d: card.artifactDigest, o: "APPROVE" }) };
    await corePlanPressHandler(w.pressDeps).handle(w.action(OWNER, CORE_APPROVE_ACTION, real));
    expect(w.ephemerals.at(-1)).toBe(decisionRefusalWords("step_up"));
    expect(await w.stepWorkflow()).toEqual(before);
    expect(await w.snapshot()).toBe(rowsBefore);
    expect(approvedAudit(w)).toEqual([]);
    expect(w.slack.updates).toEqual([]);
  });

  it("refused, and nothing written: a member who is not the task's person, an unlinked account, a person who left the company, a person with no project grant", async () => {
    for (const [name, who, adjust] of [
      ["a member who is not the task's own person", PEER, undefined],
      ["an account linked to nobody", STRANGER, undefined],
      ["a person whose membership ended", LEFT, undefined],
      ["the task's own person, whose project grant was removed", OWNER, (w: World) => w.grants.delete("dev-a")],
    ] as const) {
      const w = await world({ kind: "medium" });
      adjust?.(w);
      const before = await w.stepWorkflow();
      const stored = await w.snapshot();
      const dispatch = createSlackPressDispatcher({ handlers: [corePlanPressHandler(w.pressDeps)], respondEphemeral: async () => undefined });
      await dispatch(w.action(who, CORE_APPROVE_ACTION));
      expect(await w.stepWorkflow(), name).toEqual(before);
      expect(await decisionsOf(w), name).toEqual([]);
      expect(w.slack.updates, name).toEqual([]);
      expect(approvedAudit(w), name).toEqual([]);
      expect(await w.snapshot(), name).toBe(stored);
      // The person is told, privately and in fixed words, that it could not be applied from here.
      expect(w.ephemerals, name).toHaveLength(1);
      expect(w.ephemerals[0], name).toMatch(/Open the task page|no longer linked/u);
    }
  });

  it("another company's workspace, and a person of another company in this company's workspace, are refused and nothing is written", async () => {
    const w = await world({ kind: "medium" });
    const before = await w.stepWorkflow();
    const rowsBefore = await w.snapshot();
    // Company OTHER's person presses THIS company's card, from their own workspace (a card is under its own company's key, so it is not found there).
    const fromOther = w.action(OTHERCO, CORE_APPROVE_ACTION, { userTeamId: TEAM_B, workspaceTeamId: TEAM_B, thread: { teamId: TEAM_B, channelId: CHANNEL, threadTs: TS } });
    await corePlanPressHandler(w.pressDeps).handle(fromOther);
    expect(w.ephemerals.at(-1)).toBe(decisionRefusalWords("not_open"));
    // Company OTHER's person presses it from THIS company's workspace: the account is linked in another company, so it is nobody here.
    await corePlanPressHandler(w.pressDeps).handle(w.action(OTHERCO, CORE_APPROVE_ACTION));
    expect(w.ephemerals).toHaveLength(2);
    // This company's person, from a guest account of another workspace (Slack Connect): refused before anything is asked.
    const asked = w.calls.length;
    await corePlanPressHandler(w.pressDeps).handle(w.action(OWNER, CORE_APPROVE_ACTION, { userTeamId: TEAM_B }));
    expect(w.calls.length).toBe(asked);
    expect(await w.stepWorkflow()).toEqual(before);
    expect(approvedAudit(w)).toEqual([]);
    // The core's own rule, past the Lambda: a press whose conversation is a workspace of ANOTHER company is refused with nothing claimed.
    const answer = await w.entry.chatDecision!({ developerId: "dev-a", sessionId: "s", name: "x" }, {
      conversation: { channel: SLACK_CHANNEL, tenant: TEAM_B, space: CHANNEL, thread: TS }, actor: ACTOR(OWNER, TEAM_B), eventId: "evt-other", requestId: (await w.cardId())!, expectedRevision: 1, artifactDigest: "a".repeat(64), decision: "APPROVE", reason: "x",
    });
    expect(answer).toEqual({ outcome: "refused", reason: "not_allowed" });
    expect(await w.stepWorkflow()).toEqual(before);
    expect(await w.snapshot()).toBe(rowsBefore);
  });

  it("the core's own rules past the Lambda: an account of another workspace than the conversation's, and a caller who is not the account's person, are refused and nothing is written", async () => {
    const w = await world({ kind: "medium" });
    const rowsBefore = await w.snapshot();
    const base = { conversation: CONVERSATION, actor: ACTOR(OWNER), eventId: "evt-core-1", requestId: (await w.cardId())!, expectedRevision: 1, artifactDigest: "a".repeat(64), decision: "APPROVE" as const, reason: "x" };
    const owner: CoreEntryCaller = { developerId: "dev-a", sessionId: "s", name: "x" };
    // A guest of another workspace in this company's conversation.
    expect(await w.entry.chatDecision!(owner, { ...base, actor: ACTOR(OWNER, TEAM_B) })).toEqual({ outcome: "refused", reason: "not_allowed" });
    // The broker resolved dev-b, but the account is dev-a's.
    expect(await w.entry.chatDecision!({ developerId: "dev-b", sessionId: "s", name: "x" }, base)).toEqual({ outcome: "refused", reason: "link_gone" });
    // A caller with no membership at all.
    expect(await w.entry.chatDecision!({ developerId: "dev-gone", sessionId: "s", name: "x" }, base)).toEqual({ outcome: "refused", reason: "not_approved" });
    // A rejection or a skip is no decision the chat can take.
    expect(await w.entry.chatDecision!(owner, { ...base, decision: "REJECT" as never })).toEqual({ outcome: "refused", reason: "invalid" });
    expect(await w.entry.chatDecision!(owner, { ...base, decision: "SKIP" as never })).toEqual({ outcome: "refused", reason: "invalid" });
    expect(await w.snapshot()).toBe(rowsBefore);
    expect(await decisionsOf(w)).toEqual([]);
  });

  it("the core checks the press against the card itself: a press naming another revision or digest than the card's, a card that is not a plan's, and a request for changes with no words are refused with nothing written", async () => {
    const w = await world({ kind: "medium" });
    const card = (await readApprovalCard({ store: w.storage, orgId: ORG, now: () => w.fake.clock.now }, [...w.cards][0]!))!;
    const owner: CoreEntryCaller = { developerId: "dev-a", sessionId: "s", name: "x" };
    const press = { conversation: CONVERSATION, actor: ACTOR(OWNER), requestId: card.requestId, expectedRevision: card.revision, artifactDigest: card.artifactDigest, decision: "APPROVE" as const, reason: "x" };
    const rowsBefore = await w.snapshot();
    expect(await w.entry.chatDecision!(owner, { ...press, eventId: "evt-a", expectedRevision: card.revision + 1 })).toEqual({ outcome: "refused", reason: "stale" });
    expect(await w.entry.chatDecision!(owner, { ...press, eventId: "evt-b", artifactDigest: "d".repeat(64) })).toEqual({ outcome: "refused", reason: "stale" });
    expect(await w.entry.chatDecision!(owner, { ...press, eventId: "evt-c", decision: "REQUEST_CHANGES", reason: "  \u0007 " })).toEqual({ outcome: "refused", reason: "empty_reason" });
    // A card that is not a plan's approval (here: an "other" card on the same plan, offering Approve) is never decided in a chat.
    const other = randomUUID();
    await w.fake.store.put({ item: { ...cardKey(ORG, other), entityType: "CHANNEL_CARD", requestId: other, channel: SLACK_CHANNEL, kind: "other", subject: card.subject, revision: card.revision, artifactDigest: card.artifactDigest, conversation: CONVERSATION, offered: ["APPROVE"], sentAt: new Date(w.fake.clock.now).toISOString(), expiresAt: Math.floor(w.fake.clock.now / 1000) + 3600 } });
    const withOther = await w.snapshot();
    expect(await w.entry.chatDecision!(owner, { ...press, eventId: "evt-d", requestId: other })).toEqual({ outcome: "refused", reason: "step_up" });
    expect(await w.snapshot()).toBe(withOther);
    expect(withOther).not.toBe(rowsBefore);
    expect(await decisionsOf(w)).toEqual([]);
    // Nothing above left a claim or a decision; the real press still works once, afterwards.
    expect(await w.entry.chatDecision!(owner, { ...press, eventId: "evt-e" })).toEqual({ outcome: "decided" });
    expect(await decisionsOf(w)).toEqual(["APPROVE"]);
  });

  it("an unlink that commits after the checks and before the write wins (the link is fenced in the decision's own transaction): nothing is decided", async () => {
    const w = await world({ kind: "medium" });
    const card = (await readApprovalCard({ store: w.storage, orgId: ORG, now: () => w.fake.clock.now }, [...w.cards][0]!))!;
    // The person unlinks their account right here: after the press was read and every check passed, before the decision's transaction.
    const transact = w.fake.store.transact.bind(w.fake.store);
    let unlinked = false;
    w.fake.store.transact = async (items) => {
      if (!unlinked) { unlinked = true; await w.fake.store.delete({ key: orgChannelLinkKey(ORG, ACTOR(OWNER)) }); }
      return transact(items);
    };
    const gate = w.gateOf();
    const result = await decideFromChat(
      { chatThreads: w.threads, proofKey: PROOF_KEY, now: () => w.fake.clock.now, companyFor: async () => ({ store: w.fake.store, gate }) },
      { principal: principalOf("dev-a") },
      { conversation: CONVERSATION, actor: ACTOR(OWNER), eventId: "evt-race", requestId: card.requestId, expectedRevision: card.revision, artifactDigest: card.artifactDigest, decision: "APPROVE", reason: "x" },
    );
    expect(result).toEqual({ outcome: "refused", reason: "link_gone" });
    expect(await decisionsOf(w)).toEqual([]);
    // (The audit event is staged into the decision's own transaction, so it failed with it; the test double records what was staged.)
    expect((await w.stepWorkflow()).stage).toBe("PLAN_REVIEW");
  });

  it("a replayed press acts once: the same press twice, and the same person pressing again, write nothing new; a press by someone else afterwards is 'no longer waiting'", async () => {
    const w = await world({ kind: "medium" });
    const press = w.action(OWNER, CORE_APPROVE_ACTION, { triggerId: "trig-one" });
    await corePlanPressHandler(w.pressDeps).handle(press);
    const after = await w.stepWorkflow();
    const storedAfter = await w.snapshot();
    expect(after.decisions.map((entry) => entry.decision)).toEqual(["APPROVE"]);
    // The very same press again (Slack's retry): a duplicate, said nothing, written nothing.
    await corePlanPressHandler(w.pressDeps).handle(press);
    expect(await w.stepWorkflow()).toEqual(after);
    expect(w.slack.updates).toHaveLength(1);
    // The same person pressing the card again (a second click on an old message): the gate answers the repeat it is; nothing is written twice.
    await corePlanPressHandler(w.pressDeps).handle(w.action(OWNER, CORE_APPROVE_ACTION, { triggerId: "trig-two" }));
    expect(await w.stepWorkflow()).toEqual(after);
    expect(approvedAudit(w)).toHaveLength(1);
    expect(await w.snapshot()).toBe(storedAfter);
    expect(w.ephemerals).toEqual([]);
    // Someone else, afterwards: the plan no longer waits for an answer.
    await corePlanPressHandler(w.pressDeps).handle(w.action(PEER, CORE_APPROVE_ACTION, { triggerId: "trig-three" }));
    expect(await w.stepWorkflow()).toEqual(after);
    expect(approvedAudit(w)).toHaveLength(1);
    expect(w.ephemerals).toHaveLength(1);
  });

  it("the interactivity gate lets exactly Approve, Request changes and the box through (the member class); Reject, Skip and anything else are not in it", () => {
    expect(slackActionClass("rovara_decide_APPROVE")).toBe("member");
    expect(slackActionClass("rovara_decide_REQUEST_CHANGES")).toBe("member");
    expect(slackActionClass("rovara_changes")).toBe("member");
    expect(slackActionClass("rovara_decide_REJECT")).toBeUndefined();
    expect(slackActionClass("rovara_decide_SKIP")).toBeUndefined();
    expect(Object.keys(SLACK_ACTION_CLASSES).filter((id) => id.startsWith("rovara_decide") || id === "rovara_changes").sort()).toEqual(["rovara_changes", "rovara_decide_APPROVE", "rovara_decide_REQUEST_CHANGES"]);
    const handler = corePlanPressHandler({ ask: async () => ({ status: "decided" }), openView: async () => undefined, respondEphemeral: async () => undefined, update: async () => undefined });
    expect(handler.matches("rovara_decide_REJECT")).toBe(false);
    expect(handler.matches("rovara_decide_SKIP")).toBe(false);
    expect(handler.matches(CORE_APPROVE_ACTION)).toBe(true);
  });
});

describe("a signed Slack request through the company interactivity gate", () => {
  // Built at run time: a public repository refuses key-shaped strings in source.
  const SIGNING = ["hw5b", "signing", "material"].join("-");
  const NOW = Date.parse("2026-11-15T12:00:00.000Z");
  function signed(payload: unknown, skew = 0) {
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const timestamp = String(NOW / 1000 + skew);
    return { body, headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${createHmac("sha256", SIGNING).update(`v0:${timestamp}:${body}`).digest("hex")}` }, requestContext: { http: { method: "POST" } }, isBase64Encoded: false } as never;
  }
  async function gateWorld() {
    const w = await world({ kind: "medium" });
    const notices: string[] = [];
    const workspaces = { store: w.fake.store, getProject: async () => ({ companyId: ORG }), linkUrl: (code: string) => `https://example.test/link/${code}`, requireCompany: w.bindings.requireCompany, tokenForEvent: async (team: string) => ({ companyId: w.teams[team]!.company, token: w.teams[team]!.token }) };
    const handler = createSlackInteractivityHandler({
      workspaces: workspaces, companies: w.companies, now: () => NOW, secrets: async () => ({ signingSecret: SIGNING, botToken: tokenOf("legacy000000") }),
      handlers: [corePlanPressHandler(w.pressDeps)], coreSubmission: corePlanSubmission(w.pressDeps), respondEphemeral: async (_url, text) => { notices.push(text); },
    });
    const press = (userId: string, actionId: string, value?: string) => ({
      type: "block_actions", team: { id: TEAM_A }, user: { id: userId, team_id: TEAM_A }, channel: { id: CHANNEL }, trigger_id: `1000.${randomUUID().slice(0, 6)}`,
      container: { channel_id: CHANNEL, message_ts: CARD_TS, thread_ts: TS }, message: { ts: CARD_TS, thread_ts: TS, text: w.post!.text },
      actions: [{ action_id: actionId, value: value ?? String(w.button(actionId)?.["value"]), action_ts: "1700000002.000300" }], response_url: RESPONSE_URL,
    });
    return { w, handler, notices, press };
  }

  it("a signed press by the task's person approves; a bad signature, an old timestamp and an unlinked account decide nothing", async () => {
    const { w, handler, notices, press } = await gateWorld();
    const forgedBody = signed(press(OWNER, CORE_APPROVE_ACTION));
    const bad = await handler({ ...(forgedBody as object), headers: { ...(forgedBody as { headers: object }).headers, "x-slack-signature": "v0=" + "0".repeat(64) } });
    expect(bad.statusCode).toBe(401);
    expect((await handler(signed(press(OWNER, CORE_APPROVE_ACTION), -3_600))).statusCode).toBe(401);
    // Linked to nobody: the member gate answers the link notice and the press never reaches the handler.
    const asked = w.calls.length;
    expect((await handler(signed(press(STRANGER, CORE_APPROVE_ACTION)))).statusCode).toBe(200);
    expect(w.calls.length).toBe(asked);
    expect(notices.at(-1)).toContain("link your account");
    expect(await decisionsOf(w)).toEqual([]);
    expect((await handler(signed(press(OWNER, CORE_APPROVE_ACTION)))).statusCode).toBe(200);
    expect(await decisionsOf(w)).toEqual(["APPROVE"]);
    expect(w.slack.updates).toHaveLength(1);
  });

  it("a press of the card's \"Open the task\" link button is let through with no notice and decides nothing (a linked member); an unlinked account still gets the link notice", async () => {
    const { w, handler, notices, press } = await gateWorld();
    const link = (userId: string) => { const payload = press(userId, CORE_APPROVE_ACTION); return { ...payload, actions: [{ action_id: "rovara_open_task", action_ts: "1700000002.000300" }] }; };
    const rowsBefore = await w.snapshot();
    expect((await handler(signed(link(OWNER)))).statusCode).toBe(200);
    expect(notices).toEqual([]);
    expect(w.calls).toEqual([]);
    expect(await w.snapshot()).toBe(rowsBefore);
    expect(await decisionsOf(w)).toEqual([]);
    expect((await handler(signed(link(STRANGER)))).statusCode).toBe(200);
    expect(notices.at(-1)).toContain("link your account");
    expect(slackActionClass("rovara_open_task")).toBe("member");
  });

  it("a forged Reject or Skip press, an unknown decide id, and a high risk card's missing buttons never reach a decision", async () => {
    const { w, handler, notices, press } = await gateWorld();
    const value = JSON.stringify({ r: [...w.cards][0], v: 1, d: "a".repeat(64), o: "REJECT" });
    for (const id of ["rovara_decide_REJECT", "rovara_decide_SKIP", "rovara_decide_x"]) {
      notices.length = 0;
      expect((await handler(signed(press(OWNER, id, value)))).statusCode).toBe(200);
      expect(notices).toEqual(["That needs a web sign-in. Open it in Rovara."]);
    }
    expect(w.calls).toEqual([]);
    expect(await decisionsOf(w)).toEqual([]);
  });

  it("the Request changes box, signed and sent by the person who opened it, requests the changes; sent by another person it decides nothing", async () => {
    const { w, handler, press } = await gateWorld();
    expect((await handler(signed(press(OWNER, CORE_CHANGES_ACTION)))).statusCode).toBe(200);
    expect(w.slack.views).toHaveLength(1);
    const metadata = (w.slack.views[0]!.view as { private_metadata: string }).private_metadata;
    const submission = (userId: string) => ({ type: "view_submission", team: { id: TEAM_A }, user: { id: userId, team_id: TEAM_A }, view: { id: "V0BOX00003", callback_id: CHANGES_CALLBACK, private_metadata: metadata, state: { values: { [CHANGES_INPUT]: { text: { value: "Add a test first" } } } } } });
    const other = await handler(signed(submission(PEER)));
    expect(JSON.parse(other.body)).toEqual({ response_action: "clear" });
    expect(await decisionsOf(w)).toEqual([]);
    const own = await handler(signed(submission(OWNER)));
    expect(JSON.parse(own.body)).toEqual({ response_action: "clear" });
    expect(await decisionsOf(w)).toEqual(["REQUEST_CHANGES"]);
  });

  // S1 review (Opus): production runs SlackViaChannel=enabled, where the interactivity handler first offers each press to `routePress` and each form to `routeSubmission` (the channel API). The registry's buttons, an older
  // card's Stop and the registry's form must NOT be taken by that path (the channel-presses Lambda has no registry handler): they fall through to the dispatcher / `coreSubmission` that hold the registry. The route gates below
  // are the real ones (`channelActionOfPress`, `channelActionOfSubmission`), as `createAwsSlackInteractivityHandler` wires them under `viaChannel`.
  it("with the via-channel routes wired (production), a registry press, an older Stop and the registry form reach the registry, and a routed workflow press still goes to the channel API", async () => {
    const w = await world({ kind: "medium" });
    const workspaces = { store: w.fake.store, getProject: async () => ({ companyId: ORG }), linkUrl: (code: string) => `https://example.test/link/${code}`, requireCompany: w.bindings.requireCompany, tokenForEvent: async (team: string) => ({ companyId: w.teams[team]!.company, token: w.teams[team]!.token }) };
    const routed: string[] = [];
    const registry: string[] = [];
    const submitted: string[] = [];
    const handler = createSlackInteractivityHandler({
      workspaces, companies: w.companies, now: () => NOW, secrets: async () => ({ signingSecret: SIGNING, botToken: tokenOf("legacy000000") }),
      handlers: [], respondEphemeral: async () => undefined,
      routePress: async (action) => { if (channelActionOfPress(action) === undefined) return false; routed.push(action.actionId); return true; },
      routeSubmission: async (payload) => { if (channelActionOfSubmission(payload, NOW) === undefined) return undefined; routed.push("submission"); return { response_action: "clear" }; },
      taskActions: {
        claims: async (action) => taskActionOfButtonId(action.actionId) !== undefined || action.actionId === WORKFLOW_STOP_ACTION,
        handle: async (action) => { registry.push(action.actionId); },
      },
      coreSubmission: async (payload) => { const view = payload.view as { callback_id?: unknown }; if (view.callback_id !== TASK_ACTION_FORM) return undefined; submitted.push(String(view.callback_id)); return { response_action: "clear" }; },
    });
    const press = (actionId: string, value: string) => ({
      type: "block_actions", team: { id: TEAM_A }, user: { id: OWNER, team_id: TEAM_A }, channel: { id: CHANNEL }, trigger_id: "1000.abcdef",
      container: { channel_id: CHANNEL, message_ts: CARD_TS, thread_ts: TS }, message: { ts: CARD_TS, thread_ts: TS, text: "card" },
      actions: [{ action_id: actionId, value, action_ts: "1700000002.000300" }], response_url: RESPONSE_URL,
    });
    const taskId = w.task.taskId;
    expect((await handler(signed(press(taskActionButtonId("task.stop"), JSON.stringify({ t: taskId, r: 0 }))))).statusCode).toBe(200);
    expect((await handler(signed(press(WORKFLOW_STOP_ACTION, JSON.stringify({ taskId }))))).statusCode).toBe(200);
    expect((await handler(signed(press(taskActionButtonId("task.close"), JSON.stringify({ t: taskId, r: 1, n: 1 }))))).statusCode).toBe(200);
    expect(registry).toEqual([taskActionButtonId("task.stop"), WORKFLOW_STOP_ACTION, taskActionButtonId("task.close")]);
    expect(routed).toEqual([]);
    // The registry form's submission is not a channel API form: it reaches `coreSubmission`.
    const form = { type: "view_submission", team: { id: TEAM_A }, user: { id: OWNER, team_id: TEAM_A }, view: { id: "V0FORM00001", callback_id: TASK_ACTION_FORM, private_metadata: "{}", state: { values: {} } } };
    expect(JSON.parse((await handler(signed(form))).body)).toEqual({ response_action: "clear" });
    expect(submitted).toEqual([TASK_ACTION_FORM]);
    expect(routed).toEqual([]);
    // Control: a press the channel API does take (a workflow send-back) is routed there, not to the registry.
    expect((await handler(signed(press("agentx_workflow_send_back", JSON.stringify({ taskId }))))).statusCode).toBe(200);
    expect(routed).toEqual(["agentx_workflow_send_back"]);
    expect(registry).toHaveLength(3);
  });
});

describe("the approvers' chat method on its own", () => {
  const requestOf = (w: World, over: Record<string, unknown> = {}) => ({
    companyId: ORG, requestId: "req-1.x", kind: "plan", subject: { type: "task", id: w.task.taskId }, revision: 1, artifactDigest: "a".repeat(64), risk: "medium" as const, outcome: "approve" as const, projectName: "payments", settlesClaims: true as const, ...over,
  });
  /** The broker's own proof for this request and account (what `decideFromChat` makes), or a given token. */
  const proofOf = (request: { companyId: string; requestId: string; revision: number; artifactDigest: string; outcome?: string }, account: { provider: string; tenant: string; accountId: string } | undefined, token?: string) => ({
    proofId: randomUUID(), method: "chat-slack", requestId: request.requestId, revision: request.revision, artifactDigest: request.artifactDigest,
    token: token ?? (account === undefined ? "x" : chatPressToken(PROOF_KEY, { companyId: request.companyId, requestId: request.requestId.split(".")[0]!, revision: request.revision, artifactDigest: request.artifactDigest, outcome: request.outcome ?? "approve", tenant: account.tenant, userId: account.accountId })),
    ...(account === undefined ? {} : { claimedAccount: account }),
  });
  const owner = { provider: SLACK_CHANNEL, tenant: TEAM_A, accountId: OWNER };

  it("accepts the task's own person at low and medium risk, an approval or a request for changes; refuses everything else with its own reason", async () => {
    const w = await world({ kind: "medium", post: false });
    const approvers = w.approvers();
    for (const risk of ["low", "medium"] as const) for (const outcome of ["approve", "request_changes"] as const) {
      const request = requestOf(w, { risk, outcome });
      expect(await approvers.verify(request as never, proofOf(request as never, owner) as never), `${risk} ${outcome}`).toMatchObject({ approved: true, method: "chat-slack", approver: { personId: "dev-a", companyId: ORG } });
    }
    const refusal = async (over: Record<string, unknown>, account: typeof owner | null = owner) => {
      const request = requestOf(w, over);
      const verdict = await approvers.verify(request, proofOf(request, account ?? undefined));
      return verdict.approved ? "approved" : verdict.reason;
    };
    // Only a task document's decision (S1: plan, requirements and design), only from the decision gate, only with the broker's own proof.
    expect(await refusal({ kind: "merge" })).toBe("no_rule_for_this_request");
    expect(await refusal({ kind: "scope_question" })).toBe("no_rule_for_this_request");
    expect(await refusal({ kind: "requirements" })).toBe("approved");
    expect(await refusal({ kind: "design" })).toBe("approved");
    expect(await refusal({ settlesClaims: undefined })).toBe("needs_settling_caller");
    const real = requestOf(w);
    expect(await approvers.verify(real as never, proofOf(real as never, owner, "t".repeat(64)) as never)).toEqual({ approved: false, reason: "not_a_valid_proof" });
    expect(await approvers.verify(real as never, proofOf(real as never, owner, "") as never)).toEqual({ approved: false, reason: "not_a_valid_proof" });
    // A proof made for another answer, another card or another account is not this press's.
    const forOther = proofOf({ ...real, outcome: "request_changes" }, owner);
    expect(await approvers.verify(real as never, { ...proofOf(real as never, owner), token: forOther.token })).toEqual({ approved: false, reason: "not_a_valid_proof" });
    expect(await approvers.verify(real as never, { ...proofOf(real as never, { ...owner, accountId: PEER }), claimedAccount: owner })).toEqual({ approved: false, reason: "not_a_valid_proof" });
    expect(await refusal({ risk: "high" })).toBe("chat_not_enough_for_this_risk");
    expect(await refusal({ risk: undefined })).toBe("chat_not_enough_for_this_risk");
    // S1 (owner DEC 254zzz477): a rejection is taken in the chat at low and medium risk, never above; any other answer is no answer.
    expect(await refusal({ outcome: "reject" })).toBe("approved");
    expect(await refusal({ outcome: "reject", risk: "high" })).toBe("chat_not_enough_for_this_risk");
    expect(await refusal({ outcome: "skip" })).toBe("chat_cannot_reject");
    expect(await refusal({ subject: { type: "setup_proposal", id: "payments" } })).toBe("no_rule_for_this_request");
    expect(await refusal({ subject: { type: "task", id: "not-a-task" } })).toBe("no_rule_for_this_request");
    expect(await refusal({ companyId: OTHER })).toBe("wrong_company");
    expect(await refusal({}, null)).toBe("account_mismatch");
    expect(await refusal({}, { ...owner, provider: "teams" })).toBe("account_mismatch");
    expect(await refusal({}, { ...owner, tenant: TEAM_B })).toBe("wrong_company");
    expect(await refusal({}, { ...owner, accountId: STRANGER })).toBe("not_a_member");
    expect(await refusal({}, { ...owner, accountId: LEFT })).toBe("not_a_member");
    expect(await refusal({}, { ...owner, accountId: PEER })).toBe("not_the_task_owner");
    expect(await refusal({ projectName: "other-project" })).toBe("not_the_task_owner");
    expect(await refusal({ expiresAt: new Date(w.fake.clock.now - 1000).toISOString() })).toBe("expired");
    // The step-up method is unchanged: it still needs a settling caller and a signed proof.
    const request = requestOf(w);
    expect(await approvers.verify(request as never, { ...proofOf(request, owner), method: "rovara-step-up" })).toMatchObject({ approved: false });
    expect(await approvers.verify(request as never, { ...proofOf(request, owner), method: "chat-teams" })).toEqual({ approved: false, reason: "unknown_method" });
    // A request bound to another revision, digest or id than the proof's is refused.
    expect(await approvers.verify(request as never, { ...proofOf(request as never, owner), revision: 2 })).toEqual({ approved: false, reason: "other_revision" });
    expect(await approvers.verify(request as never, { ...proofOf(request as never, owner), artifactDigest: "c".repeat(64) })).toEqual({ approved: false, reason: "other_content" });
    expect(await approvers.verify(request as never, { ...proofOf(request as never, owner), requestId: "req-2.x" })).toEqual({ approved: false, reason: "other_request" });
  });
});

const cardIds = async (w: World): Promise<string[]> => [...w.cards];

describe("the wiring (guards on the source, beside the behaviour above)", () => {
  const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

  it("the hosted root builds the chat approval from its chat seam and passes it to the approvers; the entry's chat decision is wired", () => {
    const root = read("packages/broker/src/aws/core-engine-root.ts");
    expect(root).toContain("const chatApproval = hostedChatApproval(inputs.chatThreads, { membershipOf, projectGrantRole }, ");
    expect(root).toContain("...(chatApproval === undefined ? {} : { chat: chatApproval })");
    expect(root).toMatch(/decideFromChat\(\{\s+chatThreads, proofKey: approvalProofKeyOf\(inputs\.callbackSigningKey\), now/u);
    expect(root).toContain("chatDecision: (caller: CoreEntryCaller, press");
    const broker = read("packages/broker/src/aws/broker.ts");
    expect(broker).toContain("isSlackCorePressEvent(event)");
    expect(broker).toContain("createSlackPersonResolver({ workspaces: slackCompany.workspaces");
    const interactivity = read("packages/broker/src/aws/slack-interactivity.ts");
    expect(interactivity).toContain("corePlanPressHandler(corePlan)");
    expect(interactivity).toContain("company.workspaces === undefined || brokerFunctionName === undefined ? undefined");
  });
});


// S1: the same plan, decided through the TASK ACTION REGISTRY (`core-host/task-action-routes.ts`): the real hosted approvers with their `chat-slack` method, the company's decision gate, the Slack seam and the person resolver over real link
// rows. Plan decisions use the one `owner` rule; requirements and design are taken like a plan; a rejection needs a reason; a high risk plan is decided on the web in this cut; and a refused press writes nothing.
describe("the plan decided through the task action registry", () => {
  const factsOf = (kind: Kind) => async () => [{
    kind: "approve_plan" as const, path: "quick" as const, files: ["src/health.ts"], claims: 0, untestedClaims: 0, subjectId: "plan-1", taskId: "", project: "payments", title: "Add a health endpoint", createdAt: "2026-11-15T10:00:00.000Z",
    openPath: "/app/tasks/x", contentVersion: "v1", ...(kind === "high" ? {} : {}),
  }];
  async function registryWorld(kind: Kind = "medium", peopleOver?: Record<string, unknown>, taskOwner?: NonNullable<Parameters<typeof createHostedApprovers>[0]["taskOwner"]>) {
    const w = await world({ kind, post: false, ...(taskOwner === undefined ? {} : { taskOwner }) });
    const stored = (await w.fake.store.get(taskKey(w.task.taskId)))!;
    const workflow = stored["workflow"] as unknown as WorkflowSnapshot;
    const digest = workflow.artifacts.at(-1)!.sha256;
    const binding = { revision: workflow.revision, digest };
    const wiring = {
      origin: () => ORIGIN, taskActions: { roundCap: async () => undefined },
      ...(peopleOver === undefined ? {} : { taskRules: { people: peopleOver } }),
      decisions: { sources: {
        list: async () => (await factsOf(kind)()).map((item) => ({ ...item, taskId: w.task.taskId, binding: { revision: workflow.revision, artifactDigest: digest } })),
        locks: async () => ({}),
      } },
    };
    const routes = createTaskActionRoutes({
      companyOf: async (caller) => w.memberships.get(caller.principal.personId), now: () => w.fake.clock.now,
      mount: async () => ({ runtime: w.runtime, wiring: wiring as never }),
      // The gate is built from the runtime the registry hands it (its audit stamped with the surface), as the deployed root builds it.
      chat: { threads: w.threads, proofKey: PROOF_KEY, gateFor: (runtime, companyId) => hostedDecisionService({ deps: runtime.flow.deps, registry: w.registry, companyId: companyId, now: () => new Date(w.fake.clock.now) }).gate },
    });
    const caller = (personId: string) => ({ principal: principalOf(personId) });
    const as = (userId: string, personId: string) => ({ conversation: CONVERSATION, actor: ACTOR(userId), personId });
    let n = 0;
    const press = (who: { personId: string; conversation: ConversationRef; actor: ActorRef }, actionId: string, extra: Record<string, unknown> = {}) =>
      routes.taskAction(caller(who.personId), { mode: "perform", actionId, taskId: w.task.taskId, binding, requestKey: `k${String(++n)}`, conversation: who.conversation, actor: who.actor, ...extra } as never);
    return { w, routes, press, as, binding, caller, workflowOf: w.stepWorkflow };
  }

  it("approves a medium risk plan as the task's owner, recorded as the chat's method, and the same press again is the same decision", async () => {
    const { w, press, as, workflowOf } = await registryWorld("medium");
    const answer = await press(as(OWNER, "dev-a"), "plan.approve");
    expect(answer).toMatchObject({ mode: "perform", result: { status: "started" } });
    expect((await workflowOf()).decisions.map((entry) => entry.decision)).toEqual(["APPROVE"]);
    expect(w.fake.audit.some((event) => String(event.action).startsWith("decision.") && JSON.stringify(event.details ?? {}).includes("chat-slack"))).toBe(true);
    // The decision's audit names the surface too, as every other move of the registry does (what an audit read filtering on `via` finds).
    expect(w.fake.audit.filter((event) => String(event.action).startsWith("decision.")).every((event) => event.details?.["via"] === "slack")).toBe(true);
    const again = await press(as(OWNER, "dev-a"), "plan.approve");
    expect(["replayed", "refused"]).toContain((again as { result: { status: string } }).result.status);
    expect((await workflowOf()).decisions).toHaveLength(1);
  });

  it("the task's CURRENT owner decides from the chat, not only its starter: a person the owner rule names an owner now (a successor, a co-owner) approves, recorded as them (TASK-TAKEOVER PR A)", async () => {
    // The approvers point's own re-check names the same owner (production wires it to the company's owner rule: `hostedTaskOwner`).
    const { w, press, as, workflowOf } = await registryWorld("medium", undefined, async ({ principal }) => principal.personId === "dev-b");
    const deps = w.runtime.flow.deps;
    const key = (taskId: string) => taskOwnerKey("dev-b", taskId);
    // The company's owner rule now names dev-b an owner of the task (the starter's own entry is out of it), with the People revision fence of any owner move.
    const real = deps.access;
    deps.access = { ...real, canAct: async (principal, task) => principal.personId === "dev-b" || (principal.personId !== "dev-a" && await real.canAct(principal, task)),
      ownerActing: async (principal, task) => (principal.personId === "dev-b" ? { actorId: key(task.taskId), authority: { actorId: key(task.taskId), ownerIds: [key(task.taskId)] }, items: [] } : undefined) };
    expect(await press(as(OWNER, "dev-a"), "plan.approve")).toMatchObject({ result: { status: "refused", writes: "none" } });
    const approved = await press(as(PEER, "dev-b"), "plan.approve");
    expect(approved, JSON.stringify(approved)).toMatchObject({ result: { status: "started" } });
    const decisions = (await workflowOf()).decisions;
    expect(decisions.map((entry) => [entry.decision, entry.actorId])).toEqual([["APPROVE", key(w.task.taskId)]]);
  });

  it("an owner who was removed from the project is REFUSED in the chat: by the owner rule itself, and by the approvers' own re-check when the rule is stale; nothing is decided (TASK-TAKEOVER PR A)", async () => {
    const removed = new Set<string>();
    const { w, press, as, workflowOf } = await registryWorld("medium", undefined, async ({ principal }) => !removed.has(principal.personId));
    const deps = w.runtime.flow.deps;
    const real = deps.access;
    const key = (taskId: string) => taskOwnerKey("dev-b", taskId);
    const acting = (taskId: string) => ({ actorId: key(taskId), authority: { actorId: key(taskId), ownerIds: [key(taskId)] }, items: [] });
    let ruleKnows = true;
    deps.access = { ...real, canAct: async (principal, task) => (principal.personId === "dev-b" ? ruleKnows : principal.personId !== "dev-a" && await real.canAct(principal, task)),
      ownerActing: async (principal, task) => (principal.personId === "dev-b" && ruleKnows ? acting(task.taskId) : undefined) };
    const before = await w.snapshot();
    // Removed from the project, and the rule has caught up: not found, nothing written.
    removed.add("dev-b"); ruleKnows = false;
    expect(await press(as(PEER, "dev-b"), "plan.approve")).toMatchObject({ result: { status: "refused", writes: "none" } });
    // Removed, and the owner rule still names them (stale): the approvers' own re-check refuses.
    ruleKnows = true;
    expect(await press(as(PEER, "dev-b"), "plan.approve")).toMatchObject({ result: { status: "refused", writes: "none" } });
    expect(await w.snapshot()).toBe(before);
    expect((await workflowOf()).decisions).toEqual([]);
  });

  it("asks a reason for a request for changes and for a rejection, and takes both with it", async () => {
    const changes = await registryWorld("low");
    expect(await changes.press(changes.as(OWNER, "dev-a"), "plan.request-changes")).toMatchObject({ result: { status: "refused", reason: "needs_input", writes: "none" } });
    expect(await changes.press(changes.as(OWNER, "dev-a"), "plan.request-changes", { values: { reason: "Use the shared client." } })).toMatchObject({ result: { status: "done" } });
    expect((await changes.workflowOf()).decisions.map((entry) => entry.decision)).toEqual(["REQUEST_CHANGES"]);
    const rejected = await registryWorld("medium");
    expect(await rejected.press(rejected.as(OWNER, "dev-a"), "plan.reject", { values: { reason: "Not what we want." } })).toMatchObject({ result: { status: "done" } });
    expect((await rejected.workflowOf()).decisions.map((entry) => entry.decision)).toEqual(["REJECT"]);
  });

  it("refuses a colleague who owns nothing here, another company's person and an unlinked account; nothing is written", async () => {
    const { w, press, as, workflowOf } = await registryWorld("medium");
    const before = await w.snapshot();
    expect(await press(as(PEER, "dev-b"), "plan.approve")).toMatchObject({ result: { status: "refused", writes: "none" } });
    expect(await press({ ...as(OTHERCO, "dev-x"), conversation: { ...CONVERSATION, tenant: TEAM_B }, actor: ACTOR(OTHERCO, TEAM_B) }, "plan.approve")).toMatchObject({ result: { status: "refused", reason: "not_found" } });
    expect(await press(as(STRANGER, "dev-a"), "plan.approve")).toMatchObject({ result: { status: "refused", reason: "not_linked", code: "SLACK_ACCOUNT_NOT_LINKED" } });
    expect(await w.snapshot()).toBe(before);
    expect((await workflowOf()).decisions).toEqual([]);
  });

  it("does not offer a high risk plan in this cut, and refuses a card named for an older document", async () => {
    const high = await registryWorld("high");
    const before = await high.w.snapshot();
    expect(await high.press(high.as(OWNER, "dev-a"), "plan.approve")).toMatchObject({ result: { status: "refused", reason: "not_offered", writes: "none" } });
    expect(await high.w.snapshot()).toBe(before);
    const stale = await registryWorld("medium");
    expect(await stale.press(stale.as(OWNER, "dev-a"), "plan.approve", { binding: { revision: stale.binding.revision, digest: "f".repeat(64) } })).toMatchObject({ result: { status: "refused", reason: "stale", writes: "none" } });
  });

  it("refuses once the account is unlinked: the link's own fence is in the decision's transaction", async () => {
    const { w, press, as, workflowOf } = await registryWorld("medium");
    // The press resolved the account, then the link was removed before the write: the same press now reads not linked, and nothing was decided.
    const key = orgChannelLinkKey(ORG, ACTOR(OWNER));
    await w.fake.store.delete({ key });
    expect(await press(as(OWNER, "dev-a"), "plan.approve")).toMatchObject({ result: { status: "refused", reason: "not_linked" } });
    expect((await workflowOf()).decisions).toEqual([]);
  });

  it("refuses taking over a task when the account is unlinked while the request runs, and writes nothing", async () => {
    const taken = vi.fn(async () => undefined);
    let calls = 0;
    const hooks: { unlink?: () => Promise<void> } = {};
    const people = {
      view: async () => { calls += 1; if (calls === 5) await hooks.unlink!(); return { revision: 3, orphaned: true, people: [], canManage: false, canTakeOwnership: true }; },
      takeOwnership: taken,
    };
    const { w, routes, caller } = await registryWorld("medium", people);
    hooks.unlink = async () => { await w.fake.store.delete({ key: orgChannelLinkKey(ORG, ACTOR(OWNER)) }); };
    const common = { actionId: "people.take-ownership", taskId: w.task.taskId, binding: { revision: 3 }, conversation: CONVERSATION, actor: ACTOR(OWNER) };
    const described = await routes.taskAction(caller("dev-a"), { mode: "describe", ...common } as never);
    const digest = (described as { description: { confirmDigest?: string } }).description.confirmDigest;
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    const answer = await routes.taskAction(caller("dev-a"), { mode: "perform", ...common, confirmDigest: digest, requestKey: "k-take" } as never);
    expect(answer).toMatchObject({ result: { status: "refused", reason: "not_linked", code: "SLACK_ACCOUNT_NOT_LINKED", writes: "none" } });
    expect(taken).not.toHaveBeenCalled();
  });
});

// S1 (arch ruling: ONE `owner` rule for a plan decision, the web's): the chat press used a narrower check (the task's own person alone), so a People co-owner could decide on the web and not in Slack. With the live owner rule given, the chat
// press uses it: a co-owner counts, a reader does not, and a person the rule refuses is refused whoever the task runs for.
describe("a chat press is judged by the web's owner rule (S1)", () => {
  it("accepts a People co-owner of the task, refuses a reader, and asks the live rule every time", async () => {
    const w = await world({ kind: "medium", post: false });
    const asked: string[] = [];
    const approvers = (owner: (personId: string) => boolean) => createHostedApprovers({
      store: w.fake.store, identity: w.registry.require("identity"), key: PROOF_KEY, now: () => new Date(w.fake.clock.now), chat: hostedChatApproval(w.threads, w.people, PROOF_KEY),
      taskOwner: async ({ principal }) => { asked.push(principal.personId); return owner(principal.personId); },
    });
    const request = { companyId: ORG, requestId: "req-1.x", kind: "plan", subject: { type: "task", id: w.task.taskId }, revision: 1, artifactDigest: "a".repeat(64), risk: "medium" as const, outcome: "approve" as const, projectName: "payments", settlesClaims: true as const };
    const proofFor = (userId: string) => ({
      proofId: randomUUID(), method: "chat-slack", requestId: request.requestId, revision: request.revision, artifactDigest: request.artifactDigest,
      token: chatPressToken(PROOF_KEY, { companyId: ORG, requestId: "req-1", revision: 1, artifactDigest: request.artifactDigest, outcome: "approve", tenant: TEAM_A, userId }),
      claimedAccount: { provider: SLACK_CHANNEL, tenant: TEAM_A, accountId: userId },
    });
    // dev-b is a co-owner of this task though the task runs for dev-a: the web lets them decide, and so does Slack now.
    expect(await approvers((personId) => personId === "dev-b").verify(request as never, proofFor(PEER) as never)).toMatchObject({ approved: true, approver: { personId: "dev-b" } });
    // The task's own person is refused when the live rule says no (an ownership change the narrower check never saw).
    expect(await approvers((personId) => personId === "dev-b").verify(request as never, proofFor(OWNER) as never)).toEqual({ approved: false, reason: "not_the_task_owner" });
    expect(await approvers(() => false).verify(request as never, proofFor(PEER) as never)).toEqual({ approved: false, reason: "not_the_task_owner" });
    expect(asked).toEqual(["dev-b", "dev-a", "dev-b"]);
  });
});

// S1 follow-up (U1): the writes that cannot join the core store's transaction (the merge on GitHub, the People write) read the chat link again just before they are made. An unlink that lands in the middle of the request refuses them.
describe("a move made outside the core store's transaction re-reads the chat link first", () => {
  it("guards the merge and the take-over wrappers: the host is not asked once the link is gone, and is asked while it holds", async () => {
    let linked = true;
    const guard = relinkedBefore(async () => linked);
    const press = vi.fn(async () => undefined);
    const take = vi.fn(async () => undefined);
    const merge = guard.merge({ standing: async () => ({ may: true }), readiness: async () => ({ ready: true }), press })!;
    const people = guard.people({ view: async () => undefined, canTakeOwnership: async () => undefined, takeOwnership: take })!;
    await merge.press({} as never, {} as never, {} as never);
    await people.takeOwnership({} as never, {} as never, {} as never);
    expect([press.mock.calls.length, take.mock.calls.length]).toEqual([1, 1]);
    linked = false;
    await expect(merge.press({} as never, {} as never, {} as never)).rejects.toMatchObject({ code: "SLACK_ACCOUNT_NOT_LINKED", detail: { writes: "none" } });
    await expect(people.takeOwnership({} as never, {} as never, {} as never)).rejects.toMatchObject({ code: "SLACK_ACCOUNT_NOT_LINKED" });
    expect([press.mock.calls.length, take.mock.calls.length]).toEqual([1, 1]);
    expect(guard.merge(undefined)).toBeUndefined();
    expect(guard.people(undefined)).toBeUndefined();
  });
});
