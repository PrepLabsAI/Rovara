// Rovara's AI (DEC 240): the transport that calls Bedrock in Rovara's OWN account with the gateway task role (SigV4, service
// "bedrock"), at a fixed host built only from the configured region, on a path the route built from an allow-listed model.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { crc32 } from "node:zlib";
import type https from "node:https";
import { beforeAll, describe, expect, it } from "vitest";
import { signRequest } from "../../packages/model-gateway/src/aws.js";
import { bedrockInvokePath, createBedrockTransport } from "../../packages/model-gateway/src/bedrock-transport.js";
import { NotSentError } from "../../packages/model-gateway/src/provider.js";

const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", sessionToken: "session-token-example", expiresAt: Date.UTC(2030, 0, 1) };
const real = readFileSync(new URL("../fixtures/model-gateway-bedrock/invoke-with-response-stream-haiku-4-5.bin", import.meta.url));
const MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const now = Date.UTC(2026, 10, 15, 12, 30, 45);

interface Sent { options: https.RequestOptions; body: Buffer }
/** A node https.request stand-in: records the options and body, answers `status` with `chunks`. */
function fakeRequest(status: number, chunks: Buffer[], headers: Record<string, string> = {}) {
  const sent: Sent[] = [];
  const request = ((options: https.RequestOptions, onResponse: (response: PassThrough & { statusCode: number; headers: Record<string, string> }) => void) => {
    const call = new EventEmitter() as EventEmitter & { end(body: Buffer): void; destroy(): void };
    call.destroy = () => undefined;
    call.end = (body: Buffer) => {
      sent.push({ options, body });
      const response = Object.assign(new PassThrough(), { statusCode: status, headers });
      setImmediate(() => { onResponse(response); for (const c of chunks) response.write(c); response.end(); });
    };
    return call;
  }) as unknown as typeof https.request;
  return { request, sent };
}
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
async function text(body: AsyncIterable<Uint8Array>): Promise<string> { const parts: Buffer[] = []; for await (const p of body) parts.push(Buffer.from(p)); return Buffer.concat(parts).toString("utf8"); }

describe("SigV4 on a request path", () => {
  it("signs a Bedrock model path exactly as the AWS SDK's signer does (the model id's ':' double-encoded in the canonical path)", async () => {
    const path = bedrockInvokePath(MODEL, true);
    expect(path).toBe("/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/invoke-with-response-stream");
    const body = Buffer.from('{"anthropic_version":"bedrock-2023-05-31","max_tokens":8,"messages":[]}');
    const host = "bedrock-runtime.us-west-2.amazonaws.com";
    const ours = signRequest({ method: "POST", host, path, region: "us-west-2", service: "bedrock", body, credentials, now: new Date(now), headers: { "content-type": "application/json", accept: "application/vnd.amazon.eventstream" } });
    const signer = new SignatureV4({ credentials, region: "us-west-2", service: "bedrock", sha256: Sha256, applyChecksum: false });
    const theirs = await signer.sign({ method: "POST", protocol: "https:", hostname: host, path, headers: { host, "content-type": "application/json", accept: "application/vnd.amazon.eventstream" }, body }, { signingDate: new Date(now) });
    expect(ours.authorization).toBe(theirs.headers.authorization);
  });

  it("the root path still signs as before", async () => {
    const body = Buffer.from("{}");
    const a = signRequest({ method: "POST", host: "dynamodb.us-west-2.amazonaws.com", region: "us-west-2", service: "dynamodb", body, credentials, now: new Date(now), headers: {} });
    const b = signRequest({ method: "POST", host: "dynamodb.us-west-2.amazonaws.com", path: "/", region: "us-west-2", service: "dynamodb", body, credentials, now: new Date(now), headers: {} });
    expect(a.authorization).toBe(b.authorization);
  });
});

describe("Bedrock transport", () => {
  it("posts to the fixed regional host with the task role's SigV4 headers, never an API key, and streams Anthropic SSE back", async () => {
    const fake = fakeRequest(200, [real.subarray(0, 100), real.subarray(100)], { "content-type": "application/vnd.amazon.eventstream" });
    const transport = createBedrockTransport({ region: "us-west-2", credentials: async () => credentials, request: fake.request, now: () => now });
    const response = await transport({ body: Buffer.from("{}"), headers: { "content-type": "application/json", "x-api-key": "should-not-pass" }, key: "marker-not-a-secret", signal: new AbortController().signal, path: bedrockInvokePath(MODEL, true) });
    expect(response.status).toBe(200);
    const sse = await text(response.body);
    expect(sse.startsWith("event: message_start\ndata: ")).toBe(true);
    expect(sse).toContain("event: message_stop\n");
    expect(sse).not.toContain("amazon-bedrock-invocationMetrics");
    const options = fake.sent[0]!.options;
    expect(options.hostname).toBe("bedrock-runtime.us-west-2.amazonaws.com");
    expect(options.path).toBe("/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/invoke-with-response-stream");
    const headers = options.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261115\/us-west-2\/bedrock\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/u);
    expect(headers["x-amz-security-token"]).toBe("session-token-example");
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("x-api-key");
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("anthropic-version");
  });

  it("a non-streaming call answers the provider's JSON as is; a refusal passes its status through for the route to classify", async () => {
    const ok = fakeRequest(200, [Buffer.from('{"type":"message","usage":{"input_tokens":1,"output_tokens":1}}')]);
    const transport = createBedrockTransport({ region: "us-west-2", credentials: async () => credentials, request: ok.request, now: () => now });
    const answer = await transport({ body: Buffer.from("{}"), headers: {}, key: "marker-not-a-secret", signal: new AbortController().signal, path: bedrockInvokePath(MODEL, false) });
    expect(await text(answer.body)).toBe('{"type":"message","usage":{"input_tokens":1,"output_tokens":1}}');
    expect(ok.sent[0]!.options.path).toBe("/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/invoke");
    const refused = fakeRequest(403, [Buffer.from('{"message":"You don\'t have access to the model"}')]);
    const denied = await createBedrockTransport({ region: "us-west-2", credentials: async () => credentials, request: refused.request, now: () => now })({ body: Buffer.from("{}"), headers: {}, key: "marker-not-a-secret", signal: new AbortController().signal, path: bedrockInvokePath(MODEL, true) });
    expect(denied.status).toBe(403);
  });

  it("nothing is sent without credentials, without a model path, or on any path it did not build", async () => {
    const fake = fakeRequest(200, []);
    const signal = new AbortController().signal;
    const noCredentials = createBedrockTransport({ region: "us-west-2", credentials: () => Promise.reject(new Error("no role")), request: fake.request, now: () => now });
    await expect(noCredentials({ body: Buffer.from("{}"), headers: {}, key: "m", signal, path: bedrockInvokePath(MODEL, true) })).rejects.toBeInstanceOf(NotSentError);
    const transport = createBedrockTransport({ region: "us-west-2", credentials: async () => credentials, request: fake.request, now: () => now });
    await expect(transport({ body: Buffer.from("{}"), headers: {}, key: "m", signal })).rejects.toBeInstanceOf(NotSentError);
    for (const path of ["/model/x/converse", "/../model/x/invoke", "/model/a/b/invoke", "/anthropic/v1/messages", "/model/%2e%2e/invoke"]) {
      await expect(transport({ body: Buffer.from("{}"), headers: {}, key: "m", signal, path })).rejects.toBeInstanceOf(NotSentError);
    }
    expect(fake.sent).toHaveLength(0);
    expect(() => createBedrockTransport({ region: "evil.example/", credentials: async () => credentials })).toThrow();
  });

  it("an exception as the stream's first frame is answered as its error status (no output: the route never charges it)", async () => {
    const exception = (type: string) => frame({ ":exception-type": type, ":content-type": "application/json", ":message-type": "exception" }, Buffer.from('{"message":"x"}'));
    for (const [type, status] of [["throttlingException", 429], ["serviceUnavailableException", 503], ["modelTimeoutException", 408], ["internalServerException", 500]] as const) {
      const f = fakeRequest(200, [exception(type)]);
      const response = await createBedrockTransport({ region: "us-west-2", credentials: async () => credentials, request: f.request, now: () => now })({ body: Buffer.from("{}"), headers: {}, key: "m", signal: new AbortController().signal, path: bedrockInvokePath(MODEL, true) });
      expect(response.status).toBe(status);
      expect(await text(response.body)).toBe("");
    }
    // After output started, an exception fails the stream instead.
    const later = fakeRequest(200, [real.subarray(0, 300), exception("throttlingException")]);
    const response = await createBedrockTransport({ region: "us-west-2", credentials: async () => credentials, request: later.request, now: () => now })({ body: Buffer.from("{}"), headers: {}, key: "m", signal: new AbortController().signal, path: bedrockInvokePath(MODEL, true) });
    expect(response.status).toBe(200);
    await expect(text(response.body)).rejects.toThrow();
  });

  it("a broken event stream fails the answer (charged as any stream that broke after sending)", async () => {
    const cut = fakeRequest(200, [real.subarray(0, real.length - 5)]);
    const transport = createBedrockTransport({ region: "us-west-2", credentials: async () => credentials, request: cut.request, now: () => now });
    const response = await transport({ body: Buffer.from("{}"), headers: {}, key: "m", signal: new AbortController().signal, path: bedrockInvokePath(MODEL, true) });
    await expect(text(response.body)).rejects.toThrow();
  });
});
