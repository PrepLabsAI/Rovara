import { describe, expect, it } from "vitest";
import { DRIVING_TEST_FIRST_CALL_CASE_ID, E2E_MODEL_CHECK_RESULT_SCHEMA, e2eModelRouteRevision } from "../../packages/contracts/src/index.js";
import { deriveE2EAgentRouteForModel, e2eAgentRouteDefinitionDigest } from "../../packages/model-runtime/src/e2e-route-derive.js";
import { formatCanaryPlan, parseCanaryArgs, runModelCanary, type CanaryEffects, type CanaryFacts } from "../../scripts/test-model-canary.js";

// M1.4 Task 4.9 step 3, as Task 4.10C changed it: the operator's plan-first model check command, driven with fakes. Nothing here calls AWS or a model.

const ENV = "agentxlivetest123";
const ROLE_ID = "AROAEXAMPLEROLEID123";
const INSTANCE_ID = "i-0123456789abcdef0";
const PREFIX = `e2e-runtime/${ROLE_ID}:${INSTANCE_ID}/`;
const CHECK_ID = "5b0e8a52-6f3e-4b8f-9f1c-0f5c1f4f2a11";
const MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const installation = { provider: "amazon-bedrock", region: "us-east-1" };
const defs = (() => {
  const standard = deriveE2EAgentRouteForModel(installation, MODEL, "standard", 1);
  const minimal = deriveE2EAgentRouteForModel(installation, MODEL, "minimal", 1);
  if (standard.status !== "available" || minimal.status !== "available") throw new Error("fixture");
  return { standard: standard.definition, minimal: minimal.definition };
})();
const digest = e2eAgentRouteDefinitionDigest(defs.standard);
const facts: CanaryFacts = { bucket: "agentx-agentxlivetest123-control-artifacts", stateTable: "agentx-agentxlivetest123-state", roleId: ROLE_ID, installation };
const args = parseCanaryArgs(["--env", ENV, "--profile", "agentx-test", "--instance", INSTANCE_ID, "--model", MODEL, "--apply"]);

let n = 0;
const receipt = (overrides: Record<string, unknown> = {}) => {
  n += 1;
  return { receiptId: `rcpt-${n}`, runId: CHECK_ID, caseId: DRIVING_TEST_FIRST_CALL_CASE_ID, stepIndex: 0, callIndex: 0, routeId: defs.standard.routeId, routeRevision: e2eModelRouteRevision(defs.standard),
    provider: "amazon-bedrock", modelId: MODEL, startedAt: new Date(Date.parse("2026-10-23T12:00:00Z") + n * 1000).toISOString(), inputTokens: 1000, outputTokens: 40, latencyMs: 900,
    servedModelId: null, servedUpstream: null, promptSha256: "c".repeat(64), responseSha256: "d".repeat(64), outcome: "ok", ...overrides };
};
const passed = (overrides: Record<string, unknown> = {}) => {
  const receipts = [receipt(), receipt({ caseId: "case", stepIndex: 1, callIndex: 0 }), receipt({ caseId: "case", stepIndex: 1, callIndex: 1 })];
  return { schemaVersion: E2E_MODEL_CHECK_RESULT_SCHEMA, status: "driven", checkId: CHECK_ID, drive: { routeId: defs.standard.routeId, routeRevision: e2eModelRouteRevision(defs.standard), definitionDigest: digest,
    provider: "amazon-bedrock", modelId: MODEL, payloadShape: "standard", outcome: "passed", failure: null, calls: 3, inputTokens: 3000, outputTokens: 120, caseVerdict: "passed", caseCode: null,
    receipts, reported: { modelCalls: 2, downloads: 1, csvPassed: true }, ...overrides } };
};

function effects(answer: unknown, options: { stale?: boolean; shape?: "minimal" } = {}) {
  const objects = new Map<string, Buffer>();
  if (options.stale) objects.set(`${PREFIX}canary-result.json`, Buffer.from(JSON.stringify({ ...passed(), checkId: "6b0e8a52-6f3e-4b8f-9f1c-0f5c1f4f2a11" })));
  const puts: Array<{ key: string; body: Record<string, unknown> }> = [];
  const recorded: Array<{ kind: string; checkId: string }> = [];
  const lines: string[] = [];
  let clock = 0;
  const value: CanaryEffects = {
    resolveFacts: async () => facts,
    getObject: async (key) => objects.get(key),
    putObject: async (key, bytes) => {
      puts.push({ key, body: JSON.parse(bytes.toString("utf8")) as Record<string, unknown> });
      if (key.endsWith("canary-request.json") && answer !== undefined) objects.set(`${PREFIX}canary-result.json`, Buffer.from(JSON.stringify(answer)));
    },
    readShape: async () => options.shape,
    recordDrive: async (validated, checkId) => { recorded.push({ kind: `drive-${validated.finding.outcome}`, checkId }); },
    recordDiscovery: async (_provider, _report, checkId) => { recorded.push({ kind: "discovery", checkId }); },
    now: () => clock, sleep: async (ms) => { clock += ms; }, print: (line) => lines.push(line), newCheckId: () => CHECK_ID,
  };
  return { value, puts, recorded, lines };
}

describe("scripts/test-model-canary.ts", () => {
  it("is plan-first: without --apply it only prints the plan, with the exact bounds", () => {
    const planOnly = parseCanaryArgs(["--env", ENV, "--profile", "agentx-test", "--instance", INSTANCE_ID, "--model", MODEL]);
    expect(planOnly.apply).toBe(false);
    const text = formatCanaryPlan(planOnly);
    expect(text).toContain("at most 6 model calls, 36,000 input tokens in all and 512 output tokens per call");
    expect(text).toContain("E2E_MODEL_ROUTE_CANARY#<routeId>#<definitionDigest> (test driving/v1)");
    expect(text).toContain(INSTANCE_ID);
    expect(formatCanaryPlan(parseCanaryArgs(["--env", ENV, "--profile", "p", "--instance", INSTANCE_ID, "--discover"]))).toContain("no model call");
  });

  it("refuses an installation that is not allowlisted, and production, before anything", () => {
    expect(() => parseCanaryArgs(["--env", "production", "--profile", "p", "--instance", INSTANCE_ID], ["production"])).toThrow(/production/);
    expect(() => parseCanaryArgs(["--env", "otherenv", "--profile", "p", "--instance", INSTANCE_ID])).toThrow(/allowlisted/);
    expect(() => parseCanaryArgs(["--env", ENV, "--profile", "p", "--instance", "i-bad"])).toThrow(/--instance/);
    expect(() => parseCanaryArgs(["--env", ENV, "--profile", "p"])).toThrow(/--instance/);
    expect(() => parseCanaryArgs(["--env", ENV, "--instance", INSTANCE_ID])).toThrow(/--profile/);
    expect(() => parseCanaryArgs(["--env", ENV, "--profile", "p", "--instance", INSTANCE_ID, "--model", "a b;c"])).toThrow(/--model/);
    expect(() => parseCanaryArgs(["--env", ENV, "--profile", "p", "--instance", INSTANCE_ID, "--discover", "--model", MODEL])).toThrow(/--discover/);
  });

  it("refuses to run without --apply", async () => {
    const fake = effects(passed());
    await expect(runModelCanary(parseCanaryArgs(["--env", ENV, "--profile", "agentx-test", "--instance", INSTANCE_ID, "--model", MODEL]), fake.value)).rejects.toThrow(/--apply/);
    expect(fake.puts).toEqual([]);
  });

  it("asks for a v2 driving test of the planned route and records the rows only for a validated pass", async () => {
    const fake = effects(passed());
    expect(await runModelCanary(args, fake.value)).toBe(0);
    expect(fake.puts).toEqual([{ key: `${PREFIX}canary-request.json`, body: { schemaVersion: "rovara-e2e-model-check-request/v2", checkId: CHECK_ID, kind: "drive", routeId: defs.standard.routeId, definitionDigest: digest } }]);
    expect(fake.recorded).toEqual([{ kind: "drive-passed", checkId: CHECK_ID }]);
    expect(fake.lines.join("\n")).toContain("driving test passed");
    expect(fake.lines.join("\n")).toContain("inputTokens 1000");
  });

  it("an earlier answer under the key is not this check's: it waits for the one that names it", async () => {
    const fake = effects(passed(), { stale: true });
    expect(await runModelCanary(args, fake.value)).toBe(0);
    expect(fake.recorded).toHaveLength(1);
  });

  it("asks in the stored shape when a minimal shape passed before", async () => {
    const fake = effects(undefined, { shape: "minimal" });
    await runModelCanary({ ...args, timeoutMinutes: 1 }, fake.value);
    expect(fake.puts[0]!.body["definitionDigest"]).toBe(e2eAgentRouteDefinitionDigest(defs.minimal));
  });

  it("records a failed test's row but exits 1, and writes nothing for a result that does not add up", async () => {
    const failed = receipt({ outcome: "provider-error", responseSha256: null, inputTokens: 0, outputTokens: 0, failure: { class: "limit-or-rate-limited", signal: "ThrottlingException" } });
    const fake = effects(passed({ outcome: "failed", failure: { class: "limit-or-rate-limited", signal: "ThrottlingException" }, caseVerdict: "none", reported: null, calls: 1, inputTokens: 0, outputTokens: 0, receipts: [failed] }));
    expect(await runModelCanary(args, fake.value)).toBe(1);
    expect(fake.recorded).toEqual([{ kind: "drive-failed", checkId: CHECK_ID }]);
    expect(fake.lines.join("\n")).toContain("limit-or-rate-limited (ThrottlingException)");
    for (const answer of [
      passed({ reported: { modelCalls: 3, downloads: 1, csvPassed: true } }), passed({ caseVerdict: "unknown", caseCode: "agent-no-download" }), passed({ definitionDigest: "f".repeat(64) }),
      passed({ calls: 2 }), { schemaVersion: E2E_MODEL_CHECK_RESULT_SCHEMA, status: "refused", code: "model-environment-unsafe", checkId: CHECK_ID },
      { schemaVersion: E2E_MODEL_CHECK_RESULT_SCHEMA, status: "failed", reason: "check-run-failed", checkId: CHECK_ID }, { checkId: CHECK_ID, junk: true },
    ]) {
      const other = effects(answer);
      expect(await runModelCanary(args, other.value), JSON.stringify(answer)).toBe(1);
      expect(other.recorded, JSON.stringify(answer)).toEqual([]);
    }
  });

  it("records a discovery without a model call and exits 0", async () => {
    const answer = { schemaVersion: E2E_MODEL_CHECK_RESULT_SCHEMA, status: "discovered", checkId: CHECK_ID, discovery: { schemaVersion: "rovara-model-discovery/v1", provider: "amazon-bedrock", checkedAt: "2026-10-23T10:00:00.000Z", status: "listed",
      models: [{ modelId: MODEL, visible: true, state: "available", quotas: [{ scope: "geographic", code: "L-1", tokensPerMinute: 5 }], signals: [] }] } };
    const fake = effects(answer);
    expect(await runModelCanary({ ...args, discover: true }, fake.value)).toBe(0);
    expect(fake.puts[0]!.body).toEqual({ schemaVersion: "rovara-e2e-model-check-request/v2", checkId: CHECK_ID, kind: "discover" });
    expect(fake.recorded).toEqual([{ kind: "discovery", checkId: CHECK_ID }]);
    expect(fake.lines.join("\n")).toContain(`${MODEL}: available, geographic L-1 5 tokens per minute`);
  });

  it("gives up, bounded, when the runner never answers, and writes no row", async () => {
    const fake = effects(undefined);
    expect(await runModelCanary(args, fake.value)).toBe(1);
    expect(fake.recorded).toEqual([]);
    expect(fake.lines.join("\n")).toMatch(/no result for this check within/);
  });

  it("refuses an installation with no provider, or a model Rovara cannot use there, sending nothing", async () => {
    const none = effects(passed());
    none.value.resolveFacts = async () => ({ ...facts, installation: {} });
    await expect(runModelCanary(args, none.value)).rejects.toThrow(/no AI navigation route/);
    const bad = effects(passed());
    await expect(runModelCanary({ ...args, model: "anthropic.claude-haiku-4-5-20251001-v1:0" }, bad.value)).rejects.toThrow(/not one Rovara can use/);
    expect(none.puts).toEqual([]);
    expect(bad.puts).toEqual([]);
  });
});
