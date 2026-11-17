// Guided onboarding PR 7 (design section 3d; DEC 254l item 5): a company's Linear connection, Rovara acting as the app.
//
// Records (State table):
//   LINEAR_CONNECT#<sha256(state)> / META             a connect start: company, person, session, 10 minutes, single use; the PKCE verifier sealed
//   LINEAR_WORKSPACE#<organization id> / BINDING      which company a Linear workspace belongs to: first binder wins (conditional), never overwritten
//   ORG#<company>#LINEAR_CONNECTION / META            the company's one connection: workspace id/name/url key, status, who connected it and when,
//                                                     the access and refresh tokens SEALED (KMS, encryption context naming the company and the field), a version
//   ORG#<company>#LINEAR_TEAMS / PROJECT#<project>    a project's Linear team (the pick)
//   ORG#<company>#LINEAR_AUDIT / <at>#<action>#<id>   every bind, reconnect, unbind, revoke, refresh refusal and team pick, naming the person (or "linear")
//   LINEAR_DELIVERY#<sha256(raw body)> / META         an app webhook delivery already taken (a replay inside the 60-second window is a no-op); expires by TTL
//
// Tokens are stored ONLY here, sealed, under the company; they are never returned to a browser, logged, or put in an error. Like Sign in with ChatGPT's connections
// (chatgpt/connections.ts), because Code writes them on every refresh: the per-company Secrets Manager path (Slack's pattern) is written by an operator, and the broker's
// company secrets role is not assumed by anything yet (infra/lib/company-secrets.ts).
//
// Refresh (access tokens last 24 hours; refresh tokens 30 days and ROTATE on every refresh):
//   - an access token is refreshed REFRESH_MARGIN_MS before it ends, by whoever asks for it then;
//   - one refresher at a time: a conditional write takes a lease (a random id and an end) on exactly the version read; the new pair is written only while that SAME lease
//     still stands (condition: leaseId and version), so two refreshers can never both write, and the stored refresh token is always the one Linear issued last to a writer;
//   - a refresher whose lease ended (or was taken) discards what it got and reads again. A refresher that crashed after Linear rotated, before writing, leaves the OLD
//     refresh token stored: Linear accepts it again for 30 minutes (the docs' retry window), so the next refresher still succeeds;
//   - Linear refusing the refresh (`invalid_grant`) marks the connection "needs_reconnect" and drops the tokens (an admin notice, PR 13); nothing else does.
import { createHash, randomBytes } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { agentXError, companyLog, INDEX_EXPIRY_ATTRIBUTE, OrgIdSchema, orgScoped } from "@agentx/contracts";
import { isConditional } from "./broker-shared.js";
import { LinearOAuthFailure, refreshLinearTokens, revokeLinearToken, type LinearApp, type LinearTeam, type LinearTokens, type LinearWorkspace } from "./linear-oauth-client.js";

/** The app's settings, read from its secret (`linearAppSecretName`): never in a variable, a log or an answer. */
export interface LinearAppSettings extends LinearApp {
  /** The OAuth app's webhook signing secret (one per app). */
  webhookSecret: string;
}

/** Where the app's settings live: under the connector secret prefix the broker already reads (`agentx/<env>/connectors/`), so no new grant. */
export const LINEAR_APP_SECRET_LEAF = "linear-oauth-app";
export function linearAppSecretName(connectorSecretPrefix: string): string {
  return `${connectorSecretPrefix}${LINEAR_APP_SECRET_LEAF}`;
}
const Printable = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/);
export const LinearAppSettingsSchema = z.object({
  clientId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/), clientSecret: Printable, webhookSecret: Printable,
  redirectUri: z.string().max(512).refine((value) => {
    try { const url = new URL(value); return url.protocol === "https:" && url.username === "" && url.password === "" && url.search === "" && url.hash === "" && url.pathname === "/api/connect/linear/callback"; }
    catch { return false; }
  }),
}).strict();

export interface LinearSealer {
  seal(plain: string, context: Record<string, string>): Promise<string>;
  open(sealed: string, context: Record<string, string>): Promise<string>;
}

export interface LinearConnectionsDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  sealer: LinearSealer;
  /** The Linear HTTP seam (tests: a fake Linear). */
  fetch: typeof fetch;
  now: () => number;
  /** The app's settings, or undefined when the owner has not set them up. */
  app: () => Promise<LinearAppSettings | undefined>;
  log: (entry: Record<string, unknown>) => void;
  random?: (bytes: number) => Buffer;
  sleep?: (ms: number) => Promise<void>;
}

export const LINEAR_CONNECT_TTL_SECONDS = 600;
/** How long before the access token ends it is refreshed. */
export const REFRESH_MARGIN_MS = 10 * 60_000;
/** How long a refresher holds the connection. Longer than one refresh call can take (10 s), so a live refresher's lease never ends under it. */
export const REFRESH_LEASE_MS = 60_000;
const REFRESH_WAIT_MS = 250;
const REFRESH_ATTEMPTS = 40;
/** A delivery's dedupe row outlives the 60-second window by far; it expires by the State table's TTL. */
const DELIVERY_KEEP_SECONDS = 86_400;
/** The most projects one company's team picks are read for (more refuses the read). */
export const LINEAR_PICKS_MAX = 500;

export const LINEAR_NEEDS_RECONNECT = "Linear needs reconnecting. A company owner or admin can reconnect it in Company settings, Connections.";
export const LINEAR_NOT_CONNECTED = "Linear isn't connected for this company. A company owner or admin can connect it in Company settings, Connections.";
export const LINEAR_UNAVAILABLE = "Linear could not be reached just now; try again.";

export type LinearConnectionStatus = "connected" | "needs_reconnect" | "disconnected";
const PersonOrLinear = z.union([z.string().regex(/^[a-f0-9]{64}$/), z.literal("linear")]);
const WorkspaceId = z.string().regex(/^[A-Za-z0-9-]{1,100}$/);
const ConnectionRow = z.object({
  entityType: z.literal("LINEAR_CONNECTION"), companyId: OrgIdSchema, organizationId: WorkspaceId, workspaceName: z.string().min(1).max(256),
  urlKey: z.string().max(63), status: z.enum(["connected", "needs_reconnect", "disconnected"]), statusAt: z.iso.datetime(),
  connectedBy: z.string().regex(/^[a-f0-9]{64}$/), connectedAt: z.iso.datetime(), version: z.number().int().positive(),
  sealedAccess: z.string().min(1).max(16_384).optional(), sealedRefresh: z.string().min(1).max(16_384).optional(), accessExpiresAt: z.number().int().positive().optional(),
  scope: z.string().max(1000).optional(), leaseId: z.string().optional(), leaseUntil: z.number().optional(),
}).passthrough();
export type LinearConnectionRow = z.infer<typeof ConnectionRow>;
const BindingRow = z.object({ entityType: z.literal("LINEAR_WORKSPACE_BINDING"), organizationId: WorkspaceId, companyId: OrgIdSchema, boundAt: z.iso.datetime(), boundBy: PersonOrLinear }).passthrough();
const PickRow = z.object({
  entityType: z.literal("LINEAR_PROJECT_TEAM"), companyId: OrgIdSchema, project: z.string().min(1).max(128), teamId: WorkspaceId,
  teamKey: z.string().max(10), teamName: z.string().max(256), setBy: z.string().regex(/^[a-f0-9]{64}$/), setAt: z.iso.datetime(),
}).passthrough();
export type LinearTeamPick = z.infer<typeof PickRow>;
const StateRow = z.object({
  entityType: z.literal("LINEAR_CONNECT_STATE"), provider: z.literal("linear"), status: z.literal("live"), companyId: OrgIdSchema,
  personId: z.string().regex(/^[a-f0-9]{64}$/), sessionId: z.string().min(1).max(256), createdAt: z.iso.datetime(), expiresAt: z.number().int().positive(),
  sealedVerifier: z.string().min(1).max(16_384),
}).passthrough();

const hashOf = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
export const linearStateKey = (state: string) => ({ pk: `LINEAR_CONNECT#${hashOf(state)}`, sk: "META" });
export const linearWorkspaceKey = (organizationId: string) => ({ pk: `LINEAR_WORKSPACE#${organizationId}`, sk: "BINDING" });
export const linearConnectionKey = (companyId: string) => ({ pk: orgScoped(OrgIdSchema.parse(companyId), "LINEAR_CONNECTION"), sk: "META" });
export const linearTeamsPk = (companyId: string) => orgScoped(OrgIdSchema.parse(companyId), "LINEAR_TEAMS");
export const linearTeamKey = (companyId: string, project: string) => ({ pk: linearTeamsPk(companyId), sk: `PROJECT#${project}` });
export const linearAuditKey = (companyId: string, at: string, action: string, id: string) => ({ pk: orgScoped(OrgIdSchema.parse(companyId), "LINEAR_AUDIT"), sk: `${at}#${action}#${id}` });
export const linearDeliveryKey = (rawBody: string | Buffer) => ({ pk: `LINEAR_DELIVERY#${createHash("sha256").update(rawBody).digest("hex")}`, sk: "META" });

const tokenContext = (companyId: string, organizationId: string, field: "access" | "refresh") => ({ purpose: "linear-connection", companyId, organizationId, field });
const verifierContext = (companyId: string, personId: string, stateHash: string) => ({ purpose: "linear-connect", companyId, personId, stateHash, field: "verifier" });

export const notConnected = () => agentXError("LINEAR_NOT_CONNECTED", LINEAR_NOT_CONNECTED);
export const needsReconnect = () => agentXError("LINEAR_NOT_CONNECTED", LINEAR_NEEDS_RECONNECT);
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", LINEAR_UNAVAILABLE);

export type BindOutcome = { outcome: "connected" | "reconnected" } | { outcome: "taken" } | { outcome: "other_workspace" };
export type DisconnectOutcome = { outcome: "not_found" } | { outcome: "disconnected"; workspaceName: string; projects: string[] };

export class LinearConnections {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: (bytes: number) => Buffer;
  constructor(private readonly deps: LinearConnectionsDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = deps.random ?? ((bytes) => randomBytes(bytes));
  }

  private get table() { return this.deps.tableName; }
  private async get(key: { pk: string; sk: string }): Promise<unknown> {
    return ((await this.deps.documentClient.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true }))) as { Item?: unknown }).Item;
  }
  private log(companyId: string, entry: Record<string, unknown>) { companyLog(companyId, this.deps.log)(entry); }
  private auditItem(companyId: string, action: string, actor: string, fields: Record<string, unknown>) {
    const at = new Date(this.deps.now()).toISOString();
    return { Put: { TableName: this.table, Item: { ...linearAuditKey(companyId, at, action, this.random(8).toString("hex")), entityType: "LINEAR_CONNECTION_AUDIT", companyId, action, actor, at, ...fields },
      ConditionExpression: "attribute_not_exists(pk)" } };
  }

  /** A connect start for this company, person and session: the state (returned once) and the PKCE verifier (sealed, kept here). */
  async mintState(who: { companyId: string; personId: string; sessionId: string }): Promise<{ state: string; verifier: string; expiresAt: number }> {
    const stateBytes = this.random(32); const verifierBytes = this.random(32);
    if (stateBytes.length !== 32 || verifierBytes.length !== 32) throw new Error("random");
    const state = stateBytes.toString("base64url"); const verifier = verifierBytes.toString("base64url");
    const nowMs = this.deps.now();
    const expiresAt = Math.floor(nowMs / 1000) + LINEAR_CONNECT_TTL_SECONDS;
    const key = linearStateKey(state);
    const sealedVerifier = await this.deps.sealer.seal(verifier, verifierContext(who.companyId, who.personId, key.pk));
    await this.deps.documentClient.send(new PutCommand({ TableName: this.table, Item: { ...key, entityType: "LINEAR_CONNECT_STATE", provider: "linear", status: "live",
      ...who, createdAt: new Date(nowMs).toISOString(), expiresAt, sealedVerifier, [INDEX_EXPIRY_ATTRIBUTE]: expiresAt + DELIVERY_KEEP_SECONDS }, ConditionExpression: "attribute_not_exists(pk)" }));
    return { state, verifier, expiresAt };
  }

  /** Spends a live state once, only for the same company, person and session, before it expires; its PKCE verifier. Undefined for anything else. */
  async spendState(state: string, who: { companyId: string; personId: string; sessionId: string }): Promise<string | undefined> {
    try {
      const key = linearStateKey(state);
      const nowSeconds = Math.floor(this.deps.now() / 1000);
      const row = StateRow.parse(await this.get(key));
      if (row.companyId !== who.companyId || row.personId !== who.personId || row.sessionId !== who.sessionId || row.expiresAt <= nowSeconds) return undefined;
      await this.deps.documentClient.send(new UpdateCommand({ TableName: this.table, Key: key,
        UpdateExpression: "SET #status = :used, usedAt = :at REMOVE sealedVerifier",
        ConditionExpression: "#status = :live AND #provider = :provider AND companyId = :company AND personId = :person AND sessionId = :session AND expiresAt > :now",
        ExpressionAttributeNames: { "#status": "status", "#provider": "provider" },
        ExpressionAttributeValues: { ":used": "used", ":live": "live", ":at": new Date(this.deps.now()).toISOString(), ":provider": "linear",
          ":company": who.companyId, ":person": who.personId, ":session": who.sessionId, ":now": nowSeconds } }));
      return await this.deps.sealer.open(row.sealedVerifier, verifierContext(who.companyId, who.personId, key.pk));
    } catch { return undefined; }
  }

  /** The company's connection record (no token is opened), or undefined. */
  async connection(companyId: string): Promise<LinearConnectionRow | undefined> {
    const item = await this.get(linearConnectionKey(companyId));
    if (item === undefined) return undefined;
    const row = ConnectionRow.parse(item);
    if (row.companyId !== companyId) throw new Error("connection");
    return row;
  }

  /** The company a Linear workspace is bound to, or undefined. */
  async companyOfWorkspace(organizationId: string): Promise<string | undefined> {
    if (!WorkspaceId.safeParse(organizationId).success) return undefined;
    const item = await this.get(linearWorkspaceKey(organizationId));
    if (item === undefined) return undefined;
    const row = BindingRow.parse(item);
    return row.organizationId === organizationId ? row.companyId : undefined;
  }

  /**
   * After the person's consent and the code exchange: bind the workspace to the company (first binder wins) and store the tokens, sealed, in ONE conditional transaction with
   * the audit row naming the person. Another company's workspace: taken, nothing written. The company already connected to another workspace: other_workspace, nothing written
   * (an owner disconnects first). The same workspace again (needs_reconnect, disconnected by Linear, or connected): the new tokens replace the old, on exactly the version read.
   */
  async bindAndStore(companyId: string, personId: string, workspace: LinearWorkspace, tokens: LinearTokens): Promise<BindOutcome> {
    OrgIdSchema.parse(companyId); WorkspaceId.parse(workspace.id);
    for (let attempt = 0; attempt < 2; attempt++) {
      const [bindingItem, existing] = await Promise.all([this.get(linearWorkspaceKey(workspace.id)), this.connection(companyId)]);
      const binding = bindingItem === undefined ? undefined : BindingRow.parse(bindingItem);
      if (binding !== undefined && binding.companyId !== companyId) return { outcome: "taken" };
      if (existing !== undefined && existing.organizationId !== workspace.id) return { outcome: "other_workspace" };
      const at = new Date(this.deps.now()).toISOString();
      const sealedAccess = await this.deps.sealer.seal(tokens.access, tokenContext(companyId, workspace.id, "access"));
      const sealedRefresh = await this.deps.sealer.seal(tokens.refresh, tokenContext(companyId, workspace.id, "refresh"));
      const reconnect = binding !== undefined;
      // The pair being replaced (a reconnect) is revoked at Linear after the commit, best effort.
      const replaced: string[] = [];
      for (const [sealed, field] of [[existing?.sealedAccess, "access"], [existing?.sealedRefresh, "refresh"]] as const) {
        if (sealed === undefined || existing === undefined) continue;
        try { replaced.push(await this.deps.sealer.open(sealed, tokenContext(companyId, existing.organizationId, field))); } catch { /* not revoked */ }
      }
      try {
        await this.deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
          binding === undefined
            ? { Put: { TableName: this.table, Item: { ...linearWorkspaceKey(workspace.id), entityType: "LINEAR_WORKSPACE_BINDING", organizationId: workspace.id, companyId, boundAt: at, boundBy: personId },
              ConditionExpression: "attribute_not_exists(pk)" } }
            : { ConditionCheck: { TableName: this.table, Key: linearWorkspaceKey(workspace.id), ConditionExpression: "companyId = :company AND boundAt = :boundAt",
              ExpressionAttributeValues: { ":company": companyId, ":boundAt": binding.boundAt } } },
          { Put: { TableName: this.table, Item: { ...linearConnectionKey(companyId), entityType: "LINEAR_CONNECTION", companyId, organizationId: workspace.id, workspaceName: workspace.name,
            urlKey: workspace.urlKey, status: "connected", statusAt: at, connectedBy: personId, connectedAt: at, version: (existing?.version ?? 0) + 1,
            sealedAccess, sealedRefresh, accessExpiresAt: tokens.accessExpiresAt, scope: tokens.scope },
          ...(existing === undefined ? { ConditionExpression: "attribute_not_exists(pk)" }
            : { ConditionExpression: "organizationId = :org AND version = :version", ExpressionAttributeValues: { ":org": workspace.id, ":version": existing.version } }) } },
          this.auditItem(companyId, reconnect ? "reconnect" : "connect", personId, { organizationId: workspace.id }),
        ] }));
      } catch (error) {
        if (!isConditional(error)) throw error;
        continue;
      }
      this.log(companyId, { event: reconnect ? "linear.connection_reconnected" : "linear.connection_bound", actor: personId });
      for (const token of replaced) if (!await revokeLinearToken({ fetch: this.deps.fetch, token })) this.log(companyId, { event: "linear.revoke_failed" });
      return { outcome: reconnect ? "reconnected" : "connected" };
    }
    // Lost twice: whatever is stored now decides; nothing was overwritten.
    const now = await this.companyOfWorkspace(workspace.id);
    if (now !== undefined && now !== companyId) return { outcome: "taken" };
    throw unavailable();
  }

  /**
   * The company's current access token, refreshed when it is about to end (see the file's header for the race rules). Only this company's connection is ever read:
   * the company is the caller's, and the encryption context names it, so another company's sealed token never opens here.
   */
  async accessToken(companyId: string): Promise<string> {
    OrgIdSchema.parse(companyId);
    for (let attempt = 0; attempt < REFRESH_ATTEMPTS; attempt++) {
      const row = await this.connection(companyId).catch(() => { throw unavailable(); });
      if (row === undefined || row.status === "disconnected") throw notConnected();
      if (row.status !== "connected" || row.sealedAccess === undefined || row.sealedRefresh === undefined || row.accessExpiresAt === undefined) throw needsReconnect();
      const now = this.deps.now();
      if (row.accessExpiresAt - REFRESH_MARGIN_MS > now) {
        // A sealed value that does not open under THIS company's context (moved from another record) is never used.
        try { return await this.deps.sealer.open(row.sealedAccess, tokenContext(companyId, row.organizationId, "access")); } catch { throw unavailable(); }
      }
      const leaseId = this.random(16).toString("hex");
      const leaseUntil = now + REFRESH_LEASE_MS;
      try {
        await this.deps.documentClient.send(new UpdateCommand({ TableName: this.table, Key: linearConnectionKey(companyId),
          UpdateExpression: "SET leaseId = :lease, leaseUntil = :until",
          ConditionExpression: "version = :version AND #status = :connected AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":lease": leaseId, ":until": leaseUntil, ":version": row.version, ":connected": "connected", ":now": now } }));
      } catch (error) {
        if (!isConditional(error)) throw unavailable();
        // Another refresher holds it, or just finished: read again.
        await this.sleep(REFRESH_WAIT_MS);
        continue;
      }
      const ours = { ":lease": leaseId, ":version": row.version };
      const app = await this.deps.app().catch(() => undefined);
      let tokens: LinearTokens;
      try {
        if (app === undefined) throw new LinearOAuthFailure("unavailable");
        tokens = await refreshLinearTokens({ fetch: this.deps.fetch, app, refresh: await this.deps.sealer.open(row.sealedRefresh, tokenContext(companyId, row.organizationId, "refresh")), now });
      } catch (error) {
        if (error instanceof LinearOAuthFailure && error.kind === "refused") {
          await this.markNeedsReconnect(companyId, row, leaseId);
          throw needsReconnect();
        }
        await this.deps.documentClient.send(new UpdateCommand({ TableName: this.table, Key: linearConnectionKey(companyId), UpdateExpression: "REMOVE leaseId, leaseUntil",
          ConditionExpression: "leaseId = :lease AND version = :version", ExpressionAttributeValues: ours })).catch(() => undefined);
        throw unavailable();
      }
      // If our lease ended while Linear answered and another refresher took it, the write's lease condition fails and what we got is discarded (the stored refresh token is still
      // accepted for 30 minutes). If nobody took it, our pair is the newest Linear issued, so writing it is right.
      // Linear has rotated: the new pair is written while our lease stands, tried a few times (a KMS or DynamoDB blip must not drop it), and the lease is given back if it never lands.
      let written: "written" | "lost" | "failed" = "failed";
      for (let write = 0; write < 3 && written === "failed"; write++) {
        try {
          await this.deps.documentClient.send(new UpdateCommand({ TableName: this.table, Key: linearConnectionKey(companyId),
            UpdateExpression: "SET sealedAccess = :access, sealedRefresh = :refresh, accessExpiresAt = :expires, version = :next, refreshedAt = :at REMOVE leaseId, leaseUntil",
            ConditionExpression: "leaseId = :lease AND version = :version",
            ExpressionAttributeValues: { ...ours, ":next": row.version + 1, ":expires": tokens.accessExpiresAt, ":at": new Date(this.deps.now()).toISOString(),
              ":access": await this.deps.sealer.seal(tokens.access, tokenContext(companyId, row.organizationId, "access")),
              ":refresh": await this.deps.sealer.seal(tokens.refresh, tokenContext(companyId, row.organizationId, "refresh")) } }));
          written = "written";
        } catch (error) {
          if (isConditional(error)) written = "lost";
        }
      }
      if (written === "lost") continue;
      if (written === "failed") {
        await this.deps.documentClient.send(new UpdateCommand({ TableName: this.table, Key: linearConnectionKey(companyId), UpdateExpression: "REMOVE leaseId, leaseUntil",
          ConditionExpression: "leaseId = :lease AND version = :version", ExpressionAttributeValues: ours })).catch(() => undefined);
        throw unavailable();
      }
      return tokens.access;
    }
    throw unavailable();
  }

  private async markNeedsReconnect(companyId: string, row: LinearConnectionRow, leaseId: string): Promise<void> {
    try {
      await this.deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Update: { TableName: this.table, Key: linearConnectionKey(companyId),
          UpdateExpression: "SET #status = :needs, statusAt = :at, version = :next REMOVE sealedAccess, sealedRefresh, accessExpiresAt, leaseId, leaseUntil",
          ConditionExpression: "leaseId = :lease AND version = :version", ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":needs": "needs_reconnect", ":at": new Date(this.deps.now()).toISOString(), ":next": row.version + 1, ":lease": leaseId, ":version": row.version } } },
        this.auditItem(companyId, "needs_reconnect", "linear", { organizationId: row.organizationId }),
      ] }));
      this.log(companyId, { event: "linear.connection_needs_reconnect", actor: "linear" });
    } catch { /* Someone else changed it meanwhile: what is stored decides. */ }
  }

  /** The company's projects' team picks (at most LINEAR_PICKS_MAX; more refuses the whole read). */
  async teamPicks(companyId: string, options: { all?: true } = {}): Promise<LinearTeamPick[]> {
    const picks: LinearTeamPick[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.deps.documentClient.send(new QueryCommand({ TableName: this.table, KeyConditionExpression: "pk = :pk AND begins_with(sk, :project)",
        ExpressionAttributeValues: { ":pk": linearTeamsPk(companyId), ":project": "PROJECT#" }, ConsistentRead: true,
        ...(start === undefined ? {} : { ExclusiveStartKey: start }) })) as { Items?: unknown[]; LastEvaluatedKey?: Record<string, unknown> };
      for (const item of page.Items ?? []) {
        const pick = PickRow.parse(item);
        if (pick.companyId !== companyId) throw new Error("pick");
        picks.push(pick);
        if (options.all !== true && picks.length > LINEAR_PICKS_MAX) throw new Error("picks");
      }
      start = page.LastEvaluatedKey;
    } while (start !== undefined);
    return picks;
  }

  async teamPick(companyId: string, project: string): Promise<LinearTeamPick | undefined> {
    const item = await this.get(linearTeamKey(companyId, project));
    if (item === undefined) return undefined;
    const pick = PickRow.parse(item);
    return pick.companyId === companyId && pick.project === project ? pick : undefined;
  }

  /** Sets a project's team, only while the company's connection is still the one read (same workspace and version), with an audit row naming the person. */
  async setTeam(companyId: string, project: string, team: LinearTeam, personId: string, connection: LinearConnectionRow): Promise<void> {
    const at = new Date(this.deps.now()).toISOString();
    try {
      await this.deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: this.table, Key: linearConnectionKey(companyId), ConditionExpression: "organizationId = :org AND #status = :connected",
          ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":org": connection.organizationId, ":connected": "connected" } } },
        { Put: { TableName: this.table, Item: { ...linearTeamKey(companyId, project), entityType: "LINEAR_PROJECT_TEAM", companyId, project, teamId: team.id, teamKey: team.key, teamName: team.name, setBy: personId, setAt: at } } },
        this.auditItem(companyId, "team_set", personId, { project, teamId: team.id }),
      ] }));
    } catch (error) {
      if (isConditional(error)) throw needsReconnect();
      throw error;
    }
    this.log(companyId, { event: "linear.team_set", actor: personId });
  }

  async clearTeam(companyId: string, project: string, personId: string): Promise<boolean> {
    try {
      await this.deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Delete: { TableName: this.table, Key: linearTeamKey(companyId, project), ConditionExpression: "attribute_exists(pk) AND companyId = :company", ExpressionAttributeValues: { ":company": companyId } } },
        this.auditItem(companyId, "team_cleared", personId, { project }),
      ] }));
    } catch (error) {
      if (isConditional(error)) return false;
      throw error;
    }
    this.log(companyId, { event: "linear.team_cleared", actor: personId });
    return true;
  }

  /**
   * An owner disconnects: the connection and the workspace binding go in ONE conditional transaction on exactly what was read, with an audit row naming the person; then every
   * team pick of the company is cleared and both tokens are revoked at Linear (best effort: a revoke Linear does not answer is logged by name only). The answer names the
   * projects that had a team.
   */
  async disconnect(companyId: string, personId: string): Promise<DisconnectOutcome> {
    const row = await this.connection(companyId);
    if (row === undefined) return { outcome: "not_found" };
    // Every pick, however many: a disconnect must never be blocked by the routing read's cap.
    const picks = await this.teamPicks(companyId, { all: true });
    let access: string | undefined; let refresh: string | undefined;
    try {
      if (row.sealedAccess !== undefined) access = await this.deps.sealer.open(row.sealedAccess, tokenContext(companyId, row.organizationId, "access"));
      if (row.sealedRefresh !== undefined) refresh = await this.deps.sealer.open(row.sealedRefresh, tokenContext(companyId, row.organizationId, "refresh"));
    } catch { /* A token that does not open is not revoked; the connection still goes. */ }
    const audit = this.auditItem(companyId, "disconnect", personId, { organizationId: row.organizationId, projects: picks.map((pick) => pick.project).slice(0, 100) });
    try {
      await this.deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Delete: { TableName: this.table, Key: linearConnectionKey(companyId), ConditionExpression: "version = :version AND organizationId = :org",
          ExpressionAttributeValues: { ":version": row.version, ":org": row.organizationId } } },
        { Delete: { TableName: this.table, Key: linearWorkspaceKey(row.organizationId), ConditionExpression: "attribute_not_exists(pk) OR companyId = :company", ExpressionAttributeValues: { ":company": companyId } } },
        audit,
      ] }));
    } catch (error) {
      if (!isConditional(error)) throw error;
      // Lost a race: our own audit row says whether it committed.
      if (await this.get({ pk: audit.Put.Item.pk, sk: audit.Put.Item.sk }) === undefined) {
        if (await this.connection(companyId) === undefined) return { outcome: "not_found" };
        throw unavailable();
      }
    }
    for (const pick of picks) {
      await this.deps.documentClient.send(new DeleteCommand({ TableName: this.table, Key: linearTeamKey(companyId, pick.project), ConditionExpression: "attribute_exists(pk) AND companyId = :company",
        ExpressionAttributeValues: { ":company": companyId } })).catch(() => undefined);
    }
    this.log(companyId, { event: "linear.connection_disconnected", actor: personId, projects: picks.length });
    for (const token of [access, refresh]) {
      if (token === undefined) continue;
      if (!await revokeLinearToken({ fetch: this.deps.fetch, token })) this.log(companyId, { event: "linear.revoke_failed" });
    }
    return { outcome: "disconnected", workspaceName: row.workspaceName, projects: [...new Set(picks.map((pick) => pick.project))].sort() };
  }

  /**
   * Linear's app webhook said the app was revoked in this workspace: the bound company's connection is marked disconnected and its tokens dropped (conditionally, on what was
   * read; audit actor "linear"). The binding and the team picks stay, so the same company reconnects in one step; only an owner's disconnect frees the workspace.
   */
  async markRevoked(organizationId: string, attempt = 0): Promise<{ companyId: string } | undefined> {
    const companyId = await this.companyOfWorkspace(organizationId);
    if (companyId === undefined) return undefined;
    const row = await this.connection(companyId);
    if (row === undefined || row.organizationId !== organizationId || row.status === "disconnected") return { companyId };
    try {
      await this.deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Update: { TableName: this.table, Key: linearConnectionKey(companyId),
          UpdateExpression: "SET #status = :off, statusAt = :at, version = :next REMOVE sealedAccess, sealedRefresh, accessExpiresAt, leaseId, leaseUntil",
          ConditionExpression: "version = :version AND organizationId = :org", ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":off": "disconnected", ":at": new Date(this.deps.now()).toISOString(), ":next": row.version + 1, ":version": row.version, ":org": organizationId } } },
        this.auditItem(companyId, "revoked", "linear", { organizationId }),
      ] }));
    } catch (error) {
      if (!isConditional(error) || attempt >= 2) throw error;
      return this.markRevoked(organizationId, attempt + 1);
    }
    this.log(companyId, { event: "linear.connection_revoked", actor: "linear" });
    return { companyId };
  }

  /** Gives a delivery back (its processing failed, so Linear's retry of the same body is taken again). */
  async releaseDelivery(rawBody: string): Promise<void> {
    await this.deps.documentClient.send(new DeleteCommand({ TableName: this.table, Key: linearDeliveryKey(rawBody) }));
  }

  /** Takes a webhook delivery once: false when this exact body was already taken (a replay). */
  async takeDelivery(rawBody: string): Promise<boolean> {
    const nowSeconds = Math.floor(this.deps.now() / 1000);
    try {
      await this.deps.documentClient.send(new PutCommand({ TableName: this.table, Item: { ...linearDeliveryKey(rawBody), entityType: "LINEAR_WEBHOOK_DELIVERY", takenAt: new Date(this.deps.now()).toISOString(),
        [INDEX_EXPIRY_ATTRIBUTE]: nowSeconds + DELIVERY_KEEP_SECONDS }, ConditionExpression: "attribute_not_exists(pk)" }));
      return true;
    } catch (error) {
      if (isConditional(error)) return false;
      throw error;
    }
  }
}
