// The Vertex product route (DEC 229b): `/v1/product/vertex/...` under the same money core as Gemini (AI Studio): the same
// prices, media rules, combined company cap, eval stage holds and outcome classes; credentials and tokens from the key store,
// per company; the project and location from the key store, never from the request.
import { beforeAll, describe, expect, it } from "vitest";
import type https from "node:https";
import { EventEmitter } from "node:events";
import { denyNetwork } from "./model-gateway-no-network.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import type { MediaPriceSource } from "../../packages/model-gateway/src/media-price.js";
import type { ProviderRequest, ProviderTransport } from "../../packages/model-gateway/src/provider.js";
import { NotSentError } from "../../packages/model-gateway/src/provider.js";
import { PRODUCT_KEY_REFUSED, PRODUCT_NOT_SET_UP, PRODUCT_VERTEX_NOT_CONNECTED } from "../../packages/model-gateway/src/product-route.js";
import { createVertexTransport, parseVertexPath } from "../../packages/model-gateway/src/product-vertex.js";
import { VertexTokens } from "../../packages/model-gateway/src/product-vertex-token.js";
import { EVAL_HOLD_PATH, EVAL_SCOPE_HEADER, ProductEvalStages } from "../../packages/model-gateway/src/product-eval.js";
import { PRODUCT_AUDIO_REFUSED, PRODUCT_MEDIA_FILE_REFUSED, PRODUCT_TOOL_REFUSED } from "../../packages/model-gateway/src/product-gemini.js";
import { handleGateway, type GatewayDependencies, type GatewayLogEvent } from "../../packages/model-gateway/src/server.js";
import { MemorySink, mint, now, scope as agentScope } from "./model-gateway-fixture.js";
import { change, cid, geminiAnswer, geminiBody, iss, maintainer, pid, productCall, productGateway, productScope, storeKit } from "./model-gateway-product-fixture.js";
import { AWS_REGION, FakeGoogle, ROLE_ARN, audienceOf, keyFile, sessionArn } from "./model-gateway-vertex-fake.js";
beforeAll(denyNetwork);

const B = `org_${"b".repeat(20)}`;
const PROJECT = "acme-tests"; const LOCATION = "us-central1";
const vxPath = (o: { project?: string; location?: string; model?: string; stream?: boolean; version?: string } = {}) => `/v1/product/vertex/${o.version ?? "v1"}/projects/${o.project ?? PROJECT}/locations/${o.location ?? LOCATION}/publishers/google/models/${o.model ?? "gemini-2.5-flash"}:${o.stream === false ? "generateContent" : "streamGenerateContent?alt=sse"}`;
const fed = (pool = "pool-a", extra: Record<string, unknown> = {}) => JSON.stringify({ scheme: "federation", projectId: PROJECT, location: LOCATION, audience: audienceOf(pool), ...extra });

async function vertexGateway(options: { pool?: "exact" | "open" | "wrong"; key?: string; transport?: ProviderTransport; media?: MediaPriceSource; evalStages?: ProductEvalStages; companyMonth?: number; google?: FakeGoogle; gemini?: boolean; prices?: GatewayDependencies["prices"] } = {}) {
  const google = options.google ?? new FakeGoogle(now);
  if (options.pool !== "wrong") { if (options.pool === "open") google.openPool(audienceOf("pool-a")); else google.exactPool(audienceOf("pool-a"), cid); }
  else google.exactPool(audienceOf("pool-a"), B);
  const tokens = new VertexTokens({ http: google.http, aws: async () => google.base, federationRoleArn: ROLE_ARN, awsRegion: AWS_REGION, now: () => google.now });
  const kit = storeKit({ vertexCheck: async () => "ok" });
  await kit.store.connect({ ...change(pid, 0, maintainer), sourceId: "src_vx", provider: "vertex", key: options.key ?? fed() });
  const vertexCalls: ProviderRequest[] = [];
  const transport = options.transport ?? (async () => ({ status: 200, body: geminiAnswer() }));
  const g = await productGateway({ kit, connect: options.gemini === true, vertex: { tokens }, vertexTransport: async (r) => { vertexCalls.push(r); return transport(r); }, ...(options.media === undefined ? {} : { media: options.media }), ...(options.evalStages === undefined ? {} : { evalStages: options.evalStages }), ...(options.prices === undefined ? {} : { overrides: { prices: options.prices } }),
    companyCaps: new FixedCapsSource({ task: 1_000_000_000, projectMonth: 1_000_000_000, companyMonth: options.companyMonth ?? 1_000_000_000 }) });
  return { ...g, google, tokens, vertexCalls };
}

describe("Vertex product route: the journey", () => {
  it("streams with a token minted for the company, to the connected project and location, priced as Gemini, on the combined company row", async () => {
    const g = await vertexGateway();
    const sink = await productCall(g.deps, vxPath());
    expect(sink.status).toBe(200); expect(sink.text()).toContain("finishReason");
    const sent = g.vertexCalls[0]!;
    expect(sent.path).toBe(`/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse`);
    expect(g.google.whoIs(sent.key)).toBe(sessionArn(cid));
    expect(Object.keys(sent.headers)).toEqual(["content-type"]);
    expect((JSON.parse(Buffer.from(sent.body).toString()) as { generationConfig: { maxOutputTokens: number } }).generationConfig.maxOutputTokens).toBe(100);
    // Same price as the Gemini journey: 10 x $1/M + 5 x $2/M = 20 micros, settled to the project and the agent company row.
    expect((await g.productMeter.read(productScope)).map((r) => r.spentMicros)).toEqual([20, 20, 20]);
    expect((await g.meter.read(agentScope)).find((r) => r.item === "company")).toMatchObject({ spentMicros: 20, reservedMicros: 0 });
    expect(g.logs).toContainEqual({ event: "settled", costMicros: 20, estimated: false, appliedMaxOutputTokens: 100, route: "product" });
  });
  it("whole answers and the global location and v1beta1 work; the token is reused across calls", async () => {
    const g = await vertexGateway({ key: fed("pool-a", { location: "global" }), transport: async () => ({ status: 200, body: (async function* () { yield Buffer.from(JSON.stringify({ candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 } })); })() }) });
    expect((await productCall(g.deps, vxPath({ location: "global", stream: false, version: "v1beta1" }))).status).toBe(200);
    expect((await productCall(g.deps, vxPath({ location: "global", stream: false }))).status).toBe(200);
    expect(g.vertexCalls.map((c) => c.path)).toEqual([`/v1beta1/projects/${PROJECT}/locations/global/publishers/google/models/gemini-2.5-flash:generateContent`, `/v1/projects/${PROJECT}/locations/global/publishers/google/models/gemini-2.5-flash:generateContent`]);
    expect(g.vertexCalls[0]!.key).toBe(g.vertexCalls[1]!.key);
    expect(g.google.calls.filter((c) => c.host === "sts.googleapis.com")).toHaveLength(1);
  });
  it("a path naming another project or location is refused before any hold, token or send, even though the token could reach it", async () => {
    for (const path of [vxPath({ project: "other-project" }), vxPath({ location: "europe-west4" }), vxPath({ project: "123456789012" })]) {
      const g = await vertexGateway();
      const sink = await productCall(g.deps, path);
      expect(sink.status).toBe(400); expect(sink.text()).toContain(PRODUCT_VERTEX_NOT_CONNECTED);
      expect(g.vertexCalls).toHaveLength(0); expect(g.google.calls).toHaveLength(0);
      expect((await g.productMeter.read(productScope))[0]!.committed).toBe(0);
    }
  });
  it("refuses malformed paths and other publishers (404)", async () => {
    const g = await vertexGateway();
    for (const path of [vxPath().replace("publishers/google", "publishers/anthropic"), vxPath().replace("?alt=sse", ""), `${vxPath({ stream: false })}?key=x`, vxPath({ version: "v2" }), vxPath({ model: "Gemini" }), vxPath().replace(LOCATION, "us-central1%2F..")]) {
      expect((await productCall(g.deps, path)).status, path).toBe(404);
    }
    expect(parseVertexPath("/v1/product/vertex/v1/projects/p-abcdef/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent", "")).toEqual({ version: "v1", project: "p-abcdef", location: "us-central1", model: "gemini-2.5-flash", streaming: false });
  });
  it("refuses Google credential headers from the caller", async () => {
    const g = await vertexGateway();
    for (const headers of [{ "x-goog-api-key": "dummy-key-value" }, { "x-goog-user-project": PROJECT }, { "x-goog-iam-authorization-token": "abc123" }, { "x-goog-iam-authority-selector": "x" }]) {
      expect((await productCall(g.deps, vxPath(), geminiBody, mint(), headers)).status).toBe(400);
    }
    // A Google bearer left next to the task token is ambiguous: refused before the token is read.
    expect((await productCall(g.deps, vxPath(), geminiBody, mint(), { authorization: "Bearer ya29.dummy" })).status).toBe(401);
    expect(g.vertexCalls).toHaveLength(0);
  });
  it("a project with only Gemini connected is not set up for Vertex; a gateway without Vertex answers 404", async () => {
    const g = await productGateway();
    expect((await productCall(g.deps, vxPath())).status).toBe(404);
    const kit = storeKit();
    const v = await productGateway({ kit, vertex: { tokens: new VertexTokens({ http: new FakeGoogle(now).http, aws: async () => new FakeGoogle(now).base, federationRoleArn: ROLE_ARN, awsRegion: AWS_REGION }) }, vertexTransport: async () => { throw new NotSentError(); } });
    const sink = await productCall(v.deps, vxPath());
    expect(sink.status).toBe(404); expect(sink.text()).toContain(PRODUCT_NOT_SET_UP);
  });
});

describe("Vertex product route: credentials and tokens", () => {
  it("a pool that refuses the company: the fixed key-refused words, nothing held or charged, the source is marked for Settings", async () => {
    const g = await vertexGateway({ pool: "wrong" });
    const sink = await productCall(g.deps, vxPath());
    expect(sink.status).toBe(502); expect(sink.text()).toContain(PRODUCT_KEY_REFUSED); expect(sink.text()).not.toContain("attribute condition");
    expect(g.vertexCalls).toHaveLength(0);
    expect((await g.productMeter.read(productScope))[0]).toMatchObject({ committed: 0, spentMicros: 0 });
    const view = await g.kit.store.view(iss, cid, pid);
    expect(view.sources[0]!.warning?.status).toBe(401);
  });
  it("Google token outage: 503, nothing held or sent", async () => {
    const google = new FakeGoogle(now); google.fail.set("sts.googleapis.com", 503);
    const g = await vertexGateway({ google });
    const sink = await productCall(g.deps, vxPath());
    expect(sink.status).toBe(503); expect(g.vertexCalls).toHaveLength(0);
    expect((await g.productMeter.read(productScope))[0]!.committed).toBe(0);
  });
  it("a Vertex 401 is not charged, says key refused, and drops the cached token so the next call mints a new one", async () => {
    let status = 401;
    const g = await vertexGateway({ transport: async () => (status === 200 ? { status, body: geminiAnswer() } : { status, body: (async function* () { yield Buffer.from('{"error":{"message":"Request had invalid authentication credentials."}}'); })() }) });
    const first = await productCall(g.deps, vxPath());
    expect(first.status).toBe(502); expect(first.text()).toContain(PRODUCT_KEY_REFUSED);
    expect((await g.productMeter.read(productScope))[0]!.spentMicros).toBe(0);
    status = 200;
    expect((await productCall(g.deps, vxPath())).status).toBe(200);
    expect(g.vertexCalls[0]!.key).not.toBe(g.vertexCalls[1]!.key);
  });
  it("the key-file fallback mints by JWT and calls Vertex with that token; the private key never reaches a log, answer or request", async () => {
    const google = new FakeGoogle(now); const k = keyFile(); google.registerKeyFile(k.file, k.publicKey);
    const g = await vertexGateway({ google, key: JSON.stringify({ scheme: "service_account_key", location: LOCATION, keyFile: k.file }) });
    const sink = await productCall(g.deps, vxPath());
    expect(sink.status).toBe(200);
    expect(g.google.whoIs(g.vertexCalls[0]!.key)).toBe(`sa:${k.file.client_email}`);
    const line = k.pem.split("\n")[2]!;
    expect(JSON.stringify(g.logs)).not.toContain(line); expect(sink.text()).not.toContain(line);
    for (const call of g.vertexCalls) { expect(call.key).not.toContain(line); expect(Buffer.from(call.body).toString()).not.toContain(line); }
  });
  it("two companies: each call carries its own company's token; B's credential and token are never used for A", async () => {
    const google = new FakeGoogle(now);
    google.exactPool(audienceOf("pool-b"), B);
    const g = await vertexGateway({ google });
    await g.kit.store.connect({ ...change(pid, 0, maintainer), cid: B, sourceId: "src_vx", provider: "vertex", key: fed("pool-b") });
    expect((await productCall(g.deps, vxPath())).status).toBe(200);
    expect((await productCall(g.deps, vxPath(), geminiBody, mint({ cid: B }))).status).toBe(200);
    expect((await productCall(g.deps, vxPath())).status).toBe(200);
    expect(g.vertexCalls.map((c) => g.google.whoIs(c.key))).toEqual([sessionArn(cid), sessionArn(B), sessionArn(cid)]);
    // B's spend is on B's rows only.
    expect((await g.productMeter.read(productScope))[0]!.spentMicros).toBe(40);
    expect((await g.productMeter.read({ ...productScope, cid: B }))[0]!.spentMicros).toBe(20);
  });
});

describe("Vertex product route: the same money rules as Gemini", () => {
  const rejects = (status: number, text: string): ProviderTransport => async () => ({ status, body: (async function* () { yield Buffer.from(text); })() });
  it("outcome classes: 400 refused free, 429 per minute / quota / overloaded free, 503 charged", async () => {
    const cases: Array<[number, string, number, string, boolean]> = [[400, "{}", 400, "provider_refused", false], [429, "Quota exceeded for requests per minute", 429, "provider_limited", false], [429, "quota exceeded for quota metric generate per day", 429, "provider_quota", false], [429, "The model is overloaded", 429, "provider_overloaded", false], [503, "{}", 503, "provider_overloaded", true]];
    for (const [status, text, answer, type, charged] of cases) {
      const g = await vertexGateway({ transport: rejects(status, text) });
      const sink = await productCall(g.deps, vxPath());
      expect(sink.status, type).toBe(answer); expect(sink.text()).toContain(type);
      expect((await g.productMeter.read(productScope))[0]!.spentMicros > 0).toBe(charged);
    }
  });
  it("media: audio needs a price; audio and video by file reference are refused; server tools are refused", async () => {
    const g = await vertexGateway();
    const audio = { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data: "AAAA" } }] }] };
    expect((await productCall(g.deps, vxPath(), audio)).text()).toContain(PRODUCT_AUDIO_REFUSED);
    expect((await productCall(g.deps, vxPath(), { contents: [{ role: "user", parts: [{ fileData: { mimeType: "video/mp4", fileUri: "gs://bucket/v.mp4" } }] }] })).text()).toContain(PRODUCT_MEDIA_FILE_REFUSED);
    expect((await productCall(g.deps, vxPath(), { ...geminiBody, tools: [{ googleSearch: {} }] })).text()).toContain(PRODUCT_TOOL_REFUSED);
    expect(g.vertexCalls).toHaveLength(0);
    const priced = await vertexGateway({ media: { mediaFor: (provider) => (provider === "gemini" ? { audioInput: 3_000_000 } : undefined) } });
    expect((await productCall(priced.deps, vxPath(), audio)).status).toBe(200);
  });
  it("a cached context must live in the connected project and location", async () => {
    const g = await vertexGateway();
    expect((await productCall(g.deps, vxPath(), { ...geminiBody, cachedContent: "projects/other-proj/locations/us-central1/cachedContents/123" })).status).toBe(400);
    expect((await productCall(g.deps, vxPath(), { ...geminiBody, cachedContent: "cachedContents/123" })).status).toBe(400);
    expect((await productCall(g.deps, vxPath(), { ...geminiBody, cachedContent: `projects/${PROJECT}/locations/${LOCATION}/cachedContents/123` })).status).toBe(200);
  });
  it("prices on the Gemini rows: a price list that knows only Gemini rows prices a Vertex call exactly, not as an unknown model", async () => {
    const g = await vertexGateway({ prices: { priceFor: (provider) => (provider === "gemini" ? { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 } : undefined) } });
    expect((await productCall(g.deps, vxPath())).status).toBe(200);
    expect((await g.productMeter.read(productScope))[0]!.spentMicros).toBe(20);
    expect(g.logs).toContainEqual(expect.objectContaining({ event: "settled", estimated: false, route: "product" }));
  });
  it("prices at the DEARER of the AI Studio and Vertex rows of the same model, per component (never undercharged)", async () => {
    const rows = (vertex: Record<string, { inputMicrosPerMTok: number; outputMicrosPerMTok: number }>, gemini: { inputMicrosPerMTok: number; outputMicrosPerMTok: number } | undefined = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 }) =>
      ({ priceFor: (provider: string, model: string) => (provider === "gemini" ? gemini : provider === "vertex" ? vertex[model] : undefined) });
    const spent = async (prices: GatewayDependencies["prices"]) => {
      const g = await vertexGateway({ prices });
      expect((await productCall(g.deps, vxPath())).status).toBe(200);
      return { micros: (await g.productMeter.read(productScope))[0]!.spentMicros, estimated: (g.logs as GatewayLogEvent[]).some((l) => l.event === "settled" && l.estimated) };
    };
    // Vertex row dearer on input, Gemini dearer on output: 10 x $3/M + 5 x $2/M = 40.
    expect(await spent(rows({ "gemini-2.5-flash": { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 1_000_000 } }))).toEqual({ micros: 40, estimated: false });
    // LiteLLM's vertex_ai/<model> spelling counts too: 10 x $2/M + 5 x $6/M = 50.
    expect(await spent(rows({ "vertex_ai/gemini-2.5-flash": { inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 6_000_000 } }))).toEqual({ micros: 50, estimated: false });
    // A cheaper Vertex row never lowers the price.
    expect(await spent(rows({ "gemini-2.5-flash": { inputMicrosPerMTok: 500_000, outputMicrosPerMTok: 1_000_000 } }))).toEqual({ micros: 20, estimated: false });
    // Only a Vertex row: priced exactly on it, not as an unknown model.
    expect(await spent(rows({ "gemini-2.5-flash": { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 } }, undefined))).toEqual({ micros: 20, estimated: false });
  });
  it("the combined company cap refuses a Vertex call without sending", async () => {
    const g = await vertexGateway({ companyMonth: 10 });
    const sink = await productCall(g.deps, vxPath());
    expect(sink.status).toBe(422); expect(g.vertexCalls).toHaveLength(0);
  });
  it("an eval stage holds and runs Vertex calls: ok and key_refused classes", async () => {
    const DIGEST = "d".repeat(64);
    const approval = { selection: "all-questions", inputsDigest: DIGEST, maxCalls: 400, maxCostMicros: 4_000_000, approver: { personId: "p1", provider: "github" } };
    const stages = new ProductEvalStages({ approvals: { current: async () => approval, roleOf: async () => "maintainer" }, now: () => now });
    let status = 200;
    const g = await vertexGateway({ evalStages: stages, transport: async () => (status === 200 ? { status, body: geminiAnswer() } : { status, body: (async function* () { yield Buffer.from("{}"); })() }) });
    const holdSink = new MemorySink();
    const body = Buffer.from(JSON.stringify({ grant: { company: cid, project: pid, selection: "all-questions", role: "maintainer", inputsDigest: DIGEST, provider: "customer", connected: true, maxCalls: 400, maxCostMicros: 4_000_000 }, calls: 10, costMicros: 100_000 }));
    await handleGateway(g.deps, { method: "POST", url: EVAL_HOLD_PATH, headers: { "content-type": "application/json", "x-api-key": mint() }, body: (async function* () { yield body; })() }, holdSink);
    expect(holdSink.status).toBe(200);
    const scope = (JSON.parse(holdSink.text()) as { scope: string }).scope;
    const settleOf = (sink: MemorySink) => JSON.parse(sink.text().trim().split("\n").at(-1)!) as { class: string };
    expect(settleOf(await productCall(g.deps, vxPath(), geminiBody, mint(), { [EVAL_SCOPE_HEADER]: scope })).class).toBe("ok");
    status = 403;
    expect(settleOf(await productCall(g.deps, vxPath(), geminiBody, mint(), { [EVAL_SCOPE_HEADER]: scope })).class).toBe("key_refused");
  });
});

describe("Vertex transport", () => {
  function fakeRequest() {
    const seen: Array<Record<string, unknown>> = [];
    const request = ((options: Record<string, unknown>, callback: (res: EventEmitter & { statusCode: number }) => void) => {
      seen.push(options);
      const req = Object.assign(new EventEmitter(), { end: () => { const res = Object.assign(new EventEmitter(), { statusCode: 200, destroy: () => undefined }); callback(res); }, destroy: () => undefined });
      return req;
    }) as unknown as typeof https.request;
    return { seen, request };
  }
  const input = (path: string) => ({ body: Buffer.from("{}"), headers: { "content-type": "application/json" }, key: "ya29.token-value", signal: new AbortController().signal, path });
  it("derives the host from the checked location, sends the token as a bearer, TLS on 443", async () => {
    const { seen, request } = fakeRequest();
    const transport = createVertexTransport(request);
    await transport(input(`/v1/projects/${PROJECT}/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent`));
    await transport(input(`/v1beta1/projects/${PROJECT}/locations/global/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse`));
    expect(seen.map((o) => o.hostname)).toEqual(["us-central1-aiplatform.googleapis.com", "aiplatform.googleapis.com"]);
    expect(seen.every((o) => o.port === 443 && o.rejectUnauthorized === true && o.agent === false && (o.headers as Record<string, string>).authorization === "Bearer ya29.token-value")).toBe(true);
  });
  it("refuses any path it did not build (not sent)", async () => {
    const { seen, request } = fakeRequest();
    const transport = createVertexTransport(request);
    for (const path of ["/v1/models/gemini-2.5-flash:generateContent", `/v1/projects/${PROJECT}/locations/us-central1/publishers/anthropic/models/x:generateContent`, `/v1/projects/${PROJECT}/locations/evil.example#/publishers/google/models/gemini-2.5-flash:generateContent`, `/v1/projects/${PROJECT}/locations/us/publishers/google/models/gemini-2.5-flash:generateContent`]) {
      await expect(transport(input(path))).rejects.toBeInstanceOf(NotSentError);
    }
    expect(seen).toHaveLength(0);
  });
});

describe("Vertex engine bridge contract", () => {
  it("the shared JSON equals the module and its SHA-256 is pinned (Code's worker copies it); the Gemini contract is unchanged", async () => {
    const { readFileSync } = await import("node:fs");
    const { createHash } = await import("node:crypto");
    const { PRODUCT_VERTEX_BRIDGE } = await import("../../packages/model-gateway/src/product-bridge.js");
    const bytes = readFileSync("contracts/shared/model-gateway-product-vertex.v1.json");
    expect(JSON.parse(bytes.toString())).toEqual(JSON.parse(JSON.stringify(PRODUCT_VERTEX_BRIDGE)));
    expect(bytes.toString().endsWith("}\n")).toBe(true); expect(bytes.toString()).not.toContain("\r");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("3fa5dd5f7f5b7f074e10c6e3312ee3c32c89a5eb77f6cb2230b4f5dd62828610");
    expect(createHash("sha256").update(readFileSync("contracts/shared/model-gateway-product-ai.v1.json")).digest("hex")).toBe("edf5eab5748e1e8f4ba204cbede6b0c2140424cd9fc5ef7ef2b487213bf871c8");
  });
});

describe("dearerPrice", () => {
  it("keeps the dearer rate per component and per long-context band; an estimate adds nothing", async () => {
    const { dearerPrice } = await import("../../packages/model-gateway/src/price.js");
    const a = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 4_000_000, cacheReadMicrosPerMTok: 100_000, estimated: false, priceVersion: 7 };
    const b = { inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 3_000_000, cacheReadMicrosPerMTok: 200_000, longContext: [{ aboveTokens: 200_000, inputMicrosPerMTok: 4_000_000 }], estimated: false, priceVersion: 7 };
    const d = dearerPrice(a, b);
    expect(d).toMatchObject({ inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 4_000_000, cacheReadMicrosPerMTok: 200_000, estimated: false, priceVersion: 7 });
    expect(d.longContext?.find((t) => t.aboveTokens === 200_000)?.inputMicrosPerMTok).toBe(4_000_000);
    expect(dearerPrice(a, { inputMicrosPerMTok: 9e9, outputMicrosPerMTok: 9e9, estimated: true })).toBe(a);
    expect(dearerPrice({ inputMicrosPerMTok: 9e9, outputMicrosPerMTok: 9e9, estimated: true, priceVersion: 3 }, { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 4_000_000, estimated: false })).toMatchObject({ inputMicrosPerMTok: 1_000_000, estimated: false, priceVersion: 3 });
  });
});
