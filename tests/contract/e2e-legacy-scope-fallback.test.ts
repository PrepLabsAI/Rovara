import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { E2E_MODEL_ROUTE_DEFAULT_BUDGETS, e2eApplicationAccountDefinitionDigest, OrgIdSchema, type E2EModelDayBudgetRequest } from "@agentx/contracts";
import { planSyntheticAccountWrites } from "../../packages/broker/src/e2e/application-account-registry.js";
import { accountRegistryFences, planSetupAccountWrites, readAccountRegistryEntries } from "../../packages/broker/src/aws/e2e-account-registry.js";
import { handleE2EModelBudgetCallback, type E2EModelBudgetDependencies, type E2EModelBudgetOperation } from "../../packages/broker/src/e2e/model-budget-endpoint.js";
import { createBrokerE2EDayBudget, e2eDayBudgetRoom } from "../../packages/broker/src/e2e/model-route-registry.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { NOW as PLAN_NOW, snapshotOf } from "../support/e2e-application-plan-fixtures.js";
import { ORDERS_APPLICATION_ID, contractOf, ordersManifestWith, withOwnerB, withViewerRole } from "../support/e2e-account-registry-fixtures.js";
import { TEST_ORG, testProjectPk } from "../support/orgs.js";

// Before 744b6e68 the production E2E account registry and AI navigation day budgets sat under the unscoped partition `PROJECT#<name>`; now they sit under
// `ORG#<org>#PROJECT#<name>`. Rows that were written before the move must still be read, and an open budget reservation must still settle, for Code's one implicit
// company; another company must never read them; and every new row goes under the new key.

void PLAN_NOW;
const TABLE = "state";
const LEGACY_PK = "PROJECT#payments";
const OTHER_ORG = OrgIdSchema.parse("org_bbbbbbbbbbbbbbbbbbbb");
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const T1 = "2026-10-01T00:00:00.000Z";
const T2 = "2026-10-02T00:00:00.000Z";
const SHA = "a".repeat(64);

/** A client that remembers every key it was asked to read, so a test can show which partitions a call touched. */
function spied(db: FakeDynamoDb) {
  const reads: Array<{ pk: string; sk: string }> = [];
  const send = async (command: { input: Record<string, unknown> }) => {
    const key = command.input.Key as { pk: string; sk: string } | undefined;
    if (key !== undefined && command.constructor.name === "GetCommand") reads.push(key);
    return db.send(command);
  };
  return { reads, store: { documentClient: { send } as never, tableName: TABLE } };
}
/** The partition of the row a transaction item puts. */
const putPk = (item: { Put?: { Item?: Record<string, unknown> | undefined } | undefined }): unknown => item.Put?.Item?.["pk"];
const touchedLegacy = (reads: Array<{ pk: string }>) => reads.some((read) => read.pk === LEGACY_PK);

describe("the account registry across the key move", () => {
  const four = contractOf(ordersManifestWith(withOwnerB));
  const changed = contractOf(ordersManifestWith((e2e) => { withOwnerB(e2e); withViewerRole("auditor")(e2e); }));
  const snapshotOfContract = (...edits: Array<(e2e: Parameters<typeof withOwnerB>[0]) => void>) =>
    snapshotOf({ "package.json": ordersManifestWith((e2e) => { withOwnerB(e2e); for (const edit of edits) edit(e2e); }) });
  const PROFILES = ["synthetic", "orders-owner", "orders-viewer", "orders-owner-b"];

  /** The rows the old layout held for the four synthetic profiles of the fixture contract at revision 1, under the unscoped partition. */
  function seedLegacy(db: FakeDynamoDb, now = T0) {
    const writes = planSyntheticAccountWrites({ contract: four, applicationId: ORDERS_APPLICATION_ID, prior: [], now, setup: { approvedAt: T1 } });
    for (const write of writes) {
      const { applicationId, profileId, revision } = write.definition;
      db.set({ pk: LEGACY_PK, sk: `E2E_ACCOUNT#${applicationId}#${profileId}#REV#${revision}`, entityType: "E2E_ACCOUNT", ...write.definition });
      db.set({ pk: LEGACY_PK, sk: `E2E_ACCOUNT_LATEST#${applicationId}#${profileId}`, entityType: "E2E_ACCOUNT_LATEST", ...write.latest, setupApprovedAt: T1, setupProposalSha256: SHA });
    }
    return writes;
  }
  const pairs = PROFILES.map((profileId) => ({ applicationId: ORDERS_APPLICATION_ID, profileId }));
  const scopedLatest = (profile: string) => ({ pk: testProjectPk("payments"), sk: `E2E_ACCOUNT_LATEST#${ORDERS_APPLICATION_ID}#${profile}` });
  const transact = (db: FakeDynamoDb, items: unknown[]) => db.send(new TransactWriteCommand({ TransactItems: items as never }));

  it("reads an account written under the old unscoped key for the implicit company", async () => {
    const db = new FakeDynamoDb();
    const written = seedLegacy(db);
    const read = await readAccountRegistryEntries({ documentClient: { send: db.send } as never, tableName: TABLE }, TEST_ORG, "payments", pairs);
    expect(read.corrupt).toEqual([]);
    expect(read.entries.map((entry) => entry.definition)).toEqual(written.map((write) => write.definition));
    expect(read.entries.map((entry) => entry.latest)).toEqual(written.map((write) => write.latest));
    expect(read.entries.every((entry) => entry.setupApprovedAt === T1)).toBe(true);
  });

  it("prefers the new key: a row under the scoped partition is the one read, and the old revision is ignored", async () => {
    const db = new FakeDynamoDb();
    seedLegacy(db);
    const viewer = planSyntheticAccountWrites({ contract: changed, applicationId: ORDERS_APPLICATION_ID, prior: [], now: T0 + 1000, setup: { approvedAt: T2 } }).find((write) => write.definition.profileId === "orders-viewer")!;
    const revision2 = { ...viewer.definition, revision: 2 };
    db.set({ ...scopedLatest("orders-viewer"), entityType: "E2E_ACCOUNT_LATEST", revision: 2, definitionDigest: e2eApplicationAccountDefinitionDigest(revision2) });
    db.set({ pk: testProjectPk("payments"), sk: `E2E_ACCOUNT#${ORDERS_APPLICATION_ID}#orders-viewer#REV#2`, entityType: "E2E_ACCOUNT", ...revision2 });
    const read = await readAccountRegistryEntries({ documentClient: { send: db.send } as never, tableName: TABLE }, TEST_ORG, "payments", [{ applicationId: ORDERS_APPLICATION_ID, profileId: "orders-viewer" }]);
    expect(read.corrupt).toEqual([]);
    expect(read.entries.map((entry) => entry.definition.revision)).toEqual([2]);
    expect(read.entries[0]!.legacy).toBeUndefined();
  });

  it("does not fall back to the old key when the new row exists but cannot be read: the account is reported unreadable", async () => {
    const db = new FakeDynamoDb();
    seedLegacy(db);
    db.set({ ...scopedLatest("orders-viewer"), entityType: "E2E_ACCOUNT_LATEST", revision: "garbage" });
    const read = await readAccountRegistryEntries({ documentClient: { send: db.send } as never, tableName: TABLE }, TEST_ORG, "payments", [{ applicationId: ORDERS_APPLICATION_ID, profileId: "orders-viewer" }]);
    expect(read.entries).toEqual([]);
    expect(read.corrupt).toEqual([expect.objectContaining({ profileId: "orders-viewer" })]);
  });

  it("never reads the old unscoped key for another company: company B does not see company A's account, and the key is not even asked for", async () => {
    const db = new FakeDynamoDb();
    seedLegacy(db);
    const { reads, store } = spied(db);
    const read = await readAccountRegistryEntries(store, OTHER_ORG, "payments", pairs);
    expect(read).toEqual({ entries: [], corrupt: [] });
    expect(touchedLegacy(reads)).toBe(false);
  });

  it("plans company B's setup from nothing, not from company A's old accounts, and writes only under B's own partition", async () => {
    const db = new FakeDynamoDb();
    seedLegacy(db);
    const plan = await planSetupAccountWrites({ documentClient: { send: db.send } as never, tableName: TABLE }, { orgId: OTHER_ORG, projectId: "payments", snapshot: snapshotOfContract(), setup: { approvedAt: T2, proposalSha256: SHA }, now: T0 });
    expect(plan.written).toBe(4);
    const keys = plan.items.map((item) => putPk(item));
    expect(new Set(keys)).toEqual(new Set([`ORG#${OTHER_ORG}#PROJECT#payments`]));
  });

  it("writes a changed account's next revision under the new key, starting from the old row, and leaves the old rows as they were", async () => {
    const db = new FakeDynamoDb();
    seedLegacy(db);
    const before = structuredClone(db.find((row) => row.pk === LEGACY_PK));
    const plan = await planSetupAccountWrites({ documentClient: { send: db.send } as never, tableName: TABLE }, { orgId: TEST_ORG, projectId: "payments", snapshot: snapshotOfContract(withViewerRole("auditor")), setup: { approvedAt: T2, proposalSha256: SHA }, now: T0 + 86_400_000 });
    // The viewer changed (revision 2); the other three are registered unchanged by a newer setup (a pointer raise). Every row lands under the new key.
    expect(plan.written).toBe(4);
    expect(plan.planKey.split("\n")).toContain([ORDERS_APPLICATION_ID, "orders-viewer", "2"].join("\u0000"));
    for (const item of plan.items) expect(putPk(item)).toBe(testProjectPk("payments"));
    expect(await transact(db, plan.items)).toBeDefined();
    expect(db.get(testProjectPk("payments"), `E2E_ACCOUNT#${ORDERS_APPLICATION_ID}#orders-viewer#REV#2`)).toMatchObject({ revision: 2 });
    expect(db.get(testProjectPk("payments"), `E2E_ACCOUNT_LATEST#${ORDERS_APPLICATION_ID}#orders-viewer`)).toMatchObject({ revision: 2, setupApprovedAt: T2 });
    expect(db.find((row) => row.pk === LEGACY_PK)).toEqual(before);
    // The next read finds revision 2 under the new key, and the account is no longer read from the old one.
    const read = await readAccountRegistryEntries({ documentClient: { send: db.send } as never, tableName: TABLE }, TEST_ORG, "payments", [{ applicationId: ORDERS_APPLICATION_ID, profileId: "orders-viewer" }]);
    expect(read.entries[0]!.definition.revision).toBe(2);
  });

  it("moves an unchanged account to the new key when a newer setup registers it (the pointer raise carries its definition along)", async () => {
    const db = new FakeDynamoDb();
    seedLegacy(db);
    const plan = await planSetupAccountWrites({ documentClient: { send: db.send } as never, tableName: TABLE }, { orgId: TEST_ORG, projectId: "payments", snapshot: snapshotOfContract(), setup: { approvedAt: T2, proposalSha256: SHA }, now: T0 + 86_400_000 });
    expect(plan.written).toBe(4);
    await transact(db, plan.items);
    for (const profile of PROFILES) {
      expect(db.get(scopedLatest(profile).pk, scopedLatest(profile).sk), profile).toMatchObject({ revision: 1, setupApprovedAt: T2 });
      expect(db.get(testProjectPk("payments"), `E2E_ACCOUNT#${ORDERS_APPLICATION_ID}#${profile}#REV#1`), profile).toMatchObject({ entityType: "E2E_ACCOUNT", revision: 1 });
    }
    const read = await readAccountRegistryEntries({ documentClient: { send: db.send } as never, tableName: TABLE }, TEST_ORG, "payments", pairs);
    expect(read.corrupt).toEqual([]);
    expect(read.entries).toHaveLength(4);
  });

  it("still reads an account's older revisions from the old key once its newest revision is under the new key (a task pinned to an older project revision keeps its definition)", async () => {
    const db = new FakeDynamoDb();
    const written = seedLegacy(db);
    const viewer1 = written.find((write) => write.definition.profileId === "orders-viewer")!;
    const plan = await planSetupAccountWrites({ documentClient: { send: db.send } as never, tableName: TABLE }, { orgId: TEST_ORG, projectId: "payments", snapshot: snapshotOfContract(withViewerRole("auditor")), setup: { approvedAt: T2, proposalSha256: SHA }, now: T0 + 86_400_000 });
    await transact(db, plan.items);
    const read = await readAccountRegistryEntries({ documentClient: { send: db.send } as never, tableName: TABLE }, TEST_ORG, "payments", [{ applicationId: ORDERS_APPLICATION_ID, profileId: "orders-viewer" }], { earlierFor: () => true });
    expect(read.entries[0]!.definition.revision).toBe(2);
    expect(read.entries[0]!.earlier).toEqual([viewer1.definition]);
    // Company B, with its own revision 2 of the same-named account, gets none of company A's old revision 1 as an earlier definition.
    const bPk = `ORG#${OTHER_ORG}#PROJECT#payments`;
    const viewer2 = read.entries[0]!;
    db.set({ pk: bPk, sk: `E2E_ACCOUNT_LATEST#${ORDERS_APPLICATION_ID}#orders-viewer`, entityType: "E2E_ACCOUNT_LATEST", ...viewer2.latest, setupApprovedAt: T2, setupProposalSha256: SHA });
    db.set({ pk: bPk, sk: `E2E_ACCOUNT#${ORDERS_APPLICATION_ID}#orders-viewer#REV#2`, entityType: "E2E_ACCOUNT", ...viewer2.definition });
    const other = await readAccountRegistryEntries({ documentClient: { send: db.send } as never, tableName: TABLE }, OTHER_ORG, "payments", [{ applicationId: ORDERS_APPLICATION_ID, profileId: "orders-viewer" }], { earlierFor: () => true });
    expect(other.entries[0]!.definition.revision).toBe(2);
    expect(other.entries[0]!.earlier).toEqual([]);
  });

  it("fences an account read from the old key: the transaction fails once the account has a row under the new key,", async () => {
    const db = new FakeDynamoDb();
    seedLegacy(db);
    const store = { documentClient: { send: db.send } as never, tableName: TABLE };
    const { entries } = await readAccountRegistryEntries(store, TEST_ORG, "payments", pairs);
    const refs = entries.map((entry) => ({ applicationId: entry.definition.applicationId, profileId: entry.definition.profileId }));
    const fences = accountRegistryFences({ orgId: TEST_ORG, tableName: TABLE, projectId: "payments", refs: refs as never, entries });
    const probe = { Put: { TableName: TABLE, Item: { pk: "PROBE", sk: "ROW", entityType: "PROBE" } } };
    expect(fences.length).toBeGreaterThan(0);
    await transact(db, [...fences, probe]);
    expect(db.get("PROBE", "ROW")).toBeDefined();
    // A registration moved one account to the new key meanwhile: the earlier read is stale.
    const viewer = entries.find((entry) => entry.definition.profileId === "orders-viewer")!;
    db.set({ ...scopedLatest("orders-viewer"), entityType: "E2E_ACCOUNT_LATEST", ...viewer.latest });
    db.delete("PROBE", "ROW");
    await expect(transact(db, [...fences, probe])).rejects.toThrow();
    expect(db.get("PROBE", "ROW")).toBeUndefined();
  });
});

describe("the AI navigation day budget across the key move", () => {
  const DAY = Date.parse("2026-10-21T10:00:00.000Z");
  const DAY_KEY = "2026-10-21";
  const LIMITS = { maxInputTokens: 10_000, maxCalls: 5 };
  const legacyDay = (db: FakeDynamoDb, inputTokens: number, calls: number) =>
    db.set({ pk: LEGACY_PK, sk: `E2E_MODEL_BUDGET#${DAY_KEY}`, entityType: "E2E_MODEL_BUDGET", inputTokens, calls, indexExpiresAt: Math.floor(DAY / 1000) + 90_000 });
  const scopedDay = (db: FakeDynamoDb, orgPk = testProjectPk("payments")) => db.get(orgPk, `E2E_MODEL_BUDGET#${DAY_KEY}`);
  const route = (db: FakeDynamoDb, orgId = TEST_ORG) => ({ documentClient: { send: db.send } as never, tableName: TABLE, orgId, projectName: "payments", now: DAY });

  it("counts the old day row toward the day's room for the implicit company only", async () => {
    const db = new FakeDynamoDb();
    legacyDay(db, 9_000, 4);
    expect(await e2eDayBudgetRoom(route(db), { inputTokens: 1_000, calls: 1 }, LIMITS)).toBe(true);
    expect(await e2eDayBudgetRoom(route(db), { inputTokens: 1_001, calls: 1 }, LIMITS)).toBe(false);
    expect(await e2eDayBudgetRoom(route(db), { inputTokens: 100, calls: 2 }, LIMITS)).toBe(false);
    // Company B has the whole day, and the old key is never asked for.
    const { reads, store } = spied(db);
    expect(await e2eDayBudgetRoom({ ...route(db, OTHER_ORG), ...store }, { inputTokens: 10_000, calls: 5 }, LIMITS)).toBe(true);
    expect(touchedLegacy(reads)).toBe(false);
  });

  it("adds the old and the new day rows, so spending that began before the move still counts after it", async () => {
    const db = new FakeDynamoDb();
    legacyDay(db, 5_000, 2);
    db.set({ pk: testProjectPk("payments"), sk: `E2E_MODEL_BUDGET#${DAY_KEY}`, entityType: "E2E_MODEL_BUDGET", inputTokens: 4_000, calls: 2 });
    expect(await e2eDayBudgetRoom(route(db), { inputTokens: 1_000, calls: 1 }, LIMITS)).toBe(true);
    expect(await e2eDayBudgetRoom(route(db), { inputTokens: 1_001, calls: 1 }, LIMITS)).toBe(false);
    expect(await e2eDayBudgetRoom(route(db), { inputTokens: 1, calls: 2 }, LIMITS)).toBe(false);
  });

  it("reserves under the new key only, within the room the old row leaves, and never touches the old row", async () => {
    const db = new FakeDynamoDb();
    legacyDay(db, 7_000, 3);
    const budget = createBrokerE2EDayBudget({ ...route(db), now: () => DAY });
    expect(await budget.reserve(3_001, LIMITS)).toBeNull();
    expect(await budget.reserve(3_000, LIMITS)).not.toBeNull();
    expect(scopedDay(db)).toMatchObject({ inputTokens: 3_000, calls: 1 });
    expect(await budget.reserve(1, { maxInputTokens: 10_000, maxCalls: 4 })).toBeNull();
    expect(db.get(LEGACY_PK, `E2E_MODEL_BUDGET#${DAY_KEY}`)).toMatchObject({ inputTokens: 7_000, calls: 3 });
  });

  it("holds the cap against the old and the new rows together when it writes (a reserve that fits either row alone is refused)", async () => {
    const db = new FakeDynamoDb();
    legacyDay(db, 7_000, 1);
    db.set({ pk: testProjectPk("payments"), sk: `E2E_MODEL_BUDGET#${DAY_KEY}`, entityType: "E2E_MODEL_BUDGET", inputTokens: 2_000, calls: 1 });
    const budget = createBrokerE2EDayBudget({ ...route(db), now: () => DAY });
    expect(await budget.reserve(1_001, LIMITS)).toBeNull();
    expect(await budget.reserve(1_000, LIMITS)).not.toBeNull();
    expect(scopedDay(db)).toMatchObject({ inputTokens: 3_000, calls: 2 });
  });

  it("gives company B the whole day: its reserve ignores the old row and never reads it", async () => {
    const db = new FakeDynamoDb();
    legacyDay(db, 9_999, 5);
    const { reads, store } = spied(db);
    const budget = createBrokerE2EDayBudget({ ...route(db, OTHER_ORG), ...store, now: () => DAY });
    expect(await budget.reserve(10_000, LIMITS)).not.toBeNull();
    expect(scopedDay(db, `ORG#${OTHER_ORG}#PROJECT#payments`)).toMatchObject({ inputTokens: 10_000, calls: 1 });
    expect(touchedLegacy(reads)).toBe(false);
  });
});

describe("the day budget callback across the key move", () => {
  const NOW = Date.parse("2026-10-21T10:00:00.000Z");
  const DAY = "2026-10-21";
  const TASK = "11111111-aaaa-4bbb-8ccc-111111111111";
  const GROUP = "22222222-aaaa-4bbb-8ccc-222222222222";
  const CAPS = { tokens: E2E_MODEL_ROUTE_DEFAULT_BUDGETS.maxInputTokensPerProjectDay, calls: E2E_MODEL_ROUTE_DEFAULT_BUDGETS.maxCallsPerProjectDay };
  const scopedPk = (org: string) => `ORG#${org}#PROJECT#payments`;

  function fixture(org: typeof TEST_ORG = TEST_ORG) {
    const db = new FakeDynamoDb();
    db.set({ pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVTASK", workspaceId: "ws-1", project: "payments" });
    const operation: E2EModelBudgetOperation = { id: "op-1", workspaceId: "ws-1", kind: "task", workflowMode: "CHECKS", status: "RUNNING", workflowE2EAdmission: { taskId: TASK, groupRunIds: [GROUP], agentSteps: true } };
    const watched = spied(db);
    const dependencies: E2EModelBudgetDependencies = { documentClient: watched.store.documentClient, tableName: TABLE, now: () => NOW, orgOf: async () => org };
    const call = (body: unknown) => handleE2EModelBudgetCallback(dependencies, operation, body);
    return { db, call, reads: watched.reads };
  }
  const base = (reservationId: string) => ({ schemaVersion: "rovara-e2e-model-budget/v1", reservationId });
  const reserveBody = (id: string, inputTokens = 4_000) => ({ ...base(id), stage: "reserve", groupRunId: GROUP, inputTokens }) as E2EModelDayBudgetRequest;
  const settleBody = (id: string, actual: number) => ({ ...base(id), stage: "settle", actualInputTokens: actual }) as E2EModelDayBudgetRequest;
  const releaseBody = (id: string) => ({ ...base(id), stage: "release" }) as E2EModelDayBudgetRequest;
  const legacyReservation = (db: FakeDynamoDb, id: string, tokens = 4_000, status = "open") => {
    db.set({ pk: LEGACY_PK, sk: `E2E_MODEL_BUDGET#${DAY}`, entityType: "E2E_MODEL_BUDGET", inputTokens: tokens + 1_000, calls: 2 });
    db.set({ pk: LEGACY_PK, sk: `E2E_MODEL_BUDGET_RESERVATION#${id}`, entityType: "E2E_MODEL_BUDGET_RESERVATION", schemaVersion: 1, status, day: DAY, reservedInputTokens: tokens, groupRunId: GROUP, operationId: "op-1" });
  };
  const legacyRows = (db: FakeDynamoDb) => db.find((row) => row.pk === LEGACY_PK);
  const scopedRows = (db: FakeDynamoDb, org: string) => db.find((row) => row.pk === scopedPk(org));

  it("settles a reservation that is still open under the old key: the old reservation row and the old day row move, and no new row appears", async () => {
    const { db, call } = fixture();
    const id = randomUUID();
    legacyReservation(db, id);
    expect(await call(settleBody(id, 1_500))).toMatchObject({ reservationId: id, status: "settled" });
    expect(db.get(LEGACY_PK, `E2E_MODEL_BUDGET_RESERVATION#${id}`)).toMatchObject({ status: "settled", settledInputTokens: 1_500 });
    expect(db.get(LEGACY_PK, `E2E_MODEL_BUDGET#${DAY}`)).toMatchObject({ inputTokens: 5_000 - 4_000 + 1_500, calls: 2 });
    expect(scopedRows(db, TEST_ORG)).toEqual([]);
    // A second settle is a no-op, as it is for a new reservation.
    expect(await call(settleBody(id, 1_500))).toMatchObject({ status: "settled" });
    expect(db.get(LEGACY_PK, `E2E_MODEL_BUDGET#${DAY}`)).toMatchObject({ inputTokens: 2_500 });
  });

  it("releases a reservation that is still open under the old key, giving back its tokens and its call", async () => {
    const { db, call } = fixture();
    const id = randomUUID();
    legacyReservation(db, id);
    expect(await call(releaseBody(id))).toMatchObject({ status: "released" });
    expect(db.get(LEGACY_PK, `E2E_MODEL_BUDGET#${DAY}`)).toMatchObject({ inputTokens: 1_000, calls: 1 });
    expect(db.get(LEGACY_PK, `E2E_MODEL_BUDGET_RESERVATION#${id}`)).toMatchObject({ status: "released" });
    expect(scopedRows(db, TEST_ORG)).toEqual([]);
  });

  it("answers a repeated reserve of a reservation made under the old key from that row, without charging a second time", async () => {
    const { db, call } = fixture();
    const id = randomUUID();
    legacyReservation(db, id);
    expect(await call(reserveBody(id))).toMatchObject({ reservationId: id, status: "reserved" });
    expect(db.get(LEGACY_PK, `E2E_MODEL_BUDGET#${DAY}`)).toMatchObject({ inputTokens: 5_000, calls: 2 });
    expect(scopedRows(db, TEST_ORG)).toEqual([]);
    legacyReservation(db, id, 4_000, "settled");
    expect(await call(reserveBody(id))).toMatchObject({ status: "settled" });
    // The same id for another request is still refused.
    await expect(call(reserveBody(id, 5_000))).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
  });

  it("refuses company B a reservation that exists only under the old key, and does not touch or read it", async () => {
    const { db, call, reads } = fixture(OTHER_ORG);
    const id = randomUUID();
    legacyReservation(db, id);
    const before = structuredClone(legacyRows(db));
    await expect(call(settleBody(id, 1_500))).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    await expect(call(releaseBody(id))).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    expect(legacyRows(db)).toEqual(before);
    expect(touchedLegacy(reads)).toBe(false);
  });

  it("reserves a new call under the new key, within the room the old day row leaves", async () => {
    const { db, call } = fixture();
    db.set({ pk: LEGACY_PK, sk: `E2E_MODEL_BUDGET#${DAY}`, entityType: "E2E_MODEL_BUDGET", inputTokens: CAPS.tokens - 3_999, calls: 1 });
    expect(await call(reserveBody(randomUUID(), 4_000))).toMatchObject({ status: "exhausted" });
    expect(scopedRows(db, TEST_ORG)).toEqual([]);
    const id = randomUUID();
    expect(await call(reserveBody(id, 3_999))).toMatchObject({ status: "reserved" });
    expect(db.get(scopedPk(TEST_ORG), `E2E_MODEL_BUDGET#${DAY}`)).toMatchObject({ inputTokens: 3_999, calls: 1 });
    expect(db.get(scopedPk(TEST_ORG), `E2E_MODEL_BUDGET_RESERVATION#${id}`)).toMatchObject({ status: "open" });
    expect(db.get(LEGACY_PK, `E2E_MODEL_BUDGET#${DAY}`)).toMatchObject({ inputTokens: CAPS.tokens - 3_999, calls: 1 });
    // The new reservation settles under the new key.
    expect(await call(settleBody(id, 1_000))).toMatchObject({ status: "settled" });
    expect(db.get(scopedPk(TEST_ORG), `E2E_MODEL_BUDGET#${DAY}`)).toMatchObject({ inputTokens: 1_000 });
    expect(db.get(LEGACY_PK, `E2E_MODEL_BUDGET#${DAY}`)).toMatchObject({ inputTokens: CAPS.tokens - 3_999 });
  });

  it("holds the day's caps against the old and the new rows together when it writes", async () => {
    const { db, call } = fixture();
    db.set({ pk: LEGACY_PK, sk: `E2E_MODEL_BUDGET#${DAY}`, entityType: "E2E_MODEL_BUDGET", inputTokens: CAPS.tokens - 3_000, calls: 1 });
    db.set({ pk: scopedPk(TEST_ORG), sk: `E2E_MODEL_BUDGET#${DAY}`, entityType: "E2E_MODEL_BUDGET", inputTokens: 2_000, calls: 1 });
    expect(await call(reserveBody(randomUUID(), 1_001))).toMatchObject({ status: "exhausted" });
    expect(await call(reserveBody(randomUUID(), 1_000))).toMatchObject({ status: "reserved" });
  });

  it("gives company B the whole day: an old day row at its cap does not exhaust it, and nothing is read from the old key", async () => {
    const { db, call, reads } = fixture(OTHER_ORG);
    db.set({ pk: LEGACY_PK, sk: `E2E_MODEL_BUDGET#${DAY}`, entityType: "E2E_MODEL_BUDGET", inputTokens: CAPS.tokens, calls: CAPS.calls });
    const id = randomUUID();
    expect(await call(reserveBody(id, 4_000))).toMatchObject({ status: "reserved" });
    expect(db.get(scopedPk(OTHER_ORG), `E2E_MODEL_BUDGET#${DAY}`)).toMatchObject({ inputTokens: 4_000, calls: 1 });
    expect(touchedLegacy(reads)).toBe(false);
  });
});
