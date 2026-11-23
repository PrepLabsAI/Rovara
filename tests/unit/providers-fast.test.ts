import { describe, expect, it, vi } from "vitest";
import { OfferedAgentModelsSchema, agentModelIdentity, agentModelName, isCoreAgentModelId, CompanyEngineModelBodySchema, ModelRouteSchema, sourceKindProblem, BROKER_SETTING_VALUE, type OrgId } from "@agentx/contracts";
import { gatewayModelSelectionSeams, createOfferedModelsView } from "../../packages/broker/src/core-host/gateway-model-selection.js";
import { publishAgentModelChoice, storedAgentModelChoice } from "../../packages/broker/src/core-host/stored-agent-model-choice.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { companyEngineModelRoute } from "../../packages/broker/src/core-host/company-engine-model.js";
import { mintTaskToken } from "../../packages/broker/src/core/model-gateway/token.js";
import { claimVector, signingWorld } from "../support/model-gateway.js";

const model = "openai/gpt-5-mini";
const companyId = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const identity = { provider: "openrouter" as const, sourceId: "company-openrouter", connectionRevision: "r7", modelId: model };
const entry = { model, identity };
const now = 1_800_000_000_000;
const price = { companyId, model, provider: "openrouter", sourceId: identity.sourceId, connectionRevision: identity.connectionRevision, catalogModel: model, snapshotHash: "a".repeat(64), snapshotVersion: 7, expiresAt: now + 60_000, inputUsdPerMillion: 1, outputUsdPerMillion: 4, cacheWriteUsdPerMillion: 1, cacheReadUsdPerMillion: 1 };

describe("provider identity", () => {
  it("keeps exact OpenRouter ids through company/install and packed defaults", () => {
    expect(agentModelIdentity(model)).toEqual({ provider: "openrouter", modelId: model });
    expect(agentModelName({ provider: "openrouter", modelId: model })).toBe(model);
    expect(agentModelName({ provider: "amazon-bedrock", modelId: model })).toBeUndefined();
    expect(isCoreAgentModelId(model)).toBe(true);
    expect(CompanyEngineModelBodySchema.safeParse({ model }).success).toBe(true);
    expect(isCoreAgentModelId("anthropic/claude-sonnet-5-5")).toBe(true);
    for (const bad of ["a/b/c", "https://example.com", "/model", "openai/auto", "openai/model:free", "openai/model,aa=x"]) expect(isCoreAgentModelId(bad), bad).toBe(false);
    expect(BROKER_SETTING_VALUE.test(model)).toBe(true);
  });
  it("requires a complete consistent connection identity for slash IDs, retaining legacy readers", () => {
    expect(OfferedAgentModelsSchema.safeParse({ version: 1, models: [entry] }).success).toBe(true);
    expect(OfferedAgentModelsSchema.safeParse({ version: 1, models: [{ model: "claude-sonnet-5-5" }] }).success).toBe(true);
    for (const bad of [{ model }, { ...entry, identity: { ...identity, provider: "bedrock" } }, { ...entry, identity: { ...identity, modelId: "openai/other" } }, { ...entry, identity: { provider: "openrouter" } }]) expect(OfferedAgentModelsSchema.safeParse({ version: 1, models: [bad] }).success).toBe(false);
  });
  it("preserves connection identity through live selection and stored dispatcher choice", async () => {
    const offered = { version: 1, models: [entry] };
    const view = createOfferedModelsView({ companyId, now: () => now, reader: { offered: async () => offered } });
    const seams = gatewayModelSelectionSeams({ offered: view, defaultModel: async () => model });
    expect(await seams.route({ provider: "openrouter", modelId: model })).toEqual({ alias: model, catalog: model, api: "anthropic-messages", identity });
    const store = new MemoryDocumentStore();
    await publishAgentModelChoice({ companyId, store, offered, defaultModel: model, now: () => now });
    expect(await storedAgentModelChoice({ companyId, store, now: () => now }).choose({ stage: "build" })).toMatchObject({ ok: true, step: { model: { provider: "openrouter", modelId: model }, route: { identity } } });
    expect(ModelRouteSchema.safeParse({ alias: model, catalog: model, api: "anthropic-messages", identity }).success).toBe(true);
  });
  it("binds the install default to the company connection even without the step picker", async () => {
    const store = new MemoryDocumentStore();
    const install = { route: async () => ({ alias: model, catalog: model, api: "anthropic-messages" as const }) };
    const route = companyEngineModelRoute({ companyId, store, install, offered: async () => ({ version: 1, models: [entry] }) });
    expect(await route.route()).toMatchObject({ identity });
    await expect(companyEngineModelRoute({ companyId, store, install }).route()).rejects.toThrow();
  });
  // DEC 254zzz241: turning on bedrock/openrouter custom sources is a human launch decision; the launch list stays the gate.
  it("keeps the two provider kinds behind the launch list until a person turns them on", () => {
    for (const kind of ["bedrock", "openrouter"] as const) {
      expect(sourceKindProblem(kind, undefined, { kinds: [] })).toBe(`${kind} sources aren't available yet`);
      expect(sourceKindProblem(kind, undefined, { kinds: [kind] })).toBeUndefined();
    }
    expect(sourceKindProblem("endpoint")).toBeDefined();
  });
});

describe("provider signed ceiling before signing", () => {
  const vector = claimVector();
  const operation = { workspaceId: vector.ws, operationId: vector.op, fence: 1 };
  const description = { companyId, project: vector.pid, payer: vector.pay, taskId: vector.tid, step: "build", models: [model] };
  it("signs the exact price on ordinary agent tasks, with no credentials in claims", async () => {
    const w = signingWorld();
    const minted = await mintTaskToken({ signer: w.signer, issuer: vector.iss, now: () => now, describer: { describe: async () => description }, runPrice: async () => price }, operation);
    const claims = JSON.parse(Buffer.from(minted.token.split(".")[1]!, "base64url").toString()) as { runPrice: unknown };
    expect(claims.runPrice).toEqual(price);
  });
  it.each([undefined, { ...price, companyId: "org_bbbbbbbbbbbbbbbbbbbb" }, { ...price, model: "other" }, { ...price, expiresAt: now }, { ...price, inputUsdPerMillion: 0 }])("refuses missing or invalid ceilings without signing", async bad => {
    const w = signingWorld();
    const sign = vi.fn((input: Buffer) => w.signer.sign(input));
    await expect(mintTaskToken({ signer: { ...w.signer, sign }, issuer: vector.iss, now: () => now, describer: { describe: async () => description }, runPrice: async () => bad }, operation)).rejects.toThrow();
    expect(sign).not.toHaveBeenCalled();
  });
  it.each([{ sourceId: "other" }, { connectionRevision: "r8" }, { provider: "bedrock" }, { catalogModel: "openai/other" }])("refuses a rotated selected source before signing", async change => {
    const w = signingWorld();
    await expect(mintTaskToken({ signer: w.signer, issuer: vector.iss, now: () => now, describer: { describe: async () => ({ ...description, identity }) }, runPrice: async () => ({ ...price, ...change }) }, operation)).rejects.toThrow();
    expect(w.signs()).toBe(0);
  });
  it("never mints legacy unpriced OpenRouter authority", async () => {
    const w = signingWorld();
    await expect(mintTaskToken({ signer: w.signer, issuer: vector.iss, now: () => now, describer: { describe: async () => description } }, operation)).rejects.toThrow();
    expect(w.signs()).toBe(0);
  });
});
