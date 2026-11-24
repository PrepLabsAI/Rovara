// L4-HW5: the hosted Slack thread gets the laptop's plan card, setup link and attention notices, and NOTHING that approves. The real hosted approvers (a fresh step-up proved on the web is the one method), the real gate
// (`hostedDecisionService`), the real hosted Slack adapter over a fake web API and the real notice sweep, over the memory store. Mutants are listed in the PR body with the test that kills each.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SLACK_CHANNEL, WorkflowSnapshotSchema, createWorkflowSnapshot, orgProjectCatalogKey, projectRevisionKey, submitWorkflowArtifact,
  type ActorRef, type AdapterRegistry, type ConversationRef, type JsonValue, type OrgId, type OrgRole, type Principal, type ProjectDefinition, type StoredDocument, type WorkflowSnapshot,
} from "@agentx/contracts";
import { createCoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { coreAdapter } from "../../packages/broker/src/core-host/registry.js";
import { HOSTED_IDENTITY_PROVIDER, createHostedIdentity } from "../../packages/broker/src/core-host/hosted-modules.js";
import { createHostedApprovers, approvalProofKeyOf } from "../../packages/broker/src/core-host/hosted-approvers.js";
import { type DeployedPeople } from "../../packages/broker/src/core-host/deployed-decisions.js";
import { hostedThreadHandler, hostedThreadNotification } from "../../packages/broker/src/core-host/thread-notification.js";
import { hostedTaskAccess } from "../../packages/broker/src/aws/core-engine-root.js";
import { hostedSlackThreads } from "../../packages/broker/src/aws/slack-thread-channel.js";
import { recordTaskThread } from "../../packages/broker/src/core/channel/threads.js";
import { projectPageUrl, sessionPageUrl } from "../../packages/broker/src/core/decisions/open-path.js";
import { PENDING_PK, deliverAttention } from "../../packages/broker/src/core/notify/index.js";
import { createTaskSessionItems, developerIdOf, refreshSessionSummary, taskSessionId } from "../../packages/broker/src/core/sessions/index.js";
import { createTaskFactsSource } from "../../packages/broker/src/local/app/facts.js";
import { driftTaskKey, recheckRowKey, setupBrokenWarningMessage, type RecheckState } from "../../packages/broker/src/core/setup-agent/recheck.js";
import { taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { ticketMomentsOnChange } from "../../packages/broker/src/core/ticket-updates/moments.js";
import { createDocumentMilestones } from "../../packages/broker/src/core/milestones/milestones.js";
import { FAKE_COMPANY, createFakeWorld } from "../support/core-host-fakes.js";

const ORG = FAKE_COMPANY as OrgId;
const OTHER = "org_corehost00000000000b" as OrgId;
const TEAM_A = "T0AAAAAAAAA";
const TEAM_B = "T0BBBBBBBBB";
const CHANNEL = "C0123456789";
const TS = "1700000000.000100";
const USER = "U0123456789";
const ORIGIN = "https://app.example";
const tokenOf = (label: string): string => ["xoxb", "1111111111", label].join("-");
const TOKEN_A = tokenOf("aaaaaaaaaa");
const TOKEN_B = tokenOf("bbbbbbbbbb");
const KEY = "a".repeat(48);
const STEP = "setup: npm ci - setup step 0 (npm ci) failed: exit 1";
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const CONVERSATION: ConversationRef = { channel: SLACK_CHANNEL, tenant: TEAM_A, space: CHANNEL, thread: TS };
const ACTOR: ActorRef = { channel: SLACK_CHANNEL, tenant: TEAM_A, userId: USER };
const principalOf = (personId: string, companyId: string = ORG): Principal => ({ companyId, personId, displayName: personId, roles: ["member"], provider: HOSTED_IDENTITY_PROVIDER });

/** Slack's web API as a fake: who the bot is (the workspace the token belongs to) and every post, with its token, text and blocks. */
function fakeSlack() {
  let deletionConfirmed = true;
  let postingFails = false;
  const posts: Array<{ token: string; channel: string; thread_ts?: string; text: string; blocks?: Array<Record<string, unknown>> }> = [];
  const tokenTeams: Record<string, string> = { [TOKEN_A]: TEAM_A, [TOKEN_B]: TEAM_B };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).replace("https://slack.com/api/", "");
    const token = String((init?.headers as Record<string, string>)["authorization"]).replace("Bearer ", "");
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    if (method === "auth.test") return new Response(JSON.stringify({ ok: true, team_id: tokenTeams[token] ?? "T0UNKNOWN00", user_id: "U0BOT000000" }), { status: 200 });
    if (method === "canvases.create") return Response.json({ ok: true, canvas_id: "F0123456789" });
    if (method === "canvases.access.set") return Response.json({ ok: true });
    if (method === "canvases.delete") return Response.json(deletionConfirmed ? { ok: true } : { ok: false, error: "canvas_not_found" });
    if (method.startsWith("files.info")) return Response.json({ ok: true, file: { permalink: "https://example.slack.com/docs/F0123456789" } });
    if (method === "chat.postMessage") {
      if (postingFails) throw new Error("post unavailable");
      posts.push({ token, channel: String(body["channel"]), ...(typeof body["thread_ts"] === "string" ? { thread_ts: body["thread_ts"] } : {}), text: String(body["text"]), ...(Array.isArray(body["blocks"]) ? { blocks: body["blocks"] as Array<Record<string, unknown>> } : {}) });
      return new Response(JSON.stringify({ ok: true, ts: "1700000001.000200" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, error: "unsupported" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { posts, fetchImpl, failPosts: (fails: boolean) => { postingFails = fails; }, confirmDeletion: (confirmed: boolean) => { deletionConfirmed = confirmed; } };
}
const workspaces = (map: Record<string, { company: OrgId; token?: string }>) => ({
  requireCompany: async (team: string): Promise<string> => { const found = map[team]; if (found === undefined) throw new Error("no such workspace"); return found.company; },
  tokenForCompany: async (company: string, team: string): Promise<string | undefined> => (map[team]?.company === company ? map[team]?.token : undefined),
});
const buttonsOf = (post: { blocks?: Array<Record<string, unknown>> } | undefined): Array<Record<string, unknown>> =>
  (post?.blocks ?? []).flatMap((block) => (block["type"] === "actions" ? (block["elements"] as Array<Record<string, unknown>>) : []));

/** The company's world: the REAL hosted approvers over live memberships, a core runtime, a task waiting on a plan, and the hosted Slack seam over a fake web API. */
async function world(options: { teams?: Record<string, { company: OrgId; token?: string }>; origin?: string | undefined; member?: boolean; session?: boolean; planText?: string; withoutArtifactReader?: boolean } = {}) {
  const fake = createFakeWorld({ without: ["approvers", "identity"] });
  const memberships = new Map<string, { companyId: OrgId; role: OrgRole }>([["dev-a", { companyId: ORG, role: "member" }], ["dev-x", { companyId: OTHER, role: "owner" }]]);
  const people: DeployedPeople = { membershipOf: async (personId) => memberships.get(personId), projectGrantRole: async () => "developer" };
  const identity = createHostedIdentity({ membershipOf: people.membershipOf, displayNameOf: async (personId) => personId });
  fake.modules.push(coreAdapter({ point: "identity", name: HOSTED_IDENTITY_PROVIDER, owner: "fake", create: () => identity }));
  fake.modules.push(coreAdapter({ point: "approvers", name: "deployed", owner: "fake", create: () => createHostedApprovers({ store: fake.store, identity, key: approvalProofKeyOf("k".repeat(32)), now: () => new Date(fake.clock.now) }) }));
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
  const remove = fake.store.delete.bind(fake.store);
  fake.store.delete = async (input) => { const done = await remove(input); const match = /CHANNEL_CARD#([0-9a-f-]{36})$/u.exec(String(input.key.pk)); if (match !== null) cards.delete(match[1]!); return done; };
  const registry: AdapterRegistry = await app.registry();
  const runtime = await app.runtimeFor(ORG);
  const deps = runtime.flow.deps;
  const { task } = await runtime.flow.start({ principal: principalOf("dev-a"), client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
  const stored = (await fake.store.get(taskKey(task.taskId)))!;
  const ownerKey = stored["ownerKey"] as string;
  const objectKey = `private/${ownerKey}/${stored["workspaceId"] as string}/plan-v1.md`;
  const text = options.planText ?? "# Plan\n\nChange src/health.ts to answer 200.\n";
  await registry.require("object-storage").put(objectKey, new TextEncoder().encode(text), { contentType: "text/markdown", metadata: {}, retention: "evidence-std" });
  const initial = createWorkflowSnapshot({ taskId: task.taskId, ownerId: ownerKey, now: "2026-11-15T09:59:00.000Z", definitionVersion: "1.1.0" });
  const workflow = submitWorkflowArtifact(initial, {
    expectedRevision: initial.revision, now: "2026-11-15T10:00:00.000Z",
    artifact: { id: "plan-v1", type: "plan", version: 1, sha256: createHash("sha256").update(text).digest("hex"), producer: "agentx-planner", objectKey, createdAt: "2026-11-15T10:00:00.000Z", format: "markdown" },
  });
  // The task of a chat thread has its session (the start's own transaction writes it: `ticketSessionStartExtras` with chat threads); `session: false` is a task that has none.
  const sessionId = taskSessionId(task.taskId);
  await fake.store.put({ item: { ...stored, ...(options.session === false ? {} : { sessionId }), workflow: JSON.parse(JSON.stringify(workflow)) as JsonValue } });
  const slack = fakeSlack();
  const threads = hostedSlackThreads({ workspaces: workspaces(options.teams ?? { [TEAM_A]: { company: ORG, token: TOKEN_A }, [TEAM_B]: { company: OTHER, token: TOKEN_B } }), fetch: slack.fetchImpl });
  const storage = registry.require("storage");
  await recordTaskThread({ store: storage, orgId: ORG, now: () => fake.clock.now }, { sessionId, conversation: CONVERSATION, personId: "dev-a", actor: ACTOR });
  const origin = "origin" in options ? options.origin : ORIGIN;
  if (options.withoutArtifactReader === true) delete deps.artifacts;
  const handler = hostedThreadHandler({
    threads, registry, companyId: ORG, deps, now: () => fake.clock.now, clock: () => new Date(fake.clock.now), origin: () => origin,
    isMember: async (orgId, personId) => options.member === false ? false : (await people.membershipOf(personId))?.companyId === orgId, log: () => undefined,
  });
  const milestone = (kind: "plan_ready" | "setup_paused", org: OrgId = ORG) => ({ kind, orgId: org, taskId: task.taskId, at: new Date(fake.clock.now).toISOString(), text: "x" }) as never;
  const stepWorkflow = async (): Promise<WorkflowSnapshot> => (await fake.store.get(taskKey(task.taskId)))!["workflow"] as unknown as WorkflowSnapshot;
  return { fake, cards, store: fake.store, storage, registry, runtime, deps, memberships, people, task, sessionId, slack, threads, handler, milestone, stepWorkflow, origin, identity };
}
type World = Awaited<ReturnType<typeof world>>;

const RECHECK_ROW = (orgId: OrgId, state: RecheckState, now: string) => ({
  ...recheckRowKey(orgId, "payments", KEY), entityType: "SETUP_RECHECK", orgId, project: "payments", key: KEY, setupRevision: 1, commits: { demo: "c1" }, classes: ["lockfile"], state, attempt: 1,
  check: { workspaceId: "ws-1", revision: 1, startedAt: now, startedBy: "system" }, startedAt: now, ...(state === "broken" ? { failedStep: STEP } : {}),
});
async function seedBroken(w: World): Promise<void> {
  const now = new Date().toISOString();
  await w.store.put({ item: JSON.parse(JSON.stringify(RECHECK_ROW(ORG, "broken", now))) as StoredDocument });
  await w.store.put({ item: JSON.parse(JSON.stringify({ ...driftTaskKey(ORG, "payments", w.task.taskId), entityType: "SETUP_DRIFT_TASK", orgId: ORG, project: "payments", taskId: w.task.taskId, recheckKey: KEY, state: "pending", at: now })) as StoredDocument });
}

describe("the plan card on a hosted Slack thread", () => {

  it.each([
    { withoutArtifactReader: false, scope: "foreign-company" },
    { withoutArtifactReader: true, scope: "foreign-company" },
    { withoutArtifactReader: false, scope: "wrong-owner" },
    { withoutArtifactReader: true, scope: "wrong-owner" },
  ])("refuses inaccessible task documents before any content reaches a notice or Canvas ($scope, fallback: $withoutArtifactReader)", async ({ withoutArtifactReader, scope }) => {
    const w = await world({ withoutArtifactReader });
    const workflow = await w.stepWorkflow();
    const secret = "# Private plan\n\nNever disclose this task's confidential document.\n";
    const bytes = new TextEncoder().encode(secret);
    const stored = (await w.store.get(taskKey(w.task.taskId)))!;
    const foreignWorkspace = "ws-private-other-company";
    await w.storage.put({ item: { ...workspaceKey(OTHER, foreignWorkspace), entityType: "WORKSPACE", id: foreignWorkspace, companyId: OTHER, orgId: OTHER, ownerKey: "foreign-owner" } });
    const objectKey = scope === "foreign-company" ? `private/foreign-owner/${foreignWorkspace}/plan.md` : `private/wrong-owner/${stored["workspaceId"] as string}/plan.md`;
    await w.registry.require("object-storage").put(objectKey, bytes, { contentType: "text/markdown", metadata: {}, retention: "evidence-std" });
    await w.store.put({ item: { ...stored, workflow: JSON.parse(JSON.stringify({ ...workflow, artifacts: [{ ...workflow.artifacts[0]!, objectKey, sha256: createHash("sha256").update(bytes).digest("hex") }] })) as JsonValue } });
    await w.handler.on(w.milestone("plan_ready"));
    expect((await w.stepWorkflow()).canvasLineage).toBeUndefined();
    expect(w.slack.posts.length).toBeGreaterThan(0);
    expect(JSON.stringify(w.slack.posts)).not.toContain("confidential document");
    expect(JSON.stringify(w.slack.posts)).not.toContain("slack.com/docs/");
  });

  it("xcompany C2: a milestone naming another company's task emits no hosted notification", async () => {
    const w = await world();
    const key = taskKey(w.task.taskId);
    const original = (await w.store.get(key))!;
    const foreign = { ...original, companyId: OTHER };
    await w.store.put({ item: foreign });
    const ownId = randomUUID();
    await w.store.put({ item: { ...original, ...taskKey(ownId), taskId: ownId } });
    await w.handler.on(w.milestone("plan_ready"));
    expect(w.slack.posts).toEqual([]);
    expect(await cardIds(w)).toEqual([]);
    expect(await w.store.get(key)).toEqual(foreign);
    expect((await w.store.get(taskKey(ownId)))?.["companyId"]).toBe(ORG);
  });

  it("xcompany C2: the document lookup treats a task now owned by another company as not found", async () => {
    const w = await world();
    const key = taskKey(w.task.taskId);
    const original = (await w.store.get(key))!;
    const ownId = randomUUID();
    await w.store.put({ item: { ...original, ...taskKey(ownId), taskId: ownId } });
    const foreign = { ...original, companyId: OTHER, title: "Other company's private task" };
    // Change the REAL stored row after the outer task/gate checks, immediately before
    // the document callback re-reads it. Do not bypass or mock either company guard.
    const put = w.store.put.bind(w.store);
    let changed = false;
    w.store.put = async (input) => {
      const result = await put(input);
      if (!changed && result.applied && input.item["entityType"] === "CHANNEL_NOTICE") {
        changed = true;
        await put({ item: foreign });
      }
      return result;
    };
    await w.handler.on(w.milestone("plan_ready"));
    expect(changed).toBe(true);
    expect(await w.store.get(key)).toEqual(foreign);
    expect((await w.store.get(taskKey(ownId)))?.["companyId"]).toBe(ORG);
    // Only the already-authorized card survives; no document/title from the foreign lookup.
    expect(w.slack.posts).toHaveLength(1);
    expect(w.slack.posts[0]?.text).not.toContain("Other company's private task");
    expect(w.slack.posts[0]?.text).not.toContain("Change src/health.ts");
    expect(w.slack.posts[0]?.text).not.toContain("slack.com/docs/");
    expect(await cardIds(w)).toHaveLength(1);
  });

  it("the company fallback still publishes an accessible plan Canvas", async () => {
    const w = await world({ withoutArtifactReader: true });
    await w.handler.on(w.milestone("plan_ready"));
    expect(w.slack.posts[0]?.text).toContain("https://example.slack.com/docs/F0123456789");
    expect((await w.stepWorkflow()).canvasLineage?.[0]?.state).toBe("CREATED");
  });

  it("another company's workspace, a thread whose person left the company, and a workspace with no token get no card (and no Slack call is made for the first two)", async () => {
    // The thread row names company B's workspace: this company never reaches it.
    const other = await world({ teams: { [TEAM_A]: { company: OTHER, token: TOKEN_B } } });
    await other.handler.on(other.milestone("plan_ready"));
    expect(other.slack.posts).toEqual([]);
    expect(await cardIds(other)).toEqual([]);
    // The person who started the task is no longer a member.
    const left = await world({ member: false });
    await left.handler.on(left.milestone("plan_ready"));
    expect(left.slack.posts).toEqual([]);
    expect(await cardIds(left)).toEqual([]);
    // A workspace of this company with no token: the post is refused, no card record stays behind to be answered.
    const tokenless = await world({ teams: { [TEAM_A]: { company: ORG } } });
    await expect(tokenless.handler.on(tokenless.milestone("plan_ready"))).rejects.toThrow();
    expect(tokenless.slack.posts).toEqual([]);
    expect(await cardIds(tokenless)).toEqual([]);
  });

  it("with no https origin there is only Slack's verified Canvas link and no decision button", async () => {
    for (const origin of [undefined, "", "http://app.example", "https://user:pw@app.example"]) {
      const w = await world({ origin });
      await w.handler.on(w.milestone("plan_ready"));
      expect(w.slack.posts).toHaveLength(1);
      expect(buttonsOf(w.slack.posts[0])).toEqual([]);
      expect(w.slack.posts[0]!.text).toContain("https://example.slack.com/docs/F0123456789");
      expect(w.slack.posts[0]!.text).not.toContain("app.example");
    }
  });

  it("a task with no session of its own links to its PROJECT's page (never to a session page that does not exist)", async () => {
    const w = await world({ session: false });
    await w.handler.on(w.milestone("plan_ready"));
    expect(buttonsOf(w.slack.posts[0]).find((button) => button["action_id"] === "rovara_open_task")?.["url"]).toBe(`${ORIGIN}/app/projects/payments`);
  });

  it("the setup pause names the project's page on the web app (the page that holds the repair card), once", async () => {
    const w = await world();
    await seedBroken(w);
    await w.handler.on(w.milestone("setup_paused"));
    await w.handler.on(w.milestone("setup_paused"));
    expect(w.slack.posts).toHaveLength(1);
    expect(w.slack.posts[0]!.text).toBe(setupBrokenWarningMessage(STEP, `${ORIGIN}/app/projects/payments`));
    expect(w.slack.posts[0]!.text).toContain("https://app.example/app/projects/payments");
  });
});

const cardIds = async (w: World): Promise<string[]> => [...w.cards];

describe("the addresses", () => {
  it("a session's page and a project's page are on the web app's own https origin, and nothing else is accepted", () => {
    const session = taskSessionId("8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6");
    expect(sessionPageUrl("https://app.example", session)).toBe(`https://app.example/app/sessions/${session}`);
    expect(sessionPageUrl("https://app.example/some/path?x=1", session)).toBeUndefined();
    expect(sessionPageUrl("http://app.example", session)).toBeUndefined();
    expect(projectPageUrl("https://app.example", "payments")).toBe("https://app.example/app/projects/payments");
    expect(projectPageUrl("https://app.example/x", "pay.ments-1")).toBe("https://app.example/app/projects/pay.ments-1");
    for (const bad of ["../x", "a b", "a/b", "", "-x", "x".repeat(101), "a?b=c"]) expect(projectPageUrl("https://app.example", bad)).toBeUndefined();
    expect(projectPageUrl("http://app.example", "payments")).toBeUndefined();
    expect(projectPageUrl(undefined, "payments")).toBeUndefined();
    expect(projectPageUrl("https://app.example", undefined)).toBeUndefined();
  });
});

describe("what needs a person also reaches the hosted thread", () => {
  async function sweepWorld(options: Parameters<typeof world>[0] = {}) {
    const w = await world(options);
    const owner = principalOf("dev-a");
    const developerId = developerIdOf(owner);
    await w.store.transact(createTaskSessionItems({
      orgId: ORG, sessionId: w.sessionId, taskId: w.task.taskId, project: "payments", agent: { agentId: "rovara-code", name: "Rovara Code", version: 1 }, title: "Add a /health endpoint",
      owner, origin: "app", payer: { kind: "member", developerId } as never, now: new Date(w.fake.clock.now).toISOString(),
    }));
    // The first refresh computes the summary (the task waits on its plan: Needs you); the pending row is what a change into it queues.
    await refreshSessionSummary({ store: w.store, facts: createTaskFactsSource(w.deps), cost: { costUsd: async () => 0 }, now: () => new Date(w.fake.clock.now), log: () => undefined }, ORG, w.sessionId);
    await w.store.put({ item: { pk: PENDING_PK, sk: `${ORG}#${developerId}#${w.sessionId}#needs_you`, orgId: ORG, developerId, sessionId: w.sessionId, kind: "needs_you", at: new Date(w.fake.clock.now).toISOString() } });
    const notification = hostedThreadNotification({ threads: w.threads, registry: w.registry, companyId: ORG, store: w.storage, now: () => w.fake.clock.now, origin: () => w.origin, threadsTold: true });
    const sweep = () => deliverAttention({ store: w.store, now: () => w.fake.clock.now, log: () => undefined, ...notification }, { companyId: ORG });
    return { ...w, developerId, notification, sweep };
  }

  it("the notice service sees the company's Slack as a chat (it saw none before), and the thread is the one the task was started from, named by the person's session id", async () => {
    const w = await sweepWorld();
    expect(w.notification.registry.names("channel")).toEqual([SLACK_CHANNEL]);
    expect(w.notification.registry.get("channel", SLACK_CHANNEL)).toBeDefined();
    expect(w.notification.registry.names("email")).toEqual(w.registry.names("email"));
    expect(await w.notification.thread!(ORG, w.sessionId)).toEqual({ conversation: CONVERSATION, personId: w.developerId });
    // The thread's own "done" line is the milestones' where they run; without them the notice service tells it.
    expect(w.notification.doneToldInThread!()).toBe(true);
    expect(hostedThreadNotification({ threads: w.threads, registry: w.registry, companyId: ORG, store: w.storage, now: () => 0, origin: () => w.origin, threadsTold: false }).doneToldInThread!()).toBe(false);
  });

  it("a needs-you notice is told in the thread with the task's page link, with the company's token; a person with no thread is told nowhere", async () => {
    const w = await sweepWorld();
    expect(await w.sweep()).toMatchObject({ people: 1, sent: 1 });
    expect(w.slack.posts).toHaveLength(1);
    expect(w.slack.posts[0]).toMatchObject({ token: TOKEN_A, channel: CHANNEL, thread_ts: TS });
    expect(w.slack.posts[0]!.text).toContain(`${ORIGIN}/app/sessions/${w.sessionId}`);
    // Told once: the row is gone.
    expect(await w.sweep()).toMatchObject({ sent: 0 });
    expect(w.slack.posts).toHaveLength(1);
  });

  it("the plan card already in the thread means the needs-you reminder is NOT sent there again", async () => {
    const w = await sweepWorld();
    await w.handler.on(w.milestone("plan_ready"));
    expect(w.slack.posts).toHaveLength(1);
    const session = (await w.notification.planCarded!({ orgId: ORG, sessionId: w.sessionId, subject: { kind: "task", taskId: w.task.taskId } } as never));
    expect(session).toBe(true);
    expect(await w.sweep()).toMatchObject({ sent: 0 });
    expect(w.slack.posts).toHaveLength(1);
  });

  it("another company's workspace, a person who left, and a thread row of another company's session are never told", async () => {
    // The workspace of the thread moved to company B.
    const moved = await sweepWorld({ teams: { [TEAM_A]: { company: OTHER, token: TOKEN_B } } });
    expect(await moved.sweep()).toMatchObject({ sent: 0, unreachable: 1, failed: 0 });
    expect(moved.slack.posts).toEqual([]);
    // The person is no longer a member: no thread, so nobody is told.
    const left = await sweepWorld();
    left.memberships.delete("dev-a");
    expect(await left.notification.thread!(ORG, left.sessionId)).toBeUndefined();
    expect(await left.sweep()).toMatchObject({ sent: 0 });
    expect(left.slack.posts).toEqual([]);
    // Asked for another company's session: nothing.
    const w = await sweepWorld();
    expect(await w.notification.thread!(OTHER, w.sessionId)).toBeUndefined();
    expect(w.notification.link!({ orgId: OTHER, sessionId: w.sessionId } as never)).toBeUndefined();
  });

  it("another person's notice (the thread's person is not the row's person) is not told in the thread", async () => {
    const w = await sweepWorld();
    const stranger = developerIdOf(principalOf("someone-else"));
    await w.store.delete({ key: { pk: PENDING_PK, sk: `${ORG}#${w.developerId}#${w.sessionId}#needs_you` } });
    await w.store.put({ item: { pk: PENDING_PK, sk: `${ORG}#${stranger}#${w.sessionId}#needs_you`, orgId: ORG, developerId: stranger, sessionId: w.sessionId, kind: "needs_you", at: new Date(w.fake.clock.now).toISOString() } });
    expect((await w.sweep()).sent).toBe(0);
    expect(w.slack.posts).toEqual([]);
  });
});

describe("the thread's moments are written for a session that follows a thread, and for nothing else", () => {

  it("a table that serves one company writes nothing for another company's task", async () => {
    const w = await world();
    const milestones = createDocumentMilestones({ store: w.store, now: () => w.fake.clock.now });
    const change = { orgId: ORG, sessionId: w.sessionId, session: { subject: { kind: "task", taskId: w.task.taskId } }, summary: { display: { state: "needs_you" } }, ended: false } as never;
    await ticketMomentsOnChange({ store: w.store, milestones, now: () => w.fake.clock.now, follows: async () => true, ticketBindings: false, companyId: OTHER })(change);
    expect((await w.store.query({ pk: `DEVTASK#${w.task.taskId}` })).items.filter((item) => JSON.stringify(item).includes("plan_ready"))).toEqual([]);
  });
});

describe("the wiring (guards on the source, beside the behaviour above)", () => {
  const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

  it("the hosted root registers the hosted thread handler, gives the notice service the thread's wiring, and links the admins' setup notice", () => {
    const root = read("packages/broker/src/aws/core-engine-root.ts");
    expect(root).toMatch(/lessons\.milestones\.register\(hostedThreadHandler\(\{\s+threads, registry, companyId, deps: flow\.deps/u);
    // Batch b18: the thread notification shares one notification object with the attention email's seams (#1030 beside #994's email).
    expect(root).toContain("...(inputs.chatThreads === undefined ? {} : hostedThreadNotification({ threads: inputs.chatThreads");
    expect(root).toContain("threadMoments: lessons !== undefined");
    expect(root).toContain("startExtras: ticketSessionStartExtras(companyId, { chatThreads: inputs.chatThreads !== undefined })");
    expect(root).toContain("setupLink: (project) => projectPageUrl(originOf(), project)");
    const broker = read("packages/broker/src/aws/broker.ts");
    expect(broker).toContain("notification: { ...(wiring.notification ?? {}),");
    expect(broker).toContain("...(wiring.threadMoments === true ? { threadMoments: true } : {})");
  });

  it("the handler is given the gate's `requirement` alone (a chat can post the card, never decide), and the session sweep writes thread moments only with milestones", () => {
    const source = read("packages/broker/src/core-host/thread-notification.ts");
    expect(source).toContain("plan: { gate: { requirement: (orgId, kind, subjectId) => gate.requirement(orgId, kind, subjectId) } }");
    expect(source).not.toMatch(/gate\.decide|gate\.verify/u);
    const jobs = read("packages/broker/src/aws/core-job-services.ts");
    expect(jobs).toContain("options.threadMoments === true && deps.milestones !== undefined");
    expect(jobs).toContain("ticketBindings: false, companyId");
  });
});


it("the hosted plan card uses the persisted Canvas, and its terminal milestone closes it out", async () => {
  const w = await world();
  await w.handler.on(w.milestone("plan_ready"));
  expect(w.slack.posts[0]?.text).toContain("https://example.slack.com/docs/F0123456789");
  expect((await w.stepWorkflow()).canvasLineage?.[0]).toMatchObject({ state: "CREATED", canvasId: "F0123456789" });
  const stored = (await w.store.get(taskKey(w.task.taskId)))!;
  await w.store.put({ item: { ...stored, closedAt: new Date(w.fake.clock.now).toISOString() } });
  await w.handler.on({ kind: "closed", orgId: ORG, taskId: w.task.taskId, at: new Date(w.fake.clock.now).toISOString(), text: "closed" });
  expect((await w.stepWorkflow()).canvasCloseout?.status).toBe("COMPLETE");
});


it.each([false, true])("review3: pending Canvas cleanup posts once and stays due until the real dispatcher confirms deletion (post unavailable: %s)", async (postUnavailable) => {
  const w = await world();
  await w.handler.on(w.milestone("plan_ready"));
  const stored = (await w.store.get(taskKey(w.task.taskId)))!;
  await w.store.put({ item: { ...stored, closedAt: new Date(w.fake.clock.now).toISOString() } });
  w.slack.confirmDeletion(false);
  w.slack.failPosts(postUnavailable);
  const pendingPosts = postUnavailable ? 1 : 2;
  const closed = { kind: "closed" as const, orgId: ORG, taskId: w.task.taskId, at: new Date(w.fake.clock.now).toISOString(), text: "closed" };
  const milestones = createDocumentMilestones({ store: w.store, now: () => w.fake.clock.now });
  milestones.register(w.handler);
  await w.store.transact(milestones.items(closed, 1));
  const row = async () => (await w.store.query({ pk: `DEVTASK#${w.task.taskId}`, sk: { op: "beginsWith", prefix: "CODE_MILESTONE#closed#" } })).items[0]!;
  await milestones.deliver(w.task.taskId);
  expect(w.slack.posts).toHaveLength(pendingPosts);
  if (!postUnavailable) expect(w.slack.posts[1]?.text).toContain("closed");
  expect((await w.stepWorkflow()).canvasCloseout).toMatchObject({ status: "ARCHIVE_PENDING", canvases: [{ status: "UNKNOWN", attempts: 1 }] });
  expect(await row()).toMatchObject({ dispatchDuePk: "CODE_MILESTONE", tries_channel_thread: 0 });
  expect((await row())["done_channel_thread"]).toBeUndefined();
  expect((await row())["deliveredAt"]).toBeUndefined();
  // Pending destructive cleanup must outlive ordinary delivery's five-error limit.
  for (let attempt = 0; attempt < 6; attempt++) {
    w.fake.clock.now += 600_000;
    expect(await milestones.deliverDue()).toMatchObject({ attempted: 1 });
    expect((await row())["done_channel_thread"]).toBeUndefined();
    expect((await row())["deliveredAt"]).toBeUndefined();
    expect((await row())["dispatchDuePk"]).toBe("CODE_MILESTONE");
    expect(w.slack.posts).toHaveLength(pendingPosts);
  }
  // No legacy task.share exists; this must recover through the persisted core dispatcher.
  expect(stored["share"]).toBeUndefined();
  w.slack.confirmDeletion(true);
  w.slack.failPosts(false);
  w.fake.clock.now += 120_000;
  expect(await milestones.deliverDue()).toMatchObject({ attempted: 1 });
  await milestones.deliver(w.task.taskId);
  expect(await row()).toMatchObject({ done_channel_thread: true, deliveredAt: new Date(w.fake.clock.now).toISOString() });
  expect((await row())["dispatchDuePk"]).toBeUndefined();
  expect((await row())["dispatchDueSk"]).toBeUndefined();
  expect((await w.stepWorkflow()).canvasCloseout).toMatchObject({ status: "COMPLETE", canvases: [{ status: "DELETED", attempts: 8 }] });
  expect(w.slack.posts).toHaveLength(2);
});

/** Persist the same terminal milestone production sweeps, without legacy task.share. */
async function pendingCloseoutWorld() {
  const w = await world();
  await w.handler.on(w.milestone("plan_ready"));
  const stored = (await w.store.get(taskKey(w.task.taskId)))!;
  await w.store.put({ item: { ...stored, closedAt: new Date(w.fake.clock.now).toISOString() } });
  w.slack.confirmDeletion(false);
  const dispatcher = () => {
    const milestones = createDocumentMilestones({ store: w.store, now: () => w.fake.clock.now });
    milestones.register(w.handler);
    return milestones;
  };
  const milestones = dispatcher();
  await w.store.transact(milestones.items({ kind: "closed", orgId: ORG, taskId: w.task.taskId, at: new Date(w.fake.clock.now).toISOString(), text: "closed" }, 1));
  await milestones.deliver(w.task.taskId);
  const row = async () => (await w.store.query({ pk: `DEVTASK#${w.task.taskId}`, sk: { op: "beginsWith", prefix: "CODE_MILESTONE#closed#" } })).items[0]!;
  expect((await w.stepWorkflow()).canvasCloseout?.status).toBe("ARCHIVE_PENDING");
  expect((await row())["deliveredAt"]).toBeUndefined();
  expect(w.slack.posts).toHaveLength(2);
  return { ...w, dispatcher, row };
}

it.each([
  [1, "thread handler task"], [2, "hosted closeout task"], [3, "closeout load"],
  [4, "attempt checkpoint"], [5, "outcome checkpoint"],
] as const)("review4: pending cleanup survives five exceptions at read %s (%s)", async (readPosition, readLabel) => {
  const w = await pendingCloseoutWorld();
  // Reconstruct the dispatcher so retryability cannot depend on process memory.
  const milestones = w.dispatcher();
  const get = w.store.get.bind(w.store);
  let taskReads = 0;
  let failedReads = 0;
  w.store.get = async (key) => {
    if (key.pk === taskKey(w.task.taskId).pk && key.sk === taskKey(w.task.taskId).sk && ++taskReads === readPosition) {
      failedReads++;
      throw new Error("temporary task read failure");
    }
    return get(key);
  };
  try {
    for (let retry = 0; retry < 5; retry++) {
      taskReads = 0;
      w.fake.clock.now += 600_000;
      expect(await milestones.deliverDue()).toEqual({ attempted: 1 });
      expect((await w.row())["deliveredAt"]).toBeUndefined();
      expect((await w.row())["dispatchDuePk"]).toBe("CODE_MILESTONE");
    }
  } finally { w.store.get = get; }
  expect(failedReads, readLabel).toBe(5);
  w.slack.confirmDeletion(true);
  w.fake.clock.now += 600_000;
  expect(await w.dispatcher().deliverDue()).toEqual({ attempted: 1 });
  expect((await w.stepWorkflow()).canvasCloseout?.status).toBe("COMPLETE");
  expect(await w.row()).toMatchObject({ done_channel_thread: true, deliveredAt: new Date(w.fake.clock.now).toISOString() });
  expect((await w.row())["dispatchDuePk"]).toBeUndefined();
  expect(w.slack.posts).toHaveLength(2);
});

it.each([999, 1000])("review4: pending cleanup keeps the workflow valid at %s Canvas attempts and still completes", async (attempts) => {
  const w = await pendingCloseoutWorld();
  const task = (await w.store.get(taskKey(w.task.taskId)))!;
  const workflow = await w.stepWorkflow();
  const seeded = { ...workflow, canvasCloseout: { ...workflow.canvasCloseout!, canvases: workflow.canvasCloseout!.canvases.map((canvas) => ({ ...canvas, attempts })) } };
  expect(WorkflowSnapshotSchema.safeParse(seeded).success).toBe(true);
  await w.store.put({ item: { ...task, workflow: JSON.parse(JSON.stringify(seeded)) as JsonValue } });
  w.fake.clock.now += 600_000;
  expect(await w.dispatcher().deliverDue()).toEqual({ attempted: 1 });
  const pending = await w.stepWorkflow();
  expect(pending.canvasCloseout).toMatchObject({ status: "ARCHIVE_PENDING", canvases: [{ attempts: 1000, status: "UNKNOWN" }] });
  expect(WorkflowSnapshotSchema.safeParse(pending).success).toBe(true);
  expect((await w.row())["deliveredAt"]).toBeUndefined();
  w.slack.confirmDeletion(true);
  w.fake.clock.now += 600_000;
  expect(await w.dispatcher().deliverDue()).toEqual({ attempted: 1 });
  const completed = await w.stepWorkflow();
  expect(completed.canvasCloseout).toMatchObject({ status: "COMPLETE", canvases: [{ attempts: 1000, status: "DELETED" }] });
  expect(WorkflowSnapshotSchema.safeParse(completed).success).toBe(true);
  expect((await w.row())["deliveredAt"]).toBeDefined();
  expect(w.slack.posts).toHaveLength(2);
});

it.each([
  ["reviewer's large plan", "# Plan\n\n" + "A normal plan line.\n".repeat(2000)],
  ["UTF-8 bytes above the limit", "# Plan\n\n" + "界".repeat(11000)],
])("review2: %s retains its approval card through the task-page fallback", async (_label, planText) => {
  const w = await world({ planText });
  let error: unknown;
  try { await w.handler.on(w.milestone("plan_ready")); } catch (caught) { error = caught; }
  expect({ error, posts: w.slack.posts.length }).toEqual({ error: undefined, posts: 1 });
  expect(w.slack.posts[0]?.text).toContain(`${ORIGIN}/app/sessions/${w.sessionId}`);
  expect(w.slack.posts[0]?.text).not.toContain("slack.com/docs");
  expect(await cardIds(w)).toHaveLength(1);
  expect((await w.stepWorkflow()).canvasLineage).toBeUndefined();
});
