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
  | { kind: "recently_rotated"; session: SessionRecord; tokenHash: string }
  | { kind: "ended"; session: SessionRecord };

/** Auth0-style reuse interval (rulings.md, Task 4 fix round 1, F2): a refresh token presented again
 * within this many seconds of its own rotation is not treated as theft, so a lost response or a
 * stale-lock race between two local processes does not sign the person out. */
export const REFRESH_REUSE_GRACE_SECONDS = 60;

interface CodeRecord { developerId: string; amr: DeveloperSignInMethod; slackUserId?: string; codeChallenge: string; redirectUri: string; expiresAt: number; usedAt?: string }
interface RefreshRecord { sessionId: string; expiresAt: number; usedAt?: string; graceUsedAt?: string }
interface CancellationReason { Code?: string }

export const META = "META";
const conditionFailed = (error: unknown) =>
  error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");

/** Real DynamoDB always populates this on a cancelled TransactWriteItems, one entry per
 * TransactItem, ordered the same way, "None" for items not implicated (fix round 2, F4: FakeDynamoDb
 * now models this too, so there is no other case to fall back to). */
function cancellationReasons(error: unknown): CancellationReason[] | undefined {
  const reasons = (error as { CancellationReasons?: unknown } | null)?.CancellationReasons;
  return Array.isArray(reasons) ? (reasons as CancellationReason[]) : undefined;
}

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
    // One atomic update, not a read-then-overwrite: a concurrent revocation (or another sign-in)
    // must never be clobbered by this call. firstSignInAt and revoked are set only if absent;
    // revoked in particular must never flip true back to false (fix round 1, F3).
    const at = this.iso();
    const setClauses = [
      "entityType = :entityType",
      "provider = :provider",
      "issuer = :issuer",
      "subject = :subject",
      "displayName = :displayName",
      "lastSignInAt = :at",
      "firstSignInAt = if_not_exists(firstSignInAt, :at)",
      "revoked = if_not_exists(revoked, :false)",
    ];
    const removeClauses: string[] = [];
    const values: Record<string, unknown> = {
      ":entityType": "DEVELOPER",
      ":provider": profile.provider,
      ":issuer": profile.issuer,
      ":subject": profile.subject,
      ":displayName": profile.displayName,
      ":at": at,
      ":false": false,
    };
    if (profile.email === undefined) removeClauses.push("email");
    else { setClauses.push("email = :email"); values[":email"] = profile.email; }
    if (profile.slackUserId === undefined) removeClauses.push("slackUserId");
    else { setClauses.push("slackUserId = :slackUserId"); values[":slackUserId"] = profile.slackUserId; }

    await this.input.documentClient.send(new UpdateCommand({
      TableName: this.input.tableName,
      Key: { pk: `DEVELOPER#${profile.developerId}`, sk: META },
      UpdateExpression: `SET ${setClauses.join(", ")}${removeClauses.length > 0 ? ` REMOVE ${removeClauses.join(", ")}` : ""}`,
      ExpressionAttributeValues: values,
    }));
    const stored = await this.getDeveloper(profile.developerId);
    if (stored === undefined) throw new Error("developer upsert did not persist");
    return stored;
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
    if (record.usedAt !== undefined) {
      // Fix round 1, F2 (owner ruling): inside the grace window, and only for a session that is
      // still healthy, a repeat presentation gets a fresh successor instead of being treated as
      // theft. Past the window, or against a dead session, it's reused exactly as before. Strict
      // comparison (fix round 2, F5), matching the mint condition's strict `usedAt > :cutoff`: the
      // boundary itself (exactly REFRESH_REUSE_GRACE_SECONDS elapsed) is outside the window.
      const withinGrace = this.input.now() - Date.parse(record.usedAt) < REFRESH_REUSE_GRACE_SECONDS * 1000;
      if (withinGrace) {
        const session = await this.getSession(record.sessionId);
        if (session !== undefined && session.revokedAt === undefined && session.endsAt > this.seconds()) {
          return { kind: "recently_rotated", session, tokenHash };
        }
      }
      return { kind: "reused", sessionId: record.sessionId };
    }
    const session = await this.getSession(record.sessionId);
    if (session === undefined) return { kind: "unknown" };
    if (session.revokedAt !== undefined || session.endsAt <= this.seconds()) return { kind: "ended", session };
    return { kind: "active", session, tokenHash };
  }

  async rotateRefresh(input: { session: SessionRecord; tokenHash: string }): Promise<{ refreshToken: string } | { reused: true } | { ended: true }> {
    const refreshToken = randomToken("agxr_");
    const at = this.iso();
    try {
      await this.input.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          { Update: { TableName: this.input.tableName, Key: { pk: `REFRESH#${input.tokenHash}`, sk: META }, UpdateExpression: "SET usedAt = :at", ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(usedAt)", ExpressionAttributeValues: { ":at": at } } },
          { Put: { TableName: this.input.tableName, Item: { pk: `REFRESH#${sha256Hex(refreshToken)}`, sk: META, entityType: "REFRESH_TOKEN", sessionId: input.session.sessionId, expiresAt: input.session.endsAt }, ConditionExpression: "attribute_not_exists(pk)" } },
          { Update: { TableName: this.input.tableName, Key: { pk: `SESSION#${input.session.sessionId}`, sk: META }, UpdateExpression: "SET lastRefreshAt = :at", ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(revokedAt) AND endsAt > :now", ExpressionAttributeValues: { ":at": at, ":now": this.seconds() } } },
        ],
      }));
    } catch (error) {
      const classification = this.classifyRotationFailure(error);
      // Fix round 2, F2: the real two-process race. Both processes see `active` and both call
      // rotateRefresh with the same old token; the loser's old-token condition fails here. Rather
      // than reporting that as reuse (which would make Task 6 revoke a perfectly healthy session),
      // attempt the same grace mint rotateRecentlyUsed uses. Its own atomic condition (window, one
      // mint per old token, session health) decides the real answer, so a genuine replay outside
      // the window or past the cap still ends up `reused`.
      if (!("reused" in classification)) return classification; // { ended: true }
      return this.mintGraceSuccessor(input.tokenHash, input.session);
    }
    return { refreshToken };
  }

  /** Fix round 1, F2 (owner ruling); fix round 2, F1 and F3: mints a fresh successor for a token
   * already used within REFRESH_REUSE_GRACE_SECONDS, atomically re-checking that window, the
   * one-grace-mint-per-old-token cap, and the session's health, so a caller can't be tricked by a
   * stale lookup. Covers a lost response and a stale-lock race between two local processes
   * refreshing at once, without weakening reuse detection past the window or the cap. */
  async rotateRecentlyUsed(input: { session: SessionRecord; tokenHash: string }): Promise<{ refreshToken: string } | { reused: true }> {
    const result = await this.mintGraceSuccessor(input.tokenHash, input.session);
    // This method's signature predates the reused/ended split classifyRotationFailure makes for
    // rotateRefresh; a dead session here still means "no grace, fall through to reused handling".
    return "ended" in result ? { reused: true } : result;
  }

  /** Fix round 2, F2 and F3: one atomic transaction shared by rotateRefresh's internal fallback and
   * rotateRecentlyUsed. Stamps the old token with `graceUsedAt` (condition: not already stamped, its
   * `usedAt` within the window) so at most one grace successor can ever come from a given old token
   * (the security ruling's "two lineages" cap) -- a second grace presentation, or one past the
   * window, is `reused` just like an ordinary replay. The first successor (from the original
   * rotation) is never touched or invalidated by this. */
  private async mintGraceSuccessor(oldTokenHash: string, session: SessionRecord): Promise<{ refreshToken: string } | { reused: true } | { ended: true }> {
    const refreshToken = randomToken("agxr_");
    const at = this.iso();
    const cutoff = new Date(this.input.now() - REFRESH_REUSE_GRACE_SECONDS * 1000).toISOString();
    try {
      await this.input.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          { Update: { TableName: this.input.tableName, Key: { pk: `REFRESH#${oldTokenHash}`, sk: META }, UpdateExpression: "SET graceUsedAt = :at", ConditionExpression: "attribute_exists(pk) AND attribute_exists(usedAt) AND usedAt > :cutoff AND attribute_not_exists(graceUsedAt)", ExpressionAttributeValues: { ":at": at, ":cutoff": cutoff } } },
          { Put: { TableName: this.input.tableName, Item: { pk: `REFRESH#${sha256Hex(refreshToken)}`, sk: META, entityType: "REFRESH_TOKEN", sessionId: session.sessionId, expiresAt: session.endsAt }, ConditionExpression: "attribute_not_exists(pk)" } },
          { Update: { TableName: this.input.tableName, Key: { pk: `SESSION#${session.sessionId}`, sk: META }, UpdateExpression: "SET lastRefreshAt = :at", ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(revokedAt) AND endsAt > :now", ExpressionAttributeValues: { ":at": at, ":now": this.seconds() } } },
        ],
      }));
    } catch (error) {
      return this.classifyRotationFailure(error);
    }
    return { refreshToken };
  }

  /** Fix round 2, F4: a cancelled transaction must be read for which item's condition actually
   * failed. ConditionalCheckFailed on index 0 (the old token's check, in both rotateRefresh's own
   * transaction and mintGraceSuccessor's) means reused; on index 2 (the session's check), ended.
   * Anything else (TransactionConflict, throttling, ...) is transient and gets rethrown so the
   * caller can retry, instead of being folded into "reused" and signing the person out. Real
   * DynamoDB always includes CancellationReasons on a cancelled transaction, and FakeDynamoDb now
   * models that too, so a missing array only means a genuinely unmodeled failure -- treated as
   * transient, not reused. */
  private classifyRotationFailure(error: unknown): { reused: true } | { ended: true } {
    if (!conditionFailed(error)) throw error;
    const reasons = cancellationReasons(error);
    if (reasons === undefined) throw error;
    if (reasons[0]?.Code === "ConditionalCheckFailed") return { reused: true };
    if (reasons[2]?.Code === "ConditionalCheckFailed") return { ended: true };
    throw error;
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
