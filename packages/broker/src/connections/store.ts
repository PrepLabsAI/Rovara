// Connections: the record of each Linear, Jira, MCP, Sentry, Datadog, CloudWatch, Grafana, Vercel or PagerDuty connection the owner has given Rovara (the last six are read-only). A record holds
// the connection's settings, whether a secret has been saved, and what the last check found. It never holds the key or token, or even the secret's name: that name is derived from the
// company id and the connection id each time, and the value lives only in the secret store (`org-secrets.ts`, `local-secrets.ts`).
//
// Over the document store port. The keys and the records are the hosted product's (`ORG#<company>#CONNECTION#<id>`, and the directory `ORG#<company>#CONNECTIONS`), so a later switch moves no data. A change commits in one
// transaction with its directory entry, the audit event the audit sink stages and the request's own item. Adding, changing or removing a connection is the owner's act on the local page (the page
// calls this store); the routes a tool uses can only read.
import { createHash } from "node:crypto";
import type { z } from "zod";
import { listMcpTools } from "@agentx/gateway";
import {
  type AuditEvent,
  type AuditSink,
  ConnectionIdSchema,
  ConnectionSecretSchemas,
  ObservabilityConnectionTypeSchema,
  OrgConnectionSchema,
  OrgIdSchema,
  agentXError,
  change as set,
  cloudwatchExternalId,
  cloudwatchRoleAccount,
  connectionKey,
  connectionSecretToken,
  connectionTakesSecret,
  connectionsKey,
  readOnlyConnectionMessage,
  when,
  type ConnectionSecret,
  type ConnectionType,
  type DocumentStore,
  type ObservabilityConnectionType,
  type OrgConnection,
  type OrgId,
  type SecretConnectionType,
  type StoredDocument,
} from "@agentx/contracts";
import { commitWithMark, type RequestMark } from "./request-marks.js";
import { orgConnectorSecretName, type ConnectionSecrets } from "./org-secrets.js";
import { mcpEndpointGuard, type McpEndpointGuard } from "./pinned-endpoint.js";
import { noWebRequests, originHeldFetch, vendorHostOf } from "./vendor-hosts.js";
import { safeVendorFetch } from "../connectors/native/vendor-fetch.js";

type Item = StoredDocument;

/** What the stores and the per-company credential registry need. */
export interface OrgConnectionDeps {
  store: DocumentStore;
  /** The install's environment name, which prefixes every secret name (`local` on a laptop). */
  env: string;
  secrets: Pick<ConnectionSecrets, "read" | "put" | "scheduleDelete">;
  now: () => number;
  /** The AWS account this install runs in. A CloudWatch connection may not name a role in it; absent, that check is not made. */
  ownAccountId?: string | undefined;
}

/** The id of the secret version a connection's own save wrote (kept on the record, never shown); a connection reads exactly that version. */
const VERSION_FIELD = "secretVersion";

type JiraSecret = z.infer<(typeof ConnectionSecretSchemas)["jira"]>;

export interface ConnectionCheckRecord {
  ok: boolean;
  at: string;
}

/** A connection as members and administrators see it: no secret, no secret name and no vendor account id (`actorId`). */
export type OrgConnectionRecord = OrgConnection & {
  orgId: OrgId;
  hasSecret: boolean;
  /** A CloudWatch connection's external id, `rovara-<orgId>`: set by the server, shown so the customer can put it in the role's trust policy. It is not a secret. */
  externalId?: string;
  lastCheck?: ConnectionCheckRecord;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
};

export interface CheckResult {
  ok: boolean;
  message?: string;
}

/** One of the six monitoring connection types, as a record's settings. */
export type ObservabilityConnection = Extract<OrgConnection, { type: ObservabilityConnectionType }>;

/**
 * What a type's check is given: the org, the connection's settings and the saved secret (none for CloudWatch). It answers whether the
 * connection works, and may name the vendor account the secret belongs to (`actorId`). Its message must hold no part of the secret.
 */
export interface ConnectionCheckInput<T extends ObservabilityConnectionType = ObservabilityConnectionType> {
  orgId: OrgId;
  connection: Extract<OrgConnection, { type: T }>;
  secret: ConnectionSecret | undefined;
  /**
   * The only fetch a check may use to reach the vendor. A Grafana check's is pinned to the addresses checked for this very request, keeps to the
   * connection's origin and follows no redirect (`mcpEndpointGuard`); Sentry's, Datadog's, PagerDuty's and Vercel's are held to the vendor's fixed origin;
   * CloudWatch's refuses everything, since it speaks to AWS through its own client. A check must not build its own.
   */
  fetch: typeof fetch;
}

/** Each of the six types' check, supplied by its connector task (Tasks 13 to 16). A type with none answers that checking is not available yet. */
export type ConnectionChecks = { [T in ObservabilityConnectionType]?: (input: ConnectionCheckInput<T>) => Promise<CheckResult & { actorId?: string }> };

export interface OrgConnectionStoreInput extends OrgConnectionDeps {
  fetch?: typeof fetch;
  /**
   * Refuses an MCP endpoint that must not be called (`checkEndpointUrl` also resolves the host).
   * It throws, with a message safe to show, to refuse. Without it an MCP connection cannot be checked.
   */
  checkEndpoint?: (url: string) => Promise<void>;
  /** The checks of the monitoring connection types; see `ConnectionChecks`. */
  checks?: ConnectionChecks;
  /**
   * Checks an address a person typed (a Grafana base URL, an MCP endpoint) and gives the fetch pinned to the addresses it returned, for this request
   * only. `checkEndpoint` alone cannot do this: it forgets the addresses, so the connection would resolve the name again. Defaults to
   * `mcpEndpointGuard()`. The Grafana runtime connector must be built on the same guard (`HOST_TYPED_CONNECTOR_TYPES`).
   */
  endpointGuard?: McpEndpointGuard;
  listMcpTools?: typeof listMcpTools;
  /**
   * The audit sink. Saving or removing a connection adds the steps it stages to the write that changes the record
   * (after the secret, which is never part of an event). Absent: nothing is added.
   */
  audit?: AuditSink;
  /**
   * Told after a connection has been removed (and its removal committed), for what depends on it that lives elsewhere (the CloudWatch hooks of its AWS account). A failure is
   * logged by name and never undoes or fails the removal.
   */
  afterRemove?: (removed: { orgId: OrgId; connectionId: string; type: string; roleArn?: string }) => Promise<void>;
  /**
   * Told after a connection has been saved (and the save committed), for what follows from it that lives elsewhere (the Team record reads a newly connected Linear or Jira user list to link people). A failure is
   * logged by name and never undoes or fails the save.
   */
  afterSave?: (saved: { orgId: OrgId; connectionId: string; type: string; hasSecret: boolean }) => Promise<void>;
}

const CHECK_TIMEOUT_MS = 10_000;
/** The longest message a check may answer, in characters. */
const CHECK_MESSAGE_MAX = 300;
const DEFAULT_ENDPOINT_GUARD = mcpEndpointGuard();
const MAX_CHECK_RESPONSE_BYTES = 1_000_000;
export const LINEAR_GRAPHQL = "https://api.linear.app/graphql";
/** A Linear workspace's url key (`acme` in linear.app/acme/issue/ENG-1): lowercase letters, digits and hyphens. */
export const LINEAR_WORKSPACE_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/u;

const coded = (code: Parameters<typeof agentXError>[0], message: string) => agentXError(code, message);
const parseOrg = (orgId: string): OrgId => {
  const parsed = OrgIdSchema.safeParse(orgId);
  if (!parsed.success) throw coded("FORBIDDEN", "that is not an organization id");
  return parsed.data;
};

/** Every change names who made it (`"system"` for Rovara's own), so a person's change is never recorded as Rovara's by leaving it out. */
function requireActor(by: unknown): void {
  if (typeof by !== "string" || by === "") throw coded("CONFIG_INVALID", "by: say who is making this change");
}

/**
 * Where a saved secret goes, as a value that changes whenever the destination does, or undefined where it cannot change (Linear and Vercel have
 * one fixed vendor endpoint). A Jira, MCP or Grafana connection names a host; Sentry, Datadog and PagerDuty a region or site, each of which is another
 * vendor host; a CloudWatch connection names the role Rovara assumes. Moving it needs a new secret with it (CloudWatch has none, so what its last check learned is dropped).
 */
function secretHost(connection: OrgConnection): string | undefined {
  switch (connection.type) {
    case "jira": return new URL(connection.siteUrl).hostname;
    case "mcp": return new URL(connection.endpoint).hostname;
    case "grafana": return new URL(connection.baseUrl).hostname;
    case "sentry": return `sentry-region:${connection.region}`;
    case "datadog": return `datadog-site:${connection.site}`;
    case "pagerduty": return `pagerduty-region:${connection.region}`;
    case "cloudwatch": return `role:${connection.roleArn}`;
    case "linear":
    case "vercel": return undefined;
  }
}

/** The address a customer typed that Rovara will call, and what to call it in a refusal; undefined for the types that call only their vendor. */
function endpointTarget(connection: OrgConnection): { url: string; noun: string; what: string } | undefined {
  if (connection.type === "mcp") return { url: connection.endpoint, noun: "an MCP endpoint", what: "an MCP connection" };
  if (connection.type === "grafana") return { url: connection.baseUrl, noun: "a Grafana address", what: "a Grafana connection" };
  return undefined;
}

/**
 * A check's message as it may be recorded and shown: control, format and line-separator characters removed (they can hide or rewrite text on a terminal or page),
 * every value of the saved secret replaced with `[redacted]`, at most `CHECK_MESSAGE_MAX` characters, and none at all when nothing is left. A vendor's
 * reply that a careless check passes on, even one that quotes the token, is held to this too.
 */
function cleanMessage(message: string | undefined, secret?: ConnectionSecret): string | undefined {
  if (message === undefined) return undefined;
  // Cleaned first, so a secret split by a control character is whole again when it is looked for; redacted before the cap, so the cap cannot cut one in half.
  let cleaned = message.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
  for (const value of Object.values(secret ?? {})) if (typeof value === "string" && value !== "") cleaned = cleaned.split(value).join("[redacted]");
  cleaned = Array.from(cleaned).slice(0, CHECK_MESSAGE_MAX).join("").trim();
  return cleaned === "" ? undefined : cleaned;
}

const isObservability = (connection: OrgConnection): connection is ObservabilityConnection => ObservabilityConnectionTypeSchema.safeParse(connection.type).success;

function strip(item: Record<string, unknown>): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the keys
  const { pk: _pk, sk: _sk, entityType: _type, actorId: _actor, workspaceKey: _workspace, revision: _revision, secretVersion: _version, ...rest } = item;
  return rest;
}

/** The revision a record was read at; a record written before revisions has none. */
const revisionOf = (item: Item | undefined): number | undefined => (typeof item?.revision === "number" ? item.revision : undefined);

/** A condition on the revision a write read: a record with none must still have none. */
const atRevision = (revision: number | undefined) => (revision === undefined ? when.notExists("revision") : when.eq("revision", revision));

async function readItem(deps: Pick<OrgConnectionDeps, "store">, orgId: OrgId, connectionId: string): Promise<Item | undefined> {
  if (!ConnectionIdSchema.safeParse(connectionId).success) return undefined;
  return deps.store.get(connectionKey(orgId, connectionId));
}

async function listItems(deps: Pick<OrgConnectionDeps, "store">, orgId: OrgId): Promise<Item[]> {
  const directory: Item[] = [];
  let cursor: string | undefined;
  const pk = connectionsKey(orgId, "x").pk;
  do {
    const page = await deps.store.query({ pk, ...(cursor === undefined ? {} : { cursor }) });
    directory.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  const items = await Promise.all(directory.map((entry) => readItem(deps, orgId, String(entry.sk))));
  return items.filter((item): item is Item => item !== undefined);
}

/** The vendor account ids this org's connections of one type have checked as, to tell their own writes from a person's. */
export async function connectionActorIds(deps: Pick<OrgConnectionDeps, "store">, orgId: string, type: ConnectionType): Promise<Set<string>> {
  const org = parseOrg(orgId);
  const ids = new Set<string>();
  for (const item of await listItems(deps, org)) {
    if (item.type === type && typeof item.actorId === "string" && item.actorId !== "") ids.add(item.actorId);
  }
  return ids;
}

/**
 * The vendor account ids of this org's connections of one type that are marked as service identities: the accounts only Rovara uses, so what they make is Rovara's. A connection
 * made with a person's own key, or not marked, is left out, because that person's tickets are not Rovara's.
 */
export async function connectionServiceActorIds(deps: Pick<OrgConnectionDeps, "store">, orgId: string, type: ConnectionType): Promise<Set<string>> {
  const org = parseOrg(orgId);
  const ids = new Set<string>();
  for (const item of await listItems(deps, org)) {
    if (item.type === type && item.identity === "service" && typeof item.actorId === "string" && item.actorId !== "") ids.add(item.actorId);
  }
  return ids;
}

/**
 * The Linear workspace url keys this org's Linear connections have checked as (`acme`), to tell which workspace an issue key belongs to. A connection that was never checked, or whose check did not say, adds none.
 */
export async function connectionWorkspaceKeys(deps: Pick<OrgConnectionDeps, "store">, orgId: string): Promise<Set<string>> {
  const org = parseOrg(orgId);
  const keys = new Set<string>();
  for (const item of await listItems(deps, org)) {
    if (item.type === "linear" && typeof item.workspaceKey === "string" && LINEAR_WORKSPACE_KEY.test(item.workspaceKey)) keys.add(item.workspaceKey);
  }
  return keys;
}

/** Who a change is by: Rovara's own changes say `"system"`; anything else is a person's id. */
const auditActorOf = (by: string): AuditEvent["actor"] => (by === "system" ? { type: "system", id: "rovara" } : { type: "person", id: by });

/** A short stable id for one occurrence of a fact: the same request records it once. */
const occurrenceOf = (...parts: string[]): string => createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 32);

export class OrgConnectionStore {
  constructor(private readonly input: OrgConnectionStoreInput) {}

  private iso(): string {
    return new Date(this.input.now()).toISOString();
  }

  async get(orgId: string, connectionId: string): Promise<OrgConnectionRecord | undefined> {
    const item = await readItem(this.input, parseOrg(orgId), connectionId);
    return item === undefined ? undefined : (strip(item) as unknown as OrgConnectionRecord);
  }

  async list(orgId: string): Promise<OrgConnectionRecord[]> {
    return (await listItems(this.input, parseOrg(orgId))).map((item) => strip(item) as unknown as OrgConnectionRecord);
  }

  /**
   * Creates the connection, or changes an existing one. The secret is write-only: given, it replaces the saved one; absent,
   * the saved one stays. A saved secret is never sent to another host: pointing a connection at a different site or
   * endpoint host needs a new secret with it. An MCP endpoint is checked first and the save is refused if it may not be called.
   * The write is conditional on the revision it read, and carries the request's own item (R18) when `request` is given.
   */
  async put(input: {
    orgId: string; connection: unknown; secret?: unknown;
    /** Who saves it; Rovara's own changes say `"system"`. */
    by: string;
    /** The request's id, when it has one: it makes the audit event's occurrence. */
    requestId?: string;
    /** The request item written with the change (R18); its `requestId` is also the audit occurrence when `requestId` is not given. */
    request?: RequestMark;
    /** Change only a connection that exists: a route's PUT never makes up an id. */
    requireExisting?: boolean;
    /** Create only: an id that exists is refused, and the write itself is conditional on there being none (a create never overwrites). */
    requireNew?: boolean;
    /** Change only the record as this caller read it (its revision, 0 for none): a record that moved since is refused as stale, whatever a second read in here would find. */
    expectRevision?: number;
  }): Promise<OrgConnectionRecord> {
    const orgId = parseOrg(input.orgId);
    requireActor(input.by);
    const requestId = input.requestId ?? input.request?.requestId;
    // The monitoring types are read-only: asking for more says so in the plan's words, before anything else is judged.
    if (typeof input.connection === "object" && input.connection !== null) {
      const { type, access } = input.connection as { type?: unknown; access?: unknown };
      const readOnly = ObservabilityConnectionTypeSchema.safeParse(type);
      if (readOnly.success && access !== undefined && access !== "read") throw coded("CONFIG_INVALID", readOnlyConnectionMessage(readOnly.data));
    }
    const parsed = OrgConnectionSchema.safeParse(input.connection);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      // An unknown field's name is not echoed: a client can put anything, a secret included, where a field name goes.
      throw coded("CONFIG_INVALID", `connection${first && first.path.length > 0 ? `.${first.path.join(".")}` : ""}: ${first === undefined ? "is not valid" : first.code === "unrecognized_keys" ? "has a field this kind of connection does not take" : first.message}`);
    }
    const connection = parsed.data;
    // Rovara assumes the customer's role from its own account: a role in that account is never the customer's, and would let the session reach Rovara's own.
    if (connection.type === "cloudwatch" && this.input.ownAccountId !== undefined && cloudwatchRoleAccount(connection.roleArn) === this.input.ownAccountId) {
      throw coded("CONFIG_INVALID", "roleArn: use a role in your own AWS account");
    }
    let secretJson: string | undefined;
    let pendingJira: JiraSecret | undefined;
    if (input.secret !== undefined) {
      if (!connectionTakesSecret(connection.type)) throw coded("CONFIG_INVALID", `secret: a ${connection.type} connection takes no secret`);
      const schema = ConnectionSecretSchemas[connection.type];
      const secret = schema.safeParse(input.secret);
      if (!secret.success) throw coded("CONFIG_INVALID", `secret: a ${connection.type} connection takes ${Object.keys(schema.shape).join(", ")} and nothing else`);
      secretJson = JSON.stringify(secret.data);
      if (connection.type === "jira") pendingJira = secret.data as JiraSecret;
    }
    const target = endpointTarget(connection);
    if (target !== undefined) {
      // Refused before anything is written, and with no endpoint check at all the save is refused too: nothing here may be called unchecked.
      if (this.input.checkEndpoint === undefined) throw coded("CONFIG_INVALID", `this deployment cannot check ${target.noun}, so it cannot save ${target.what}`);
      await this.input.checkEndpoint(target.url);
    }
    const existing = await readItem(this.input, orgId, connection.connectionId);
    if (existing === undefined && input.requireExisting === true) throw coded("NOT_FOUND", "no connection has that ID");
    if (input.expectRevision !== undefined && (revisionOf(existing) ?? 0) !== input.expectRevision) throw coded("CHANGE_STALE", "that connection changed while you were saving it; try again");
    if (existing !== undefined && input.requireNew === true) throw coded("CONFIG_INVALID", "requestId: this request ID was already used; send a new one");
    if (existing !== undefined && existing.type !== connection.type) throw coded("CONFIG_INVALID", "connection.type: a connection's type cannot change; remove it and add a new one");
    // The Jira organization admin key and its organization id are kept by a later save that leaves them out (the web and the CLI send only the email and token); `clearOrgAdmin: true` removes them. Nothing of the
    // stored secret is read for any other purpose, and the flag is never stored.
    if (pendingJira !== undefined) {
      const { clearOrgAdmin, ...rest } = pendingJira;
      let merged: Omit<JiraSecret, "clearOrgAdmin"> = rest;
      if (rest.orgAdminKey === undefined && clearOrgAdmin !== true && existing !== undefined && existing.hasSecret === true && existing.type === "jira") {
        const stored = await readConnectionSecret(this.input, orgId, { connectionId: connection.connectionId, type: "jira", ...(typeof existing[VERSION_FIELD] === "string" ? { secretVersion: existing[VERSION_FIELD] } : {}) }).catch(() => undefined);
        const kept = stored !== undefined && "orgAdminKey" in stored && "atlassianOrgId" in stored && typeof stored.orgAdminKey === "string" && typeof stored.atlassianOrgId === "string" ? { orgAdminKey: stored.orgAdminKey, atlassianOrgId: stored.atlassianOrgId } : undefined;
        if (kept !== undefined) merged = { ...rest, ...kept };
      }
      secretJson = JSON.stringify(merged);
    }
    const movedHost = existing !== undefined && secretHost(OrgConnectionSchema.parse(pick(existing))) !== secretHost(connection);
    if (movedHost && secretJson === undefined && existing.hasSecret === true) {
      throw coded("CONFIG_INVALID", "connection: the saved secret would be sent to a different host; give the new secret with it");
    }
    // The secret first, as a new version whose id the record keeps, written by the same conditional commit that decides which save won. A save
    // that loses leaves its version in Secrets Manager but nothing refers to it, so it is never read, whatever order the writes landed in.
    const secretVersion = secretJson === undefined ? undefined : await this.input.secrets.put(orgId, orgConnectorSecretName(this.input.env, orgId, connection.connectionId), secretJson);
    const at = this.iso();
    // A new secret may belong to another vendor account, so what the last check learned is dropped with the old one.
    const keepsAccount = existing !== undefined && !movedHost && secretJson === undefined;
    const record: Record<string, unknown> = {
      ...connectionKey(orgId, connection.connectionId),
      entityType: "ORG_CONNECTION",
      orgId,
      ...connection,
      // The server's own, never the body's (the body's would be an unknown field): the id the customer's role must require.
      ...(connection.type === "cloudwatch" ? { externalId: cloudwatchExternalId(orgId) } : {}),
      hasSecret: secretJson !== undefined || existing?.hasSecret === true,
      ...(secretVersion !== undefined ? { [VERSION_FIELD]: secretVersion } : typeof existing?.[VERSION_FIELD] === "string" ? { [VERSION_FIELD]: existing[VERSION_FIELD] } : {}),
      ...(keepsAccount && existing.lastCheck !== undefined ? { lastCheck: existing.lastCheck } : {}),
      ...(keepsAccount && typeof existing.actorId === "string" ? { actorId: existing.actorId } : {}),
      revision: (revisionOf(existing) ?? 0) + 1,
      createdBy: typeof existing?.createdBy === "string" ? existing.createdBy : input.by,
      createdAt: typeof existing?.createdAt === "string" ? existing.createdAt : at,
      updatedBy: input.by,
      updatedAt: at,
    };
    // Plain JSON for the store (an optional field left undefined is not written).
    const item = JSON.parse(JSON.stringify(record)) as StoredDocument;
    // The event names the connection and its type, never the label or any part of the secret.
    const event: AuditEvent = {
      eventId: requestId === undefined ? occurrenceOf("connection.saved", connection.connectionId, at) : occurrenceOf("connection.saved", requestId, connection.connectionId),
      companyId: orgId, at, actor: auditActorOf(input.by), action: "connection.saved",
      subject: { type: "connection", id: connection.connectionId }, details: { connectorType: connection.type },
    };
    const staged = this.input.audit?.stage(event) ?? [];
    const saved = strip(record) as unknown as OrgConnectionRecord;
    // The record, the directory entry, the audit steps and the request item commit together or not at all. The record is written only
    // if it is as it was read: a change that landed meanwhile refuses this one instead of being overwritten.
    const stale = coded("CHANGE_STALE", "that connection changed while you were saving it; try again");
    if (existing === undefined) {
      await commitWithMark(this.input, [
        { kind: "put", item, condition: when.absent() },
        { kind: "put", item: { ...connectionsKey(orgId, connection.connectionId), entityType: "ORG_CONNECTION_DIRECTORY", orgId, connectionId: connection.connectionId }, condition: when.absent() },
        ...staged,
      ], (failed) => (failed.has(0) || failed.has(1) ? stale : undefined), input.request, saved);
    } else {
      await commitWithMark(this.input, [
        { kind: "put", item, condition: when.and(when.present(), atRevision(revisionOf(existing))) },
        ...staged,
      ], (failed) => (failed.has(0) ? stale : undefined), input.request, saved);
    }
    await this.input.afterSave?.({ orgId, connectionId: connection.connectionId, type: connection.type, hasSecret: saved.hasSecret }).catch((error: unknown) => {
      console.log(JSON.stringify({ component: "broker", event: "connection.after_save_failed", orgId, connectionId: connection.connectionId, error: error instanceof Error ? error.name : "unknown" }));
    });
    return saved;
  }

  /** Removes the connection and schedules its secret for deletion (7 days to recover it). */
  async remove(input: {
    orgId: string; connectionId: string;
    /** Who removed it; Rovara's own removals say `"system"`. */
    by: string;
    /** The request's id, when it has one: it makes the audit event's occurrence. */
    requestId?: string;
    /** The request item written with the removal (R18). */
    request?: RequestMark;
  }): Promise<void> {
    const orgId = parseOrg(input.orgId);
    requireActor(input.by);
    const requestId = input.requestId ?? input.request?.requestId;
    const existing = await readItem(this.input, orgId, input.connectionId);
    if (existing === undefined) throw coded("NOT_FOUND", "no connection has that ID");
    if (existing.hasSecret === true) await this.input.secrets.scheduleDelete(orgId, orgConnectorSecretName(this.input.env, orgId, input.connectionId));
    const at = this.iso();
    const event: AuditEvent = {
      eventId: requestId === undefined ? occurrenceOf("connection.removed", input.connectionId, at) : occurrenceOf("connection.removed", requestId, input.connectionId),
      companyId: orgId, at, actor: auditActorOf(input.by), action: "connection.removed",
      subject: { type: "connection", id: input.connectionId }, details: { connectorType: typeof existing.type === "string" ? existing.type : "" },
    };
    await commitWithMark(this.input, [
      // Of two removes at once only one commits, and only that one records.
      { kind: "delete", key: connectionKey(orgId, input.connectionId), condition: when.present() },
      { kind: "delete", key: connectionsKey(orgId, input.connectionId) },
      ...(this.input.audit?.stage(event) ?? []),
    ], (failed) => (failed.has(0) ? coded("NOT_FOUND", "no connection has that ID") : undefined), input.request, { removed: true });
    await this.input.afterRemove?.({ orgId, connectionId: input.connectionId, type: typeof existing.type === "string" ? existing.type : "", ...(typeof existing.roleArn === "string" ? { roleArn: existing.roleArn } : {}) }).catch((error: unknown) => {
      console.log(JSON.stringify({ component: "broker", event: "connection.after_remove_failed", orgId, connectionId: input.connectionId, error: error instanceof Error ? error.name : "unknown" }));
    });
  }

  /**
   * Asks the vendor who the saved secret belongs to (Linear `viewer { id }`, Jira `GET <siteUrl>/rest/api/3/myself`) or, for
   * MCP, lists the server's tools. Linear and Jira keep the account id as `actorId`. A message never holds the secret.
   * What the check learned is written only if the connection is still as it was read: a secret saved meanwhile may belong to another
   * account, and its record must not take the old one's. With `request`, the result and the request item (R18) commit together.
   */
  async check(orgId: string, connectionId: string, request?: RequestMark): Promise<CheckResult> {
    const org = parseOrg(orgId);
    const item = await readItem(this.input, org, connectionId);
    if (item === undefined) throw coded("NOT_FOUND", "no connection has that ID");
    const connection = OrgConnectionSchema.parse(pick(item));
    const target = endpointTarget(connection);
    if (target !== undefined && this.input.checkEndpoint === undefined) {
      throw coded("CONFIG_INVALID", `this deployment cannot check ${target.noun}, so it cannot check ${target.what}`);
    }
    let result: CheckResult & { actorId?: string; workspaceKey?: string };
    let held: ConnectionSecret | undefined;
    if (!connectionTakesSecret(connection.type)) {
      // CloudWatch has no secret: its connector assumes the customer's role.
      result = await this.ask(org, connection, undefined);
    } else if (item.hasSecret !== true) {
      result = { ok: false, message: "no secret has been saved for this connection yet" };
    } else {
      const secret = await readConnectionSecret(this.input, org, { connectionId, type: connection.type, ...(versionOf(item) === undefined ? {} : { secretVersion: versionOf(item)! }) });
      result = secret === undefined
        ? { ok: false, message: "the saved secret could not be read; save it again" }
        : await this.ask(org, connection, (held = secret));
    }
    const message = cleanMessage(result.message, held);
    const answer: CheckResult = message === undefined ? { ok: result.ok } : { ok: result.ok, message };
    await this.record(org, connectionId, revisionOf(item), result, answer, request);
    return answer;
  }

  private async record(orgId: OrgId, connectionId: string, read: number | undefined, result: CheckResult & { actorId?: string; workspaceKey?: string }, answer: CheckResult, request?: RequestMark): Promise<void> {
    const ops = [set.set("lastCheck", { ok: result.ok, at: this.iso() })];
    if (result.ok && result.actorId !== undefined) {
      ops.push(set.set("actorId", result.actorId));
      // A Linear check also learns the workspace's url key (the `<key>` in linear.app/<key>/issue/ENG-1): an issue key alone does not say which workspace it is in. Kept like the account id, never shown.
      if (result.workspaceKey !== undefined) ops.push(set.set("workspaceKey", result.workspaceKey));
    }
    const raced = new Error("the connection changed while it was being checked");
    try {
      await commitWithMark(this.input, [{ kind: "update", key: connectionKey(orgId, connectionId), ops, condition: when.and(when.present(), atRevision(read)) }], (failed) => (failed.has(0) ? raced : undefined), request, answer);
    } catch (error) {
      // The connection was removed or changed while it was being checked: there is nothing true to record on it, and no request item either.
      if (error !== raced) throw error;
    }
  }

  /** Rovara's own checks for Linear, Jira and MCP; the monitoring types go to the check their adapter supplies. */
  private async ask(orgId: OrgId, connection: OrgConnection, secret: ConnectionSecret | undefined): Promise<CheckResult & { actorId?: string; workspaceKey?: string }> {
    if (isObservability(connection)) return this.askObservability(orgId, connection, secret);
    if (secret === undefined) return { ok: false, message: "the saved secret could not be read; save it again" };
    const fetchImplementation = this.input.fetch ?? fetch;
    const token = connectionSecretToken(connection.type, secret);
    if (connection.type === "mcp") return this.askMcp(connection, token);
    const vendor = connection.type === "linear" ? "Linear" : "Jira";
    try {
      const response = connection.type === "linear"
        ? await fetchImplementation(LINEAR_GRAPHQL, {
          method: "POST",
          headers: { authorization: token, "content-type": "application/json" },
          body: JSON.stringify({ query: "query { viewer { id organization { urlKey } } }" }),
          redirect: "error",
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        })
        : await fetchImplementation(`${connection.siteUrl}/rest/api/3/myself`, {
          method: "GET",
          headers: { authorization: `Basic ${Buffer.from(`${(secret as { email: string }).email}:${token}`).toString("base64")}`, accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        });
      if (!response.ok) return { ok: false, message: `${vendor} refused the saved secret (HTTP ${String(response.status)})` };
      const text = await readCapped(response, MAX_CHECK_RESPONSE_BYTES);
      if (text === undefined) return { ok: false, message: `${vendor} answered with more than a check should return` };
      const body: unknown = JSON.parse(text);
      const actorId = connection.type === "linear"
        ? ((body as { data?: { viewer?: { id?: unknown } } })?.data?.viewer?.id)
        : (body as { accountId?: unknown })?.accountId;
      if (typeof actorId !== "string" || actorId === "") return { ok: false, message: `${vendor} did not say whose secret this is` };
      const urlKey = connection.type === "linear" ? (body as { data?: { viewer?: { organization?: { urlKey?: unknown } } } })?.data?.viewer?.organization?.urlKey : undefined;
      const workspaceKey = typeof urlKey === "string" && LINEAR_WORKSPACE_KEY.test(urlKey.toLowerCase()) ? urlKey.toLowerCase() : undefined;
      return { ok: true, actorId, ...(workspaceKey === undefined ? {} : { workspaceKey }) };
    } catch {
      // The message of a network error can quote the request; only the vendor is named.
      return { ok: false, message: `could not reach ${vendor} to check the saved secret` };
    }
  }

  /** Why the customer's address may not be called, as a failed check, or undefined when it may (or the type has none). A lookup that failed is thrown. */
  private async endpointRefusal(connection: OrgConnection): Promise<CheckResult | undefined> {
    const target = endpointTarget(connection);
    if (target === undefined) return undefined;
    try {
      await this.input.checkEndpoint!(target.url);
    } catch (error) {
      // A lookup that failed says nothing about the endpoint: it is retryable, so it is neither recorded as a failed check nor remembered as one.
      if ((error as { code?: unknown } | null)?.code === "RUNTIME_UNAVAILABLE") throw error;
      return { ok: false, message: error instanceof Error ? error.message : "the endpoint is not allowed" };
    }
    return undefined;
  }

  /**
   * The address a person typed, checked now, and the fetch pinned to the addresses that check returned; or why it may not be called. A lookup that
   * failed is thrown (retryable, never recorded), as `endpointRefusal` does.
   */
  private async pinnedFetchFor(endpoint: string): Promise<{ fetch: typeof fetch } | { refused: CheckResult }> {
    try {
      return { fetch: await (this.input.endpointGuard ?? DEFAULT_ENDPOINT_GUARD)(new URL(endpoint)) };
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "RUNTIME_UNAVAILABLE") throw error;
      return { refused: { ok: false, message: error instanceof Error ? error.message : "the endpoint is not allowed" } };
    }
  }

  /** The only fetch a type's check is given (see `ConnectionCheckInput.fetch`). */
  private async checkFetch(connection: ObservabilityConnection): Promise<{ fetch: typeof fetch } | { refused: CheckResult }> {
    if (connection.type === "grafana") return this.pinnedFetchFor(connection.baseUrl);
    if (connection.type === "cloudwatch") return { fetch: noWebRequests };
    // Held to the vendor's host and, unless a test injects one, over the same lookup-checked fetch as the tools: an address that is not public is refused when it connects.
    return { fetch: originHeldFetch(this.input.fetch ?? safeVendorFetch(), vendorHostOf(connection)!) };
  }

  private async askObservability(orgId: OrgId, connection: ObservabilityConnection, secret: ConnectionSecret | undefined): Promise<CheckResult & { actorId?: string }> {
    // A customer's Grafana address is checked here, before the type's check can call it.
    const refused = await this.endpointRefusal(connection);
    if (refused !== undefined) return refused;
    const check = this.input.checks?.[connection.type] as ((input: ConnectionCheckInput) => Promise<CheckResult & { actorId?: string }>) | undefined;
    if (check === undefined) return { ok: false, message: `checking a ${connection.type} connection is not available yet` };
    const held = await this.checkFetch(connection);
    if ("refused" in held) return held.refused;
    try {
      return await check({ orgId, connection, secret, fetch: held.fetch });
    } catch (error) {
      // What a check threw can quote the request or the secret, so only the type is named. A failure to reach the vendor is retryable and not recorded.
      if ((error as { code?: unknown } | null)?.code === "RUNTIME_UNAVAILABLE") throw coded("RUNTIME_UNAVAILABLE", `could not reach ${connection.type} to check the connection; try again`);
      return { ok: false, message: `could not check the ${connection.type} connection` };
    }
  }

  private async askMcp(connection: Extract<OrgConnection, { type: "mcp" }>, token: string): Promise<CheckResult> {
    const refused = await this.endpointRefusal(connection);
    if (refused !== undefined) return refused;
    // The tool listing goes over a connection pinned to the addresses checked now, not one that resolves the name again.
    const held = await this.pinnedFetchFor(connection.endpoint);
    if ("refused" in held) return held.refused;
    try {
      const tools = await (this.input.listMcpTools ?? listMcpTools)({
        endpoint: new URL(connection.endpoint),
        token,
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        ...(connection.auth === undefined ? {} : { auth: connection.auth }),
        fetchImplementation: held.fetch,
      });
      return { ok: true, message: `${String(tools.length)} tool${tools.length === 1 ? "" : "s"}` };
    } catch (error) {
      return { ok: false, message: error instanceof Error && error.name === "McpUnauthorized" ? "the server rejected the saved token" : "could not list the server's tools" };
    }
  }
}

/**
 * The response body as text, or undefined when it is longer than `limit` bytes. It counts the bytes actually read and stops
 * reading at the cap, so a chunked or understated response cannot be pulled into memory in full.
 */
async function readCapped(response: Response, limit: number): Promise<string | undefined> {
  if (response.body === null) return "";
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The connection's settings out of a stored item. */
function pick(item: Record<string, unknown>): unknown {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the bookkeeping fields
  const { pk: _pk, sk: _sk, entityType: _type, orgId: _org, hasSecret: _has, externalId: _external, actorId: _actor, workspaceKey: _workspace, lastCheck: _check, revision: _revision, secretVersion: _version, createdBy: _by, createdAt: _at, updatedBy: _ub, updatedAt: _ua, ...settings } = item;
  return settings;
}

/** A stored record's settings as the connection they describe (never its secret, status or bookkeeping), or undefined when they do not parse. */
export function connectionOf(record: Record<string, unknown>): OrgConnection | undefined {
  const parsed = OrgConnectionSchema.safeParse(pick(record));
  return parsed.success ? parsed.data : undefined;
}

/** The secret version a record names (undefined for a record that predates versions: the current one is read). */
const versionOf = (item: Item): string | undefined => (typeof item[VERSION_FIELD] === "string" ? item[VERSION_FIELD] : undefined);

/** A stored secret, or undefined when it is not the shape its type takes. */
function parseSecret(type: SecretConnectionType, raw: string): ConnectionSecret | undefined {
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return undefined; }
  const parsed = ConnectionSecretSchemas[type].safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Reads a connection's stored secret whole, in the shape its type takes (a Datadog connection's API and application keys both), or undefined when
 * there is none, it is not that shape, or the type has none (CloudWatch). It reads the version the connection's own save wrote, so pass the record
 * `readConnection` returns, not a view.
 */
export async function readConnectionSecret(deps: OrgConnectionDeps, orgId: OrgId, connection: { connectionId: string; type: ConnectionType; secretVersion?: string }): Promise<ConnectionSecret | undefined> {
  if (!connectionTakesSecret(connection.type)) return undefined;
  const raw = await deps.secrets.read(orgId, orgConnectorSecretName(deps.env, orgId, connection.connectionId), connection.secretVersion);
  return raw === undefined ? undefined : parseSecret(connection.type, raw);
}

/** Reads a connection's stored secret as its one value, for the credential registry. */
export async function readConnectionToken(deps: OrgConnectionDeps, orgId: OrgId, connection: { connectionId: string; type: ConnectionType; secretVersion?: string }): Promise<string | undefined> {
  const secret = await readConnectionSecret(deps, orgId, connection);
  return secret === undefined || !connectionTakesSecret(connection.type) ? undefined : connectionSecretToken(connection.type, secret);
}

/** Reads one connection for the credential registry, with the fields the store keeps back from members. */
export async function readConnection(deps: OrgConnectionDeps, orgId: OrgId, connectionId: string): Promise<(OrgConnectionRecord & { actorId?: string; secretVersion?: string }) | undefined> {
  const item = await readItem(deps, orgId, connectionId);
  return item === undefined ? undefined : (item as unknown as OrgConnectionRecord);
}
