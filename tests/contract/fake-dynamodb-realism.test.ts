// The fake DynamoDB behaves like the real service by default: it refuses expression attributes the real service
// refuses, and it hands a map's attributes back in an order of its own, not the order they were written in.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { describe, expect, it } from "vitest";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { recordStream } from "../support/developer-task-broker.js";

const TABLE = "state";
const KEYS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];

function written(): Record<string, unknown> {
  return { pk: "ITEM#1", sk: "META", ...Object.fromEntries(KEYS.map((key, index) => [key, index])), nested: Object.fromEntries(KEYS.map((key) => [key, key])) };
}

async function validationError(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught as Error);
  expect(error?.name).toBe("ValidationException");
  return error!.message;
}

describe("FakeDynamoDb realism defaults", () => {
  it("refuses an update with an unused expression attribute value", async () => {
    const db = new FakeDynamoDb();
    expect(await validationError(db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: "ITEM#1", sk: "META" },
      UpdateExpression: "SET alpha = :alpha", ExpressionAttributeValues: { ":alpha": 1, ":x": 2 } })))).toMatch(/unused in expressions: keys: \{:x\}/);
    expect(db.get("ITEM#1", "META")).toBeUndefined();
  });

  it("refuses unused or undefined names, undefined values and empty maps on every command", async () => {
    const db = new FakeDynamoDb();
    expect(await validationError(db.send(new PutCommand({ TableName: TABLE, Item: { pk: "a", sk: "b" },
      ConditionExpression: "attribute_not_exists(pk)", ExpressionAttributeNames: { "#unused": "x" } })))).toMatch(/ExpressionAttributeNames unused/);
    expect(await validationError(db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: "a", sk: "b" },
      ConditionExpression: "#s = :s", ExpressionAttributeValues: { ":s": "x" } })))).toMatch(/name used in expression is not defined: #s/);
    expect(await validationError(db.send(new GetCommand({ TableName: TABLE, Key: { pk: "a", sk: "b" },
      ProjectionExpression: "pk", ExpressionAttributeNames: { "#n": "name" } })))).toMatch(/unused/);
    expect(await validationError(db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "a", ":stale": undefined } })))).toMatch(/undefined value for :stale/);
    expect(await validationError(db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: "a", sk: "b" },
      UpdateExpression: "REMOVE alpha", ExpressionAttributeValues: {} })))).toMatch(/ExpressionAttributeValues must not be empty/);
  });

  it("validates each transaction entry on its own, and applies none when one is refused", async () => {
    const db = new FakeDynamoDb();
    const message = await validationError(db.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: TABLE, Item: { pk: "ITEM#1", sk: "META" }, ConditionExpression: "attribute_not_exists(pk)" } },
      // The first entry's value is unused in the second, so each entry must be checked against its own expressions.
      { Update: { TableName: TABLE, Key: { pk: "ITEM#2", sk: "META" }, UpdateExpression: "SET alpha = :alpha", ExpressionAttributeValues: { ":alpha": 1, ":beta": 2 } } },
    ] })));
    expect(message).toMatch(/:beta/);
    expect(db.get("ITEM#1", "META")).toBeUndefined();
    expect(await validationError(db.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: TABLE, Key: { pk: "ITEM#1", sk: "META" }, ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":unused": 1 } } },
      { Put: { TableName: TABLE, Item: { pk: "ITEM#2", sk: "META" } } },
    ] })))).toMatch(/:unused/);
  });

  it("hands a map back in an order that is neither the write order nor dependent on it, and stable across round trips", async () => {
    const db = new FakeDynamoDb();
    const item = written();
    await db.send(new PutCommand({ TableName: TABLE, Item: item }));
    const first = (await db.send(new GetCommand({ TableName: TABLE, Key: { pk: "ITEM#1", sk: "META" } })) as { Item: Record<string, unknown> }).Item;
    expect(first).toEqual(item);
    expect(Object.keys(first)).not.toEqual(Object.keys(item));
    expect(Object.keys(first.nested as object)).not.toEqual(Object.keys(item.nested as object));
    // Not a reversal: a reversed write order would read back in the write order after one round trip.
    expect(Object.keys(first)).not.toEqual(Object.keys(item).reverse());
    // Writing back what was read, or the same content in any other order, reads back in the one order the key set has.
    await db.send(new PutCommand({ TableName: TABLE, Item: first }));
    const second = (await db.send(new GetCommand({ TableName: TABLE, Key: { pk: "ITEM#1", sk: "META" } })) as { Item: Record<string, unknown> }).Item;
    expect(Object.keys(second)).toEqual(Object.keys(first));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const shuffled = Object.fromEntries(Object.entries(item).sort(([left], [right]) => right.localeCompare(left)));
    await db.send(new PutCommand({ TableName: TABLE, Item: shuffled }));
    const third = (await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": "ITEM#1" } })) as { Items: Array<Record<string, unknown>> }).Items[0]!;
    expect(JSON.stringify(third)).toBe(JSON.stringify(first));
  });

  it("orders maps by its own seed, so two tables need not agree", () => {
    const left = new FakeDynamoDb({ seed: 1 });
    const right = new FakeDynamoDb({ seed: 2 });
    const item = written();
    expect(Object.keys(left.reorder(item) as object)).not.toEqual(Object.keys(right.reorder(item) as object));
  });

  it("an opt-out keeps insertion order and accepts what DynamoDB would refuse, only when asked for", async () => {
    const db = new FakeDynamoDb({ realism: { mapOrder: false, validateExpressions: false } });
    const item = written();
    await db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: "ITEM#2", sk: "META" }, UpdateExpression: "SET alpha = :alpha", ExpressionAttributeValues: { ":alpha": 1, ":x": 2 } }));
    await db.send(new PutCommand({ TableName: TABLE, Item: item }));
    const read = (await db.send(new GetCommand({ TableName: TABLE, Key: { pk: "ITEM#1", sk: "META" } })) as { Item: Record<string, unknown> }).Item;
    expect(Object.keys(read)).toEqual(Object.keys(item));
  });

  it("with eventual consistency, a read that is not consistent sees the previous version once after a write", async () => {
    const db = new FakeDynamoDb({ consistency: "eventual" });
    const key = { pk: "ITEM#1", sk: "META" };
    const get = async (consistent: boolean) => (await db.send(new GetCommand({ TableName: TABLE, Key: key, ...(consistent ? { ConsistentRead: true } : {}) })) as { Item?: Record<string, unknown> }).Item;
    await db.send(new PutCommand({ TableName: TABLE, Item: { ...key, version: 1 } }));
    expect(await get(false)).toBeUndefined();
    expect(await get(false)).toEqual({ ...key, version: 1 });
    await db.send(new UpdateCommand({ TableName: TABLE, Key: key, UpdateExpression: "SET version = :v", ExpressionAttributeValues: { ":v": 2 } }));
    expect(await get(true)).toEqual({ ...key, version: 2 });
    expect(await get(false)).toEqual({ ...key, version: 1 });
    expect(await get(false)).toEqual({ ...key, version: 2 });
  });

  it("is strongly consistent by default", async () => {
    const db = new FakeDynamoDb();
    await db.send(new PutCommand({ TableName: TABLE, Item: { pk: "ITEM#1", sk: "META", version: 1 } }));
    expect((await db.send(new GetCommand({ TableName: TABLE, Key: { pk: "ITEM#1", sk: "META" } })) as { Item?: unknown }).Item).toEqual({ pk: "ITEM#1", sk: "META", version: 1 });
  });

  it("stream images carry maps in the table's order, and duplicateNext delivers the next record twice", async () => {
    const db = new FakeDynamoDb();
    const stream = recordStream(db);
    const item = written();
    await db.send(new PutCommand({ TableName: TABLE, Item: item }));
    stream.duplicateNext();
    await db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: "ITEM#1", sk: "META" }, UpdateExpression: "SET alpha = :a", ExpressionAttributeValues: { ":a": 9 } }));
    const records = stream.take();
    expect(records.map((record) => record.eventName)).toEqual(["INSERT", "MODIFY", "MODIFY"]);
    expect(records[2]).toEqual(records[1]);
    const image = records[0]!.dynamodb!.NewImage!;
    expect(Object.keys(image)).not.toEqual(Object.keys(item));
    expect(Object.keys(image)).toEqual(Object.keys(db.reorder(item) as object));
    expect(unmarshall(image)).toEqual(item);
    const old = records[1]!.dynamodb!.OldImage!;
    expect(Object.keys(old.nested!.M!)).toEqual(Object.keys((db.reorder(item) as { nested: object }).nested));
  });
});
