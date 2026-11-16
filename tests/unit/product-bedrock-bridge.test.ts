// Offline Bedrock product boundary: only the injected gateway transport is used.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type ModelCatalogRow, type ModelEgressEvent, type ModelEgressFrame } from "@agentx/contracts";
import { createProductGatewayEgress } from "../../packages/worker/src/product-gateway-egress.js";
import { buildModelSandboxEnvironment, MODEL_DUMMY_KEY } from "../../packages/worker/src/model-sandbox-env.js";
import { headersForBackend, parseModelTarget } from "../../packages/worker/src/model-helper-http.js";

const CONTRACT = new URL("../../contracts/shared/model-gateway-product-bedrock.v2.json", import.meta.url);
const TOKEN = "worker-task-token-abcdefghijklmnop";
const DUMMY = "dummy-aws-credential";
const enc = new TextEncoder();
const model = "us.anthropic.claude-sonnet-4-6-v1:0";
const frame = (over: Partial<ModelEgressFrame> = {}): ModelEgressFrame => ({
  row: "bedrock", method: "POST", path: `/model/${model}/converse`, query: "",
  headers: [["content-type", "application/json"], ["accept", "application/json"]], body: enc.encode('{"messages":[]}'), ...over,
});
const bytes = (events: ModelEgressEvent[]) => Buffer.concat(events.flatMap(e => e.kind === "chunk" ? [e.bytes] : []));
const tail = (events: ModelEgressEvent[]) => events.at(-1);
function rig(answer: () => Response | Promise<Response> = () => new Response('{"output":{}}', { headers: { "content-type": "application/json" } }), family?: "gemini" | "bedrock") {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  let tokens = 0;
  const egress = createProductGatewayEgress({ gatewayUrl: "https://gateway.example.test", ...(family === undefined ? {} : { family }),
    tokenSource: async () => { tokens++; return TOKEN; },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => { sent.push({ url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url, init: init ?? {} }); return answer(); }),
  });
  return { sent, tokens: () => tokens, async run(input = frame()) {
    const events: ModelEgressEvent[] = [];
    for await (const event of egress.forward({} as never, input)) events.push(event);
    return events;
  } };
}
const bedrock = (answer?: () => Response | Promise<Response>) => rig(answer, "bedrock");

describe("Bedrock product contract and request boundary", () => {
  it("pins the byte-identical Cloud v2 contract", () => {
    expect(createHash("sha256").update(readFileSync(CONTRACT)).digest("hex")).toBe("56de3ce598616737dd4bec9fe74dd3ab01ef6b14d2171487c35c280117bc04ca");
  });
  it.each(["converse", "converse-stream", "invoke", "invoke-with-response-stream"])("forwards only the product %s path, body intact, with the worker token", async operation => {
    const r = bedrock();
    const body = Uint8Array.of(0, 128, 255, 10, 34);
    const out = await r.run(frame({ path: `/model/${model}/${operation}`, body }));
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.url).toBe(`https://gateway.example.test/v1/product/bedrock/model/${model}/${operation}`);
    expect(r.sent[0]!.init).toMatchObject({ method: "POST", redirect: "error", body });
    expect(new Headers(r.sent[0]!.init.headers).get("x-api-key")).toBe(TOKEN);
    expect(r.tokens()).toBe(1);
    expect(tail(out)).toMatchObject({ class: "ok", costMicros: 0 });
  });
  const credentials = ["Authorization", "X-Amz-Date", "X-Amz-Security-Token", "X-Amz-Content-Sha256", "X-Amz-User-Agent", "X-Amz-Credential", "X-Amz-Signature", "X-Amz-Bedrock-GuardrailIdentifier", "X-Amzn-Bedrock-PerformanceConfig-Latency", "amz-sdk-invocation-id", "Amz-Sdk-Request", "x-api-key", "cookie"];
  it.each(credentials)("strips %s before gateway forwarding", async name => {
    const r = bedrock();
    await r.run(frame({ headers: [...frame().headers, [name, DUMMY]] }));
    expect(r.sent).toHaveLength(1);
    expect(Object.fromEntries(new Headers(r.sent[0]!.init.headers))).toEqual({ "content-type": "application/json", accept: "application/json", "x-api-key": TOKEN });
    expect(JSON.stringify(r.sent[0])).not.toContain(DUMMY);
  });
  it("strips SDK bookkeeping at the helper boundary too", () => {
    expect(headersForBackend(Object.fromEntries([...credentials.map((n): [string, string] => [n, DUMMY]), ["content-type", "application/json"]]) as Record<string, string>)).toEqual({ "content-type": "application/json" });
  });
  it("accepts the SDK's percent-encoded model colon and canonicalizes it", async () => {
    const r = bedrock();
    const path = `/model/${model.replace(":", "%3A")}/converse`;
    expect(parseModelTarget(`/p/bedrock${path}`)).toMatchObject({ ok: true, target: { rest: path } });
    await r.run(frame({ path }));
    expect(r.sent[0]?.url).toBe(`https://gateway.example.test/v1/product/bedrock/model/${model}/converse`);
  });
  it.each([
    { path: `/model/${model}/count-tokens` }, { path: `/model/${model}/converse/extra` },
    { path: "/v1/internal/model-access" }, { path: `/v1/product/bedrock/model/${model}/converse` },
    { path: "/model/UPPER/converse" }, { path: "/model/a/converse" }, { path: `/model/${"a".repeat(202)}/converse` },
    { path: "/model/arn:aws:bedrock:us-east-1:123:model/x/converse" }, { path: "/model/../converse" },
    { path: "/model/ab%2f..%2fx/converse" }, { path: "/model/ab%253A0/converse" },
    { path: "/model/ab%ZZ/converse" }, { method: "GET" }, { query: "X-Amz-Credential=dummy" }, { query: "foo=bar" },
  ])("refuses non-contract requests before getting a token: %j", async over => {
    const r = bedrock(); const out = await r.run(frame(over));
    expect(r.sent).toEqual([]); expect(r.tokens()).toBe(0);
    expect(tail(out)).toMatchObject({ class: "refused", costMicros: 0 });
    expect((JSON.parse(bytes(out).toString()) as { message?: unknown }).message).toEqual(expect.any(String));
    expect(bytes(out).toString()).not.toContain("dummy");
  });
  it.each(["ab", "a".repeat(201)])("accepts the model-pattern boundary %s", async id => {
    const r = bedrock(); await r.run(frame({ path: `/model/${id}/converse` })); expect(r.sent).toHaveLength(1);
  });
  it("is off unless the Bedrock family is configured", async () => {
    const r = rig(); const out = await r.run();
    expect(r.sent).toEqual([]); expect(r.tokens()).toBe(0); expect(tail(out)).toMatchObject({ class: "refused" });
  });
});

describe("Bedrock responses", () => {
  it.each(["converse-stream", "invoke-with-response-stream"])("preserves binary %s bytes, including invalid UTF-8 and split multibyte sequences", async operation => {
    // High bytes exercise binary corruption without embedding the token's guarded four-character suffix.
    const chunks = [Uint8Array.from([...Array.from({ length: 200 }, (_, i) => 128 + i % 128), 195]), Uint8Array.of(169, 254, 0, 42)];
    const r = bedrock(() => new Response(new ReadableStream({ start(c) { for (const chunk of chunks) c.enqueue(chunk); c.close(); } }), { headers: { "content-type": "application/vnd.amazon.eventstream" } }));
    const out = await r.run(frame({ path: `/model/${model}/${operation}` }));
    expect(out[0]).toMatchObject({ kind: "head", status: 200, headers: [["content-type", "application/vnd.amazon.eventstream"]] });
    expect(bytes(out)).toEqual(Buffer.from([...Array.from({ length: 200 }, (_, i) => 128 + i % 128), 195, 169, 254, 0, 42]));
    expect(tail(out)).toMatchObject({ class: "ok" });
  });
  it("cuts a token echo split across binary chunks and cancels without leaking it", async () => {
    let cancelled = false;
    const r = bedrock(() => new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(TOKEN.slice(0, 12))); c.enqueue(enc.encode(TOKEN.slice(12))); }, cancel() { cancelled = true; } }), { headers: { "content-type": "application/vnd.amazon.eventstream", "x-request-id": TOKEN } }));
    const out = await r.run();
    expect(bytes(out).toString()).not.toContain(TOKEN); expect(JSON.stringify(out[0])).not.toContain(TOKEN);
    expect(tail(out)).toMatchObject({ class: "provider_error" }); expect(cancelled).toBe(true);
  });
  it("maps all v2 refusals to fixed SDK-readable answers without echoing gateway text", async () => {
    const c = JSON.parse(readFileSync(CONTRACT, "utf8")) as { refusals: Array<{ status: number; type: string; message: string }> };
    for (const refusal of c.refusals) {
      const r = bedrock(() => new Response(JSON.stringify({ message: TOKEN, error: { type: refusal.type, message: refusal.message } }), { status: refusal.status }));
      const out = await r.run();
      expect(out[0]).toMatchObject({ status: refusal.status });
      expect(JSON.parse(bytes(out).toString())).toEqual({ message: refusal.message, error: { type: refusal.type, message: refusal.message } });
      expect(tail(out)).toMatchObject({ costMicros: 0 }); expect(bytes(out).toString()).not.toContain(TOKEN);
    }
    const r = bedrock(() => new Response(JSON.stringify({ error: { type: "not_allowed", message: TOKEN } }), { status: 400 }));
    const out = await r.run();
    expect((JSON.parse(bytes(out).toString()) as { message?: unknown }).message).toBe(c.refusals[0]!.message);
  });
  it.each([302, 500])("makes one attempt for status %i and never passes untrusted words or redirects", async status => {
    const r = bedrock(() => new Response(TOKEN, { status, headers: { location: "https://other.example.test" } }));
    const out = await r.run();
    expect(r.sent).toHaveLength(1); expect(r.sent[0]!.init.redirect).toBe("error");
    expect(bytes(out).toString()).not.toContain(TOKEN); expect(tail(out)).toMatchObject({ class: "provider_error" });
  });
});

describe("Bedrock sandbox configuration", () => {
  // Bedrock already has a catalog family, but no built-in row: the configured product supplies its selected row.
  const rows = [{ id: "bedrock", family: "bedrock", routesTo: "local_aws_front", redirect: [] }] as unknown as ModelCatalogRow[];
  it("adds the helper endpoint and dummy AWS credentials only with productBedrock enabled", () => {
    expect(rows).toHaveLength(1);
    const off = buildModelSandboxEnvironment({ rows, helperIp: "172.30.7.9" });
    expect(off.entries).toEqual([]);
    expect(buildModelSandboxEnvironment({ rows, helperIp: "172.30.7.9", productBedrock: false }).entries).toEqual([]);
    expect(buildModelSandboxEnvironment({ rows: [], helperIp: "172.30.7.9", productBedrock: true }).entries).toEqual([]);
    const on = buildModelSandboxEnvironment({ rows, helperIp: "172.30.7.9", productBedrock: true });
    expect(Object.fromEntries(on.entries)).toEqual({ AWS_ENDPOINT_URL_BEDROCK_RUNTIME: `http://rovara-models:8080/p/${rows[0]!.id}`, AWS_ACCESS_KEY_ID: MODEL_DUMMY_KEY, AWS_SECRET_ACCESS_KEY: MODEL_DUMMY_KEY });
    expect(on.secretValues).toEqual([]);
  });
});
