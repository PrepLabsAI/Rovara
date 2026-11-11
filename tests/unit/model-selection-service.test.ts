// The model each step uses: the owner's setting on the document store (the hosted layout), what each step runs on by default, the fallback, the price rule where a limit is held, what a refused call teaches, and the
// owner's own change (fresh page, current revision, an approval rule for a less-safe one, audited in the same transaction).
import { describe, expect, it } from "vitest";
import {
  ModelSelectionStateSchema, canonicalModelName, modelSelectionLines, orgSettingsKey,
  type Approvers, type AuditEvent, type ModelProviderAdapter, type AuditSink, type InvocationModelRoute, type ModelIdentifier, type OrgId, type Principal,
} from "@agentx/contracts";
import { createModelPrices, type CatalogPrices } from "../../packages/broker/src/core/cost/price-table.js";
import { createModelSelection, type ModelSelectionSeams } from "../../packages/broker/src/core/model-selection/service.js";
import { MODEL_USABILITY_KEY, createUsableModels, withoutUnusable } from "../../packages/broker/src/core/model-selection/usable-models.js";
import { learnModelNotEnabled, modelsNotEnabled } from "../../packages/broker/src/core/model-selection/learn-not-enabled.js";
import { readModelSelectionPolicy } from "../../packages/broker/src/core/model-selection/policy-store.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";

const ORG = "org_00000000000000000000" as OrgId;
const owner: Principal = localOwnerPrincipal({ companyId: ORG });
const m = (provider: string, modelId: string): ModelIdentifier => ({ provider, modelId });
const SONNET = m("anthropic", "claude-sonnet-4-5");
const OPUS = m("anthropic", "claude-opus-4-5");
const HAIKU = m("anthropic", "claude-haiku-4-5");
const GPT = m("openai", "gpt-5");
const GEMINI = m("openrouter", "google/gemini-2.5-pro");
const UNPRICED = m("company-gateway", "house-model");
const PRICE: CatalogPrices = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const priced = new Set([SONNET, OPUS, HAIKU, GPT, GEMINI].map((model) => `${model.provider}/${model.modelId}`));

interface Options {
  install?: ModelIdentifier | undefined;
  /** What the install can serve (also what can be called). */
  servable?: ModelIdentifier[];
  cap?: boolean;
  approvers?: Approvers;
  fresh?: boolean;
  /** Plug-in providers (their own price tables). */
  providers?: ModelProviderAdapter[];
  /** What a policy that does not say reads as. */
  defaultReviewDefault?: "install-model" | "different-company";
}

function world(options: Options = {}) {
  const store = new MemoryDocumentStore();
  const events: AuditEvent[] = [];
  const audit: AuditSink = { stage: (event) => { events.push(event); return []; }, async record() {} };
  let clock = 1_000_000;
  const state = { install: "install" in options ? options.install : SONNET, servable: options.servable ?? [SONNET, OPUS, HAIKU, GPT, GEMINI], cap: options.cap === true, down: new Set<string>() };
  const key = (model: ModelIdentifier): string => `${model.provider}/${model.modelId}`;
  const seams: ModelSelectionSeams = {
    async servable() { return state.servable; },
    async canServe(model) { return !state.down.has(key(model)) && (state.servable.some((other) => key(other) === key(model)) || (state.install !== undefined && key(state.install) === key(model))); },
    async installModel() { return state.install; },
    async route(model): Promise<InvocationModelRoute> { return { alias: key(model), api: "anthropic-messages", catalog: model.modelId }; },
  };
  const usable = createUsableModels({ store, now: () => clock });
  const approvers: Approvers = options.approvers ?? { async requirement() { return { methods: ["local-session"], minApprovers: 1, selfApprovalAllowed: true }; }, async verify() { return { approved: false, reason: "unused" }; } };
  const selection = createModelSelection({
    store, companyId: ORG, audit, approvers, usable, now: () => clock, capApplies: () => state.cap, ...(options.defaultReviewDefault === undefined ? {} : { defaultReviewDefault: options.defaultReviewDefault }),
    prices: createModelPrices({ providers: () => options.providers ?? [], catalog: (model) => (priced.has(key(model)) ? PRICE : undefined) }),
    seams,
  });
  const apply = (body: unknown, fresh = options.fresh ?? true) => selection.apply(owner, body, { fresh });
  const stage = async (name: Parameters<typeof selection.choose>[0]["stage"], reference?: ModelIdentifier) => selection.choose({ stage: name, ...(reference === undefined ? {} : { reference }) });
  return { store, events, selection, state, usable, apply, stage, tick: (ms: number) => { clock += ms; }, key };
}

const modelOf = async (result: ReturnType<ReturnType<typeof world>["stage"]>) => { const found = await result; return found.ok ? found.step : undefined; };
const ref = (model: ModelIdentifier): { provider: string; modelId: string } => ({ provider: model.provider, modelId: model.modelId });

describe("the model each step uses: what a step runs on with nothing set", () => {
  it("every step runs on the install's model, a checking step says it is the same model, and each carries its proxy route", async () => {
    const w = world();
    for (const name of ["understand", "plan", "build", "pull_request"] as const) {
      const step = (await modelOf(w.stage(name)))!;
      expect(step.model).toEqual(SONNET);
      expect(step.reason).toBe("BUILTIN_DEFAULT");
      expect(step.route).toEqual({ alias: "anthropic/claude-sonnet-4-5", api: "anthropic-messages", catalog: "claude-sonnet-4-5" });
      expect(step.sameModelAsChecked).toBe(false);
    }
    for (const name of ["plan_check", "code_review", "security_review"] as const) {
      const step = (await modelOf(w.stage(name)))!;
      expect(step).toMatchObject({ model: SONNET, reason: "INSTALL_MODEL", sameModelAsChecked: true });
    }
  });

  it("an install with no model at all has no model to choose, whatever the stage", async () => {
    const w = world({ install: undefined, servable: [] });
    for (const name of ["plan", "plan_check", "build"] as const) expect(await w.stage(name)).toMatchObject({ ok: false, code: "NO_MODEL" });
  });

  it("the state is a valid answer, one row per step, and reads as plain lines", async () => {
    const w = world();
    const state = ModelSelectionStateSchema.parse(await w.selection.state());
    expect(state.steps.map((step) => step.stage)).toEqual(["understand", "plan", "plan_check", "build", "code_review", "security_review", "pull_request"]);
    expect(state).toMatchObject({ revision: 0, reviewDefault: "install-model", runLimit: { enforced: false }, install: SONNET });
    expect(state.models.length).toBeGreaterThan(0);
    const lines = modelSelectionLines(state);
    expect(lines[0]).toBe("understand: anthropic:claude-sonnet-4-5 (default; $3.00 in, $15.00 out per million tokens)");
    expect(lines.some((line) => line.startsWith("plan check:") && line.includes("the same model as the step it checks"))).toBe(true);
    expect(lines.at(-1)).toContain("No run limit is held");
  });
});

describe("the model each step uses: the owner's setting", () => {
  it("a model set for the plan steps is used by both of its group, kept in the hosted layout, and the others keep the default", async () => {
    const w = world();
    const done = await w.apply({ action: "set", stage: "plan", choice: { model: ref(GPT), thinkingLevel: "high" }, expectedRevision: 0 });
    expect(done).toEqual({ ok: true, revision: 1, lessSafe: [] });
    for (const name of ["understand", "plan"] as const) expect(await modelOf(w.stage(name))).toMatchObject({ model: GPT, thinkingLevel: "high", reason: "COMPANY_DEFAULT" });
    expect(await modelOf(w.stage("build"))).toMatchObject({ model: SONNET, thinkingLevel: null });
    // The row is the hosted product's company policy row: its key, its attributes (and no more than one added).
    const item = await w.store.get(orgSettingsKey(ORG, "MODEL_SELECTION_POLICY"));
    expect(item).toMatchObject({
      pk: `ORG#${ORG}#SETTINGS`, sk: "MODEL_SELECTION_POLICY", entityType: "MODEL_SELECTION_POLICY", orgId: ORG, version: 1, revision: 1, rankingVersion: "g3-v1", updatedBy: "local-owner",
      stepOverrides: { understand: { model: ref(GPT), thinkingLevel: "high", locked: false }, plan: { model: ref(GPT), thinkingLevel: "high", locked: false } },
    });
    expect(Object.keys(item!).sort()).toEqual(["entityType", "orgId", "pk", "rankingVersion", "reviewDefault", "revision", "sk", "stepOverrides", "updatedAt", "updatedBy", "version"]);
    expect(item!["reviewDefault"]).toBe("install-model");
    expect(await readModelSelectionPolicy(w.store, ORG)).toMatchObject({ revision: 1, reviewDefault: "install-model" });
    // Audited in the same transaction.
    expect(w.events.map((event) => event.action)).toEqual(["model.policy.changed"]);
  });

  it("the code and security reviews share one setting, and clearing a step goes back to the default", async () => {
    const w = world();
    expect((await w.apply({ action: "set", stage: "security_review", choice: { model: ref(GPT) }, expectedRevision: 0 })).ok).toBe(true);
    expect(await modelOf(w.stage("code_review"))).toMatchObject({ model: GPT });
    expect(await modelOf(w.stage("security_review"))).toMatchObject({ model: GPT });
    expect((await w.apply({ action: "clear", stage: "code_review", expectedRevision: 1 })).ok).toBe(true);
    expect(await modelOf(w.stage("code_review"))).toMatchObject({ model: SONNET, sameModelAsChecked: true });
    expect(await readModelSelectionPolicy(w.store, ORG)).toMatchObject({ revision: 2, stepOverrides: {} });
  });

  it("a backup model is used when the first cannot be called, and the step says so", async () => {
    const w = world();
    expect((await w.apply({ action: "set", stage: "build", choice: { model: ref(GPT), fallbackModel: ref(OPUS) }, expectedRevision: 0 })).ok).toBe(true);
    expect(await modelOf(w.stage("build"))).toMatchObject({ model: GPT, reason: "COMPANY_DEFAULT" });
    w.state.down.add(w.key(GPT));
    const step = (await modelOf(w.stage("build")))!;
    expect(step.model).toEqual(OPUS);
    expect(step.fallback).toMatchObject({ stage: "build", used: "anthropic/claude-opus-4-5", wanted: "openai/gpt-5", reasonCode: "CONFIGURED_FALLBACK" });
    // With neither callable the owner's choice is not quietly replaced by another model: the step has none, and says why.
    w.state.down.add(w.key(OPUS));
    expect(await w.stage("build")).toMatchObject({ ok: false, code: "MODEL_NOT_VERIFIED" });
  });

  it("a checking step set to a different company's model, or to be different from the step it checks, is held to it", async () => {
    const w = world();
    expect((await w.apply({ action: "set", stage: "plan_check", choice: { differentFrom: { stage: "plan", level: "vendor" } }, expectedRevision: 0 })).ok).toBe(true);
    const checked = (await modelOf(w.stage("plan_check")))!;
    expect(checked.model.provider).not.toBe("anthropic");
    expect(checked).toMatchObject({ sameModelAsChecked: false });
    // The model the plan ran on is told, and the check differs from it.
    expect((await modelOf(w.stage("plan_check", GPT)))!.model.provider).not.toBe("openai");
  });

  it("a checking step nobody set can be asked to use the strongest model of a different AI company", async () => {
    const w = world();
    expect((await w.apply({ action: "review-default", value: "different-company", expectedRevision: 0 })).ok).toBe(true);
    const step = (await modelOf(w.stage("plan_check")))!;
    expect(step.reason).toBe("DEFAULT_DIFFERENT_COMPANY");
    expect(step.model.provider).not.toBe("anthropic");
    expect(step.sameModelAsChecked).toBe(false);
    expect(await readModelSelectionPolicy(w.store, ORG)).toMatchObject({ reviewDefault: "different-company" });
    // With only one company's models the check still runs, on another model of that company (never refused), and a non-checking step is untouched.
    const alone = world({ servable: [SONNET, OPUS, HAIKU] });
    await alone.apply({ action: "review-default", value: "different-company", expectedRevision: 0 });
    const same = (await modelOf(alone.stage("plan_check")))!;
    expect(same.model.provider).toBe("anthropic");
    expect(await modelOf(alone.stage("build"))).toMatchObject({ model: SONNET, reason: "BUILTIN_DEFAULT" });
  });
});

describe("the model each step uses: what a refused call teaches, and the price rule where a limit is held", () => {
  it("a model a call to which was refused is left out of a default choice for a while, then comes back", async () => {
    const w = world();
    await w.apply({ action: "review-default", value: "different-company", expectedRevision: 0 });
    const first = (await modelOf(w.stage("plan_check")))!;
    expect(first.model.provider).not.toBe("anthropic");
    await w.usable.markUnusable(first.model);
    const second = (await modelOf(w.stage("plan_check")))!;
    expect(canonicalModelName(second.model)).not.toBe(canonicalModelName(first.model));
    w.tick(31 * 60_000);
    expect(canonicalModelName((await modelOf(w.stage("plan_check")))!.model)).toBe(canonicalModelName(first.model));
  });

  it("with a limit held a model with no price is not used, and one that has a price is", async () => {
    const free = world({ install: UNPRICED, servable: [UNPRICED] });
    expect((await modelOf(free.stage("build")))?.model).toEqual(UNPRICED);
    const capped = world({ install: UNPRICED, servable: [UNPRICED], cap: true });
    const refused = await capped.stage("build");
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { words: string }).words).toContain("company-gateway/house-model has no price, and a run limit is held");
    expect(await capped.stage("plan_check")).toMatchObject({ ok: false });
    expect(ModelSelectionStateSchema.parse(await capped.selection.state()).steps.every((step) => step.refusal !== undefined)).toBe(true);
    const fine = world({ cap: true });
    expect((await modelOf(fine.stage("build")))?.model).toEqual(SONNET);
  });

  it("a backup with a price takes over from a model with none while a limit is held, and the owner cannot set an unpriced model then", async () => {
    const w = world({ install: UNPRICED, servable: [UNPRICED, OPUS], cap: true });
    const refused = await w.apply({ action: "set", stage: "build", choice: { model: ref(UNPRICED) }, expectedRevision: 0 });
    expect(refused).toMatchObject({ ok: false, code: "model_unavailable" });
    expect((refused as { words: string }).words).toContain("no price while a run limit is held");
    expect((await w.apply({ action: "set", stage: "build", choice: { model: ref(OPUS) }, expectedRevision: 0 })).ok).toBe(true);
    expect(await modelOf(w.stage("build"))).toMatchObject({ model: OPUS });
  });

  it("learns a model from a failed step only when the failure says the model cannot be used", async () => {
    const w = world();
    const refusedCall = { model: GPT };
    expect(modelsNotEnabled(refusedCall, "FAILED", "the model call failed: key-rejected ModelNotEnabled HTTP 403", undefined)).toEqual([GPT]);
    expect(modelsNotEnabled(refusedCall, "FAILED", "the model call failed: key-rejected attempt 1", undefined)).toEqual([]);
    expect(modelsNotEnabled(refusedCall, "SUCCEEDED", "the model call failed: key-rejected ModelNotEnabled", undefined)).toEqual([]);
    expect(modelsNotEnabled({ model: undefined }, "FAILED", "the model call failed: key-rejected ModelNotEnabled", undefined)).toEqual([]);
    await learnModelNotEnabled(w.usable, refusedCall, "FAILED", "the model call failed: key-rejected attempt 1", undefined);
    expect([...(await w.usable.unusable())]).toEqual([]);
    await learnModelNotEnabled(w.usable, refusedCall, "FAILED", "the model call failed: key-rejected ModelNotEnabled HTTP 403", undefined);
    expect([...(await w.usable.unusable())]).toEqual([canonicalModelName(GPT)]);
    // The record is one row under the hosted layout's key, and a mark from the future never counts.
    expect(Object.keys((await w.store.get(MODEL_USABILITY_KEY))!).filter((name) => name.startsWith("failed#"))).toEqual([`failed#${canonicalModelName(GPT)}`]);
    await w.store.update({ key: MODEL_USABILITY_KEY, ops: [{ op: "set", path: ["failed#claude-opus-4-5"], value: 10_000_000_000_000 }] });
    expect([...(await w.usable.unusable())]).toEqual([canonicalModelName(GPT)]);
    expect(withoutUnusable([GPT, SONNET], new Set([canonicalModelName(GPT)]))).toEqual([SONNET]);
    // Never narrowed to nothing.
    expect(withoutUnusable([GPT], new Set([canonicalModelName(GPT)]))).toEqual([GPT]);
  });
});

const gatewayWith = (prices: ModelProviderAdapter["prices"]): ModelProviderAdapter => ({
  kind: "company-gateway", name: "Gateway", address: "https://models.example.test/v1", signIn: { kind: "bearer-key" },
  formats: [{ format: "openai-completions", capabilities: { forcedToolChoice: true, parallelToolCalls: true, reasoning: "none", reasoningReturned: false, promptCaching: false, streamUsage: true } }],
  ...(prices === undefined ? {} : { prices }),
});

describe("the model each step uses: prices in another currency, and what a missing setting reads as", () => {
  it("a model priced in another currency is no price to a dollar cap: it is not offered under a limit and cannot be set, and without a limit it runs", async () => {
    const euro = gatewayWith({ currency: "EUR", models: { "house-model": { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 } } });
    const capped = world({ install: UNPRICED, servable: [UNPRICED, OPUS], cap: true, providers: [euro] });
    const refused = await capped.stage("build");
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { words: string }).words).toContain("company-gateway/house-model has no price");
    expect(await capped.apply({ action: "set", stage: "build", choice: { model: ref(UNPRICED) }, expectedRevision: 0 })).toMatchObject({ ok: false, code: "model_unavailable" });
    expect(ModelSelectionStateSchema.parse(await capped.selection.state()).models.find((entry) => entry.model.modelId === "house-model")).toMatchObject({ priced: false });
    expect((await modelOf(world({ install: UNPRICED, servable: [UNPRICED], providers: [euro] }).stage("build")))?.model).toEqual(UNPRICED);
    // In dollars the same table is a price.
    const dollars = gatewayWith({ currency: "USD", models: { "house-model": { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 } } });
    expect((await modelOf(world({ install: UNPRICED, servable: [UNPRICED], cap: true, providers: [dollars] }).stage("build")))?.model).toEqual(UNPRICED);
  });

  it("what a policy that says nothing about checking steps reads as is the host's to say: the install's model on a laptop, another company's model for a host whose rule that is", async () => {
    const laptop = world();
    expect((await readModelSelectionPolicy(laptop.store, ORG)).reviewDefault).toBe("install-model");
    const host = world({ defaultReviewDefault: "different-company" });
    expect(await readModelSelectionPolicy(host.store, ORG, "different-company")).toMatchObject({ revision: 0, reviewDefault: "different-company" });
    expect((await modelOf(host.stage("plan_check")))!.reason).toBe("DEFAULT_DIFFERENT_COMPANY");
    // A row a host wrote (no attribute) reads as the host's default; one that says reads as it says; a write made here always says.
    await host.store.put({ item: { ...orgSettingsKey(ORG, "MODEL_SELECTION_POLICY"), entityType: "MODEL_SELECTION_POLICY", orgId: ORG, version: 1, revision: 2, rankingVersion: "g3-v1", stepOverrides: {}, updatedAt: "2026-11-10T00:00:00.000Z", updatedBy: "x" } });
    expect((await readModelSelectionPolicy(host.store, ORG, "different-company")).reviewDefault).toBe("different-company");
    expect((await host.apply({ action: "review-default", value: "install-model", expectedRevision: 2 })).ok).toBe(true);
    expect((await host.store.get(orgSettingsKey(ORG, "MODEL_SELECTION_POLICY")))!["reviewDefault"]).toBe("install-model");
    expect((await readModelSelectionPolicy(host.store, ORG, "different-company")).reviewDefault).toBe("install-model");
    expect((await modelOf(host.stage("plan_check")))!.reason).toBe("INSTALL_MODEL");
  });
});

describe("the model each step uses: the owner's change", () => {
  it("is refused outside a page opened lately, against an old revision, or for something the setting does not offer", async () => {
    const w = world();
    expect(await w.apply({ action: "set", stage: "plan", choice: { model: ref(GPT) }, expectedRevision: 0 }, false)).toMatchObject({ ok: false, code: "reauth_required" });
    expect(await w.apply({ action: "set", stage: "plan", choice: { model: ref(GPT) }, expectedRevision: 3 })).toMatchObject({ ok: false, code: "stale" });
    expect(await w.apply({ action: "set", stage: "nonsense", choice: {}, expectedRevision: 0 })).toMatchObject({ ok: false, code: "invalid" });
    // A choice that sets nothing is not a setting (clearing a step is its own action).
    expect(await w.apply({ action: "set", stage: "plan", choice: {}, expectedRevision: 0 })).toMatchObject({ ok: false, code: "invalid" });
    expect(await w.apply({ action: "set", stage: "plan", choice: { differentFrom: { stage: "plan", level: "model" } }, expectedRevision: 0 })).toMatchObject({ ok: false, code: "invalid" });
    expect(await w.apply({ action: "set", stage: "plan", choice: { model: { provider: "nowhere", modelId: "ghost" } }, expectedRevision: 0 })).toMatchObject({ ok: false, code: "model_unavailable" });
    expect(await readModelSelectionPolicy(w.store, ORG)).toMatchObject({ revision: 0 });
    expect(w.events).toEqual([]);
    // A change made against the revision it read goes through once; the same page sent again is stale, not a second write.
    expect((await w.apply({ action: "set", stage: "plan", choice: { model: ref(GPT) }, expectedRevision: 0 })).ok).toBe(true);
    expect(await w.apply({ action: "set", stage: "plan", choice: { model: ref(GPT) }, expectedRevision: 0 })).toMatchObject({ ok: false, code: "stale" });
  });

  it("two changes made against the same revision at once: one is made, the other is told the setting moved, and nothing is lost", async () => {
    const w = world();
    const [first, second] = await Promise.all([
      w.apply({ action: "set", stage: "plan", choice: { model: ref(GPT) }, expectedRevision: 0 }),
      w.apply({ action: "set", stage: "build", choice: { model: ref(OPUS) }, expectedRevision: 0 }),
    ]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    expect([first, second].find((result) => !result.ok)).toMatchObject({ code: "stale" });
    // Exactly one of the two settings is there (the other was not written over it).
    const kept = Object.keys((await readModelSelectionPolicy(w.store, ORG)).stepOverrides);
    expect(await readModelSelectionPolicy(w.store, ORG)).toMatchObject({ revision: 1 });
    expect(kept.length === 2 ? kept.includes("plan") && kept.includes("understand") : kept[0] === "build").toBe(true);
  });

  it("a checking step cannot be set to the model of the step it checks", async () => {
    const w = world();
    await w.apply({ action: "set", stage: "build", choice: { model: ref(OPUS) }, expectedRevision: 0 });
    const refused = await w.apply({ action: "set", stage: "code_review", choice: { model: ref(OPUS) }, expectedRevision: 1 });
    expect(refused).toMatchObject({ ok: false, code: "same_model" });
    // Another model of the same maker is another model; the company is a different rule (differentFrom).
    expect((await w.apply({ action: "set", stage: "code_review", choice: { model: ref(GPT) }, expectedRevision: 1 })).ok).toBe(true);
  });

  it("a check cannot be saved on the model the step it checks would run on when that step is left to the default", async () => {
    const w = world();
    // The plan is unset, so it runs on the install's model: a plan check set to that model would be refused at every dispatch.
    expect(await w.apply({ action: "set", stage: "plan_check", choice: { model: ref(SONNET) }, expectedRevision: 0 })).toMatchObject({ ok: false, code: "same_model" });
    expect(await w.apply({ action: "set", stage: "plan_check", choice: { fallbackModel: ref(SONNET) }, expectedRevision: 0 })).toMatchObject({ ok: false, code: "same_model" });
    expect((await w.apply({ action: "set", stage: "plan_check", choice: { model: ref(GPT) }, expectedRevision: 0 })).ok).toBe(true);
    // And the plan cannot then be moved onto the check's model.
    expect(await w.apply({ action: "set", stage: "plan", choice: { model: ref(GPT) }, expectedRevision: 1 })).toMatchObject({ ok: false, code: "same_model" });
  });

  it("a weaker model for a check that had none set, and giving up the different-company default, are said to be less safe", async () => {
    const w = world();
    const weaker = await w.apply({ action: "set", stage: "plan_check", choice: { model: ref(HAIKU) }, expectedRevision: 0 });
    expect(weaker).toMatchObject({ ok: true, lessSafe: ["Moves the company plan_check default to a weaker model"] });
    const host = world({ defaultReviewDefault: "different-company" });
    const given = await host.apply({ action: "review-default", value: "install-model", expectedRevision: 0 });
    expect(given).toMatchObject({ ok: true, lessSafe: ["Stops checking steps nobody set from using a different AI company's model"] });
    // Rules that need another person stop it.
    const strict = world({ defaultReviewDefault: "different-company", approvers: { async requirement() { return { methods: ["local-session"], minApprovers: 2, selfApprovalAllowed: false }; }, async verify() { return { approved: false, reason: "no" }; } } });
    expect(await strict.apply({ action: "review-default", value: "install-model", expectedRevision: 0 })).toMatchObject({ ok: false, code: "second_person_required" });
  });

  it("a less-safe change (a weaker model for a check) needs the approval rules to let the owner approve it, and says what is less safe", async () => {
    const w = world();
    await w.apply({ action: "set", stage: "plan_check", choice: { model: ref(OPUS) }, expectedRevision: 0 });
    const weaker = await w.apply({ action: "set", stage: "plan_check", choice: { model: ref(HAIKU) }, expectedRevision: 1 });
    expect(weaker).toMatchObject({ ok: true, revision: 2 });
    expect((weaker as { lessSafe: string[] }).lessSafe).toEqual(["Moves the company plan_check default to a weaker model"]);
    expect(w.events.at(-1)?.details).toMatchObject({ lessSafe: 1, revision: 2 });
    // Rules that need a different person cannot be met on a laptop: the change is not made.
    const strict = world({ approvers: { async requirement() { return { methods: ["local-session"], minApprovers: 2, selfApprovalAllowed: false }; }, async verify() { return { approved: false, reason: "no" }; } } });
    await strict.apply({ action: "set", stage: "plan_check", choice: { model: ref(OPUS) }, expectedRevision: 0 });
    expect(await strict.apply({ action: "set", stage: "plan_check", choice: { model: ref(HAIKU) }, expectedRevision: 1 })).toMatchObject({ ok: false, code: "second_person_required" });
    expect(await readModelSelectionPolicy(strict.store, ORG)).toMatchObject({ revision: 1, stepOverrides: { plan_check: { model: ref(OPUS) } } });
    // A rule that cannot be read is not an approval.
    const broken = world({ approvers: { async requirement() { throw new Error("down"); }, async verify() { return { approved: false, reason: "no" }; } } });
    await broken.apply({ action: "set", stage: "plan_check", choice: { model: ref(OPUS) }, expectedRevision: 0 });
    expect(await broken.apply({ action: "set", stage: "plan_check", choice: { model: ref(HAIKU) }, expectedRevision: 1 })).toMatchObject({ ok: false, code: "approval_unavailable" });
  });

  it("a row the hosted product wrote (no review default, a lock) is read, and a row that cannot be read is an error, never the default", async () => {
    const w = world();
    await w.store.put({ item: {
      ...orgSettingsKey(ORG, "MODEL_SELECTION_POLICY"), entityType: "MODEL_SELECTION_POLICY", orgId: ORG, version: 1, revision: 4, rankingVersion: "g3-v1",
      stepOverrides: { build: { model: ref(OPUS), thinkingLevel: "low", locked: true } }, updatedAt: "2026-11-10T00:00:00.000Z", updatedBy: "someone",
    } });
    const step = (await modelOf(w.stage("build")))!;
    expect(step).toMatchObject({ model: OPUS, thinkingLevel: "low", reason: "COMPANY_LOCK" });
    await w.store.put({ item: { ...orgSettingsKey(ORG, "MODEL_SELECTION_POLICY"), entityType: "MODEL_SELECTION_POLICY", orgId: ORG, version: 7, revision: -1 } });
    await expect(readModelSelectionPolicy(w.store, ORG)).rejects.toThrow("could not be read");
    expect(await w.stage("build")).toMatchObject({ ok: false, code: "MODEL_STALE" });
    expect(await w.apply({ action: "clear", stage: "build", expectedRevision: 0 })).toMatchObject({ ok: false, code: "settings_unreadable" });
  });
});
