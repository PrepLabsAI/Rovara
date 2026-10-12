// Sign in with ChatGPT (#337, #338): each developer's connection to their own ChatGPT plan.
//
// Two records per developer in the state table, under pk CHATGPT#<developerId>:
//   PENDING     the one connection being started: the state's hash and the PKCE verifier (sealed),
//               replaced by every new start and deleted as it is used, so nothing piles up
//   CONNECTION  the connection: OpenAI's issued client ID, the refresh token and the current access
//               token (both sealed with the connection key), the email, the allowed models, a status
//               and a version that serializes refreshes
//
// Tokens are sealed with KMS under an encryption context naming the developer and the field, so a
// sealed value moved to another record or another field does not open. No token is ever returned to
// a developer: the developer API answers what is connected, and only a running task's own owner's
// short-lived access token leaves this module (accessToken, for #341).
import { createHash, timingSafeEqual } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DecryptCommand, EncryptCommand, type KMSClient } from "@aws-sdk/client-kms";
import {
  CHATGPT_CONNECT_STATE_SECONDS, CLI_COMMAND_NAME, ChatGptConnectFinishRequestSchema, agentXError, AgentXError,
  type ChatGptConnectionStatus, type ChatGptConnectionView, type ChatGptConnectStart,
} from "@agentx/contracts";
import { readChatGptSettings, type ChatGptSettings } from "./settings.js";
import { chatGptAuthorization, chatGptModels, exchangeChatGptCode, parseChatGptCallback, refreshChatGptTokens } from "./oauth.js";

/** How long before an access token's expiry it is refreshed: a request never starts with one about to expire. */
export const ACCESS_TOKEN_MARGIN_MS = 5 * 60_000;
/** How long one refresh may hold the record before another may take over. */
export const REFRESH_LOCK_MS = 30_000;
const REFRESH_WAIT_MS = 500;
const REFRESH_ATTEMPTS = 40;

export interface ChatGptSealer {
  seal(plain: string, context: Record<string, string>): Promise<string>;
  open(sealed: string, context: Record<string, string>): Promise<string>;
}

export function kmsChatGptSealer(client: Pick<KMSClient, "send">, keyId: string): ChatGptSealer {
  return {
    async seal(plain, context) {
      const sealed = await client.send(new EncryptCommand({ KeyId: keyId, Plaintext: Buffer.from(plain, "utf8"), EncryptionContext: context }));
      return Buffer.from(sealed.CiphertextBlob ?? new Uint8Array()).toString("base64");
    },
    async open(sealed, context) {
      const opened = await client.send(new DecryptCommand({ CiphertextBlob: Buffer.from(sealed, "base64"), EncryptionContext: context }));
      return Buffer.from(opened.Plaintext ?? new Uint8Array()).toString("utf8");
    },
  };
}

export interface ChatGptConnectionsDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  sealer: ChatGptSealer;
  fetch: typeof fetch;
  now: () => number;
  /** This install's stable `urn:uuid:` for OpenAI (chatGptHostId). */
  hostId: string;
  sleep?: (ms: number) => Promise<void>;
}

interface ConnectionRecord {
  pk: string; sk: "CONNECTION";
  developerId: string; clientId: string; sealedRefresh: string; sealedAccess: string; accessExpiresAt: number;
  email?: string; connectedAt: string; models: string[]; status: ChatGptConnectionStatus; version: number; refreshingUntil?: number;
}
interface PendingRecord { pk: string; sk: "PENDING"; stateHash: string; sealedVerifier: string; expiresAt: number }

export interface ChatGptAccessToken { access: string; expiresAt: number; models: string[] }

export interface ChatGptConnections {
  start(developerId: string): Promise<ChatGptConnectStart>;
  finish(developerId: string, request: unknown): Promise<ChatGptConnectionView>;
  view(developerId: string): Promise<ChatGptConnectionView>;
  disconnect(developerId: string): Promise<ChatGptConnectionView>;
  /** A running task's owner's current access token, refreshed when needed (#341). */
  accessToken(developerId: string): Promise<ChatGptAccessToken>;
  /** #343: the install's switch and preferred model. */
  settings(): Promise<ChatGptSettings>;
  /** Records what a task found (#342): the plan's limit, or a model list that changed. */
  markStatus(developerId: string, status: ChatGptConnectionStatus, models?: string[]): Promise<void>;
}

const pkOf = (developerId: string) => `CHATGPT#${developerId}`;
const hashOf = (value: string) => createHash("sha256").update(value).digest("hex");
const contextOf = (developerId: string, field: string) => ({ purpose: "chatgpt-connection", developerId, field });
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const conditionFailed = (error: unknown) => error instanceof Error && error.name === "ConditionalCheckFailedException";

function viewOf(record: ConnectionRecord | undefined): ChatGptConnectionView {
  if (record === undefined) return { connected: false };
  return { connected: record.status !== "revoked", status: record.status, ...(record.email === undefined ? {} : { email: record.email }), connectedAt: record.connectedAt, models: record.models };
}

export function chatGptConnections(deps: ChatGptConnectionsDependencies): ChatGptConnections {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const get = async <T>(developerId: string, sk: string): Promise<T | undefined> =>
    ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: pkOf(developerId), sk }, ConsistentRead: true }))) as { Item?: T }).Item;

  const connection = (developerId: string) => get<ConnectionRecord>(developerId, "CONNECTION");
  const settings = () => readChatGptSettings(deps);
  // #343: connecting needs the admin's switch on; with it off, existing connections are kept but unused.
  const requireEnabled = async () => {
    if (!(await settings()).enabled) throw agentXError("FORBIDDEN", `Sign in with ChatGPT is turned off in this Rovara; ask an admin to turn it on with: ${CLI_COMMAND_NAME} config set models.chatgpt.enabled true`);
  };

  return {
    settings,

    async start(developerId) {
      await requireEnabled();
      const authorization = chatGptAuthorization(deps.hostId);
      const expiresAt = deps.now() + CHATGPT_CONNECT_STATE_SECONDS * 1000;
      const pending: PendingRecord = {
        pk: pkOf(developerId), sk: "PENDING", stateHash: hashOf(authorization.state),
        sealedVerifier: await deps.sealer.seal(authorization.verifier, contextOf(developerId, "verifier")), expiresAt,
      };
      // Replaces any earlier start: only the newest address can finish.
      await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: pending }));
      return { authorizeUrl: authorization.url, expiresAt: new Date(expiresAt).toISOString() };
    },

    async finish(developerId, request) {
      await requireEnabled();
      const parsed = ChatGptConnectFinishRequestSchema.safeParse(request);
      if (!parsed.success) throw agentXError("CONFIG_INVALID", "send the address the browser ended on, or the code, state and client ID");
      const callback = "callbackUrl" in parsed.data ? parseChatGptCallback(parsed.data.callbackUrl) : parsed.data;
      const pending = await get<PendingRecord>(developerId, "PENDING");
      if (pending === undefined || !sameHash(pending.stateHash, hashOf(callback.state))) {
        throw agentXError("CONFIG_INVALID", "this sign-in was not started by you, or a newer one replaced it; start connecting ChatGPT again");
      }
      // Used once, whatever happens next.
      try {
        await deps.documentClient.send(new DeleteCommand({
          TableName: deps.tableName, Key: { pk: pkOf(developerId), sk: "PENDING" },
          ConditionExpression: "stateHash = :hash", ExpressionAttributeValues: { ":hash": pending.stateHash },
        }));
      } catch (error) {
        if (conditionFailed(error)) throw agentXError("CONFIG_INVALID", "this sign-in was already used; start connecting ChatGPT again");
        throw error;
      }
      if (pending.expiresAt <= deps.now()) throw agentXError("CONFIG_INVALID", "this sign-in has expired; start connecting ChatGPT again");
      const verifier = await deps.sealer.open(pending.sealedVerifier, contextOf(developerId, "verifier"));
      const tokens = await exchangeChatGptCode({ fetch: deps.fetch, now: deps.now(), code: callback.code, verifier, clientId: callback.clientId }).catch((error: unknown) => {
        // OpenAI refusing the code is not the caller's Rovara sign-in ending: answering 401 would
        // tell the CLI to sign in to Rovara again.
        if (error instanceof AgentXError && error.code === "AUTH_REQUIRED") {
          throw agentXError("CONFIG_INVALID", `${error.message.slice(error.code.length + 2)}; start connecting ChatGPT again`);
        }
        throw error;
      });
      // The eligibility check: a plan Rovara may not use refuses this, and nothing is kept.
      const models = await chatGptModels({ fetch: deps.fetch, access: tokens.access });
      const record: ConnectionRecord = {
        pk: pkOf(developerId), sk: "CONNECTION", developerId, clientId: callback.clientId,
        sealedRefresh: await deps.sealer.seal(tokens.refresh, contextOf(developerId, "refresh")),
        sealedAccess: await deps.sealer.seal(tokens.access, contextOf(developerId, "access")),
        accessExpiresAt: tokens.expiresAt, ...(tokens.email === undefined ? {} : { email: tokens.email }),
        connectedAt: new Date(deps.now()).toISOString(), models, status: "connected", version: 1,
      };
      await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: record }));
      return viewOf(record);
    },

    async view(developerId) {
      return viewOf(await connection(developerId));
    },

    async disconnect(developerId) {
      await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: pkOf(developerId), sk: "CONNECTION" } }));
      await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: pkOf(developerId), sk: "PENDING" } }));
      return { connected: false };
    },

    async accessToken(developerId) {
      for (let attempt = 0; attempt < REFRESH_ATTEMPTS; attempt += 1) {
        const record = await connection(developerId);
        if (record === undefined) throw agentXError("NOT_FOUND", "this developer has not connected ChatGPT");
        if (record.status === "revoked") throw agentXError("AUTH_REQUIRED", "the ChatGPT connection was revoked; connect ChatGPT again");
        if (record.accessExpiresAt - ACCESS_TOKEN_MARGIN_MS > deps.now()) {
          return { access: await deps.sealer.open(record.sealedAccess, contextOf(developerId, "access")), expiresAt: record.accessExpiresAt, models: record.models };
        }
        // One refresh at a time: OpenAI rotates the refresh token, so two at once would lose one.
        try {
          await deps.documentClient.send(new UpdateCommand({
            TableName: deps.tableName, Key: { pk: record.pk, sk: "CONNECTION" },
            UpdateExpression: "SET refreshingUntil = :until",
            ConditionExpression: "version = :version AND (attribute_not_exists(refreshingUntil) OR refreshingUntil < :now)",
            ExpressionAttributeValues: { ":until": deps.now() + REFRESH_LOCK_MS, ":version": record.version, ":now": deps.now() },
          }));
        } catch (error) {
          if (!conditionFailed(error)) throw error;
          // Another refresh is running, or just finished: read again.
          await sleep(REFRESH_WAIT_MS);
          continue;
        }
        let tokens;
        try {
          tokens = await refreshChatGptTokens({
            fetch: deps.fetch, now: deps.now(), clientId: record.clientId,
            refresh: await deps.sealer.open(record.sealedRefresh, contextOf(developerId, "refresh")),
          });
        } catch (error) {
          const revoked = error instanceof AgentXError && error.code === "AUTH_REQUIRED";
          await deps.documentClient.send(new UpdateCommand({
            TableName: deps.tableName, Key: { pk: record.pk, sk: "CONNECTION" },
            UpdateExpression: revoked ? "SET #status = :revoked REMOVE refreshingUntil" : "REMOVE refreshingUntil",
            ...(revoked ? { ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":revoked": "revoked" } } : {}),
          }));
          if (revoked) throw agentXError("AUTH_REQUIRED", "the ChatGPT connection was revoked or expired; connect ChatGPT again");
          throw error;
        }
        await deps.documentClient.send(new UpdateCommand({
          TableName: deps.tableName, Key: { pk: record.pk, sk: "CONNECTION" },
          UpdateExpression: "SET sealedRefresh = :refresh, sealedAccess = :access, accessExpiresAt = :expires, version = :next REMOVE refreshingUntil",
          ConditionExpression: "version = :version",
          ExpressionAttributeValues: {
            ":refresh": await deps.sealer.seal(tokens.refresh, contextOf(developerId, "refresh")),
            ":access": await deps.sealer.seal(tokens.access, contextOf(developerId, "access")),
            ":expires": tokens.expiresAt, ":next": record.version + 1, ":version": record.version,
          },
        }));
        return { access: tokens.access, expiresAt: tokens.expiresAt, models: record.models };
      }
      throw agentXError("RUNTIME_UNAVAILABLE", "the ChatGPT token refresh is busy; try again in a moment");
    },

    async markStatus(developerId, status, models) {
      try {
        await deps.documentClient.send(new UpdateCommand({
          TableName: deps.tableName, Key: { pk: pkOf(developerId), sk: "CONNECTION" },
          UpdateExpression: `SET #status = :status${models === undefined ? "" : ", models = :models"}`,
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":status": status, ...(models === undefined ? {} : { ":models": models }) },
        }));
      } catch (error) {
        // Disconnected meanwhile: nothing to mark.
        if (!conditionFailed(error)) throw error;
      }
    },
  };
}
