import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { E2EModelReceiptSchema } from "../../packages/contracts/src/e2e-model-channel.js";
import { deriveE2EAgentRoute, e2eAgentInstallationFromEnvironment, e2eAgentRouteDefinitionDigest } from "../../packages/model-runtime/src/e2e-route-derive.js";
import { e2eAgentRouteDefinitionDigest as brokerDigest } from "../../packages/broker/src/e2e/model-route-registry.js";
import type { E2EInvoke, E2EInvokeInput, E2EInvokeOutput } from "../../packages/model-runtime/src/e2e-route.js";
import { E2E_MODEL_CANARY_BOUNDS, E2E_MODEL_CANARY_CALL, runE2EModelCanary, type E2EModelCanaryRequest } from "../../packages/worker/src/e2e-model-canary.js";
import { parseCanaryCliArgs, serveModelCanary } from "../../packages/worker/src/e2e-model-canary-cli.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";

// M1.4 Task 4.9 step 3: the worker side of the model canary. One call, through the governed route the agent steps use, with a faked provider.

const CANARY_ID = "5b0e8a52-6f3e-4b8f-9f1c-0f5c1f4f2a11";
const bedrockEnv = { AGENTX_MODEL_PROVIDER: "amazon-bedrock", AWS_REGION: "us-east-1" };
const definition = (() => {
  const derived = deriveE2EAgentRoute(e2eAgentInstallationFromEnvironment(bedrockEnv), 1);
  if (derived.status !== "available") throw new Error("fixture");
  return derived.definition;
})();
const request = (overrides: Partial<E2EModelCanaryRequest> = {}): unknown => ({
  schemaVersion: "rovara-e2e-model-canary-request/v1", canaryId: CANARY_ID, routeId: definition.routeId, definitionDigest: e2eAgentRouteDefinitionDigest(definition),
  maxCalls: 1, maxInputTokens: 32_000, maxOutputTokens: 1024, ...overrides,
});
const PAYLOAD_SHA = "a".repeat(64);
const answer = (overrides: Partial<E2EInvokeOutput> = {}): E2EInvokeOutput => ({
  servedModelId: null, providerPayloadSha256: PAYLOAD_SHA, content: [{ type: "text", text: "OK the secret answer text" }], finishReason: { unified: "stop", raw: "end_turn" },
  usage: { inputTokens: 41, outputTokens: 3 }, ...overrides,
});
function fakeInvoke(output: E2EInvokeOutput | (() => never) = answer()) {
  const calls: E2EInvokeInput[] = [];
  const invoke: E2EInvoke = async (input) => {
    calls.push(input);
    // The payload goes through the credential scan as the real invoke does.
    input.inspectPayload?.({ modelId: input.target.identifier, messages: input.call.prompt });
    return typeof output === "function" ? output() : output;
  };
  return { invoke, calls };
}
const run = (raw: unknown, invoke: E2EInvoke, environment: NodeJS.ProcessEnv = bedrockEnv) =>
  runE2EModelCanary(raw, { invoke, environment, now: () => Date.parse("2026-10-22T12:00:00.000Z"), assertSharedConfig: () => undefined });

beforeEach(() => { cleanRedirectingEnvironment(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("the worker's model canary", () => {
  it("makes exactly one call through the governed route and reports an ok receipt with digests and token counts only", async () => {
    const { invoke, calls } = fakeInvoke();
    const result = await run(request(), invoke);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toEqual({ provider: "amazon-bedrock", identifier: "us.anthropic.claude-haiku-5-5", region: "us-east-1" });
    expect(calls[0]!.thinking).toBe("off");
    expect(calls[0]!.effort).toBe("low");
    expect(calls[0]!.maxOutputTokens).toBeLessThanOrEqual(1024);
    expect(calls[0]!.call).toEqual(E2E_MODEL_CANARY_CALL);
    expect(result.status).toBe("called");
    if (result.status !== "called") throw new Error("unreachable");
    expect(result).toMatchObject({ schemaVersion: "rovara-e2e-model-canary-result/v1", canaryId: CANARY_ID, routeId: definition.routeId, definitionDigest: e2eAgentRouteDefinitionDigest(definition),
      provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-5-5", calls: 1, providerPayloadSha256: PAYLOAD_SHA });
    const receipt = E2EModelReceiptSchema.parse(result.receipt);
    expect(receipt).toMatchObject({ runId: CANARY_ID, caseId: "model-canary", stepIndex: 0, callIndex: 0, outcome: "ok", provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-5-5",
      servedModelId: null, inputTokens: 41, outputTokens: 3 });
    // No prompt or response text leaves the canary: only digests and counts.
    const text = JSON.stringify(result);
    expect(text).not.toContain("secret answer");
    expect(text).not.toContain(E2E_MODEL_CANARY_CALL.prompt[0]!.role === "system" ? (E2E_MODEL_CANARY_CALL.prompt[0] as { content: string }).content : "never");
  });

  it("keys its digest exactly as the broker keys the canary row", () => {
    expect(e2eAgentRouteDefinitionDigest(definition)).toBe(brokerDigest(definition));
  });

  it("refuses a request that raises a bound, before any call", async () => {
    for (const raised of [{ maxCalls: 2 }, { maxInputTokens: 32_001 }, { maxOutputTokens: 1025 }, { maxCalls: 0 }]) {
      const { invoke, calls } = fakeInvoke();
      const result = await run(request(raised as Partial<E2EModelCanaryRequest>), invoke);
      expect(result).toMatchObject({ status: "refused", code: "canary-request-invalid" });
      expect(calls).toHaveLength(0);
    }
  });

  it("refuses a malformed request, and one with an unknown field, before any call", async () => {
    for (const raw of [null, "x", { ...(request() as object), extra: 1 }, { ...(request() as object), canaryId: "not-a-uuid" }]) {
      const { invoke, calls } = fakeInvoke();
      expect(await run(raw, invoke)).toMatchObject({ status: "refused", code: "canary-request-invalid" });
      expect(calls).toHaveLength(0);
    }
  });

  it("refuses when the worker's own route is not the one the operator planned (another digest), before any call", async () => {
    const { invoke, calls } = fakeInvoke();
    expect(await run(request({ definitionDigest: "b".repeat(64) }), invoke)).toMatchObject({ status: "refused", code: "model-route-changed-reapprove" });
    expect(calls).toHaveLength(0);
  });

  it("refuses when the worker's environment could redirect the call, before any call", async () => {
    const { invoke, calls } = fakeInvoke();
    expect(await run(request(), invoke, { ...bedrockEnv, AWS_PROFILE: "someone" })).toMatchObject({ status: "refused", code: "model-environment-unsafe" });
    expect(calls).toHaveLength(0);
  });

  it("refuses when the worker has no usable route", async () => {
    const { invoke, calls } = fakeInvoke();
    expect(await run(request(), invoke, { AGENTX_MODEL_PROVIDER: "amazon-bedrock" })).toMatchObject({ status: "refused", code: "agent-route-not-approved" });
    expect(calls).toHaveLength(0);
  });

  it("reports a provider failure as a receipt that is not ok, still one call at most", async () => {
    const { invoke, calls } = fakeInvoke(() => { throw Object.assign(new Error("AccessDeniedException: secret text"), { name: "AccessDeniedException", $metadata: { httpStatusCode: 403 } }); });
    const result = await run(request(), invoke);
    expect(calls).toHaveLength(1);
    expect(result.status).toBe("called");
    if (result.status !== "called") throw new Error("unreachable");
    expect(result.receipt.outcome).toBe("provider-error");
    expect(JSON.stringify(result)).not.toContain("secret text");
  });

  it("reports an answer above the output bound as not ok", async () => {
    const { invoke } = fakeInvoke(answer({ usage: { inputTokens: 41, outputTokens: 1025 } }));
    const result = await run(request(), invoke);
    if (result.status !== "called") throw new Error("unreachable");
    expect(result.receipt.outcome).toBe("invalid-output");
  });

  it("holds the call to the canary bounds", () => {
    expect(E2E_MODEL_CANARY_BOUNDS).toEqual({ maxCalls: 1, maxInputTokens: 32_000, maxOutputTokens: 1024 });
    expect(E2E_MODEL_CANARY_CALL.maxOutputTokens).toBeLessThanOrEqual(1024);
    expect(E2E_MODEL_CANARY_CALL.tools).toBeUndefined();
  });

  it("runs the payload through the credential scan: a credential-shaped payload is never sent", async () => {
    const calls: E2EInvokeInput[] = [];
    const invoke: E2EInvoke = async (input) => { calls.push(input); input.inspectPayload?.({ leaked: "AKIAABCDEFGHIJKLMNOP" }); return answer(); };
    const result = await run(request(), invoke);
    if (result.status !== "called") throw new Error("unreachable");
    expect(calls).toHaveLength(1);
    expect(result.receipt.outcome).toBe("refused-credential-match");
  });
});

describe("the worker's model canary command", () => {
  const PREFIX = "e2e-runtime/AROAEXAMPLEROLEID1234:i-0123456789abcdef0/";
  const args = { bucket: "agentx-test-artifacts", prefix: PREFIX, waitSeconds: 30 };
  function transport(objects: Map<string, Uint8Array> = new Map()) {
    const puts: Array<{ key: string; body: string }> = [];
    const gets: string[] = [];
    return { puts, gets, objects, get: async (key: string) => { gets.push(key); return objects.get(key); }, put: async (key: string, body: string) => { puts.push({ key, body }); } };
  }
  function deps(t: ReturnType<typeof transport>, runner: (raw: unknown) => ReturnType<typeof run>) {
    let clock = 0;
    const lines: string[] = [];
    return { lines, value: { transport: t, run: runner, sleep: async (ms: number) => { clock += ms; }, now: () => clock, log: (line: string) => lines.push(line), pollMs: 10_000 } };
  }

  it("serves one request from its own prefix: one call, the result put under the same prefix", async () => {
    const t = transport(new Map([[`${PREFIX}canary-request.json`, Buffer.from(JSON.stringify(request()))]]));
    const { invoke, calls } = fakeInvoke();
    const d = deps(t, (raw) => run(raw, invoke));
    expect(await serveModelCanary(args, d.value)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(t.puts.map((item) => item.key)).toEqual([`${PREFIX}canary-result.json`]);
    expect(JSON.parse(t.puts[0]!.body)).toMatchObject({ status: "called", calls: 1, receipt: { outcome: "ok" } });
    expect(new Set(t.gets)).toEqual(new Set([`${PREFIX}canary-request.json`]));
    expect(d.lines.join("\n")).not.toContain("secret answer");
  });

  it("waits, bounded, and makes no call and puts nothing when no request comes", async () => {
    const t = transport();
    let ran = 0;
    const d = deps(t, async (raw) => { ran += 1; return run(raw, fakeInvoke().invoke); });
    expect(await serveModelCanary(args, d.value)).toBe(0);
    expect(ran).toBe(0);
    expect(t.puts).toEqual([]);
    expect(t.gets.length).toBe(4);
    expect(d.lines).toContain("model-canary: no model canary was asked for");
  });

  it("puts a fixed failure for an empty or oversized request without calling", async () => {
    for (const body of [Buffer.alloc(0), Buffer.alloc(4_097, 120)]) {
      const t = transport(new Map([[`${PREFIX}canary-request.json`, body]]));
      let ran = 0;
      expect(await serveModelCanary(args, deps(t, async (raw) => { ran += 1; return run(raw, fakeInvoke().invoke); }).value)).toBe(0);
      expect(ran).toBe(0);
      expect(JSON.parse(t.puts[0]!.body)).toEqual({ schemaVersion: "rovara-e2e-model-canary-result/v1", status: "failed", reason: "canary-request-size-rejected" });
    }
  });

  it("puts a refusal for a request that is not JSON, without calling", async () => {
    const t = transport(new Map([[`${PREFIX}canary-request.json`, Buffer.from("{not json")]]));
    const { invoke, calls } = fakeInvoke();
    expect(await serveModelCanary(args, deps(t, (raw) => run(raw, invoke)).value)).toBe(0);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(t.puts[0]!.body)).toMatchObject({ status: "refused", code: "canary-request-invalid" });
  });

  it("refuses arguments outside its own prefix shape", () => {
    expect(parseCanaryCliArgs(["--bucket", "agentx-test-artifacts", "--prefix", PREFIX])).toEqual({ bucket: "agentx-test-artifacts", prefix: PREFIX, waitSeconds: 7200 });
    for (const argv of [["--bucket", "b"], ["--bucket", "agentx-test-artifacts", "--prefix", "e2e-runtime/other/"], ["--bucket", "agentx-test-artifacts", "--prefix", PREFIX, "--x", "1"],
      ["--bucket", "agentx-test-artifacts", "--prefix", PREFIX, "--wait-seconds", "-1"]]) {
      expect(() => parseCanaryCliArgs(argv)).toThrow();
    }
  });
});
