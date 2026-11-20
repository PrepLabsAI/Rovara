import { describe, expect, it } from "vitest";
import { claimGithubWebhookDelivery, completeGithubWebhookDelivery, processGithubWebhookDelivery, rejectGithubWebhookDelivery, reserveGithubWebhookDelivery } from "../../packages/broker/src/aws/github-webhooks.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { assertDynamoExpressionAttributes, validatingDocumentClient } from "../support/validating-document-client.js";

const deliveryId = "550e8400-e29b-41d4-a716-446655440020";
const key = { pk: `GITHUB_DELIVERY#${deliveryId}`, sk: "META" };
const event = { kind: "PULL_REQUEST" as const, action: "closed", installationId: 777, repositoryId: 1234, fullName: "acme/payments", number: 9 };
const received = { delivery: "ACCEPTED" as const, deliveryId, event };
const START = "2026-10-05T12:00:00.000Z";

async function seeded() {
  const table = new FakeDynamoDb();
  const documentClient = validatingDocumentClient(table);
  await reserveGithubWebhookDelivery({ documentClient, tableName: "state", deliveryId, installationId: 777, repositoryId: 1234, eventHash: "d".repeat(64), event, now: START });
  return { table, documentClient };
}

describe("the validating document client", () => {
  it("refuses unused and undefined expression attributes as DynamoDB does", () => {
    const base = { UpdateExpression: "SET a = :a", ConditionExpression: "#s = :s", ExpressionAttributeNames: { "#s": "status" } };
    expect(() => assertDynamoExpressionAttributes({ ...base, ExpressionAttributeValues: { ":a": 1, ":s": "x" } })).not.toThrow();
    expect(() => assertDynamoExpressionAttributes({ ...base, ExpressionAttributeValues: { ":a": 1, ":s": "x", ":unused": 2 } })).toThrow(expect.objectContaining({ name: "ValidationException" }));
    expect(() => assertDynamoExpressionAttributes({ ...base, ExpressionAttributeNames: { "#s": "status", "#extra": "x" }, ExpressionAttributeValues: { ":a": 1, ":s": "x" } })).toThrow(expect.objectContaining({ name: "ValidationException" }));
    expect(() => assertDynamoExpressionAttributes({ ...base, ExpressionAttributeValues: { ":a": undefined, ":s": "x" } })).toThrow(expect.objectContaining({ name: "ValidationException" }));
    expect(() => assertDynamoExpressionAttributes({ ...base, ExpressionAttributeValues: { ":a": 1 } })).toThrow(expect.objectContaining({ name: "ValidationException" }));
  });
});

describe("GitHub webhook delivery bookkeeping against a DynamoDB-validating client", () => {
  it("claims, completes and rejects without unused expression values", async () => {
    const { table, documentClient } = await seeded();
    await claimGithubWebhookDelivery({ documentClient, tableName: "state", deliveryId, leaseToken: "550e8400-e29b-41d4-a716-446655440021", now: START });
    await completeGithubWebhookDelivery({ documentClient, tableName: "state", deliveryId, leaseToken: "550e8400-e29b-41d4-a716-446655440021", now: START });
    expect(table.get(key.pk, key.sk)?.status).toBe("COMPLETED");
    const other = await seeded();
    await claimGithubWebhookDelivery({ documentClient: other.documentClient, tableName: "state", deliveryId, leaseToken: "550e8400-e29b-41d4-a716-446655440022", now: START });
    await rejectGithubWebhookDelivery({ documentClient: other.documentClient, tableName: "state", deliveryId, leaseToken: "550e8400-e29b-41d4-a716-446655440022", now: START });
    expect(other.table.get(key.pk, key.sk)?.status).toBe("DEAD");
  });

  it("makes the eighth failed attempt DEAD and removes it from the retry index", async () => {
    const { table, documentClient } = await seeded();
    table.set({ ...table.get(key.pk, key.sk)!, attempts: 7 });
    await expect(processGithubWebhookDelivery({
      documentClient, tableName: "state", received, now: () => START, log: () => {},
      process: async () => { throw new Error("still failing"); },
    })).rejects.toThrow(/still failing/);
    const stored = table.get(key.pk, key.sk);
    expect(stored).toMatchObject({ status: "DEAD", attempts: 8 });
    expect(stored?.webhookRecoveryPk).toBeUndefined();
    expect(stored?.nextAttemptAt).toBeUndefined();
  });

  it("still reports the original error when the bookkeeping write itself fails", async () => {
    const { table } = await seeded();
    const entries: Array<Record<string, unknown>> = [];
    table.injectFault({ command: "UpdateCommand", match: (input) => String(input.UpdateExpression).includes("DEAD") || String(input.UpdateExpression).includes(":retryable"), error: { name: "ProvisionedThroughputExceededException" } });
    // The first UpdateCommand is the claim; the fault matches only the retry write.
    await expect(processGithubWebhookDelivery({
      documentClient: table, tableName: "state", received, now: () => START, log: (entry) => entries.push(entry),
      process: async () => { throw Object.assign(new Error("boom"), { name: "OriginalFailure" }); },
    })).rejects.toBeDefined();
    expect(entries[0]).toMatchObject({ error: "OriginalFailure" });
  });

});
