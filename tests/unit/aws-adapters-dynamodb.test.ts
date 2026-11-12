// Convergence lane A1: the DynamoDB document store passes the shared document-store conformance suite unchanged (over the in-memory
// DynamoDB double, which parses the real expressions), and keeps the hosted State table's stored form.
import { runDocumentStoreConformance } from "../support/ports/document-store-conformance.js";
import { dynamoStoreHarness } from "../support/ports/dynamodb-harness.js";

runDocumentStoreConformance("dynamodb (in-memory DynamoDB double)", dynamoStoreHarness());

import { describe, expect, it } from "vitest";
import { ConditionalCheckFailedException, DynamoDBServiceException, GetItemCommand, PutItemCommand, QueryCommand, TransactionCanceledException, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  DocumentStoreError,
  OUTBOX_PENDING_INDEX,
  change,
  companyScoped,
  isAllowedModuleSpecifier,
  queryAll,
  when,
  type DocumentChange,
} from "@agentx/contracts";
import {
  DynamoDocumentStore,
  DynamoStreamChangeFeed,
  STATE_TABLE_INDEXES,
  STATE_TABLE_KEY,
  STATE_TABLE_PLANNED_INDEXES,
  STATE_TABLE_TTL_ATTRIBUTE,
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
  // A row as the hosted broker writes it today: its document client marshals plain JavaScript values with default options.
  const cloudRow = {
    pk: PK, sk: "META", entityType: "WORKSPACE", orgId: "org_aaaaaaaaaaaaaaaaaaaa", workspaceProject: "org_aaaaaaaaaaaaaaaaaaaa#proj_1", workspaceCreatedAt: "2026-11-11T00:00:00.000Z",
    revision: 7, cost: 0.125, archived: false, note: null, tags: ["a", "b"], nested: { deep: { list: [1, { x: "y" }] } }, empty: "", emptyList: [], emptyMap: {},
  };

  it("writes exactly the attribute values the hosted broker's document client writes, and adds nothing", async () => {
    const world = dynamoWorld({ indexes: [...STATE_TABLE_INDEXES, OUTBOX_PENDING_INDEX] });
    await world.store.put({ item: cloudRow });
    expect(world.fake.raw(PK, "META")).toEqual(marshall(cloudRow));
    const sent = world.fake.requests.find((entry) => entry.operation === "PutItem")!.input as { Item: unknown; TableName: string };
    expect(sent.Item).toEqual(marshall(cloudRow));
    expect(sent.TableName).toBe("State");
  });

  it("reads a row the hosted broker wrote as the document it wrote, keyed by the same pk and sk", async () => {
    const world = dynamoWorld({ indexes: [...STATE_TABLE_INDEXES, OUTBOX_PENDING_INDEX] });
    world.fake.seed(marshall(cloudRow));
    expect(await world.store.get({ pk: PK, sk: "META" })).toEqual(unmarshall(marshall(cloudRow)));
    const sent = world.fake.requests.find((entry) => entry.operation === "GetItem")!.input as { Key: unknown; ConsistentRead: boolean };
    expect(sent.Key).toEqual({ pk: { S: PK }, sk: { S: "META" } });
    expect(sent.ConsistentRead).toBe(true);
    // The hosted product's workspace index is queried by its own name and attributes.
    const page = await world.store.queryIndex({ index: "byWorkspaceProject", partition: "org_aaaaaaaaaaaaaaaaaaaa#proj_1" });
    expect(page.items.map((item) => item.sk)).toEqual(["META"]);
    expect((world.fake.requests.at(-1)!.input as { IndexName: string }).IndexName).toBe("byWorkspaceProject");
  });

  it("describes the State table as the hosted deployment defines it", () => {
    expect(STATE_TABLE_KEY).toEqual({ partitionKey: "pk", sortKey: "sk", streamView: "NEW_AND_OLD_IMAGES" });
    expect(STATE_TABLE_TTL_ATTRIBUTE).toBe("indexExpiresAt");
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
    await expect(world.store.query({ pk: PK })).rejects.toMatchObject({ code: "invalid_request" });
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
  it("names every attribute and value through placeholders, and sends none it does not use", async () => {
    const world = dynamoWorld();
    await world.store.update({ key: { pk: PK, sk: "U" }, ops: [change.set("a.b", 1), change.add("count", -2), change.setIfAbsent("status", "x"), change.remove("gone")], condition: when.or(when.absent(), when.lt("count", 3)) }).catch(() => undefined);
    const input = world.fake.requests.find((entry) => entry.operation === "UpdateItem")!.input as { UpdateExpression: string; ConditionExpression: string; ExpressionAttributeNames: Record<string, string> };
    expect(input.UpdateExpression).not.toMatch(/\b(count|status|gone)\b/);
    expect(Object.values(input.ExpressionAttributeNames).sort()).toEqual(["a", "b", "count", "gone", "pk", "status"]);
    expect(input.UpdateExpression).toContain(" - ");
  });

  it("writes an empty and as a test that holds and an empty or as one that fails, on present and absent items", async () => {
    const world = dynamoWorld();
    expect((await world.store.put({ item: { pk: PK, sk: "E1" }, condition: when.and() })).applied).toBe(true);
    expect((await world.store.put({ item: { pk: PK, sk: "E2" }, condition: when.or() })).applied).toBe(false);
    expect((await world.store.put({ item: { pk: PK, sk: "E1", v: 2 }, condition: when.and() })).applied).toBe(true);
    expect((await world.store.put({ item: { pk: PK, sk: "E1", v: 3 }, condition: when.or() })).applied).toBe(false);
  });

  it("reads table pages strongly consistently and index pages without asking for it", async () => {
    const world = dynamoWorld();
    await world.store.query({ pk: PK });
    await world.store.queryIndex({ index: "byOwner", partition: "dev" });
    const [table, index] = world.fake.requests.filter((entry) => entry.operation === "Query").map((entry) => entry.input as { ConsistentRead?: boolean; Limit: number });
    expect(table!.ConsistentRead).toBe(true);
    expect(index!.ConsistentRead).toBeUndefined();
    expect(table!.Limit).toBe(1_000);
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

  it("keeps paging when a page ends at DynamoDB's size cap rather than the limit", async () => {
    const world = dynamoWorld({ pageBytes: 2_000 });
    for (let index = 0; index < 30; index += 1) await world.store.put({ item: { pk: PK, sk: `R${String(index).padStart(2, "0")}`, body: "x".repeat(300) } });
    const all = await queryAll(world.store, { pk: PK });
    expect(all.map((item) => item.sk)).toEqual(Array.from({ length: 30 }, (_, index) => `R${String(index).padStart(2, "0")}`));
    expect(world.fake.requests.filter((entry) => entry.operation === "Query").length).toBeGreaterThan(3);
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

  it("names the failed steps even when another step lost a race", async () => {
    const world = dynamoWorld();
    world.fake.failNext("TransactWriteItems", () => new TransactionCanceledException({ message: "x", $metadata: {}, CancellationReasons: [{ Code: "TransactionConflict" }, { Code: "ConditionalCheckFailed" }] }));
    expect(await world.store.transact([{ kind: "put", item: { pk: PK, sk: "A" } }, { kind: "check", key: { pk: PK, sk: "B" }, condition: when.present() }])).toEqual({ applied: false, reason: "condition_failed", failed: [1] });
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

  it("never puts document text in an error message", async () => {
    const world = dynamoWorld();
    world.fake.failNext("PutItem", () => service("InternalServerError"));
    const error = await world.store.put({ item: { pk: PK, sk: "s", secret: "do-not-echo" } }).catch((caught: unknown) => caught as DocumentStoreError);
    expect(String((error as Error).message)).not.toContain("do-not-echo");
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

  it("gives each consumer its own copy of a batch", async () => {
    const feed = new DynamoStreamChangeFeed({ consumers: ["a", "b"] });
    let other: DocumentChange[] = [];
    await feed.subscribe("a", async (batch) => { (batch[0]!.after as unknown as { v: number }).v = 99; });
    await feed.subscribe("b", async (batch) => { other = [...batch]; });
    await feed.deliver([lambdaRecord()]);
    expect((other[0]!.after as unknown as { v: number }).v).toBe(2);
  });

  it("feeds every write of the store through the stream, and nothing for a write that changed nothing", async () => {
    const world = dynamoWorld();
    const seen: DocumentChange[] = [];
    await world.feed.subscribe("suite", async (batch) => void seen.push(...batch));
    await world.store.put({ item: { pk: PK, sk: "S", v: 1 } });
    await world.store.put({ item: { pk: PK, sk: "S", v: 1 } });
    await world.store.update({ key: { pk: PK, sk: "S" }, ops: [change.set("v", 2)] });
    await world.store.delete({ key: { pk: PK, sk: "never" } });
    await world.settled();
    expect(seen.map((entry) => entry.kind)).toEqual(["insert", "modify"]);
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
    await loadAdapters(parsePluginConfig({ version: 1, plugins: [{ point: "storage", name: "dynamodb", module: "@rovara/aws-adapters/dynamodb", settings: { tableName: "State", region: "us-west-2", endpoint: "http://127.0.0.1:1", ttlAttribute: "indexExpiresAt" } }] }), { registry, importModule: importer });
    const store = registry.require("storage");
    expect(store).toBeInstanceOf(DynamoDocumentStore);
    expect(store.ttlAttribute).toBe("indexExpiresAt");
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
