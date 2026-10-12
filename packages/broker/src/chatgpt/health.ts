// Sign in with ChatGPT for `rovara doctor` (#343): the admin's settings, how many people are
// connected, and whether the control plane reaches OpenAI. Names and counts only, never a person or a token.
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { ChatGptHealth } from "@agentx/contracts";
import { CHATGPT_AUTHORIZE_URL, CHATGPT_RESOURCE } from "./oauth.js";
import { readChatGptSettings } from "./settings.js";

/**
 * One item per connection in one partition, so the count is a Query rather than a scan of the state table. Each item
 * follows its connection's status (connections.ts); a connection made before the index existed has none and is not counted.
 */
export const CHATGPT_CONNECTIONS_INDEX_PK = "CHATGPT_CONNECTIONS";

/** How many pages of the connection index one read counts; beyond it the count is a lower bound. */
const COUNT_PAGES_MAX = 10;
const REACH_TIMEOUT_MS = 5_000;

interface Table { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }

export async function chatGptHealth(deps: Table & { fetch: typeof fetch }): Promise<ChatGptHealth> {
  const [settings, count, auth, api] = await Promise.all([
    readChatGptSettings(deps),
    countConnected(deps),
    reaches(deps.fetch, new URL(CHATGPT_AUTHORIZE_URL).origin),
    reaches(deps.fetch, `${CHATGPT_RESOURCE}/models`),
  ]);
  return { enabled: settings.enabled, preferredModel: settings.preferredModel, connected: count.connected, connectedComplete: count.complete, reachable: { auth, api } };
}

async function countConnected(deps: Table): Promise<{ connected: number; complete: boolean }> {
  let connected = 0;
  let start: Record<string, unknown> | undefined;
  for (let page = 0; page < COUNT_PAGES_MAX; page += 1) {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", FilterExpression: "#status <> :revoked",
      ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":pk": CHATGPT_CONNECTIONS_INDEX_PK, ":revoked": "revoked" },
      // Only the key comes back; the count is of the items, so no developer ID leaves this function.
      ProjectionExpression: "sk", ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: unknown[]; LastEvaluatedKey?: Record<string, unknown> };
    connected += response.Items?.length ?? 0;
    start = response.LastEvaluatedKey;
    if (start === undefined) return { connected, complete: true };
  }
  return { connected, complete: false };
}

/** Any HTTP answer means the host is reachable (OpenAI's API answers 401 without a token); a failed request does not. */
async function reaches(fetchImplementation: typeof fetch, url: string): Promise<boolean> {
  try {
    await fetchImplementation(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(REACH_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}
