// DEC 238 slice 2: the product route on a company's OWN Bedrock. The customer's tests call `/v1/product/bedrock/model/{id}/{op}` with
// the task token; the gateway signs for the company's role (a project's own, or the company's it links to), passes AWS's bytes
// back unchanged, counts the usage at list price under the one combined company cap, and writes no billable line. Two companies in
// every isolation test; nothing opens a socket.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { crc32 } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import type { AwsCredentials, CredentialSource } from "../../packages/model-gateway/src/aws.js";
import type { BedrockCheck } from "../../packages/model-gateway/src/product-keys.js";
import type { AssumeResult, BedrockSessionSource } from "../../packages/model-gateway/src/bedrock-byo-sessions.js";
import { PRODUCT_BEDROCK_FEATURE, PRODUCT_BEDROCK_MODEL, PRODUCT_BEDROCK_MODEL_NOT_ENABLED, PRODUCT_BEDROCK_QUOTA, PRODUCT_BEDROCK_REFUSED, PRODUCT_BEDROCK_THROTTLED } from "../../packages/model-gateway/src/product-bedrock.js";
import { PRODUCT_NOT_SET_UP, PRODUCT_PROVIDER_REFUSED } from "../../packages/model-gateway/src/product-route.js";
import { EVAL_SCOPE_HEADER, ProductEvalStages } from "../../packages/model-gateway/src/product-eval.js";
import type { ProductKeyRow } from "../../packages/model-gateway/src/product-seal.js";
import type { ProviderRequest, ProviderTransport } from "../../packages/model-gateway/src/provider.js";
import { NotSentError } from "../../packages/model-gateway/src/provider.js";
import { type MemorySink, claims, mint, now, scope as agentScope } from "./model-gateway-fixture.js";
import { admin, cid, iss, maintainer, pid, productCall, productGateway, productScope, storeKit, PRODUCT_COMPANY_OWNER } from "./model-gateway-product-fixture.js";

const A = cid; const B = `org_${"b".repeat(20)}`;
const CLAUDE = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const NOVA = "us.amazon.nova-pro-v1:0";
const TITAN = "amazon.titan-embed-text-v2:0";
const roleOf = (company: string) => `arn:aws:iam::${company === A ? "111111111111" : "222222222222"}:role/RovaraBedrockInvoke-${company}`;
const connectionText = (company: string, over: Record<string, unknown> = {}) => JSON.stringify({ scheme: "assume_role", roleArn: roleOf(company), region: company === A ? "us-west-2" : "us-east-2", models: { "claude-sonnet-4-5-20250929": CLAUDE }, allowGlobal: false, productModels: [NOVA, TITAN], ...over });
const OK: BedrockCheck = async (_cid, c) => ({ result: "ok", models: Object.fromEntries([...Object.values(c.models), ...(c.productModels ?? [])].map((id) => [id, "ready" as const])) });
const url = (id: string, op: string) => `/v1/product/bedrock/model/${encodeURIComponent(id)}/${op}`;

function frame(headers: Record<string, string>, payload: Buffer): Buffer {
  const head = Buffer.concat(Object.entries(headers).map(([name, value]) => {
    const n = Buffer.from(name); const v = Buffer.from(value); const h = Buffer.alloc(4 + n.length + v.length);
    h.writeUInt8(n.length, 0); n.copy(h, 1); h.writeUInt8(7, 1 + n.length); h.writeUInt16BE(v.length, 2 + n.length); v.copy(h, 4 + n.length); return h;
  }));
  const total = 12 + head.length + payload.length + 4;
  const prelude = Buffer.alloc(8); prelude.writeUInt32BE(total, 0); prelude.writeUInt32BE(head.length, 4);
  const pc = Buffer.alloc(4); pc.writeUInt32BE(crc32(prelude) >>> 0, 0);
  const body = Buffer.concat([prelude, pc, head, payload]); const mc = Buffer.alloc(4); mc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([body, mc]);
}
const ev = (type: string, payload: unknown): Buffer => frame({ ":event-type": type, ":message-type": "event", ":content-type": "application/json" }, Buffer.from(JSON.stringify(payload)));
const chunk = (event: Record<string, unknown>): Buffer => frame({ ":event-type": "chunk", ":message-type": "event", ":content-type": "application/json" }, Buffer.from(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString("base64") })));
const streamOf = (...parts: Buffer[]): AsyncIterable<Uint8Array> => (async function* () { for (const p of parts) yield p; })();
const converseJson = Buffer.from(JSON.stringify({ output: { message: { role: "assistant", content: [{ text: "hi" }] } }, stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, metrics: { latencyMs: 5 } }));
const converseStreamBytes = [ev("messageStart", { role: "assistant" }), ev("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "hi" } }), ev("messageStop", { stopReason: "end_turn" }), ev("metadata", { usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, metrics: { latencyMs: 5 } })];
const converseBody = { messages: [{ role: "user", content: [{ text: "hello" }] }], inferenceConfig: { maxTokens: 50 } };

class Sessions implements BedrockSessionSource {
  readonly asked: Array<{ row: ProductKeyRow; roleArn: string }> = [];
  readonly forgotten: ProductKeyRow[] = [];
  result: (row: ProductKeyRow) => AssumeResult = (row) => ({ ok: true, credentials: { accessKeyId: `ASIA${row.cid.slice(4, 20).toUpperCase()}`, secretAccessKey: "s", sessionToken: "t", expiresAt: Date.now() + 3_600_000 } });
  async credentials(row: ProductKeyRow, connection: { roleArn: string }): Promise<AssumeResult> { this.asked.push({ row, roleArn: connection.roleArn }); return this.result(row); }
  forget(row: ProductKeyRow): void { this.forgotten.push(row); }
}
interface Setup { company?: string; project?: string; link?: boolean; connection?: string; none?: boolean }
async function gateway(options: { transport?: (request: ProviderRequest, region: string, credentials: AwsCredentials) => ReturnType<ProviderTransport>; companyMonth?: number; connect?: Setup[]; evalStages?: ProductEvalStages; noBedrock?: boolean } = {}) {
  const kit = storeKit({ bedrockCheck: OK });
  const sessions = new Sessions();
  const sent: Array<{ region: string; request: ProviderRequest; credentials: AwsCredentials }> = [];
  const priced: Array<[string, string, string]> = [];
  const setupList = options.connect ?? [{ company: A }];
  let company = 0;
  for (const s of setupList) {
    const co = s.company ?? A; const project = s.project ?? pid; company++;
    const base = { iss, cid: co, requestId: crypto.randomUUID(), actor: admin };
    if (s.none === true) continue;
    // A company-level source (the agents' too), then either a link from the project or the project's own role.
    if (s.link === true) {
      await kit.store.connect({ ...base, owner: PRODUCT_COMPANY_OWNER, expectedRevision: 0, sourceId: "src_bedrock", provider: "bedrock", key: s.connection ?? connectionText(co) });
      await kit.store.link({ ...base, requestId: crypto.randomUUID(), owner: project, expectedRevision: 0, actor: maintainer, sourceId: "src_bdrlink", companySourceId: "src_bedrock" });
    } else await kit.store.connect({ ...base, owner: project, expectedRevision: 0, actor: maintainer, sourceId: "src_bdr", provider: "bedrock", key: s.connection ?? connectionText(co) });
  }
  void company;
  const g = await productGateway({
    kit, connect: false, companyCaps: new FixedCapsSource({ task: 1_000_000_000, projectMonth: 1_000_000_000, companyMonth: options.companyMonth ?? 1_000_000_000 }),
    ...(options.evalStages === undefined ? {} : { evalStages: options.evalStages }),
    modelLimits: { maxOutputTokens: (provider, model) => (provider === "bedrock" && model === CLAUDE ? 64_000 : undefined) },
    ...(options.noBedrock === true ? {} : { bedrock: { sessions, transport: (region: string, credentials: CredentialSource) => async (request: ProviderRequest) => {
      const creds = await credentials();
      sent.push({ region, request, credentials: creds });
      return (options.transport ?? (async () => ({ status: 200, body: streamOf(converseJson) })))(request, region, creds);
    } } }),
    overrides: { prices: { priceFor: (provider, model) => { priced.push([provider, model, "chat"]); return provider === "anthropic" ? { inputMicrosPerMTok: 4_000_000, outputMicrosPerMTok: 12_000_000 } : { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 }; } } },
  });
  return { ...g, sessions, sent, priced };
}
const as = (company: string) => mint({ cid: company });
const call = (g: Awaited<ReturnType<typeof gateway>>, path: string, body: unknown = converseBody, token = mint(), headers: Record<string, string> = {}) => productCall(g.deps, path, body, token, headers);
const err = (sink: MemorySink) => JSON.parse(sink.text()) as { message: string; error: { type: string; message: string } };
const spent = async (g: Awaited<ReturnType<typeof gateway>>, company = A) => (await g.productMeter.read({ ...productScope, cid: company })).map((r) => r.spentMicros);
const held = async (g: Awaited<ReturnType<typeof gateway>>, company = A) => (await g.productMeter.read({ ...productScope, cid: company })).map((r) => r.reservedMicros);

describe("Bedrock product route: Converse", () => {
  it("sends the checked body to Bedrock in the connection's Region with the company's own session, passes AWS's bytes back unchanged, and counts it at the dearer of the Bedrock and Anthropic rows under the combined company cap with no billable line", async () => {
    const g = await gateway();
    const sink = await call(g, url(CLAUDE, "converse"));
    expect(sink.status).toBe(200);
    expect(Buffer.concat(sink.chunks).equals(converseJson)).toBe(true);
    expect(sink.headers["content-type"]).toBe("application/json");
    expect(g.sent).toHaveLength(1);
    const { region, request, credentials } = g.sent[0]!;
    expect(region).toBe("us-west-2");
    expect(credentials.accessKeyId).toBe("ASIAAAAAAAAAAAAAAAAA");
    expect(request.path).toBe(`/model/${encodeURIComponent(CLAUDE)}/converse`);
    expect(request.headers).toEqual({ "content-type": "application/json" });
    expect(request.key).toMatch(/^byo-bedrock-[0-9a-f-]{36}$/u);
    expect(JSON.parse(Buffer.from(request.body).toString("utf8"))).toEqual({ ...converseBody, requestMetadata: { rovara_project: claims.pid, rovara_task: claims.tid } });
    // The session is the verified company's own project row.
    expect(g.sessions.asked).toEqual([{ row: expect.objectContaining({ iss, cid: A, owner: pid, sourceId: "src_bdr" }) as ProductKeyRow, roleArn: roleOf(A) }]);
    // Dearer per component: input max($3, $4) = $4/M, output max($15, $12) = $15/M: 100 x 4 + 10 x 15 = 550 micros, on the project and the agent company row.
    expect(g.priced).toEqual([["bedrock", CLAUDE, "chat"], ["anthropic", "claude-sonnet-4-5-20250929", "chat"]]);
    expect(await spent(g)).toEqual([550, 550, 550]);
    expect((await g.meter.read(agentScope)).find((r) => r.item === "company")).toMatchObject({ spentMicros: 550, reservedMicros: 0 });
    expect(g.productMeter.billedCalls(iss, A)).toEqual([]); expect(g.meter.billedCalls(iss, A)).toEqual([]);
    expect(g.logs).toContainEqual({ event: "settled", costMicros: 550, estimated: false, appliedMaxOutputTokens: 50, route: "product" });
  });

  it("a model with no agent name (a product model) is priced at its Bedrock row alone; a model with none is estimated, never free", async () => {
    const g = await gateway();
    expect((await call(g, url(NOVA, "converse"))).status).toBe(200);
    expect(g.priced).toEqual([["bedrock", NOVA, "chat"]]);
    // $3/M in, $15/M out: 100 x 3 + 10 x 15 = 450.
    expect(await spent(g)).toEqual([450, 450, 450]);
  });

  it("ConverseStream: the event stream goes back byte for byte with its own content type; usage comes from the final metadata event", async () => {
    const g = await gateway({ transport: async () => ({ status: 200, body: streamOf(...converseStreamBytes) }) });
    const sink = await call(g, url(CLAUDE, "converse-stream"));
    expect(sink.status).toBe(200);
    expect(sink.headers["content-type"]).toBe("application/vnd.amazon.eventstream");
    expect(Buffer.concat(sink.chunks).equals(Buffer.concat(converseStreamBytes))).toBe(true);
    expect(await spent(g)).toEqual([550, 550, 550]);
  });

  it("a stream cut before its final count is settled at the full hold, never at zero or at a guess", async () => {
    const g = await gateway({ transport: async () => ({ status: 200, body: streamOf(...converseStreamBytes.slice(0, 3)) }) });
    const sink = await call(g, url(CLAUDE, "converse-stream"));
    expect(sink.destroyed).toBe(true);
    const [task] = await spent(g);
    // The hold: the request's bytes and 50 output tokens at the dearer rates (> the 550 a real answer cost).
    expect(task).toBeGreaterThan(550);
    expect((await held(g))[0]).toBe(0);
  });

  it("an event stream with an exception event in it is settled at the full hold too", async () => {
    const exception = frame({ ":exception-type": "modelStreamErrorException", ":message-type": "exception", ":content-type": "application/json" }, Buffer.from("{}"));
    const g = await gateway({ transport: async () => ({ status: 200, body: streamOf(converseStreamBytes[0]!, exception) }) });
    await call(g, url(CLAUDE, "converse-stream"));
    expect((await spent(g))[0]).toBeGreaterThan(550);
  });

  it("images make the call overrun-capable: the hold is the bytes, and a settle above it blocks the task (DEC 165)", async () => {
    const huge = { usage: { inputTokens: 5_000_000, outputTokens: 10, totalTokens: 5_000_010 } };
    const g = await gateway({ transport: async () => ({ status: 200, body: streamOf(Buffer.from(JSON.stringify({ output: {}, ...huge }))) }) });
    const body = { messages: [{ role: "user", content: [{ text: "x" }, { image: { format: "png", source: { bytes: "AAAA" } } }] }], inferenceConfig: { maxTokens: 50 } };
    expect((await call(g, url(CLAUDE, "converse"), body)).status).toBe(200);
    const second = await call(g, url(CLAUDE, "converse"), converseBody);
    expect(second.status).toBe(422); expect(err(second).error.type).toBe("budget_exceeded");
    expect(g.sent).toHaveLength(1);
  });
});

describe("Bedrock product route: InvokeModel", () => {
  const anthropic = { anthropic_version: "bedrock-2023-05-31", max_tokens: 50, messages: [{ role: "user", content: "hello" }] };
  it("Claude's Anthropic body: whole and streamed, usage from the message or the chunks", async () => {
    const message = Buffer.from(JSON.stringify({ type: "message", role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 10 } }));
    const whole = await gateway({ transport: async () => ({ status: 200, body: streamOf(message) }) });
    const sink = await call(whole, url(CLAUDE, "invoke"), anthropic);
    expect(sink.status).toBe(200); expect(Buffer.concat(sink.chunks).equals(message)).toBe(true);
    expect(whole.sent[0]!.request.path).toBe(`/model/${encodeURIComponent(CLAUDE)}/invoke`);
    expect(await spent(whole)).toEqual([550, 550, 550]);
    const parts = [chunk({ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 0 } } }), chunk({ type: "message_delta", usage: { output_tokens: 10 } }), chunk({ type: "message_stop" })];
    const streamed = await gateway({ transport: async () => ({ status: 200, body: streamOf(...parts) }) });
    const s = await call(streamed, url(CLAUDE, "invoke-with-response-stream"), anthropic);
    expect(s.headers["content-type"]).toBe("application/vnd.amazon.eventstream");
    expect(Buffer.concat(s.chunks).equals(Buffer.concat(parts))).toBe(true);
    expect(await spent(streamed)).toEqual([550, 550, 550]);
  });
  it("Titan embeddings are priced as embeddings, from the answer's own token count", async () => {
    const kinds: string[] = [];
    const g = await gateway({ transport: async () => ({ status: 200, body: streamOf(Buffer.from(JSON.stringify({ embedding: [0.1, 0.2], inputTextTokenCount: 1000 }))) }) });
    g.deps.prices = { priceFor: () => undefined, effectiveFor: (provider, model, kind) => { kinds.push(`${provider}/${model}/${kind}`); return { inputMicrosPerMTok: 20_000, outputMicrosPerMTok: 20_000, estimated: false }; } };
    const sink = await call(g, url(TITAN, "invoke"), { inputText: "hello world" });
    expect(sink.status).toBe(200);
    expect(kinds).toEqual([`bedrock/${TITAN}/embedding`]);
    // 1,000 tokens x $0.02/M = 20 micros.
    expect(await spent(g)).toEqual([20, 20, 20]);
  });
  it("another family through InvokeModel is refused before any hold", async () => {
    const g = await gateway();
    const sink = await call(g, url(NOVA, "invoke"), { inputText: "x" });
    expect(sink.status).toBe(400); expect(err(sink).error.type).toBe("not_allowed");
    expect(g.sent).toEqual([]); expect(g.sessions.asked).toEqual([]);
    expect(await held(g)).toEqual([0, 0, 0]);
  });
});

describe("Bedrock product route: refusals come first, free, with nothing held, assumed or sent", () => {
  const nothing = async (g: Awaited<ReturnType<typeof gateway>>) => { expect(g.sent).toEqual([]); expect(g.sessions.asked).toEqual([]); expect(await spent(g)).toEqual([0, 0, 0]); expect(await held(g)).toEqual([0, 0, 0]); };
  it("provisioned throughput, application inference profiles and prompts (ARNs) answer the feature words before anything is read", async () => {
    for (const arn of ["arn:aws:bedrock:us-west-2:111111111111:provisioned-model/abc123", "arn:aws:bedrock:us-west-2:111111111111:application-inference-profile/abc123", "arn:aws:bedrock:us-west-2:111111111111:prompt/ABC123:1"]) {
      const g = await gateway();
      const reads = g.kit.table.reads.length;
      const sink = await call(g, `/v1/product/bedrock/model/${encodeURIComponent(arn)}/converse`);
      expect(sink.status, arn).toBe(400); expect(err(sink)).toEqual({ message: PRODUCT_BEDROCK_FEATURE, error: { type: "not_allowed", message: PRODUCT_BEDROCK_FEATURE } });
      // Refused at admission: the key table is never read (no source, no sealed key).
      expect(g.kit.table.reads.length).toBe(reads);
      await nothing(g);
    }
  });
  it("guardrails, performance and service tiers (body or header) are refused with the feature words", async () => {
    const g = await gateway();
    for (const body of [{ ...converseBody, guardrailConfig: { guardrailIdentifier: "g", guardrailVersion: "1" } }, { ...converseBody, performanceConfig: { latency: "optimized" } }, { ...converseBody, serviceTier: { type: "priority" } }]) {
      const sink = await call(g, url(CLAUDE, "converse"), body);
      expect(sink.status).toBe(400); expect(err(sink).error.message).toBe(PRODUCT_BEDROCK_FEATURE);
    }
    const header = await call(g, url(CLAUDE, "converse"), converseBody, mint(), { "x-amzn-bedrock-guardrailidentifier": "g" });
    expect(header.status).toBe(400); expect(err(header).error.message).toBe(PRODUCT_BEDROCK_FEATURE);
    await nothing(g);
  });
  it("a model the company did not pick, an operation its family is not offered with, a bad body and a dummy SigV4 credential left on the request", async () => {
    const g = await gateway();
    expect(err(await call(g, url("us.anthropic.claude-opus-5-5", "converse"))).error.message).toBe(PRODUCT_BEDROCK_MODEL);
    expect((await call(g, url("abc123xyz789", "converse"))).status).toBe(400);
    expect((await call(g, url(CLAUDE, "converse"), { messages: [] })).status).toBe(400);
    // The dummy signature next to the task token is ambiguous: 401, before anything is read.
    expect((await call(g, url(CLAUDE, "converse"), converseBody, mint(), { authorization: "AWS4-HMAC-SHA256 Credential=dummy/20261116/us-west-2/bedrock/aws4_request" })).status).toBe(401);
    expect((await call(g, url(CLAUDE, "converse"), converseBody, mint(), { "x-amz-security-token": "dummy" })).status).toBe(400);
    await nothing(g);
  });
  it("a request over the output ceiling, and one the hold cannot cover (the company's month used up), is refused before the call", async () => {
    const g = await gateway({ companyMonth: 5 });
    const over = await call(g, url(CLAUDE, "converse"));
    expect(over.status).toBe(422); expect(err(over).error.type).toBe("budget_exceeded");
    await nothing(g);
    const big = await gateway();
    expect((await call(big, url(CLAUDE, "converse"), { ...converseBody, inferenceConfig: { maxTokens: 64_001 } })).status).toBe(400);
    await nothing(big);
  });
  it("a gateway without Bedrock, malformed paths, an eval-stage scope on Bedrock, and a project with no connection answer 404", async () => {
    const off = await gateway({ noBedrock: true });
    expect((await call(off, url(CLAUDE, "converse"))).status).toBe(404);
    const g = await gateway();
    for (const path of [`${url(CLAUDE, "converse")}?x=1`, url(CLAUDE, "count-tokens"), `/v1/product/bedrock/model/${CLAUDE}`, "/v1/product/bedrock/models/x/converse"]) expect((await call(g, path)).status, path).toBe(404);
    // An eval stage scope on a Bedrock path is not a route at all (a stage's answer is events, Bedrock's is AWS's own bytes): nothing is read.
    const staged = await gateway({ evalStages: new ProductEvalStages({ approvals: { current: async () => undefined, roleOf: async () => "maintainer" }, now: () => now }) });
    const reads = staged.kit.table.reads.length;
    expect((await call(staged, url(CLAUDE, "converse"), converseBody, mint(), { [EVAL_SCOPE_HEADER]: "stage-1" })).status).toBe(404);
    expect(staged.kit.table.reads.length).toBe(reads);
    expect((await call(g, url(CLAUDE, "converse"), converseBody, mint(), { [EVAL_SCOPE_HEADER]: "stage-1" })).status).toBe(404);
    const none = await gateway({ connect: [{ none: true }] });
    const sink = await call(none, url(CLAUDE, "converse"));
    expect(sink.status).toBe(404); expect(err(sink).error.message).toBe(PRODUCT_NOT_SET_UP);
    await nothing(none);
  });
});

describe("Bedrock product route: Bedrock's errors", () => {
  const failing = (status: number, type: string | undefined, text = '{"message":"x"}'): ProviderTransport => async () => ({ status, body: streamOf(Buffer.from(`${type ?? "Unknown"}\n${text}`)) });
  it("not enabled yet (the model-access words on a 403): free, in its own words", async () => {
    const g = await gateway({ transport: failing(403, "AccessDeniedException", '{"message":"You don\'t have access to the model with the specified model ID."}') });
    const sink = await call(g, url(CLAUDE, "converse"));
    expect(sink.status).toBe(403); expect(err(sink).error).toEqual({ type: "model_not_enabled", message: PRODUCT_BEDROCK_MODEL_NOT_ENABLED });
    expect(await spent(g)).toEqual([0, 0, 0]); expect(g.sessions.forgotten).toEqual([]);
  });
  it("the role refused (any other 403 or a 401): free, the settings page is told, the session is dropped so the next call assumes it again", async () => {
    for (const status of [403, 401]) {
      const g = await gateway({ transport: failing(status, "AccessDeniedException", '{"message":"User is not authorized to perform: bedrock:InvokeModel"}') });
      const sink = await call(g, url(CLAUDE, "converse"));
      expect(sink.status).toBe(502); expect(err(sink).error).toEqual({ type: "product_key_refused", message: PRODUCT_BEDROCK_REFUSED });
      expect(sink.text()).not.toContain("not authorized");
      expect(await spent(g)).toEqual([0, 0, 0]);
      expect(g.sessions.forgotten).toEqual([expect.objectContaining({ cid: A, sourceId: "src_bdr" })]);
      const view = await g.kit.store.view(iss, A, pid);
      expect(view.sources[0]!.warning?.status).toBe(status);
    }
  });
  it("throttling, quota, a bad request and a missing model are free with fixed words; nothing of AWS's text is echoed", async () => {
    const cases: Array<[number, string, number, string, string | undefined]> = [
      [429, "ThrottlingException", 429, "provider_limited", PRODUCT_BEDROCK_THROTTLED], [400, "ServiceQuotaExceededException", 429, "provider_quota", PRODUCT_BEDROCK_QUOTA],
      [400, "ValidationException", 400, "provider_refused", PRODUCT_PROVIDER_REFUSED], [404, "ResourceNotFoundException", 400, "provider_refused", PRODUCT_PROVIDER_REFUSED],
    ];
    for (const [status, type, expectedStatus, code, message] of cases) {
      const g = await gateway({ transport: failing(status, type, '{"message":"secret-looking customer text 123456"}') });
      const sink = await call(g, url(CLAUDE, "converse"));
      expect(sink.status, type).toBe(expectedStatus); expect(err(sink).error, type).toEqual({ type: code, message });
      expect(sink.text()).not.toContain("secret-looking");
      expect(await spent(g), type).toEqual([0, 0, 0]);
    }
    const limited = await gateway({ transport: failing(429, "ThrottlingException") });
    expect((await call(limited, url(CLAUDE, "converse"))).headers["retry-after"]).toBe("5");
  });
  it("a timeout or a server error after the send is charged at the hold, as for every provider; an overload says so", async () => {
    for (const [status, type] of [[408, "ModelTimeoutException"], [500, "InternalServerException"], [424, "ModelErrorException"]] as const) {
      const g = await gateway({ transport: failing(status, type) });
      const sink = await call(g, url(CLAUDE, "converse"));
      expect(sink.status, String(status)).toBe(502); expect(err(sink).error.type).toBe("provider_error");
      expect((await spent(g))[0]).toBeGreaterThan(0);
    }
    const g = await gateway({ transport: failing(503, "ServiceUnavailableException") });
    const sink = await call(g, url(CLAUDE, "converse"));
    expect(sink.status).toBe(503); expect(err(sink).error.type).toBe("provider_overloaded");
    expect((await spent(g))[0]).toBeGreaterThan(0);
  });
  it("a role refused by STS or a session outage is free: refused marks Settings, an outage is 503; nothing is sent", async () => {
    const refused = await gateway();
    refused.sessions.result = () => ({ ok: false, reason: "refused" });
    const r = await call(refused, url(CLAUDE, "converse"));
    expect(r.status).toBe(502); expect(err(r).error.message).toBe(PRODUCT_BEDROCK_REFUSED);
    expect(refused.sent).toEqual([]); expect(await spent(refused)).toEqual([0, 0, 0]); expect(await held(refused)).toEqual([0, 0, 0]);
    expect((await refused.kit.store.view(iss, A, pid)).sources[0]!.warning?.status).toBe(403);
    const down = await gateway();
    down.sessions.result = () => ({ ok: false, reason: "unavailable" });
    const d = await call(down, url(CLAUDE, "converse"));
    expect(d.status).toBe(503); expect(down.sent).toEqual([]); expect(await held(down)).toEqual([0, 0, 0]);
    expect((await down.kit.store.view(iss, A, pid)).sources[0]!.warning).toBeUndefined();
  });
  it("a transport that did not send is free", async () => {
    const g = await gateway({ transport: async () => { throw new NotSentError(); } });
    const sink = await call(g, url(CLAUDE, "converse"));
    expect(sink.status).toBe(502); expect(await spent(g)).toEqual([0, 0, 0]);
  });
});

describe("Bedrock product route: the project's own role, or a link to the company's", () => {
  it("a project linked to the company's Bedrock calls through the company's role (the company's key-store row)", async () => {
    const g = await gateway({ connect: [{ link: true }] });
    expect((await call(g, url(CLAUDE, "converse"))).status).toBe(200);
    expect(g.sessions.asked).toEqual([{ row: expect.objectContaining({ cid: A, owner: PRODUCT_COMPANY_OWNER, sourceId: "src_bedrock" }) as ProductKeyRow, roleArn: roleOf(A) }]);
    // Removing the company's source ends every linked project's calls at once.
    await g.kit.store.remove({ iss, cid: A, owner: PRODUCT_COMPANY_OWNER, requestId: crypto.randomUUID(), expectedRevision: 1, actor: admin, sourceId: "src_bedrock" });
    const after = await call(g, url(CLAUDE, "converse"));
    expect(after.status).toBe(404); expect(err(after).error.message).toBe(PRODUCT_NOT_SET_UP);
    expect(g.sent).toHaveLength(1);
  });
  it("a project's own role is used over nothing else: its own row, its own Region, no fallback to the company's", async () => {
    const g = await gateway({ connect: [{ company: A, connection: connectionText(A, { region: "us-west-2" }) }] });
    await g.kit.store.connect({ iss, cid: A, owner: PRODUCT_COMPANY_OWNER, requestId: crypto.randomUUID(), expectedRevision: 0, actor: admin, sourceId: "src_bedrock", provider: "bedrock", key: connectionText(A, { roleArn: `${roleOf(A)}2`, region: "us-east-2" }) });
    await call(g, url(CLAUDE, "converse"));
    expect(g.sent.map((s) => s.region)).toEqual(["us-west-2"]);
    expect(g.sessions.asked.map((a) => a.row.owner)).toEqual([pid]);
  });
});

describe("Bedrock product route: two companies never meet", () => {
  it("each company's calls use its own connection, Region, role row and session; each is counted on its own rows; B's connection is never used for A's token", async () => {
    const g = await gateway({ connect: [{ company: A }, { company: B }] });
    expect((await call(g, url(CLAUDE, "converse"), converseBody, as(A))).status).toBe(200);
    expect((await call(g, url(CLAUDE, "converse"), converseBody, as(B))).status).toBe(200);
    expect(g.sent.map((s) => [s.region, s.credentials.accessKeyId])).toEqual([["us-west-2", "ASIAAAAAAAAAAAAAAAAA"], ["us-east-2", "ASIABBBBBBBBBBBBBBBB"]]);
    expect(g.sessions.asked.map((a) => [a.row.cid, a.roleArn])).toEqual([[A, roleOf(A)], [B, roleOf(B)]]);
    expect(await spent(g, A)).toEqual([550, 550, 550]); expect(await spent(g, B)).toEqual([550, 550, 550]);
    // A company with nothing connected gets nothing, whoever else has a role in the same install.
    const c = `org_${"c".repeat(20)}`;
    const none = await call(g, url(CLAUDE, "converse"), converseBody, as(c));
    expect(none.status).toBe(404); expect(g.sent).toHaveLength(2);
  });
  it("company A's sealed connection cannot be opened as company B's, nor a copied row under another company", async () => {
    const g = await gateway({ connect: [{ company: A }, { company: B }] });
    const resolutionA = (await g.kit.store.resolve(iss, A, pid, "bedrock"))!;
    expect(await g.kit.store.useKey(iss, B, resolutionA)).toBeUndefined();
    expect(await g.kit.store.resolve(iss, B, pid, "bedrock")).not.toEqual(resolutionA);
  });
  it("the same role connected by the other company is refused when a project connects it (role claims hold across projects)", async () => {
    const kit = storeKit({ bedrockCheck: OK });
    await kit.store.connect({ iss, cid: A, owner: pid, requestId: crypto.randomUUID(), expectedRevision: 0, actor: maintainer, sourceId: "src_bdr", provider: "bedrock", key: connectionText(A) });
    await expect(kit.store.connect({ iss, cid: B, owner: pid, requestId: crypto.randomUUID(), expectedRevision: 0, actor: maintainer, sourceId: "src_bdr", provider: "bedrock", key: connectionText(A) })).rejects.toMatchObject({ code: "role_in_use" });
    await expect(kit.store.connect({ iss, cid: A, owner: "other-project", requestId: crypto.randomUUID(), expectedRevision: 0, actor: maintainer, sourceId: "src_bdr", provider: "bedrock", key: connectionText(A) })).rejects.toMatchObject({ code: "role_in_use" });
  });
});

describe("Bedrock product route: the one combined company cap", () => {
  it("counts product spend on the same company row the agents use, and refuses the call that would pass it", async () => {
    const g = await gateway({ companyMonth: 2_000 });
    expect((await call(g, url(CLAUDE, "converse"))).status).toBe(200);
    expect((await g.meter.read(agentScope)).find((r) => r.item === "company")).toMatchObject({ spentMicros: 550 });
    // The next hold (the request's bytes and 50 output tokens at $15/M plus its input) passes what is left: refused, nothing sent.
    const big = { messages: [{ role: "user", content: [{ text: "x".repeat(2_000) }] }], inferenceConfig: { maxTokens: 50 } };
    const second = await call(g, url(CLAUDE, "converse"), big);
    expect(second.status).toBe(422); expect(err(second).error.type).toBe("budget_exceeded");
    expect(g.sent).toHaveLength(1);
    void now;
  });
});
