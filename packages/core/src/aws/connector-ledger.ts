import { GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Invocation, Ledger } from "@agentx/gateway";

/** GitHub keeps its feature 007 key, so records written before and during the release stay one record. */
export const GITHUB_LEDGER = { prefix: "GITHUB_MCP#", entityType: "GITHUB_MCP_INVOCATION" } as const;

export function connectorLedgerKeys(connector: string): { prefix: string; entityType: string } {
  return { prefix: `CONNECTOR#${connector}#`, entityType: "CONNECTOR_INVOCATION" };
}

export class DynamoConnectorLedger implements Ledger {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly workspaceId: string,
    private readonly keys: { prefix: string; entityType: string },
    private readonly connector: string,
  ) {}

  async claim(record: Invocation): Promise<boolean> {
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: this.item(record),
        ConditionExpression: "attribute_not_exists(pk)",
      }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  async get(requestId: string): Promise<Invocation | undefined> {
    const response = await this.client.send(new GetCommand({ TableName: this.tableName, Key: this.key(requestId), ConsistentRead: true }));
    return response.Item as Invocation | undefined;
  }

  async finish(record: Invocation): Promise<void> {
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: this.item(record),
      ConditionExpression: "fingerprint = :fingerprint AND ownerKey = :owner AND #result.#status = :pending",
      ExpressionAttributeNames: { "#result": "result", "#status": "status" },
      ExpressionAttributeValues: { ":fingerprint": record.fingerprint, ":owner": record.ownerKey, ":pending": "IN_PROGRESS" },
    }));
  }

  private item(record: Invocation) {
    return { ...this.key(record.requestId), entityType: this.keys.entityType, connector: this.connector, ...record };
  }

  private key(requestId: string) {
    return { pk: `WORKSPACE#${this.workspaceId}`, sk: `${this.keys.prefix}${requestId}` };
  }
}
