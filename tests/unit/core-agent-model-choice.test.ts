import { storedAgentModelChoice, STORED_MODEL_CHOICE_UNAVAILABLE } from "../../packages/broker/src/core-host/stored-agent-model-choice.js";
import { modelSelectionPolicyKey } from "../../packages/broker/src/core/model-selection/policy-store.js";
// DEC 243c / DEC 236j: a company's agents run on a model it chose from what the gateway offers it. The list is the gateway's (read per company, checked against the contract); a model not on it is never chosen
// (a step already holding its choice keeps it); every route is the gateway's agent route under the model's own name; the default is the install's model while nothing is chosen. Two companies never see each other's list or choice.
import { describe, expect, it } from "vitest";
import {
  OFFERED_AGENT_MODELS_MAX, OfferedAgentModelsSchema, agentModelIdentity, agentModelName,
  type Approvers, type AuditEvent, type AuditSink, type OrgId, type Principal,
} from "@agentx/contracts";
import { chooseStepModel } from "../../packages/broker/src/core/task-flow/step-model.js";
import type { OperationRecord } from "../../packages/broker/src/core/task-flow/records.js";
import {
  OFFERED_MODELS_TTL_MS, OFFERED_MODELS_UNAVAILABLE, agentModelChoiceFromRegistry, createAgentModelChoice, createCompanyModelChoices, gatewayModelSelectionSeams, createOfferedModelsView, gatewayRouteOf,
} from "../../packages/broker/src/core-host/gateway-model-selection.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { GATEWAY_OFFERED_MODELS, createFakeOfferedModels, offeredAnswer } from "../support/offered-models-fake.js";

const ORG_A = "org_agentmodels0000000a" as OrgId;
const ORG_B = "org_agentmodels0000000b" as OrgId;
const DEFAULT = "claude-sonnet-5-5";
const owner = (companyId: OrgId): Principal => localOwnerPrincipal({ companyId });

function world(options: { approvers?: Approvers } = {}) {
  const store = new MemoryDocumentStore();
  const reader = createFakeOfferedModels();
  const events: AuditEvent[] = [];
  const audit: AuditSink = { stage: (event) => { events.push(event); return []; }, async record() {} };
  let clock = 1_000_000;
  const approvers: Approvers = options.approvers ?? { async requirement() { return { methods: ["local-session"], minApprovers: 1, selfApprovalAllowed: true }; }, async verify() { return { approved: false, reason: "unused" }; } };
  const choiceFor = (companyId: OrgId, defaultModel = DEFAULT) => createAgentModelChoice({ store, companyId, audit, approvers, reader, defaultModel: async () => defaultModel, now: () => clock, readTimeoutMs: 25 });
  return { store, reader, events, choiceFor, tick: (ms: number) => { clock += ms; } };
}
const stepOf = async (choice: ReturnType<ReturnType<typeof world>["choiceFor"]>, stage: "build" | "plan" | "understand" | "code_review" | "plan_check" = "build") => choice.stepModels.choose({ stage });
const revisionOf = async (choice: ReturnType<ReturnType<typeof world>["choiceFor"]>) => (await choice.service().state()).revision;
const setBuild = async (choice: ReturnType<ReturnType<typeof world>["choiceFor"]>, company: OrgId, name: string) =>
  choice.service().apply(owner(company), { action: "set", stage: "build", choice: { model: agentModelIdentity(name) }, expectedRevision: await revisionOf(choice) }, { fresh: true });

describe("the contract the gateway publishes", () => {
  it("accepts the whole list as it is, and refuses anything else", () => {
    expect(OfferedAgentModelsSchema.safeParse(offeredAnswer(GATEWAY_OFFERED_MODELS)).success).toBe(true);
    const bad: unknown[] = [
      undefined, null, "x", {}, { version: 2, models: [{ model: "claude-sonnet-5-5" }] }, { version: 1, models: [] }, { version: 1 },
      { version: 1, models: [{ model: "claude-sonnet-5-5" }, { model: "claude-sonnet-5-5" }] },
      { version: 1, models: [{ model: "" }] }, { version: 1, models: [{ model: "a b" }] }, { version: 1, models: [{ model: "../x" }] }, { version: 1, models: [{ model: "x\u0000" }] }, { version: 1, models: [{ model: "-x" }] },
      { version: 1, models: [{ model: "claude-sonnet-5-5", price: 1 }] }, { version: 1, models: [{ model: "claude-sonnet-5-5" }], extra: true },
      offeredAnswer(Array.from({ length: OFFERED_AGENT_MODELS_MAX + 1 }, (_, index) => `model.m${String(index)}`)),
    ];
    for (const value of bad) expect(OfferedAgentModelsSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });

  it("names a Claude model under Anthropic and every other model under Bedrock, one name for one model", () => {
    expect(agentModelIdentity("claude-opus-5-5")).toEqual({ provider: "anthropic", modelId: "claude-opus-5-5" });
    expect(agentModelIdentity("us.amazon.nova-2-lite-v1:0")).toEqual({ provider: "amazon-bedrock", modelId: "us.amazon.nova-2-lite-v1:0" });
    for (const name of GATEWAY_OFFERED_MODELS) expect(agentModelName(agentModelIdentity(name))).toBe(name);
    expect(agentModelName({ provider: "amazon-bedrock", modelId: "claude-opus-5-5" })).toBeUndefined();
    expect(agentModelName({ provider: "anthropic", modelId: "qwen.qwen3-coder-480b-a35b-v1:0" })).toBeUndefined();
    expect(agentModelName({ provider: "openai", modelId: "gpt-5" })).toBeUndefined();
    expect(agentModelName({ provider: "openrouter", modelId: "anthropic/claude-opus-5-5" })).toBeUndefined();
    expect(agentModelName({ provider: "anthropic", modelId: "claude opus" })).toBeUndefined();
  });
});

describe("a company's choice", () => {

  it("refuses a model that is not on the list, a model named under the wrong provider, and a change without a fresh sign-in; nothing is stored", async () => {
    const w = world();
    const choice = w.choiceFor(ORG_A);
    const attempts = [
      { model: { provider: "amazon-bedrock", modelId: "meta.llama3-1-405b-instruct-v1:0" } },
      { model: { provider: "amazon-bedrock", modelId: "claude-sonnet-5-5" } },
      { model: { provider: "anthropic", modelId: "mistral.devstral-2-123b" } },
      { model: { provider: "openai", modelId: "gpt-5" } },
      { model: { provider: "openrouter", modelId: "anthropic/claude-opus-5-5" } },
    ];
    for (const attempt of attempts) {
      const result = await choice.service().apply(owner(ORG_A), { action: "set", stage: "build", choice: attempt, expectedRevision: 0 }, { fresh: true });
      expect(result, JSON.stringify(attempt)).toMatchObject({ ok: false, code: "model_unavailable" });
      expect(JSON.stringify(result)).not.toContain("this computer");
    }
    // A fallback model is held to the same list.
    expect(await choice.service().apply(owner(ORG_A), { action: "set", stage: "build", choice: { model: agentModelIdentity("claude-opus-5-5"), fallbackModel: { provider: "amazon-bedrock", modelId: "meta.llama3-1-405b-instruct-v1:0" } }, expectedRevision: 0 }, { fresh: true })).toMatchObject({ ok: false, code: "model_unavailable" });
    expect(await choice.service().apply(owner(ORG_A), { action: "set", stage: "build", choice: { model: agentModelIdentity("claude-opus-5-5") }, expectedRevision: 0 }, { fresh: false })).toMatchObject({ ok: false, code: "reauth_required" });
    expect(await revisionOf(choice)).toBe(0);
    expect(w.events).toEqual([]);
    expect(await stepOf(choice)).toMatchObject({ ok: true, step: { model: { modelId: DEFAULT } } });
  });

  it("through the engine's step rule: a refused model ends the step before any machine, with the sentence", async () => {
    const w = world();
    const choice = w.choiceFor(ORG_A);
    await setBuild(choice, ORG_A, "deepseek.v3-v1:0");
    const operation = { id: "00000000-0000-4000-8000-000000000001", workspaceId: "11111111-1111-4111-8111-111111111111", kind: "task", dispatch: { kind: "task", payload: {} }, workflowMode: "IMPLEMENT", status: "ACCEPTED" } as unknown as OperationRecord;
    const deps = { store: w.store, companyId: ORG_A, stepModels: choice.stepModels };
    expect(await chooseStepModel(deps, operation)).toMatchObject({ ok: true, fresh: true, choice: { stage: "build", route: { alias: "deepseek.v3-v1:0", api: "anthropic-messages" } } });
    w.reader.fail();
    w.tick(OFFERED_MODELS_TTL_MS);
    const refused = await chooseStepModel(deps, operation);
    expect(refused).toMatchObject({ ok: false });
    expect(JSON.stringify(refused)).not.toMatch(/ECONNREFUSED|gateway\.internal/u);
    // An operation that already holds its choice keeps it (a repeat delivery), as before.
    expect(await chooseStepModel(deps, { ...operation, modelChoice: { stage: "build", model: agentModelIdentity("deepseek.v3-v1:0"), route: gatewayRouteOf("deepseek.v3-v1:0"), reason: "COMPANY_DEFAULT" } })).toMatchObject({ ok: true, fresh: false });
  });
});

describe("a list that cannot be trusted offers nothing", () => {
  const failures: Array<[string, (w: ReturnType<typeof world>) => void]> = [
    ["a reader that fails", (w) => w.reader.fail()],
    ["an answer that is not the contract", (w) => w.reader.answer({ models: ["claude-sonnet-5-5"] })],
    ["an empty list", (w) => w.reader.answer({ version: 1, models: [] })],
    ["a list with a name that is not a model name", (w) => w.reader.answer(offeredAnswer(["claude-sonnet-5-5", "a b"]))],
    ["a reader that never answers", (w) => w.reader.hang()],
  ];
  for (const [name, break_] of failures) {
    it(`${name}: no step runs, no change is made, and the page's read says so in fixed words (no cause)`, async () => {
      const w = world();
      const choice = w.choiceFor(ORG_A);
      await setBuild(choice, ORG_A, "claude-opus-5-5");
      break_(w);
      w.tick(OFFERED_MODELS_TTL_MS);
      const outcome = await stepOf(choice);
      expect(outcome).toMatchObject({ ok: false });
      expect(JSON.stringify(outcome)).not.toMatch(/gateway\.internal|ECONNREFUSED|opus/u);
      const change = await choice.service().apply(owner(ORG_A), { action: "set", stage: "plan", choice: { model: agentModelIdentity("claude-haiku-5-5") }, expectedRevision: 1 }, { fresh: true });
      expect(change).toMatchObject({ ok: false });
      expect(await revisionOf(choice)).toBe(1);
      await expect(choice.offered()).rejects.toThrow(OFFERED_MODELS_UNAVAILABLE);
    });
  }
});

describe("the seams over the list", () => {
  it("route, serve and servable are the list and nothing else", async () => {
    const reader = createFakeOfferedModels();
    reader.set(ORG_A, ["claude-sonnet-5-5", "zai.glm-5"]);
    const seams = gatewayModelSelectionSeams({ offered: createOfferedModelsView({ reader, companyId: ORG_A, now: () => 1 }), defaultModel: async () => DEFAULT });
    expect(await seams.servable()).toEqual([agentModelIdentity("claude-sonnet-5-5"), agentModelIdentity("zai.glm-5")]);
    expect(await seams.route(agentModelIdentity("zai.glm-5"))).toEqual({ alias: "zai.glm-5", api: "anthropic-messages", catalog: "zai.glm-5" });
    for (const model of [agentModelIdentity("zai.glm-4.7"), { provider: "amazon-bedrock", modelId: "claude-sonnet-5-5" }, { provider: "openai", modelId: "gpt-5" }]) {
      expect(await seams.route(model)).toBeUndefined();
      expect(await seams.canServe(model)).toBe(false);
    }
    reader.fail();
    const down = gatewayModelSelectionSeams({ offered: createOfferedModelsView({ reader, companyId: ORG_B, now: () => 1 }), defaultModel: async () => DEFAULT });
    expect(await down.route(agentModelIdentity("zai.glm-5"))).toBeUndefined();
    expect(await down.canServe(agentModelIdentity("zai.glm-5"))).toBe(false);
    await expect(down.servable()).rejects.toThrow(OFFERED_MODELS_UNAVAILABLE);
  });
});

describe("the step rule over a registry", () => {
  const registry = (w: ReturnType<typeof world>) => ({
    require: ((point: string) => point === "storage" ? w.store : point === "audit-sink" ? { stage: () => [], async record() {} } : { async requirement() { return { methods: [], minApprovers: 1, selfApprovalAllowed: true }; }, async verify() { return { approved: false, reason: "" }; } }) as never,
  });
  const route = { route: async () => gatewayRouteOf(DEFAULT) };
  it("takes the install's default model from the declared route when a step is chosen, and refuses the step when no route is declared", async () => {
    const w = world();
    const made = agentModelChoiceFromRegistry({ registry: registry(w), companyId: ORG_A, reader: w.reader, modelAccess: route, now: () => 1 })!;
    expect(await stepOf(made)).toMatchObject({ ok: true, step: { route: { alias: DEFAULT } } });
    const none = agentModelChoiceFromRegistry({ registry: registry(w), companyId: ORG_A, reader: w.reader, modelAccess: { route: async () => undefined }, now: () => 1 })!;
    expect(await stepOf(none)).toMatchObject({ ok: false });
  });
});

describe("the broker root's companies", () => {
  const registryOf = (w: ReturnType<typeof world>) => ({
    require: ((point: string) => point === "storage" ? w.store : point === "audit-sink" ? { stage: () => [], async record() {} } : { async requirement() { return { methods: [], minApprovers: 1, selfApprovalAllowed: true }; }, async verify() { return { approved: false, reason: "" }; } }) as never,
  });
  const options = { modelAccess: { route: async () => gatewayRouteOf(DEFAULT) } };
  it("with a reader: one rule per company, the engine's and the page's the same one, each over its own list and its own setting", async () => {
    const w = world();
    w.reader.set(ORG_A, GATEWAY_OFFERED_MODELS);
    w.reader.set(ORG_B, ["claude-sonnet-5-5"]);
    const choices = createCompanyModelChoices({ reader: w.reader, now: () => 1 });
    const a = choices.flowOptionsFor(registryOf(w), ORG_A, options);
    const b = choices.flowOptionsFor(registryOf(w), ORG_B, options);
    expect(choices.choiceFor(ORG_A)!.stepModels).toBe(a.stepModels);
    expect(choices.choiceFor(ORG_B)!.stepModels).toBe(b.stepModels);
    expect(a.stepModels).not.toBe(b.stepModels);
    expect(choices.choiceFor("org_neverbuilt000000000x")).toBeUndefined();
    expect(options).not.toHaveProperty("stepModels");
    // A's page changes A's setting only: A's engine rule follows, B's does not.
    expect(await setBuild(choices.choiceFor(ORG_A)!, ORG_A, "zai.glm-5")).toMatchObject({ ok: true });
    expect(await a.stepModels!.choose({ stage: "build" })).toMatchObject({ ok: true, step: { route: { alias: "zai.glm-5" } } });
    expect(await b.stepModels!.choose({ stage: "build" })).toMatchObject({ ok: true, step: { route: { alias: DEFAULT } } });
    expect(await setBuild(choices.choiceFor(ORG_B)!, ORG_B, "zai.glm-5")).toMatchObject({ ok: false, code: "model_unavailable" });
    expect((await choices.choiceFor(ORG_B)!.offered()).map((entry) => entry.model)).toEqual(["claude-sonnet-5-5"]);
  });
});

describe("broker-validated model choices stored on the company's existing model-policy row", () => {
  it("uses a validated choice through the dispatcher without asking the offered-models route", async () => {
    const w = world();
    const choice = w.choiceFor(ORG_A);
    await setBuild(choice, ORG_A, "zai.glm-5");
    await choice.service().state();
    const before = w.reader.asked.length;
    const stored = storedAgentModelChoice({ store: w.store, companyId: ORG_A, now: () => 1_000_000 });
    expect(await stored.choose({ stage: "build" })).toMatchObject({ ok: true, step: { route: { alias: "zai.glm-5" } } });
    expect(w.reader.asked).toHaveLength(before);
    expect(await storedAgentModelChoice({ store: w.store, companyId: ORG_B, now: () => 1_000_000 }).choose({ stage: "build" })).toEqual({ ok: false, code: "MODEL_STALE", words: STORED_MODEL_CHOICE_UNAVAILABLE });
  });

  it.each(["expired", "future", "malformed", "other-company", "wrong-key", "revision-changed"])("refuses a %s snapshot with fixed words", async (bad) => {
    const w = world();
    await w.choiceFor(ORG_A).service().state();
    const key = modelSelectionPolicyKey(ORG_A);
    const row = (await w.store.get(key))!;
    const snapshot = row["agentModelValidation"] as Record<string, unknown>;
    // A genuinely expired, otherwise valid interval: the expiry guard alone must refuse it.
    if (bad === "future") snapshot["validatedAt"] = 1_000_001;
    if (bad === "malformed") snapshot["offered"] = { version: 1, models: [] };
    if (bad === "other-company") row["orgId"] = ORG_B;
    if (bad === "wrong-key") row["pk"] = modelSelectionPolicyKey(ORG_B).pk;
    if (bad === "revision-changed") row["revision"] = 3;
    await w.store.put({ item: { ...row, ...key } });
    // Wrong key is represented by a faulty adapter response, not a legitimate write to another key.
    const store = bad === "wrong-key" ? { get: async () => ({ ...row, pk: modelSelectionPolicyKey(ORG_B).pk }) } : w.store;
    expect(await storedAgentModelChoice({ store, companyId: ORG_A, now: () => bad === "expired" ? 1_060_000 : 1_000_000 }).choose({ stage: "build" })).toEqual({ ok: false, code: "MODEL_STALE", words: STORED_MODEL_CHOICE_UNAVAILABLE });
  });
});
