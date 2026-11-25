import { beforeAll, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { claims, mint, now, scope } from "./model-gateway-fixture.js";
import { admin, maintainer, PRODUCT_COMPANY_OWNER, productCall, productGateway, storeKit } from "./model-gateway-product-fixture.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";
import { UnknownPriceSource } from "../../packages/model-gateway/src/price.js";
import type { Payer } from "../../packages/model-gateway/src/model-gateway-token.js";

beforeAll(denyNetwork);
const alias = "claude-haiku-4-5", model = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const embedding = "amazon.titan-embed-text-v2:0";
const payers: Payer[] = [
  { kind: "member", developerId: claims.per },
  { kind: "agent", agentId: "rovara-code" },
  { kind: "chain", chainId: `chn_${"a".repeat(20)}` },
  { kind: "project", project: claims.pid },
];
async function world(durable: boolean, estimated = false) {
  const a = { meter: "AgentMeter", ledger: "AgentLedger", markers: "AgentMarkers" };
  const p = { meter: "ProductMeter", ledger: "ProductLedger", markers: "ProductMarkers" };
  const wire = new WireDynamo([...Object.values(a), ...Object.values(p)], { namespaceTables: true });
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "TEST", secretAccessKey: "not-real" }), transport: wire.transport });
  const agent = durable ? new DynamoMeter({ db, tables: a, now: () => now }) : new InMemoryMeter(() => now);
  const product = durable ? new DynamoMeter({ db, tables: p, combinedCompany: { meter: a.meter, markers: a.markers }, now: () => now }) : new InMemoryMeter(() => now, undefined, undefined, { combineCompanyWith: agent as InMemoryMeter });
  const kit = storeKit({ bedrockCheck: async (_cid, connection) => ({ result: "ok", models: Object.fromEntries([...Object.values(connection.models), ...(connection.productModels ?? [])].map(id => [id, "ready"])) }) });
  await kit.store.connect({ iss: claims.iss, cid: claims.cid, owner: PRODUCT_COMPANY_OWNER, requestId: crypto.randomUUID(), expectedRevision: 0, actor: admin, sourceId: "src_bedrock", provider: "bedrock", key: JSON.stringify({ scheme: "assume_role", roleArn: "arn:aws:iam::111111111111:role/RovaraBedrockInvoke-fixture", region: "us-west-2", models: { [alias]: model }, productModels: [embedding], allowGlobal: false }) });
  await kit.store.link({ iss: claims.iss, cid: claims.cid, owner: claims.pid, requestId: crypto.randomUUID(), expectedRevision: 0, actor: maintainer, sourceId: "src_link", companySourceId: "src_bedrock" });
  const send = vi.fn(async () => ({ status: 200, body: (async function* () { yield Buffer.from(JSON.stringify(estimated ? { embedding: [0.1], inputTextTokenCount: 2 } : { output: { message: { role: "assistant", content: [{ text: "hi" }] } }, stopReason: "end_turn", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } })); })() }));
  const assumed = vi.fn(async () => ({ ok: true as const, credentials: { accessKeyId: "TEST", secretAccessKey: "not-real" } }));
  const gateway = await productGateway({ kit, connect: false, productMeter: product, overrides: { meter: agent, chargeReceipts: { source: (_claims, _model, resolved) => resolved }, ...(estimated ? { prices: UnknownPriceSource } : {}) }, bedrock: { sessions: { credentials: assumed, forget: () => undefined }, transport: () => send } });
  return { ...gateway, product, agent, wire, p, send, assumed };
}

for (const durable of [false, true]) {
  for (const pay of payers) for (const requester of [claims.per, undefined]) {
    it(`R3-1 product receipt charges the project and preserves requester (payer=${pay.kind}, requester=${requester === undefined ? "absent" : "present"}, durable=${durable})`, async () => {
      const w = await world(durable), settle = vi.spyOn(w.product, "settleV2"), reserve = vi.spyOn(w.product, "reserve");
      const result = await productCall(w.deps, `/v1/product/bedrock/model/${encodeURIComponent(model)}/converse`, { messages: [{ role: "user", content: [{ text: "hello" }] }], inferenceConfig: { maxTokens: 10 } }, mint({ mdl: [alias], tid: "task_product", pay, per: requester }));
      expect(result.status).toBe(200); expect(w.send).toHaveBeenCalledTimes(1); expect(w.assumed).toHaveBeenCalledTimes(1);
      expect(settle).toHaveBeenCalledTimes(1); expect(reserve).toHaveBeenCalledTimes(1);
      const receipt = settle.mock.calls[0]![0].receipt;
      expect(receipt).toMatchObject({ amountMicros: { state: "available", value: 4 }, billing: "external_provider", billableMicros: { state: "available", value: 0 }, source: { kind: "company_key", id: "src_bedrock", provider: "bedrock" } });
      const rows = await w.product.read({ iss: scope.iss, cid: scope.cid, pid: scope.pid, tid: "task_product" });
      expect(rows.find(row => row.item === "project")).toMatchObject({ spentMicros: 4, reservedMicros: 0 });
      expect(rows.find(row => row.item === "person")).toBeUndefined();
      expect((await w.product.read({ ...scope, tid: "task_product" })).find(row => row.item === "person")?.spentMicros).toBe(0);
      expect((await w.agent.read(scope)).find(row => row.item === "company")).toMatchObject({ spentMicros: 4, reservedMicros: 0 });
      expect(receipt.requesterId).toEqual(requester === undefined ? { state: "unavailable", reason: "not_measured" } : { state: "available", value: requester });
      if (durable) expect(w.wire.items(w.p.ledger).find(row => row.sk === `CALL#${receipt.callId}`)?.receipt).toEqual(receipt);
      expect(receipt.payer).toEqual({ kind: "project", id: "web", name: "web" });
      expect(reserve.mock.calls[0]![0]).toMatchObject({ customerSource: "bedrock_byo", charge: { receipt: { payer: { kind: "project", id: "web", name: "web" }, requesterId: receipt.requesterId } } });
    });
  }
  it(`R3-2 estimated product embedding keeps its settlement kind through receipt revision (durable=${durable})`, async () => {
    const w = await world(durable, true), settle = vi.spyOn(w.product, "settleV2");
    const result = await productCall(w.deps, `/v1/product/bedrock/model/${encodeURIComponent(embedding)}/invoke`, { inputText: "hello" }, mint({ tid: "task_embedding" }));
    expect(result.status).toBe(200); expect(w.send).toHaveBeenCalledTimes(1); expect(settle).toHaveBeenCalledTimes(1);
    const receipt = settle.mock.calls[0]![0].receipt;
    expect(receipt).toMatchObject({ status: "estimated", billing: "external_provider", requesterId: { state: "available", value: claims.per } });
    const pending = (await w.product.pendingFor({ provider: "bedrock", model: embedding }, 10)).items;
    expect(pending).toHaveLength(1); expect(pending[0]).toMatchObject({ kind: "embedding", model: embedding, usage: { input: 2, output: 0 } });
    if (durable) expect(w.wire.items(w.p.ledger).find(row => row.sk === `CALL#${receipt.callId}`)).toMatchObject({ receipt, kind: "embedding" });
    const revision = { ...receipt, revision: 2, replacesRevision: 1, recordedAt: new Date(now + 1).toISOString() };
    expect(await w.product.applyChargeReceipt(revision)).toMatchObject({ result: "applied", deltaMicros: 0 });
    expect((await w.product.pendingFor({ provider: "bedrock", model: embedding }, 10)).items).toMatchObject([{ kind: "embedding", model: embedding }]);
    expect(await w.product.applyChargeReceipt(revision)).toMatchObject({ result: "duplicate", deltaMicros: 0 });
  });
}
