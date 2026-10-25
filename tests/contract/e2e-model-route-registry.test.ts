import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { E2EPolicySchema, E2E_DEFAULT_MODEL_ROUTE_ID, E2E_MODEL_ROUTE_DEFAULT_BUDGETS, e2eModelRouteRevision } from "@agentx/contracts";
import { DEFAULT_E2E_AGENT_MODELS } from "../../packages/model-runtime/src/config.js";
import { E2E_BUDGET_EXHAUSTED_PREFIX, createGovernedE2EModelRoute } from "../../packages/model-runtime/src/e2e-route.js";
import {
  E2E_MODEL_ROUTE_PARTITION, agentRouteSummary, approveE2EAgentRoute, checkE2EAgentRouteCurrent, createBrokerE2EDayBudget, deriveE2EAgentRoute, e2eAgentRouteDefinitionDigest,
  e2eDayBudgetRoom, e2eModelBudgetKey, isTransientAwsFault, e2eModelRouteLatestKey, e2eModelRouteRevisionKey, planE2EAgentRoute, readAdmittedE2EModelRoute, readE2EModelRouteLatest, type E2EAgentInstallation,
} from "../../packages/broker/src/e2e/model-route-registry.js";
import { E2E_MODEL_ROUTE } from "../../scripts/test-deploy-check.js";
import { FakeDynamoDb, assumeDrivingTestsPassed } from "../support/fake-dynamodb.js";
import { SECRET_ARN, channelRequest, drivingTestRow, tapAnswer } from "../support/e2e-model-fixtures.js";

// The gate itself is tested in e2e-driving-test-gate.test.ts; here every digest counts as driven (Task 4.10C).
assumeDrivingTestsPassed();

const TABLE = "state";
const OTHER_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/other-key-ZyXwVu";
const DAY = Date.parse("2026-10-21T10:00:00.000Z");

const bedrock: E2EAgentInstallation = { provider: "amazon-bedrock", region: "us-east-1" };
const anthropic: E2EAgentInstallation = { provider: "anthropic", secretArn: SECRET_ARN };
const store = (db: FakeDynamoDb) => ({ documentClient: { send: db.send } as unknown as DynamoDBDocumentClient, tableName: TABLE });
const available = (installation: E2EAgentInstallation, revision = 1) => {
  const derived = deriveE2EAgentRoute(installation, revision);
  if (derived.status !== "available") throw new Error(`expected an available route: ${derived.detail}`);
  return derived.definition;
};

describe("the route is derived from the installation's worker provider", () => {
  it("uses the route id rovara-e2e-default, the one head's deploy check pins", () => {
    expect(E2E_DEFAULT_MODEL_ROUTE_ID).toBe("rovara-e2e-default");
    expect(E2E_MODEL_ROUTE.routeId).toBe(E2E_DEFAULT_MODEL_ROUTE_ID);
    expect(available(bedrock).routeId).toBe(E2E_MODEL_ROUTE.routeId);
    // On Bedrock the pinned model is the very one head's check evaluates.
    expect(available(bedrock).modelId).toBe(E2E_MODEL_ROUTE.modelId);
  });

  it("pins the provider's small model from DEFAULT_E2E_AGENT_MODELS and nothing else", () => {
    expect(available(bedrock)).toMatchObject({ provider: "amazon-bedrock", modelId: DEFAULT_E2E_AGENT_MODELS["amazon-bedrock"], region: "us-east-1", secretArn: null, openRouter: null, effort: "low", scope: "standard" });
    expect(available(anthropic)).toMatchObject({ provider: "anthropic", modelId: DEFAULT_E2E_AGENT_MODELS.anthropic, region: null, secretArn: SECRET_ARN, openRouter: null, effort: "low" });
    expect(available({ provider: "openai", secretArn: SECRET_ARN })).toMatchObject({ provider: "openai", modelId: DEFAULT_E2E_AGENT_MODELS.openai, effort: null });
    expect(available({ provider: "openrouter", secretArn: SECRET_ARN })).toMatchObject({ provider: "openrouter", modelId: DEFAULT_E2E_AGENT_MODELS.openrouter, effort: "low",
      openRouter: { allowFallbacks: false, requireParameters: true, dataCollection: "deny", only: [] } });
    expect(available(bedrock).budgets).toEqual(E2E_MODEL_ROUTE_DEFAULT_BUDGETS);
  });

  it("carries the OpenRouter provider allowlist from worker-openrouter-providers", () => {
    const definition = available({ provider: "openrouter", secretArn: SECRET_ARN, openRouterProviders: "anthropic,amazon-bedrock" });
    expect(definition.openRouter?.only).toEqual(["anthropic", "amazon-bedrock"]);
  });

  it("holds the ARN only: the definition never has a place for a key value", () => {
    const text = JSON.stringify(available(anthropic));
    expect(text).toContain(SECRET_ARN);
    expect(Object.keys(available(anthropic)).sort()).toEqual(["budgets", "effort", "inferenceProfileArn", "modelId", "openRouter", "promptProtocol", "provider", "region", "revision", "routeId", "sampling", "scope", "secretArn", "thinking", "vision"]);
  });

  it.each<[string, E2EAgentInstallation]>([
    ["no provider setting", { region: "us-east-1" }],
    ["a provider that is not an installation provider", { provider: "rovara-scripted", region: "us-east-1" }],
    ["a provider that is made up", { provider: "gemini", secretArn: SECRET_ARN }],
    ["a keyed provider with no configured secret", { provider: "anthropic" }],
    ["a keyed provider whose secret is not an ARN", { provider: "openai", secretArn: "sk-not-an-arn" }],
    ["a Bedrock installation with no region", { provider: "amazon-bedrock" }],
    ["OpenRouter providers that are not slugs", { provider: "openrouter", secretArn: SECRET_ARN, openRouterProviders: "Not A Slug" }],
  ])("leaves agent steps unavailable with agent-route-not-approved for %s", (_name, installation) => {
    expect(deriveE2EAgentRoute(installation, 1)).toMatchObject({ status: "unavailable", reason: "agent-route-not-approved" });
  });

  it("reads the proposal sentence the administrator approves", () => {
    expect(agentRouteSummary(available(anthropic))).toBe(`AI navigation: Anthropic \`${DEFAULT_E2E_AGENT_MODELS.anthropic}\` (Rovara's recommendation); at most 8 actions per step; checks decide`);
    expect(agentRouteSummary(available(bedrock))).toMatch(/^AI navigation: Amazon Bedrock `us\.anthropic\.claude-haiku-5-5` \(Rovara's recommendation\)\. Your app's pages are processed by the AI in US data centers\. At most 8 actions per step; checks decide$/);
  });
});

describe("the registry keeps revisions in the broker table and reads them by key", () => {
  it("plans revision 1 on an empty registry, without writing", async () => {
    const db = new FakeDynamoDb();
    const planned = await planE2EAgentRoute(store(db), anthropic);
    expect(planned).toMatchObject({ status: "available", revisionNumber: 1, unchanged: false });
    if (planned.status !== "available") return;
    expect(planned.revision).toBe(e2eModelRouteRevision(available(anthropic, 1)));
    expect(db.items.size).toBe(0);
    // The latest pointer, then the driving test's gating row.
    expect(db.commandNames()).toEqual(["GetCommand", "GetCommand"]);
  });

  it("approval writes the revision row and the latest pointer, and keeps them under one fixed partition", async () => {
    const db = new FakeDynamoDb();
    const planned = await planE2EAgentRoute(store(db), anthropic);
    if (planned.status !== "available") throw new Error("unavailable");
    const approved = await approveE2EAgentRoute(store(db), anthropic, planned.revision, { approvedAt: "2026-10-21T10:00:00.000Z" });
    expect(approved).toEqual({ revision: planned.revision, revisionNumber: 1, written: true });
    const row = db.get(E2E_MODEL_ROUTE_PARTITION, `E2E_MODEL_ROUTE#${E2E_DEFAULT_MODEL_ROUTE_ID}#REV#1`);
    expect(row).toMatchObject({ entityType: "E2E_MODEL_ROUTE", revision: planned.revision, definition: planned.definition });
    expect(db.get(E2E_MODEL_ROUTE_PARTITION, `E2E_MODEL_ROUTE_LATEST#${E2E_DEFAULT_MODEL_ROUTE_ID}`)).toMatchObject({ revisionNumber: 1, revision: planned.revision, definitionDigest: planned.definitionDigest });
    expect(e2eModelRouteLatestKey(E2E_DEFAULT_MODEL_ROUTE_ID)).toEqual({ pk: E2E_MODEL_ROUTE_PARTITION, sk: `E2E_MODEL_ROUTE_LATEST#${E2E_DEFAULT_MODEL_ROUTE_ID}` });
  });

  it("writes nothing when the digest is unchanged, so a second project's approval keeps the same revision", async () => {
    const db = new FakeDynamoDb();
    const first = await planE2EAgentRoute(store(db), anthropic);
    if (first.status !== "available") throw new Error("unavailable");
    await approveE2EAgentRoute(store(db), anthropic, first.revision);
    const before = new Map(db.items);
    const again = await planE2EAgentRoute(store(db), anthropic);
    expect(again).toMatchObject({ status: "available", revision: first.revision, revisionNumber: 1, unchanged: true });
    if (again.status !== "available") return;
    const sent = db.commandNames().length;
    expect(await approveE2EAgentRoute(store(db), anthropic, again.revision)).toEqual({ revision: first.revision, revisionNumber: 1, written: false });
    expect(db.commandNames().slice(sent)).not.toContain("TransactWriteCommand");
    expect(db.items).toEqual(before);
  });

  it.each<[string, E2EAgentInstallation]>([
    ["the provider", bedrock],
    ["the secret ARN", { provider: "anthropic", secretArn: OTHER_ARN }],
  ])("writes revision 2 when %s changes", async (_name, changed) => {
    const db = new FakeDynamoDb();
    const first = await planE2EAgentRoute(store(db), anthropic);
    if (first.status !== "available") throw new Error("unavailable");
    await approveE2EAgentRoute(store(db), anthropic, first.revision);
    const second = await planE2EAgentRoute(store(db), changed);
    expect(second).toMatchObject({ status: "available", revisionNumber: 2, unchanged: false });
    if (second.status !== "available") return;
    expect(second.revision).not.toBe(first.revision);
    expect(await approveE2EAgentRoute(store(db), changed, second.revision)).toMatchObject({ revision: second.revision, revisionNumber: 2, written: true });
    expect((await readE2EModelRouteLatest(store(db), E2E_DEFAULT_MODEL_ROUTE_ID))?.revision).toBe(second.revision);
    expect(db.get(E2E_MODEL_ROUTE_PARTITION, `E2E_MODEL_ROUTE#${E2E_DEFAULT_MODEL_ROUTE_ID}#REV#1`)).toBeDefined();
  });

  it("writes revision 2 when the OpenRouter policy changes", async () => {
    const db = new FakeDynamoDb();
    const open = { provider: "openrouter", secretArn: SECRET_ARN } satisfies E2EAgentInstallation;
    const narrowed = { ...open, openRouterProviders: "anthropic" };
    expect(available(open).openRouter?.only).toEqual([]);
    expect(available(narrowed).openRouter?.only).toEqual(["anthropic"]);
    // The driving test a live OpenRouter installation passes, one gating row per exact definition.
    for (const installation of [open, narrowed]) db.set(drivingTestRow(available(installation), e2eAgentRouteDefinitionDigest(available(installation))));
    const first = await planE2EAgentRoute(store(db), open);
    if (first.status !== "available") throw new Error(`unavailable: ${first.detail}`);
    await approveE2EAgentRoute(store(db), open, first.revision);
    const second = await planE2EAgentRoute(store(db), narrowed);
    expect(second).toMatchObject({ status: "available", revisionNumber: 2, unchanged: false });
    if (second.status !== "available") return;
    expect(second.revision).not.toBe(first.revision);
  });

  it("settles two racing approvals of different routes into two revisions, never one overwriting the other", async () => {
    const db = new FakeDynamoDb();
    const first = await planE2EAgentRoute(store(db), anthropic);
    const second = await planE2EAgentRoute(store(db), bedrock);
    if (first.status !== "available" || second.status !== "available") throw new Error("unavailable");
    // Both planned revision 1; the writes race.
    const outcomes = await Promise.allSettled([approveE2EAgentRoute(store(db), anthropic, first.revision), approveE2EAgentRoute(store(db), bedrock, second.revision)]);
    const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const losers = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(String((losers[0] as PromiseRejectedResult).reason)).toMatch(/model-route-changed-reapprove/);
    // The revision-1 row is the winner's alone.
    const latest = await readE2EModelRouteLatest(store(db), E2E_DEFAULT_MODEL_ROUTE_ID);
    expect(latest?.revisionNumber).toBe(1);
    expect(db.find((item) => item.pk === E2E_MODEL_ROUTE_PARTITION && String(item.sk).includes("#REV#"))).toHaveLength(1);
  });

  it("refuses to approve a route other than the one planned (the installation changed between proposal and approval)", async () => {
    const db = new FakeDynamoDb();
    const planned = await planE2EAgentRoute(store(db), anthropic);
    if (planned.status !== "available") throw new Error("unavailable");
    await expect(approveE2EAgentRoute(store(db), { provider: "anthropic", secretArn: OTHER_ARN }, planned.revision)).rejects.toThrow(/model-route-changed-reapprove/);
    await expect(approveE2EAgentRoute(store(db), { provider: "anthropic" }, planned.revision)).rejects.toThrow(/agent-route-not-approved/);
    expect(db.items.size).toBe(0);
  });

  it("reads approval state with keyed GetItem or Query only, never a Scan", async () => {
    const db = new FakeDynamoDb();
    const planned = await planE2EAgentRoute(store(db), anthropic);
    if (planned.status !== "available") throw new Error("unavailable");
    await approveE2EAgentRoute(store(db), anthropic, planned.revision);
    await readE2EModelRouteLatest(store(db), E2E_DEFAULT_MODEL_ROUTE_ID);
    await checkE2EAgentRouteCurrent(store(db), anthropic, planned.revision);
    expect(db.commandNames().filter((name) => name === "ScanCommand")).toEqual([]);
    expect(db.commandNames()).toContain("GetCommand");
  });
});

describe("dispatch re-derives the route and compares it with what was approved", () => {
  const approvedRevision = async (db: FakeDynamoDb, installation: E2EAgentInstallation) => {
    const planned = await planE2EAgentRoute(store(db), installation);
    if (planned.status !== "available") throw new Error("unavailable");
    await approveE2EAgentRoute(store(db), installation, planned.revision);
    return planned.revision;
  };

  it("accepts the installation the route was approved for", async () => {
    const db = new FakeDynamoDb();
    const revision = await approvedRevision(db, anthropic);
    expect(await checkE2EAgentRouteCurrent(store(db), anthropic, revision)).toEqual({ ok: true, routeId: E2E_DEFAULT_MODEL_ROUTE_ID, routeRevision: revision });
  });

  it.each<[string, E2EAgentInstallation]>([
    ["the provider changed", bedrock],
    ["the model-bearing provider's secret ARN changed", { provider: "anthropic", secretArn: OTHER_ARN }],
  ])("gives model-route-changed-reapprove when %s", async (_name, changed) => {
    const db = new FakeDynamoDb();
    const revision = await approvedRevision(db, anthropic);
    expect(await checkE2EAgentRouteCurrent(store(db), changed, revision)).toMatchObject({ ok: false, code: "model-route-changed-reapprove" });
  });

  it("gives model-route-changed-reapprove when the OpenRouter policy changed", async () => {
    const db = new FakeDynamoDb();
    const open = { provider: "openrouter", secretArn: SECRET_ARN } satisfies E2EAgentInstallation;
    db.set(drivingTestRow(available(open), e2eAgentRouteDefinitionDigest(available(open))));
    const revision = await approvedRevision(db, open);
    expect(await checkE2EAgentRouteCurrent(store(db), { ...open, openRouterProviders: "anthropic" }, revision)).toMatchObject({ ok: false, code: "model-route-changed-reapprove" });
  });

  it("gives model-route-changed-reapprove when the policy pins a revision that is no longer the latest", async () => {
    const db = new FakeDynamoDb();
    const first = await approvedRevision(db, anthropic);
    await approvedRevision(db, bedrock);
    expect(await checkE2EAgentRouteCurrent(store(db), bedrock, first)).toMatchObject({ ok: false, code: "model-route-changed-reapprove" });
  });

  it("gives agent-route-not-approved when the installation no longer has a usable route, or none was ever approved", async () => {
    const db = new FakeDynamoDb();
    const revision = await approvedRevision(db, anthropic);
    expect(await checkE2EAgentRouteCurrent(store(db), { provider: "anthropic" }, revision)).toMatchObject({ ok: false, code: "agent-route-not-approved" });
    expect(await checkE2EAgentRouteCurrent(store(new FakeDynamoDb()), anthropic, revision)).toMatchObject({ ok: false, code: "agent-route-not-approved" });
  });
});

describe("the broker-backed day budget", () => {
  const budget = (db: FakeDynamoDb, now = DAY) => createBrokerE2EDayBudget({ ...store(db), projectName: "payments", now: () => now });
  const LIMITS = { maxInputTokens: 10_000, maxCalls: 3 };
  const row = (db: FakeDynamoDb, day = "2026-10-21") => db.get(`PROJECT#payments`, `E2E_MODEL_BUDGET#${day}`);

  it("keeps one row per project and UTC day with the tokens and calls reserved", async () => {
    const db = new FakeDynamoDb();
    const reservation = await budget(db).reserve(4_000, LIMITS);
    expect(reservation).not.toBeNull();
    expect(row(db)).toMatchObject({ inputTokens: 4_000, calls: 1 });
    expect(e2eModelBudgetKey("payments", "2026-10-21")).toEqual({ pk: "PROJECT#payments", sk: "E2E_MODEL_BUDGET#2026-10-21" });
  });

  it("refuses a reserve that would pass the token cap or the call cap, and records nothing for it", async () => {
    const db = new FakeDynamoDb();
    const b = budget(db);
    expect(await b.reserve(6_000, LIMITS)).not.toBeNull();
    expect(await b.reserve(4_001, LIMITS)).toBeNull();
    expect(row(db)).toMatchObject({ inputTokens: 6_000, calls: 1 });
    expect(await b.reserve(10_001, LIMITS)).toBeNull();
    expect(await b.reserve(1_000, { maxInputTokens: 10_000, maxCalls: 1 })).toBeNull();
    expect(row(db)).toMatchObject({ inputTokens: 6_000, calls: 1 });
  });

  it("is race-safe: concurrent reserves never pass either cap", async () => {
    const db = new FakeDynamoDb();
    const b = budget(db);
    const outcomes = await Promise.all(Array.from({ length: 8 }, async () => b.reserve(3_000, { maxInputTokens: 10_000, maxCalls: 400 })));
    expect(outcomes.filter((outcome) => outcome !== null)).toHaveLength(3);
    expect(row(db)).toMatchObject({ inputTokens: 9_000, calls: 3 });
    const callCapped = await Promise.all(Array.from({ length: 6 }, async () => budget(db).reserve(1, { maxInputTokens: 10_000, maxCalls: 5 })));
    expect(callCapped.filter((outcome) => outcome !== null)).toHaveLength(2);
    expect(row(db)).toMatchObject({ calls: 5 });
  });

  it("uses conditional writes for the reservation", async () => {
    const db = new FakeDynamoDb();
    const sent: Array<Record<string, unknown>> = [];
    const spy = { send: async (command: { input: Record<string, unknown> }) => { sent.push(command.input); return db.send(command); } };
    await createBrokerE2EDayBudget({ documentClient: spy as unknown as DynamoDBDocumentClient, tableName: TABLE, projectName: "payments", now: () => DAY }).reserve(100, LIMITS);
    expect(sent).toHaveLength(1);
    expect(String(sent[0]!.ConditionExpression)).toMatch(/attribute_not_exists/);
    expect(String(sent[0]!.UpdateExpression)).toMatch(/ADD/);
  });

  it("settles to the tokens the provider reported", async () => {
    const db = new FakeDynamoDb();
    const reservation = (await budget(db).reserve(4_000, LIMITS))!;
    await reservation.settle(900);
    expect(row(db)).toMatchObject({ inputTokens: 900, calls: 1 });
  });

  it("settles an overrun in full, because the provider billed it", async () => {
    const db = new FakeDynamoDb();
    const reservation = (await budget(db).reserve(4_000, LIMITS))!;
    await reservation.settle(5_500);
    expect(row(db)).toMatchObject({ inputTokens: 5_500, calls: 1 });
  });

  it("releases both the tokens and the call count with release(), for a call that was never sent", async () => {
    const db = new FakeDynamoDb();
    const b = budget(db);
    const kept = (await b.reserve(1_000, LIMITS))!;
    const reservation = (await b.reserve(4_000, LIMITS))!;
    await reservation.release();
    expect(row(db)).toMatchObject({ inputTokens: 1_000, calls: 1 });
    await kept.settle(700);
    expect(row(db)).toMatchObject({ inputTokens: 700, calls: 1 });
  });

  it("never treats a settle of zero as a release: a sent call keeps its call, and zero is refused", async () => {
    const db = new FakeDynamoDb();
    const reservation = (await budget(db).reserve(4_000, LIMITS))!;
    await expect(reservation.settle(0)).rejects.toThrow();
    expect(row(db)).toMatchObject({ inputTokens: 4_000, calls: 1 });
    await reservation.settle(1);
    expect(row(db)).toMatchObject({ inputTokens: 1, calls: 1 });
  });

  it("settles or releases once: a second call changes nothing", async () => {
    const db = new FakeDynamoDb();
    const reservation = (await budget(db).reserve(4_000, LIMITS))!;
    await reservation.release();
    await reservation.release();
    await reservation.settle(3_000);
    expect(row(db)).toMatchObject({ inputTokens: 0, calls: 0 });
    const sent = (await budget(db).reserve(4_000, LIMITS))!;
    await sent.settle(900);
    await sent.settle(2_000);
    await sent.release();
    expect(row(db)).toMatchObject({ inputTokens: 900, calls: 1 });
  });

  it("gives every budget row a TTL through indexExpiresAt, after its day", async () => {
    const db = new FakeDynamoDb();
    await budget(db).reserve(4_000, LIMITS);
    const expires = Number(row(db)?.indexExpiresAt);
    expect(expires).toBeGreaterThan(Date.parse("2026-10-22T00:00:00.000Z") / 1000);
    expect(expires).toBeLessThan(Date.parse("2027-12-31T00:00:00.000Z") / 1000);
  });

  it("fails closed when a reserve cannot be recorded, and records nothing", async () => {
    const db = new FakeDynamoDb();
    db.injectFault({ command: "UpdateCommand", error: { name: "ProvisionedThroughputExceededException" } });
    await expect(budget(db).reserve(1_000, LIMITS)).rejects.toThrow();
    expect(row(db)).toBeUndefined();
    db.injectFault({ command: "UpdateCommand", error: { name: "InternalServerError" } });
    await expect(budget(db).reserve(1_000, LIMITS)).rejects.toThrow();
  });

  it("fails closed on a request that is not a positive whole token count or has no usable limits", async () => {
    const db = new FakeDynamoDb();
    const b = budget(db);
    await expect(b.reserve(0, LIMITS)).rejects.toThrow();
    await expect(b.reserve(-5, LIMITS)).rejects.toThrow();
    await expect(b.reserve(1.5, LIMITS)).rejects.toThrow();
    await expect(b.reserve(Number.NaN, LIMITS)).rejects.toThrow();
    await expect(b.reserve(100, { maxInputTokens: 0, maxCalls: 3 })).rejects.toThrow();
    expect(db.items.size).toBe(0);
  });

  it("throws, keeping the reservation, when a settle cannot be recorded", async () => {
    const db = new FakeDynamoDb();
    const reservation = (await budget(db).reserve(4_000, LIMITS))!;
    db.injectFault({ command: "UpdateCommand", error: { name: "InternalServerError" } });
    await expect(reservation.settle(900)).rejects.toThrow();
    expect(row(db)).toMatchObject({ inputTokens: 4_000, calls: 1 });
  });

  it("never lets a settle drive a counter below zero", async () => {
    const db = new FakeDynamoDb();
    const reservation = (await budget(db).reserve(4_000, LIMITS))!;
    db.set({ ...row(db)!, inputTokens: 100, calls: 0 });
    await expect(reservation.release()).rejects.toThrow();
    expect(row(db)).toMatchObject({ inputTokens: 100, calls: 0 });
  });

  it("charges the day the reservation was made on, even if the settle crosses midnight", async () => {
    const db = new FakeDynamoDb();
    const reservation = (await budget(db, Date.parse("2026-10-21T23:59:59.000Z")).reserve(2_000, LIMITS))!;
    const nextDay = createBrokerE2EDayBudget({ ...store(db), projectName: "payments", now: () => Date.parse("2026-10-22T00:00:05.000Z") });
    await nextDay.reserve(500, LIMITS);
    await reservation.settle(800);
    expect(row(db, "2026-10-21")).toMatchObject({ inputTokens: 800, calls: 1 });
    expect(row(db, "2026-10-22")).toMatchObject({ inputTokens: 500, calls: 1 });
  });

  it("keeps projects apart", async () => {
    const db = new FakeDynamoDb();
    await budget(db).reserve(9_000, LIMITS);
    const other = createBrokerE2EDayBudget({ ...store(db), projectName: "billing", now: () => DAY });
    expect(await other.reserve(9_000, LIMITS)).not.toBeNull();
  });

  it("answers the dispatch precheck from a keyed read, before a run starts", async () => {
    const db = new FakeDynamoDb();
    expect(await e2eDayBudgetRoom({ ...store(db), projectName: "payments", now: DAY }, { inputTokens: 400_000, calls: 12 }, { maxInputTokens: 2_000_000, maxCalls: 400 })).toBe(true);
    db.set({ pk: "PROJECT#payments", sk: "E2E_MODEL_BUDGET#2026-10-21", inputTokens: 1_700_000, calls: 100 });
    expect(await e2eDayBudgetRoom({ ...store(db), projectName: "payments", now: DAY }, { inputTokens: 400_000, calls: 12 }, { maxInputTokens: 2_000_000, maxCalls: 400 })).toBe(false);
    db.set({ pk: "PROJECT#payments", sk: "E2E_MODEL_BUDGET#2026-10-21", inputTokens: 1_000, calls: 395 });
    expect(await e2eDayBudgetRoom({ ...store(db), projectName: "payments", now: DAY }, { inputTokens: 400_000, calls: 12 }, { maxInputTokens: 2_000_000, maxCalls: 400 })).toBe(false);
    expect(db.commandNames().filter((name) => name === "ScanCommand")).toEqual([]);
  });
});

describe("the governed route against the broker-backed budget", () => {
  const route = (db: FakeDynamoDb, invoke: Parameters<typeof createGovernedE2EModelRoute>[1]["invoke"], definition = available(bedrock)) => {
    let clock = DAY;
    return createGovernedE2EModelRoute(definition, { invoke, now: () => (clock += 5),
      dayBudget: createBrokerE2EDayBudget({ ...store(db), projectName: "payments", now: () => DAY }) });
  };
  const row = (db: FakeDynamoDb) => db.get("PROJECT#payments", "E2E_MODEL_BUDGET#2026-10-21");

  it("charges one call and the reported tokens for a call that is answered", async () => {
    const db = new FakeDynamoDb();
    const { receipt } = await route(db, async () => tapAnswer()).generate(channelRequest());
    expect(receipt.outcome).toBe("ok");
    expect(row(db)).toMatchObject({ inputTokens: 900, calls: 1 });
  });

  it("charges the reserved bound, and keeps the call, when a sent call reports zero input tokens", async () => {
    const db = new FakeDynamoDb();
    const { receipt } = await route(db, async () => tapAnswer({ usage: { inputTokens: 0, outputTokens: 5 } })).generate(channelRequest());
    expect(receipt.outcome).toBe("invalid-output");
    expect(row(db)?.calls).toBe(1);
    expect(Number(row(db)?.inputTokens)).toBeGreaterThanOrEqual(1_024);
  });

  it("releases the call and its tokens when the request was never sent", async () => {
    const db = new FakeDynamoDb();
    const refused = Object.assign(new Error("environment can redirect model calls"), { requestNotSent: true });
    const { receipt } = await route(db, async () => { throw refused; }).generate(channelRequest());
    expect(receipt.outcome).toBe("provider-error");
    expect(row(db)).toMatchObject({ inputTokens: 0, calls: 0 });
  });

  it("keeps the reservation when the provider failed after the request may have gone out", async () => {
    const db = new FakeDynamoDb();
    const { receipt } = await route(db, async () => { throw new Error("boom"); }).generate(channelRequest());
    expect(receipt.outcome).toBe("provider-error");
    expect(row(db)?.calls).toBe(1);
    expect(Number(row(db)?.inputTokens)).toBeGreaterThan(0);
  });

  it("declines with model-route-budget-exhausted when the day is spent, without calling the provider", async () => {
    const db = new FakeDynamoDb();
    db.set({ pk: "PROJECT#payments", sk: "E2E_MODEL_BUDGET#2026-10-21", inputTokens: 1_999_900, calls: 3 });
    const invoke = vi.fn(async () => tapAnswer());
    const { result, receipt } = await route(db, invoke).generate(channelRequest());
    expect(invoke).not.toHaveBeenCalled();
    expect(receipt.outcome).toBe("budget");
    expect(JSON.stringify(result)).toContain(E2E_BUDGET_EXHAUSTED_PREFIX);
  });

  it("declines with budget, never calling the provider, when the reservation cannot be recorded", async () => {
    const db = new FakeDynamoDb();
    db.injectFault({ command: "UpdateCommand", error: { name: "InternalServerError" } });
    const invoke = vi.fn(async () => tapAnswer());
    const { receipt } = await route(db, invoke).generate(channelRequest());
    expect(invoke).not.toHaveBeenCalled();
    expect(receipt.outcome).toBe("budget");
    expect(row(db)).toBeUndefined();
  });
});

describe("the registry rows do not touch membership", () => {
  it("never writes outside the route registry and project budget partitions", async () => {
    const db = new FakeDynamoDb();
    const planned = await planE2EAgentRoute(store(db), anthropic);
    if (planned.status !== "available") throw new Error("unavailable");
    await approveE2EAgentRoute(store(db), anthropic, planned.revision);
    await createBrokerE2EDayBudget({ ...store(db), projectName: "payments", now: () => DAY }).reserve(100, { maxInputTokens: 1_000, maxCalls: 2 });
    expect([...db.items.values()].map((item) => String(item.pk)).sort()).toEqual([E2E_MODEL_ROUTE_PARTITION, E2E_MODEL_ROUTE_PARTITION, "PROJECT#payments"]);
    expect([...db.items.values()].some((item) => String(item.pk).startsWith("MEMBER#"))).toBe(false);
  });

  it("is the source of the keyed read the deploy check can use (the scan it replaces is in scripts/test-deploy.ts)", () => {
    const script = readFileSync(new URL("../../scripts/test-deploy.ts", import.meta.url), "utf8");
    // Recorded for Task 4.8: this key is what its check reads instead of the filtered scan.
    expect(script).toContain("E2E_MODEL_ROUTE_LATEST#");
    expect(E2E_MODEL_ROUTE_PARTITION).toBe("E2E_MODEL_ROUTES");
  });
});

describe("a project's policy carries the approved revision", () => {
  it("accepts the revision id the registry mints as the policy's model route revision", () => {
    const revision = e2eModelRouteRevision(available(anthropic, 3));
    expect(revision).toMatch(/^r3-[a-f0-9]{12}$/);
    const policy = { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [], targets: [], defaultSandboxProfileId: "default-sandbox", fallback: "mock-unconnected",
      modelRouteRevision: revision, capture: { screenshots: true, traces: false, video: false, downloads: true },
      limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000, maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } };
    expect(E2EPolicySchema.parse(policy).modelRouteRevision).toBe(revision);
  });
});

describe("which read failures a later attempt can get past (Ruling M4-AE)", () => {
  const named = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(name), { name, ...extra });
  it.each([
    ["DynamoDB throttling", named("ProvisionedThroughputExceededException")], ["a request limit", named("RequestLimitExceeded")], ["throttling", named("ThrottlingException")],
    ["an InternalServerError", named("InternalServerError")], ["a 5xx status", named("Whatever", { $metadata: { httpStatusCode: 502 } })], ["a 429 status", named("Whatever", { $metadata: { httpStatusCode: 429 } })],
    ["a server fault", named("Whatever", { $fault: "server" })], ["a network reset", named("Error", { code: "ECONNRESET" })], ["a connect timeout", named("Error", { code: "ETIMEDOUT" })],
    ["a timeout", named("TimeoutError")], ["an abort", named("AbortError")], ["a transient cause behind a wrapper", named("Error", { cause: named("ThrottlingException") })],
  ])("is transient: %s", (_label, error) => { expect(isTransientAwsFault(error)).toBe(true); });
  it.each([
    ["access denied", named("AccessDeniedException", { $metadata: { httpStatusCode: 400 } })], ["a missing parameter", named("ParameterNotFound")], ["a validation error", named("ValidationException")],
    ["a malformed row", new Error("the stored latest route revision cannot be read")], ["a conditional failure", named("ConditionalCheckFailedException")], ["a string", "boom"], ["nothing", undefined],
  ])("is deterministic: %s", (_label, error) => { expect(isTransientAwsFault(error)).toBe(false); });
});

describe("the broker reads the definition of the admitted revision from the registry (Task 4.4a, ruling DJ)", () => {
  const approve = async (db: FakeDynamoDb, installation: E2EAgentInstallation) => {
    const planned = await planE2EAgentRoute(store(db), installation);
    if (planned.status !== "available") throw new Error("unavailable");
    await approveE2EAgentRoute(store(db), installation, planned.revision);
    return { routeId: E2E_DEFAULT_MODEL_ROUTE_ID, routeRevision: planned.revision, definition: planned.definition };
  };
  const read = (db: FakeDynamoDb) => (key: { pk: string; sk: string }) => store(db).documentClient.send({ input: { TableName: TABLE, Key: key }, constructor: { name: "GetCommand" } } as never)
    .then((result) => (result as { Item?: Record<string, unknown> }).Item);
  const readFrom = (db: FakeDynamoDb) => (key: { pk: string; sk: string }) => Promise.resolve(db.get(key.pk, key.sk) as Record<string, unknown> | undefined);

  it("returns the stored definition of the revision, with one keyed read and nothing else", async () => {
    const db = new FakeDynamoDb();
    const route = await approve(db, anthropic);
    const keys: Array<{ pk: string; sk: string }> = [];
    const definition = await readAdmittedE2EModelRoute(async (key) => { keys.push(key); return readFrom(db)(key); }, route);
    expect(definition).toEqual(route.definition);
    expect(keys).toEqual([e2eModelRouteRevisionKey(route.routeId, 1)]);
    void read;
  });

  it("is null for a revision the registry does not hold, another route id, or a revision that cannot be read", async () => {
    const db = new FakeDynamoDb();
    const route = await approve(db, anthropic);
    expect(await readAdmittedE2EModelRoute(readFrom(db), { routeId: route.routeId, routeRevision: "r2-aaaaaaaaaaaa" })).toBeNull();
    expect(await readAdmittedE2EModelRoute(readFrom(db), { routeId: "some-other-route", routeRevision: route.routeRevision })).toBeNull();
    expect(await readAdmittedE2EModelRoute(readFrom(db), { routeId: route.routeId, routeRevision: "not-a-revision" })).toBeNull();
  });

  it("is null for a row that is not exactly the revision it is filed under: a definition that hashes to another revision, another number, or another entity", async () => {
    const db = new FakeDynamoDb();
    const route = await approve(db, anthropic);
    const key = e2eModelRouteRevisionKey(route.routeId, 1);
    const row = db.get(key.pk, key.sk) as Record<string, unknown>;
    const other = available(bedrock, 1);
    for (const edit of [{ definition: other }, { revisionNumber: 2 }, { revision: "r1-bbbbbbbbbbbb" }, { entityType: "SOMETHING" }, { routeId: "other" }, { definition: { ...route.definition, budgets: { ...route.definition.budgets, maxModelCallsPerGroup: 39 } } }]) {
      expect(await readAdmittedE2EModelRoute(async () => ({ ...row, ...edit }), route), JSON.stringify(Object.keys(edit))).toBeNull();
    }
    // The row as written is accepted (the control for the edits above).
    expect(await readAdmittedE2EModelRoute(async () => row, route)).toEqual(route.definition);
  });

  it("tries a fault it can expect to get past (throttling, a timeout) up to three times in all, and throws one that persists, or any other at once", async () => {
    const db = new FakeDynamoDb();
    const route = await approve(db, anthropic);
    const throttled = Object.assign(new Error("slow down"), { name: "ThrottlingException" });
    let calls = 0; const sleeps: number[] = [];
    const flaky = async (key: { pk: string; sk: string }) => { calls += 1; if (calls < 3) throw throttled; return readFrom(db)(key); };
    expect(await readAdmittedE2EModelRoute(flaky, route, { sleep: async (ms) => { sleeps.push(ms); } })).toEqual(route.definition);
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
    calls = 0;
    await expect(readAdmittedE2EModelRoute(async () => { calls += 1; throw throttled; }, route, { sleep: async () => undefined })).rejects.toBe(throttled);
    expect(calls).toBe(3);
    calls = 0;
    const denied = Object.assign(new Error("no"), { name: "AccessDeniedException" });
    await expect(readAdmittedE2EModelRoute(async () => { calls += 1; throw denied; }, route, { sleep: async () => undefined })).rejects.toBe(denied);
    expect(calls).toBe(1);
  });
});
