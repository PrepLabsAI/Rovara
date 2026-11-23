import type { DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks.js";
import { createConfiguredModelRuntime } from "../../packages/model-runtime/src/index.js";
import { operationModelProxy } from "../../packages/worker/src/design-review-sessions.js";
// L6 composition contract: real broker root, registry, dispatch host, callbacks, actions and jobs over fake adapters.
// ANSWER-2: the real worker proxy and model runtime carry each broker answer through to a fake gateway transport.
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { IMPLICIT_COMPANY_ID, LEARNED_CONTEXT_FEATURE, ROVARA_CODE_AGENT_ID, WorkflowSnapshotSchema, change, companyScoped, createCandidateManifest, createWorkflowSnapshot, orgProjectCatalogKey, projectRevisionKey, runCostKey, sessionBindingKey, type OrgId, type WorkerMachines, type StoredDocument, type WorkerInvocation } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { createBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { createCoreDispatchHost } from "../../packages/broker/src/aws/worker-machines/core-dispatch-host.js";
import { workspaceCompanyReader } from "../../packages/broker/src/aws/worker-machines/workspace-company.js";
import { taskKey, workspaceKey, operationKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { startTask } from "../../packages/broker/src/core/task-flow/start.js";
import { coreInUseKey } from "../../packages/broker/src/core-host/engine-stamp.js";
import { createFakeWorld } from "../support/core-host-fakes.js";
import { DocumentLessonStore } from "../../packages/broker/src/lessons/document-store.js";
import { lessonRecord } from "../unit/lessons/lesson-helpers.js";
import { createDispatcherLearned } from "../../packages/broker/src/aws/worker-machines/dispatcher-lessons.js";
import { createTeamRecord } from "../../packages/broker/src/team-record/record.js";
import { costPartition } from "../../packages/broker/src/core/cost/ledger.js";
import { recoveryRowKey } from "../../packages/broker/src/core/merge/store.js";
import { blockedReview, code, parserId, report, PARSER, TOKEN, tokenId } from "../support/task-actions-world.js";
import { taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { makeKey, signerOf } from "../unit/policy-hook-fixture.js";
import { createAdminBroker } from "../support/admin-broker.js";
import { createFakeOfferedModels } from "../support/offered-models-fake.js";
import { companyEngineModelKey } from "../../packages/broker/src/core-host/company-engine-model.js";
import type { OfferedModelsReader } from "../../packages/broker/src/core-host/gateway-model-selection.js";
import { runPriceFor } from "../support/hosted-run-price.js";

afterEach(() => { vi.unstubAllGlobals(); });

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", async (original) => ({ ...await original<object>(), codeAdapterModules: () => adapters.modules }));
// Batch b18 (#1041 HW3c): the company-instructions point reads the gateway's rules service when the gateway signs tasks; this two-company run is not about company rules, so its install has no such service (the point stays empty, as before #1041).
vi.mock("../../packages/broker/src/core-host/company-instructions-http.js", async (original) => ({ ...await original<object>(), companyInstructionsModules: () => [] }));
const A: OrgId = "org_aaaaaaaaaaaaaaaaaaaa", B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb", C: OrgId = "org_cccccccccccccccccccc";
const personA = "a".repeat(64), personB = "b".repeat(64), personC = "c".repeat(64);
const SIGNING = "k".repeat(32);
const MODEL = "claude-sonnet-4-6";
const gateway = "https://gateway.example";
const plain = (value: unknown): StoredDocument => JSON.parse(JSON.stringify(value)) as StoredDocument;
const project = { name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "app" }] };

async function world(options: { noSigner?: boolean; offeredModels?: OfferedModelsReader; priceState?: "missing" | "expired" | "wrong-company" | "wrong-model" | "unavailable" } = {}) {
  const w = createFakeWorld();
  w.clock.now = Date.now();
  // Hosted tokens need a company/model-bound price from the signed gateway read.
  // Fake only its transport; unknown companies, models and endpoints stay refused.
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const companyId = [A, B].find(id => url.pathname === `/v1/service/companies/${id}/rate-quote`);
    const model = url.searchParams.get("model");
    if (url.origin !== gateway || companyId === undefined || url.searchParams.get("runPrice") !== "1"
      || (model !== MODEL && model !== "zai.glm-5")) return Response.json({}, { status: 404 });
    if (options.priceState === "unavailable") throw new Error("gateway transport unavailable");
    if (options.priceState === "missing") return Response.json({});
    return Response.json({ runPrice: { ...runPriceFor(model, w.clock.now), companyId, catalogModel: model,
      ...(options.priceState === "expired" ? { expiresAt: w.clock.now } : {}),
      ...(options.priceState === "wrong-company" ? { companyId: B } : {}),
      ...(options.priceState === "wrong-model" ? { model: "foreign" } : {}),
    } });
  });
  adapters.modules = w.modules.filter((module) => ["storage", "queue", "worker-machines", "object-storage", "code-host", "check-runner", "secrets"].includes(module.point));
  const members = new Map([[personA, A], [personB, B], [personC, C]]);
  const client = { async send(command: unknown) {
    if (!(command instanceof GetCommand)) throw new Error("only fake point reads");
    const key = command.input.Key as { pk: string; sk: string };
    if (key.pk.startsWith("COMPANY_MEMBER#")) {
      const personId = key.pk.slice("COMPANY_MEMBER#".length), companyId = members.get(personId);
      return { Item: companyId === undefined ? undefined : { ...key, entityType: "COMPANY_MEMBERSHIP", personId, companyId, role: "member", joinedAt: new Date(w.clock.now).toISOString() } };
    }
    // DEC 254zzz80: each person's "payments" grant sits in their own company's partition (`ORG#<company>#MEMBER#<person>`), as a named company keeps its grants.
    const grant = /^ORG#(org_[0-9a-z]{20})#MEMBER#(.+)$/u.exec(key.pk);
    if (grant !== null) return { Item: members.get(grant[2]!) === grant[1] ? { ...key, projectName: "payments", role: "developer" } : undefined };
    return { Item: await w.store.get(key) };
  } };
  const key = makeKey("t".repeat(16));
  const root = createBrokerCoreRoot({
    // This fixture isolates the existing root behavior; core-task-people-hosted/identity tests exercise creation's real identity proof.
    taskRules: () => ({ taskPeopleStart: async () => [] }) as unknown as DeveloperTaskRouteDependencies,
    env: { ROVARA_CORE_MODEL_GATEWAY_URL: gateway, ROVARA_CORE_AGENT_MODEL: MODEL, ROVARA_CORE_LESSONS: "on" },
    documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: SIGNING, repositoryGrantKey: Buffer.alloc(32, 1),
    repositoryCredential: async () => ({ token: "fake" }), codeModules: () => ({}) as never,
    ...(options.noSigner ? {} : { taskTokens: () => ({ signer: taskKeySigner(signerOf(key)), issuer: "https://api.example/v1/auth" }) }),
    origin: () => "https://api.example", now: () => new Date(w.clock.now), log: () => undefined,
    ...(options.offeredModels === undefined ? {} : { offeredModels: options.offeredModels }),
    ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    lessonsPeople: () => ({ approvers: async () => ({ complete: true, membershipVersion: 1, ownerIds: [], eligibleIds: [], lastEligibleLossAtMs: null }), onProjectRoster: async () => true, linkedAccounts: async () => [], displayName: async () => "Member", isErased: async () => false }),
    services: (companyId, flow, registry, wiring) => createBrokerCoreServices({ companyId, flow, registry, ciMode: wiring.ciMode!, now: () => new Date(w.clock.now) }),
  });
  for (const companyId of [A, B]) {
    await w.store.put({ item: plain({ ...projectRevisionKey(companyId, "payments", 1), definition: project }) });
    await w.store.put({ item: { ...orgProjectCatalogKey(companyId, "payments"), latestRevision: 1 } });
  }
  const caller = (developerId: string) => ({ developerId, sessionId: "session", name: "Member" });
  const start = (developerId: string) => root.coreTasks!.route({ method: "POST", path: "/v1/dev/tasks", headers: {}, body: JSON.stringify({ requestId: randomUUID(), project: "payments", instructions: "Add retry handling" }) }, caller(developerId));
  const dispatch = createCoreDispatchHost({
    companyOfWorkspace: workspaceCompanyReader(client, "state"),
    depsFor: async (companyId, queues) => {
      const flow = (await root.app.runtimeFor(companyId)).flow;
      const source = flow.deps.machines;
      const machines: WorkerMachines & { companyId: OrgId } = {
        companyId, capabilities: source.capabilities,
        start: (spec) => source.start(spec), stop: (id) => source.stop(id), terminate: (id) => source.terminate(id),
        health: (id) => source.health(id), deliver: (id, job) => source.deliver(id, job),
      };
      return { ...flow.deps, machines, queues };
    }, changeVisibility: async () => undefined,
  });
  const dispatchOnce = async () => {
    const queue = await w.queues.queue("task-dispatch");
    const messages = await queue.receive({ maxMessages: 10 });
    const records = messages.map((message) => ({ messageId: message.messageId, receiptHandle: message.receiptHandle, body: JSON.stringify(message.body) }));
    const taken = dispatch.take(records);
    const result = await dispatch.handle(records, taken);
    for (const message of messages) if (!result.failures.includes(message.messageId)) await queue.ack(message.receiptHandle);
    return result;
  };
  const invocation = async (companyId: OrgId, workspaceId: string): Promise<WorkerInvocation> => {
    const workspace = await w.store.get(workspaceKey(companyId, workspaceId));
    const machineId = (workspace?.["machine"] as { machineId: string }).machineId;
    return w.machines.delivered(machineId).at(-1)!;
  };
  const callback = (job: WorkerInvocation, action: string, body: unknown, workspaceId = job.workspaceId) => root.callback({ method: "POST", path: `/v1/internal/workspaces/${workspaceId}/operations/${job.operationId}/${action}`, headers: { "x-agentx-callback-capability": job.callbackCapability }, body: JSON.stringify(body) });
  return { w, root, caller, start, dispatchOnce, invocation, callback, client };
}

// Removing the price check, or running it after the in-use mark/a refusal audit,
// must fail these checks against the real hosted start and its document store.
it.each(["missing", "expired", "wrong-company", "wrong-model", "unavailable"] as const)("refuses a hosted start with %s signed prices before any write or spend", async priceState => {
  const h = await world({ priceState });
  const flow = (await h.root.app.runtimeFor(A)).flow;
  const writes = [vi.spyOn(h.w.store, "put"), vi.spyOn(h.w.store, "update"), vi.spyOn(h.w.store, "delete"), vi.spyOn(h.w.store, "transact")];
  const audit = [vi.spyOn(flow.deps.audit, "record"), vi.spyOn(flow.deps.audit, "stage")];
  const answer = await h.start(personA);
  expect(answer?.statusCode).toBe(503);
  expect(JSON.parse(answer!.body)).toMatchObject({ error: { code: "RUNTIME_UNAVAILABLE", message: expect.stringMatching(/signed.price.*gateway.*ready/iu) as string } });
  for (const write of [...writes, ...audit]) expect(write).not.toHaveBeenCalled();
  expect(await h.w.store.get(coreInUseKey(A))).toBeUndefined();
  expect((await flow.list({ principal: { companyId: A, personId: personA, displayName: "Member", roles: ["member"], provider: "hosted" }, origin: "app" })).tasks).toEqual([]);
  expect(h.w.spend).toEqual([]);
  expect(h.w.machines.answered).toEqual([]);
  expect(await (await h.w.queues.queue("task-dispatch")).receive()).toEqual([]);
});

it.each(["missing", "unavailable"] as const)("refuses unauthorized hosted starts before reading %s gateway readiness or writing", async priceState => {
  const h = await world({ priceState });
  const flow = (await h.root.app.runtimeFor(A)).flow;
  const writes = [vi.spyOn(h.w.store, "put"), vi.spyOn(h.w.store, "delete"), vi.spyOn(h.w.store, "transact")];
  const update = vi.spyOn(h.w.store, "update");
  const record = vi.spyOn(flow.deps.audit, "record");
  const stage = vi.spyOn(flow.deps.audit, "stage");
  const readiness = vi.spyOn(flow.deps, "startModelCheck");
  await expect(startTask(flow.deps, { principal: { companyId: A, personId: personA, displayName: "Member", roles: ["member"], provider: "hosted" }, origin: "app" },
    { requestId: randomUUID(), project: "missing", instructions: "Set up the project" })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("You do not have access to this project.") as string });
  expect(readiness).not.toHaveBeenCalled();
  for (const write of writes) expect(write).not.toHaveBeenCalled();
  expect(record).toHaveBeenCalledTimes(1);
  expect(record.mock.calls[0]?.[0]).toMatchObject({ action: "task.start_refused", details: { code: "FORBIDDEN" } });
  expect(stage).not.toHaveBeenCalled();
  expect(update).toHaveBeenCalledTimes(1);
  expect(update.mock.calls[0]?.[0].key.pk).toBe(`ORG#${A}#AUDIT`);
  expect(await h.w.store.get(coreInUseKey(A))).toBeUndefined();
  expect(h.w.spend).toEqual([]);
  expect(await (await h.w.queues.queue("task-dispatch")).receive()).toEqual([]);
});

it("starts normally when the signed-price gateway becomes ready, without caching a refusal", async () => {
  const state: Parameters<typeof world>[0] = { priceState: "missing" };
  const h = await world(state);
  expect((await h.start(personA))?.statusCode).toBe(503);
  delete state.priceState;
  const answer = await h.start(personA);
  expect(answer?.statusCode, answer?.body).toBe(200);
  const { task: { taskId } } = z.object({ task: z.object({ taskId: z.string() }) }).parse(JSON.parse(answer!.body));
  expect(await h.w.store.get(coreInUseKey(A))).toMatchObject({ orgId: A });
  expect(await h.w.store.get(taskKey(taskId))).toMatchObject({ companyId: A, taskId });
});

it("runs two companies through start, dispatch, callbacks, broker model access, review and one shared merge scan; every company's new task starts on the core", async () => {
  const h = await world();
  const broker = await createAdminBroker({ core: h.root });
  const runs: Array<{ companyId: string; person: string; taskId: string; workspaceId: string; job: WorkerInvocation }> = [];
  for (const [companyId, person] of [[A, personA], [B, personB]] as const) {
    const answer = await h.start(person);
    expect(answer?.statusCode, answer?.body).toBe(200);
    const { task: { taskId } } = z.object({ task: z.object({ taskId: z.string() }) }).parse(JSON.parse(answer!.body));
    const task = (await h.w.store.get(taskKey(taskId)))!;
    const workspaceId = z.string().parse(task["workspaceId"]);
    expect(task["companyId"]).toBe(companyId);
    expect((await h.dispatchOnce()).failures).toEqual([]);
    let job = await h.invocation(companyId, workspaceId);
    expect(job.kind).toBe("prepare");
    expect((await h.callback(job, "result", { status: "SUCCEEDED" }))?.statusCode).toBe(200);
    h.w.machines.finish(((await h.w.store.get(workspaceKey(companyId, workspaceId)))!["machine"] as { machineId: string }).machineId, job.operationId);
    expect((await h.dispatchOnce()).failures).toEqual([]);
    job = await h.invocation(companyId, workspaceId);
    expect(job.kind).toBe("task");
    if (job.kind !== "task") throw new Error("expected a task invocation");
    expect((await h.callback(job, "events", { events: [{ type: "progress", timestamp: new Date(h.w.clock.now).toISOString(), payload: { message: companyId } }] }))?.statusCode).toBe(200);
    // Exercise the AWS broker's GET clause with no user JWT/authorizer. The broker's answer is the contract boundary.
    const get = (query = "") => broker.handler({ version: "2.0", routeKey: "GET /v1/internal/model-access", rawPath: "/v1/internal/model-access", rawQueryString: query, headers: { "x-agentx-callback-capability": job.callbackCapability }, requestContext: { requestId: randomUUID(), http: { method: "GET" } } });
    const access = await get();
    expect(access.statusCode, access.body).toBe(200);
    const body = z.object({ baseUrl: z.string(), apiKey: z.string() }).parse(JSON.parse(access.body));
    expect(body.baseUrl).toBe(gateway);
    const claims: unknown = JSON.parse(Buffer.from(body.apiKey.split(".")[1]!, "base64url").toString());
    expect(claims).toMatchObject({ cid: companyId, ws: workspaceId, op: job.operationId, mdl: [MODEL], runPrice: { companyId, model: MODEL, catalogModel: MODEL } });
    const sent: Array<{ url: string; claims: Record<string, unknown> }> = [];
    const proxy = operationModelProxy({ payload: job.payload, proxyUrl: companyId === A ? "https://old-proxy.example" : undefined, controlPlaneUrl: "https://broker.example", capability: job.callbackCapability,
      fetch: async () => { const answer = await get(); return new Response(answer.body, { status: answer.statusCode }); } });
    const runtime = await createConfiguredModelRuntime({ provider: "anthropic", modelId: MODEL }, { proxy: { ...proxy!, route: job.payload.modelRoute! }, onUsage: () => undefined,
      fetch: async (url, init) => {
        const token = new Headers(init?.headers).get("x-api-key")!;
        const address = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
        sent.push({ url: `${address.origin}${address.pathname}`, claims: z.record(z.string(), z.unknown()).parse(JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString())) });
        return new Response("{}", { status: 400 });
      } });
    await runtime.completeSimple(runtime.getModel("rovara-route", MODEL)!, { messages: [{ role: "user", content: "fake company model call", timestamp: 0 }] });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: `${gateway}/v1/messages`, claims: { cid: companyId, ws: workspaceId, op: job.operationId, mdl: [MODEL] } });
    expect((await get("slot=other-reviewer")).statusCode).toBe(401);
    const operation = (await h.w.store.get(operationKey(companyId, workspaceId, job.operationId)))!;
    await h.w.store.update({ key: operationKey(companyId, workspaceId, job.operationId), ops: [change.set("workflowMode", "REVIEW"), change.set(["dispatch", "payload", "workflowSecondReviewer"], { provider: "anthropic", modelId: MODEL })] });
    expect((await get()).statusCode).toBeGreaterThanOrEqual(400);
    await h.w.store.put({ item: operation });
    runs.push({ companyId, person, taskId, workspaceId, job });
  }
  const [a, b] = runs;
  for (const [own, other] of [[a!, b!], [b!, a!]] as const) {
    await h.root.app.runtimeFor(own.companyId);
    expect((await h.root.coreTasks!.route({ method: "GET", path: `/v1/dev/tasks/${other.taskId}`, headers: {} }, h.caller(own.person)))?.statusCode).toBe(404);
    expect((await h.root.coreTasks!.route({ method: "POST", path: `/v1/dev/tasks/${other.taskId}/continue`, headers: {}, body: "{}" }, h.caller(own.person)))?.statusCode).toBe(404);
    expect((await h.callback(own.job, "events", { events: [] }, other.workspaceId))?.statusCode).toBeGreaterThanOrEqual(400);
    // Fake reviewer evidence is seeded at the review boundary; the owner act and its company checks run on the real root.
    expect((await h.callback(own.job, "result", { status: "SUCCEEDED" }))?.statusCode).toBe(200);
    const task = (await h.w.store.get(taskKey(own.taskId)))!;
    const security = blockedReview({ taskId: own.taskId, ownerId: z.string().parse(task["ownerKey"]) }, [report("CRITIC", "FINDINGS", [PARSER]), report("SECURITY", "FINDINGS", [TOKEN])]);
    await h.w.store.update({ key: taskKey(own.taskId), ops: [change.set("workflow", plain(security))] });
    const refused = await h.root.coreTasks!.route({ method: "POST", path: `/v1/dev/tasks/${own.taskId}/workflow/review-findings`, headers: {}, body: JSON.stringify({ requestId: randomUUID(), expectedRevision: 6, candidateDigest: code.digest, resolutions: [{ findingId: parserId, action: "FIX", note: "Fix this" }, { findingId: tokenId, action: "ACCEPT", note: "Accept this" }] }) }, h.caller(own.person));
    expect(refused?.statusCode).toBe(403);
    expect(refused?.body).toContain("Rovara web page");
    expect((await h.w.store.get(taskKey(own.taskId)))?.["workflow"]).toEqual(plain(security));
    const workflow = blockedReview({ taskId: own.taskId, ownerId: z.string().parse(task["ownerKey"]) });
    await h.w.store.update({ key: taskKey(own.taskId), ops: [change.set("workflow", plain(workflow))] });
    const accepted = await h.root.coreTasks!.route({ method: "POST", path: `/v1/dev/tasks/${own.taskId}/workflow/review-findings`, headers: {}, body: JSON.stringify({ requestId: randomUUID(), expectedRevision: 6, candidateDigest: code.digest, resolutions: [{ findingId: parserId, action: "ACCEPT", note: "Reviewed on the fixture" }] }) }, h.caller(own.person));
    expect(accepted?.statusCode, accepted?.body).toBe(200);
    expect(((await h.w.store.get(taskKey(own.taskId)))!["workflow"] as { acceptedFindings: unknown[] }).acceptedFindings).toHaveLength(1);
    // Same lesson source id and query across both companies; each runtime's search sees only its own record.
    await createTeamRecord({ store: h.w.store, companyId: own.companyId, now: () => h.w.clock.now }).put({ project: "payments", taskId: own.taskId, authorId: own.person, kind: "decision", text: `shared query ${own.companyId}`, sourceRef: "same-source", occurredAt: new Date(h.w.clock.now).toISOString() });
    const due = { pk: companyScoped(own.companyId, "TIER_CHECKS_DUE"), sk: `TASK#${own.taskId}` };
    await h.w.store.put({ item: { ...due, taskId: own.taskId, companyId: own.companyId, lastRunAt: 0 } });
    // A poisoned foreign row in this partition must be filtered before its task is touched.
    await h.w.store.put({ item: { pk: due.pk, sk: `TASK#${other.taskId}`, taskId: other.taskId, companyId: other.companyId, lastRunAt: 0 } });
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "c".repeat(40) }]);
    const waiting = WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId: own.taskId, ownerId: z.string().parse(task["ownerKey"]), now: new Date(h.w.clock.now).toISOString() }), stage: "WAIT_FOR_MERGE", state: "WAITING", candidate, verification: { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: new Date(h.w.clock.now).toISOString(), results: [{ checkId: "unit", status: "PASS" }] }, reviews: [report("CRITIC", "PASS", [], candidate.digest), report("SECURITY", "PASS", [], candidate.digest)], pullRequests: [{ repositoryId: "demo", number: 1, headSha: "a".repeat(40), candidateDigest: candidate.digest, required: true, state: "OPEN", url: "https://github.com/example/demo/pull/1" }] });
    await h.w.store.update({ key: taskKey(own.taskId), ops: [change.set("workflow", plain(waiting))] });
    await h.w.store.put({ item: { ...recoveryRowKey(own.taskId), taskId: own.taskId, kind: "tracking", nextAttemptAt: 0 } });
  }
  for (const [own, other] of [[a!, b!], [b!, a!]] as const) {
    const record = createTeamRecord({ store: h.w.store, companyId: own.companyId, now: () => h.w.clock.now });
    const hits = await record.search("payments", "shared query", 10);
    expect(hits.some((hit) => hit.row.text.includes(own.companyId))).toBe(true);
    expect(hits.some((hit) => hit.row.text.includes(other.companyId))).toBe(false);
    const lessons = new DocumentLessonStore(h.w.store, () => h.w.clock.now);
    const lesson = lessonRecord({ id: "les_shared1111", workspaceId: own.companyId, project: "payments", title: `Advice ${own.companyId}`, tier: 1,
      // Batch 17 (rule F): #998's one absolute fit floor loads a lesson for a step only when it fits the task ("Add retry handling") by its own words.
      description: "Add retry handling with the shared helper.", body: "Add retry handling with the shared helper, not a hand-written loop.",
      approvals: [{ approvalId: "approved", by: own.person, at: 1, mode: "one" }], citations: [], citationChecks: [], scope: {}, stages: ["PLAN"], expiresAt: h.w.clock.now + 86_400_000,
      provenance: { ...lessonRecord().provenance, supportTasks: [] } });
    expect((await lessons.commit({ workspaceId: own.companyId, project: "payments" }, 0, [lesson], h.w.clock.now)).ok).toBe(true);
    const learned = createDispatcherLearned({ companyId: own.companyId, lessonsSwitch: { mode: "on" }, documentClient: h.client, tableName: "state", store: h.w.store, now: () => h.w.clock.now,
      people: { approvers: async () => ({ complete: true, membershipVersion: 1, ownerIds: [own.person], eligibleIds: [own.person], lastEligibleLossAtMs: null }), onProjectRoster: async (company) => company === own.companyId, linkedAccounts: async () => [], displayName: async () => "Member", isErased: async () => false } });
    const input = { workspaceId: own.workspaceId, operationId: own.job.operationId, workflowMode: "PLAN", features: [LEARNED_CONTEXT_FEATURE], companyId: other.companyId };
    const loaded = await learned(input);
    expect(loaded.learnedContext?.lessons.map((lesson) => lesson.title)).toEqual([`Advice ${own.companyId}`]);
    await expect(learned({ ...input, workspaceId: other.workspaceId })).rejects.toThrow();
  }
  // Identical outbox ids in each company are staged together. Relaying A cannot consume B's pending row.
  for (const own of runs) {
    const flow = (await h.root.app.runtimeFor(own.companyId)).flow;
    expect((await h.w.store.transact([flow.deps.outbox.stage({ companyId: own.companyId, id: "same-raw-id", queue: "contract-outbox", body: { companyId: own.companyId } })])).applied).toBe(true);
  }
  await (await h.root.app.runtimeFor(A)).flow.relayOnce();
  expect((await h.w.store.get({ pk: companyScoped(B, "OUTBOX#same-raw-id"), sk: "OUTBOX" }))?.["status"]).toBe("PENDING");
  const outboxQueue = await h.w.queues.queue("contract-outbox");
  const sentA = await outboxQueue.receive();
  expect(sentA.map((message) => message.body)).toEqual([{ companyId: A }]);
  for (const message of sentA) await outboxQueue.ack(message.receiptHandle);
  await (await h.root.app.runtimeFor(B)).flow.relayOnce();
  expect((await outboxQueue.receive()).map((message) => message.body)).toEqual([{ companyId: B }]);
  const foreignId = randomUUID();
  await h.w.store.put({ item: { ...taskKey(foreignId), taskId: foreignId, companyId: C } });
  const foreignRow = { ...recoveryRowKey(foreignId), taskId: foreignId, kind: "tracking", nextAttemptAt: 0 };
  await h.w.store.put({ item: foreignRow });
  const query = vi.spyOn(h.w.store, "query");
  const jobReport = await h.root.handleEvent({ source: "agentx.core-job", job: "merge-tracking" }) as { companies: Array<{ companyId: string; outcome: string; report: { attempted: number } }> };
  expect(jobReport.companies.map((entry) => [entry.companyId, entry.outcome, entry.report?.attempted])).toEqual([[IMPLICIT_COMPANY_ID, "ran", 0], [A, "ran", 1], [B, "ran", 1]]);
  expect(query.mock.calls.filter(([input]) => input.pk === "WORKFLOW_MERGE_RECOVERY")).toHaveLength(1);
  expect(await h.w.store.get(recoveryRowKey(foreignId))).toEqual(foreignRow);
  for (const companyId of [A, B]) expect(query.mock.calls.find(([input]) => input.pk === companyScoped(companyId, "TIER_CHECKS_DUE"))?.[0].filter).toEqual({ op: "eq", path: ["companyId"], value: companyId });
  // #1275: no switch, so C's new tasks start on the core too.
  expect(h.root.app.engineForNewTask(C)).toBe("core");
});

it("refuses the entire company's runtime when the gateway has no task signer", async () => {
  const h = await world({ noSigner: true });
  await expect(h.root.app.runtimeFor(A)).rejects.toMatchObject({ name: "GatewayTaskTokensMissing" });
  expect((await h.w.store.query({ pk: `ORG#${A}#TASKS` })).items).toEqual([]);
});

it("wires hosted close cost, session bindings and after-merge independently for each company", async () => {
  const h = await world();
  const sessionId = "ses_11111111111111111111";
  const closedAt = "2026-11-18T12:00:00.000Z";
  for (const companyId of [A, B]) {
    const issueId = companyId === A ? "LIN-A" : "LIN-B";
    await h.w.store.put({ item: { ...sessionBindingKey(companyId, sessionId, "linear_issue"), entityType: "AGENT_SESSION_BINDING", orgId: companyId, sessionId, binding: { kind: "linear_issue", issueId, url: `https://linear.app/acme/issue/${issueId}` } } });
    const taskId = randomUUID();
    await h.w.store.put({ item: { ...taskKey(taskId), taskId, companyId, project: "payments" } });
    await h.w.store.put({ item: { pk: costPartition(companyId, taskId), sk: "TOTAL", taskId, currency: "USD", micros: 2_500_000, unpricedEntries: 0 } });
    const runtime = await h.root.app.runtimeFor(companyId);
    expect(runtime.services["after-merge"]).toMatchObject({ companyId });
    expect(await runtime.flow.deps.sessionBindings!.read(companyId, sessionId)).toMatchObject([{ kind: "linear_issue", issueId }]);
    await runtime.flow.deps.onTaskClosed!({ taskId, companyId, project: "payments", workflow: { path: "FULL" } } as never, closedAt);
    expect(await h.w.store.get(runCostKey(companyId, "payments", ROVARA_CODE_AGENT_ID, "FULL", closedAt, taskId))).toMatchObject({ entityType: "RUN_COST", orgId: companyId, costUsd: 2.5 });
  }
  const a = await h.root.app.runtimeFor(A);
  const b = await h.root.app.runtimeFor(B);
  expect(await a.flow.deps.sessionBindings!.read(A, sessionId)).toMatchObject([{ issueId: "LIN-A" }]);
  expect(await a.flow.deps.sessionBindings!.read(B, sessionId)).toMatchObject([{ issueId: "LIN-A" }]);
  expect(a.services["after-merge"]).not.toBe(b.services["after-merge"]);
});

it("applies FR-018 from the company's catalog and reads the broker's live workspace setting before every start", async () => {
  const h = await world();
  const revision = projectRevisionKey(A, "payments", 1);
  await h.w.store.put({ item: plain({ ...revision, definition: { ...project, developerTasks: { enabled: false } } }) });
  const disabled = await h.start(personA);
  expect(disabled?.statusCode).toBe(403);
  expect(disabled?.body).toContain("tasks from AI tools are turned off");
  await h.w.store.put({ item: plain({ ...revision, definition: project }) });
  await h.w.store.put({ item: { pk: "SETTINGS", sk: "WORKSPACE_LIMITS", perPerson: 1, perOrganization: 2 } });
  expect((await h.start(personA))?.statusCode).toBe(200);
  const full = await h.start(personA);
  expect(full?.body).toContain("WORKSPACE_LIMIT");
  await h.w.store.put({ item: { pk: "SETTINGS", sk: "WORKSPACE_LIMITS", perPerson: 2, perOrganization: 3 } });
  expect((await h.start(personA))?.statusCode).toBe(200);
  // B's identical project name has its own enabled policy and workspace counters.
  expect((await h.start(personB))?.statusCode).toBe(200);
});

it("DEC 254n (1): A's own engine model is A's step route and A's task token model; B keeps the install default; A's start is refused before anything once the gateway stops offering it", async () => {
  const offered = createFakeOfferedModels();
  offered.set(A, [MODEL, "zai.glm-5"]);
  offered.set(B, [MODEL]);
  const h = await world({ offeredModels: offered });
  const broker = await createAdminBroker({ core: h.root });
  await h.w.store.put({ item: { ...companyEngineModelKey(A), entityType: "COMPANY_ENGINE_MODEL", orgId: A, version: 1, model: "zai.glm-5", updatedAt: new Date(h.w.clock.now).toISOString(), updatedBy: personA } });
  for (const [companyId, person, model] of [[A, personA, "zai.glm-5"], [B, personB, MODEL]] as const) {
    const answer = await h.start(person);
    expect(answer?.statusCode, answer?.body).toBe(200);
    const { task: { taskId } } = z.object({ task: z.object({ taskId: z.string() }) }).parse(JSON.parse(answer!.body));
    const workspaceId = z.string().parse((await h.w.store.get(taskKey(taskId)))!["workspaceId"]);
    expect((await h.dispatchOnce()).failures).toEqual([]);
    let job = await h.invocation(companyId, workspaceId);
    expect((await h.callback(job, "result", { status: "SUCCEEDED" }))?.statusCode).toBe(200);
    h.w.machines.finish(((await h.w.store.get(workspaceKey(companyId, workspaceId)))!["machine"] as { machineId: string }).machineId, job.operationId);
    expect((await h.dispatchOnce()).failures).toEqual([]);
    job = await h.invocation(companyId, workspaceId);
    if (job.kind !== "task") throw new Error("expected a task invocation");
    expect(job.payload.modelRoute).toEqual({ alias: model, api: "anthropic-messages", catalog: model });
    const access = await broker.handler({ version: "2.0", routeKey: "GET /v1/internal/model-access", rawPath: "/v1/internal/model-access", rawQueryString: "", headers: { "x-agentx-callback-capability": job.callbackCapability }, requestContext: { requestId: randomUUID(), http: { method: "GET" } } });
    expect(access.statusCode, access.body).toBe(200);
    const body = z.object({ apiKey: z.string() }).parse(JSON.parse(access.body));
    expect(JSON.parse(Buffer.from(body.apiKey.split(".")[1]!, "base64url").toString())).toMatchObject({ cid: companyId, mdl: [model], runPrice: { companyId, model, catalogModel: model } });
  }
  // B has no model of its own: the gateway was asked only for A, at A's start.
  expect(offered.asked).toEqual([A]);
  // The gateway no longer offers A's model: A's next start is refused before anything is written or queued; B still starts.
  offered.set(A, [MODEL]);
  const tasksBefore = (await h.w.store.query({ pk: `ORG#${A}#TASKS` })).items.length;
  const refused = await h.start(personA);
  expect(refused?.statusCode).toBe(400);
  expect(refused?.body).toContain("Pick another model in Company settings, AI and spending.");
  expect(refused?.body).not.toContain("glm");
  expect((await h.w.store.query({ pk: `ORG#${A}#TASKS` })).items).toHaveLength(tasksBefore);
  expect((await (await h.w.queues.queue("task-dispatch")).receive({ maxMessages: 10 }))).toEqual([]);
  expect((await h.start(personB))?.statusCode).toBe(200);
  // The list cannot be read: refused with the fixed reason, never started on a guess.
  offered.fail(true);
  const unchecked = await h.start(personA);
  expect(unchecked?.statusCode).toBe(503);
  expect(unchecked?.body).toContain("couldn't be checked just now");
});
