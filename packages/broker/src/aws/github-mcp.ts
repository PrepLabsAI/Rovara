import { GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { GitHubMcpInvocation, GitHubMcpStore } from "../github-mcp.js";

export class DynamoGitHubMcpStore implements GitHubMcpStore {
  constructor(private readonly client: DynamoDBDocumentClient, private readonly tableName: string, private readonly workspaceId: string) {}

  async claim(record: GitHubMcpInvocation): Promise<boolean> {
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: { ...this.key(record.requestId), entityType: "GITHUB_MCP_INVOCATION", ...record },
        ConditionExpression: "attribute_not_exists(pk)",
      }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  async get(requestId: string): Promise<GitHubMcpInvocation | undefined> {
    const response = await this.client.send(new GetCommand({ TableName: this.tableName, Key: this.key(requestId), ConsistentRead: true }));
    return response.Item as GitHubMcpInvocation | undefined;
  }

  async finish(record: GitHubMcpInvocation): Promise<void> {
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: { ...this.key(record.requestId), entityType: "GITHUB_MCP_INVOCATION", ...record },
      ConditionExpression: "fingerprint = :fingerprint AND ownerKey = :owner AND #result.#status = :pending",
      ExpressionAttributeNames: { "#result": "result", "#status": "status" },
      ExpressionAttributeValues: { ":fingerprint": record.fingerprint, ":owner": record.ownerKey, ":pending": "IN_PROGRESS" },
    }));
  }

  private key(requestId: string) { return { pk: `WORKSPACE#${this.workspaceId}`, sk: `GITHUB_MCP#${requestId}` }; }
}
