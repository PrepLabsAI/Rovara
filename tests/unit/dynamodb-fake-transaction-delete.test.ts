// The in-memory DynamoDB double must answer a transaction's Delete of an item that is not there as the service does (journey 14 found it crashing on one: the review retry's transaction holds one).
// AWS, DeleteItem: "Unless you specify conditions, the DeleteItem is an idempotent operation; running it multiple times on the same item or attribute does not result in an error response."
// AWS, TransactWriteItems: a condition expression that is not met cancels the whole transaction (TransactionCanceledException, cancellation reason ConditionalCheckFailed, "The conditional request failed.").
import { describe, expect, it } from "vitest";
import { TransactWriteItemsCommand, TransactionCanceledException, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { FakeDynamoDb } from "../support/ports/dynamodb-fake.js";

const key = (sk: string): Record<string, AttributeValue> => ({ pk: { S: "P" }, sk: { S: sk } });
function table() {
  const fake = new FakeDynamoDb({ tableName: "T" });
  const records: Array<{ eventName: string | undefined; sk: string | undefined }> = [];
  fake.onStream((record) => records.push({ eventName: record.eventName, sk: record.dynamodb?.Keys?.sk?.S }));
  return { fake, records };
}

describe("the DynamoDB double's transactional Delete", () => {
  it("an unconditional Delete of an item that is not there succeeds, writes no stream record, and does not stop the transaction's other writes", async () => {
    const { fake, records } = table();
    await fake.send(new TransactWriteItemsCommand({ TransactItems: [
      { Delete: { TableName: "T", Key: key("MISSING") } },
      { Put: { TableName: "T", Item: { ...key("NEW"), n: { N: "1" } } } },
    ] }));
    expect(records, "only the Put changed anything").toEqual([{ eventName: "INSERT", sk: "NEW" }]);
  });

  it("an unconditional Delete of an item that is there removes it and writes a REMOVE record", async () => {
    const { fake, records } = table();
    fake.seed({ ...key("HERE"), n: { N: "1" } });
    records.length = 0; // seeding is reported as a write; only the transaction is under test
    await fake.send(new TransactWriteItemsCommand({ TransactItems: [{ Delete: { TableName: "T", Key: key("HERE") } }] }));
    expect(records).toEqual([{ eventName: "REMOVE", sk: "HERE" }]);
    // Deleted: a second, identical transaction is the idempotent case and writes nothing more.
    await fake.send(new TransactWriteItemsCommand({ TransactItems: [{ Delete: { TableName: "T", Key: key("HERE") } }] }));
    expect(records).toHaveLength(1);
  });

  it("a Delete with a condition the missing item cannot meet cancels the whole transaction with ConditionalCheckFailed, and nothing else is written", async () => {
    const { fake, records } = table();
    const refused = await fake.send(new TransactWriteItemsCommand({ TransactItems: [
      { Delete: { TableName: "T", Key: key("MISSING"), ConditionExpression: "attribute_exists(pk)" } },
      { Put: { TableName: "T", Item: { ...key("NEW"), n: { N: "1" } } } },
    ] })).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TransactionCanceledException);
    expect((refused as TransactionCanceledException).CancellationReasons?.map((reason) => reason.Code)).toEqual(["ConditionalCheckFailed", "None"]);
    expect(records, "the Put was not written either").toEqual([]);
  });
});
