import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRIVING_TEST_BUDGET, E2EModelCheckResultSchema, E2E_MODEL_CHECK_REQUEST_SCHEMA, e2eModelRouteRevision, type E2EModelRouteDefinition } from "@agentx/contracts";
import { createGovernedE2EModelRoute } from "../../packages/model-runtime/src/e2e-route.js";
import type { E2EInvoke, E2EInvokeInput, E2EInvokeOutput } from "../../packages/model-runtime/src/e2e-route.js";
import { deriveE2EAgentRouteForModel, e2eAgentRouteDefinitionDigest } from "../../packages/model-runtime/src/e2e-route-derive.js";
import { validateModelCheckResult } from "../../packages/broker/src/e2e/model-checks.js";
import { createDrivingTestLedger, drivingTestHostConfig, requestIdOf, runE2EModelCheck, withOutputCap } from "../../packages/worker/src/e2e-model-check.js";
import { CANARY_REQUEST_KEY, CANARY_RESULT_KEY, parseCanaryCliArgs, runRequest, s3CanaryTransport, serveModelChecks, type CanaryTransport } from "../../packages/worker/src/e2e-model-canary-cli.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";

// M1.4 Task 4.10C, tests 30 (the budget), 32 (the server) and the worker side of 34: the check the runner makes, with a faked provider and a faked navigation.

const CHECK = "5b0e8a52-6f3e-4b8f-9f1c-0f5c1f4f2a11";
const MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const env = { AGENTX_MODEL_PROVIDER: "amazon-bedrock", AWS_REGION: "us-east-1" };
const installation = { provider: "amazon-bedrock", region: "us-east-1" } as const;
const defs = (() => {
  const standard = deriveE2EAgentRouteForModel(installation, MODEL, "standard", 1);
  const minimal = deriveE2EAgentRouteForModel(installation, MODEL, "minimal", 1);
  if (standard.status !== "available" || minimal.status !== "available") throw new Error("fixture");
  return { standard: standard.definition, minimal: minimal.definition };
})();
const driveRequest = (over: Record<string, unknown> = {}) => ({ schemaVersion: E2E_MODEL_CHECK_REQUEST_SCHEMA, checkId: CHECK, kind: "drive", routeId: defs.standard.routeId,
  definitionDigest: e2eAgentRouteDefinitionDigest(defs.standard), ...over });
const answer = (inputTokens = 800): E2EInvokeOutput => ({ servedModelId: null, content: [{ type: "text", text: "OK the secret answer text" }], finishReason: { unified: "stop", raw: "end_turn" }, usage: { inputTokens, outputTokens: 3 } });
const failure = (cls: string, signal: string | null = null) => Object.assign(new Error("provider said: secret provider text"), { failure: { class: cls, signal } });

/** An invoke chosen by the shape of the definition it is built for, so a test can make the standard shape fail and the minimal one work. */
function invokes(byShape: { standard: () => E2EInvokeOutput; minimal?: () => E2EInvokeOutput }) {
  const calls: Array<{ shape: "standard" | "minimal"; input: E2EInvokeInput }> = [];
  const invokeFor = async (definition: E2EModelRouteDefinition): Promise<E2EInvoke> => {
    const shape = definition.payloadShape === "minimal" ? "minimal" as const : "standard" as const;
    return async (input) => { calls.push({ shape, input }); input.inspectPayload?.({ messages: input.call.prompt }); return (byShape[shape] ?? byShape.standard)(); };
  };
  return { invokeFor, calls };
}

const base = { environment: env, now: () => Date.parse("2026-10-23T12:00:00.000Z"), assertSharedConfig: () => undefined };
beforeEach(() => { cleanRedirectingEnvironment(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("the driving test's budget on the worker (test 30)", () => {
  it("holds 6 calls and 36,000 input tokens across every route that shares the ledger", async () => {
    const ledger = createDrivingTestLedger();
    const route = createGovernedE2EModelRoute(defs.standard, { invoke: async () => answer(100), now: () => Date.now(), dayBudget: ledger });
    const outcomes: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      const result = await route.generate({ schemaVersion: "rovara-e2e-model-channel/v1", runId: CHECK, caseId: "case", stepIndex: 0, callIndex: index, call: { prompt: [{ role: "user", content: [{ type: "text", text: "Reply with OK." }] }], maxOutputTokens: 64 } } as never, {});
      outcomes.push(result.receipt.outcome);
      if (result.receipt.outcome === "budget") expect(result.result).toMatchObject({ code: "budget", message: expect.stringContaining("model-route-budget-exhausted") as string });
    }
    expect(outcomes).toEqual(["ok", "ok", "ok", "ok", "ok", "ok", "budget", "budget", "budget"]);
    expect(ledger.snapshot().calls).toBe(6);
  });

  it("refuses a reserve that would pass 36,000 input tokens, however few calls were made", () => {
    const ledger = createDrivingTestLedger();
    expect(ledger.reserve(30_000, { maxInputTokens: 1_000_000, maxCalls: 1_000 })).not.toBeNull();
    expect(ledger.reserve(6_001, { maxInputTokens: 1_000_000, maxCalls: 1_000 })).toBeNull();
    expect(ledger.reserve(6_000, { maxInputTokens: 1_000_000, maxCalls: 1_000 })).not.toBeNull();
    expect(ledger.snapshot()).toEqual({ calls: 2, inputTokens: 36_000 });
  });

  it("gives back a call that was never sent, and trues a settled one up to what was charged", async () => {
    const ledger = createDrivingTestLedger();
    const first = (await ledger.reserve(5_000, { maxInputTokens: 0, maxCalls: 0 }))!;
    await first.release();
    expect(ledger.snapshot()).toEqual({ calls: 0, inputTokens: 0 });
    const second = (await ledger.reserve(5_000, { maxInputTokens: 0, maxCalls: 0 }))!;
    await second.settle(1_200);
    expect(ledger.snapshot()).toEqual({ calls: 1, inputTokens: 1_200 });
  });

  it("caps the output of every call at 512 whatever the call asks for, and keeps the invoke's secrets", async () => {
    const seen: number[] = [];
    const inner = Object.assign(async (input: E2EInvokeInput) => { seen.push(input.maxOutputTokens); return answer(); }, { secrets: ["k-secret-value"] });
    const capped = withOutputCap(inner, DRIVING_TEST_BUDGET.maxOutputTokensPerCall);
    await capped({ maxOutputTokens: 4_000 } as E2EInvokeInput);
    await capped({ maxOutputTokens: 64 } as E2EInvokeInput);
    expect(seen).toEqual([512, 64]);
    expect((capped as unknown as { secrets: string[] }).secrets).toEqual(["k-secret-value"]);
  });

  it("a navigation that keeps calling is stopped at 6 calls in all, and the broker takes the result for no pass", async () => {
    const { invokeFor } = invokes({ standard: () => answer(500) });
    const result = await runE2EModelCheck(driveRequest(), { ...base, invokeFor,
      async navigate({ definition, runId, ledger, invoke }) {
        const route = createGovernedE2EModelRoute(definition, { invoke, now: () => Date.now(), dayBudget: ledger, newReceiptId: (() => { let n = 0; return () => `rcpt-nav-${(n += 1)}`; })() });
        const receipts = [];
        for (let index = 0; index < 11; index += 1) receipts.push((await route.generate({ schemaVersion: "rovara-e2e-model-channel/v1", runId, caseId: "case", stepIndex: 1, callIndex: index,
          call: { prompt: [{ role: "user", content: [{ type: "text", text: `Goal: export ${index}` }] }], maxOutputTokens: 64 } } as never, {})).receipt);
        return { caseVerdict: "unknown", caseCode: "model-route-budget-exhausted", receipts, reported: null };
      } });
    const parsed = E2EModelCheckResultSchema.parse(result);
    if (parsed.status !== "driven") throw new Error("expected a finding");
    // The first call plus the navigation's calls: 6 in all, then the budget refusals (which are receipts too, with no tokens).
    expect(parsed.drive.receipts.filter((item) => item.outcome === "ok")).toHaveLength(6);
    expect(parsed.drive.receipts.filter((item) => item.outcome === "budget")).toHaveLength(6);
    expect(parsed.drive.calls).toBe(6);
    expect(parsed.drive).toMatchObject({ outcome: "failed", caseVerdict: "unknown", caseCode: "model-route-budget-exhausted" });
    // The broker accepts it as what it is, a failed test, and the same facts claimed as a pass are refused.
    const expected = { checkId: CHECK, kind: "drive", provider: "amazon-bedrock", startShape: "standard", definitions: defs } as const;
    expect(validateModelCheckResult(result, expected)).toMatchObject({ ok: true, finding: { outcome: "failed" } });
    expect(validateModelCheckResult({ ...parsed, drive: { ...parsed.drive, outcome: "passed" } }, expected)).toMatchObject({ ok: false });
  });
});

describe("the check the runner makes", () => {
  it("drive, a pass: the first call and the navigation's receipts are one finding the broker's validator accepts", async () => {
    const { invokeFor, calls } = invokes({ standard: () => answer() });
    const result = await runE2EModelCheck(driveRequest(), { ...base, invokeFor,
      async navigate({ definition, runId, ledger, invoke }) {
        const route = createGovernedE2EModelRoute(definition, { invoke, now: () => Date.now(), dayBudget: ledger });
        const receipts = [];
        for (let index = 0; index < 2; index += 1) receipts.push((await route.generate({ schemaVersion: "rovara-e2e-model-channel/v1", runId, caseId: "case-drive", stepIndex: 1, callIndex: index,
          call: { prompt: [{ role: "user", content: [{ type: "text", text: "Goal: export the orders" }] }], maxOutputTokens: 64 } } as never, {})).receipt);
        return { caseVerdict: "passed", caseCode: null, receipts, reported: { modelCalls: 2, downloads: 1, csvPassed: true } };
      } });
    expect(calls[0]!.shape).toBe("standard");
    expect(calls[0]!.input.maxOutputTokens).toBeLessThanOrEqual(512);
    const parsed = E2EModelCheckResultSchema.parse(result);
    expect(parsed).toMatchObject({ status: "driven", checkId: CHECK, drive: { outcome: "passed", payloadShape: "standard", calls: 3, failure: null, caseVerdict: "passed" } });
    expect(validateModelCheckResult(result, { checkId: CHECK, kind: "drive", provider: "amazon-bedrock", startShape: "standard", definitions: defs })).toMatchObject({ ok: true, kind: "drive" });
    // The finding carries digests and counts only.
    const text = JSON.stringify(result);
    expect(text).not.toContain("secret answer");
    expect(text).not.toContain("Reply with OK");
  });

  it("request-rejected on the standard shape: one retry in the minimal shape, then the navigation in that shape", async () => {
    const { invokeFor, calls } = invokes({ standard: () => { throw failure("request-rejected", "ValidationException"); }, minimal: () => answer() });
    const shapes: string[] = [];
    const result = await runE2EModelCheck(driveRequest(), { ...base, invokeFor,
      async navigate({ definition, runId, ledger, invoke }) {
        shapes.push(definition.payloadShape ?? "standard");
        const route = createGovernedE2EModelRoute(definition, { invoke, now: () => Date.now(), dayBudget: ledger });
        const receipts = [];
        for (let index = 0; index < 2; index += 1) receipts.push((await route.generate({ schemaVersion: "rovara-e2e-model-channel/v1", runId, caseId: "case-drive", stepIndex: 1, callIndex: index,
          call: { prompt: [{ role: "user", content: [{ type: "text", text: "Goal: export the orders" }] }], maxOutputTokens: 64 } } as never, {})).receipt);
        return { caseVerdict: "passed", caseCode: null, receipts, reported: { modelCalls: 2, downloads: 1, csvPassed: true } };
      } });
    expect(calls.filter((item) => item.shape === "standard")).toHaveLength(1);
    expect(shapes).toEqual(["minimal"]);
    const parsed = E2EModelCheckResultSchema.parse(result);
    if (parsed.status !== "driven") throw new Error("expected a finding");
    expect(parsed.drive).toMatchObject({ payloadShape: "minimal", outcome: "passed", definitionDigest: e2eAgentRouteDefinitionDigest(defs.minimal), routeRevision: e2eModelRouteRevision(defs.minimal) });
    expect(validateModelCheckResult(result, { checkId: CHECK, kind: "drive", provider: "amazon-bedrock", startShape: "standard", definitions: defs })).toMatchObject({ ok: true });
  });

  it("a stored minimal shape begins in the minimal shape, and a rejection there is final", async () => {
    const { invokeFor, calls } = invokes({ standard: () => answer(), minimal: () => { throw failure("request-rejected"); } });
    const navigate = vi.fn();
    const result = await runE2EModelCheck(driveRequest({ definitionDigest: e2eAgentRouteDefinitionDigest(defs.minimal) }), { ...base, invokeFor, navigate });
    expect(calls.map((item) => item.shape)).toEqual(["minimal"]);
    expect(navigate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "driven", drive: { payloadShape: "minimal", outcome: "failed", failure: { class: "request-rejected" } } });
    expect(validateModelCheckResult(result, { checkId: CHECK, kind: "drive", provider: "amazon-bedrock", startShape: "minimal", definitions: defs })).toMatchObject({ ok: true });
  });

  it("a limit on the first call ends the test with that class: no retry, no navigation, and no provider text in the result", async () => {
    const { invokeFor, calls } = invokes({ standard: () => { throw failure("limit-or-rate-limited", "ThrottlingException"); } });
    const navigate = vi.fn();
    const result = await runE2EModelCheck(driveRequest(), { ...base, invokeFor, navigate });
    expect(calls).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "driven", drive: { outcome: "failed", failure: { class: "limit-or-rate-limited", signal: "ThrottlingException" }, caseVerdict: "none", calls: 1 } });
    expect(JSON.stringify(result)).not.toContain("secret provider text");
  });

  it("refuses a request that is not valid, names another route, or runs where the environment could redirect the call: before any call", async () => {
    const { invokeFor, calls } = invokes({ standard: () => answer() });
    expect(await runE2EModelCheck({ ...driveRequest(), extra: 1 }, { ...base, invokeFor })).toMatchObject({ status: "refused", code: "check-request-invalid", checkId: CHECK });
    expect(await runE2EModelCheck({ schemaVersion: E2E_MODEL_CHECK_REQUEST_SCHEMA, checkId: CHECK, kind: "drive" }, { ...base, invokeFor })).toMatchObject({ status: "refused", code: "check-request-invalid" });
    expect(await runE2EModelCheck(driveRequest({ definitionDigest: "b".repeat(64) }), { ...base, invokeFor })).toMatchObject({ status: "refused", code: "model-route-changed-reapprove" });
    expect(await runE2EModelCheck(driveRequest(), { ...base, invokeFor, environment: { ...env, AWS_PROFILE: "someone" } })).toMatchObject({ status: "refused", code: "model-environment-unsafe" });
    expect(await runE2EModelCheck(driveRequest(), { ...base, invokeFor, environment: { AGENTX_MODEL_PROVIDER: "amazon-bedrock" } })).toMatchObject({ status: "refused", code: "agent-route-not-approved" });
    expect(calls).toHaveLength(0);
  });

  it("a fault outside the route is a fixed failed result with no message", async () => {
    const result = await runE2EModelCheck(driveRequest(), { ...base, invokeFor: async () => { throw new Error("secret internal detail"); } });
    expect(result).toEqual({ schemaVersion: "rovara-e2e-model-check-result/v2", status: "failed", reason: "check-run-failed", checkId: CHECK });
  });

  it("discover reports the report of the injected transports and never throws", async () => {
    const discoveryDependencies = vi.fn(() => ({ now: () => Date.parse("2026-10-23T12:00:00.000Z") }));
    const result = await runE2EModelCheck({ schemaVersion: E2E_MODEL_CHECK_REQUEST_SCHEMA, checkId: CHECK, kind: "discover" }, { ...base, discoveryDependencies });
    expect(result).toMatchObject({ status: "discovered", checkId: CHECK, discovery: { provider: "amazon-bedrock", status: "unverified", unverifiedReason: "not-supported", models: [] } });
    expect(discoveryDependencies).toHaveBeenCalledWith({ provider: "amazon-bedrock", region: "us-east-1" });
  });

  it("dispatches by version: the single-call canary (v1) is served as before and writes no finding", async () => {
    const result = await runRequest({ schemaVersion: "rovara-e2e-model-canary-request/v1", canaryId: CHECK, extra: true }) as { status: string; code: string };
    expect(result).toMatchObject({ status: "refused", code: "canary-request-invalid" });
    expect(requestIdOf({ canaryId: CHECK })).toBe(CHECK);
    expect(requestIdOf({ checkId: "nope" })).toBeUndefined();
  });

  it("finds the driving test's host from the worker's own configuration, and fails closed without it", () => {
    expect(() => drivingTestHostConfig({}, "linux", "arm64")).toThrow(/EXECUTOR_IMAGE/);
    expect(() => drivingTestHostConfig({ EXECUTOR_IMAGE: "-bad" }, "linux", "arm64")).toThrow();
    expect(drivingTestHostConfig({ EXECUTOR_IMAGE: "111122223333.dkr.ecr.us-east-1.amazonaws.com/executor@sha256:" + "e".repeat(64) }, "linux", "arm64")).toMatchObject({ runRoot: expect.stringContaining("web-api-probes") as string });
  });
});

describe("the bounded model check server (test 32)", () => {
  const PREFIX = "e2e-runtime/AROAEXAMPLEROLEID1234:i-0123456789abcdef0/";
  const args = { bucket: "agentx-test-artifacts", prefix: PREFIX, waitSeconds: 4 * 3600 };
  const id = (n: number) => `5b0e8a52-6f3e-4b8f-9f1c-0f5c1f4f2a${String(n).padStart(2, "0")}`;
  const request = (n: number) => Buffer.from(JSON.stringify({ schemaVersion: E2E_MODEL_CHECK_REQUEST_SCHEMA, checkId: id(n), kind: "discover" }));

  function server(options: { requests?: Array<Uint8Array | undefined | Error>; waitSeconds?: number; stopAfterPolls?: number; putFails?: boolean } = {}) {
    let clock = 0;
    const lines: string[] = [];
    const puts: Array<{ key: string; body: string; at: number }> = [];
    const gets: number[] = [];
    const ran: string[] = [];
    const feed = [...(options.requests ?? [])];
    let current: Uint8Array | undefined | Error;
    const transport: CanaryTransport = {
      async get(key) {
        gets.push(clock);
        expect(key).toBe(`${PREFIX}${CANARY_REQUEST_KEY}`);
        if (feed.length > 0) current = feed.shift();
        if (current instanceof Error) throw current;
        return current;
      },
      async put(key, body) { if (options.putFails === true) throw new Error("denied"); puts.push({ key, body, at: clock }); },
    };
    const value = { transport, run: async (raw: unknown) => { const checkId = (raw as { checkId: string }).checkId; ran.push(checkId); return { schemaVersion: "rovara-e2e-model-check-result/v2", status: "discovered", checkId }; },
      sleep: async (ms: number) => { clock += ms; }, now: () => clock, log: (line: string) => lines.push(line),
      stopped: () => options.stopAfterPolls !== undefined && gets.length >= options.stopAfterPolls };
    return { value, lines, puts, gets, ran, advance: (ms: number) => { clock += ms; }, clockNow: () => clock, args: { ...args, waitSeconds: options.waitSeconds ?? args.waitSeconds } };
  }

  it("serves each check id once: a repeat of the request under the key is ignored", async () => {
    const s = server({ requests: [request(1)], stopAfterPolls: 5 });
    expect(await serveModelChecks(s.args, s.value)).toBe(0);
    expect(s.ran).toEqual([id(1)]);
    expect(s.puts.map((item) => item.key)).toEqual([`${PREFIX}${CANARY_RESULT_KEY}`]);
  });

  it("serves a second check once it is under the key, at least 60 seconds after the first", async () => {
    // The second request is there from the first poll after the first was served; the server waits out the spacing before serving it.
    const s = server({ requests: [request(1), request(1), request(2)], stopAfterPolls: 6 });
    await serveModelChecks(s.args, s.value);
    expect(s.ran).toEqual([id(1), id(2)]);
    expect(s.puts[1]!.at - s.puts[0]!.at).toBeGreaterThanOrEqual(60_000);
  });

  it("refuses a 13th check with served-limit and makes no call for it", async () => {
    const requests = Array.from({ length: 13 }, (_unused, index) => request(index + 1));
    const s = server({ requests, stopAfterPolls: 14, waitSeconds: 30 * 24 * 3600 });
    await serveModelChecks({ ...s.args, waitSeconds: 30 * 24 * 3600 }, s.value);
    expect(s.ran).toHaveLength(12);
    expect(s.ran).not.toContain(id(13));
    expect(JSON.parse(s.puts.at(-1)!.body)).toEqual({ schemaVersion: "rovara-e2e-model-check-result/v2", status: "refused", code: "served-limit", checkId: id(13) });
    expect(s.lines).toContain("model-check: refused, served-limit");
  });

  it("polls every 20 seconds for two hours, then every 120 seconds, and stops at the expiry", async () => {
    const s = server({ waitSeconds: 3 * 3600 });
    expect(await serveModelChecks(s.args, s.value)).toBe(0);
    const gaps = s.gets.slice(1).map((at, index) => at - s.gets[index]!);
    expect(gaps[0]).toBe(20_000);
    expect(gaps.filter((gap) => gap === 20_000)).toHaveLength(360);
    expect(gaps.at(-1)).toBe(120_000);
    expect(s.clockNow()).toBeGreaterThanOrEqual(3 * 3600 * 1000);
    expect(s.lines.at(-1)).toBe("model-check: stopped");
    expect(s.puts).toEqual([]);
    expect(s.ran).toEqual([]);
  });

  it("stops when told to, and with 0 seconds does not even poll", async () => {
    const stopped = server({ stopAfterPolls: 2 });
    await serveModelChecks(stopped.args, stopped.value);
    expect(stopped.gets).toHaveLength(2);
    const none = server({ waitSeconds: 0 });
    await serveModelChecks(none.args, none.value);
    expect(none.gets).toHaveLength(0);
  });

  it("logs one fixed line, with the error's name, for the first unreadable request, and nothing about the error's text", async () => {
    const throttled = Object.assign(new Error("Slow down for arn:aws:s3:::secret-bucket/key"), { name: "SlowDown" });
    const s = server({ requests: [throttled], stopAfterPolls: 5 });
    await serveModelChecks(s.args, s.value);
    expect(s.lines.filter((line) => line.startsWith("model-check: request not readable"))).toEqual(["model-check: request not readable (SlowDown)"]);
    expect(s.lines.join("\n")).not.toContain("secret-bucket");
    expect(s.ran).toEqual([]);
  });

  // Review M-3: the worker role has no s3:ListBucket, so S3 answers a key that is not there with AccessDenied (403): that is a healthy runner with no request yet.
  it("a healthy runner polling for a request that is not there logs nothing: S3's AccessDenied and NoSuchKey are 'not there yet'", async () => {
    for (const absent of [Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }), Object.assign(new Error("nope"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } }),
      Object.assign(new Error("Forbidden"), { name: "Forbidden", $metadata: { httpStatusCode: 403 } })]) {
      const transport = s3CanaryTransport("agentx-test-artifacts", "us-east-1", { send: async () => { throw absent; } });
      const s = server({ stopAfterPolls: 6 });
      s.value.transport = transport;
      await serveModelChecks(s.args, s.value);
      expect(s.lines.filter((line) => line.includes("not readable")), absent.name).toEqual([]);
      expect(s.ran).toEqual([]);
    }
  });

  it("a real S3 fault (throttling, a 5xx) is still thrown by the transport and logged once, by name", async () => {
    const fault = Object.assign(new Error("Please reduce your request rate for secret-bucket"), { name: "SlowDown", $metadata: { httpStatusCode: 503 } });
    const transport = s3CanaryTransport("agentx-test-artifacts", "us-east-1", { send: async () => { throw fault; } });
    await expect(transport.get(`${PREFIX}${CANARY_REQUEST_KEY}`)).rejects.toBe(fault);
    const s = server({ stopAfterPolls: 6 });
    s.value.transport = transport;
    await serveModelChecks(s.args, s.value);
    expect(s.lines.filter((line) => line.includes("not readable"))).toEqual(["model-check: request not readable (SlowDown)"]);
    expect(s.lines.join("\n")).not.toContain("secret-bucket");
  });

  it("returns the request's bytes when S3 has it", async () => {
    const transport = s3CanaryTransport("agentx-test-artifacts", "us-east-1", { send: async () => ({ Body: { transformToByteArray: async () => Buffer.from("{}") } }) });
    expect(Buffer.from((await transport.get(`${PREFIX}${CANARY_REQUEST_KEY}`))!).toString()).toBe("{}");
  });

  it("a transient fault in putting the result is retried, and does not end the server", async () => {
    const s = server({ requests: [request(1)], stopAfterPolls: 3 });
    let failures = 2;
    const inner = s.value.transport;
    s.value.transport = { get: (key) => inner.get(key), put: async (key, body) => { if (failures > 0) { failures -= 1; throw new Error("denied"); } await inner.put(key, body); } };
    expect(await serveModelChecks(s.args, s.value)).toBe(0);
    expect(s.puts).toHaveLength(1);
    expect(s.lines).not.toContain("model-check: the result could not be uploaded");
  });

  it("answers a request that is empty, oversized or not JSON with a fixed refusal and no call, and exits 1 when the result cannot be put", async () => {
    for (const body of [Buffer.alloc(0), Buffer.alloc(4_097, 120), Buffer.from("{not json")]) {
      const s = server({ requests: [body], stopAfterPolls: 3 });
      await serveModelChecks(s.args, s.value);
      expect(s.ran).toEqual([]);
      expect(JSON.parse(s.puts[0]!.body)).toEqual({ schemaVersion: "rovara-e2e-model-check-result/v2", status: "refused", code: "check-request-invalid", checkId: null });
    }
    const failing = server({ requests: [request(1)], putFails: true });
    expect(await serveModelChecks(failing.args, failing.value)).toBe(1);
    expect(failing.lines).toContain("model-check: the result could not be uploaded");
  });

  it("a fault in the check is a fixed failed result and a fixed log line", async () => {
    const s = server({ requests: [request(1)], stopAfterPolls: 3 });
    s.value.run = async () => { throw Object.assign(new Error("secret detail"), { name: "TypeError" }); };
    await serveModelChecks(s.args, s.value);
    expect(JSON.parse(s.puts[0]!.body)).toEqual({ schemaVersion: "rovara-e2e-model-check-result/v2", status: "failed", reason: "check-run-failed", checkId: id(1) });
    expect(s.lines.join("\n")).not.toContain("secret detail");
    expect(s.lines).toContain("model-check: failed (TypeError)");
  });

  it("refuses arguments outside its own prefix shape, and serves for seven days by default", () => {
    expect(parseCanaryCliArgs(["--bucket", "agentx-test-artifacts", "--prefix", PREFIX])).toEqual({ bucket: "agentx-test-artifacts", prefix: PREFIX, waitSeconds: 604_800 });
    for (const argv of [["--bucket", "b"], ["--bucket", "agentx-test-artifacts", "--prefix", "e2e-runtime/other/"], ["--bucket", "agentx-test-artifacts", "--prefix", PREFIX, "--x", "1"],
      ["--bucket", "agentx-test-artifacts", "--prefix", PREFIX, "--wait-seconds", "-1"], ["--bucket", "agentx-test-artifacts", "--prefix", PREFIX, "--wait-seconds", "604801"]]) {
      expect(() => parseCanaryCliArgs(argv)).toThrow();
    }
  });
});
