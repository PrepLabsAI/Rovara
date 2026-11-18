// DEC 254zzz96 (2): the gateway may publish each offered model's list price, for the company's step models card. The field is optional (a list
// without prices reads exactly as before), checked strictly (a price that is not two amounts refuses the WHOLE list, never a partial one), and
// passed through untouched to the page; the engine's choice, its stored validation and the dispatcher's copy work the same with or without it.
import { describe, expect, it } from "vitest";
import { OfferedAgentModelsSchema, agentModelIdentity, type Principal } from "@agentx/contracts";
import { createAgentModelChoice, type OfferedModelsReader } from "../../packages/broker/src/core-host/gateway-model-selection.js";
import { dispatcherStoredAgentModelChoice } from "../../packages/broker/src/core-host/stored-agent-model-choice.js";
import { createLocalOwnerApprovers, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createHarness } from "../support/task-flow-harness.js";
import { modelSelectionPolicyKey } from "../../packages/broker/src/core/model-selection/policy-store.js";

const PRICED = { version: 1, models: [
  { model: "claude-sonnet-5-5", price: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
  { model: "zai.glm-5", price: { inputUsdPerMillion: 1, outputUsdPerMillion: 3.2 } },
  { model: "qwen.qwen3-coder-480b-a35b-v1:0" },
] };

describe("the offered list's optional price", () => {
  it("a list with prices, without them, or with some reads; the price is kept as given", () => {
    expect(OfferedAgentModelsSchema.parse(PRICED).models[1]).toEqual({ model: "zai.glm-5", price: { inputUsdPerMillion: 1, outputUsdPerMillion: 3.2 } });
    expect(OfferedAgentModelsSchema.safeParse({ version: 1, models: [{ model: "zai.glm-5" }] }).success).toBe(true);
  });
  it.each([
    { inputUsdPerMillion: -1, outputUsdPerMillion: 1 }, { inputUsdPerMillion: 1 }, { inputUsdPerMillion: "1", outputUsdPerMillion: 1 }, { inputUsdPerMillion: 1, outputUsdPerMillion: Number.POSITIVE_INFINITY },
    { inputUsdPerMillion: 1, outputUsdPerMillion: 10_001 }, { inputUsdPerMillion: 1, outputUsdPerMillion: 1, currency: "EUR" }, null, 3,
  ])("a price that is not two amounts refuses the whole list (%j)", (price) => {
    expect(OfferedAgentModelsSchema.safeParse({ version: 1, models: [{ model: "claude-sonnet-5-5" }, { model: "zai.glm-5", price }] }).success).toBe(false);
  });
});

describe("the engine with a priced list", () => {
  async function world() {
    const h = createHarness();
    const company = h.deps.companyId;
    const reader: OfferedModelsReader = { offered: async () => PRICED };
    const choice = createAgentModelChoice({ store: h.store, companyId: company, audit: h.deps.audit, approvers: createLocalOwnerApprovers({ now: () => new Date(h.clock.now) }), reader, now: () => h.clock.now, defaultModel: async () => "claude-sonnet-5-5" });
    const owner = { ...localOwnerPrincipal({ companyId: company }), authTime: new Date(h.clock.now).toISOString() } as Principal;
    return { h, company, choice, owner };
  }
  it("the page's list carries the prices; a step is set, chosen and stored as before", async () => {
    const w = await world();
    expect(await w.choice.offered()).toEqual(PRICED.models);
    expect(await w.choice.service().apply(w.owner, { action: "set", stage: "build", choice: { model: agentModelIdentity("zai.glm-5") }, expectedRevision: 0 }, { fresh: true })).toMatchObject({ ok: true });
    expect(await w.choice.stepModels.choose({ stage: "build" })).toMatchObject({ ok: true, step: { route: { alias: "zai.glm-5" } } });
    const dispatcher = dispatcherStoredAgentModelChoice({ store: w.h.store, companyId: w.company, now: () => w.h.clock.now, defaultRoute: async () => ({ alias: "claude-sonnet-5-5", api: "anthropic-messages", catalog: "claude-sonnet-5-5" }), log: () => undefined });
    expect(await dispatcher.choose({ stage: "build" })).toMatchObject({ ok: true, step: { route: { alias: "zai.glm-5" } } });
    expect(await dispatcher.choose({ stage: "plan" })).toMatchObject({ ok: true, step: { route: { alias: "claude-sonnet-5-5" } } });
    // The stored validation keeps the names only: never a price (an older dispatcher reads it during a rolling upgrade; a rollback never meets a priced row).
    const row = (await w.h.store.get(modelSelectionPolicyKey(w.company)))!;
    expect(JSON.stringify(row["agentModelValidation"])).not.toContain("price");
    expect((row["agentModelValidation"] as { offered: { models: unknown[] } }).offered.models).toEqual(PRICED.models.map(({ model }) => ({ model })));
  });
});
