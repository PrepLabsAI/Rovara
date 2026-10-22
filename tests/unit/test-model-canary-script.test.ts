import { describe, expect, it } from "vitest";
import { deriveE2EAgentRoute, e2eAgentRouteDefinitionDigest } from "../../packages/model-runtime/src/e2e-route-derive.js";
import { e2eModelRouteRevision } from "../../packages/contracts/src/e2e-model-channel.js";
import { formatCanaryPlan, parseCanaryArgs, runModelCanary, type CanaryEffects, type CanaryFacts } from "../../scripts/test-model-canary.js";

// M1.4 Task 4.9 step 3: the operator's plan-first model canary command, driven with fakes. Nothing here calls AWS or a model.

const ENV = "agentxlivetest123";
const ROLE_ID = "AROAEXAMPLEROLEID123";
const INSTANCE_ID = "i-0123456789abcdef0";
const PREFIX = `e2e-runtime/${ROLE_ID}:${INSTANCE_ID}/`;
const CANARY_ID = "5b0e8a52-6f3e-4b8f-9f1c-0f5c1f4f2a11";
const installation = { provider: "amazon-bedrock", region: "us-east-1" };
const definition = (() => { const derived = deriveE2EAgentRoute(installation, 1); if (derived.status !== "available") throw new Error("fixture"); return derived.definition; })();
const digest = e2eAgentRouteDefinitionDigest(definition);
const facts: CanaryFacts = { bucket: "agentx-agentxlivetest123-control-artifacts", stateTable: "agentx-agentxlivetest123-state", roleId: ROLE_ID, installation };
const args = parseCanaryArgs(["--env", ENV, "--profile", "agentx-test", "--instance", INSTANCE_ID, "--apply"]);

const receipt = (overrides: Record<string, unknown> = {}) => ({
  receiptId: "rcpt-canary-1", runId: CANARY_ID, caseId: "model-canary", stepIndex: 0, callIndex: 0, routeId: definition.routeId, routeRevision: e2eModelRouteRevision(definition),
  provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-5-5", startedAt: "2026-10-22T12:00:00.000Z", inputTokens: 41, outputTokens: 3, latencyMs: 900,
  servedModelId: null, servedUpstream: null, promptSha256: "c".repeat(64), responseSha256: "d".repeat(64), outcome: "ok", ...overrides,
});
const called = (overrides: Record<string, unknown> = {}, receiptOverrides: Record<string, unknown> = {}) => ({
  schemaVersion: "rovara-e2e-model-canary-result/v1", status: "called", canaryId: CANARY_ID, routeId: definition.routeId, routeRevision: e2eModelRouteRevision(definition), definitionDigest: digest,
  provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-5-5", calls: 1, receipt: receipt(receiptOverrides), providerPayloadSha256: "e".repeat(64), usageMissing: false, ...overrides,
});

function effects(answer: unknown, options: { stale?: boolean; rowExists?: boolean } = {}) {
  const objects = new Map<string, Buffer>();
  if (options.stale) objects.set(`${PREFIX}canary-result.json`, Buffer.from("{}"));
  const puts: Array<{ key: string; body: unknown }> = [];
  const rows: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  let clock = 0;
  const value: CanaryEffects = {
    resolveFacts: async () => facts,
    getObject: async (key) => objects.get(key),
    putObject: async (key, bytes) => {
      puts.push({ key, body: JSON.parse(bytes.toString("utf8")) });
      // The runner answers a request with its result.
      if (key.endsWith("canary-request.json") && answer !== undefined) objects.set(`${PREFIX}canary-result.json`, Buffer.from(JSON.stringify(answer)));
    },
    putCanaryRow: async (item) => { rows.push(item); return options.rowExists ? "exists" : "written"; },
    now: () => clock, sleep: async (ms) => { clock += ms; }, print: (line) => lines.push(line), newCanaryId: () => CANARY_ID,
  };
  return { value, puts, rows, lines };
}

describe("scripts/test-model-canary.ts", () => {
  it("is plan-first: without --apply it only prints the plan, with the exact call bounds", () => {
    const planOnly = parseCanaryArgs(["--env", ENV, "--profile", "agentx-test", "--instance", INSTANCE_ID]);
    expect(planOnly.apply).toBe(false);
    const text = formatCanaryPlan(planOnly);
    expect(text).toContain("at most 1 model call");
    expect(text).toContain("input at most 32,000 tokens");
    expect(text).toContain("output at most 1,024 tokens");
    expect(text).toContain("E2E_MODEL_ROUTE_CANARY#<routeId>#<definitionDigest>");
    expect(text).toContain(`${INSTANCE_ID}`);
  });

  it("refuses an installation that is not allowlisted, and production, before anything", () => {
    expect(() => parseCanaryArgs(["--env", "production", "--profile", "p", "--instance", INSTANCE_ID], ["production"])).toThrow(/production/);
    expect(() => parseCanaryArgs(["--env", "otherenv", "--profile", "p", "--instance", INSTANCE_ID])).toThrow(/allowlisted/);
    expect(() => parseCanaryArgs(["--env", ENV, "--profile", "p", "--instance", "i-bad"])).toThrow(/--instance/);
    expect(() => parseCanaryArgs(["--env", ENV, "--profile", "p"])).toThrow(/--instance/);
    expect(() => parseCanaryArgs(["--env", ENV, "--instance", INSTANCE_ID])).toThrow(/--profile/);
  });

  it("refuses to run without --apply", async () => {
    const fake = effects(called());
    await expect(runModelCanary(parseCanaryArgs(["--env", ENV, "--profile", "agentx-test", "--instance", INSTANCE_ID]), fake.value)).rejects.toThrow(/--apply/);
    expect(fake.puts).toEqual([]);
  });

  it("asks the runner for one call with the bounds and the planned route, and records the canary row only on an ok receipt", async () => {
    const fake = effects(called());
    expect(await runModelCanary(args, fake.value)).toBe(0);
    expect(fake.puts).toEqual([{ key: `${PREFIX}canary-request.json`, body: {
      schemaVersion: "rovara-e2e-model-canary-request/v1", canaryId: CANARY_ID, routeId: definition.routeId, definitionDigest: digest, maxCalls: 1, maxInputTokens: 32_000, maxOutputTokens: 1024,
    } }]);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]).toMatchObject({ pk: "E2E_MODEL_ROUTES", sk: `E2E_MODEL_ROUTE_CANARY#${definition.routeId}#${digest}`, entityType: "E2E_MODEL_ROUTE_CANARY",
      routeId: definition.routeId, definitionDigest: digest, provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-5-5", servedModelId: null, canaryId: CANARY_ID, instanceId: INSTANCE_ID,
      receipt: { outcome: "ok", inputTokens: 41, outputTokens: 3 } });
    const out = fake.lines.join("\n");
    expect(out).toContain("outcome ok");
    expect(out).toContain("inputTokens 41");
  });

  it("writes no row for a receipt that is not ok, or breaks a bound, or is not the call it asked for", async () => {
    for (const answer of [
      called({}, { outcome: "provider-error", responseSha256: null, inputTokens: 0, outputTokens: 0 }),
      called({}, { inputTokens: 32_001 }),
      called({ calls: 2 }),
      called({ canaryId: "00000000-0000-4000-8000-000000000000" }),
      called({}, { runId: "00000000-0000-4000-8000-000000000000" }),
      called({ definitionDigest: "f".repeat(64) }),
      called({}, { modelId: "us.anthropic.claude-sonnet-5-5" }),
      { schemaVersion: "rovara-e2e-model-canary-result/v1", status: "refused", code: "model-environment-unsafe", canaryId: CANARY_ID },
      { schemaVersion: "rovara-e2e-model-canary-result/v1", status: "failed", reason: "canary-run-failed" },
      "not an object",
    ]) {
      const fake = effects(answer);
      expect(await runModelCanary(args, fake.value), JSON.stringify(answer)).toBe(1);
      expect(fake.rows, JSON.stringify(answer)).toEqual([]);
    }
  });

  it("gives up, bounded, when the runner never answers, and writes no row", async () => {
    const fake = effects(undefined);
    expect(await runModelCanary(args, fake.value)).toBe(1);
    expect(fake.rows).toEqual([]);
    expect(fake.lines.join("\n")).toMatch(/no canary result within/);
  });

  it("refuses a runner that already served its one canary, sending nothing", async () => {
    const fake = effects(called(), { stale: true });
    await expect(runModelCanary(args, fake.value)).rejects.toThrow(/already/);
    expect(fake.puts).toEqual([]);
  });

  it("refuses an installation with no usable route, sending nothing", async () => {
    const fake = effects(called());
    fake.value.resolveFacts = async () => ({ ...facts, installation: { provider: "amazon-bedrock" } });
    await expect(runModelCanary(args, fake.value)).rejects.toThrow(/no AI navigation route/);
    expect(fake.puts).toEqual([]);
  });

  it("says so when the row was already recorded for this exact route", async () => {
    const fake = effects(called(), { rowExists: true });
    expect(await runModelCanary(args, fake.value)).toBe(0);
    expect(fake.lines.join("\n")).toContain("already recorded");
  });
});
