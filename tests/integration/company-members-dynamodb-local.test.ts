import { afterAll, beforeAll, expect, it } from "vitest";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { companyScoped } from "@agentx/contracts";
import { membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";

// Set this only to a local DynamoDB endpoint. This focused integration test is
// intentionally skipped when DynamoDB Local is not available.
const endpoint = process.env.COMPANY_MEMBERS_DYNAMODB_LOCAL_ENDPOINT;
const endpointIsLoopback = (() => {
  if (endpoint === undefined) return false;
  try {
    const parsed = new URL(endpoint);
    return parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  }
  catch { return false; }
})();
const companyId = `org_${"c".repeat(20)}`;
const ownerA = "a".repeat(64), ownerB = "b".repeat(64);
const tableName = `owner-stepdown-${process.pid}`;
const client = !endpointIsLoopback || endpoint === undefined ? undefined : new DynamoDBClient({ endpoint, region: "us-east-1", credentials: { accessKeyId: "local", secretAccessKey: "local" } });
const documentClient = client === undefined ? undefined : DynamoDBDocumentClient.from(client);

beforeAll(async () => {
  if (client === undefined) return;
  await client.send(new CreateTableCommand({
    TableName: tableName,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
  }));
  await waitUntilTableExists({ client, maxWaitTime: 20 }, { TableName: tableName });
});

afterAll(async () => {
  if (client === undefined) return;
  try { await client.send(new DeleteTableCommand({ TableName: tableName })); }
  finally { client.destroy(); }
});

async function seedOwner(personId: string) {
  if (documentClient === undefined) throw new Error("DynamoDB Local endpoint is required");
  const member = { entityType: "COMPANY_MEMBERSHIP", personId, companyId, role: "owner", joinedAt: "2026-11-19T12:00:00.000Z", joinedVia: "preapproval" };
  await documentClient.send(new PutCommand({ TableName: tableName, Item: { ...membershipKey(personId), ...member } }));
  await documentClient.send(new PutCommand({ TableName: tableName, Item: { pk: companyScoped(companyId, "MEMBERS"), sk: `MEMBER#${personId}`, ...member, entityType: "COMPANY_MEMBER_VIEW" } }));
}

it.skipIf(!endpointIsLoopback)("DynamoDB transaction permits only one of two concurrent owners to step down", async () => {
  if (documentClient === undefined) throw new Error("DynamoDB Local endpoint is required");
  const localDocumentClient = documentClient;
  const send = (command: unknown): Promise<unknown> => localDocumentClient.send(command as Parameters<typeof localDocumentClient.send>[0]);
  await seedOwner(ownerA);
  await seedOwner(ownerB);

  const pending: Array<() => void> = [];
  const gatedDocumentClient = {
    send(command: unknown): Promise<unknown> {
      if ((command as { constructor?: { name?: string } }).constructor?.name !== "TransactWriteCommand") return send(command);
      return new Promise((resolve, reject) => {
        pending.push(() => { void send(command).then(resolve, reject); });
        if (pending.length === 2) for (const execute of pending.splice(0)) execute();
      });
    },
  };
  const localStore = new CompanySignInStore({ documentClient: gatedDocumentClient, tableName, now: () => Date.parse("2026-11-19T12:00:00.000Z") });
  const outcomes = await Promise.allSettled([
    localStore.setRole(companyId, ownerA, "admin", ownerA),
    localStore.setRole(companyId, ownerB, "admin", ownerB),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled" && outcome.value === "changed")).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);

  const owners = await Promise.all([ownerA, ownerB].map(async (personId) => {
    const row = await documentClient.send(new GetCommand({ TableName: tableName, Key: membershipKey(personId), ConsistentRead: true }));
    return row.Item?.role === "owner" && row.Item?.revokedAt === undefined;
  }));
  expect(owners.filter(Boolean)).toHaveLength(1);
});
