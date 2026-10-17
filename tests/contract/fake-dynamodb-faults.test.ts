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

  it("evaluates nested document paths for size and contains without accepting a missing nested value", async () => {
    const db = new FakeDynamoDb();
    await db.send(new PutCommand({ TableName: "t", Item: { pk: "PROJECT#orders", sk: "REV#1", runtimeBinding: {
      subnets: [{ subnetId: "subnet-a", availabilityZone: "us-east-1a" }, { subnetId: "subnet-b", availabilityZone: "us-east-1b" }],
    } } }));
    const check = (subnet: string) => db.send(new TransactWriteCommand({ TransactItems: [{ ConditionCheck: {
      TableName: "t", Key: { pk: "PROJECT#orders", sk: "REV#1" },
      ConditionExpression: "size(runtimeBinding.#subnets) = :count AND contains(runtimeBinding.#subnets, :subnet)",
      ExpressionAttributeNames: { "#subnets": "subnets" },
      ExpressionAttributeValues: { ":count": 2, ":subnet": { subnetId: subnet, availabilityZone: "us-east-1a" } },
    } }] }));
    await expect(check("subnet-a")).resolves.toEqual({});
    await expect(check("subnet-foreign")).rejects.toMatchObject({ name: "TransactionCanceledException" });
  });

  it("evaluates indexed nested list paths so reordered bindings fail", async () => {
    const db = new FakeDynamoDb();
    const subnetA = { subnetId: "subnet-a", availabilityZone: "us-east-1a" };
    const subnetB = { subnetId: "subnet-b", availabilityZone: "us-east-1b" };
    await db.send(new PutCommand({ TableName: "t", Item: { pk: "PROJECT#ordered", sk: "REV#1", runtimeBinding: { subnets: [subnetA, subnetB] } } }));
    await db.send(new PutCommand({ TableName: "t", Item: { pk: "PROJECT#swapped", sk: "REV#1", runtimeBinding: { subnets: [subnetB, subnetA] } } }));
    const check = (pk: string) => db.send(new TransactWriteCommand({ TransactItems: [{ ConditionCheck: {
      TableName: "t", Key: { pk, sk: "REV#1" },
      ConditionExpression: "runtimeBinding.#subnets[0].availabilityZone = :az0 AND runtimeBinding.#subnets[0].subnetId = :id0 AND runtimeBinding.#subnets[1].availabilityZone = :az1 AND runtimeBinding.#subnets[1].subnetId = :id1",
      ExpressionAttributeNames: { "#subnets": "subnets" },
      ExpressionAttributeValues: { ":az0": subnetA.availabilityZone, ":id0": subnetA.subnetId, ":az1": subnetB.availabilityZone, ":id1": subnetB.subnetId },
    } }] }));
    await expect(check("PROJECT#ordered")).resolves.toEqual({});
    await expect(check("PROJECT#swapped")).rejects.toMatchObject({ name: "TransactionCanceledException" });
  });

  it("compares complete binding snapshots, rejecting reordered lists and extra nested fields", async () => {
    const db = new FakeDynamoDb();
    const binding = { deploymentMode: "ec2-ebs", launchTemplateId: "lt-12345678", subnets: [
      { subnetId: "subnet-a", availabilityZone: "us-east-1a" }, { subnetId: "subnet-b", availabilityZone: "us-east-1b" },
    ], volumeSizeGiB: 20, volumeType: "gp3" };
    await db.send(new PutCommand({ TableName: "t", Item: { pk: "PROJECT#exact", sk: "REV#1", runtimeBinding: structuredClone(binding) } }));
    await db.send(new PutCommand({ TableName: "t", Item: { pk: "PROJECT#extra", sk: "REV#1", runtimeBinding: {
      ...structuredClone(binding), subnets: [{ ...binding.subnets[0], unexpected: true }, binding.subnets[1]],
    } } }));
    await db.send(new PutCommand({ TableName: "t", Item: { pk: "PROJECT#swapped-map", sk: "REV#1", runtimeBinding: {
      ...structuredClone(binding), subnets: [binding.subnets[1], binding.subnets[0]],
    } } }));
    const check = (pk: string) => db.send(new TransactWriteCommand({ TransactItems: [{ ConditionCheck: {
      TableName: "t", Key: { pk, sk: "REV#1" }, ConditionExpression: "runtimeBinding = :binding",
      ExpressionAttributeValues: { ":binding": binding },
    } }] }));
    await expect(check("PROJECT#exact")).resolves.toEqual({});
    await expect(check("PROJECT#extra")).rejects.toMatchObject({ name: "TransactionCanceledException" });
    await expect(check("PROJECT#swapped-map")).rejects.toMatchObject({ name: "TransactionCanceledException" });
  });
});
