// L4-EVH (DEC 254zzz20 D5): how a claimed health run reaches a worker and comes back. The run is a read-only, pinned preparation of the project's main heads carrying `evalHealth`; its plan and grant, its model
// access and its one result are answered only to that preparation, under that request and claim, while the claim lives. Real task flow, real callback layer, real approval and plan: only the worker, the gateway's
// signer and the reservation adapter are stand-ins. Every guard has a named mutant in briefs/lead4/L4-EVH-MUTANTS-20261118.md.
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EVAL_HEALTH_RESULT_MAX_BYTES, EVAL_HEALTH_RESULT_PATH, EVAL_HEALTH_RUN_MAX_MS, EVAL_PLAN_DELIVERY_ACTION, EvalPlanDeliverySchema, PREPARE_EVAL_HEALTH_FEATURE, WORKER_INVOCATION_FEATURES,
  WorkerInvocationSchema, type EvalBaseRecord, type EvalReservationAdapter, type ProjectDefinition,
} from "@agentx/contracts";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { createCallbackHandler } from "../../packages/broker/src/services/callbacks.js";
import { gatewayForCallbacks, gatewayModelAccessFromEnvironment, taskKeySigner, CORE_MODEL_GATEWAY_URL_VARIABLE, CORE_AGENT_MODEL_VARIABLE } from "../../packages/broker/src/core-host/gateway-model-access.js";
import type { TokenSigner } from "../../packages/broker/src/developer/tokens.js";
import { createEvalPlanSources } from "../../packages/broker/src/core/setup-agent/eval-plan-source.js";
import { launchEvalHealthRun } from "../../packages/broker/src/core/setup-agent/eval-health-launch.js";
import { readEvalHealthRow, requestEvalHealthCheck } from "../../packages/broker/src/core/setup-agent/eval-health-request.js";
import { recordEvalHealthResult, startEvalHealthRun, type EvalHealthRunDeps } from "../../packages/broker/src/core/setup-agent/eval-health-run.js";
import { operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { A, CAP, ROLES, filesOf, company, person, project, reportOf } from "../support/eval-card-world.js";
import { SIGNING_KEY, createHarness } from "../support/task-flow-harness.js";

const HEAD = "a".repeat(40);
const GATEWAY = "https://gateway.example.test";
const definition: ProjectDefinition = { name: project, revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "host-app" }], setup: [], readiness: [], orchestratorInstructions: "x" };
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = pair.publicKey.export({ type: "spki", format: "der" });
const exported = pair.publicKey.export({ format: "jwk" }) as { n: string; e: string };
const signer: TokenSigner = {
  publicJwk: async () => ({ kty: "RSA", n: exported.n, e: exported.e, kid: createHash("sha256").update(der).digest("base64url").slice(0, 16), alg: "RS256", use: "sig" }),
  sign: async (input) => sign("sha256", input, pair.privateKey),
};
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;

async function world(options: { definitionOver?: Partial<ProjectDefinition>; features?: readonly string[] } = {}) {
  const h = createHarness({ companyId: A, understandFirst: false, machines: { startingChecks: 0, features: [...(options.features ?? WORKER_INVOCATION_FEATURES)] },
    extra: () => ({ modelAccess: { route: async () => ({ alias: "claude-sonnet-4-5", api: "anthropic-messages" as const, catalog: "claude-sonnet-4-5" }) }, evalGatewayUrl: GATEWAY }) });
  await h.registerProject({ ...definition, ...options.definitionOver });
  const w = company(A, { ...ROLES }, h.store);
  await (await w.run(filesOf(2), reportOf(2))).approve();
  const adapter: EvalReservationAdapter = {
    async authority(request) { return { company: request.company, project: request.project, principal: { companyId: request.company, personId: request.approver.personId, provider: request.approver.provider, displayName: "", roles: [] }, provider: "customer", connected: true }; },
    async reserve() { return undefined; },
  };
  const registry = { names: (point: string) => point === "eval-reservation" ? ["test"] : [], get: () => adapter } as never;
  const audits: string[] = [];
  const launches: boolean[] = [];
  const deps = (over: Partial<EvalHealthRunDeps> = {}): EvalHealthRunDeps => ({
    store: h.store, companyId: A, now: () => h.clock.now, members: w.members, registry, monthlyCap: async () => CAP,
    mainHeads: async () => [{ repositoryId: "web", baseCommitSha: HEAD }],
    launch: async (job) => { const row = await readEvalHealthRow({ store: h.store, companyId: A }, job.project); const ok = await launchEvalHealthRun(h.deps, { ...job, owner: row!.requestedBy.personId }); launches.push(ok); return ok; },
    audit: async (event) => { audits.push(event.action); }, ...over,
  });
  const ask = () => requestEvalHealthCheck({ store: h.store, companyId: A, now: () => h.clock.now, members: w.members }, project, { requestId: randomUUID(), seenCostMicros: 600_000 }, person(A, "maintainer"));
  const capabilities = new CallbackCapabilities(SIGNING_KEY);
  /** A yes, a claim and the run's own preparation, as the dispatcher would hold it. */
  async function started(running = true) {
    await ask();
    const outcome = await startEvalHealthRun(deps(), project);
    if (outcome.outcome !== "started") throw new Error(`not started: ${JSON.stringify(outcome)}`);
    const [message] = await (await h.queues.queue("task-dispatch")).receive();
    const { workspaceId, operationId } = message!.body as { workspaceId: string; operationId: string };
    // The worker reports the preparation running before it calls back.
    if (running) { const key = operationKey(A, workspaceId, operationId); await h.store.put({ item: { ...(await h.store.get(key))!, status: "RUNNING" } }); }
    return { ...outcome, workspaceId, operationId };
  }
  const token = (run: { workspaceId: string; operationId: string }, actions: string[] = [EVAL_PLAN_DELIVERY_ACTION, EVAL_HEALTH_RESULT_PATH, "model-access"], over: { fence?: number } = {}) =>
    capabilities.issue({ workspaceId: run.workspaceId, operationId: run.operationId, fence: over.fence ?? 1, actions: actions as never, expiresInSeconds: 600 });
  const settings = gatewayModelAccessFromEnvironment({ [CORE_MODEL_GATEWAY_URL_VARIABLE]: GATEWAY, [CORE_AGENT_MODEL_VARIABLE]: "claude-sonnet-4-5" })!;
  const gateway = gatewayForCallbacks(settings, { issuer: "https://api.example.test/v1/auth", signer: taskKeySigner(signer), describer: { describe: async () => undefined } });
  const handler = (over: { companyId?: string; evalHealth?: EvalHealthRunDeps | undefined; evalPlan?: boolean } = {}) => createCallbackHandler({
    flow: { store: h.store, companyId: over.companyId ?? A, callbackSigningKey: SIGNING_KEY, now: h.deps.now, modelAccess: h.deps.modelAccess } as never, blobs: {} as never, grants: {} as never, modelGateway: gateway,
    ...(over.evalPlan === false ? {} : { evalPlan: createEvalPlanSources({ store: h.store, companyId: A, registry, members: w.members }) }),
    ...("evalHealth" in over ? (over.evalHealth === undefined ? {} : { evalHealth: over.evalHealth }) : { evalHealth: deps() }),
  });
  const post = (run: { workspaceId: string; operationId: string }, action: string, capability: string | undefined, body: unknown = {}, h2 = handler()) => h2({ method: "POST", path: `/v1/internal/workspaces/${run.workspaceId}/operations/${run.operationId}/${action}`,
    headers: capability === undefined ? {} : { "x-agentx-callback-capability": capability }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const modelAccess = (capability: string | undefined, h2 = handler()) => h2({ method: "GET", path: "/v1/internal/model-access", headers: capability === undefined ? {} : { "x-agentx-callback-capability": capability } });
  return { h, w, deps, ask, started, token, handler, post, modelAccess, audits, launches, registry };
}
type World = Awaited<ReturnType<typeof world>>;
/** Dispatches the run's preparation (machine start included) and reads the workspace after. */
async function dispatched(w: World, run: { workspaceId: string }, rounds = 8) {
  for (let round = 0; round < rounds; round++) {
    await w.h.flow.dispatchOnce({ maxMessages: 10 }); w.h.clock.advance(70);
    const ws = (await readWorkspace(w.h.deps, run.workspaceId))!;
    if (ws.machine !== undefined && w.h.machines.delivered(ws.machine.machineId).length > 0) return ws;
  }
  return (await readWorkspace(w.h.deps, run.workspaceId))!;
}
const json = (reply: { body?: string }) => JSON.parse(reply.body ?? "{}") as Record<string, unknown>;
const record = (ids: string[] = ["q1", "q2"]): EvalBaseRecord => ({ schemaVersion: 1, runnerSchemaVersion: 1, roundKind: "check_unsealed", recordedOn: "2026-11-18", caseCount: ids.length,
  measures: [{ name: "pass", unit: "fraction", value: 0.5, direction: "up_good" }], questions: ids.map(id => ({ id, samples: [{ pass: true, answer: "a" }, { pass: true, answer: "a" }, { pass: false, answer: "b" }] })) });
const resultBody = (run: { requestId: string; claimId: string }, over: Record<string, unknown> = {}) => ({ requestId: run.requestId, claimId: run.claimId, result: { status: "measured", record: record() }, ...over });

describe("the run's own preparation", () => {
  it("is a read-only preparation pinned to every repository's main head, on a workspace in no list, carrying the claim and asking for nothing else", async () => {
    const w = await world(); const run = await w.started(false);
    expect(w.launches).toEqual([true]);
    const workspace = (await w.h.store.get(workspaceKey(A, run.workspaceId))) as Record<string, unknown>;
    expect(workspace).toMatchObject({ status: "PREPARING", projectName: project, activeOperationId: run.operationId, fence: 1 });
    expect(workspace["workspaceProject"]).toBeUndefined();
    const operation = (await w.h.store.get(operationKey(A, run.workspaceId, run.operationId))) as unknown as { kind: string; status: string; dispatch: { payload: Record<string, unknown>; extraActions: string[]; requires: string[] } };
    expect(operation).toMatchObject({ kind: "prepare", status: "ACCEPTED" });
    expect(operation.dispatch).toMatchObject({ extraActions: [EVAL_PLAN_DELIVERY_ACTION, EVAL_HEALTH_RESULT_PATH], requires: [PREPARE_EVAL_HEALTH_FEATURE] });
    expect(operation.dispatch.payload).toEqual({ readOnly: true, pins: [{ repository: "web", commit: HEAD }], evalHealth: { requestId: run.requestId, claimId: run.claimId } });
    expect(JSON.stringify(operation)).not.toMatch(/token|secret|password/iu);
  });
  it("is delivered to a worker that lists the feature, with the gateway's address and a capability for exactly its three actions; a worker without the feature is never sent it", async () => {
    const w = await world(); const run = await w.started(false);
    const ws = await dispatched(w, run);
    const delivered = w.h.machines.delivered(ws.machine!.machineId).find(entry => entry.operationId === run.operationId)! as unknown as Record<string, unknown> & { payload: Record<string, unknown>; callbackCapability: string };
    expect(WorkerInvocationSchema.safeParse(delivered).success).toBe(true);
    expect(delivered.payload).toMatchObject({ readOnly: true, evalHealth: { requestId: run.requestId, claimId: run.claimId }, evalGatewayUrl: GATEWAY });
    expect(delivered.payload["modelRoute"]).toBeUndefined();
    const capability = new CallbackCapabilities(SIGNING_KEY).verify(delivered.callbackCapability, "model-access");
    expect([...capability.actions].sort()).toEqual(["artifacts", "eval-health-result", "eval-plan", "events", "heartbeat", "model-access", "result"].filter(a => capability.actions.includes(a as never)).sort());
    expect(capability.actions).toEqual(expect.arrayContaining([EVAL_PLAN_DELIVERY_ACTION, EVAL_HEALTH_RESULT_PATH, "model-access"]));
    // A worker that does not list the feature is not sent the run.
    const old = await world({ features: WORKER_INVOCATION_FEATURES.filter(f => f !== PREPARE_EVAL_HEALTH_FEATURE) });
    const oldRun = await old.started(false);
    const oldWorkspace = await dispatched(old, oldRun, 3);
    expect(oldWorkspace.machine === undefined ? [] : old.h.machines.delivered(oldWorkspace.machine.machineId).filter(entry => entry.operationId === oldRun.operationId)).toEqual([]);
  });
  it("is closed, with its machine, when its preparation ends, whether it succeeded or failed: a finished health run keeps nothing running", async () => {
    for (const status of ["SUCCEEDED", "FAILED"] as const) {
      const w = await world(); const run = await w.started(false);
      const ws = await dispatched(w, run);
      expect(ws.machine).toBeDefined();
      const job = w.h.machines.delivered(ws.machine!.machineId).find(entry => entry.operationId === run.operationId)!;
      await w.h.flow.recordResult({ workspaceId: ws.id, operationId: run.operationId, fence: job.fence ?? ws.fence, status });
      expect((await readWorkspace(w.h.deps, run.workspaceId))!.status).toBe("CLOSED");
      expect((await w.h.machines.health(ws.machine!.machineId)).state).toBe("terminated");
    }
  });
  it("is refused (nothing written) for heads that are not the project's repositories exactly, or a project that is gone", async () => {
    const w = await world();
    const job = { project, requestId: randomUUID(), claimId: randomUUID(), owner: "maintainer" };
    const store = w.h.store;
    const before = JSON.stringify(await store.query({ pk: workspaceKey(A, "x").pk }).catch(() => ({})));
    for (const bases of [[], [{ repositoryId: "other", baseCommitSha: HEAD }], [{ repositoryId: "web", baseCommitSha: HEAD }, { repositoryId: "extra", baseCommitSha: HEAD }], [{ repositoryId: "web", baseCommitSha: HEAD }, { repositoryId: "web", baseCommitSha: HEAD }]]) {
      expect(await launchEvalHealthRun(w.h.deps, { ...job, bases })).toBe(false);
    }
    expect(await launchEvalHealthRun(w.h.deps, { ...job, project: "nope", bases: [{ repositoryId: "web", baseCommitSha: HEAD }] })).toBe(false);
    expect(await launchEvalHealthRun({ ...w.h.deps, projects: { latest: async () => undefined } as never }, { ...job, bases: [{ repositoryId: "web", baseCommitSha: HEAD }] })).toBe(false);
    expect(JSON.stringify(await store.query({ pk: workspaceKey(A, "x").pk }).catch(() => ({})))).toBe(before);
    expect(await (await w.h.queues.queue("task-dispatch")).receive()).toEqual([]);
  });
  it("a store that refuses is a run that could not be started: the claim ends as not run and nothing is held", async () => {
    const w = await world(); await w.ask();
    const failing = { ...w.h.deps.store, transact: async () => ({ applied: false }) } as never;
    const outcome = await startEvalHealthRun(w.deps({ launch: async (job) => launchEvalHealthRun({ ...w.h.deps, store: failing }, { ...job, owner: "maintainer" }) }), project);
    expect(outcome).toMatchObject({ outcome: "not_run", reason: "could_not_start" });
  });
});

describe("the plan and grant callback for the run's preparation", () => {
  it("answers the plan on main's head and the grant of the request's approved item, no-store, to the run's own capability", async () => {
    const w = await world(); const run = await w.started();
    const reply = await w.post(run, EVAL_PLAN_DELIVERY_ACTION, w.token(run));
    expect(reply.statusCode).toBe(200);
    expect(reply.headers["cache-control"]).toBe("no-store");
    const answer = EvalPlanDeliverySchema.parse(json(reply));
    if (answer.status !== "ready") throw new Error("not ready");
    expect((answer.plan as { key: { baseCommit: string; company: string; project: string } }).key).toMatchObject({ baseCommit: HEAD, company: A, project });
    expect(answer.approval).toMatchObject({ company: A, project, provider: "customer", maxCalls: 12, maxCostMicros: 600_000 });
    expect(answer.baseline).toMatchObject({ record: null });
  });
  it("answers not available once the claim ended, expired or was replaced, and for a person who no longer may approve", async () => {
    const ended = await world(); const a = await ended.started();
    await recordEvalHealthResult(ended.deps(), project, resultBody(a));
    expect(json(await ended.post(a, EVAL_PLAN_DELIVERY_ACTION, ended.token(a)))).toEqual({ status: "not_available" });
    const late = await world(); const b = await late.started();
    late.h.clock.advance(EVAL_HEALTH_RUN_MAX_MS / 1000 + 1);
    expect(json(await late.post(b, EVAL_PLAN_DELIVERY_ACTION, late.token(b)))).toEqual({ status: "not_available" });
    const lost = await world(); const c = await lost.started();
    lost.w.roles["maintainer"] = undefined;
    expect(json(await lost.post(c, EVAL_PLAN_DELIVERY_ACTION, lost.token(c)))).toEqual({ status: "not_available" });
    const moved = await world(); const d = await moved.started();
    await (await moved.w.run(filesOf(2), reportOf(2, { model: "gemini-2.5-pro", modelVersion: "gemini-2.5-pro-001" }))).approve();
    expect(json(await moved.post(d, EVAL_PLAN_DELIVERY_ACTION, moved.token(d)))).toEqual({ status: "not_available" });
  });
  it("is not served where no health run is wired, to a capability without the action, or to another company's layer", async () => {
    const w = await world(); const run = await w.started();
    expect((await w.post(run, EVAL_PLAN_DELIVERY_ACTION, w.token(run), {}, w.handler({ evalHealth: undefined }))).statusCode).toBe(409);
    expect((await w.post(run, EVAL_PLAN_DELIVERY_ACTION, w.token(run, [EVAL_HEALTH_RESULT_PATH]))).statusCode).toBeGreaterThanOrEqual(400);
    expect((await w.post(run, EVAL_PLAN_DELIVERY_ACTION, undefined)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await w.post(run, EVAL_PLAN_DELIVERY_ACTION, w.token(run), {}, w.handler({ companyId: COMPANY_B.orgId }))).statusCode).toBe(404);
  });
  it("is not served to a preparation that is not a health run's (a plain preparation of the same project)", async () => {
    const w = await world(); const run = await w.started();
    const key = operationKey(A, run.workspaceId, run.operationId);
    const op = (await w.h.store.get(key))!;
    const dispatch = { ...(op["dispatch"] as Record<string, unknown>), payload: { readOnly: true, pins: [{ repository: "web", commit: HEAD }] } };
    await w.h.store.put({ item: { ...op, dispatch } });
    const reply = await w.post(run, EVAL_PLAN_DELIVERY_ACTION, w.token(run));
    expect(reply.statusCode).toBe(409);
    expect((await w.post(run, EVAL_HEALTH_RESULT_PATH, w.token(run), resultBody(run))).statusCode).toBe(409);
  });
});

describe("the result callback", () => {
  it("takes the run's one result: the baseline is kept and the request finishes, and a second post is the same answer", async () => {
    const w = await world(); const run = await w.started();
    const reply = await w.post(run, EVAL_HEALTH_RESULT_PATH, w.token(run), resultBody(run));
    expect(reply.statusCode).toBe(200);
    expect(json(reply)).toEqual({ outcome: "finished" });
    expect(await readEvalHealthRow({ store: w.h.store, companyId: A }, project)).toMatchObject({ state: "finished", result: { questionCount: 2, saved: true } });
    expect(json(await w.post(run, EVAL_HEALTH_RESULT_PATH, w.token(run), resultBody(run)))).toEqual({ outcome: "duplicate" });
  });
  it("is refused for a body that names another request or claim than this preparation's own, with nothing kept", async () => {
    const w = await world(); const run = await w.started();
    for (const over of [{ requestId: randomUUID() }, { claimId: randomUUID() }]) {
      expect((await w.post(run, EVAL_HEALTH_RESULT_PATH, w.token(run), resultBody(run, over))).statusCode).toBe(409);
    }
    expect((await w.post(run, EVAL_HEALTH_RESULT_PATH, w.token(run), "not json")).statusCode).toBeGreaterThanOrEqual(400);
    expect((await readEvalHealthRow({ store: w.h.store, companyId: A }, project))!.state).toBe("running");
  });
  it("is refused for a capability without the action, past the size bound, and from another company's layer", async () => {
    const w = await world(); const run = await w.started();
    expect((await w.post(run, EVAL_HEALTH_RESULT_PATH, w.token(run, [EVAL_PLAN_DELIVERY_ACTION]), resultBody(run))).statusCode).toBeGreaterThanOrEqual(400);
    expect((await w.post(run, EVAL_HEALTH_RESULT_PATH, w.token(run), "x".repeat(EVAL_HEALTH_RESULT_MAX_BYTES + 1))).statusCode).toBe(400);
    expect((await w.post(run, EVAL_HEALTH_RESULT_PATH, w.token(run), resultBody(run), w.handler({ companyId: COMPANY_B.orgId }))).statusCode).toBe(404);
    expect((await w.post(run, EVAL_HEALTH_RESULT_PATH, w.token(run), resultBody(run), w.handler({ evalHealth: undefined }))).statusCode).toBe(404);
    expect((await readEvalHealthRow({ store: w.h.store, companyId: A }, project))!.state).toBe("running");
  });
  it("a worker's stop (the operation ended) takes no result", async () => {
    const w = await world(); const run = await w.started();
    const key = operationKey(A, run.workspaceId, run.operationId);
    await w.h.store.put({ item: { ...(await w.h.store.get(key))!, status: "CANCELLED" } });
    expect((await w.post(run, EVAL_HEALTH_RESULT_PATH, w.token(run), resultBody(run))).statusCode).toBeGreaterThanOrEqual(400);
    expect((await readEvalHealthRow({ store: w.h.store, companyId: A }, project))!.state).toBe("running");
  });
});

describe("the run's model access", () => {
  it("is a task token for the company, the project (as payer) and the run itself, while the claim lives", async () => {
    const w = await world(); const run = await w.started();
    const reply = await w.modelAccess(w.token(run));
    expect(reply.statusCode).toBe(200);
    const body = json(reply) as { baseUrl: string; apiKey: string };
    expect(body.baseUrl).toBe(GATEWAY);
    expect(claimsOf(body.apiKey)).toMatchObject({ cid: A, pid: project, pay: { kind: "project", project }, tid: `eval-health-${run.requestId}`, ws: run.workspaceId, op: run.operationId, stp: "eval-health", mdl: ["claude-sonnet-4-5"] });
    expect(claimsOf(body.apiKey)["per"]).toBeUndefined();
  });
  it("is refused once the claim ended, expired or is not this operation's, and for a preparation that is not a health run's", async () => {
    const ended = await world(); const a = await ended.started();
    await recordEvalHealthResult(ended.deps(), project, resultBody(a));
    expect((await ended.modelAccess(ended.token(a))).statusCode).toBeGreaterThanOrEqual(400);
    const late = await world(); const b = await late.started(); late.h.clock.advance(EVAL_HEALTH_RUN_MAX_MS / 1000 + 1);
    expect((await late.modelAccess(late.token(b))).statusCode).toBeGreaterThanOrEqual(400);
    const other = await world(); const c = await other.started();
    const key = operationKey(A, c.workspaceId, c.operationId); const op = (await other.h.store.get(key))!;
    const dispatch = op["dispatch"] as { payload: Record<string, unknown> };
    await other.h.store.put({ item: { ...op, dispatch: { ...dispatch, payload: { ...dispatch.payload, evalHealth: { requestId: c.requestId, claimId: randomUUID() } } } } });
    expect((await other.modelAccess(other.token(c))).statusCode).toBeGreaterThanOrEqual(400);
    const plain = await world(); const d = await plain.started();
    const key2 = operationKey(A, d.workspaceId, d.operationId); const op2 = (await plain.h.store.get(key2))!;
    const dispatch2 = op2["dispatch"] as { payload: Record<string, unknown> };
    await plain.h.store.put({ item: { ...op2, dispatch: { ...dispatch2, payload: { readOnly: true, pins: dispatch2.payload["pins"] } } as never } });
    expect((await plain.modelAccess(plain.token(d))).statusCode).toBeGreaterThanOrEqual(400);
  });
  it("is refused to a person whose yes no longer holds is not needed (the claim is the authority), but never to another company's layer or without the action", async () => {
    const w = await world(); const run = await w.started();
    expect((await w.modelAccess(w.token(run, [EVAL_PLAN_DELIVERY_ACTION]))).statusCode).toBeGreaterThanOrEqual(400);
    expect((await w.modelAccess(w.token(run), w.handler({ companyId: COMPANY_B.orgId }))).statusCode).toBeGreaterThanOrEqual(400);
    expect((await w.modelAccess(undefined)).statusCode).toBeGreaterThanOrEqual(400);
  });
  it("a stale fence is refused", async () => {
    const w = await world(); const run = await w.started();
    expect((await w.modelAccess(w.token(run, undefined, { fence: 2 }))).statusCode).toBeGreaterThanOrEqual(400);
  });
});
