// packages/broker/src/developer/store.ts
// The DeveloperSignIn table (spec 025 FR-005, FR-008). Codes and refresh tokens are stored only as
// SHA-256 hashes. Every expiry is checked here; the table's TTL only cleans up afterwards.
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import {
  DEVELOPER_AUTH_REQUEST_SECONDS,
  DEVELOPER_CODE_SECONDS,
  DEVELOPER_SESSION_SECONDS,
  IMPLICIT_COMPANY_ID, OrgIdSchema, companyScoped,
  SIGN_IN_CLIENTS_PK,
  agentXError,
  SignInClientRecordSchema,
  signInClientKey,
  type DeveloperSignInMethod,
  type SignInClientRecord,
  SignInClientIdSchema,
} from "@agentx/contracts";
import { pkceChallengeMatches, randomToken, sha256Hex } from "./tokens.js";

/** `clientId` (spec 063): the registered sign-in client this request is for; absent, the AgentX CLI. */
/** `scopes` (spec 065): what the client asked for at sign-in that its registration allows. */
export interface AuthRequestRecord { id: string; clientRedirectUri: string; clientState: string; codeChallenge: string; nonce: string; method?: DeveloperSignInMethod; consumedAt?: string; expiresAt: number; browserReturnTo?: string; clientId?: string; scopes?: string[]; companyId?: string;
  /** DEC 254h: the SHA-256 of the invite link secret this sign-in carries (`invite=`, with `company=`). The secret itself is never stored. */
  inviteHash?: string }
export interface DeveloperRecord { developerId: string; provider: DeveloperSignInMethod; issuer: string; subject: string; displayName: string;
  /** True once the person chose their own name (`PUT /v1/dev/me/name`); a sign-in then leaves `displayName` alone. Absent: the provider's name. */
  displayNameChosen?: boolean;
  email?: string; slackUserId?: string; /** DEC 254w: a connected install-workspace Slack user (kept by every sign-in), and on a connected sign-in's own record the person it signs in as. */ linkedSlackUserId?: string; mergedInto?: string;
  /** DEC 254zzz33 (4): on a connected sign-in's own record that was unlinked (kept, never deleted): when, and from which person. DEC 254zzz39: and that person's company (the only one
   * it may be linked into again). All three go when it is linked again. */
  unlinkedAt?: string; unlinkedFrom?: string; unlinkedCompany?: string;
  /** DEC 253z: a sign-in with no company (never a legacy seat in the built-in company); also every kept unlinked record (DEC 254zzz33). */
  companyless?: boolean;
  /** DEC 254e: the Slack workspace (id, and its name when Slack gives one) of a Slack sign-in with Code's company layer on. Never a company. */
  slackTeamId?: string; slackTeamName?: string;
  firstSignInAt: string; lastSignInAt: string; revoked: boolean; sessionsEndedAt?: string }
/** Spec 063: `clientId`, the registered client it belongs to (absent: the CLI or a review page); `administrator`, its
 * company sign-in carried the administrator claim (FR-005). */
export interface SessionRecord { signedInId?: string; sessionId: string; developerId: string; amr: DeveloperSignInMethod; slackUserId?: string; startedAt: string; endsAt: number; reviewExpiresAt?: number; lastRefreshAt?: string; revokedAt?: string; revokedReason?: string; clientId?: string; administrator?: true; scopes?: string[]; companyId?: string; installMethod?: true; joinedByInvite?: true }

/**
 * What a code carries into its session.
 * DEC 254b (a): `installMethod` marks a session bound to a company other than the built-in one that was signed in through the install's own OIDC
 * (the shared sign-in method), because that company has no sign-in of its own. Written only by the sign-in server; every mint, refresh and broker
 * check refuses it once the company has its own issuer, and refuses an unmarked session for a company that has none.
 * DEC 254b (f): `joinedByInvite` is set only by the sign-in server, when this sign-in's own join consumed a live pre-approval for the session's company.
 */
/**
 * Whether a refresh token for this session may be exchanged by this client. Never for a browser sign-in session (it has reviewExpiresAt: the cookie is its
 * whole credential and it has no refresh token to give). Spec 063: and only by the client the session was issued to, not across a removal and re-registration.
 */
export const refreshableBy = (session: SessionRecord, clientId: string | undefined): boolean => session.reviewExpiresAt === undefined && session.clientId === clientId;
export interface CodeGrant { /** DEC 254w: the identity that signed in when it is not `developerId` (seated as its person); each redeem and refresh walks it again. */ signedInId?: string; developerId: string; amr: DeveloperSignInMethod; slackUserId?: string; clientId?: string; administrator?: true; scopes?: string[]; companyId?: string; installMethod?: true; joinedByInvite?: true }


/** A method's enabled-since cutoff from its environment variable, epoch seconds; "0", empty or unreadable means none. */
export function methodSince(text: string | undefined): number | undefined {
  if (text === undefined || !/^[0-9]{1,12}$/.test(text)) return undefined;
  const since = Number(text);
  return since > 0 ? since : undefined;
}

/** Whether a session started before its method was last turned on (FR-045): its disable ended it. */
export function startedBeforeMethodOn(startedAt: string, since: number | undefined): boolean {
  if (since === undefined || since <= 0) return false;
  const started = Date.parse(startedAt);
  return !Number.isFinite(started) || started < since * 1000;
}
/** E9: whether an admin ended this session: it started before the developer's `sessionsEndedAt`. Fails closed on an unreadable time. */
export function endedByAdmin(startedAt: string, sessionsEndedAt: string | undefined): boolean {
  if (sessionsEndedAt === undefined) return false;
  const started = Date.parse(startedAt);
  const ended = Date.parse(sessionsEndedAt);
  return !Number.isFinite(started) || !Number.isFinite(ended) || started < ended;
}
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

interface CodeRecord extends CodeGrant { codeChallenge: string; redirectUri: string; expiresAt: number; usedAt?: string }
interface RefreshRecord { sessionId: string; expiresAt: number; usedAt?: string; graceUsedAt?: string }
interface CancellationReason { Code?: string }

export const META = "META";

/**
 * A stored sign-in record (`DEVELOPER#<id>` / `META`) keeps its id only in the key: `upsertDeveloper` never writes a `developerId` attribute, so most real rows
 * lack it. Every reader that proves identity takes the id from the KEY it asked for. A row whose `pk` names another person, or whose `developerId` attribute is
 * present and disagrees with the key, is refused (undefined: the callers treat an absent record as unverifiable).
 */
export function developerRecordKeyedBy<T extends object>(item: T | undefined, developerId: string): (T & { developerId: string }) | undefined {
  if (item === undefined) return undefined;
  const row = item as { pk?: unknown; developerId?: unknown };
  if (row.pk !== undefined && row.pk !== `DEVELOPER#${developerId}`) return undefined;
  if (row.developerId !== undefined && row.developerId !== developerId) return undefined;
  return { ...item, developerId };
}


/** E8: the email index's key, the SHA-256 of the trimmed, lowercased email, so no email is stored as a key. */
export function emailIndexKey(email: string, companyId?: string): { pk: string; sk: "META" } {
  const key = `EMAIL#${sha256Hex(email.trim().toLowerCase())}`;
  if (companyId === undefined || companyId === IMPLICIT_COMPANY_ID) return { pk: key, sk: META };
  return { pk: companyScoped(OrgIdSchema.parse(companyId), key), sk: META };
}
const conditionFailed = (error: unknown) =>
  error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");

/** Real DynamoDB always populates this on a cancelled TransactWriteItems, one entry per
 * TransactItem, ordered the same way, "None" for items not implicated (fix round 2, F4: FakeDynamoDb
 * now models this too, so there is no other case to fall back to). */
function cancellationReasons(error: unknown): CancellationReason[] | undefined {
  const reasons = (error as { CancellationReasons?: unknown } | null)?.CancellationReasons;
  return Array.isArray(reasons) ? (reasons as CancellationReason[]) : undefined;
}

/** What a stored code grants: the grant's own fields only (never the challenge, the redirect or the expiry). */
function grantOfCode(record: CodeRecord): CodeGrant {
  return {
    developerId: record.developerId, amr: record.amr, ...(typeof record.signedInId === "string" ? { signedInId: record.signedInId } : {}),
    ...(record.slackUserId === undefined ? {} : { slackUserId: record.slackUserId }),
    ...(record.clientId === undefined ? {} : { clientId: record.clientId }),
    ...(record.administrator === true ? { administrator: true as const } : {}),
    ...(record.scopes === undefined ? {} : { scopes: record.scopes }),
    ...(record.companyId === undefined ? {} : { companyId: record.companyId }),
    ...(record.installMethod === true ? { installMethod: true as const } : {}),
    ...(record.joinedByInvite === true ? { joinedByInvite: true as const } : {}),
  };
}

export class DeveloperSignInStore {
  constructor(private readonly input: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number }) {}

  private seconds(): number { return Math.floor(this.input.now() / 1000); }
  private iso(): string { return new Date(this.input.now()).toISOString(); } /** DEC 254w: the table and client, for the sign-in link transactions (sign-in-links.ts). */ table(): { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string } { return { documentClient: this.input.documentClient, tableName: this.input.tableName }; }

  private async get<T>(pk: string): Promise<(T & { pk: string; sk: string }) | undefined> {
    const response = await this.input.documentClient.send(new GetCommand({ TableName: this.input.tableName, Key: { pk, sk: META }, ConsistentRead: true })) as { Item?: T & { pk: string; sk: string } };
    return response.Item;
  }

  private async put(item: Record<string, unknown>, condition?: string): Promise<void> {
    await this.input.documentClient.send(new PutCommand({ TableName: this.input.tableName, Item: item, ...(condition === undefined ? {} : { ConditionExpression: condition }) }));
  }

  // ---- Spec 063: the sign-in clients an administrator registered ----

  /** Registers a client or replaces it; its first registration's time is kept. */
  async putClient(client: SignInClientRecord, companyId?: string, options: { keepSecret?: true; operator?: true; commit?: (writes: NonNullable<TransactWriteCommandInput["TransactItems"]>) => Promise<void> } = {}): Promise<void> {
    if (companyId !== undefined) {
      const started = this.input.now();
      const scope = OrgIdSchema.parse(companyId);
      const record = SignInClientRecordSchema.parse(client);
      if (options.operator !== true && (record.installLevel === true || (record.companyId ?? IMPLICIT_COMPANY_ID) !== scope)) throw new Error("client unavailable");
      const revision = await this.clientRevision();
      const clients = await this.clientSnapshot(started, { revision });
      const current = clients.find((row) => row.clientId === record.clientId);
      if (current !== undefined && (current.installLevel === true ? options.operator !== true || record.installLevel !== true : record.installLevel === true || (current.companyId ?? IMPLICIT_COMPANY_ID) !== scope)) throw new Error("client unavailable");
      if (clients.some((row) => row.clientId !== record.clientId && row.audience === record.audience) || (current === undefined && clients.length >= 100)) throw new Error("client unavailable");
      if (options.keepSecret === true) {
        if (current?.secretHash === undefined) throw new Error("client unavailable");
        record.secretHash = current.secretHash;
      }
      if (record.fullAccess === true && record.secretHash === undefined) throw new Error("client unavailable");
      // DEC 236h: the web app marker is the operator's, on an install-level client: never a company administrator's, and never carried over by an update.
      if (record.webApp === true && !(options.operator === true && record.installLevel === true)) throw new Error("client unavailable");
      const writes = [{ Put: { TableName: this.input.tableName, Item: { ...signInClientKey(record.clientId), entityType: "SIGN_IN_CLIENT", ...record, createdAt: current?.createdAt ?? record.createdAt } } }, this.reviseClients(revision)];
      if (this.input.now() - started > 10_000) throw new Error("client unavailable");
      if (options.commit !== undefined) await options.commit(writes);
      else await this.input.documentClient.send(new TransactWriteCommand({ TransactItems: writes }));
      return;
    }
    const record = SignInClientRecordSchema.parse(client);
    const current = await this.getClient(record.clientId);
    await this.input.documentClient.send(new PutCommand({ TableName: this.input.tableName,
      Item: { ...signInClientKey(record.clientId), entityType: "SIGN_IN_CLIENT", ...record, createdAt: current?.createdAt ?? record.createdAt } }));
  }

  async removeClient(clientId: string, companyId?: string): Promise<boolean> {
    if (companyId !== undefined) {
      const started = this.input.now();
      const scope = OrgIdSchema.parse(companyId);
      SignInClientIdSchema.parse(clientId);
      const revision = await this.clientRevision();
      const clients = await this.clientSnapshot(started, { revision });
      const current = clients.find((row) => row.clientId === clientId);
      if (current === undefined || current.installLevel === true || (current.companyId ?? IMPLICIT_COMPANY_ID) !== scope) return false;
      await this.input.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Delete: { TableName: this.input.tableName, Key: signInClientKey(clientId) } }, this.reviseClients(revision),
      ] }));
      return true;
    }
    const response = await this.input.documentClient.send(new DeleteCommand({ TableName: this.input.tableName, Key: signInClientKey(clientId), ReturnValues: "ALL_OLD" })) as { Attributes?: unknown };
    return response.Attributes !== undefined;
  }

  /** A registered client, or undefined for one never registered or since removed (an unreadable row reads as none). */
  async getClient(clientId: string, companyId?: string, companyMode = false): Promise<SignInClientRecord | undefined> {
    const response = await this.input.documentClient.send(new GetCommand({ TableName: this.input.tableName, Key: signInClientKey(clientId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
    const client = response.Item === undefined ? undefined : clientOf(response.Item);
    if ((companyMode || companyId !== undefined) && response.Item !== undefined && (response.Item.pk !== SIGN_IN_CLIENTS_PK || response.Item.sk !== `CLIENT#${clientId}` || response.Item.entityType !== "SIGN_IN_CLIENT" || client?.clientId !== clientId)) return undefined;
    if (companyId !== undefined && (!OrgIdSchema.safeParse(companyId).success || client?.installLevel === true || (client?.companyId ?? IMPLICIT_COMPANY_ID) !== companyId)) return undefined;
    return client;
  }

  async listClients(companyId?: string): Promise<SignInClientRecord[]> {
    if (companyId !== undefined) {
      const scope = OrgIdSchema.parse(companyId);
      return (await this.clientSnapshot(this.input.now())).filter((row) => row.installLevel !== true && (row.companyId ?? IMPLICIT_COMPANY_ID) === scope);
    }
    const clients: SignInClientRecord[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const response = await this.input.documentClient.send(new QueryCommand({ TableName: this.input.tableName, KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": SIGN_IN_CLIENTS_PK }, ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }) })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
      for (const item of response.Items ?? []) {
        const client = clientOf(item);
        if (client !== undefined) clients.push(client);
      }
      start = response.LastEvaluatedKey;
    } while (start !== undefined);
    return clients.sort((a, b) => a.clientId.localeCompare(b.clientId));
  }

  /** The revision must precede the complete snapshot: all company-mode writers serialize here. */
  private async clientRevision(): Promise<string | undefined> {
    const response = await this.input.documentClient.send(new GetCommand({ TableName: this.input.tableName, Key: { pk: SIGN_IN_CLIENTS_PK, sk: "REVISION" }, ConsistentRead: true })) as { Item?: unknown };
    if (response.Item === undefined) return undefined;
    return z.object({ pk: z.literal(SIGN_IN_CLIENTS_PK), sk: z.literal("REVISION"), entityType: z.literal("SIGN_IN_CLIENT_REGISTRY"), revision: z.uuid() }).strict().parse(response.Item).revision;
  }
  private reviseClients(revision: string | undefined) {
    return { Put: { TableName: this.input.tableName, Item: { pk: SIGN_IN_CLIENTS_PK, sk: "REVISION", entityType: "SIGN_IN_CLIENT_REGISTRY", revision: randomUUID() },
      ...(revision === undefined ? { ConditionExpression: "attribute_not_exists(pk)" } : { ConditionExpression: "revision = :revision", ExpressionAttributeValues: { ":revision": revision } }),
    } };
  }
  /** One query, 100 clients plus the revision, one total byte/time budget. Pagination is not proof. */
  private async clientSnapshot(started: number, expected?: { revision: string | undefined }): Promise<SignInClientRecord[]> {
    const response = await this.input.documentClient.send(new QueryCommand({ TableName: this.input.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": SIGN_IN_CLIENTS_PK }, ConsistentRead: true, Limit: 102 })) as { Items?: unknown[]; LastEvaluatedKey?: unknown };
    if (!Array.isArray(response.Items) || response.Items.length > 101 || response.LastEvaluatedKey !== undefined || Buffer.byteLength(JSON.stringify(response)) > 900_000 || this.input.now() - started > 10_000) throw new Error("client unavailable");
    const clients: SignInClientRecord[] = []; const ids = new Set<string>(); const audiences = new Set<string>();
    let revisionSeen = false; let snapshotRevision: string | undefined;
    for (const value of response.Items) {
      const row = z.record(z.string(), z.unknown()).parse(value);
      if (row.sk === "REVISION") {
        z.object({ pk: z.literal(SIGN_IN_CLIENTS_PK), sk: z.literal("REVISION"), entityType: z.literal("SIGN_IN_CLIENT_REGISTRY"), revision: z.uuid() }).strict().parse(row);
        if (revisionSeen) throw new Error("client unavailable");
        snapshotRevision = row.revision as string; revisionSeen = true; continue;
      }
      const client = clientOf(row);
      if (client === undefined || row.pk !== SIGN_IN_CLIENTS_PK || row.sk !== `CLIENT#${client.clientId}` || row.entityType !== "SIGN_IN_CLIENT" || ids.has(client.clientId) || audiences.has(client.audience)) throw new Error("client unavailable");
      ids.add(client.clientId); audiences.add(client.audience); clients.push(client);
    }
    if (expected !== undefined && snapshotRevision !== expected.revision) throw new Error("client unavailable");
    if (clients.length > 100) throw new Error("client unavailable");
    return clients.sort((a, b) => a.clientId.localeCompare(b.clientId));
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

  /**
   * `companyless` (DEC 253z): a sign-in with no company. Its record is marked, so it never reads as a legacy person's (who would join the built-in
   * company), and its email goes in no company's email index.
   */
  async upsertDeveloper(profile: Omit<DeveloperRecord, "firstSignInAt" | "lastSignInAt" | "revoked" | "displayNameChosen">, companyId?: string, options: { companyless?: true; unmerged?: true } = {}): Promise<DeveloperRecord> {
    // One atomic update, not a read-then-overwrite: a concurrent revocation (or another sign-in)
    // must never be clobbered by this call. firstSignInAt and revoked are set only if absent;
    // revoked in particular must never flip true back to false (fix round 1, F3).
    const at = this.iso();
    const setClauses = [
      "entityType = :entityType",
      "provider = :provider",
      "issuer = :issuer",
      "subject = :subject",
      "lastSignInAt = :at",
      "firstSignInAt = if_not_exists(firstSignInAt, :at)",
      "revoked = if_not_exists(revoked, :false)",
      ...(options.companyless === true ? ["companyless = :true"] : []),
    ];
    const removeClauses: string[] = [];
    const values: Record<string, unknown> = {
      ":entityType": "DEVELOPER",
      ":provider": profile.provider,
      ":issuer": profile.issuer,
      ":subject": profile.subject,
      ":at": at,
      ":false": false,
      ...(options.companyless === true ? { ":true": true } : {}),
    };
    if (profile.email === undefined) removeClauses.push("email");
    else { setClauses.push("email = :email"); values[":email"] = profile.email; }
    if (profile.slackUserId === undefined) removeClauses.push("slackUserId");
    else { setClauses.push("slackUserId = :slackUserId"); values[":slackUserId"] = profile.slackUserId; }
    // DEC 254e: written only when given (company layer on), so every other sign-in's write is exactly as before.
    if (profile.slackTeamId !== undefined) {
      setClauses.push("slackTeamId = :slackTeamId"); values[":slackTeamId"] = profile.slackTeamId;
      if (profile.slackTeamName === undefined) removeClauses.push("slackTeamName");
      else { setClauses.push("slackTeamName = :slackTeamName"); values[":slackTeamName"] = profile.slackTeamName; }
    }

    const update = (withName: boolean) => this.input.documentClient.send(new UpdateCommand({
      TableName: this.input.tableName,
      Key: { pk: `DEVELOPER#${profile.developerId}`, sk: META },
      UpdateExpression: `SET ${[...setClauses, ...(withName ? ["displayName = :displayName"] : [])].join(", ")}${removeClauses.length > 0 ? ` REMOVE ${removeClauses.join(", ")}` : ""}`,
      // A name the person chose is theirs: the sign-in writes the provider's name only while they have not chosen one. The check is part of
      // the write, so a name chosen while this sign-in is in flight is not overwritten either (ported from an earlier private release).
      ...(withName ? { ConditionExpression: `(attribute_not_exists(displayNameChosen) OR displayNameChosen = :false)${options.unmerged === true ? " AND attribute_not_exists(mergedInto)" : ""}` } : options.unmerged === true ? { ConditionExpression: "attribute_not_exists(mergedInto)" } : {}), // DEC 254w (`unmerged`): a record connected to a person meanwhile is never written as a person of its own.
      ExpressionAttributeValues: { ...values, ...(withName ? { ":displayName": profile.displayName } : {}) },
    }));
    try {
      await update(true);
    } catch (error) {
      if (!conditionFailed(error)) throw error;
      await update(false).catch((again: unknown) => { throw options.unmerged === true && conditionFailed(again) ? new Error("the sign-in was connected to a person meanwhile") : again; });
    }
    if (profile.email !== undefined) {
      // E8 (Q4): the latest sign-in with this verified email wins; the email itself is not stored here.
      if (options.companyless !== true) await this.put({ ...emailIndexKey(profile.email, companyId), entityType: "DEVELOPER_EMAIL", developerId: profile.developerId, updatedAt: at });
    }
    const stored = await this.getDeveloper(profile.developerId);
    if (stored === undefined) throw new Error("developer upsert did not persist");
    return stored;
  }

  /**
   * The person chooses their own name. `developerId` is the verified caller's, never anything a request carries; `name` was checked with
   * `SetMyNameBodySchema` at the route. Marks it chosen, so a sign-in leaves it alone. A revoked or unknown person is NOT_FOUND.
   */
  async setChosenDisplayName(developerId: string, name: string): Promise<DeveloperRecord> {
    try {
      await this.input.documentClient.send(new UpdateCommand({
        TableName: this.input.tableName,
        Key: { pk: `DEVELOPER#${developerId}`, sk: META },
        UpdateExpression: "SET displayName = :name, displayNameChosen = :chosen",
        ConditionExpression: "attribute_exists(pk) AND revoked = :false",
        ExpressionAttributeValues: { ":name": name, ":chosen": true, ":false": false },
      }));
    } catch (error) {
      if (conditionFailed(error)) throw agentXError("NOT_FOUND", "your sign-in record was not found; sign in again");
      throw error;
    }
    const stored = await this.getDeveloper(developerId);
    if (stored === undefined) throw agentXError("NOT_FOUND", "your sign-in record was not found; sign in again");
    return stored;
  }

  /** A merged Slack sign-in remembers only its own workspace; never rewrite either person's profile or email index. */
  async rememberMergedSlackWorkspace(developerId: string, mergedInto: string, team: { id: string; name?: string }): Promise<void> {
    await this.input.documentClient.send(new UpdateCommand({
      TableName: this.input.tableName,
      Key: { pk: `DEVELOPER#${developerId}`, sk: META },
      UpdateExpression: `SET slackTeamId = :team${team.name === undefined ? " REMOVE slackTeamName" : ", slackTeamName = :name"}`,
      // Do not recreate a removed identity or overwrite an unlink, move or revocation racing this callback.
      ConditionExpression: "attribute_exists(pk) AND mergedInto = :mergedInto AND revoked = :false",
      ExpressionAttributeValues: { ":team": team.id, ":mergedInto": mergedInto, ":false": false, ...(team.name === undefined ? {} : { ":name": team.name }) },
    }));
  }

  async getDeveloper(developerId: string): Promise<DeveloperRecord | undefined> {
    const item = await this.get<DeveloperRecord>(`DEVELOPER#${developerId}`);
    return item === undefined ? undefined : strip(item);
  }

  async issueCode(input: CodeGrant & { codeChallenge: string; redirectUri: string }): Promise<string> {
    const code = randomToken("agxc_");
    const record: CodeRecord = { ...input, expiresAt: this.seconds() + DEVELOPER_CODE_SECONDS };
    await this.put({ pk: `CODE#${sha256Hex(code)}`, sk: META, entityType: "AUTH_CODE", ...record }, "attribute_not_exists(pk)");
    return code;
  }

  /**
   * A code's grant read WITHOUT redeeming it: undefined for an unknown, used or expired code. The token endpoint reads it first to run the membership checks, so a membership read that fails
   * answers the retryable 503 while the code is still unburned (redeemCode burns it, so a retry afterwards could never work). Nothing is verified or spent here.
   */
  async peekCode(code: string): Promise<CodeGrant | undefined> {
    const record = await this.get<CodeRecord>(`CODE#${sha256Hex(code)}`);
    if (record === undefined || record.usedAt !== undefined || record.expiresAt <= this.seconds()) return undefined;
    return grantOfCode(record);
  }

  async redeemCode(input: { code: string; verifier: string; redirectUri: string }): Promise<CodeGrant | undefined> {
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
    return grantOfCode(record);
  }

  /** `endsAt` (epoch seconds) is for a browser review sign-in, which has its own fixed length; every other session lasts DEVELOPER_SESSION_SECONDS. The stored record's clean-up time follows `endsAt`. */
  async createSession(input: CodeGrant & { reviewExpiresAt?: number; endsAt?: number }): Promise<{ session: SessionRecord; refreshToken: string }> {
    const session: SessionRecord = { endsAt: this.seconds() + DEVELOPER_SESSION_SECONDS, ...input, sessionId: randomUUID(), startedAt: this.iso() };
    const refreshToken = randomToken("agxr_");
    await this.input.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: this.input.tableName, Item: { pk: `SESSION#${session.sessionId}`, sk: META, entityType: "SESSION", ...session, expiresAt: session.endsAt + 86_400 }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: this.input.tableName, Item: { pk: `REFRESH#${sha256Hex(refreshToken)}`, sk: META, entityType: "REFRESH_TOKEN", sessionId: session.sessionId, expiresAt: session.endsAt }, ConditionExpression: "attribute_not_exists(pk)" } },
      ],
    }));
    return { session, refreshToken };
  }

  /**
   * A browser review sign-in: the SESSION row and nothing else. Its cookie is its whole credential, so no refresh-token row is written for it
   * (refreshableBy still refuses a session carrying reviewExpiresAt, for any row that already exists).
   */
  async createBrowserSession(input: CodeGrant & { reviewExpiresAt: number; endsAt: number }): Promise<{ session: SessionRecord }> {
    const session: SessionRecord = { ...input, sessionId: randomUUID(), startedAt: this.iso() };
    await this.input.documentClient.send(new PutCommand({ TableName: this.input.tableName, Item: { pk: `SESSION#${session.sessionId}`, sk: META, entityType: "SESSION", ...session, expiresAt: session.endsAt + 86_400 }, ConditionExpression: "attribute_not_exists(pk)" }));
    return { session };
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

  /**
   * E9 (Q3): sessions that started before `at` end; `revoked` is untouched, so they may sign in again.
   * The end never moves backwards: an older `at` leaves a later end in place and still answers
   * "ended". `at` is stored in toISOString's one format, so the condition's text order is time order.
   */
  async endSessions(developerId: string, at: string): Promise<"ended" | "not_found"> {
    const when = Date.parse(at);
    if (!Number.isFinite(when)) throw new RangeError("endSessions needs a readable time");
    const normalized = new Date(when).toISOString();
    try {
      await this.input.documentClient.send(new UpdateCommand({
        TableName: this.input.tableName,
        Key: { pk: `DEVELOPER#${developerId}`, sk: META },
        UpdateExpression: "SET sessionsEndedAt = :at",
        ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(sessionsEndedAt) OR sessionsEndedAt < :at)",
        ExpressionAttributeValues: { ":at": normalized },
      }));
      return "ended";
    } catch (error) {
      if (!conditionFailed(error)) throw error;
      // The record exists with a later or equal end, or it does not exist at all.
      return (await this.getDeveloper(developerId)) === undefined ? "not_found" : "ended";
    }
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

/** A stored client row as its record, without the table's own fields; undefined for a row that does not read. */
function clientOf(item: Record<string, unknown>): SignInClientRecord | undefined {
  const rest: Record<string, unknown> = { ...item };
  for (const key of ["pk", "sk", "entityType"]) delete rest[key];
  const parsed = SignInClientRecordSchema.safeParse(rest);
  return parsed.success ? parsed.data : undefined;
}
