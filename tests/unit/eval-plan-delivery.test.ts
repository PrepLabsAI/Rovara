// EVAL-WIRE-SOURCES (DEC 253c): the `eval-plan` callback delivers the trusted eval plan, the spend approval and the base-score cache entry to the ONE CHECKS run the broker asked for an eval,
// for that run's own company and project. Every guard below has a test that fails without it (two companies, the action, the signature, the size, the run, the scope of each source).
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  EVAL_PLAN_DELIVERY_ACTION, EVAL_PLAN_DELIVERY_MAX_BYTES, EvalPlanDeliverySchema, createDocumentBaseScoreCache, evalBaseCacheKey, evalCommandFingerprint,
  type BaseScoreCache, type EvalBaseCacheKeyParts, type EvalBaseRecord, type EvalSpendApproval, type EvalSpendGrant,
} from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createCallbackHandler } from "../../packages/broker/src/services/callbacks.js";
import { CallbackCapabilities, type CallbackAction } from "../../packages/broker/src/callbacks.js";
import { EVAL_PLAN_DELIVERY_FORBIDDEN, handleEvalPlanDelivery, type EvalPlanScope, type EvalPlanSources } from "../../packages/broker/src/core/proof/eval-plan-delivery.js";
import { operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { evalSourcesFromDelivery, fetchEvalPlanDelivery } from "../../packages/worker/src/verification/eval-plan-delivery.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A.orgId;
const B = COMPANY_B.orgId;
const KEY = Buffer.alloc(32, 9);
const hex = (c: string, n = 64) => c.repeat(n);
const EVAL_REQUEST = { aiChange: true, reason: "eval_hint", evalPass: 1, callsAlreadyUsed: 0, costAlreadyUsedMicros: 0 };

const planOf = (company: string, project: string, over: Record<string, unknown> = {}) => ({
  company, project, selection: "evals/main", evalSetHash: hex("b"), evalConfigured: true, judgePin: hex("c"), baselineJudgePin: hex("c"), subsetSupported: true,
  inputs: { evalSetHash: hex("b"), judgePin: hex("c"), modelVersion: "gemini-small-2026-10-01", model: "gemini-small", catalogRowId: "gemini", commandFingerprint: evalCommandFingerprint("npm run eval"), settingsFingerprint: hex("d") },
  key: { company, project, baseCommit: hex("a", 40), commandFingerprint: evalCommandFingerprint("npm run eval"), catalogRowId: "gemini", model: "gemini-small", modelVersion: "gemini-small-2026-10-01" },
  settings: { imageDigest: "sha256:" + hex("e"), route: "gateway" },
  questions: [{ id: "q1", category: "ordinary", baseHash: hex("1"), headHash: hex("2") }], maxCallsPerQuestion: 2, maxCostMicrosPerQuestion: 1000,
  ...over,
});
const partsOf = (plan: ReturnType<typeof planOf>): EvalBaseCacheKeyParts => ({ ...plan.key, evalSetHash: plan.evalSetHash, hiddenSetHash: "none", settingsFingerprint: plan.inputs.settingsFingerprint });
const grantOf = (company: string, project: string): EvalSpendGrant => ({ company, project, selection: "evals/main", role: "maintainer", inputsDigest: hex("f"), provider: "customer", connected: true, maxCalls: 40, maxCostMicros: 400_000 });
const RECORD: EvalBaseRecord = { schemaVersion: 1, measures: [{ name: "accuracy", unit: "fraction", value: 0.8, direction: "up_good", spread: 0.04, count: 50 }], caseCount: 50, recordedOn: "2026-11-13", roundKind: "check_unsealed", runnerSchemaVersion: 1 };

/** One store holding two companies' tasks and sources; every source is per company and per project, and records what it was asked. */
async function world(options: { company?: string; operation?: Record<string, unknown>; taskCompany?: string; taskWorkspace?: string; body?: string; workspace?: boolean } = {}) {
  const company = options.company ?? A;
  const store = new MemoryDocumentStore();
  const workspaceId = randomUUID(); const operationId = randomUUID(); const taskId = randomUUID();
  // T1: the workspace, its operation and its task pointer sit under the company's own workspace partition; the workspace record names the company.
  if (options.workspace !== false) await store.put({ item: { ...workspaceKey(company, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId: company } });
  await store.put({ item: { ...operationKey(company, workspaceId, operationId), entityType: "OPERATION", id: operationId, workspaceId, kind: "task", workflowMode: "CHECKS", status: "RUNNING", fence: 3, companyId: company,
    dispatch: { kind: "task", payload: { workflowMode: "CHECKS", evalRequest: EVAL_REQUEST } }, ...options.operation } });
  await store.put({ item: { ...(await workspaceKeys({ store, companyId: company }, workspaceId)).taskPointerKey(), taskId } });
  await store.put({ item: { ...taskKey(taskId), taskId, workspaceId: options.taskWorkspace ?? workspaceId, project: "web", companyId: options.taskCompany ?? company } });
  const caches = new Map<string, BaseScoreCache>([[A, createDocumentBaseScoreCache(store, { companyId: A })], [B, createDocumentBaseScoreCache(store, { companyId: B })]]);
  const asked: Array<{ source: string; scope: unknown }> = [];
  // The plan and the approval the one read answers (EVAL-PLAN-SNAPSHOT), each replaceable by a test.
  const parts: { plan: (scope: EvalPlanScope) => Promise<unknown>; approval: (scope: EvalPlanScope) => EvalSpendApproval | undefined } = {
    plan: vi.fn(async (scope: EvalPlanScope) => { asked.push({ source: "plan", scope }); return planOf(scope.companyId, scope.project); }),
    approval: vi.fn((scope: EvalPlanScope) => { asked.push({ source: "approval", scope }); return { read: async () => grantOf(scope.companyId, scope.project) }; }),
  };
  const sources: EvalPlanSources = {
    read: vi.fn(async (scope: EvalPlanScope) => { const plan = await parts.plan(scope); return plan === undefined ? undefined : { plan, approval: parts.approval(scope) }; }),
    cache: vi.fn((companyId: string) => { asked.push({ source: "cache", scope: companyId }); return caches.get(companyId); }),
  };
  const capabilities = new CallbackCapabilities(KEY);
  const token = (actions: string[], over: { workspaceId?: string; operationId?: string; fence?: number; expiresInSeconds?: number } = {}) => capabilities.issue({ workspaceId: over.workspaceId ?? workspaceId, operationId: over.operationId ?? operationId, fence: over.fence ?? 3, actions: actions as CallbackAction[], expiresInSeconds: over.expiresInSeconds ?? 60 });
  const handler = (deps: { evalPlan?: EvalPlanSources } = { evalPlan: sources }) => createCallbackHandler({ flow: { store, companyId: company, callbackSigningKey: KEY } as never, blobs: {} as never, grants: {} as never, ...deps });
  const call = (capability: string | undefined, body = options.body ?? "{}", h = handler()) => h({ method: "POST", path: `/v1/internal/workspaces/${workspaceId}/operations/${operationId}/${EVAL_PLAN_DELIVERY_ACTION}`, headers: capability === undefined ? {} : { "x-agentx-callback-capability": capability }, body });
  return { store, workspaceId, operationId, taskId, sources, parts, asked, caches, token, handler, call, company };
}
const json = (reply: { body?: string }) => JSON.parse(reply.body ?? "{}") as Record<string, unknown>;

describe("the eval-plan callback", () => {
  it("happy path: answers this run's plan, approval and cache entry, for its own company and task project, with no-store (and the worker reads it back into read-only sources)", async () => {
    const w = await world();
    const plan = planOf(A, "web");
    await w.caches.get(A)!.write(partsOf(plan), RECORD, { writer: "rovara_base_round", baseCommit: plan.key.baseCommit });
    const reply = await w.call(w.token([EVAL_PLAN_DELIVERY_ACTION]));
    expect(reply.statusCode).toBe(200);
    expect(reply.headers["cache-control"]).toBe("no-store");
    const answer = EvalPlanDeliverySchema.parse(json(reply));
    expect(answer).toEqual({ status: "ready", plan, approval: grantOf(A, "web"), baseline: { key: evalBaseCacheKey(partsOf(plan)), record: RECORD, measurement: "idle" } });
    // Every source was asked for the run's own scope only.
    expect(w.asked).toEqual([{ source: "plan", scope: { companyId: A, project: "web" } }, { source: "approval", scope: { companyId: A, project: "web" } }, { source: "cache", scope: A }]);
    const delivered = evalSourcesFromDelivery(answer)!;
    expect(await delivered.plan()).toEqual(plan);
    expect(await delivered.approval.read()).toEqual(grantOf(A, "web"));
    expect(await delivered.cache.read(partsOf(plan))).toEqual(RECORD);
    // Another key is a miss; the worker never writes through it.
    expect(await delivered.cache.read({ ...partsOf(plan), project: "api" })).toBeUndefined();
    expect(await delivered.cache.readMeasurement!({ ...partsOf(plan), project: "api" })).toBe("unavailable");
    expect(await delivered.cache.write(partsOf(plan), RECORD, { writer: "rovara_base_round", baseCommit: plan.key.baseCommit })).toBe("refused");
  });

  it("cross-company: company B's install never answers A's operation, and A's run never sees B's plan, grant or cache (mutants: the operation company check, the task company check)", async () => {
    // An operation stored by company A, served by company B's callback layer: not found, nothing asked.
    const a = await world();
    const bHandler = createCallbackHandler({ flow: { store: a.store, companyId: B, callbackSigningKey: KEY } as never, blobs: {} as never, grants: {} as never, evalPlan: a.sources });
    const viaB = await a.call(a.token([EVAL_PLAN_DELIVERY_ACTION]), "{}", bHandler);
    expect(viaB.statusCode).toBe(404);
    expect(a.asked).toEqual([]);
    // A's operation whose task record is B's: refused before any source is asked.
    const mixed = await world({ taskCompany: B });
    const refused = await mixed.call(mixed.token([EVAL_PLAN_DELIVERY_ACTION]));
    expect(refused.statusCode).toBe(409);
    expect(json(refused)).toEqual({ error: { code: "CALLBACK_FORBIDDEN", message: EVAL_PLAN_DELIVERY_FORBIDDEN } });
    expect(mixed.asked).toEqual([]);
    // B's cache holds a record under the same parts with B's company; A's answer has none of it.
    const w = await world();
    const bPlan = planOf(B, "web");
    await w.caches.get(B)!.write(partsOf(bPlan), RECORD, { writer: "rovara_base_round", baseCommit: bPlan.key.baseCommit });
    const answer = EvalPlanDeliverySchema.parse(json(await w.call(w.token([EVAL_PLAN_DELIVERY_ACTION]))));
    expect(answer.status === "ready" && answer.baseline?.record).toBeNull();
    expect(JSON.stringify(answer)).not.toContain(B);
  });

  it("cross-company: a source that answers another company's or project's data is not passed on (mutants: each plan scope check, the grant scope check)", async () => {
    for (const [name, wrong] of [["company", planOf(B, "web")], ["project", planOf(A, "api")], ["plan company only", { ...planOf(A, "web"), company: B }], ["plan project only", { ...planOf(A, "web"), project: "api" }], ["key company", { ...planOf(A, "web"), key: { ...planOf(A, "web").key, company: B } }], ["key project", { ...planOf(A, "web"), key: { ...planOf(A, "web").key, project: "api" } }]] as const) {
      const w = await world();
      w.parts.plan = async () => wrong;
      const answer = json(await w.call(w.token([EVAL_PLAN_DELIVERY_ACTION])));
      expect(answer, name).toEqual({ status: "not_available" });
    }
    for (const grant of [grantOf(B, "web"), grantOf(A, "api")]) {
      const w = await world();
      w.parts.approval = () => ({ read: async () => grant });
      const answer = EvalPlanDeliverySchema.parse(json(await w.call(w.token([EVAL_PLAN_DELIVERY_ACTION]))));
      expect(answer.status === "ready" && answer.approval).toBeNull();
      expect(JSON.stringify(answer)).not.toContain(B);
    }
  });

  it("wrong action: a capability for any other action, even model-access or every other action together, is refused and nothing is read (mutant: the action check)", async () => {
    const w = await world();
    const others = ["events", "artifacts", "result", "model-access", "browser-evidence-sign-in", "setup-agent", "context-tools"];
    for (const actions of [...others.map((action) => [action]), others]) {
      const reply = await w.call(w.token(actions));
      expect(reply.statusCode, actions.join()).toBe(409);
      expect(json(reply)).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
    }
    // A capability for another operation, another workspace or an older fence of this one.
    expect((await w.call(w.token([EVAL_PLAN_DELIVERY_ACTION], { operationId: randomUUID() }))).statusCode).toBe(409);
    expect((await w.call(w.token([EVAL_PLAN_DELIVERY_ACTION], { workspaceId: randomUUID() }))).statusCode).toBe(409);
    expect((await w.call(w.token([EVAL_PLAN_DELIVERY_ACTION], { fence: 2 }))).statusCode).toBe(409);
    expect(w.asked).toEqual([]);
  });

  it("unsigned: no capability, a forged signature, a token signed with another key or an expired one is refused and nothing is read (mutant: the signature check)", async () => {
    const w = await world();
    const good = w.token([EVAL_PLAN_DELIVERY_ACTION]);
    const [body] = good.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ workspaceId: w.workspaceId, operationId: w.operationId, fence: 3, actions: [EVAL_PLAN_DELIVERY_ACTION], expiresAt: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
    const otherKey = new CallbackCapabilities(Buffer.alloc(32, 1)).issue({ workspaceId: w.workspaceId, operationId: w.operationId, fence: 3, actions: [EVAL_PLAN_DELIVERY_ACTION], expiresInSeconds: 60 });
    for (const capability of [undefined, "", `${forgedBody}.${good.split(".")[1]}`, `${body}.`, `${body}`, otherKey, w.token([EVAL_PLAN_DELIVERY_ACTION], { expiresInSeconds: -1 })]) {
      const reply = await w.call(capability);
      expect(reply.statusCode, String(capability)).toBeGreaterThanOrEqual(400);
      expect(reply.statusCode).toBeLessThan(500);
      expect(json(reply)).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
    }
    expect(w.asked).toEqual([]);
  });

  it("oversize: a request body over the bound is refused before any read, and an answer over the bound is not sent (mutants: each size check)", async () => {
    const w = await world();
    const big = await w.call(w.token([EVAL_PLAN_DELIVERY_ACTION]), JSON.stringify({ pad: "x".repeat(100) }));
    expect(big.statusCode).toBe(400);
    expect(w.asked).toEqual([]);
    // The handler itself refuses an operation of another company than the one it serves, before any source is asked (mutant: the handler's operation company check).
    const foreign = await world({ company: B });
    await expect(handleEvalPlanDelivery({ sources: foreign.sources, companyId: A, projectOf: async () => "web" }, (await foreign.store.get(operationKey(B, foreign.workspaceId, foreign.operationId))) as never))
      .rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    expect(foreign.asked).toEqual([]);
    // A plan whose answer would be over the bound: "not_available", and the oversize is logged by its fixed name only.
    const huge = await world();
    huge.parts.plan = async (scope: EvalPlanScope) => planOf(scope.companyId, scope.project, { padding: "y".repeat(EVAL_PLAN_DELIVERY_MAX_BYTES) });
    const log = vi.fn();
    const answer = await handleEvalPlanDelivery({ sources: huge.sources, companyId: A, projectOf: async () => "web", log },
      (await huge.store.get(operationKey(A, huge.workspaceId, huge.operationId))) as never);
    expect(answer).toEqual({ status: "not_available" });
    expect(log).toHaveBeenCalledWith("eval_plan_oversize");
    // The worker refuses an answer over the bound while reading it.
    const fetched = await fetchEvalPlanDelivery({ controlPlaneUrl: "https://broker.example.test", workspaceId: w.workspaceId, operationId: w.operationId, capability: "c",
      fetch: async () => new Response(JSON.stringify({ status: "ready", plan: { padding: "z".repeat(EVAL_PLAN_DELIVERY_MAX_BYTES + 512) }, approval: null, baseline: null }), { status: 200 }) });
    expect(fetched).toEqual({ status: "not_available" });
  });

  it("is refused for a run that was not asked for an eval, is not a live task CHECKS run, or has no readable task (mutants: each run check dropped)", async () => {
    for (const operation of [
      { workflowMode: "IMPLEMENT" }, { workflowMode: "REVIEW" }, { kind: "publish" }, { status: "QUEUED_NOT_LIVE" },
      { dispatch: { kind: "task", payload: { workflowMode: "CHECKS" } } }, { dispatch: { kind: "task", payload: { workflowMode: "CHECKS", evalRequest: { ...EVAL_REQUEST, evalPass: 3 } } } },
    ]) {
      const w = await world({ operation });
      const reply = await w.call(w.token([EVAL_PLAN_DELIVERY_ACTION]));
      expect(reply.statusCode, JSON.stringify(operation)).toBeGreaterThanOrEqual(400);
      expect(w.asked).toEqual([]);
    }
    for (const status of ["SUCCEEDED", "FAILED", "CANCELLED"]) {
      const ended = await world({ operation: { status } });
      const reply = await ended.call(ended.token([EVAL_PLAN_DELIVERY_ACTION]));
      expect(reply.statusCode, status).toBe(409);
      expect(json(reply)).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
      expect(ended.asked).toEqual([]);
    }
    // A pointer that names a task of another workspace (the pointer moved): refused (mutant: the task workspace check).
    const moved = await world({ taskWorkspace: randomUUID() });
    expect(json(await moved.call(moved.token([EVAL_PLAN_DELIVERY_ACTION])))).toEqual({ error: { code: "CALLBACK_FORBIDDEN", message: EVAL_PLAN_DELIVERY_FORBIDDEN } });
    expect(moved.asked).toEqual([]);
    const w = await world();
    await w.store.delete({ key: (await workspaceKeys({ store: w.store, companyId: A }, w.workspaceId)).taskPointerKey() });
    expect(json(await w.call(w.token([EVAL_PLAN_DELIVERY_ACTION])))).toEqual({ error: { code: "CALLBACK_FORBIDDEN", message: EVAL_PLAN_DELIVERY_FORBIDDEN } });
    expect(w.asked).toEqual([]);
    // T1: a workspace that is not located in the run's own company (no workspace record, or one that names another company) gives no project (mutant: the locateWorkspace check).
    for (const [name, build] of [["no workspace record", async () => world({ workspace: false })], ["another company's workspace record", async () => {
      const other = await world();
      await other.store.put({ item: { ...workspaceKey(A, other.workspaceId), entityType: "WORKSPACE", id: other.workspaceId, companyId: B } });
      return other;
    }]] as const) {
      const lost = await build();
      expect(json(await lost.call(lost.token([EVAL_PLAN_DELIVERY_ACTION]))), name).toEqual({ error: { code: "CALLBACK_FORBIDDEN", message: EVAL_PLAN_DELIVERY_FORBIDDEN } });
      expect(lost.asked, name).toEqual([]);
    }
  });

  it("fails closed: no sources wired is `not available`; a missing plan, a throwing source or an unreadable grant gives nothing a worker could spend on", async () => {
    const w = await world();
    const bare = await w.call(w.token([EVAL_PLAN_DELIVERY_ACTION]), "{}", w.handler({}));
    expect(bare.statusCode).toBe(404);
    for (const plan of [async () => undefined, async () => { throw new Error("secret-canary"); }, async () => "not a plan"]) {
      const x = await world();
      x.parts.plan = plan;
      const reply = await x.call(x.token([EVAL_PLAN_DELIVERY_ACTION]));
      expect(json(reply)).toEqual({ status: "not_available" });
      expect(reply.body).not.toContain("secret-canary");
    }
    const y = await world();
    y.parts.approval = () => ({ read: async () => { throw new Error("secret-canary"); } });
    y.sources.cache = () => undefined;
    const answer = json(await y.call(y.token([EVAL_PLAN_DELIVERY_ACTION])));
    expect(answer).toMatchObject({ status: "ready", approval: null, baseline: null });
    expect(evalSourcesFromDelivery({ status: "not_available" })).toBeUndefined();
    // The worker's ask: a refused answer or a reply that is not exactly the contract is "not_available", and the capability goes only in its header.
    const seen: RequestInit[] = [];
    const refusedAsk = await fetchEvalPlanDelivery({ controlPlaneUrl: "https://broker.example.test/", workspaceId: y.workspaceId, operationId: y.operationId, capability: "cap",
      fetch: async (_url, init) => { seen.push(init!); return new Response("{}", { status: 409 }); } });
    expect(refusedAsk).toEqual({ status: "not_available" });
    expect(seen[0]).toMatchObject({ method: "POST", body: "{}", headers: { "x-agentx-callback-capability": "cap" } });
    const extra = await fetchEvalPlanDelivery({ controlPlaneUrl: "https://broker.example.test", workspaceId: y.workspaceId, operationId: y.operationId, capability: "cap",
      fetch: async () => new Response(JSON.stringify({ status: "ready", plan: {}, approval: null, baseline: null, other: 1 }), { status: 200 }) });
    expect(extra).toEqual({ status: "not_available" });
  });
});
