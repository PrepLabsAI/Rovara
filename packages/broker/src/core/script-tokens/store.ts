// Script tokens: the stored tokens, over the document store port. A token is a `META` item in its own partition (`scriptTokenKey`) holding the hash of the token, never
// the token, and a row in the company's list (`orgScriptTokensKey`). Both are written in one transaction with the request's own mark and the audit event the audit sink stages. Revoking marks both
// `revokedAt` in one transaction with its audit event. Every item expires by the store's TTL a month after the token's own end, so dead tokens leave nothing behind. The list row only says where to
// look: the record decides.
//
// The keys and the record are Cloud's (decision 45.6). Differences, all additive or wider: a record also keeps `personId` (the identity port is asked for the creator by Rovara id; Cloud's reader strips
// the field), and `amr` may also be `local` (the sign-in method of a laptop's owner). Cloud also refuses to make or use a token without its audit ledger; here the audit sink is a port whose
// default writes nothing, but `rovara up` registers the document audit sink (the events are kept in the install's own audit trail), and the audit steps are staged whatever the sink is.
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CreateScriptTokenBodySchema,
  INDEX_EXPIRY_ATTRIBUTE,
  OrgIdSchema,
  OrgRoleSchema,
  SCRIPT_TOKEN_DEFAULT_DAYS,
  SCRIPT_TOKEN_MAX_DAYS,
  SCRIPT_TOKENS_LIMIT_MESSAGE,
  SCRIPT_TOKENS_PER_PERSON_MAX,
  SCRIPT_TOKEN_PROJECTS_MAX,
  ScriptTokenIdSchema,
  ScriptTokenNameSchema,
  ScriptTokenPermissionSchema,
  agentRequestKey,
  agentXError,
  canonicalJson,
  change,
  companyScoped,
  newPrefixedId,
  orgScriptTokensKey,
  scriptTokenKey,
  when,
  type AuditEvent,
  type AuditSink,
  type DeveloperSignInMethod,
  type DocumentStore,
  type OrgId,
  type OrgRole,
  type ScriptTokenPermission,
  type ScriptTokenView,
  type StoredDocument,
  type TransactItem,
  type CreatedScriptToken,
} from "@agentx/contracts";
import { mintScriptToken, scriptTokenHint } from "./token-format.js";
import { takeRate } from "./rate.js";

export interface ScriptTokenDependencies {
  store: DocumentStore;
  audit: AuditSink;
  now: () => number;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

/** Who makes, lists or revokes tokens: a signed-in person, with their live role. `personId` is Rovara's id for them (the identity port's), `developerId` the hash the sessions name them by. */
export interface ScriptTokenCaller {
  developerId: string;
  personId: string;
  orgId: OrgId;
  orgRole: OrgRole;
}

const DAY_MS = 86_400_000;
/** How long a dead token's items stay before the TTL deletes them: a month after the token's end (or its revocation). */
const KEEP_AFTER_END_DAYS = 30;
/** A person makes at most this many tokens an hour. */
export const SCRIPT_TOKEN_CREATES_PER_HOUR = 10;
/** List rows read per page, and pages at most: a company's list holds at most a few hundred rows that have not expired. */
const ROWS_PER_PAGE = 100;
const ROW_PAGES_MAX = 20;
/** How often a token's "last used" time is written at most (the day's first use is always written, with its audit event). */
export const LAST_USED_EVERY_MS = 5 * 60_000;
/** How long a request id is remembered, so a repeat of making a token is refused and never answered with the token. */
const REQUEST_MEMORY_DAYS = 7;
const REVOKE_TRIES = 3;

/** The sign-in methods a stored record may name: Cloud's, and `local` for the owner of a laptop. */
const METHODS = ["slack", "oidc", "cloud", "github", "saml", "local"] as const satisfies readonly (DeveloperSignInMethod | "local")[];
const Instant = z.string().datetime();

/** A token as stored. `secretHash` is the SHA-256 hex of the token. `createdRole` is the creator's company role when they made it: the token works only while it is still theirs. */
export const ScriptTokenRecordSchema = z.object({
  orgId: OrgIdSchema,
  tokenId: ScriptTokenIdSchema,
  developerId: z.string().regex(/^[a-f0-9]{64}$/),
  /** Code only: Rovara's id for the creator, so the identity port can be asked whether they still hold the role. Absent on a record Cloud made. */
  personId: z.string().min(1).max(200).optional(),
  name: ScriptTokenNameSchema,
  projects: z.array(z.string()).min(1).max(SCRIPT_TOKEN_PROJECTS_MAX),
  permissions: z.array(ScriptTokenPermissionSchema).min(1),
  createdAt: Instant,
  expiresAt: Instant,
  createdRole: OrgRoleSchema,
  amr: z.enum(METHODS),
  secretHash: z.string().regex(/^[0-9a-f]{64}$/),
  lastUsedAt: Instant.optional(),
  lastUsedDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  revokedAt: Instant.optional(),
  /** A person's id, or `rovara` when Rovara revoked it because its creator's access changed. */
  revokedBy: z.union([z.string().regex(/^[a-f0-9]{64}$/), z.literal("rovara")]).optional(),
  identityKey: z.string().min(1).max(200).optional(),
  authTime: Instant.optional(),
}).strip();
export type ScriptTokenRecord = z.infer<typeof ScriptTokenRecordSchema>;

const isAdmin = (role: OrgRole) => role === "owner" || role === "admin";
const isoOf = (ms: number) => new Date(ms).toISOString();
const keepUntil = (endMs: number) => Math.floor(endMs / 1000) + KEEP_AFTER_END_DAYS * 86_400;
const log = (deps: ScriptTokenDependencies, entry: Record<string, unknown>) => (deps.log ?? ((line: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);
const notFound = () => agentXError("NOT_FOUND", "script token not found");
const sha256 = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

/** Whether the token's own record lets it work now: not revoked, not past its end, and never made for longer than the cap. */
export function scriptTokenStatus(record: ScriptTokenRecord, nowMs: number): "active" | "expired" | "revoked" {
  if (record.revokedAt !== undefined) return "revoked";
  const created = Date.parse(record.createdAt);
  const expires = Date.parse(record.expiresAt);
  if (!(expires > nowMs) || !(expires - created <= SCRIPT_TOKEN_MAX_DAYS * DAY_MS)) return "expired";
  return "active";
}

function viewOf(record: ScriptTokenRecord, nowMs: number, viewer: string, createdBy?: string): ScriptTokenView {
  const mine = record.developerId === viewer;
  return {
    tokenId: record.tokenId, name: record.name, hint: scriptTokenHint(record.tokenId), projects: record.projects, permissions: record.permissions,
    createdAt: record.createdAt, expiresAt: record.expiresAt, ...(record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt }),
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }), status: scriptTokenStatus(record, nowMs), mine,
    ...(mine || createdBy === undefined ? {} : { createdBy }),
  };
}

/** The error text for a body that doesn't fit: the first field that is wrong, never the value. */
function invalidBody(issue: { path: PropertyKey[]; code: string; message: string } | undefined): Error {
  const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.map(String).join(".");
  return agentXError("CONFIG_INVALID", `${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
}

/** A stored document as a plain JSON record (the store's documents carry their key). */
const document = (key: { pk: string; sk: string }, fields: Record<string, unknown>): StoredDocument => ({ ...key, ...fields });

// ---- reading

/** The record under a token id in a company, if it is that company's and well formed (revoked or expired records are returned; the caller decides). */
export async function readScriptToken(deps: Pick<ScriptTokenDependencies, "store" | "log">, orgId: OrgId, tokenId: string): Promise<ScriptTokenRecord | undefined> {
  const id = ScriptTokenIdSchema.safeParse(tokenId);
  if (!id.success) return undefined;
  const item = await deps.store.get(scriptTokenKey(orgId, id.data));
  if (item === undefined) return undefined;
  const parsed = ScriptTokenRecordSchema.safeParse(item);
  if (!parsed.success || parsed.data.orgId !== orgId || parsed.data.tokenId !== id.data) {
    log(deps as ScriptTokenDependencies, { event: "script_tokens.record_unreadable", orgId });
    return undefined;
  }
  return parsed.data;
}

/** Every token record of the company (or one person's), read through the list rows. `complete` is false when the pages ran out first. */
async function readTokens(deps: ScriptTokenDependencies, orgId: OrgId, developerId: string | undefined): Promise<{ records: ScriptTokenRecord[]; complete: boolean }> {
  const records: ScriptTokenRecord[] = [];
  let cursor: string | undefined;
  const partition = orgScriptTokensKey(orgId, "stk_00000000000000000000").pk;
  for (let page = 0; page < ROW_PAGES_MAX; page += 1) {
    const answer = await deps.store.query({ pk: partition, limit: ROWS_PER_PAGE, ...(cursor === undefined ? {} : { cursor }) });
    const ids = answer.items.filter((row) => developerId === undefined || row["developerId"] === developerId).map((row) => String(row.sk));
    const found = await Promise.all(ids.map((id) => readScriptToken(deps, orgId, id)));
    for (const record of found) if (record !== undefined && (developerId === undefined || record.developerId === developerId)) records.push(record);
    cursor = answer.cursor;
    if (cursor === undefined) return { records, complete: true };
  }
  return { records, complete: false };
}

/**
 * The caller's own tokens; an owner or admin also sees every other token in the company (to revoke it), with its creator's name. Newest first.
 * `nameOf` gives a person's display name (never an email address).
 */
export async function listScriptTokens(deps: ScriptTokenDependencies, caller: ScriptTokenCaller, nameOf: (developerId: string) => Promise<string | undefined>): Promise<ScriptTokenView[]> {
  const { records, complete } = await readTokens(deps, caller.orgId, isAdmin(caller.orgRole) ? undefined : caller.developerId);
  if (!complete) log(deps, { event: "script_tokens.list_truncated", orgId: caller.orgId });
  const names = new Map<string, string | undefined>();
  for (const record of records) if (record.developerId !== caller.developerId && !names.has(record.developerId)) names.set(record.developerId, await nameOf(record.developerId));
  const now = deps.now();
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.tokenId.localeCompare(b.tokenId))
    .map((record) => viewOf(record, now, caller.developerId, names.get(record.developerId)));
}

const liveCount = (records: ScriptTokenRecord[], nowMs: number) => records.filter((record) => scriptTokenStatus(record, nowMs) === "active").length;

// ---- audit

type Occurrence = (tokenId: string, kind: string) => string;
const occurrence: Occurrence = (tokenId, kind) => `${tokenId}\n${kind}`;
const eventId = (action: string, key: string): string => createHash("sha256").update(`${action}\n${key}`).digest("hex");

function auditEvent(input: { orgId: OrgId; at: string; actor: AuditEvent["actor"]; action: string; key: string; tokenId: string; related?: string; details?: Record<string, string | number> }): AuditEvent {
  return {
    eventId: eventId(input.action, input.key), companyId: input.orgId, at: input.at, actor: input.actor, action: input.action,
    subject: { type: "script_token", id: input.tokenId },
    details: { tokenId: input.tokenId, ...(input.related === undefined ? {} : { related: input.related }), ...(input.details ?? {}) },
  };
}

// ---- making

/**
 * Makes a token for the caller, on projects they can reach today (`checkProject` refuses one they can't), and returns it this once. The request's own item remembers only the token's id: a repeat of
 * the request is refused, never answered with the token. A person keeps at most `SCRIPT_TOKENS_PER_PERSON_MAX` live tokens, counted from what is stored; two requests can pass the count together,
 * so the list is read again after the write and a request that finds more takes its own token back and is refused.
 *
 * Who may call this is the surface's rule, not this function's: in Code only a local page the owner opened a few minutes ago does (never the API token, which an AI tool holds).
 */
export async function createScriptToken(deps: ScriptTokenDependencies, caller: ScriptTokenCaller, body: unknown, checkProject: (project: string) => Promise<void>, options: { lifetimeCapSeconds?: number } = {}): Promise<CreatedScriptToken> {
  const parsed = CreateScriptTokenBodySchema.safeParse(body);
  if (!parsed.success) throw invalidBody(parsed.error.issues[0]);
  const input = parsed.data;
  const days = input.days ?? SCRIPT_TOKEN_DEFAULT_DAYS;
  const projects = [...input.projects].sort();
  const permissions = (["read", "start", "lessons"] as const).filter((permission) => input.permissions.includes(permission));
  const { orgId, developerId } = caller;
  const fingerprint = sha256({ route: "script_token_create", name: input.name, projects, permissions, days });
  const markKey = agentRequestKey(orgId, developerId, input.requestId);
  const earlier = await deps.store.get(markKey);
  const earlierExpires = earlier?.[INDEX_EXPIRY_ATTRIBUTE];
  if (earlier !== undefined && !(typeof earlierExpires === "number" && earlierExpires <= Math.floor(deps.now() / 1000))) {
    if (earlier["fingerprint"] !== fingerprint) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
    throw agentXError("CONFIG_INVALID", "That token was already made and shown once. Make a new one, and revoke the first if you didn't keep it.");
  }
  if (!await takeRate(deps.store, { pk: companyScoped(orgId, "SCRIPT_TOKEN_CREATE_RATE"), sk: developerId }, SCRIPT_TOKEN_CREATES_PER_HOUR, 3_600_000, deps.now)) {
    throw agentXError("TOO_MANY_REQUESTS", "Too many script tokens made in the last hour. Try again later.");
  }
  for (const project of projects) await checkProject(project);
  const before = await readTokens(deps, orgId, developerId);
  if (!before.complete || liveCount(before.records, deps.now()) >= SCRIPT_TOKENS_PER_PERSON_MAX) throw agentXError("CONFIG_INVALID", SCRIPT_TOKENS_LIMIT_MESSAGE);

  const nowMs = deps.now();
  const tokenId = newPrefixedId("stk");
  const { token, hash } = mintScriptToken(orgId, tokenId);
  // Where an install caps every session, a token lives no longer than a session would.
  const expiresMs = Math.min(nowMs + days * DAY_MS, options.lifetimeCapSeconds === undefined ? Number.MAX_SAFE_INTEGER : nowMs + options.lifetimeCapSeconds * 1000);
  const record: ScriptTokenRecord = {
    orgId, tokenId, developerId, personId: caller.personId, name: input.name, projects, permissions, createdAt: isoOf(nowMs), expiresAt: isoOf(expiresMs), createdRole: caller.orgRole, amr: "local", secretHash: hash,
  };
  const event = auditEvent({
    orgId, at: record.createdAt, actor: { type: "person", id: developerId }, action: "script_token.created", key: occurrence(tokenId, "created"), tokenId,
    details: { days: Math.max(0, Math.round((expiresMs - nowMs) / DAY_MS)), projects: projects.length, permissions: permissions.join(",") },
  });
  const nowSeconds = Math.floor(nowMs / 1000);
  const items: TransactItem[] = [
    { kind: "put", item: document(scriptTokenKey(orgId, tokenId), { entityType: "SCRIPT_TOKEN", ...record, [INDEX_EXPIRY_ATTRIBUTE]: keepUntil(expiresMs) }), condition: when.absent() },
    { kind: "put", item: document(orgScriptTokensKey(orgId, tokenId), { entityType: "SCRIPT_TOKEN_ROW", orgId, tokenId, developerId, createdAt: record.createdAt, [INDEX_EXPIRY_ATTRIBUTE]: keepUntil(expiresMs) }), condition: when.absent() },
    ...deps.audit.stage(event),
    // The request's own mark: written with the token or not at all. An expired mark the TTL has not removed yet is as good as gone.
    {
      kind: "put", condition: when.or(when.absent(), when.lte(INDEX_EXPIRY_ATTRIBUTE, nowSeconds)),
      item: document(markKey, { entityType: "AGENT_REQUEST", fingerprint, result: { tokenId }, at: record.createdAt, [INDEX_EXPIRY_ATTRIBUTE]: nowSeconds + REQUEST_MEMORY_DAYS * 86_400 }),
    },
  ];
  const written = await deps.store.transact(items);
  if (!written.applied) {
    if (written.failed.includes(items.length - 1)) throw agentXError("IDEMPOTENCY_CONFLICT", "This request ID is already being used for another change.");
    throw agentXError("RUNTIME_UNAVAILABLE", "Couldn't make that token. Try again.");
  }

  const after = await readTokens(deps, orgId, developerId);
  if (!after.complete || liveCount(after.records, deps.now()) > SCRIPT_TOKENS_PER_PERSON_MAX) {
    await takeBack(deps, record);
    throw agentXError("CONFIG_INVALID", SCRIPT_TOKENS_LIMIT_MESSAGE);
  }
  return { token: viewOf(record, nowMs, developerId), secret: token };
}

/** Revokes a token made a moment ago that broke the per-person limit (it was never handed out). Tries a few times; if it can't, fails closed with a retryable error. */
async function takeBack(deps: ScriptTokenDependencies, record: ScriptTokenRecord): Promise<void> {
  for (let attempt = 0; attempt < REVOKE_TRIES; attempt += 1) {
    try {
      const at = isoOf(deps.now());
      // The take-back is audited like any revoke, so the ledger never shows a token made and never ended.
      const event = auditEvent({ orgId: record.orgId, at, actor: { type: "person", id: record.developerId }, action: "script_token.revoked", key: occurrence(record.tokenId, "revoked"), tokenId: record.tokenId, details: { by: "limit" } });
      const done = await deps.store.transact([...revokeItems(record, at, record.developerId), ...deps.audit.stage(event)]);
      if (done.applied) return;
    } catch (error) {
      log(deps, { event: "script_tokens.take_back_failed", orgId: record.orgId, error: errorName(error) });
    }
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "Couldn't finish making that token. Try again.");
}

function revokeItems(record: ScriptTokenRecord, at: string, by: string): TransactItem[] {
  const expires = keepUntil(Date.parse(at));
  return [
    {
      kind: "update", key: scriptTokenKey(record.orgId, record.tokenId), ops: [change.set("revokedAt", at), change.set("revokedBy", by), change.set(INDEX_EXPIRY_ATTRIBUTE, expires)],
      condition: when.and(when.present(), when.eq("orgId", record.orgId), when.eq("developerId", record.developerId), when.notExists("revokedAt")),
    },
    { kind: "update", key: orgScriptTokensKey(record.orgId, record.tokenId), ops: [change.set("revokedAt", at), change.set(INDEX_EXPIRY_ATTRIBUTE, expires)] },
  ];
}

// ---- revoking

/**
 * Revokes the caller's own token, or any token in the company when the caller is an owner or admin. Any other token (missing, another company's, another person's for a member) is `NOT_FOUND`. It takes
 * effect at once: every request reads the record. Revoking a revoked token answers it as it is.
 */
export async function revokeScriptToken(deps: ScriptTokenDependencies, caller: ScriptTokenCaller, tokenId: string): Promise<ScriptTokenView> {
  if (!ScriptTokenIdSchema.safeParse(tokenId).success) throw notFound();
  for (let attempt = 0; attempt < REVOKE_TRIES; attempt += 1) {
    const record = await readScriptToken(deps, caller.orgId, tokenId);
    const mine = record?.developerId === caller.developerId;
    if (record === undefined || (!mine && !isAdmin(caller.orgRole))) throw notFound();
    if (record.revokedAt !== undefined) return viewOf(record, deps.now(), caller.developerId);
    const at = isoOf(deps.now());
    const event = auditEvent({
      orgId: caller.orgId, at, actor: { type: "person", id: caller.developerId }, action: "script_token.revoked", key: occurrence(tokenId, "revoked"), tokenId, related: record.developerId, details: { by: mine ? "creator" : "admin" },
    });
    const done = await deps.store.transact([...revokeItems(record, at, caller.developerId), ...deps.audit.stage(event)]);
    if (done.applied) return viewOf({ ...record, revokedAt: at, revokedBy: caller.developerId }, deps.now(), caller.developerId);
    // Revoked by someone else at the same moment: read it again and answer what is there.
    log(deps, { event: "script_tokens.revoke_cancelled", orgId: caller.orgId, reasons: done.failed.join(",") || "none" });
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "That token changed while it was revoked. Try again.");
}

/**
 * A token refused because its creator's place changed (role, removal) is revoked by Rovara at once, so it never works again if the creator goes back to where they stood. Best effort: the request is
 * refused either way; a failed write is logged and the next request tries again.
 */
export async function revokeForAccessChange(deps: ScriptTokenDependencies, record: ScriptTokenRecord): Promise<void> {
  const at = isoOf(deps.now());
  const event = auditEvent({ orgId: record.orgId, at, actor: { type: "system", id: "rovara" }, action: "script_token.revoked", key: occurrence(record.tokenId, "revoked"), tokenId: record.tokenId, related: record.developerId, details: { by: "access_changed" } });
  try {
    const done = await deps.store.transact([...revokeItems(record, at, "rovara"), ...deps.audit.stage(event)]);
    if (!done.applied) log(deps, { event: "script_tokens.access_revoke_failed", orgId: record.orgId, reasons: done.failed.join(",") || "none" });
  } catch (error) {
    log(deps, { event: "script_tokens.access_revoke_failed", orgId: record.orgId, error: errorName(error) });
  }
}

/**
 * The install's switch was found off at start: every live token is revoked (audited, `by: switch_off`), so turning the switch back on never revives a credential that was made before. Best effort per
 * token: one that cannot be revoked now is tried again at the next start with the switch off, and meanwhile no token authenticates (the switch refuses them all). Returns how many were revoked.
 */
export async function revokeAllScriptTokens(deps: ScriptTokenDependencies, orgId: OrgId): Promise<number> {
  const { records } = await readTokens(deps, orgId, undefined);
  let revoked = 0;
  for (const record of records) {
    if (record.revokedAt !== undefined) continue;
    const at = isoOf(deps.now());
    const event = auditEvent({ orgId, at, actor: { type: "system", id: "rovara" }, action: "script_token.revoked", key: occurrence(record.tokenId, "revoked"), tokenId: record.tokenId, related: record.developerId, details: { by: "switch_off" } });
    try {
      if ((await deps.store.transact([...revokeItems(record, at, "rovara"), ...deps.audit.stage(event)])).applied) revoked += 1;
    } catch (error) {
      log(deps, { event: "script_tokens.switch_off_revoke_failed", orgId, error: errorName(error) });
    }
  }
  return revoked;
}

// ---- use

/**
 * Notes a request a token made: with the day's first request, the day's `script_token.used` audit event, in the same write as the token's "last used" day. That write fails closed: if it fails for any
 * reason but its own condition (another request noted the day first), the request is refused with a retryable 503, so every day of use is in the ledger. Later "last used" updates (at most every
 * `LAST_USED_EVERY_MS`) are bookkeeping only: a failure is logged and the request goes on.
 */
export async function noteScriptTokenUse(deps: ScriptTokenDependencies, record: ScriptTokenRecord, permission: ScriptTokenPermission): Promise<void> {
  const nowMs = deps.now();
  const at = isoOf(nowMs);
  const day = at.slice(0, 10);
  const key = scriptTokenKey(record.orgId, record.tokenId);
  if (record.lastUsedDay !== day) {
    const event = auditEvent({ orgId: record.orgId, at, actor: { type: "person", id: record.developerId }, action: "script_token.used", key: occurrence(record.tokenId, day), tokenId: record.tokenId, details: { day, permission } });
    let done;
    try {
      done = await deps.store.transact([
        {
          kind: "update", key, ops: [change.set("lastUsedAt", at), change.set("lastUsedDay", day)],
          condition: when.and(when.present(), when.notExists("revokedAt"), when.or(when.notExists("lastUsedDay"), when.not(when.eq("lastUsedDay", day)))),
        },
        ...deps.audit.stage(event),
      ]);
    } catch (error) {
      log(deps, { event: "script_tokens.use_note_failed", orgId: record.orgId, error: errorName(error) });
      throw agentXError("RUNTIME_UNAVAILABLE", "Rovara couldn't record this script token's use. Try again.");
    }
    if (done.applied) return;
    log(deps, { event: "script_tokens.use_note_cancelled", orgId: record.orgId, reasons: done.failed.join(",") || "none" });
    // Only the token's own condition: today is noted already (or the token was revoked a moment ago, which the next request refuses).
    if (done.failed.length === 1 && done.failed[0] === 0) return;
    throw agentXError("RUNTIME_UNAVAILABLE", "Rovara couldn't record this script token's use. Try again.");
  }
  if (record.lastUsedAt !== undefined && Date.parse(record.lastUsedAt) > nowMs - LAST_USED_EVERY_MS) return;
  try {
    await deps.store.update({
      key, ops: [change.set("lastUsedAt", at)],
      condition: when.and(when.present(), when.notExists("revokedAt"), when.or(when.notExists("lastUsedAt"), when.lt("lastUsedAt", isoOf(nowMs - LAST_USED_EVERY_MS)))),
    });
  } catch (error) {
    log(deps, { event: "script_tokens.last_used_failed", orgId: record.orgId, error: errorName(error) });
  }
}

/**
 * Every task a token starts is audited by itself, naming the token and the task (`related`), so the ledger lists what a token did. Written after the start answered; the occurrence is the token and
 * the task, so a retry of the same start (same request id, same task) writes the same event once. Fails closed with a retryable 503: the script retries with its request id, gets the same task back,
 * and the event is written then.
 */
export async function auditScriptTokenStart(deps: ScriptTokenDependencies, token: { orgId: OrgId; tokenId: string; developerId: string }, taskId: string): Promise<void> {
  const at = isoOf(deps.now());
  const event = auditEvent({
    orgId: token.orgId, at, actor: { type: "person", id: token.developerId }, action: "script_token.used", key: occurrence(token.tokenId, taskId), tokenId: token.tokenId, related: taskId, details: { day: at.slice(0, 10), permission: "start" },
  });
  const staged = deps.audit.stage(event);
  if (staged.length === 0) {
    // A sink that writes somewhere else (or none): record it on its own.
    try { await deps.audit.record(event); } catch (error) {
      log(deps, { event: "script_tokens.start_audit_failed", orgId: token.orgId, error: errorName(error) });
      throw agentXError("RUNTIME_UNAVAILABLE", "The task started, but Rovara couldn't record it. Send the same request again.");
    }
    return;
  }
  try {
    const done = await deps.store.transact(staged);
    // The event is the same one a retry writes: a condition that fails because it is already there is the answer wanted.
    if (!done.applied) log(deps, { event: "script_tokens.start_audit_repeat", orgId: token.orgId });
  } catch (error) {
    log(deps, { event: "script_tokens.start_audit_failed", orgId: token.orgId, error: errorName(error) });
    throw agentXError("RUNTIME_UNAVAILABLE", "The task started, but Rovara couldn't record it. Send the same request again.");
  }
}
