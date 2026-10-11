import { describe, expect, it } from "vitest";
import {
  claimGithubWebhookDelivery, completeGithubWebhookDelivery, processGithubWebhookDelivery, rejectGithubWebhookDelivery,
  reserveGithubWebhookDelivery, retryGithubWebhookDelivery,
} from "../../packages/broker/src/aws/github-webhooks.js";
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

  it("makes a first retryable failure RETRYABLE with a next attempt time, and rethrows the original error", async () => {
    const { table, documentClient } = await seeded();
    const failure = new Error("GitHub API unavailable");
    await expect(processGithubWebhookDelivery({
      documentClient, tableName: "state", received, now: () => START, log: () => {},
      process: async () => { throw failure; },
    })).rejects.toBe(failure);
    const stored = table.get(key.pk, key.sk);
    expect(stored).toMatchObject({ status: "RETRYABLE", attempts: 1, nextAttemptAt: "2026-10-05T12:01:00.000Z" });
    expect(stored?.leaseToken).toBeUndefined();
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

  it("makes a delivery left PROCESSING at the attempt limit DEAD when it fails again, so it cannot loop", async () => {
    const { table, documentClient } = await seeded();
    table.set({ ...table.get(key.pk, key.sk)!, status: "PROCESSING", attempts: 8, leaseToken: "550e8400-e29b-41d4-a716-446655440023", leaseExpiresAt: "2026-10-05T11:59:00.000Z" });
    await expect(processGithubWebhookDelivery({
      documentClient, tableName: "state", received, now: () => START, log: () => {},
      process: async () => { throw new Error("fails again"); },
    })).rejects.toThrow(/fails again/);
    expect(table.get(key.pk, key.sk)).toMatchObject({ status: "DEAD", attempts: 9 });
  });

  it("logs the original error's name and code, never its message, before it records the failure", async () => {
    const { documentClient } = await seeded();
    const entries: Array<Record<string, unknown>> = [];
    await expect(processGithubWebhookDelivery({
      documentClient, tableName: "state", received, now: () => START, log: (entry) => entries.push(entry),
      process: async () => { throw Object.assign(new Error("token ghs_secret in body"), { name: "RUNTIME_UNAVAILABLE", code: "E_FEEDBACK" }); },
    })).rejects.toThrow();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ deliveryId, error: "RUNTIME_UNAVAILABLE", code: "E_FEEDBACK" });
    expect(JSON.stringify(entries)).not.toContain("ghs_secret");
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

  it("sends the retry write only the values its branch uses", async () => {
    // Plain recorder: the exact value set, independent of the validator.
    const sent: Array<Record<string, unknown>> = [];
    const documentClient = { async send(command: unknown) {
      const typed = command as { constructor: { name: string }; input: Record<string, unknown> };
      if (typed.constructor.name === "GetCommand") return { Item: { attempts: 1 } };
      sent.push(typed.input); return {};
    } };
    await retryGithubWebhookDelivery({ documentClient, tableName: "state", deliveryId, leaseToken: "550e8400-e29b-41d4-a716-446655440024", now: START });
    expect(Object.keys(sent[0]!.ExpressionAttributeValues as object).sort()).toEqual([":leaseToken", ":nextAttemptAt", ":now", ":processing", ":recoveryPk", ":recoverySk", ":retryable"]);
  });
});
