import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { GetItemCommand, TransactWriteItemsCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { IndexDefinition } from "@agentx/contracts";
import { DynamoDocumentStore } from "../../packages/aws-adapters/src/dynamodb/document-store.js";
import { hostedAuthorityStore, hostedCreatorAuthority } from "../../packages/broker/src/aws/core-e2e-authority-store.js";
import { FakeDynamoDb } from "./ports/dynamodb-fake.js";
import { codeRetentionStore } from "../../packages/broker/src/core-host/retention.js";
import type { HostedCreatorAuthority } from "../../packages/broker/src/core/e2e/hosted-authority.js";

const companyId = "org_11111111111111111111";
export async function hostedE2EStoreFixture(indexes: readonly IndexDefinition[] = [], identity = { developerId: "maya", project: "payments" }) {
  const task = { companyId, ...identity };
  const state = new FakeDynamoDb({ tableName: "state" });
  const signin = new FakeDynamoDb({ tableName: "signin" });
  state.joinTransactions(signin);
  const documentClient = { send: async (command: unknown): Promise<unknown> => {
    if (command instanceof GetCommand) {
      const input = command.input;
      const result = await (input.TableName === "signin" ? signin : state).send(new GetItemCommand({ ...input, Key: marshall(input.Key!) })) as { Item?: Record<string, AttributeValue> };
      return result.Item === undefined ? {} : { Item: unmarshall(result.Item) };
    }
    if (!(command instanceof TransactWriteCommand)) throw new Error("unexpected command");
    return state.send(new TransactWriteItemsCommand({ ...command.input, TransactItems: command.input.TransactItems!.map((step) => Object.fromEntries(Object.entries(step).map(([kind, action]) => {
      if (action === undefined) throw new Error("empty transaction action");
      const raw = action as { Key?: Record<string, unknown>; Item?: Record<string, unknown>; ExpressionAttributeValues?: Record<string, unknown> };
      return [kind, { ...action, ...(raw.Key === undefined ? {} : { Key: marshall(raw.Key) }), ...(raw.Item === undefined ? {} : { Item: marshall(raw.Item) }),
        ...(raw.ExpressionAttributeValues === undefined ? {} : { ExpressionAttributeValues: marshall(raw.ExpressionAttributeValues) }) }];
    }))) }));
  } };
  const store = hostedAuthorityStore(codeRetentionStore(new DynamoDocumentStore({ client: state, tableName: "state", indexes })), { documentClient, stateTableName: "state", signInTableName: "signin" });
  const seedIdentity = (identity: { developerId: string; project: string }) => {
    Object.assign(task, identity);
    signin.seed(marshall({ pk: `DEVELOPER#${task.developerId}`, sk: "META", entityType: "DEVELOPER", revoked: false }));
    signin.seed(marshall({ pk: `COMPANY_MEMBER#${task.developerId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: task.developerId, companyId, role: "member", joinedAt: "2026-11-01T00:00:00.000Z" }));
    state.seed(marshall({ pk: `ORG#${companyId}#MEMBER#${task.developerId}`, sk: `PROJECT#${task.project}`, entityType: "MEMBERSHIP", companyId, projectName: task.project, ownerKey: task.developerId, role: "developer", grantId: "grant-1" }));
  };
  seedIdentity(identity);
  const creator = (): Promise<HostedCreatorAuthority | undefined> => hostedCreatorAuthority({ documentClient, stateTableName: "state", signInTableName: "signin", companyId }, task);
  return { state, signin, store, creator, documentClient, seedIdentity,
    revokeCreator: () => signin.seed(marshall({ pk: `DEVELOPER#${task.developerId}`, sk: "META", entityType: "DEVELOPER", revoked: true })) };
}
