// DEC 238 slice 2 on the started process: with the product route AND bring-your-own Bedrock configured, a project's own role is
// opened from the DynamoDB key table (sealed with the configured KMS key), assumed through the broker as the token's company (its
// own external id and session name, against a fake STS), and the call is signed for that session in the connection's Region.
// Two companies. Without bring-your-own Bedrock every Bedrock product path is 404.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { GATEWAY_ENV } from "../../packages/model-gateway/src/deploy.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoProductKeyTable } from "../../packages/model-gateway/src/dynamo-product-keys.js";
import { readGatewayConfig, startServe, type RunningGateway, type ServeConfig } from "../../packages/model-gateway/src/process.js";
import { BedrockExternalIds } from "../../packages/model-gateway/src/bedrock-byo.js";
import { ProductKeyStore } from "../../packages/model-gateway/src/product-keys.js";
import { hmacFingerprinter, kmsProductKeyService, localProductKeyService, ProductKeySealer, type KmsLike } from "../../packages/model-gateway/src/product-seal.js";
import type { ProviderRequest } from "../../packages/model-gateway/src/provider.js";
import { caps, claims, jwk, kid, mint, now } from "./model-gateway-fixture.js";
import { maintainer, pid } from "./model-gateway-product-fixture.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const A = claims.cid; const B = `org_${"b".repeat(20)}`;
const CLAUDE = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const TABLES = { meter: "gw-meter", ledger: "gw-ledger", markers: "gw-markers", prices: "gw-prices", companies: "cloud-companies" };
const PRODUCT = { keys: "gw-product-keys", meter: "gw-pmeter", ledger: "gw-pledger", markers: "gw-pmarkers", stages: "gw-stages" };
const KEY_ARN = "arn:aws:kms:us-west-2:123456789012:key/00000000-0000-4000-8000-000000000000";
const MAC_ARN = "arn:aws:kms:us-west-2:123456789012:key/00000000-0000-4000-8000-0000000000aa";
const EXT_ARN = "arn:aws:kms:us-west-2:123456789012:key/00000000-0000-4000-8000-0000000000bb";
const BROKER = "arn:aws:iam::123456789012:role/RovaraBedrockBroker-staging";
const roleOf = (cid: string) => `arn:aws:iam::${cid === A ? "111111111111" : "222222222222"}:role/RovaraBedrockInvoke-${cid}`;
const ENV = {
  [GATEWAY_ENV.mode]: "serve", AWS_REGION: "us-west-2", [GATEWAY_ENV.port]: "8080",
  [GATEWAY_ENV.installIssuer]: claims.iss, [GATEWAY_ENV.installJwksUrl]: `${claims.iss}/.well-known/jwks.json`, [GATEWAY_ENV.installTaskKids]: kid,
  [GATEWAY_ENV.meterTable]: TABLES.meter, [GATEWAY_ENV.ledgerTable]: TABLES.ledger, [GATEWAY_ENV.markersTable]: TABLES.markers, [GATEWAY_ENV.pricesTable]: TABLES.prices, [GATEWAY_ENV.companyTable]: TABLES.companies,
  [GATEWAY_ENV.anthropicKeySecret]: "arn:aws:secretsmanager:us-west-2:123456789012:secret:rovara-cloud/staging/model-gateway/provider/anthropic-AbCdEf",
  [GATEWAY_ENV.productKeysTable]: PRODUCT.keys, [GATEWAY_ENV.productKeysKey]: KEY_ARN, [GATEWAY_ENV.productMeterTable]: PRODUCT.meter,
  [GATEWAY_ENV.productLedgerTable]: PRODUCT.ledger, [GATEWAY_ENV.productMarkersTable]: PRODUCT.markers, [GATEWAY_ENV.evalStagesTable]: PRODUCT.stages,
  [GATEWAY_ENV.vertexFederationRole]: "arn:aws:iam::123456789012:role/vertex", [GATEWAY_ENV.productMacKey]: MAC_ARN, [GATEWAY_ENV.agentKeys]: "company",
  [GATEWAY_ENV.bedrockBrokerRole]: BROKER, [GATEWAY_ENV.bedrockExternalIdKey]: EXT_ARN,
};
const macKey = randomBytes(32);
function fakeKms(): KmsLike & { generateMac(input: { KeyId: string; Message: Uint8Array }): Promise<{ Mac: Uint8Array }>; verifyMac(): Promise<boolean> } {
  const local = localProductKeyService(randomBytes(32));
  return {
    async generateDataKey(input) { const made = await local.generateDataKey(input.EncryptionContext); return { Plaintext: made.plaintext, CiphertextBlob: made.wrapped }; },
    async decrypt(input) { return { Plaintext: await local.unwrapDataKey(input.CiphertextBlob, input.EncryptionContext) }; },
    async generateMac(input) { return { Mac: new Uint8Array(createHmac("sha256", macKey).update(input.Message).digest()) }; },
    async verifyMac() { return false; },
  };
}
class FakeResponse extends EventEmitter {
  statusCode = 0; headers: Record<string, string> = {}; chunks: Buffer[] = []; headersSent = false;
  writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; }
  write(bytes: Uint8Array) { this.chunks.push(Buffer.from(bytes)); return true; }
  end(bytes?: Uint8Array | string) { if (bytes !== undefined) this.chunks.push(Buffer.from(bytes)); this.emit("close"); return this; }
  destroy() { this.emit("close"); return this; }
  text() { return Buffer.concat(this.chunks).toString(); }
}
function post(server: RunningGateway["server"], url: string, token: string, body: unknown): Promise<FakeResponse> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", url, headers: { "content-type": "application/json", "x-api-key": token } });
  const res = new FakeResponse();
  const done = new Promise<FakeResponse>((resolve) => res.once("close", () => resolve(res)));
  server.emit("request", req, res);
  return done;
}
const running: RunningGateway[] = [];
afterEach(async () => { for (const g of running.splice(0)) await g.drain(); });
const url = `/v1/product/bedrock/model/${encodeURIComponent(CLAUDE)}/converse`;
const body = { messages: [{ role: "user", content: [{ text: "hi" }] }], inferenceConfig: { maxTokens: 20 } };
const answer = Buffer.from(JSON.stringify({ output: {}, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }));

async function started(options: { byo: boolean }) {
  const wire = new WireDynamo([...Object.values(TABLES), ...Object.values(PRODUCT)], { namespaceTables: true });
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
  const kms = fakeKms();
  const externalIds = new BedrockExternalIds({ generateMac: (input) => kms.generateMac(input) }, EXT_ARN);
  const writer = new ProductKeyStore({
    table: new DynamoProductKeyTable(db, PRODUCT.keys), sealer: new ProductKeySealer(kmsProductKeyService(kms, KEY_ARN)), fingerprint: hmacFingerprinter(randomBytes(32)), now: () => now,
    bedrockCheck: async (_cid, c) => ({ result: "ok", models: Object.fromEntries(Object.values(c.models).map((id) => [id, "ready" as const])) }),
  });
  for (const cid of [A, B]) {
    await writer.connect({ iss: claims.iss, cid, owner: pid, requestId: randomUUID(), expectedRevision: 0, actor: maintainer, sourceId: "src_bdr", provider: "bedrock",
      key: JSON.stringify({ scheme: "assume_role", roleArn: roleOf(cid), region: cid === A ? "us-west-2" : "eu-west-1", models: { "claude-sonnet-4-5-20250929": cid === A ? CLAUDE : "eu.anthropic.claude-sonnet-4-5-20250929-v1:0" }, allowGlobal: false }) });
  }
  const sts: Array<{ roleArn: string; session: string; externalId?: string }> = [];
  const sent: Array<{ region: string; request: ProviderRequest; accessKeyId: string }> = [];
  const config = { ...(readGatewayConfig({ ...ENV, ...(options.byo ? {} : { [GATEWAY_ENV.bedrockBrokerRole]: undefined, [GATEWAY_ENV.bedrockExternalIdKey]: undefined }) }) as ServeConfig), port: 0 };
  const gateway = await startServe(config, {
    db, kms, now: () => now, listen: false, log: () => undefined, caps: new FixedCapsSource(caps), credentials: async () => ({ accessKeyId: "AKIATASK0000000000", secretAccessKey: "x" }),
    fetch: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }),
    keys: { keyFor: async () => "fixture-provider-key" }, agentKeys: { connected: async () => true, keyFor: async () => "x" },
    bedrockHttp: async (request) => {
      const form = new URLSearchParams(request.body.toString("utf8"));
      const roleArn = form.get("RoleArn")!; const session = form.get("RoleSessionName")!; const externalId = form.get("ExternalId") ?? undefined;
      sts.push({ roleArn, session, ...(externalId === undefined ? {} : { externalId }) });
      const id = `ASIA${roleArn === BROKER ? "BROKER" : session.slice(4, 14).toUpperCase()}${"0".repeat(6)}`;
      return { status: 200, body: Buffer.from(`<R><AccessKeyId>${id}</AccessKeyId><SecretAccessKey>s</SecretAccessKey><SessionToken>t</SessionToken><Expiration>${new Date(Date.now() + 3_600_000).toISOString()}</Expiration></R>`) };
    },
    bedrockProductTransport: (region, credentials) => async (request) => { const creds = await credentials(); sent.push({ region, request, accessKeyId: creds.accessKeyId }); return { status: 200, body: (async function* () { yield answer; })() }; },
  });
  running.push(gateway);
  return { gateway, sts, sent, externalIds, db, wire };
}

describe("the deployed product route on a company's own Bedrock", () => {
  it("opens each company's own connection from the key table, assumes broker then role as that company, and signs for that session in that Region", async () => {
    const t = await started({ byo: true });
    expect((await post(t.gateway.server, url, mint({ cid: A }), body)).statusCode).toBe(200);
    const eu = `/v1/product/bedrock/model/${encodeURIComponent("eu.anthropic.claude-sonnet-4-5-20250929-v1:0")}/converse`;
    expect((await post(t.gateway.server, eu, mint({ cid: B }), body)).statusCode).toBe(200);
    expect(t.sent.map((s) => [s.region, s.accessKeyId])).toEqual([["us-west-2", `ASIA${A.slice(4, 14).toUpperCase()}000000`], ["eu-west-1", `ASIA${B.slice(4, 14).toUpperCase()}000000`]]);
    const customers = t.sts.filter((c) => c.roleArn !== BROKER);
    expect(customers).toEqual([
      { roleArn: roleOf(A), session: A, externalId: await t.externalIds.of(claims.iss, A) },
      { roleArn: roleOf(B), session: B, externalId: await t.externalIds.of(claims.iss, B) },
    ]);
    expect(t.sts.filter((c) => c.roleArn === BROKER).map((c) => c.session)).toEqual([A, B]);
    // B's token cannot call A's model id: it is not one B picked, so nothing is assumed or sent for it.
    const before = t.sts.length;
    expect((await post(t.gateway.server, url, mint({ cid: B }), body)).statusCode).toBe(400);
    expect(t.sts).toHaveLength(before); expect(t.sent).toHaveLength(2);
    // Held and settled on the product tables, and the one combined company row.
    await t.gateway.drain();
    expect(t.wire.items(PRODUCT.meter).length).toBeGreaterThan(0);
  });
  it("is off without bring-your-own Bedrock: the path is 404 and nothing is read from the key table", async () => {
    const t = await started({ byo: false });
    const before = t.wire.calls.filter((c) => c.table === PRODUCT.keys).length;
    expect((await post(t.gateway.server, url, mint({ cid: A }), body)).statusCode).toBe(404);
    expect(t.wire.calls.filter((c) => c.table === PRODUCT.keys).length).toBe(before);
    expect(t.sent).toEqual([]); expect(t.sts).toEqual([]);
  });
});
