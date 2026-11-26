import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { E2E_DEFAULT_MODEL_ROUTE_ID } from "@agentx/contracts";
import { DEFAULT_E2E_AGENT_MODELS } from "../../packages/model-runtime/src/config.js";
import { E2E_BUDGET_EXHAUSTED_PREFIX, createGovernedE2EModelRoute } from "../../packages/model-runtime/src/e2e-route.js";
import { E2E_MODEL_ROUTE_PARTITION, agentRouteSummary, approveE2EAgentRoute, createBrokerE2EDayBudget, deriveE2EAgentRoute, isTransientAwsFault, e2eModelRouteRevisionKey, planE2EAgentRoute, readAdmittedE2EModelRoute, readE2EModelRouteLatest, type E2EAgentInstallation } from "../../packages/broker/src/e2e/model-route-registry.js";
import { FakeDynamoDb, assumeDrivingTestsPassed } from "../support/fake-dynamodb.js";
import { SECRET_ARN, channelRequest, tapAnswer } from "../support/e2e-model-fixtures.js";
import { TEST_ORG, testProjectPk } from "../support/orgs.js";

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


  it("reads the proposal sentence the administrator approves", () => {
    expect(agentRouteSummary(available(anthropic))).toBe(`AI navigation: Anthropic \`${DEFAULT_E2E_AGENT_MODELS.anthropic}\` (Rovara's recommendation); at most 8 actions per step; checks decide`);
    expect(agentRouteSummary(available(bedrock))).toMatch(/^AI navigation: Amazon Bedrock `us\.anthropic\.claude-haiku-5-5` \(Rovara's recommendation\)\. Your app's pages are processed by the AI in US data centers\. At most 8 actions per step; checks decide$/);
  });
});

describe("the registry keeps revisions in the broker table and reads them by key", () => {

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
    expect(db.commandNames().filter((name) => name === "ScanCommand")).toEqual([]);
    expect(db.commandNames()).toContain("GetCommand");
  });
});

describe("the broker-backed day budget", () => {
  const budget = (db: FakeDynamoDb, now = DAY) => createBrokerE2EDayBudget({ ...store(db), orgId: TEST_ORG, projectName: "payments", now: () => now });
  const LIMITS = { maxInputTokens: 10_000, maxCalls: 3 };
  const row = (db: FakeDynamoDb, day = "2026-10-21") => db.get(testProjectPk("payments"), `E2E_MODEL_BUDGET#${day}`);

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

  it("settles an overrun in full, because the provider billed it", async () => {
    const db = new FakeDynamoDb();
    const reservation = (await budget(db).reserve(4_000, LIMITS))!;
    await reservation.settle(5_500);
    expect(row(db)).toMatchObject({ inputTokens: 5_500, calls: 1 });
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

});

describe("the governed route against the broker-backed budget", () => {
  const route = (db: FakeDynamoDb, invoke: Parameters<typeof createGovernedE2EModelRoute>[1]["invoke"], definition = available(bedrock)) => {
    let clock = DAY;
    return createGovernedE2EModelRoute(definition, { invoke, now: () => (clock += 5),
      dayBudget: createBrokerE2EDayBudget({ ...store(db), orgId: TEST_ORG, projectName: "payments", now: () => DAY }) });
  };
  const row = (db: FakeDynamoDb) => db.get(testProjectPk("payments"), "E2E_MODEL_BUDGET#2026-10-21");

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
    db.set({ pk: testProjectPk("payments"), sk: "E2E_MODEL_BUDGET#2026-10-21", inputTokens: 1_999_900, calls: 3 });
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

describe("which read failures a later attempt can get past (Ruling M4-AE)", () => {
  const named = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(name), { name, ...extra });
  it.each([ ["a 5xx status", named("Whatever", { $metadata: { httpStatusCode: 502 } })],
    ["a server fault", named("Whatever", { $fault: "server" })], ["a network reset", named("Error", { code: "ECONNRESET" })], ["a transient cause behind a wrapper", named("Error", { cause: named("ThrottlingException") })],
  ])("is transient: %s", (_label, error) => { expect(isTransientAwsFault(error)).toBe(true); });
  it.each([
    ["access denied", named("AccessDeniedException", { $metadata: { httpStatusCode: 400 } })], ["a string", "boom"],
  ])("is deterministic: %s", (_label, error) => { expect(isTransientAwsFault(error)).toBe(false); });
});

describe("the broker reads the definition of the admitted revision from the registry (Task 4.4a, ruling DJ)", () => {
  const approve = async (db: FakeDynamoDb, installation: E2EAgentInstallation) => {
    const planned = await planE2EAgentRoute(store(db), installation);
    if (planned.status !== "available") throw new Error("unavailable");
    await approveE2EAgentRoute(store(db), installation, planned.revision);
    return { routeId: E2E_DEFAULT_MODEL_ROUTE_ID, routeRevision: planned.revision, definition: planned.definition };
  };
  const readFrom = (db: FakeDynamoDb) => (key: { pk: string; sk: string }) => Promise.resolve(db.get(key.pk, key.sk) as Record<string, unknown> | undefined);

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
