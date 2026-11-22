import { signedRunPriceResponse } from "../support/signed-run-price-fetch.js";
// Lead 4 L4-HW2: the hosted lessons job and the learning port are what the broker hands the core root. The root, registry, runtime, lessons and the hosted people port are real; only the deployment's adapters
// (the fake world) and the model gateway (an injected fetch) are stand-ins.
//   (a) `lessons.service` is returned from the company's services, so the 5-minute `lessons` schedule runs the pass: the reflection queue pump, milestones.deliverDue() retries, the nightly upkeep.
//   (b) the learning model is the gateway's learning route on the company's own account: no gateway, no token, no call; a company the gateway has no allowance for learns nothing and spends nothing.
import { randomUUID } from "node:crypto";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { CORE_LEARNING_MODEL_DEFAULT, CORE_LEARNING_MODEL_VARIABLE, codeMilestoneKey, companyScoped, orgProjectCatalogKey, projectRevisionKey, queryAll, type CodeMilestone, type JsonValue, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { createHostedLessonsPeople } from "../../packages/broker/src/aws/hosted-lessons-people.js";
import { CORE_AGENT_MODEL_VARIABLE, CORE_MODEL_GATEWAY_URL_VARIABLE, taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { hostedLessonsLearning } from "../../packages/broker/src/core-host/hosted-learning.js";
import { COMPANY_LEARNING_MODEL_ENTITY, companyLearningModelKey } from "../../packages/broker/src/core-host/company-learning-model.js";
import { LEARNING_MESSAGES_PATH } from "../../packages/broker/src/lessons/gateway-learning.js";
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

async function setup(options: { lessons?: string; gateway?: boolean; answer?: (n: number, seen: Seen) => Response | Promise<Response>; learning?: boolean; custom?: (companyId: OrgId) => unknown; log?: (entry: Record<string, unknown>) => void; learningEnv?: NodeJS.ProcessEnv } = {}) {
  const world = createFakeWorld();
  adapters.modules = world.modules;
  const rows = new Map<string, Record<string, unknown>>();
  const member = (personId: string, companyId: OrgId) => {
    rows.set(`signin|COMPANY_MEMBER#${personId}|COMPANY`, { pk: `COMPANY_MEMBER#${personId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId, companyId, role: "member", joinedAt: "2026-10-01T00:00:00.000Z" });
    rows.set(`signin|${companyScoped(companyId, "MEMBERS")}|MEMBER#${personId}`, { pk: companyScoped(companyId, "MEMBERS"), sk: `MEMBER#${personId}`, entityType: "COMPANY_MEMBER_VIEW", personId, companyId, role: "member", joinedAt: "2026-10-01T00:00:00.000Z" });
    // DEC 254zzz80: the grant sits in the member's own company's partition.
    rows.set(`state|ORG#${companyId}#MEMBER#${personId}|PROJECT#payments`, { pk: `ORG#${companyId}#MEMBER#${personId}`, sk: "PROJECT#payments", projectName: "payments", role: "developer" });
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
    const quote = signedRunPriceResponse(String(url), [A, B], [MODEL, CORE_LEARNING_MODEL_DEFAULT, "claude-haiku-4-5"], world.clock.now, GATEWAY);
    if (quote !== undefined) {
      const body = await quote.json() as { runPrice: object };
      return Response.json({ runPrice: { ...body.runPrice, inputUsdPerMillion: 1, outputUsdPerMillion: 1, cacheWriteUsdPerMillion: 1, cacheReadUsdPerMillion: 1 } });
    }
    const entry: Seen = { url: String(url), token: (init?.headers as Record<string, string>)["x-api-key"]!, body: JSON.parse(init?.body as string) as Seen["body"] };
    seen.push(entry);
    return await (options.answer ?? (() => new Response(JSON.stringify({ model: MODEL, content: [{ type: "text", text: reply() }] }), { status: 200, headers: { "content-type": "application/json" } })))(seen.length - 1, entry);
  }) as unknown as typeof fetch;
  const root = createBrokerCoreRoot({
    env: { ...(options.lessons === undefined ? {} : { ROVARA_CORE_LESSONS: options.lessons }) },
    documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: secret.toString(), repositoryGrantKey: secret,
    codeModules: () => ({}) as never, repositoryCredential: async () => { throw new Error("unused"); }, origin: () => "https://api.example", log: options.log ?? (() => undefined),
    now: () => new Date(world.clock.now), ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: () => Object.fromEntries(["merge-tracking", "session-sweep", "notify-deliver", "admission-hold-sweep"].map((name) => [name, { pass: async () => ({}) }])),
    lessonsPeople: createHostedLessonsPeople({ documentClient: client, stateTableName: "state", signInTableName: "signin", now: () => world.clock.now }),
    ...(options.custom !== undefined ? { lessonsLearning: options.custom as NonNullable<Parameters<typeof createBrokerCoreRoot>[0]["lessonsLearning"]> } : options.learning === false ? {} : { lessonsLearning: hostedLessonsLearning(options.gateway === false ? {} : options.learningEnv ?? GATEWAY_ENV, () => ({ signer: taskKeySigner(bareKey()), issuer: ISSUER }), { fetch: fetchImpl, now: () => world.clock.now, timeoutMs: 1_000 }) }),
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
});

// DEC 254zzz58/63: learning has its OWN model: the company's choice (read from its own core store), else the install's, else Claude Haiku 5.5. Staging runs its agents on zai.glm-5
// (not a Claude model); before, that switched learning off (`lessons_learning_not_set_up`) and nothing was learned.
describe("(c) the learning model is its own, never the agent model", () => {
  const sentBack = "Use the shared retry helper withRetry, not a hand-written loop.";
  const GLM = "zai.glm-5";
  const answer = () => new Response(JSON.stringify({ model: MODEL, content: [{ type: "text", text: reply(candidateJson({ citations: [], scope: {}, evidenceSpanIds: ["S1"] })) }] }), { status: 200, headers: { "content-type": "application/json" } });
  const glmEnv = (learning?: string): NodeJS.ProcessEnv => ({ [CORE_MODEL_GATEWAY_URL_VARIABLE]: GATEWAY, [CORE_AGENT_MODEL_VARIABLE]: GLM, ...(learning === undefined ? {} : { [CORE_LEARNING_MODEL_VARIABLE]: learning }) });
  const choose = async (s: Setup, companyId: OrgId, model: string) => s.world.store.put({ item: { ...companyLearningModelKey(companyId), entityType: COMPANY_LEARNING_MODEL_ENTITY, orgId: companyId, version: 1, model, updatedAt: "2026-11-18T00:00:00.000Z", updatedBy: MEMBER_A } });
  const models = (s: Setup) => s.seen.map((seen) => [claimsOf(seen.token).cid, claimsOf(seen.token).mdl, (seen.body as { model?: string }).model]);

  it("two companies: each learns on its own choice (or the default) with its own token, and one company's choice never reaches the other", async () => {
    const s = await setup({ lessons: `on:${A}:${B}`, answer, learningEnv: glmEnv() });
    await choose(s, A, "claude-haiku-4-5");
    await mergedTask(s, A, MEMBER_A, sentBack);
    await mergedTask(s, B, MEMBER_B, "Name the route /healthz like the others.");
    await lessonsJob(s.root);
    const seen = new Set(models(s).map(String));
    expect(seen).toEqual(new Set([String([A, ["claude-haiku-4-5"], "claude-haiku-4-5"]), String([B, [CORE_LEARNING_MODEL_DEFAULT], CORE_LEARNING_MODEL_DEFAULT])]));
  });
});

describe("the root asks for the learning port only where it can be used", () => {

  it("a port that throws is no port: the company's lessons still build, learning refuses, and it is said in the log (company id only)", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const s = await setup({ lessons: "on", log: (entry) => { logs.push(entry); }, custom: () => { throw new Error("kms down sk-ant-secret"); } });
    await servedCompany(s, A, MEMBER_A);
    const runtime = await s.root.app.runtimeFor(A);
    expect(runtime.services.lessons).toBeDefined();
    expect(logs.filter((entry) => entry.event === "core_engine.lessons_learning_unavailable")).toEqual([{ event: "core_engine.lessons_learning_unavailable", companyId: A }]);
    expect(JSON.stringify(logs)).not.toContain("sk-ant-secret");
  });
});
