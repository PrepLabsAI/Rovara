import { beforeAll as beforeNetworkTests } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
beforeNetworkTests(denyNetwork);
import { expect, it } from "vitest";
import type https from "node:https";
import type { EventEmitter as Emitter } from "node:events";
import { UsageCollector } from "../../packages/model-gateway/src/usage.js";
import { SecretScanner, scrubProviderText } from "../../packages/model-gateway/src/provider.js";
import { answer, sse } from "./model-gateway-fixture.js";
it("reads complete fragmented SSE including caches; never accepts partial or malformed usage", async () => {
  const reader = new UsageCollector();
  for await (const chunk of answer()) for (const byte of chunk) reader.push(Buffer.from([byte]));
  expect(reader.finish()).toEqual({ input: 2, output: 5, cacheRead: 3, cacheWrite: 4 });
  for (const chunks of [[sse("message_delta", { usage: { output_tokens: 1 } })], [Buffer.from('data: secret\n\n')], [sse("message_start", { message: { usage: { input_tokens: -1 } } }), sse("message_stop")]]) {
    const bad = new UsageCollector(); for (const c of chunks) bad.push(c); expect(bad.finish()).toBeUndefined();
  }
});
it("finds keys split across chunks before any piece escapes, and scrubs masked error words", () => {
  const key = "fixture-" + "a".repeat(30);
  const scanner = new SecretScanner([key]);
  const visible = [scanner.push(Buffer.from("safe " + key.slice(0, 15))).bytes];
  const hit = scanner.push(Buffer.from(key.slice(15) + " rest")); visible.push(hit.bytes);
  expect(hit.hit).toBe(true); expect(Buffer.concat(visible).toString()).not.toContain("fixture-");
  expect(scrubProviderText(`error ${key} Bearer hidden`, key)).not.toContain(key);
});
it("parses multiline data frames and rejects a truncated, invalid or oversized frame as a whole", async () => {
  const chunks: Buffer[] = []; for await (const part of answer()) chunks.push(part);
  const all = Buffer.concat(chunks).toString();
  const multi = new UsageCollector(); multi.push(Buffer.from(all.replace('"message":', '\ndata: "message":'))); expect(multi.finish()?.output).toBe(5);
  for (const suffix of ["data: incomplete", "data: {oops}\n\n", "data: " + "x".repeat(4 * 1024 * 1024 + 1)]) {
    const bad = new UsageCollector(); bad.push(Buffer.from(all + suffix)); expect(bad.finish()).toBeUndefined();
  }
});
it("pins TLS destination and classifies before/after-connect faults with one attempt", async () => {
  const { EventEmitter } = await import("node:events");
  const { createAnthropicTransport, NotSentError } = await import("../../packages/model-gateway/src/provider.js");
  for (const connected of [false, true]) {
    let sends = 0;
    const fake = ((options: unknown) => {
      sends++; expect(options).toMatchObject({ hostname: "api.anthropic.com", path: "/v1/messages", method: "POST", rejectUnauthorized: true, agent: false });
      const req = new EventEmitter() as Emitter & { end(): void; destroy(): void };
      req.destroy = () => { req.emit("close"); };
      req.end = () => { const socket = new EventEmitter(); req.emit("socket", socket); if (connected) socket.emit("secureConnect"); req.emit("error", new Error("secret provider cause")); req.emit("close"); };
      return req;
    }) as typeof https.request;
    try { await createAnthropicTransport(fake)({ body: Buffer.from("{}"), headers: {}, key: "fixture-key", signal: new AbortController().signal }); throw new Error("expected rejection"); }
    catch (error) { expect(error instanceof NotSentError).toBe(!connected); expect((error as Error).message).toBe("provider unavailable"); }
    expect(sends).toBe(1);
  }
});
it("classifies a synchronous request-construction fault as not sent", async () => {
  const { createAnthropicTransport, NotSentError } = await import("../../packages/model-gateway/src/provider.js");
  const request = (() => { throw new Error("private request cause"); }) as typeof https.request;
  await expect(createAnthropicTransport(request)({ body: Buffer.from("{}"), headers: {}, key: "fixture-key", signal: new AbortController().signal })).rejects.toBeInstanceOf(NotSentError);
});
