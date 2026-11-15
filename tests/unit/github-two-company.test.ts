import { expect, it } from "vitest";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { GetItemCommand, PutItemCommand, QueryCommand as WireQueryCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { companyScoped } from "@agentx/contracts";
import { GithubInstallationBindings } from "../../packages/broker/src/aws/github-credentials.js";
import { listDueGithubWebhookDeliveries, reserveGithubWebhookDelivery } from "../../packages/broker/src/aws/github-webhooks.js";
import { assertSurfacesIsolated, COMPANY_A, COMPANY_B, type IsolationSurface } from "../../packages/testing/src/isolation/two-company.js";
import { STATE_TABLE_INDEXES } from "../../packages/aws-adapters/src/dynamodb/state-table.js";
import { dynamoWorld } from "../support/ports/dynamodb-harness.js";

/** Only document/wire value translation; the real SDK expressions reach the same
 * wire-level double used by DynamoDocumentStore. Unsupported commands refuse. */
function world() {
  const w = dynamoWorld({ indexes: STATE_TABLE_INDEXES });
  const client = { async send(command: unknown): Promise<unknown> {
    if (command instanceof GetCommand) {
      const response = await w.fake.send(new GetItemCommand({ ...command.input, Key: marshall(command.input.Key!) })) as { Item?: Parameters<typeof unmarshall>[0] };
      return response.Item === undefined ? {} : { Item: unmarshall(response.Item) };
    }
    if (command instanceof PutCommand) return w.fake.send(new PutItemCommand({ ...command.input, Item: marshall(command.input.Item!) }));
    if (command instanceof QueryCommand) {
      const response = await w.fake.send(new WireQueryCommand({ ...command.input, ExpressionAttributeValues: marshall(command.input.ExpressionAttributeValues!) })) as { Items?: Array<Parameters<typeof unmarshall>[0]>; LastEvaluatedKey?: Parameters<typeof unmarshall>[0] };
      return { Items: (response.Items ?? []).map(row => unmarshall(row)), ...(response.LastEvaluatedKey === undefined ? {} : { LastEvaluatedKey: unmarshall(response.LastEvaluatedKey) }) };
    }
    throw new Error("unsupported test command");
  } };
  return { ...w, client, bindings: new GithubInstallationBindings(client, "State") };
}
it("real adapters keep bindings and recovery partitions separate with shared raw repository/account names", async () => {
  const w = world();
  await w.bindings.backfill(async () => []);
  const id = (company: typeof COMPANY_A) => company.label === "A" ? 77 : 78;
  const binding: IsolationSurface = {
    name: "installation binding", kind: "read",
    async plant(company) { await w.bindings.claim(company.orgId, id(company), "shared-account", "operator"); },
    async observe(company) {
      return Promise.all([COMPANY_A, COMPANY_B].map(async target => {
        try { await w.bindings.requireBound(company.orgId, id(target)); return target.canary; }
        catch { return "not found"; }
      }));
    },
  };
  const recovery: IsolationSurface = {
    name: "recovery partition", kind: "list",
    async plant(company) {
      await reserveGithubWebhookDelivery({ documentClient: w.client, tableName: "State", companyId: company.orgId,
        now: "2026-11-14T00:00:00.000Z", deliveryId: `550e8400-e29b-41d4-a716-4466554400${id(company)}`, installationId: id(company), repositoryId: 42, eventHash: "a".repeat(64),
        event: { kind: "PR_COMMENT", action: "created", fullName: "shared/repository", number: 1, installationId: id(company), repositoryId: 42,
          comment: { id: 1, body: company.canary, truncated: false, url: "https://github.com/shared/repository/pull/1#issuecomment-1", author: "shared-person", source: "pr_discussion" } } });
    },
    async observe(company) {
      const rows = await listDueGithubWebhookDeliveries({ documentClient: w.client, tableName: "State", now: "2026-11-15T00:00:00.000Z", companyId: company.orgId });
      const index = await w.store.queryIndex({ index: "github-webhook-recovery", partition: companyScoped(company.orgId, "GITHUB_WEBHOOK_RECOVERY") });
      return { rows, index };
    },
  };
  await assertSurfacesIsolated([binding, recovery]);
});
it("scoped recovery reports the wire-level page boundary", async () => {
  const w = world();
  for (let n = 0; n < 26; n++) await reserveGithubWebhookDelivery({ documentClient: w.client, tableName: "State", companyId: COMPANY_A.orgId,
    now: "2026-11-14T00:00:00.000Z", deliveryId: `550e8400-e29b-41d4-a716-${String(n).padStart(12, "0")}`, installationId: 77, repositoryId: 42, eventHash: "a".repeat(64),
    event: { kind: "PULL_REQUEST", action: "opened", installationId: 77, repositoryId: 42, fullName: "shared/repository", number: 1 } });
  const rows = await listDueGithubWebhookDeliveries({ documentClient: w.client, tableName: "State", now: "2026-11-15T00:00:00.000Z", companyId: COMPANY_A.orgId });
  expect(rows).toHaveLength(25); expect(rows.more).toBe(true);
});
