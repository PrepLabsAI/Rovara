import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { DYNAMODB_ITEM_MAX_BYTES, FakeDynamoDb } from "../support/fake-dynamodb.js";

describe("FakeDynamoDb faults and limits", () => {
  it("fails a matching command the requested number of times with the named AWS error", async () => {
    const db = new FakeDynamoDb();
    db.injectFault({ command: "PutCommand", match: (input) => (input.Item as { pk?: string }).pk === "A", error: { name: "ProvisionedThroughputExceededException" }, times: 2 });
    const put = () => db.send(new PutCommand({ TableName: "t", Item: { pk: "A", sk: "META" } }));
    await expect(put()).rejects.toMatchObject({ name: "ProvisionedThroughputExceededException" });
    await expect(put()).rejects.toMatchObject({ name: "ProvisionedThroughputExceededException" });
    await expect(put()).resolves.toEqual({});
    await db.send(new PutCommand({ TableName: "t", Item: { pk: "B", sk: "META" } }));
    expect((await db.send(new GetCommand({ TableName: "t", Key: { pk: "B", sk: "META" } })) as { Item?: unknown }).Item).toBeDefined();
  });

  it("refuses any write that leaves an item over 400 KB, atomically for transactions", async () => {
    const db = new FakeDynamoDb();
    await db.send(new PutCommand({ TableName: "t", Item: { pk: "A", sk: "META", body: "x" } }));
    const big = "y".repeat(DYNAMODB_ITEM_MAX_BYTES);
    await expect(db.send(new UpdateCommand({ TableName: "t", Key: { pk: "A", sk: "META" }, UpdateExpression: "SET body = :b", ExpressionAttributeValues: { ":b": big } })))
      .rejects.toMatchObject({ name: "ValidationException" });
    await expect(db.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: "t", Item: { pk: "C", sk: "META" } } },
      { Put: { TableName: "t", Item: { pk: "D", sk: "META", body: big } } },
    ] }))).rejects.toMatchObject({ name: "ValidationException" });
    expect(db.get("C", "META")).toBeUndefined();
    expect(db.get("A", "META")).toMatchObject({ body: "x" });
  });

  it("refuses a transaction with two operations on one item, as DynamoDB does, and writes nothing", async () => {
    const db = new FakeDynamoDb();
    await expect(db.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: "t", Item: { pk: "C", sk: "META" } } },
      { ConditionCheck: { TableName: "t", Key: { pk: "A", sk: "META" }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Update: { TableName: "t", Key: { pk: "A", sk: "META" }, UpdateExpression: "SET body = :b", ExpressionAttributeValues: { ":b": "z" } } },
    ] }))).rejects.toThrow(/multiple operations on one item/);
    expect(db.get("C", "META")).toBeUndefined();
    // The same key in two tables is two items.
    await db.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: "t", Item: { pk: "A", sk: "META" } } },
      { Put: { TableName: "other", Item: { pk: "A", sk: "META" } } },
    ] }));
  });
});
