// Convergence lane A1: the DynamoDB document store passes the shared document-store conformance suite unchanged (over the in-memory
// DynamoDB double, which parses the real expressions), and keeps the hosted State table's stored form.
import { runDocumentStoreConformance } from "../support/ports/document-store-conformance.js";
import { dynamoStoreHarness } from "../support/ports/dynamodb-harness.js";

runDocumentStoreConformance("dynamodb (in-memory DynamoDB double)", dynamoStoreHarness());

import { describe, expect, it } from "vitest";
import { ConditionalCheckFailedException, DynamoDBServiceException, GetItemCommand, PutItemCommand, QueryCommand, TransactionCanceledException, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
  DocumentStoreError,
  OUTBOX_PENDING_INDEX,
  change,
  companyScoped,
  isAllowedModuleSpecifier,
  when,
  type DocumentChange,
} from "@agentx/contracts";
import {
  DynamoDocumentStore,
  ConsumerNotReadyError,
  DynamoStreamChangeFeed,
  STATE_TABLE_INDEXES,
  STATE_TABLE_KEY,
  STATE_TABLE_PLANNED_INDEXES,
  UnrepresentableValueError,
  changeOfRecord,
  createDynamoStoreFromSettings,
  indexesOfSettings,
  type DynamoStreamRecord,
} from "../../packages/aws-adapters/src/index.js";
import * as dynamoPluginModule from "../../packages/aws-adapters/src/dynamodb/plugin.js";
import { createAdapterRegistry, loadAdapters, parsePluginConfig, type ModuleImporter } from "../../packages/broker/src/ports/adapter-registry.js";
import { FakeDynamoDb } from "../support/ports/dynamodb-fake.js";
import { dynamoWorld } from "../support/ports/dynamodb-harness.js";

const PK = companyScoped("org_aaaaaaaaaaaaaaaaaaaa", "WORKSPACE#ws_1");
const service = (name: string): DynamoDBServiceException => new DynamoDBServiceException({ name, $fault: "server", $metadata: {}, message: name });
const conflictCancel = (steps: number): TransactionCanceledException => new TransactionCanceledException({
  message: "Transaction cancelled", $metadata: {}, CancellationReasons: Array.from({ length: steps }, (_, index) => ({ Code: index === 0 ? "TransactionConflict" : "None" })),
});

describe("the DynamoDB store keeps the hosted State table's stored form (no data moves)", () => {

  it("describes the State table as the hosted deployment defines it", () => {
    expect(STATE_TABLE_KEY).toEqual({ partitionKey: "pk", sortKey: "sk", streamView: "NEW_AND_OLD_IMAGES" });
    expect(STATE_TABLE_INDEXES.map((index) => [index.name, index.partitionAttribute, index.sortAttribute, index.sortType])).toEqual([
      ["bySessionState", "sessionState", "workspaceId", "string"],
      ["byWorkspaceProject", "workspaceProject", "workspaceCreatedAt", "string"],
      ["github-webhook-recovery", "webhookRecoveryPk", "webhookRecoverySk", "string"],
      ["workflow-dispatch-due", "dispatchDuePk", "dispatchDueSk", "string"],
    ]);
    expect(STATE_TABLE_PLANNED_INDEXES).toEqual([{ name: "outbox-pending", partitionAttribute: "outboxState", sortAttribute: "outboxStagedAt", sortType: "string" }]);
  });

  it("refuses to read a row holding a set or bytes rather than change its type (decision 60)", async () => {
    const world = dynamoWorld();
    world.fake.seed({ pk: { S: PK }, sk: { S: "LIMITS" }, tasks: { SS: ["t1", "t2"] } });
    world.fake.seed({ pk: { S: PK }, sk: { S: "BLOB" }, bytes: { B: new Uint8Array([1]) } });
    await expect(world.store.get({ pk: PK, sk: "LIMITS" })).rejects.toBeInstanceOf(UnrepresentableValueError);
    await expect(world.store.get({ pk: PK, sk: "LIMITS" })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("leaves an unreadable row out of a query page or a getMany and reports its key, instead of failing the read", async () => {
    const reported: string[] = [];
    const world = dynamoWorld({ store: { onUnreadable: (key, error) => void reported.push(`${key.sk}:${error.found}`) } });
    world.fake.seed({ pk: { S: PK }, sk: { S: "A" }, n: { N: "1" } });
    world.fake.seed({ pk: { S: PK }, sk: { S: "LIMITS" }, tasks: { SS: ["t1"] } });
    world.fake.seed({ pk: { S: PK }, sk: { S: "Z" }, n: { N: "2" } });
    expect((await world.store.query({ pk: PK })).items.map((item) => item.sk)).toEqual(["A", "Z"]);
    expect((await world.store.getMany([{ pk: PK, sk: "LIMITS" }, { pk: PK, sk: "Z" }])).map((item) => item?.sk)).toEqual([undefined, "Z"]);
    expect(reported).toEqual(["LIMITS:string set", "LIMITS:string set"]);
  });

  it("counts the rows a scan page leaves out as skipped, so the company purge never ends while one is left", async () => {
    const world = dynamoWorld({ store: { onUnreadable: () => undefined } });
    world.fake.seed({ pk: { S: PK }, sk: { S: "A" }, n: { N: "1" } });
    world.fake.seed({ pk: { S: PK }, sk: { S: "LIMITS" }, tasks: { SS: ["t1"] } });
    const page = await world.store.scanPage({});
    expect(page.items.map((item) => item.sk)).toEqual(["A"]);
    expect(page.skipped).toBe(1);
    world.fake.seed({ pk: { S: `${PK}X` }, sk: { S: "B" }, n: { N: "1" } });
    expect((await world.store.scanPage({ cursor: (await world.store.scanPage({ limit: 2 })).cursor! })).skipped).toBeUndefined();
  });

  it("by default refuses to write a number the hosted broker's document client cannot read back (past 2^53 - 1)", async () => {
    const world = dynamoWorld();
    for (const n of [2 ** 53, -(2 ** 53), 1e21, 1e100, 1e125]) {
      await expect(world.store.put({ item: { pk: PK, sk: "N", n } })).rejects.toMatchObject({ code: "invalid_request" });
      await expect(world.store.put({ item: { pk: PK, sk: "N", deep: { list: [n] } } })).rejects.toMatchObject({ code: "invalid_request" });
      await expect(world.store.update({ key: { pk: PK, sk: "N" }, ops: [change.set("n", n)] })).rejects.toMatchObject({ code: "invalid_request" });
      await expect(world.store.update({ key: { pk: PK, sk: "N" }, ops: [change.add("n", n)] })).rejects.toMatchObject({ code: "invalid_request" });
      await expect(world.store.transact([{ kind: "put", item: { pk: PK, sk: "N", n } }])).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(world.fake.requests).toEqual([]);
    const fine = { pk: PK, sk: "OK", max: Number.MAX_SAFE_INTEGER, min: -Number.MAX_SAFE_INTEGER, small: 1e-129, ms: 1_762_819_200_000, fraction: 0.125 };
    expect((await world.store.put({ item: fine })).applied).toBe(true);
    // What it wrote, the hosted broker's reader reads as plain numbers.
    expect(unmarshall(world.fake.raw(PK, "OK")!)).toEqual(fine);
    const wide = dynamoWorld({ store: { cloudReadableNumbers: false } });
    expect((await wide.store.put({ item: { pk: PK, sk: "N", n: 1e125 } })).applied).toBe(true);
  });

  it("refuses an unpaired surrogate anywhere, which DynamoDB cannot store", async () => {
    const world = dynamoWorld();
    await expect(world.store.put({ item: { pk: PK, sk: "a\ud800" } })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(world.store.put({ item: { pk: PK, sk: "x", text: "b\udc00" } })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(world.store.update({ key: { pk: PK, sk: "x" }, ops: [change.set("t", "\ud800")] })).rejects.toMatchObject({ code: "invalid_request" });
    expect(world.fake.requests).toEqual([]);
    expect((await world.store.put({ item: { pk: PK, sk: "ok", text: "\u{1F600}" } })).applied).toBe(true);
  });
});

describe("the DynamoDB store's requests", () => {

  it("writes an empty and as a test that holds and an empty or as one that fails, on present and absent items", async () => {
    const world = dynamoWorld();
    expect((await world.store.put({ item: { pk: PK, sk: "E1" }, condition: when.and() })).applied).toBe(true);
    expect((await world.store.put({ item: { pk: PK, sk: "E2" }, condition: when.or() })).applied).toBe(false);
    expect((await world.store.put({ item: { pk: PK, sk: "E1", v: 2 }, condition: when.and() })).applied).toBe(true);
    expect((await world.store.put({ item: { pk: PK, sk: "E1", v: 3 }, condition: when.or() })).applied).toBe(false);
  });

  it("answers an index range whose bound has the other type with nothing, without asking DynamoDB", async () => {
    const world = dynamoWorld();
    await world.store.put({ item: { pk: PK, sk: "1", kind: "task", rank: 1 } });
    const before = world.fake.requests.length;
    expect(await world.store.queryIndex({ index: "byKind", partition: "task", sort: { op: "gte", value: "a" } })).toEqual({ items: [] });
    expect(await world.store.queryIndex({ index: "byKind", partition: "task", sort: { op: "between", low: 5, high: 1 } })).toEqual({ items: [] });
    expect(await world.store.query({ pk: PK, sk: { op: "between", low: "b", high: "a" } })).toEqual({ items: [] });
    expect(world.fake.requests.length).toBe(before);
  });

  it("walks every item of the table with a strongly consistent scan, page by page, for the company purge", async () => {
    const world = dynamoWorld({ pageBytes: 2_000 });
    const keys: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const pk = companyScoped(index % 2 === 0 ? "org_aaaaaaaaaaaaaaaaaaaa" : "org_bbbbbbbbbbbbbbbbbbbb", `P${String(index % 3)}`);
      await world.store.put({ item: { pk, sk: `R${String(index).padStart(2, "0")}`, body: "x".repeat(300) } });
      keys.push(`${pk}|R${String(index).padStart(2, "0")}`);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await world.store.scanPage({ limit: 5, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...page.items.map((item) => `${item.pk}|${item.sk}`));
      cursor = page.cursor;
      pages += 1;
      // An item deleted between pages does not break the walk.
      if (pages === 1) await world.store.delete({ key: { pk: page.items[0]!.pk, sk: page.items[0]!.sk } });
    } while (cursor !== undefined);
    expect([...seen].sort()).toEqual([...keys].sort());
    expect(pages).toBeGreaterThan(2);
    const scans = world.fake.requests.filter((entry) => entry.operation === "Scan").map((entry) => entry.input as { ConsistentRead?: boolean; Limit?: number; FilterExpression?: string });
    expect(scans.every((input) => input.ConsistentRead === true && input.Limit === 5 && input.FilterExpression === undefined)).toBe(true);
    await expect(world.store.scanPage({ cursor: (await world.store.query({ pk: keys[0]!.split("|")[0]!, limit: 1 })).cursor ?? "not-a-cursor" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(world.store.scanPage({ limit: 0 })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("refuses a cursor of another partition, and one it did not give out", async () => {
    const world = dynamoWorld();
    for (const sk of ["a", "b", "c"]) await world.store.put({ item: { pk: PK, sk } });
    const page = await world.store.query({ pk: PK, limit: 1 });
    await expect(world.store.query({ pk: `${PK}X`, cursor: page.cursor! })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(world.store.query({ pk: PK, cursor: "not-a-cursor" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(world.store.queryIndex({ index: "byOwner", partition: "x", cursor: page.cursor! })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("fetches the keys DynamoDB left unprocessed and answers in the order asked", async () => {
    const world = dynamoWorld();
    for (const sk of ["1", "2", "3", "4"]) await world.store.put({ item: { pk: PK, sk, n: Number(sk) } });
    world.fake.leaveUnprocessed(2);
    const found = await world.store.getMany([{ pk: PK, sk: "4" }, { pk: PK, sk: "9" }, { pk: PK, sk: "1" }, { pk: PK, sk: "3" }]);
    expect(found.map((item) => item?.n)).toEqual([4, undefined, 1, 3]);
    expect(world.fake.requests.filter((entry) => entry.operation === "BatchGetItem")).toHaveLength(2);
    expect(await world.store.getMany([])).toEqual([]);
  });
});

describe("the DynamoDB store's faults", () => {
  it("retries a transaction that lost a race, then gives up with conflict", async () => {
    const world = dynamoWorld({ conflictAttempts: 3 });
    world.fake.failNext("TransactWriteItems", () => conflictCancel(1), 2);
    expect(await world.store.transact([{ kind: "put", item: { pk: PK, sk: "T" } }])).toEqual({ applied: true });
    const tokens = world.fake.requests.filter((entry) => entry.operation === "TransactWriteItems").map((entry) => (entry.input as { ClientRequestToken: string }).ClientRequestToken);
    expect(tokens).toHaveLength(3);
    expect(new Set(tokens).size).toBe(3);
    world.fake.failNext("TransactWriteItems", () => conflictCancel(1), 3);
    await expect(world.store.transact([{ kind: "put", item: { pk: PK, sk: "T2" } }])).rejects.toMatchObject({ code: "conflict", retryable: true });
    expect(await world.store.get({ pk: PK, sk: "T2" })).toBeUndefined();
  });

  it("turns a step DynamoDB refused into invalid_request", async () => {
    const world = dynamoWorld();
    await world.store.put({ item: { pk: PK, sk: "S", text: "t" } });
    await expect(world.store.transact([{ kind: "update", key: { pk: PK, sk: "S" }, ops: [change.add("text", 1)] }])).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("maps DynamoDB's faults to the port's codes", async () => {
    const world = dynamoWorld();
    world.fake.failNext("GetItem", () => service("ProvisionedThroughputExceededException"));
    await expect(world.store.get({ pk: PK, sk: "x" })).rejects.toMatchObject({ code: "throttled" });
    world.fake.failNext("GetItem", () => service("InternalServerError"));
    await expect(world.store.get({ pk: PK, sk: "x" })).rejects.toMatchObject({ code: "unavailable" });
    world.fake.failNext("Query", () => new Error("socket hang up"));
    await expect(world.store.query({ pk: PK })).rejects.toMatchObject({ code: "unavailable" });
    world.fake.failNext("PutItem", () => service("TransactionConflictException"), 4);
    await expect(world.store.put({ item: { pk: PK, sk: "y" } })).rejects.toMatchObject({ code: "conflict" });
    world.fake.failNext("PutItem", () => service("TransactionConflictException"), 1);
    expect((await world.store.put({ item: { pk: PK, sk: "y" } })).applied).toBe(true);
    const missing = new DynamoDocumentStore({ client: world.fake, tableName: "Other" });
    await expect(missing.get({ pk: PK, sk: "x" })).rejects.toMatchObject({ code: "unavailable" });
    await expect(world.store.queryIndex({ index: "outbox-pending", partition: "PENDING" })).resolves.toEqual({ items: [] });
    const withoutIndex = new DynamoDocumentStore({ client: new FakeDynamoDb({ tableName: "State" }), tableName: "State", indexes: [OUTBOX_PENDING_INDEX] });
    await expect(withoutIndex.queryIndex({ index: "outbox-pending", partition: "PENDING" })).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("the change feed over the table's stream", () => {
  const lambdaRecord = (overrides: Partial<DynamoStreamRecord> = {}): DynamoStreamRecord => ({
    eventID: "1", eventName: "MODIFY",
    dynamodb: { Keys: { pk: { S: PK }, sk: { S: "META" } }, OldImage: { pk: { S: PK }, sk: { S: "META" }, v: { N: "1" } }, NewImage: { pk: { S: PK }, sk: { S: "META" }, v: { N: "2" } }, SequenceNumber: "4421584500000000017450439091", ApproximateCreationDateTime: 1_762_819_200 },
    ...overrides,
  });

  it("reads a Lambda stream record as a change, with sequences that sort as text across digit counts", () => {
    const change1 = changeOfRecord(lambdaRecord());
    expect(change1).toMatchObject({ kind: "modify", cause: "write", key: { pk: PK, sk: "META" }, before: { v: 1 }, after: { v: 2 } });
    const short = changeOfRecord(lambdaRecord({ dynamodb: { ...lambdaRecord().dynamodb, SequenceNumber: "999" } })).sequence;
    const long = changeOfRecord(lambdaRecord({ dynamodb: { ...lambdaRecord().dynamodb, SequenceNumber: "1000" } })).sequence;
    expect(short < long).toBe(true);
    const expired = changeOfRecord({ eventName: "REMOVE", dynamodb: { Keys: { pk: { S: PK }, sk: { S: "OLD" } }, OldImage: { pk: { S: PK }, sk: { S: "OLD" } }, SequenceNumber: "5" }, userIdentity: { type: "Service", principalId: "dynamodb.amazonaws.com" } });
    expect(expired).toMatchObject({ kind: "remove", cause: "expired" });
    expect(() => changeOfRecord(lambdaRecord({ dynamodb: { Keys: { pk: { S: PK }, sk: { S: "META" } }, NewImage: { pk: { S: PK }, sk: { S: "META" } }, SequenceNumber: "6" } }))).toThrow(/old image/);
  });

  it("refuses a consumer the reader did not declare, and a second subscription of one name", async () => {
    const feed = new DynamoStreamChangeFeed({ consumers: ["outbox"] });
    await expect(feed.subscribe("other", async () => {})).rejects.toMatchObject({ code: "invalid_request" });
    const first = await feed.subscribe("outbox", async () => {});
    await expect(feed.subscribe("outbox", async () => {})).rejects.toMatchObject({ code: "invalid_request" });
    await first.stop();
    await (await feed.subscribe("outbox", async () => {})).stop();
  });

  it("reports an unreadable record and hands over the rest; without a reporter the batch fails so the mapping retries", async () => {
    const unreadable: DynamoStreamRecord = { eventName: "INSERT", dynamodb: { Keys: { pk: { S: PK }, sk: { S: "SET" } }, NewImage: { pk: { S: PK }, sk: { S: "SET" }, tasks: { SS: ["a"] } }, SequenceNumber: "7" } };
    const reported: DynamoStreamRecord[] = [];
    const feed = new DynamoStreamChangeFeed({ consumers: ["c"], onUnreadable: (record) => void reported.push(record) });
    const seen: DocumentChange[] = [];
    await feed.subscribe("c", async (batch) => void seen.push(...batch));
    await feed.deliver([unreadable, lambdaRecord()]);
    expect(reported).toHaveLength(1);
    expect(seen.map((entry) => entry.key.sk)).toEqual(["META"]);
    const strict = new DynamoStreamChangeFeed({ consumers: ["c"] });
    await strict.subscribe("c", async () => {});
    await expect(strict.deliver([unreadable])).rejects.toBeInstanceOf(DocumentStoreError);
  });

  it("refuses a batch while a declared consumer has not subscribed, so the checkpoint cannot pass it (cold start)", async () => {
    const feed = new DynamoStreamChangeFeed({ consumers: ["outbox", "notifier"], retryDelayMs: 0 });
    const seen: string[] = [];
    await feed.subscribe("outbox", async (batch) => void seen.push(...batch.map((entry) => `outbox:${entry.key.sk}`)));
    await expect(feed.deliver([lambdaRecord()])).rejects.toBeInstanceOf(ConsumerNotReadyError);
    expect(seen).toEqual([]);
    const notifier = await feed.subscribe("notifier", async (batch) => void seen.push(...batch.map((entry) => `notifier:${entry.key.sk}`)));
    await feed.deliver([lambdaRecord()]);
    expect(seen.sort()).toEqual(["notifier:META", "outbox:META"]);
    // After a stop the reader is short of a consumer again.
    await notifier.stop();
    await expect(feed.deliver([lambdaRecord()])).rejects.toMatchObject({ code: "unavailable" });
  });

  it("refuses the batch a consumer stops in the middle of, so it is handed over again", async () => {
    const feed = new DynamoStreamChangeFeed({ consumers: ["slow"], retryDelayMs: 0 });
    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const subscription = await feed.subscribe("slow", async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); throw new Error("interrupted"); });
    const delivery = feed.deliver([lambdaRecord()]);
    await inside;
    const stopping = subscription.stop();
    release();
    await stopping;
    await expect(delivery).rejects.toBeInstanceOf(ConsumerNotReadyError);
  });
});

describe("the dynamodb storage plug-in", () => {
  const importer: ModuleImporter = async (specifier) => {
    if (specifier !== "@rovara/aws-adapters/dynamodb") throw new Error("no such module");
    return dynamoPluginModule;
  };

  it("is an allowed module name and loads from a config entry, only when named (no AWS call at load)", async () => {
    expect(isAllowedModuleSpecifier("@rovara/aws-adapters/dynamodb")).toBe(true);
    const registry = createAdapterRegistry();
    await loadAdapters(parsePluginConfig({ version: 1, plugins: [{ point: "storage", name: "dynamodb", module: "@rovara/aws-adapters/dynamodb", settings: { tableName: "State", region: "us-west-2", endpoint: "http://127.0.0.1:1", ttlAttribute: "expiresAt" } }] }), { registry, importModule: importer });
    const store = registry.require("storage");
    expect(store).toBeInstanceOf(DynamoDocumentStore);
    expect(store.ttlAttribute).toBe("expiresAt");
    expect(store.indexes.map((index) => index.name)).toEqual(["outbox-pending"]);
    expect(store.changes).toBeUndefined();
  });

  it("checks its settings", () => {
    const fake = new FakeDynamoDb({ tableName: "State" });
    expect(() => createDynamoStoreFromSettings({}, fake)).toThrow(/tableName/);
    expect(() => createDynamoStoreFromSettings({ tableName: "State", tabelName: "x" }, fake)).toThrow(/unknown setting/);
    expect(() => createDynamoStoreFromSettings({ tableName: "State", endpoint: "file:///x" }, fake)).toThrow(/endpoint/);
    expect(() => indexesOfSettings([{ name: "outbox-pending", partitionAttribute: "other" }])).toThrow(/fixed by the outbox/);
    expect(() => indexesOfSettings([{ name: "a", partitionAttribute: "x" }, { name: "a", partitionAttribute: "y" }])).toThrow(/two indexes/);
    expect(indexesOfSettings([...STATE_TABLE_INDEXES.map((index) => ({ ...index })), { ...OUTBOX_PENDING_INDEX }]).map((index) => index.name)).toEqual(["outbox-pending", ...STATE_TABLE_INDEXES.map((index) => index.name)]);
    expect(createDynamoStoreFromSettings({ tableName: "State", ttlAttribute: null }, fake).ttlAttribute).toBeUndefined();
  });
});

describe("the DynamoDB double refuses what DynamoDB refuses", () => {
  const fake = (): FakeDynamoDb => new FakeDynamoDb({ tableName: "State", indexes: [{ name: "byKind", partitionAttribute: "kind", sortAttribute: "rank", sortType: "number" }] });
  const key = { pk: { S: "p" }, sk: { S: "s" } };
  const refused = async (promise: Promise<unknown>, pattern: RegExp): Promise<void> => {
    const error = await promise.then(() => undefined, (caught: unknown) => caught);
    expect((error as Error).name).toBe("ValidationException");
    expect((error as Error).message).toMatch(pattern);
  };

  it("an unused or undefined placeholder, and an empty placeholder map", async () => {
    const db = fake();
    await refused(db.send(new UpdateItemCommand({ TableName: "State", Key: key, UpdateExpression: "SET #a = :a", ExpressionAttributeNames: { "#a": "a", "#b": "b" }, ExpressionAttributeValues: { ":a": { N: "1" } } })), /unused/);
    await refused(db.send(new UpdateItemCommand({ TableName: "State", Key: key, UpdateExpression: "SET #a = :b", ExpressionAttributeNames: { "#a": "a" }, ExpressionAttributeValues: { ":a": { N: "1" } } })), /not defined/);
    await refused(db.send(new PutItemCommand({ TableName: "State", Item: key, ExpressionAttributeValues: {} })), /must not be empty/);
  });

  it("overlapping paths, a key attribute, a missing parent, arithmetic on text", async () => {
    const db = fake();
    await db.send(new PutItemCommand({ TableName: "State", Item: { ...key, t: { S: "x" }, m: { M: {} } } }));
    await refused(db.send(new UpdateItemCommand({ TableName: "State", Key: key, UpdateExpression: "SET #m = :v, #m.#x = :v", ExpressionAttributeNames: { "#m": "m", "#x": "x" }, ExpressionAttributeValues: { ":v": { N: "1" } } })), /overlap/);
    await refused(db.send(new UpdateItemCommand({ TableName: "State", Key: key, UpdateExpression: "SET #k = :v", ExpressionAttributeNames: { "#k": "sk" }, ExpressionAttributeValues: { ":v": { S: "z" } } })), /part of the key/);
    await refused(db.send(new UpdateItemCommand({ TableName: "State", Key: key, UpdateExpression: "REMOVE #n.#x", ExpressionAttributeNames: { "#n": "nope", "#x": "x" } })), /invalid for update/);
    await refused(db.send(new UpdateItemCommand({ TableName: "State", Key: key, UpdateExpression: "SET #t = #t + :v", ExpressionAttributeNames: { "#t": "t" }, ExpressionAttributeValues: { ":v": { N: "1" } } })), /incorrect data type/);
  });

  it("an index key of the wrong type, an oversized item, a number out of range", async () => {
    const db = fake();
    await refused(db.send(new PutItemCommand({ TableName: "State", Item: { ...key, kind: { S: "k" }, rank: { S: "high" } } })), /Index Key/);
    await refused(db.send(new PutItemCommand({ TableName: "State", Item: { ...key, big: { S: "x".repeat(410 * 1_024) } } })), /size/);
    await refused(db.send(new PutItemCommand({ TableName: "State", Item: { ...key, n: { N: "1e200" } } })), /Number/);
  });

  it("answers a failed condition with ConditionalCheckFailedException, and a consistent index read as an error", async () => {
    const db = fake();
    await expect(db.send(new PutItemCommand({ TableName: "State", Item: key, ConditionExpression: "attribute_exists(#p)", ExpressionAttributeNames: { "#p": "pk" } }))).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    await refused(db.send(new QueryCommand({ TableName: "State", IndexName: "byKind", KeyConditionExpression: "#k = :k", ExpressionAttributeNames: { "#k": "kind" }, ExpressionAttributeValues: { ":k": { S: "x" } }, ConsistentRead: true })), /Consistent/);
    expect(await db.send(new GetItemCommand({ TableName: "State", Key: key }))).toMatchObject({ Item: undefined });
  });
});
