import { beforeAll as beforeNetworkTests } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
beforeNetworkTests(denyNetwork);
import { expect, it } from "vitest";
import { guardRequest, MAX_BODY_BYTES } from "../../packages/model-gateway/src/guard.js";
import { claims, requestBody } from "./model-gateway-fixture.js";
const guard = (body: unknown, headers: Record<string, string> = {}) => guardRequest(Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)), { "content-type": "application/json", ...headers }, claims.mdl, { maxOutputTokens: () => 128_000 });
it("accepts ordinary messages, custom function tools and tool arguments without altering bytes", () => {
  for (const body of [requestBody, { ...requestBody, tools: [{ name: "read", input_schema: { type: "object" } }] }, { ...requestBody, messages: [{ type: "tool_use", input: { tools: [{ type: "web_search" }] } }] }]) expect(guard(body).ok).toBe(true);
});
it.each([
  { ...requestBody, model: "other" }, { ...requestBody, fallbacks: [] }, { ...requestBody, tools: [{ type: "web_search" }] }, { ...requestBody, tools: 1 }, { ...requestBody, tool_choice: { type: "computer" } }, { ...requestBody, tool_choice: "computer" }, { ...requestBody, max_tokens: -1 }, { ...requestBody, max_tokens: 0 }, { ...requestBody, max_tokens: 1.5 }, { ...requestBody, stream: "yes" }, { ...requestBody, messages: "no" }, { ...requestBody, messages: [{ type: "tool_addition", tool: { type: "surprise" } }] }, { ...requestBody, system: [{ type: "tool_definition", definition: { type: "bash" } }] }, { ...requestBody, metadata: { private: "secret" } }, null,
])("rejects invalid body with fixed words", (body) => { expect(guard(body)).toEqual({ ok: false, status: 400, code: "invalid_request", message: "request not allowed" }); });
it("refuses oversize without truncation, JSON only, bad betas and control headers", () => {
  expect(guard(Buffer.alloc(MAX_BODY_BYTES + 1))).toMatchObject({ status: 413 });
  expect(guard(Buffer.from("{broken secret"))).toMatchObject({ status: 400 });
  for (const headers of [{ "content-type": "text/plain" }, { "anthropic-beta": "unknown" }, { "x-litellm-foo": "secret" }, { "openai-project": "secret" }]) expect(guard(requestBody, headers).ok).toBe(false);
});
it("handles the byte maximum and large nested input in bounded time without recursion", () => {
  const prefix = JSON.stringify(requestBody); const pad = MAX_BODY_BYTES - Buffer.byteLength(prefix);
  const start = performance.now(); expect(guard(Buffer.from(prefix + " ".repeat(pad))).ok).toBe(true);
  expect(guard({ ...requestBody, messages: Array.from({ length: 20_000 }, () => ({ role: "user", content: "x" })) }).ok).toBe(true);
  expect(performance.now() - start).toBeLessThan(3000);
});
it("keeps function schemas opaque and rejects oversized header input as a whole", () => {
  expect(guard({ ...requestBody, tools: [{ name: "read", input_schema: { type: "object", properties: { tools: { type: "string" } } } }] }).ok).toBe(true);
  expect(guard(requestBody, { "x-extra": "x".repeat(17000) }).ok).toBe(false);
});
