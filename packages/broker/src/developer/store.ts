// packages/broker/src/developer/store.ts
// The DeveloperSignIn table (spec 025 FR-005, FR-008). Codes and refresh tokens are stored only as
// SHA-256 hashes. Every expiry is checked here; the table's TTL only cleans up afterwards.
import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  DEVELOPER_AUTH_REQUEST_SECONDS,
  DEVELOPER_CODE_SECONDS,
  DEVELOPER_SESSION_SECONDS,
  type DeveloperSignInMethod,
} from "@agentx/contracts";
import { pkceChallengeMatches, randomToken, sha256Hex } from "./tokens.js";

export interface AuthRequestRecord { id: string; clientRedirectUri: string; clientState: string; codeChallenge: string; nonce: string; method?: DeveloperSignInMethod; consumedAt?: string; expiresAt: number }
export interface DeveloperRecord { developerId: string; provider: DeveloperSignInMethod; issuer: string; subject: string; displayName: string; email?: string; slackUserId?: string; firstSignInAt: string; lastSignInAt: string; revoked: boolean }
export interface SessionRecord { sessionId: string; developerId: string; amr: DeveloperSignInMethod; slackUserId?: string; startedAt: string; endsAt: number; lastRefreshAt?: string; revokedAt?: string; revokedReason?: string }
export type RefreshLookup =
  | { kind: "active"; session: SessionRecord; tokenHash: string }
  | { kind: "unknown" }
  | { kind: "reused"; sessionId: string }
  | { kind: "ended"; session: SessionRecord };

interface CodeRecord { developerId: string; amr: DeveloperSignInMethod; slackUserId?: string; codeChallenge: string; redirectUri: string; expiresAt: number; usedAt?: string }
interface RefreshRecord { sessionId: string; expiresAt: number; usedAt?: string }

const META = "META";
const conditionFailed = (error: unknown) =>
  error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");

export class DeveloperSignInStore {
  constructor(private readonly input: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number }) {}

  private seconds(): number { return Math.floor(this.input.now() / 1000); }
  private iso(): string { return new Date(this.input.now()).toISOString(); }

  private async get<T>(pk: string): Promise<(T & { pk: string; sk: string }) | undefined> {
    const response = await this.input.documentClient.send(new GetCommand({ TableName: this.input.tableName, Key: { pk, sk: META }, ConsistentRead: true })) as { Item?: T & { pk: string; sk: string } };
    return response.Item;
  }

  private async put(item: Record<string, unknown>, condition?: string): Promise<void> {
    await this.input.documentClient.send(new PutCommand({ TableName: this.input.tableName, Item: item, ...(condition === undefined ? {} : { ConditionExpression: condition }) }));
  }

  async createAuthRequest(input: Omit<AuthRequestRecord, "id" | "expiresAt" | "method" | "consumedAt">): Promise<AuthRequestRecord> {
    const record: AuthRequestRecord = { ...input, id: randomToken(""), expiresAt: this.seconds() + DEVELOPER_AUTH_REQUEST_SECONDS };
    await this.put({ pk: `AUTHREQ#${record.id}`, sk: META, entityType: "AUTH_REQUEST", ...record }, "attribute_not_exists(pk)");
    return record;
  }

  async getAuthRequest(id: string): Promise<AuthRequestRecord | undefined> {
    const item = await this.get<AuthRequestRecord>(`AUTHREQ#${id}`);
    return item === undefined || item.expiresAt <= this.seconds() ? undefined : strip(item);
  }

  async chooseMethod(id: string, method: DeveloperSignInMethod): Promise<AuthRequestRecord | undefined> {
    try {
      await this.input.documentClient.send(new UpdateCommand({
        TableName: this.input.tableName,
        Key: { pk: `AUTHREQ#${id}`, sk: META },
        UpdateExpression: "SET #method = :method",
        ConditionExpression: "attribute_exists(pk) AND expiresAt > :now AND attribute_not_exists(consumedAt)",
        ExpressionAttributeNames: { "#method": "method" },
        ExpressionAttributeValues: { ":method": method, ":now": this.seconds() },
      }));
    } catch (error) {
      if (conditionFailed(error)) return undefined;
      throw error;
    }
    return this.getAuthRequest(id);
  }

  async consumeAuthRequest(id: string, method: DeveloperSignInMethod): Promise<AuthRequestRecord | undefined> {
    try {
      await this.input.documentClient.send(new UpdateCommand({
        TableName: this.input.tableName,
        Key: { pk: `AUTHREQ#${id}`, sk: META },
        UpdateExpression: "SET consumedAt = :at",
        ConditionExpression: "attribute_exists(pk) AND expiresAt > :now AND attribute_not_exists(consumedAt) AND #method = :method",
        ExpressionAttributeNames: { "#method": "method" },
        ExpressionAttributeValues: { ":at": this.iso(), ":now": this.seconds(), ":method": method },
      }));
    } catch (error) {
      if (conditionFailed(error)) return undefined;
      throw error;
    }
    const item = await this.get<AuthRequestRecord>(`AUTHREQ#${id}`);
    return item === undefined ? undefined : strip(item);
  }

  async upsertDeveloper(profile: Omit<DeveloperRecord, "firstSignInAt" | "lastSignInAt" | "revoked">): Promise<DeveloperRecord> {
    const existing = await this.getDeveloper(profile.developerId);
    const at = this.iso();
    const record: DeveloperRecord = {
      developerId: profile.developerId,
      provider: profile.provider,
      issuer: profile.issuer,
      subject: profile.subject,
      displayName: profile.displayName,
      ...(profile.email === undefined ? {} : { email: profile.email }),
      ...(profile.slackUserId === undefined ? {} : { slackUserId: profile.slackUserId }),
      firstSignInAt: existing?.firstSignInAt ?? at,
      lastSignInAt: at,
      revoked: existing?.revoked ?? false,
    };
    await this.put({ pk: `DEVELOPER#${record.developerId}`, sk: META, entityType: "DEVELOPER", ...record });
    return record;
  }

  async getDeveloper(developerId: string): Promise<DeveloperRecord | undefined> {
    const item = await this.get<DeveloperRecord>(`DEVELOPER#${developerId}`);
    return item === undefined ? undefined : strip(item);
  }

  async issueCode(input: { developerId: string; amr: DeveloperSignInMethod; slackUserId?: string; codeChallenge: string; redirectUri: string }): Promise<string> {
    const code = randomToken("agxc_");
    const record: CodeRecord = { ...input, expiresAt: this.seconds() + DEVELOPER_CODE_SECONDS };
    await this.put({ pk: `CODE#${sha256Hex(code)}`, sk: META, entityType: "AUTH_CODE", ...record }, "attribute_not_exists(pk)");
    return code;
  }

  async redeemCode(input: { code: string; verifier: string; redirectUri: string }): Promise<{ developerId: string; amr: DeveloperSignInMethod; slackUserId?: string } | undefined> {
    const pk = `CODE#${sha256Hex(input.code)}`;
    try {
      // Burned first, whatever the verifier: a code is tried once.
      await this.input.documentClient.send(new UpdateCommand({
        TableName: this.input.tableName,
        Key: { pk, sk: META },
        UpdateExpression: "SET usedAt = :at",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(usedAt) AND expiresAt > :now",
        ExpressionAttributeValues: { ":at": this.iso(), ":now": this.seconds() },
      }));
    } catch (error) {
      if (conditionFailed(error)) return undefined;
      throw error;
    }
    const record = await this.get<CodeRecord>(pk);
    if (record === undefined || record.redirectUri !== input.redirectUri || !pkceChallengeMatches(input.verifier, record.codeChallenge)) return undefined;
    return { developerId: record.developerId, amr: record.amr, ...(record.slackUserId === undefined ? {} : { slackUserId: record.slackUserId }) };
  }

  async createSession(input: { developerId: string; amr: DeveloperSignInMethod; slackUserId?: string }): Promise<{ session: SessionRecord; refreshToken: string }> {
    const session: SessionRecord = { ...input, sessionId: randomUUID(), startedAt: this.iso(), endsAt: this.seconds() + DEVELOPER_SESSION_SECONDS };
    const refreshToken = randomToken("agxr_");
    await this.input.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: this.input.tableName, Item: { pk: `SESSION#${session.sessionId}`, sk: META, entityType: "SESSION", ...session, expiresAt: session.endsAt + 86_400 }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: this.input.tableName, Item: { pk: `REFRESH#${sha256Hex(refreshToken)}`, sk: META, entityType: "REFRESH_TOKEN", sessionId: session.sessionId, expiresAt: session.endsAt }, ConditionExpression: "attribute_not_exists(pk)" } },
      ],
    }));
    return { session, refreshToken };
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const item = await this.get<SessionRecord & { expiresAt?: number }>(`SESSION#${sessionId}`);
    if (item === undefined) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
    const { expiresAt: _ttl, ...session } = strip(item);
    return session;
  }

  async lookupRefresh(refreshToken: string): Promise<RefreshLookup> {
    const tokenHash = sha256Hex(refreshToken);
    const record = await this.get<RefreshRecord>(`REFRESH#${tokenHash}`);
    if (record === undefined) return { kind: "unknown" };
    if (record.usedAt !== undefined) return { kind: "reused", sessionId: record.sessionId };
    const session = await this.getSession(record.sessionId);
    if (session === undefined) return { kind: "unknown" };
    if (session.revokedAt !== undefined || session.endsAt <= this.seconds()) return { kind: "ended", session };
    return { kind: "active", session, tokenHash };
  }

  async rotateRefresh(input: { session: SessionRecord; tokenHash: string }): Promise<{ refreshToken: string } | { reused: true }> {
    const refreshToken = randomToken("agxr_");
    const at = this.iso();
    try {
      await this.input.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          { Update: { TableName: this.input.tableName, Key: { pk: `REFRESH#${input.tokenHash}`, sk: META }, UpdateExpression: "SET usedAt = :at", ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(usedAt)", ExpressionAttributeValues: { ":at": at } } },
          { Put: { TableName: this.input.tableName, Item: { pk: `REFRESH#${sha256Hex(refreshToken)}`, sk: META, entityType: "REFRESH_TOKEN", sessionId: input.session.sessionId, expiresAt: input.session.endsAt }, ConditionExpression: "attribute_not_exists(pk)" } },
          { Update: { TableName: this.input.tableName, Key: { pk: `SESSION#${input.session.sessionId}`, sk: META }, UpdateExpression: "SET lastRefreshAt = :at", ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(revokedAt)", ExpressionAttributeValues: { ":at": at } } },
        ],
      }));
    } catch (error) {
      if (conditionFailed(error)) return { reused: true };
      throw error;
    }
    return { refreshToken };
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.input.documentClient.send(new UpdateCommand({
      TableName: this.input.tableName,
      Key: { pk: `SESSION#${sessionId}`, sk: META },
      UpdateExpression: "SET revokedAt = if_not_exists(revokedAt, :at), revokedReason = if_not_exists(revokedReason, :reason)",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":at": this.iso(), ":reason": reason },
    })).catch((error: unknown) => {
      if (!conditionFailed(error)) throw error;
    });
  }
}

function strip<T extends { pk: string; sk: string }>(item: T): Omit<T, "pk" | "sk" | "entityType"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the keys
  const { pk: _pk, sk: _sk, entityType: _type, ...rest } = item as T & { entityType?: string };
  return rest;
}
