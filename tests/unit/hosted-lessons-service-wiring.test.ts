// Lead 4 L4-HW2: the hosted lessons job and the learning port are what the broker hands the core root. The root, registry, runtime, lessons and the hosted people port are real; only the deployment's adapters
// (the fake world) and the model gateway (an injected fetch) are stand-ins.
//   (a) `lessons.service` is returned from the company's services, so the 5-minute `lessons` schedule runs the pass: the reflection queue pump, milestones.deliverDue() retries, the nightly upkeep.
//   (b) the learning model is the gateway's learning route on the company's own account: no gateway, no token, no call; a company the gateway has no allowance for learns nothing and spends nothing.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { CORE_LEARNING_MODEL_VARIABLE, LESSONS_PAUSE_TEXT, codeMilestoneKey, companyScoped, orgProjectCatalogKey, projectRevisionKey, queryAll, teamRecordPk, type CodeMilestone, type JsonValue, type OfferedAgentModels, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { createHostedLessonsPeople } from "../../packages/broker/src/aws/hosted-lessons-people.js";
import { CORE_AGENT_MODEL_VARIABLE, CORE_MODEL_GATEWAY_URL_VARIABLE, taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { LEARNING_NO_CLAUDE_NOTICE, hostedLessonsLearning } from "../../packages/broker/src/core-host/hosted-learning.js";
import { LEARNING_MESSAGES_PATH, LEARNING_PAUSE_HEADER } from "../../packages/broker/src/lessons/gateway-learning.js";
import { setLearnedLessonsGate } from "../../packages/broker/src/lessons/policy.js";
import { codeMilestoneItems, type DocumentMilestones } from "../../packages/broker/src/core/milestones/milestones.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import type { TokenSigner } from "../../packages/broker/src/developer/tokens.js";
import { createFakeWorld, FAKE_COMPANY, type FakeWorld } from "../support/core-host-fakes.js";
import { candidateJson, reply } from "./lessons/lesson-helpers.js";

afterEach(() => setLearnedLessonsGate(undefined));

// Substitute only the deployment adapters; the root, registry, runtime and lessons API are real.
const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", () => ({ codeAdapterModules: () => adapters.modules }));
vi.mock("../../packages/broker/src/core-host/hosted-modules.js", async (original) => ({ ...await original<object>(), hostedSecurityModules: () => [] }));

const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const secret = Buffer.alloc(32, 7);
const id = (n: number): string => n.toString(16).padStart(64, "0");
const [MEMBER_A, MEMBER_B] = [id(1), id(3)];
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const GATEWAY = "https://gateway.staging.example";
const ISSUER = "https://api.staging.example/v1/auth";
const MODEL = "claude-sonnet-5";
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = pair.publicKey.export({ type: "spki", format: "der" });
const exported = pair.publicKey.export({ format: "jwk" }) as { n: string; e: string };
const KID = createHash("sha256").update(der).digest("base64url").slice(0, 16);
const bareKey = (): TokenSigner => ({
  publicJwk: async () => ({ kty: "RSA", n: exported.n, e: exported.e, kid: KID, alg: "RS256", use: "sig" }) as never,
  sign: async (input) => sign("sha256", input, pair.privateKey),
});
// DEC 254zzz58: the learning model is its own setting; these cases set it to the Claude model (the agent model's own cases are in "(c)").
const GATEWAY_ENV = { [CORE_MODEL_GATEWAY_URL_VARIABLE]: GATEWAY, [CORE_AGENT_MODEL_VARIABLE]: MODEL, [CORE_LEARNING_MODEL_VARIABLE]: MODEL };
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;

interface Seen { url: string; token: string; body: { messages?: Array<{ content?: string }> } }

async function setup(options: { lessons?: string; gateway?: boolean; answer?: (n: number, seen: Seen) => Response | Promise<Response>; learning?: boolean; custom?: (companyId: OrgId) => unknown; log?: (entry: Record<string, unknown>) => void; learningEnv?: NodeJS.ProcessEnv; offered?: (companyId: OrgId) => Promise<OfferedAgentModels> } = {}) {
  const world = createFakeWorld();
  adapters.modules = world.modules;
  const rows = new Map<string, Record<string, unknown>>();
  const member = (personId: string, companyId: OrgId) => {
    rows.set(`signin|COMPANY_MEMBER#${personId}|COMPANY`, { pk: `COMPANY_MEMBER#${personId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId, companyId, role: "member", joinedAt: "2026-10-01T00:00:00.000Z" });
    rows.set(`signin|${companyScoped(companyId, "MEMBERS")}|MEMBER#${personId}`, { pk: companyScoped(companyId, "MEMBERS"), sk: `MEMBER#${personId}`, entityType: "COMPANY_MEMBER_VIEW", personId, companyId, role: "member", joinedAt: "2026-10-01T00:00:00.000Z" });
    rows.set(`state|MEMBER#${personId}|PROJECT#payments`, { pk: `MEMBER#${personId}`, sk: "PROJECT#payments", projectName: "payments", role: "developer" });
  };
  member(MEMBER_A, A); member(MEMBER_B, B);
  const client = { async send(command: unknown) {
    if (command instanceof GetCommand) {
      const { TableName, Key } = command.input as { TableName: string; Key: { pk: string; sk: string } };
      if (TableName === "signin" || TableName === "state") return { Item: rows.get(`${TableName}|${Key.pk}|${Key.sk}`) };
      return { Item: await world.store.get(Key) };
    }
    if (command instanceof QueryCommand) {
      const input = command.input as { ExpressionAttributeValues: Record<string, string> };
      const pk = input.ExpressionAttributeValues[":pk"]!;
      const items = [...rows.entries()].filter(([k]) => k.startsWith(`signin|${pk}|`)).map(([, row]) => row);
      return { Items: items, ScannedCount: items.length };
    }
    throw new Error("unexpected write");
  } };
  const seen: Seen[] = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    const entry: Seen = { url: String(url), token: (init?.headers as Record<string, string>)["x-api-key"]!, body: JSON.parse(init?.body as string) as Seen["body"] };
    seen.push(entry);
    return await (options.answer ?? (() => new Response(JSON.stringify({ model: MODEL, content: [{ type: "text", text: reply() }] }), { status: 200, headers: { "content-type": "application/json" } })))(seen.length - 1, entry);
  }) as unknown as typeof fetch;
  const root = createBrokerCoreRoot({
    env: { ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: "all", ...(options.lessons === undefined ? {} : { ROVARA_CORE_LESSONS: options.lessons }) },
    documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: secret.toString(), repositoryGrantKey: secret,
    codeModules: () => ({}) as never, repositoryCredential: async () => { throw new Error("unused"); }, origin: () => "https://api.example", log: options.log ?? (() => undefined),
    now: () => new Date(world.clock.now), ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: () => Object.fromEntries(["merge-tracking", "session-sweep", "notify-deliver", "admission-hold-sweep"].map((name) => [name, { pass: async () => ({}) }])),
    lessonsPeople: createHostedLessonsPeople({ documentClient: client, stateTableName: "state", signInTableName: "signin", now: () => world.clock.now }),
    ...(options.custom !== undefined ? { lessonsLearning: options.custom as NonNullable<Parameters<typeof createBrokerCoreRoot>[0]["lessonsLearning"]> } : options.learning === false ? {} : { lessonsLearning: hostedLessonsLearning(options.gateway === false ? {} : options.learningEnv ?? GATEWAY_ENV, () => ({ signer: taskKeySigner(bareKey()), issuer: ISSUER }), { fetch: fetchImpl, now: () => world.clock.now, timeoutMs: 1_000, ...(options.offered === undefined ? {} : { offered: options.offered }), ...(options.log === undefined ? {} : { log: options.log }) }) }),
  });
  return { root, world, seen, fetchImpl };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const lessonsJob = (root: Setup["root"]) => root.app.handleScheduledJob({ source: "agentx.core-job", job: "lessons" });
const reportOf = (result: unknown, company: string) => ((result as { companies: Array<{ companyId: string; outcome: string; report?: Record<string, unknown> }> }).companies).find((entry) => entry.companyId === company);

const reflectedIn = (result: unknown): number => ((result as { companies: Array<{ report?: { reflected?: number } }> }).companies).reduce((sum, entry) => sum + (entry.report?.reflected ?? 0), 0);

const receivedIn = (result: unknown): number => ((result as { companies: Array<{ report?: { received?: number } }> }).companies).reduce((sum, entry) => sum + (entry.report?.received ?? 0), 0);

async function registerProject(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

/** A task of the company, started by its member, with the member's send-back words on its record; then it merges (the milestone is written and delivered as the flow would). */
async function mergedTask(s: Setup, companyId: OrgId, personId: string, words: string): Promise<string> {
  await registerProject(s.world, companyId);
  const runtime = await s.root.app.runtimeFor(companyId);
  const principal = localOwnerPrincipal({ companyId, personId });
  const { task } = await runtime.flow.start({ principal, client: "test", origin: "app" as const }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
  const record = (await s.world.store.get(taskKey(task.taskId)))! as unknown as Record<string, unknown> & { workflow: { decisions: unknown[]; revision: number } };
  const at = new Date(s.world.clock.now).toISOString();
  const decision = { requestId: randomUUID(), workflowRevision: record.workflow.revision, actorId: personId, actorRole: "TASK_OWNER", at, decision: "REQUEST_CHANGES", source: "SEND_BACK", reason: words };
  await s.world.store.put({ item: { ...record, workflow: { ...record.workflow, decisions: [...record.workflow.decisions, decision] } } as never });
  const milestone: CodeMilestone = { kind: "merged", orgId: companyId, taskId: task.taskId, at, text: "merged" };
  await runtime.flow.deps.store.transact(codeMilestoneItems(milestone, 1));
  await runtime.flow.deps.milestones?.deliver(task.taskId);
  return task.taskId;
}

/** A company is served by the schedule once it has a task on the core (its stamp); start one so the job reaches it. */
async function servedCompany(s: Setup, companyId: OrgId, personId: string): Promise<void> {
  await registerProject(s.world, companyId);
  const runtime = await s.root.app.runtimeFor(companyId);
  await runtime.flow.start({ principal: localOwnerPrincipal({ companyId, personId }), client: "test", origin: "app" as const }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
}

describe("(a) the lessons job is wired on the hosted root", () => {
  it("the company's services return the lessons pass where the switch covers it, and the 5-minute `lessons` job runs it (not `service_not_wired`)", async () => {
    const s = await setup({ lessons: "on" });
    await servedCompany(s, A, MEMBER_A);
    const runtime = await s.root.app.runtimeFor(A);
    expect(runtime.services.lessons).toBeDefined();
    const result = await lessonsJob(s.root);
    const report = reportOf(result, A);
    expect(report?.outcome).toBe("ran");
    expect(report?.report).not.toHaveProperty("skipped");
    const passed = report?.report as Record<string, unknown>;
    expect([typeof passed.milestones, typeof passed.reflected, typeof passed.nightly]).toEqual(["number", "number", "boolean"]);
  });

  it("where the switch is off, or names only another company, no pass is returned: the job is skipped as not wired for this company, and nothing is built", async () => {
    for (const lessons of [undefined, "off", `on:${B}`]) {
      const s = await setup({ ...(lessons === undefined ? {} : { lessons }) });
      await servedCompany(s, A, MEMBER_A);
      const runtime = await s.root.app.runtimeFor(A);
      expect(runtime.services.lessons, String(lessons)).toBeUndefined();
      expect(reportOf(await lessonsJob(s.root), A)?.report, String(lessons)).toMatchObject({ skipped: "service_not_wired" });
    }
  });

  it("a milestone a handler failed on (a Slack thread or Linear write-back that failed once) is told again by the pass", async () => {
    const s = await setup({ lessons: "on" });
    await servedCompany(s, A, MEMBER_A);
    const runtime = await s.root.app.runtimeFor(A);
    const heard: string[] = [];
    let failures = 1;
    (runtime.flow.deps.milestones as DocumentMilestones).register({ name: "slack_thread", on: async (milestone) => { heard.push(milestone.kind); if (failures-- > 0) throw new Error("slack down"); } });
    const taskId = randomUUID();
    const at = new Date(s.world.clock.now).toISOString();
    await runtime.flow.deps.store.transact(codeMilestoneItems({ kind: "pr_ready", orgId: A, taskId, at, text: "ready" }, 1));
    await runtime.flow.deps.milestones!.deliver(taskId);
    expect(heard).toEqual(["pr_ready"]);
    // Not due yet: the pass retries nothing.
    expect(reportOf(await lessonsJob(s.root), A)?.report).toMatchObject({ milestones: 0 });
    expect(heard).toEqual(["pr_ready"]);
    s.world.clock.advance(120);
    expect(reportOf(await lessonsJob(s.root), A)?.report).toMatchObject({ milestones: 1 });
    expect(heard).toEqual(["pr_ready", "pr_ready"]);
    const rows = await queryAll(runtime.flow.deps.store, { pk: `DEVTASK#${taskId}`, sk: { op: "beginsWith", prefix: "CODE_MILESTONE#" } });
    expect(rows[0]).toMatchObject({ done_slack_thread: true });
    expect(codeMilestoneKey(taskId, "pr_ready", 1).sk).toBe(rows[0]!["sk"]);
  });
});

describe("(b) the learning model is the gateway's, on the company's own account", () => {
  const sentBack = "Use the shared retry helper withRetry, not a hand-written loop.";

  it("a finished hosted task is reflected: one learning call goes to the gateway's learning path with the company's own learning token, carrying the member's words", async () => {
    const s = await setup({ lessons: "on", answer: () => new Response(JSON.stringify({ model: MODEL, content: [{ type: "text", text: reply(candidateJson({ citations: [], scope: {}, evidenceSpanIds: ["S1"] })) }] }), { status: 200, headers: { "content-type": "application/json" } }) });
    await mergedTask(s, A, MEMBER_A, sentBack);
    expect(s.seen).toEqual([]);
    const result = await lessonsJob(s.root);
    // The reflection queue is one per install: whichever company's pass takes the message hands it to the task's own company.
    expect(reflectedIn(result)).toBe(1);
    expect(s.seen.length).toBeGreaterThanOrEqual(1);
    const first = s.seen[0]!;
    expect(first.url).toBe(`${GATEWAY}${LEARNING_MESSAGES_PATH}`);
    expect(claimsOf(first.token)).toMatchObject({ cid: A, pid: "payments", stp: "rovara-lessons-learning-call", mdl: [MODEL] });
    expect(JSON.stringify(first.body)).toContain("withRetry");
  });

  it("with no model gateway set up, a finished task makes NO learning call at all and nothing is learned (the queue message is still taken)", async () => {
    const s = await setup({ lessons: "on", gateway: false });
    await mergedTask(s, A, MEMBER_A, sentBack);
    const result = await lessonsJob(s.root);
    expect(s.seen).toEqual([]);
    // The message was taken off the queue (not left to loop) and nothing was learned.
    expect(receivedIn(result)).toBe(1);
  });

  it("with no learning port given at all, no call is made either", async () => {
    const s = await setup({ lessons: "on", learning: false });
    await mergedTask(s, A, MEMBER_A, sentBack);
    await lessonsJob(s.root);
    expect(s.seen).toEqual([]);
  });

  it("a company the gateway has no allowance for (no connected account, no room) learns nothing: the gateway's pause is the whole answer and the pass still completes", async () => {
    const s = await setup({ lessons: "on", answer: () => new Response(JSON.stringify({ error: { type: "lessons_paused", message: "words" } }), { status: 403, headers: { "content-type": "application/json", [LEARNING_PAUSE_HEADER]: "no_provider" } }) });
    await mergedTask(s, A, MEMBER_A, sentBack);
    const result = await lessonsJob(s.root);
    expect(reportOf(result, A)?.outcome).toBe("ran");
    expect(s.seen.length).toBeGreaterThanOrEqual(1);
    // Every attempt the pass made was refused at the gateway; no lesson of the company exists.
    const stored = await queryAll(s.world.store, { pk: `${companyScoped(A, "LESSONS")}`, sk: { op: "beginsWith", prefix: "" } }).catch(() => []);
    expect(stored).toEqual([]);
  });

  it("two companies: each company's task is reflected with its own token, and a company the switch does not name makes no call", async () => {
    const s = await setup({ lessons: `on:${A}:${B}` });
    await mergedTask(s, A, MEMBER_A, sentBack);
    await mergedTask(s, B, MEMBER_B, "Name the route /healthz like the others.");
    await lessonsJob(s.root);
    const byCompany = s.seen.map((seen) => claimsOf(seen.token).cid);
    expect(new Set(byCompany)).toEqual(new Set([A, B]));
    for (const seen of s.seen) {
      const cid = claimsOf(seen.token).cid;
      // A's words only ever travel on A's token, B's on B's.
      expect(JSON.stringify(seen.body).includes("withRetry")).toBe(cid === A);
      expect(JSON.stringify(seen.body).includes("healthz")).toBe(cid === B);
    }
    const off = await setup({ lessons: `on:${B}` });
    await mergedTask(off, A, MEMBER_A, sentBack);
    await lessonsJob(off.root);
    expect(off.seen).toEqual([]);
  });
});

// DEC 254zzz58: learning has its OWN model. Staging runs its agents on zai.glm-5 (not a Claude model); before, that switched learning off (`lessons_learning_not_set_up`) and nothing was learned.
describe("(c) the learning model is its own, never the agent model", () => {
  const sentBack = "Use the shared retry helper withRetry, not a hand-written loop.";
  const GLM = "zai.glm-5";
  const answer = () => new Response(JSON.stringify({ model: MODEL, content: [{ type: "text", text: reply(candidateJson({ citations: [], scope: {}, evidenceSpanIds: ["S1"] })) }] }), { status: 200, headers: { "content-type": "application/json" } });
  const offering = (...models: string[]) => async (): Promise<OfferedAgentModels> => ({ version: 1, models: models.map((model) => ({ model })) });
  const glmEnv = (learning?: string): NodeJS.ProcessEnv => ({ [CORE_MODEL_GATEWAY_URL_VARIABLE]: GATEWAY, [CORE_AGENT_MODEL_VARIABLE]: GLM, ...(learning === undefined ? {} : { [CORE_LEARNING_MODEL_VARIABLE]: learning }) });
  const pauseOf = async (s: Setup, companyId: OrgId) => s.world.store.get({ pk: teamRecordPk(companyId, "payments"), sk: "LESSONSET#PAUSED" });

  it("agent model zai.glm-5 with the learning model set: the task is reflected on the LEARNING model (the token's one model and the request's), and nothing says 'not set up'", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const s = await setup({ lessons: "on", answer, learningEnv: glmEnv(MODEL), log: (entry) => { logs.push(entry); } });
    await mergedTask(s, A, MEMBER_A, sentBack);
    expect(reflectedIn(await lessonsJob(s.root))).toBe(1);
    expect(s.seen.length).toBeGreaterThanOrEqual(1);
    for (const seen of s.seen) {
      expect(seen.url).toBe(`${GATEWAY}${LEARNING_MESSAGES_PATH}`);
      expect(claimsOf(seen.token)).toMatchObject({ cid: A, mdl: [MODEL] });
      expect((seen.body as { model?: string }).model).toBe(MODEL);
    }
    expect(JSON.stringify(s.seen)).not.toContain(GLM);
    expect(logs.filter((entry) => entry.event === "core_engine.lessons_learning_not_set_up")).toEqual([]);
  });

  it("agent model zai.glm-5 with the learning model empty: the first Claude model the gateway offers the company learns", async () => {
    const asked: string[] = [];
    const s = await setup({ lessons: "on", answer, learningEnv: glmEnv(), offered: async (companyId) => { asked.push(companyId); return offering(GLM, MODEL, "claude-haiku-4-5")(); } });
    await mergedTask(s, A, MEMBER_A, sentBack);
    expect(reflectedIn(await lessonsJob(s.root))).toBe(1);
    expect(s.seen.length).toBeGreaterThanOrEqual(1);
    expect(s.seen.map((seen) => claimsOf(seen.token).mdl)).toEqual(s.seen.map(() => [MODEL]));
    expect(new Set(asked)).toEqual(new Set([A]));
  });

  it("no Claude model offered: no learning call, nothing spent, the log says it once with the fixed notice, and the admins' Lessons line says it", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const s = await setup({ lessons: "on", answer, learningEnv: glmEnv(), offered: offering(GLM, "us.amazon.nova-2-lite-v1:0"), log: (entry) => { logs.push(entry); } });
    await mergedTask(s, A, MEMBER_A, sentBack);
    await lessonsJob(s.root);
    expect(s.seen).toEqual([]);
    expect(logs.filter((entry) => entry.event === "core_engine.lessons_learning_not_set_up")).toEqual([{ event: "core_engine.lessons_learning_not_set_up", companyId: A, reason: "no_claude_model", notice: LEARNING_NO_CLAUDE_NOTICE }]);
    expect(await pauseOf(s, A)).toMatchObject({ code: "no_suitable_model" });
    expect(LESSONS_PAUSE_TEXT.no_suitable_model).toBe("Lessons paused: no available model can write lessons");
  });

  it("a learning model set to a model other than Claude is refused: no port, the same 'not set up' line as before, and no call", async () => {
    for (const learning of [GLM, "us.anthropic.claude-sonnet-4-6-v1:0", "Claude-Sonnet-5"]) {
      const logs: Array<Record<string, unknown>> = [];
      const s = await setup({ lessons: "on", answer, learningEnv: glmEnv(learning), offered: offering(MODEL), log: (entry) => { logs.push(entry); } });
      await mergedTask(s, A, MEMBER_A, sentBack);
      await lessonsJob(s.root);
      expect(s.seen, learning).toEqual([]);
      expect(logs, learning).toContainEqual({ event: "core_engine.lessons_learning_not_set_up", companyId: A });
    }
  });

  it("two companies: each learns on the model its own offered list gives, with its own token; a company offered no Claude model makes no call and the other is untouched", async () => {
    const s = await setup({ lessons: `on:${A}:${B}`, answer, learningEnv: glmEnv(), offered: async (companyId) => (companyId === A ? offering(MODEL)() : offering(GLM)()) });
    await mergedTask(s, A, MEMBER_A, sentBack);
    await mergedTask(s, B, MEMBER_B, "Name the route /healthz like the others.");
    await lessonsJob(s.root);
    expect(s.seen.length).toBeGreaterThanOrEqual(1);
    expect(new Set(s.seen.map((seen) => claimsOf(seen.token).cid))).toEqual(new Set([A]));
    expect(JSON.stringify(s.seen)).not.toContain("healthz");
    expect(await pauseOf(s, B)).toMatchObject({ code: "no_suitable_model" });
    expect(await pauseOf(s, A)).toBeUndefined();
  });
});

describe("the root asks for the learning port only where it can be used", () => {
  it("only for a company the lessons switch names: a company outside it never has a port asked for, a named one does", async () => {
    const asked: string[] = [];
    const s = await setup({ lessons: `on:${B}`, custom: (companyId: OrgId) => { asked.push(companyId); return undefined; } });
    await s.root.app.runtimeFor(A);
    expect(asked).toEqual([]);
    await s.root.app.runtimeFor(B);
    expect(asked).toEqual([B]);
  });

  it("a port that throws is no port: the company's lessons still build, learning refuses, and it is said in the log (company id only)", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const s = await setup({ lessons: "on", log: (entry) => { logs.push(entry); }, custom: () => { throw new Error("kms down sk-ant-secret"); } });
    await servedCompany(s, A, MEMBER_A);
    const runtime = await s.root.app.runtimeFor(A);
    expect(runtime.services.lessons).toBeDefined();
    expect(logs.filter((entry) => entry.event === "core_engine.lessons_learning_unavailable")).toEqual([{ event: "core_engine.lessons_learning_unavailable", companyId: A }]);
    expect(JSON.stringify(logs)).not.toContain("sk-ant-secret");
  });

  it("a covered company with no port (no gateway settings) is said in the log, never silent", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const s = await setup({ lessons: "on", gateway: false, log: (entry) => { logs.push(entry); } });
    await servedCompany(s, A, MEMBER_A);
    expect(logs).toContainEqual({ event: "core_engine.lessons_learning_not_set_up", companyId: A });
  });
});

describe("the broker hands the core root the learning port", () => {
  const source = readFileSync(new URL("../../packages/broker/src/aws/broker.ts", import.meta.url), "utf8");
  const call = source.slice(source.indexOf("const coreRoot = createBrokerCoreRoot({"));
  const body = call.slice(0, call.indexOf("builtCoreRoot = coreRoot;"));

  it("passes lessonsLearning built by hostedLessonsLearning over the process environment and the install's own task-token signer", () => {
    expect(body).toMatch(/lessonsLearning:\s*hostedLessonsLearning\(process\.env,\s*\(\) => taskTokensFromEnvironment\(process\.env, new KMSClient\(awsClientConfiguration\)\), \{ log: \(entry\) => console\.log\(JSON\.stringify\(\{ component: "core-engine", \.\.\.entry \}\)\) \}\)/u);
  });
});
