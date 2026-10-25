import { describe, expect, it } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DRIVING_TEST_FIRST_CALL_CASE_ID, E2E_MODEL_CHECK_RESULT_SCHEMA, e2eModelRouteRevision, type E2EModelReceipt } from "@agentx/contracts";
import { deriveE2EAgentRouteForModel, e2eAgentRouteDefinitionDigest, type E2EAgentInstallation } from "../../packages/model-runtime/src/e2e-route-derive.js";
import {
  ModelCheckError, readCurrentTiers, readModelCheck, startModelCheck, untestedRouteSentence, validateModelCheckResult, type ExpectedModelCheck, type ModelCheckDependencies,
} from "../../packages/broker/src/e2e/model-checks.js";
import {
  e2eAgentInstallationFromParameters, e2eModelCheckRunnerKey, e2eModelRouteCanaryKey, e2eModelRouteShapeKey, e2eModelRouteTestKey, planE2EAgentRoute, readE2EModelRouteShape,
} from "../../packages/broker/src/e2e/model-route-registry.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

// M1.4 Task 4.10C, tests 34 and 35: the broker's validation of a model check result, the rows a validated result writes, and the two admin routes' logic.

const CHECK = "5b0e8a52-6f3e-4b8f-9f1c-0f5c1f4f2a11";
const MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const installation: E2EAgentInstallation = { provider: "amazon-bedrock", region: "us-east-1" };
const definitions = (() => {
  const standard = deriveE2EAgentRouteForModel(installation, MODEL, "standard", 1);
  const minimal = deriveE2EAgentRouteForModel(installation, MODEL, "minimal", 1);
  if (standard.status !== "available" || minimal.status !== "available") throw new Error("expected routes");
  return { standard: standard.definition, minimal: minimal.definition };
})();
const REV = { standard: e2eModelRouteRevision(definitions.standard), minimal: e2eModelRouteRevision(definitions.minimal) };
const expected: ExpectedModelCheck = { checkId: CHECK, kind: "drive", provider: "amazon-bedrock", definitions };

let counter = 0;
function receipt(over: Partial<E2EModelReceipt> & { shape?: "standard" | "minimal" } = {}): E2EModelReceipt {
  const { shape = "standard", ...rest } = over;
  counter += 1;
  return {
    receiptId: `rcpt-${counter}`, runId: CHECK, caseId: DRIVING_TEST_FIRST_CALL_CASE_ID, stepIndex: 0, callIndex: 0, routeId: definitions.standard.routeId, routeRevision: REV[shape],
    provider: "amazon-bedrock", modelId: MODEL, startedAt: new Date(Date.parse("2026-10-23T10:00:00Z") + counter * 1000).toISOString(), inputTokens: 1000, outputTokens: 40, latencyMs: 300,
    servedModelId: null, servedUpstream: null, promptSha256: "a".repeat(64), responseSha256: "b".repeat(64), outcome: "ok", ...rest,
  };
}
const nav = (callIndex: number, over: Partial<E2EModelReceipt> & { shape?: "standard" | "minimal" } = {}) => receipt({ caseId: "case-drive", stepIndex: 1, callIndex, ...over });

function drive(over: Record<string, unknown> = {}, receipts: E2EModelReceipt[] = [receipt(), nav(0), nav(1)]) {
  const shape = (over["payloadShape"] as "standard" | "minimal" | undefined) ?? "standard";
  const definition = definitions[shape];
  return {
    schemaVersion: E2E_MODEL_CHECK_RESULT_SCHEMA, status: "driven", checkId: CHECK,
    drive: { routeId: definition.routeId, routeRevision: e2eModelRouteRevision(definition), definitionDigest: e2eAgentRouteDefinitionDigest(definition), provider: "amazon-bedrock", modelId: MODEL,
      payloadShape: "standard", outcome: "passed", failure: null, calls: receipts.length, inputTokens: receipts.reduce((total, item) => total + item.inputTokens, 0),
      outputTokens: receipts.reduce((total, item) => total + item.outputTokens, 0), caseVerdict: "passed", caseCode: null, receipts, reported: { modelCalls: 2, downloads: 1, csvPassed: true }, ...over },
  };
}

describe("validateModelCheckResult (test 34)", () => {
  it("accepts a passing driving test whose receipts, budget, verdict and report all agree", () => {
    expect(validateModelCheckResult(drive(), expected)).toMatchObject({ ok: true, kind: "drive", definitionDigest: e2eAgentRouteDefinitionDigest(definitions.standard) });
  });

  it("accepts the one minimal-shape retry after a rejected request", () => {
    const first = receipt({ outcome: "provider-error", responseSha256: null, inputTokens: 0, outputTokens: 0, failure: { class: "request-rejected", signal: "ValidationException" } });
    const retry = receipt({ shape: "minimal", callIndex: 1 });
    const result = drive({ payloadShape: "minimal" }, [first, retry, nav(0, { shape: "minimal" }), nav(1, { shape: "minimal" })]);
    expect(validateModelCheckResult(result, expected)).toMatchObject({ ok: true, definitionDigest: e2eAgentRouteDefinitionDigest(definitions.minimal) });
  });

  // The ten refusals of the 4.9 canary (not a result, the runner refused, it did not run, another canary, another route, the wrong number of calls, a malformed receipt, not this
  // check's call, another model, an outcome that is not ok) and the over-bound one, then the three of 4.10C.
  const refused: Array<[string, unknown]> = [
    ["not a model check result", { schemaVersion: "rovara-e2e-model-canary-result/v1", status: "called" }],
    ["not an object", "x"],
    ["the runner refused", { schemaVersion: E2E_MODEL_CHECK_RESULT_SCHEMA, status: "refused", code: "served-limit", checkId: CHECK }],
    ["the check did not run", { schemaVersion: E2E_MODEL_CHECK_RESULT_SCHEMA, status: "failed", reason: "check-run-failed", checkId: CHECK }],
    ["another check", { ...drive(), checkId: "6b0e8a52-6f3e-4b8f-9f1c-0f5c1f4f2a11" }],
    ["another route digest", drive({ definitionDigest: "c".repeat(64) })],
    ["another route revision", drive({ routeRevision: "r1-000000000000" })],
    ["a call count that is not the receipts", drive({ calls: 2 })],
    ["a malformed receipt", drive({}, [{ ...receipt(), outcome: "maybe" } as never, nav(0), nav(1)])],
    ["a receipt of another check's run", drive({}, [receipt({ runId: "6b0e8a52-6f3e-4b8f-9f1c-0f5c1f4f2a11" }), nav(0), nav(1)])],
    ["a receipt for another model", drive({}, [receipt({ modelId: "us.anthropic.claude-haiku-5-5" }), nav(0), nav(1)])],
    ["a receipt for another route revision", drive({}, [receipt({ routeRevision: "r1-000000000000" }), nav(0), nav(1)])],
    ["a first call that did not succeed", drive({}, [receipt({ outcome: "provider-error", responseSha256: null, inputTokens: 0, outputTokens: 0, failure: { class: "unknown", signal: null } }), nav(0), nav(1)])],
    // Task 4.10C: the budget, the oracle's verdict and the report.
    ["input tokens over the budget (7 calls)", drive({}, [receipt(), nav(0), nav(1), nav(2), nav(3), nav(4), nav(5)])],
    ["input tokens over the budget (one call is over 36,000 in total)", drive({ inputTokens: 36_001 })],
    ["output tokens over 512 on a call", drive({}, [receipt(), nav(0, { outputTokens: 513 }), nav(1)])],
    ["a verdict that is not PASS", drive({ caseVerdict: "unknown", caseCode: "agent-no-download" })],
    ["receipts that are not equal to the report", drive({ reported: { modelCalls: 3, downloads: 1, csvPassed: true } })],
    ["two downloads", drive({ reported: { modelCalls: 2, downloads: 2, csvPassed: true } })],
    ["a CSV check that did not pass", drive({ reported: { modelCalls: 2, downloads: 1, csvPassed: false } })],
    ["a pass with a failure", drive({ failure: { class: "unknown", signal: null } })],
    ["a repeated receipt id", drive({}, [receipt(), { ...nav(0), receiptId: "dup" }, { ...nav(1), receiptId: "dup" }])],
    ["a gap in the call indexes", drive({}, [receipt(), nav(0), nav(2)])],
    ["a budget refusal inside a pass", drive({}, [receipt(), nav(0), nav(1, { outcome: "budget", responseSha256: null, inputTokens: 0, outputTokens: 0 })])],
    ["two retries", drive({ payloadShape: "minimal" }, [receipt({ outcome: "provider-error", responseSha256: null, inputTokens: 0, outputTokens: 0, failure: { class: "request-rejected", signal: null } }),
      receipt({ shape: "minimal", callIndex: 1, outcome: "provider-error", responseSha256: null, inputTokens: 0, outputTokens: 0, failure: { class: "request-rejected", signal: null } }),
      receipt({ shape: "minimal", callIndex: 2 }), nav(0, { shape: "minimal" })])],
    ["a retry after a failure that was not a rejected request", drive({ payloadShape: "minimal" }, [receipt({ outcome: "provider-error", responseSha256: null, inputTokens: 0, outputTokens: 0, failure: { class: "limit-or-rate-limited", signal: null } }),
      receipt({ shape: "minimal", callIndex: 1 }), nav(0, { shape: "minimal" }), nav(1, { shape: "minimal" })])],
    ["a minimal shape with no retry", drive({ payloadShape: "minimal" }, [receipt({ shape: "minimal" }), nav(0, { shape: "minimal" }), nav(1, { shape: "minimal" })])],
    ["a navigation in another shape than the one tested", drive({}, [receipt(), nav(0, { shape: "minimal" }), nav(1)])],
  ];
  it.each(refused)("refuses %s", (_name, result) => {
    expect(validateModelCheckResult(result, expected)).toMatchObject({ ok: false });
  });

  it("accepts a failed test and holds its failure to a receipt that says it", () => {
    const failed = receipt({ outcome: "provider-error", responseSha256: null, inputTokens: 0, outputTokens: 0, failure: { class: "limit-or-rate-limited", signal: "ThrottlingException" } });
    const result = drive({ outcome: "failed", failure: { class: "limit-or-rate-limited", signal: "ThrottlingException" }, caseVerdict: "none", reported: null }, [failed]);
    expect(validateModelCheckResult(result, expected)).toMatchObject({ ok: true });
    expect(validateModelCheckResult(drive({ outcome: "failed", failure: { class: "key-rejected", signal: null }, caseVerdict: "none", reported: null }, [failed]), expected)).toMatchObject({ ok: false });
  });

  it("holds a discovery to its own check and provider", () => {
    const report = { schemaVersion: "rovara-model-discovery/v1", provider: "amazon-bedrock", checkedAt: "2026-10-23T10:00:00.000Z", status: "listed", models: [] };
    const result = { schemaVersion: E2E_MODEL_CHECK_RESULT_SCHEMA, status: "discovered", checkId: CHECK, discovery: report };
    expect(validateModelCheckResult(result, { checkId: CHECK, kind: "discover", provider: "amazon-bedrock" })).toMatchObject({ ok: true, kind: "discover" });
    expect(validateModelCheckResult(result, { checkId: CHECK, kind: "discover", provider: "openai" })).toMatchObject({ ok: false });
    expect(validateModelCheckResult(result, expected)).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

const ROLE_ID = "AROAABCDEFGHIJKLMNOP1";
const INSTANCE = "i-0123456789abcdef0";
const PREFIX = `e2e-runtime/${ROLE_ID}:${INSTANCE}/`;
const CORRELATION = "22222222-2222-4222-8222-222222222222";

function harness(options: { installation?: E2EAgentInstallation; runner?: boolean; runtimeReady?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const objects = new Map<string, string>();
  const puts: string[] = [];
  const gets: string[] = [];
  let now = Date.parse("2026-10-23T10:00:00Z");
  let ids = 0;
  if (options.runner !== false) db.set({ ...e2eModelCheckRunnerKey("linux-arm64-web-api-v1"), entityType: "E2E_MODEL_CHECK_RUNNER", roleId: ROLE_ID, instanceId: INSTANCE, transportCorrelationId: CORRELATION });
  const deps: ModelCheckDependencies = {
    documentClient: { send: db.send } as unknown as DynamoDBDocumentClient, tableName: "state", now: () => now,
    putObject: async (key, body) => { puts.push(key); objects.set(key, body); },
    getObject: async (key) => { gets.push(key); const body = objects.get(key); return body === undefined ? undefined : Buffer.from(body); },
    installation: async () => options.installation ?? installation,
    readRuntimeRow: async () => (options.runtimeReady === false ? undefined : { state: "READY", expiresAt: new Date(now + 3_600_000).toISOString(), transportCorrelationId: CORRELATION }),
    newCheckId: () => `00000000-0000-4000-8000-${String((ids += 1)).padStart(12, "0")}`,
  };
  return { db, deps, objects, puts, gets, advance: (ms: number) => { now += ms; } };
}
const route = { routeId: definitions.standard.routeId };

describe("POST: starting a check", () => {
  it("puts the request under the runner's own prefix and records the check", async () => {
    const h = harness();
    const { checkId } = await startModelCheck(h.deps, { kind: "drive", modelId: MODEL }, "linux-arm64-web-api-v1");
    expect(h.puts).toEqual([`${PREFIX}canary-request.json`]);
    expect(JSON.parse(h.objects.get(`${PREFIX}canary-request.json`)!)).toEqual({ schemaVersion: "rovara-e2e-model-check-request/v2", checkId, kind: "drive", routeId: route.routeId,
      definitionDigest: e2eAgentRouteDefinitionDigest(definitions.standard) });
    expect(h.db.get("E2E_MODEL_ROUTES", `E2E_MODEL_CHECK#${checkId}`)).toMatchObject({ state: "pending", kind: "drive", modelId: MODEL, prefix: PREFIX });
    expect(h.db.get("E2E_MODEL_ROUTES", `E2E_MODEL_CHECK#${checkId}`)!["indexExpiresAt"]).toEqual(expect.any(Number));
  });

  it("refuses a model that is not eligible with a 400, a fixed message without the value, and no put", async () => {
    const h = harness();
    const bad = "anthropic.claude-haiku-4-5-20251001-v1:0";
    const error = await startModelCheck(h.deps, { kind: "drive", modelId: bad }, "linux-arm64-web-api-v1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelCheckError);
    expect(error).toMatchObject({ status: 400, code: "model-not-eligible" });
    expect((error as Error).message).not.toContain(bad);
    expect(h.puts).toEqual([]);
    // Only the runner's own row (set up by the harness) is in the table: no check row was written.
    expect(h.db.items.size).toBe(1);
  });

  it("refuses a body that is not a drive or a discover, and a modelId that is not an id", async () => {
    const h = harness();
    for (const body of [{}, { kind: "other" }, { kind: "drive", extra: 1 }, { kind: "drive", modelId: "a b;c" }, null]) {
      await expect(startModelCheck(h.deps, body, "linux-arm64-web-api-v1")).rejects.toMatchObject({ status: 400 });
    }
    expect(h.puts).toEqual([]);
  });

  it("needs a READY runtime and a runner recorded for that registration", async () => {
    await expect(startModelCheck(harness({ runtimeReady: false }).deps, { kind: "discover" }, "linux-arm64-web-api-v1")).rejects.toMatchObject({ status: 409, code: "no-ready-runtime" });
    await expect(startModelCheck(harness({ runner: false }).deps, { kind: "discover" }, "linux-arm64-web-api-v1")).rejects.toMatchObject({ status: 409, code: "no-model-check-runner" });
    // A runner recorded for another registration is not this one's.
    const other = harness();
    other.db.set({ ...e2eModelCheckRunnerKey("linux-arm64-web-api-v1"), roleId: ROLE_ID, instanceId: INSTANCE, transportCorrelationId: "33333333-3333-4333-8333-333333333333" });
    await expect(startModelCheck(other.deps, { kind: "discover" }, "linux-arm64-web-api-v1")).rejects.toMatchObject({ code: "no-model-check-runner" });
  });

  // Review M-4: the one-check-at-a-time rule is one conditional write, and a retried POST finds its own check again.
  it("allows one check at a time: a different request while one runs is a 409 that names the running check, and after the window it is allowed", async () => {
    const h = harness();
    const { checkId } = await startModelCheck(h.deps, { kind: "discover" }, "linux-arm64-web-api-v1");
    await expect(startModelCheck(h.deps, { kind: "drive", modelId: MODEL }, "linux-arm64-web-api-v1")).rejects.toMatchObject({ status: 409, code: "check-in-progress", message: expect.stringContaining(checkId) as string });
    h.advance(11 * 60_000);
    await expect(startModelCheck(h.deps, { kind: "drive", modelId: MODEL }, "linux-arm64-web-api-v1")).resolves.toMatchObject({ checkId: expect.any(String) as string });
  });

  it("two POSTs at once cannot overwrite each other: one wins, the other is refused, and the request under the key is the winner's", async () => {
    const h = harness();
    const settled = await Promise.allSettled([startModelCheck(h.deps, { kind: "drive", modelId: MODEL }, "linux-arm64-web-api-v1"), startModelCheck(h.deps, { kind: "discover" }, "linux-arm64-web-api-v1")]);
    expect(settled.map((item) => item.status).sort()).toEqual(["fulfilled", "rejected"]);
    const winner = settled.find((item) => item.status === "fulfilled") as PromiseFulfilledResult<{ checkId: string }>;
    const loser = settled.find((item) => item.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ status: 409, code: "check-in-progress" });
    expect((JSON.parse(h.objects.get(`${PREFIX}canary-request.json`)!) as { checkId: string }).checkId).toBe(winner.value.checkId);
    expect(h.puts).toHaveLength(1);
  });

  it("the same request again (a lost 202, a double click) returns the running check's id instead of blocking, and puts its request again", async () => {
    const h = harness();
    const first = await startModelCheck(h.deps, { kind: "drive", modelId: MODEL }, "linux-arm64-web-api-v1");
    // The 202 was lost, and so was the object (the put is what may have failed).
    h.objects.delete(`${PREFIX}canary-request.json`);
    const again = await startModelCheck(h.deps, { kind: "drive", modelId: MODEL }, "linux-arm64-web-api-v1");
    expect(again).toEqual(first);
    expect((JSON.parse(h.objects.get(`${PREFIX}canary-request.json`)!) as { checkId: string }).checkId).toBe(first.checkId);
    // Only one check exists.
    expect(h.db.find((item) => String(item.sk).startsWith("E2E_MODEL_CHECK#"))).toHaveLength(1);
  });

  it("a POST whose own request put failed can be retried at once", async () => {
    const h = harness();
    const original = h.deps.putObject;
    let fail = true;
    h.deps.putObject = async (key, body) => { if (fail) { fail = false; throw new Error("S3 down"); } await original(key, body); };
    await expect(startModelCheck(h.deps, { kind: "discover" }, "linux-arm64-web-api-v1")).rejects.toThrow("S3 down");
    const retried = await startModelCheck(h.deps, { kind: "discover" }, "linux-arm64-web-api-v1");
    expect((JSON.parse(h.objects.get(`${PREFIX}canary-request.json`)!) as { checkId: string }).checkId).toBe(retried.checkId);
  });

  it("a finished check frees the runner for the next one at once", async () => {
    const h = harness();
    const { checkId } = await startModelCheck(h.deps, { kind: "discover" }, "linux-arm64-web-api-v1");
    h.objects.set(`${PREFIX}canary-result.json`, JSON.stringify({ schemaVersion: E2E_MODEL_CHECK_RESULT_SCHEMA, status: "discovered", checkId, discovery: { schemaVersion: "rovara-model-discovery/v1", provider: "amazon-bedrock", checkedAt: "2026-10-23T10:00:00.000Z", status: "unverified", unverifiedReason: "access-denied", models: [] } }));
    await readModelCheck(h.deps, checkId);
    await expect(startModelCheck(h.deps, { kind: "discover" }, "linux-arm64-web-api-v1")).resolves.toMatchObject({ checkId: expect.not.stringMatching(checkId) as string });
  });

  it("uses the stored shape for the route it asks about", async () => {
    const h = harness();
    h.db.set({ ...e2eModelRouteShapeKey(route.routeId, MODEL), entityType: "E2E_MODEL_ROUTE_SHAPE", payloadShape: "minimal", testedAt: "2026-10-22T10:00:00.000Z" });
    await startModelCheck(h.deps, { kind: "drive", modelId: MODEL }, "linux-arm64-web-api-v1");
    expect((JSON.parse([...h.objects.values()][0]!) as { definitionDigest: string }).definitionDigest).toBe(e2eAgentRouteDefinitionDigest(definitions.minimal));
  });
});

describe("GET: reading a check", () => {
  async function started(h: ReturnType<typeof harness>, kind: "drive" | "discover" = "drive") {
    const { checkId } = await startModelCheck(h.deps, kind === "drive" ? { kind, modelId: MODEL } : { kind }, "linux-arm64-web-api-v1");
    return checkId;
  }
  const answer = (h: ReturnType<typeof harness>, result: unknown) => h.objects.set(`${PREFIX}canary-result.json`, JSON.stringify(result));
  const asCheck = (checkId: string, result: ReturnType<typeof drive>) => ({ ...result, checkId, drive: { ...result.drive, receipts: result.drive.receipts.map((item) => ({ ...item, runId: checkId })) } });
  const rows = (h: ReturnType<typeof harness>) => h.db.find((item) => String(item.sk).startsWith("E2E_MODEL_ROUTE_CANARY#") || String(item.sk).startsWith("E2E_MODEL_ROUTE_SHAPE#") || String(item.sk).startsWith("E2E_MODEL_TEST#")).map((item) => String(item.sk).split("#")[0]).sort();

  it("is pending until the result names the check (an earlier result under the key is not an answer)", async () => {
    const h = harness();
    const checkId = await started(h);
    expect(await readModelCheck(h.deps, checkId)).toMatchObject({ status: "pending" });
    answer(h, { ...drive(), checkId: "6b0e8a52-6f3e-4b8f-9f1c-0f5c1f4f2a11" });
    expect(await readModelCheck(h.deps, checkId)).toMatchObject({ status: "pending" });
    expect(rows(h)).toEqual([]);
  });

  it("a validated pass writes the gating row (driving/v1), the shape row and the test row, once", async () => {
    const h = harness();
    const checkId = await started(h);
    answer(h, asCheck(checkId, drive()));
    const view = await readModelCheck(h.deps, checkId);
    expect(view).toMatchObject({ status: "passed", drive: { modelId: MODEL, payloadShape: "standard", calls: 3 } });
    expect(rows(h)).toEqual(["E2E_MODEL_ROUTE_CANARY", "E2E_MODEL_ROUTE_SHAPE", "E2E_MODEL_TEST"]);
    const digest = e2eAgentRouteDefinitionDigest(definitions.standard);
    expect(h.db.get("E2E_MODEL_ROUTES", e2eModelRouteCanaryKey(route.routeId, digest).sk)).toMatchObject({ test: "driving/v1", routeId: route.routeId, definitionDigest: digest, modelId: MODEL, checkId });
    expect(h.db.get("E2E_MODEL_ROUTES", e2eModelRouteTestKey(route.routeId, MODEL).sk)).toMatchObject({ outcome: "passed", failureClass: null, calls: 3 });
    // No prompt, answer or message text is stored: only digests, counts and fixed codes.
    expect(JSON.stringify(h.db.items.get(`E2E_MODEL_ROUTES\0${e2eModelRouteCanaryKey(route.routeId, digest).sk}`) ?? {})).not.toMatch(/prompt|message/i);
    // A second read answers from the stored view and writes nothing more.
    const writes = h.db.commandNames().filter((name) => name !== "GetCommand" && name !== "QueryCommand").length;
    expect(await readModelCheck(h.deps, checkId)).toEqual(view);
    expect(h.db.commandNames().filter((name) => name !== "GetCommand" && name !== "QueryCommand").length).toBe(writes);
  });

  it("a failed test writes only the test row, with its class, and says it in the approved sentence", async () => {
    const h = harness();
    const checkId = await started(h);
    const failed = receipt({ outcome: "provider-error", responseSha256: null, inputTokens: 0, outputTokens: 0, failure: { class: "limit-or-rate-limited", signal: "ThrottlingException" } });
    answer(h, asCheck(checkId, drive({ outcome: "failed", failure: { class: "limit-or-rate-limited", signal: "ThrottlingException" }, caseVerdict: "none", reported: null }, [failed])));
    const view = await readModelCheck(h.deps, checkId);
    expect(view.status).toBe("failed");
    expect(view.sentence).toContain("Raise the limit, or choose another model and run its driving test (agentx project model-check test --model <id>), then retry the checks");
    expect(rows(h)).toEqual(["E2E_MODEL_TEST"]);
    expect(h.db.get("E2E_MODEL_ROUTES", e2eModelRouteTestKey(route.routeId, MODEL).sk)).toMatchObject({ outcome: "failed", failureClass: "limit-or-rate-limited", signal: "ThrottlingException" });
  });

  it("a result that does not add up writes nothing and says the check could not be trusted", async () => {
    const h = harness();
    const checkId = await started(h);
    answer(h, asCheck(checkId, drive({ reported: { modelCalls: 3, downloads: 1, csvPassed: true } })));
    expect(await readModelCheck(h.deps, checkId)).toMatchObject({ status: "refused" });
    expect(rows(h)).toEqual([]);
  });

  it("a discovery is recorded and read back as the tiers", async () => {
    const h = harness();
    const checkId = await started(h, "discover");
    answer(h, { schemaVersion: E2E_MODEL_CHECK_RESULT_SCHEMA, status: "discovered", checkId, discovery: { schemaVersion: "rovara-model-discovery/v1", provider: "amazon-bedrock", checkedAt: "2026-10-23T09:59:00.000Z", status: "listed",
      models: [
        { modelId: "us.anthropic.claude-haiku-5-5", visible: true, state: "limit-zero", quotas: [{ scope: "geographic", code: "L-47520EB7", tokensPerMinute: 0 }, { scope: "global", code: "L-F26CA8D1", tokensPerMinute: 0 }], signals: [] },
        { modelId: MODEL, visible: true, state: "available", quotas: [], signals: [] }] } });
    const view = await readModelCheck(h.deps, checkId);
    expect(view.status).toBe("discovered");
    expect(view.tiers?.recommended?.modelId).toBe(MODEL);
    expect(view.tiers?.notUsable[0]).toMatchObject({ modelId: "us.anthropic.claude-haiku-5-5", reason: expect.stringContaining("L-47520EB7") as string });
    expect(view.tiers?.notUsable[0]?.reason).toContain("US-only `L-47520EB7` 0, Global `L-F26CA8D1` 0 tokens per minute");
    // The report on record feeds the tiers a later read shows.
    const tiers = await readCurrentTiers(h.deps);
    expect(tiers.recommended?.modelId).toBe(MODEL);
    expect(tiers.discovery).toMatchObject({ status: "listed" });
  });

  it("a discovery whose quotas could not be read recommends nothing, lists the models as testable, and says so (I-3)", async () => {
    const h = harness();
    const checkId = await started(h, "discover");
    const unread = [{ scope: "geographic", code: "L-47520EB7", tokensPerMinute: null }, { scope: "global", code: "L-F26CA8D1", tokensPerMinute: null }];
    answer(h, { schemaVersion: E2E_MODEL_CHECK_RESULT_SCHEMA, status: "discovered", checkId, discovery: { schemaVersion: "rovara-model-discovery/v1", provider: "amazon-bedrock", checkedAt: "2026-10-23T09:59:00.000Z", status: "listed",
      models: [
        { modelId: "us.anthropic.claude-haiku-5-5", visible: true, state: "available", quotas: unread, signals: ["quota-lookup-access-denied"] },
        { modelId: MODEL, visible: true, state: "available", quotas: unread, signals: ["quota-lookup-access-denied"] }] } });
    const view = await readModelCheck(h.deps, checkId);
    expect(view.tiers?.recommended).toBeNull();
    expect(view.tiers?.why).toBe("quota-unreadable");
    expect(view.tiers?.canBeTested.map((row) => [row.modelId, row.quotaUnreadable])).toEqual(expect.arrayContaining([["us.anthropic.claude-haiku-5-5", true], [MODEL, true]]));
    expect(view.tiers?.notUsable).toEqual([]);
  });

  it("an unreadable discovery says the driving test will confirm, and recommends the overlay default", async () => {
    const h = harness();
    const checkId = await started(h, "discover");
    answer(h, { schemaVersion: E2E_MODEL_CHECK_RESULT_SCHEMA, status: "discovered", checkId, discovery: { schemaVersion: "rovara-model-discovery/v1", provider: "amazon-bedrock", checkedAt: "2026-10-23T09:59:00.000Z", status: "unverified", unverifiedReason: "access-denied", models: [] } });
    const view = await readModelCheck(h.deps, checkId);
    expect(view.sentence).toBe("Rovara could not list your models (access-denied); the driving test will confirm a model.");
    expect(view.tiers).toMatchObject({ why: "discovery-unverified", recommended: { modelId: "us.anthropic.claude-haiku-5-5" } });
  });

  it("does not know a check it never made", async () => {
    await expect(readModelCheck(harness().deps, "6b0e8a52-6f3e-4b8f-9f1c-0f5c1f4f2a11")).rejects.toMatchObject({ status: 404 });
    await expect(readModelCheck(harness().deps, "not-an-id")).rejects.toMatchObject({ status: 404 });
  });
});

describe("the sentence a proposal shows for an untested route (review M-9)", () => {
  it("embeds the last failed test's class sentence without the placeholder command, so the real command is the only one in the text", async () => {
    const h = harness();
    h.db.set({ ...e2eModelRouteTestKey(route.routeId, MODEL), entityType: "E2E_MODEL_TEST", outcome: "failed", failureClass: "limit-or-rate-limited", signal: "ThrottlingException", testedAt: "2026-10-23T10:00:00.000Z" });
    const sentence = await untestedRouteSentence(h.deps, { provider: "amazon-bedrock", modelId: MODEL, routeId: route.routeId });
    expect(sentence).toContain("AI navigation steps will not run: the driving test with Amazon Bedrock");
    expect(sentence).toContain("choose another model and run its driving test, then retry the checks)");
    expect(sentence).not.toContain("<id>");
    expect(sentence).not.toContain("model-check test");
  });
});

describe("what was approved is exactly what was tested (test 35)", () => {
  it("after a minimal-shape pass, the planned route's digest is the gating row's", async () => {
    const h = harness();
    const { checkId } = await startModelCheck(h.deps, { kind: "drive", modelId: MODEL }, "linux-arm64-web-api-v1");
    const first = receipt({ runId: checkId, outcome: "provider-error", responseSha256: null, inputTokens: 0, outputTokens: 0, failure: { class: "request-rejected", signal: "ValidationException" } });
    const retry = receipt({ runId: checkId, shape: "minimal", callIndex: 1 });
    const result = drive({ payloadShape: "minimal" }, [first, retry, nav(0, { shape: "minimal", runId: checkId }), nav(1, { shape: "minimal", runId: checkId })]);
    h.objects.set(`${PREFIX}canary-result.json`, JSON.stringify({ ...result, checkId }));
    expect(await readModelCheck(h.deps, checkId)).toMatchObject({ status: "passed", drive: { payloadShape: "minimal" } });
    const store = { documentClient: h.deps.documentClient, tableName: "state" };
    // Setup approval reads the installation's setting and the shape row; the model chosen here is the tested one.
    const chosen = await e2eAgentInstallationFromParameters("/agentx/e/", async () => new Map([["/agentx/e/worker-model-provider", "amazon-bedrock"], ["/agentx/e/worker-e2e-agent-model", MODEL]]), "us-east-1",
      { readShape: (modelId) => readE2EModelRouteShape(store, route.routeId, modelId) });
    expect(chosen.payloadShape).toBe("minimal");
    const planned = await planE2EAgentRoute(store, chosen);
    if (planned.status !== "available") throw new Error(`unavailable: ${planned.detail}`);
    expect(planned.definitionDigest).toBe(e2eAgentRouteDefinitionDigest(definitions.minimal));
    expect(h.db.get("E2E_MODEL_ROUTES", e2eModelRouteCanaryKey(route.routeId, planned.definitionDigest).sk)).toMatchObject({ test: "driving/v1", payloadShape: "minimal" });
    // The standard definition of the same model was never tested.
    expect(await planE2EAgentRoute(store, { ...chosen, payloadShape: undefined })).toMatchObject({ status: "unavailable" });
  });
});
