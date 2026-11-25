import { describe, expect, it } from "vitest";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { applyAgentOwnKeyBackfill, planAgentOwnKeyBackfill } from "../../packages/model-gateway/src/agent-own-key-backfill.js";
import { CompanyAgentAiSource, resolveAgentSource } from "../../packages/model-gateway/src/agent-ai.js";
import { DynamoProductKeyTable } from "../../packages/model-gateway/src/dynamo-product-keys.js";
import { ProductKeySealer } from "../../packages/model-gateway/src/product-seal.js";
import { ProductKeyStore } from "../../packages/model-gateway/src/product-keys.js";
import { storedLearningKeys } from "../../packages/model-gateway/src/learning-keys.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const iss = "https://code.example.test";
const A = `org_${"a".repeat(20)}`, B = `org_${"b".repeat(20)}`, C = `org_${"c".repeat(20)}`;
const companyTable = "companies", productTable = "product-keys";
const pk = (cid: string) => `CO#${JSON.stringify([iss, cid])}`;
const denied = async (): Promise<never> => { throw new Error("secret access forbidden"); };
async function world() {
  const wire = new WireDynamo([companyTable, productTable], { namespaceTables: true });
  const db = new Dynamo({ region: "us-east-1", credentials: async () => ({ accessKeyId: "TEST", secretAccessKey: "not-real" }), transport: wire.transport });
  const input = { db, companyTable, productTable, issuer: iss, companies: [A, B, C] };
  const connect = async (cid: string, provider = "anthropic", version = 1, connected = true) => {
    const owner = provider === "bedrock" ? "_company" : "_learning";
    const source = { sourceId: provider === "bedrock" ? "src_bedrock" : "src_anthropic", provider, connectedBy: "d".repeat(64), connectedAt: 1, updatedAt: 1, currentVersion: "00000000-0000-4000-8000-000000000001",
      ...(provider === "bedrock" ? { bedrock: { roleArn: "arn:aws:iam::123456789012:role/RovaraBedrockInvoke-customer", region: "us-east-1", models: { "claude-sonnet-4-5": "us.anthropic.claude-sonnet-4-5-20250929-v1:0" }, allowGlobal: false, checks: {}, checkedAt: 1 } } : {}) };
    await db.put(productTable, { pk: pk(cid), sk: `doc#${owner}`, v: version, f_sources: connected ? [source] : [], f_removed: [] });
  };
  const saved = (cid: string) => db.get(companyTable, { pk: `COMPANY#${cid}`, sk: "AGENT_AI" });
  return { db, wire, input, connect, saved };
}

describe("C-1 own-key backfill", () => {
  it("dry-run lists and counts only connected own-key companies without a choice, without writes or secret reads", async () => {
    const w = await world(); await w.connect(A); await w.connect(B, "bedrock");
    w.wire.calls.length = 0;
    const plan = await planAgentOwnKeyBackfill(w.input);
    expect(plan.candidates.map(({ companyId, source }) => ({ companyId, source }))).toEqual([{ companyId: A, source: "anthropic_key" }, { companyId: B, source: "bedrock_byo" }]);
    expect(plan.candidates).toHaveLength(2);
    expect(w.wire.calls.every((call) => call.operation === "GetItem")).toBe(true);
    expect(w.wire.calls.every((call) => call.keys.every((key) => key.sk === "AGENT_AI" || key.sk.startsWith("doc#")))).toBe(true);
    expect(await w.saved(A)).toBeUndefined(); expect(await w.saved(B)).toBeUndefined(); expect(await w.saved(C)).toBeUndefined();
  });

  it("applies only missing choices; a rerun makes zero write attempts and keeps source/version/timestamp intact", async () => {
    const w = await world(); await w.connect(A); await w.connect(B, "bedrock");
    const plan = await planAgentOwnKeyBackfill(w.input);
    expect(await applyAgentOwnKeyBackfill(w.input, plan)).toEqual({ written: 2, conflicted: 0 });
    const before = await w.saved(A);
    expect(before).toMatchObject({ companyId: A, source: "anthropic_key", version: 1, updatedBy: "backfill:DEC254zzz279" });
    expect(await w.saved(B)).toMatchObject({ source: "bedrock_byo", version: 1 });
    w.wire.calls.length = 0;
    const again = await planAgentOwnKeyBackfill(w.input);
    expect(again.candidates).toEqual([]);
    expect(await applyAgentOwnKeyBackfill(w.input, again)).toEqual({ written: 0, conflicted: 0 });
    expect(w.wire.calls.every((call) => call.operation === "GetItem")).toBe(true);
    expect(await w.saved(A)).toEqual(before);
    expect(await w.saved(C)).toBeUndefined();
  });

  it("never overwrites any existing choice, including an unreadable row", async () => {
    const w = await world(); await w.connect(A); await w.connect(B);
    const rows = [{ pk: `COMPANY#${A}`, sk: "AGENT_AI", companyId: A, source: "rovara", version: 7, fallback: ["bedrock_byo"] }, { pk: `COMPANY#${B}`, sk: "AGENT_AI", companyId: B, source: "unknown" }];
    for (const row of rows) await w.db.put(companyTable, row);
    const plan = await planAgentOwnKeyBackfill(w.input);
    expect(plan.candidates).toEqual([]);
    expect(await applyAgentOwnKeyBackfill(w.input, plan)).toEqual({ written: 0, conflicted: 0 });
    expect(await w.saved(A)).toEqual(rows[0]); expect(await w.saved(B)).toEqual(rows[1]);
  });

  it("a concurrent saved choice wins over the dry-run plan", async () => {
    const w = await world(); await w.connect(A);
    const plan = await planAgentOwnKeyBackfill(w.input);
    const chosen = { pk: `COMPANY#${A}`, sk: "AGENT_AI", companyId: A, source: "rovara", version: 1 };
    await w.db.put(companyTable, chosen);
    expect(await applyAgentOwnKeyBackfill(w.input, plan)).toEqual({ written: 0, conflicted: 1 });
    expect(await w.saved(A)).toEqual(chosen);
  });

  it("a credential removed after preview prevents application, including Bedrock gaining a preferred Anthropic key", async () => {
    for (const provider of ["anthropic", "bedrock"]) {
      const w = await world(); await w.connect(A, provider);
      const plan = await planAgentOwnKeyBackfill(w.input);
      if (provider === "anthropic") await w.connect(A, provider, 2, false); else await w.connect(A);
      expect(await applyAgentOwnKeyBackfill(w.input, plan)).toEqual({ written: 0, conflicted: 1 });
      expect(await w.saved(A)).toBeUndefined();
    }
  });

  it("Anthropic wins when both are connected; removed or another issuer's keys never qualify a company", async () => {
    const w = await world(); await w.connect(A); await w.connect(A, "bedrock"); await w.connect(B, "anthropic", 2, false);
    const connectedMetadata = await w.db.get(productTable, { pk: pk(A), sk: "doc#_learning" });
    if (connectedMetadata === undefined) throw new Error("fixture metadata missing");
    await w.db.put(productTable, { ...connectedMetadata, pk: `CO#${JSON.stringify(["https://other.example.test", C])}` });
    const plan = await planAgentOwnKeyBackfill(w.input);
    expect(plan.candidates.map(({ companyId, source }) => ({ companyId, source }))).toEqual([{ companyId: A, source: "anthropic_key" }]);
    expect(await applyAgentOwnKeyBackfill(w.input, plan)).toEqual({ written: 1, conflicted: 0 });
    const sources = new CompanyAgentAiSource(w.db, companyTable);
    expect(await resolveAgentSource({ sources, keys: { connected: denied } }, iss, A)).toEqual({ source: "anthropic_key", via: "chosen" });
    const store = new ProductKeyStore({ table: new DynamoProductKeyTable(w.db, productTable), sealer: new ProductKeySealer({ generateDataKey: denied, unwrapDataKey: denied }), fingerprint: denied });
    expect(await resolveAgentSource({ sources, keys: storedLearningKeys(store) }, iss, C)).toEqual({ source: "rovara", via: "default" });
  });

  it("unreadable metadata fails the whole preview before any application", async () => {
    const w = await world(); await w.connect(A);
    await w.db.put(productTable, { pk: pk(B), sk: "doc#_learning", v: 1, f_sources: "broken", f_removed: [] });
    await expect(planAgentOwnKeyBackfill(w.input)).rejects.toThrow();
    expect(await w.saved(A)).toBeUndefined();
  });
});
