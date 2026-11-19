// DEC 254zzz84 (1): a company picks the model for each part of a task (plan, coding, the reviews, ...) from the models the gateway offers it. This proves the whole path the core takes
// for one step, with no model call: the company's per-step setting (core-host/gateway-model-selection.ts) -> the step's choice recorded on the operation (task-flow/step-model.ts)
// -> the gateway task token's `mdl` (model-gateway/describer.ts). And the fallbacks: a step the company did not set runs on the company's own engine model
// (DEC 254n (1), core-host/company-engine-model.ts), else on the install's default; the dispatcher's stored copy follows the same order. Two companies never see each other's choice.
import { expect, it } from "vitest";
import { agentModelIdentity, type OrgId, type Principal } from "@agentx/contracts";
import { createTaskTokenDescriber } from "../../packages/broker/src/core/model-gateway/describer.js";
import { chooseStepModel } from "../../packages/broker/src/core/task-flow/step-model.js";
import { operationKey, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import type { TaskTokenOperation } from "../../packages/broker/src/core/model-gateway/token.js";
import { HOSTED_MODEL_WORDS, createAgentModelChoice } from "../../packages/broker/src/core-host/gateway-model-selection.js";
import { COMPANY_ENGINE_MODEL_ENTITY, companyEngineModelKey, companyEngineModelRoute } from "../../packages/broker/src/core-host/company-engine-model.js";
import { dispatcherStoredAgentModelChoice } from "../../packages/broker/src/core-host/stored-agent-model-choice.js";
import { createLocalOwnerApprovers, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createHarness, newRequestId, type Harness, type HarnessOptions } from "../support/task-flow-harness.js";
import { createFakeOfferedModels, type FakeOfferedModels } from "../support/offered-models-fake.js";

const INSTALL = "claude-sonnet-5-5";
const COMPANY_MODEL = "claude-opus-5-5";
const PLAN = "claude-fable-5-2";
const BUILD = "qwen.qwen3-coder-480b-a35b-v1:0";
const REVIEW = "zai.glm-5";
const OTHER: OrgId = "org_stepmodels000000000b";
const installRoute = { route: async () => ({ alias: INSTALL, api: "anthropic-messages" as const, catalog: INSTALL }) };

/** One company's world. `shared`: the other company's store and the gateway reader, as in production (one table, keys prefixed by the company; one reader for every company). */
async function world(companyId?: OrgId, shared?: { backend: HarnessOptions["backend"]; reader: FakeOfferedModels }) {
  const h = createHarness({ ...(companyId === undefined ? {} : { companyId }), ...(shared?.backend === undefined ? {} : { backend: shared.backend }) });
  await h.registerProject();
  const reader = shared?.reader ?? createFakeOfferedModels();
  const company = h.deps.companyId;
  // The broker's wiring (core-engine-root.ts modelFlowOptions): the step rule's default is the company's engine model route, which falls back to the install's.
  const modelAccess = companyEngineModelRoute({ store: h.store, companyId: company, install: installRoute });
  const choice = createAgentModelChoice({
    store: h.store, companyId: company, audit: h.deps.audit, approvers: createLocalOwnerApprovers({ now: () => new Date(h.clock.now) }), reader, now: () => h.clock.now,
    defaultModel: async () => (await modelAccess.route())!.alias,
  });
  h.deps.modelAccess = modelAccess;
  h.deps.stepModels = choice.stepModels;
  const started = await h.flow.start(h.owner, { project: "payments", instructions: "Build it", requestId: newRequestId() });
  const workspaceId = started.task.workspaceId;
  const workspace = (await h.store.get(workspaceKey(company, workspaceId)))!;
  const operationId = workspace["activeOperationId"] as string;
  const key = operationKey(company, workspaceId, operationId);
  const tk = taskKey(started.task.taskId);
  await h.store.put({ item: { ...(await h.store.get(tk))!, origin: "app" } });
  const scope: TaskTokenOperation = { workspaceId, operationId, fence: 1 };
  const owner: Principal = { ...localOwnerPrincipal({ companyId: company }), authTime: new Date(h.clock.now).toISOString() };
  return { h, reader, choice, company, key, scope, owner, describer: createTaskTokenDescriber(h.deps), shared: { backend: (() => ({ store: h.store, queues: h.queues })) as HarnessOptions["backend"], reader } };
}
type World = Awaited<ReturnType<typeof world>>;

async function set(w: World, stage: string, model: string) {
  const state = await w.choice.service().state();
  const result = await w.choice.service().apply(w.owner, { action: "set", stage, choice: { model: agentModelIdentity(model) }, expectedRevision: state.revision }, { fresh: true });
  expect(result).toMatchObject({ ok: true });
}

/** The token's `mdl` for one step of the task: the step's model is chosen and recorded as the core does before dispatch, then the gateway token is described. */
async function tokenModels(w: World, workflowMode: string, programStepId: string): Promise<string[] | undefined> {
  const original = (await w.h.store.get(w.key))!;
  const { modelChoice: _dropped, ...rest } = original as Record<string, unknown>;
  void _dropped;
  const operation = { ...rest, kind: "task", status: "RUNNING", workflowMode, programStepId, requester: { personId: "a".repeat(64), provider: "test" }, dispatch: { kind: "task", payload: {} } };
  await w.h.store.put({ item: operation as never });
  const outcome = await chooseStepModel(w.h.deps, operation as never);
  if (outcome !== undefined) {
    if (!outcome.ok) throw new Error(outcome.sentence);
    await w.h.store.put({ item: { ...operation, modelChoice: outcome.choice } as never });
  }
  return (await w.describer.describe(w.scope))?.models;
}

const setCompanyModel = (h: Harness, company: OrgId, model: string) => h.store.put({ item: { ...companyEngineModelKey(company), entityType: COMPANY_ENGINE_MODEL_ENTITY, orgId: company, version: 1, model, updatedAt: new Date(h.clock.now).toISOString(), updatedBy: "b".repeat(64) } });

it("each step's gateway token names exactly the model the company chose for that step", async () => {
  const w = await world();
  await set(w, "plan", PLAN);
  await set(w, "build", BUILD);
  await set(w, "code_review", REVIEW);
  expect(await tokenModels(w, "PLAN", "plan")).toEqual([PLAN]);
  expect(await tokenModels(w, "IMPLEMENT", "build")).toEqual([BUILD]);
  expect(await tokenModels(w, "REVIEW", "review")).toEqual([REVIEW]);
  // Understand shares the plan's setting (one edit group).
  expect(await tokenModels(w, "UNDERSTAND", "understand")).toEqual([PLAN]);
});

it("a step the company did not set runs on the company's own engine model, else on the install's default", async () => {
  const w = await world();
  await set(w, "build", BUILD);
  // No company model: the install's default.
  expect(await tokenModels(w, "PLAN", "plan")).toEqual([INSTALL]);
  // The company's own model replaces the install's for every step it did not set; the step it set keeps its own.
  await setCompanyModel(w.h, w.company, COMPANY_MODEL);
  expect(await tokenModels(w, "PLAN", "plan")).toEqual([COMPANY_MODEL]);
  // The step rule itself chose the company's model as the step's default (not the describer's own fallback).
  expect((await w.h.store.get(w.key))!["modelChoice"]).toMatchObject({ reason: "BUILTIN_DEFAULT", route: { alias: COMPANY_MODEL } });
  expect(await tokenModels(w, "IMPLEMENT", "build")).toEqual([BUILD]);
});

it("a step set to a model the gateway no longer offers this company is refused before dispatch, never run on another model", async () => {
  const w = await world();
  await set(w, "build", BUILD);
  w.reader.set(w.company, [INSTALL, PLAN]);
  w.h.clock.advance(10);
  await expect(tokenModels(w, "IMPLEMENT", "build")).rejects.toThrow(HOSTED_MODEL_WORDS.refusals.MODEL_NOT_VERIFIED);
  // The page says so too, for that step only.
  const steps = (await w.choice.service().state()).steps;
  expect(steps.find((step) => step.stage === "build")?.refusal?.code).toBe("MODEL_NOT_VERIFIED");
  expect(steps.find((step) => step.stage === "plan")?.refusal).toBeUndefined();
});

it("a model the gateway does not offer cannot be saved for a step", async () => {
  const w = await world();
  w.reader.set(w.company, [INSTALL, PLAN]);
  const result = await w.choice.service().apply(w.owner, { action: "set", stage: "build", choice: { model: agentModelIdentity(BUILD) }, expectedRevision: 0 }, { fresh: true });
  expect(result).toMatchObject({ ok: false, code: "model_unavailable" });
  expect(await tokenModels(w, "IMPLEMENT", "build")).toEqual([INSTALL]);
});

it("two companies on one table and one gateway reader: one company's step choice and model never reach the other's steps", async () => {
  const a = await world();
  const b = await world(OTHER, a.shared);
  expect(b.h.store).toBe(a.h.store);
  a.reader.set(OTHER, [INSTALL, COMPANY_MODEL]);
  await set(a, "build", BUILD);
  await setCompanyModel(a.h, a.company, PLAN);
  expect(await tokenModels(a, "IMPLEMENT", "build")).toEqual([BUILD]);
  expect(await tokenModels(a, "PLAN", "plan")).toEqual([PLAN]);
  // B: nothing of A's (its setting, its engine model, its published validation) reaches B's steps, on the broker or the dispatcher.
  expect(await tokenModels(b, "IMPLEMENT", "build")).toEqual([INSTALL]);
  const bDispatcher = dispatcherStoredAgentModelChoice({ store: b.h.store, companyId: b.company, now: () => b.h.clock.now, defaultRoute: () => companyEngineModelRoute({ store: b.h.store, companyId: b.company, install: installRoute }).route(), log: () => undefined });
  expect(await bDispatcher.choose({ stage: "build" })).toMatchObject({ ok: true, step: { route: { alias: INSTALL } } });
  // B's own list decides for B: A's model is not offered to B.
  expect(await b.choice.service().apply(b.owner, { action: "set", stage: "build", choice: { model: agentModelIdentity(BUILD) }, expectedRevision: 0 }, { fresh: true })).toMatchObject({ ok: false, code: "model_unavailable" });
  await setCompanyModel(b.h, b.company, COMPANY_MODEL);
  expect(await tokenModels(b, "IMPLEMENT", "build")).toEqual([COMPANY_MODEL]);
  expect(await tokenModels(a, "PLAN", "plan")).toEqual([PLAN]);
});

it("the dispatcher's stored copy follows the same order: the step's validated choice, else the company's model, else the install's", async () => {
  const w = await world();
  const modelAccess = companyEngineModelRoute({ store: w.h.store, companyId: w.company, install: installRoute });
  const dispatcher = dispatcherStoredAgentModelChoice({ store: w.h.store, companyId: w.company, now: () => w.h.clock.now, defaultRoute: () => modelAccess.route(), log: () => undefined });
  // Nothing saved: the install's default.
  expect(await dispatcher.choose({ stage: "build" })).toMatchObject({ ok: true, step: { route: { alias: INSTALL } } });
  await setCompanyModel(w.h, w.company, COMPANY_MODEL);
  expect(await dispatcher.choose({ stage: "build" })).toMatchObject({ ok: true, step: { route: { alias: COMPANY_MODEL } } });
  // The broker publishes the validated choice with the change: the dispatcher then runs the step on it.
  await set(w, "build", BUILD);
  expect(await dispatcher.choose({ stage: "build" })).toMatchObject({ ok: true, step: { route: { alias: BUILD } } });
  expect(await dispatcher.choose({ stage: "plan" })).toMatchObject({ ok: true, step: { route: { alias: COMPANY_MODEL } } });
});

it("on the dispatcher's stored copy (what a deployed step runs with), the token names the step's chosen model too", async () => {
  const w = await world();
  await set(w, "build", BUILD);
  const modelAccess = companyEngineModelRoute({ store: w.h.store, companyId: w.company, install: installRoute });
  w.h.deps.stepModels = dispatcherStoredAgentModelChoice({ store: w.h.store, companyId: w.company, now: () => w.h.clock.now, defaultRoute: () => modelAccess.route(), log: () => undefined });
  expect(await tokenModels(w, "IMPLEMENT", "build")).toEqual([BUILD]);
  const recorded = (await w.h.store.get(w.key))!["modelChoice"] as { reason: string; route: { alias: string } };
  expect(recorded.route.alias).toBe(BUILD);
  expect(await tokenModels(w, "PLAN", "plan")).toEqual([INSTALL]);
  expect(((await w.h.store.get(w.key))!["modelChoice"] as { reason: string }).reason).toBe("BUILTIN_DEFAULT");
});
