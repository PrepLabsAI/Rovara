// DEC 254w: account linking between sign-in methods, inside DeveloperIdentity (the only writer of the sign-in table).
//
//   start   the caller's LIVE web-app session asks to connect a second method (Slack or GitHub). A link row is written
//           (`SIGNIN_LINK#<id>`): bound to that session, the person, their company, the method, the web app's PKCE challenge and its return URL
//           (exactly one of the web app's registered redirect URLs); single use, five minutes. The answer is the provider's authorize URL.
//   callback the provider sends the browser back to /v1/auth/callback/<method> with state = the link id. The row is consumed (once), the provider's
//           code is exchanged, and the proved identity is stored on the row with the SHA-256 of a fresh one-time code. Only the browser that
//           completed the provider's sign-in gets that code, in its redirect back to the web app.
//   finish  the SAME session (same person, same session id, still live), with that browser's one-time code and the web app's PKCE verifier (kept
//           in that browser's web-app session), attaches the identity: one transaction writes the identity's record pointing at the person
//           (`mergedInto`, which every sign-in already follows: the session, membership and role are the person's), the person's connected-method
//           row (`SIGNIN_LINKS#<person>` / `METHOD#<method>`, one per method), the company log row, and checks the person's membership and session.
//   unlink  the person, or an owner or admin of their company, removes a connected method (never the first one), ends every
//           session of the person (a removed method's sessions must not live on), and logs it. The identity's record is kept, marked unlinked (when, from
//           whom, from which company; DEC 254zzz33, 254zzz39).
//   relink  (DEC 254zzz39) a kept unlinked identity is linked again by the same finish, in place: to the person it was unlinked from or another person of
//           that company, never another company's; never one an admin turned off or one with a membership of its own. Its own sessions end; logged as a relink.
//   adopt   (SLACK-LINK-L2) the same finish adopts a never-used company-less record of the identity (its own earlier sign-in attempt: one sign-in, no membership, never merged) by the same
//           merge (`adoptableCompanyLessRecord`, `adoptWrite`); logged as an adoption. Any other existing record keeps the identity taken.
//
// Refusals: one fixed answer (`refused`) for every reason a link cannot be made: the identity is already someone's (any existing record but a kept
// unlinked one of this company or an unused company-less one that is adopted, or a membership row), a Slack identity from a workspace that proves nothing for this company (never linked by email: DEC 254h), the company's own
// sign-in refuses the method, a revoked person or member, the person already has that method, or a used, expired or foreign link. Logs carry
// fixed reasons and opaque ids only; never a code, a token, an email address or a provider's words.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  IMPLICIT_COMPANY_ID, OrgIdSchema, SIGN_IN_LINK_SECONDS, SIGN_IN_LINK_TEXT,
  SignInLinkFinishRequestSchema, SignInLinkStartRequestSchema, SignInLinksListRequestSchema, SignInUnlinkRequestSchema, companyScoped,
  type ConnectedSignIn, type DeveloperSignInMethod, type LinkableSignInMethod, type SignInClientRecord, type SignInLinkFinishResponse,
  type SignInLinkRefusal, type SignInLinkStartResponse, type SignInLinksListResponse, type SignInUnlinkResponse,
} from "@agentx/contracts";
import { membershipKey } from "../aws/company-check.js";
import { ownerKeyForSubject } from "../aws/lambda.js";
import { isUnreadableMembershipRow, type CompanySignInStore } from "./company-membership.js";
import type { SignInProvider } from "./providers.js";
import { SESSION_BINDING_PATTERN, sameSessionBinding, sessionBindingOf } from "./session-binding.js";
import { endedByAdmin, type DeveloperRecord, type DeveloperSignInStore, type SessionRecord } from "./store.js";
import { pkceChallengeMatches, sha256Hex } from "./tokens.js";
import { readingMembership, rethrowMembershipReadFailure } from "../core/membership-read.js";

type Write = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
interface HttpResult { statusCode: number; headers: Record<string, string>; body: string }

export interface SignInLinkOptions {
  store: DeveloperSignInStore;
  /** Code's company layer, read at each request. Absent: linking is not set up (every request answers `not_set_up`). */
  company: () => CompanySignInStore | undefined;
  /** The install's provider for a method; throws when it is not configured. */
  provider: (method: DeveloperSignInMethod) => SignInProvider;
  /** Whether the method is on now (the install's enabled methods). */
  methodEnabled: (method: DeveloperSignInMethod) => boolean;
  /** As a refresh checks: the session's method is still on, and was on when it started. */
  methodLive: (session: SessionRecord) => boolean;
  registeredClient: (clientId: string) => Promise<SignInClientRecord | undefined>;
  /** The company the install's own Slack workspace is bound to (undefined: none); the sign-in server's `slackCompany`. */
  installSlackCompany: () => Promise<string | undefined>;
  /** The company a Slack workspace is bound to, when the install knows one (undefined: none). */
  slackTeamCompany: (teamId: string) => Promise<string | undefined>;
  endpoint: (path: string) => string;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
}

const LINK_ID = /^lnk_[A-Za-z0-9_-]{43}$/;
/** At most this many connected-method rows are read for one person (one per linkable method; more is an error, never a partial list). */
const LINK_ROWS_MAX = 10;
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");
const conditionFailed = (error: unknown) => error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");
const refusal = (error: SignInLinkRefusal["error"], message: string): SignInLinkRefusal => ({ ok: false, error, message });
const REFUSED = () => refusal("refused", SIGN_IN_LINK_TEXT.refused);

/** The identity a callback proved, as stored on the link row. Only what the link needs: never an email address. */
const ProvedIdentity = z.object({
  method: z.enum(["slack", "github"]), issuer: z.string().min(1).max(512), subject: z.string().min(1).max(512), displayName: z.string().max(200),
  slackUserId: z.string().regex(/^[UW][A-Z0-9]{2,30}$/).optional(), slackTeamId: z.string().regex(/^[TE][A-Z0-9]{2,30}$/).optional(),
}).strict();
type Proved = z.infer<typeof ProvedIdentity>;
const LinkRow = z.object({
  entityType: z.literal("SIGNIN_LINK"), id: z.string().regex(LINK_ID), developerId: z.string().regex(/^[a-f0-9]{64}$/),
  sessionBinding: z.string().regex(SESSION_BINDING_PATTERN), companyId: OrgIdSchema, method: z.enum(["slack", "github"]), nonce: z.string().min(1), challenge: z.string().min(43),
  returnTo: z.string().url(), clientState: z.string().min(1), expiresAt: z.number().int(), consumedAt: z.string().optional(), verifiedAt: z.string().optional(),
  identity: ProvedIdentity.optional(), codeHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), attemptAt: z.string().optional(), finishedAt: z.string().optional(),
}).strict();
type Link = z.infer<typeof LinkRow>;
const ConnectedRow = z.object({ entityType: z.literal("SIGNIN_LINK_ROW"), personId: z.string(), method: z.enum(["slack", "github"]),
  linkedId: z.string().regex(/^[a-f0-9]{64}$/), linkedAt: z.iso.datetime(), linkedBy: z.string() }).strict();

/** DEC 254zzz39: what a kept unlinked record (DEC 254zzz33) must be to be linked again; anything else about it is left as it is. */
const KeptRecord = z.object({
  entityType: z.literal("DEVELOPER"), developerId: z.string().regex(/^[a-f0-9]{64}$/), provider: z.enum(["slack", "github"]), revoked: z.literal(false), companyless: z.literal(true),
  mergedInto: z.never().optional(), unlinkedAt: z.iso.datetime(), unlinkedFrom: z.string().regex(/^[a-f0-9]{64}$/), unlinkedCompany: OrgIdSchema.optional(),
}).passthrough();

/**
 * DEC 254zzz39: a kept unlinked record linked again, in place (the sign-in role deletes no DEVELOPER# row). It points at the person again and is no longer marked unlinked; its own
 * sessions from while it was nobody's end; it carries no email (a linked record never does) and no first-sign-in mark. Conditioned on being exactly the record that was read: still
 * nobody's, on, company-less, the same unlink (time and person), from this company (or, unlinked before the company was kept, none: then the person read was checked to be this one).
 */
function relinkWrite(tableName: string, linkedId: string, personId: string, companyId: string, kept: { unlinkedAt: string; unlinkedFrom: string; unlinkedCompany?: string }, identity: Proved, at: string): Write {
  const slackUserId = identity.method === "slack" ? identity.slackUserId : undefined;
  const set = ["mergedInto = :person", "linkedAt = :at", "linkedBy = :person", "sessionsEndedAt = :at", ...(slackUserId === undefined ? [] : ["slackUserId = :su"]), ...(identity.slackTeamId === undefined ? [] : ["slackTeamId = :team"])];
  const remove = ["unlinkedAt", "unlinkedFrom", "unlinkedCompany", "firstSignInMark", "email", "slackTeamName", ...(slackUserId === undefined ? ["slackUserId"] : []), ...(identity.slackTeamId === undefined ? ["slackTeamId"] : [])];
  return { Update: { TableName: tableName, Key: { pk: `DEVELOPER#${linkedId}`, sk: "META" },
    UpdateExpression: `SET ${set.join(", ")} REMOVE ${remove.join(", ")}`,
    ConditionExpression: `attribute_exists(pk) AND attribute_not_exists(mergedInto) AND revoked = :false AND companyless = :true AND provider = :method AND unlinkedAt = :unlinkedAt AND unlinkedFrom = :from AND ${
      kept.unlinkedCompany === undefined ? "attribute_not_exists(unlinkedCompany)" : "unlinkedCompany = :company"}`,
    ExpressionAttributeValues: { ":person": personId, ":at": at, ":false": false, ":true": true, ":method": identity.method, ":unlinkedAt": kept.unlinkedAt, ":from": kept.unlinkedFrom,
      ...(kept.unlinkedCompany === undefined ? {} : { ":company": companyId }), ...(slackUserId === undefined ? {} : { ":su": slackUserId }), ...(identity.slackTeamId === undefined ? {} : { ":team": identity.slackTeamId }) } } };
}

/** The sign-in table's row reader the adopt check uses (`read` in createSignInLinks): a consistent GetItem by key. */
export type RecordReader = (key: { pk: string; sk: string }) => Promise<Record<string, unknown> | undefined>;
/** Why an unused company-less record may not be adopted: fixed reasons, for the log only (the person's answer never says which). */
export type AdoptRefusalReason = "not_the_identitys_record" | "wrong_method" | "turned_off" | "not_company_less" | "already_connected" | "has_membership" | "used_more_than_once";
/** The record fields an adoption's write is conditioned on again, in the transaction. */
export interface AdoptableRecord { firstSignInAt: string }

/**
 * DEC 550 / SLACK-LINK-L2: whether the record found under an identity is an UNUSED company-less record that a signed-in person may adopt (their own sign-in attempt that never
 * got anywhere), instead of the identity being refused as taken. ONE function, so every caller applies the very same checks (the identity join reuses it). Any doubt: no.
 * It adopts only a record that is ALL of:
 *   1. the identity's own, a `DEVELOPER` row of the wanted method whose issuer and subject hash to the key it was read under (the key and `provider` are the identity's, `ownerKeyForSubject`), not turned off;
 *   2. flagged company-less (`companyless` = true, set when a person first signs in with no company; server.ts `companylessMayMint`). The flag is NEVER cleared when the person later creates or joins a company, so it proves nothing
 *      by itself: a real person (even a company owner) carries it. It is necessary here, never sufficient: check 4 (no membership row) is what makes the record unused;
 *   3. never merged, linked or unlinked: no `mergedInto`, `linkedAt`, `linkedBy`, `linkedSlackUserId`, `unlinkedAt`, `unlinkedFrom`, `unlinkedCompany` (a kept unlinked record has its own relink path);
 *   4. no membership row at all, not even a revoked one (`membershipKey`, the one place grants, roles and tasks hang from: a project grant or a task needs a member, so none can exist without one);
 *   5. used by exactly ONE sign-in (`firstSignInAt` = `lastSignInAt`, both written by every sign-in's upsert): one sign-in is one session, so no other session exists; and its name was never chosen by the person.
 * The caller writes the adoption with `adoptWrite`, which conditions the record on the same facts again.
 */
export async function adoptableCompanyLessRecord(input: { read: RecordReader; linkedId: string; record: Record<string, unknown>; method?: LinkableSignInMethod }): Promise<{ ok: true; record: AdoptableRecord } | { ok: false; reason: AdoptRefusalReason }> {
  const { read, linkedId, record, method } = input;
  const no = (reason: AdoptRefusalReason) => ({ ok: false as const, reason });
  if (record.pk !== `DEVELOPER#${linkedId}` || record.sk !== "META" || record.entityType !== "DEVELOPER" || (record.developerId !== undefined && record.developerId !== linkedId)
    || typeof record.issuer !== "string" || typeof record.subject !== "string" || ownerKeyForSubject(record.issuer, record.subject) !== linkedId) return no("not_the_identitys_record");
  if (record.provider !== "slack" && record.provider !== "github") return no("wrong_method");
  if (method !== undefined && record.provider !== method) return no("wrong_method");
  if (record.revoked !== false) return no("turned_off");
  if (record.companyless !== true) return no("not_company_less");
  for (const field of ["mergedInto", "linkedAt", "linkedBy", "linkedSlackUserId", "unlinkedAt", "unlinkedFrom", "unlinkedCompany"]) if (record[field] !== undefined) return no("already_connected");
  if (await read(membershipKey(linkedId)) !== undefined) return no("has_membership");
  const first = record.firstSignInAt;
  if (typeof first !== "string" || !Number.isFinite(Date.parse(first)) || record.lastSignInAt !== first || record.displayNameChosen !== undefined) return no("used_more_than_once");
  return { ok: true, record: { firstSignInAt: first } };
}

/**
 * The adoption itself: the existing merge (`mergedInto`) of the unused record toward the signed-in person, in place, as `relinkWrite` does for a kept one (its own session from the sign-in that
 * made it ends; it carries no email, as a linked record never does, and no `companyless` flag: it is a person's linked sign-in now, and an unlink sets the flag again, DEC 254zzz33). Conditioned on exactly what `adoptableCompanyLessRecord` read: still nobody's, on, company-less, never connected,
 * signed in once (the same first-sign-in time, and no later one), its name not chosen.
 */
function adoptWrite(tableName: string, linkedId: string, personId: string, adopted: AdoptableRecord, identity: Proved, at: string): Write {
  const slackUserId = identity.method === "slack" ? identity.slackUserId : undefined;
  const set = ["mergedInto = :person", "linkedAt = :at", "linkedBy = :person", "sessionsEndedAt = :at", ...(slackUserId === undefined ? [] : ["slackUserId = :su"]), ...(identity.slackTeamId === undefined ? [] : ["slackTeamId = :team"])];
  const remove = ["companyless", "firstSignInMark", "email", "slackTeamName", ...(slackUserId === undefined ? ["slackUserId"] : []), ...(identity.slackTeamId === undefined ? ["slackTeamId"] : [])];
  return { Update: { TableName: tableName, Key: { pk: `DEVELOPER#${linkedId}`, sk: "META" },
    UpdateExpression: `SET ${set.join(", ")} REMOVE ${remove.join(", ")}`,
    ConditionExpression: "attribute_exists(pk) AND revoked = :false AND companyless = :true AND provider = :method AND firstSignInAt = :first AND lastSignInAt = :first AND attribute_not_exists(displayNameChosen) AND attribute_not_exists(mergedInto) "
      + "AND attribute_not_exists(linkedAt) AND attribute_not_exists(linkedBy) AND attribute_not_exists(linkedSlackUserId) AND attribute_not_exists(unlinkedAt) AND attribute_not_exists(unlinkedFrom) AND attribute_not_exists(unlinkedCompany)",
    ExpressionAttributeValues: { ":person": personId, ":at": at, ":false": false, ":true": true, ":method": identity.method, ":first": adopted.firstSignInAt,
      ...(slackUserId === undefined ? {} : { ":su": slackUserId }), ...(identity.slackTeamId === undefined ? {} : { ":team": identity.slackTeamId }) } } };
}

/** What stands in the way of an identity being linked: nothing (a new record is written), a kept unlinked record (linked again), an unused company-less record (adopted), or someone else's (taken). */
type Claim = { kind: "new" } | { kind: "relink"; relink: { unlinkedAt: string; unlinkedFrom: string; unlinkedCompany?: string } } | { kind: "adopt"; adopt: AdoptableRecord } | { kind: "taken" };
/** The marks the company log row of a link carries for a relink (the person it was unlinked from) or an adoption (the adopted record's own opaque id, its owner key: the connected-method row that names it goes on an unlink). */
const claimMarks = (claim: Claim, linkedId: string) => (claim.kind === "relink" ? { relink: true, previousPersonId: claim.relink.unlinkedFrom } : claim.kind === "adopt" ? { adopted: true, adoptedId: linkedId } : {});
/** The write of the linked identity's own record for each kind of claim (a new record, the kept one linked again, or the unused one adopted). */
function identityWrite(tableName: string, claim: Claim, linkedId: string, personId: string, companyId: string, identity: Proved, at: string): Write {
  if (claim.kind === "adopt") return adoptWrite(tableName, linkedId, personId, claim.adopt, identity, at);
  if (claim.kind === "relink") return relinkWrite(tableName, linkedId, personId, companyId, claim.relink, identity, at);
  const slackUserId = identity.method === "slack" ? identity.slackUserId : undefined;
  return { Put: { TableName: tableName, ConditionExpression: "attribute_not_exists(pk)", Item: {
    pk: `DEVELOPER#${linkedId}`, sk: "META", entityType: "DEVELOPER", developerId: linkedId, provider: identity.method, issuer: identity.issuer, subject: identity.subject,
    displayName: identity.displayName, revoked: false, firstSignInAt: at, lastSignInAt: at, mergedInto: personId, linkedAt: at, linkedBy: personId,
    ...(slackUserId === undefined ? {} : { slackUserId }), ...(identity.slackTeamId === undefined ? {} : { slackTeamId: identity.slackTeamId }),
  } } };
}

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
};
function page(title: string, text: string): HttpResult {
  const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
  return { statusCode: 400, headers: { ...HTML_HEADERS }, body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title></head><body><main><h1>${escape(title)}</h1><p>${escape(text)}</p></main></body></html>` };
}
function back(link: Link, params: Record<string, string>): HttpResult {
  const url = new URL(link.returnTo);
  for (const [key, value] of Object.entries({ ...params, state: link.clientState })) url.searchParams.set(key, value);
  return { statusCode: 302, headers: { location: url.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" }, body: "" };
}
const sameSecret = (given: string, keptHex: string) => {
  const a = Buffer.from(sha256Hex(given), "hex"); const b = Buffer.from(keptHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};

export function createSignInLinks(options: SignInLinkOptions) {
  const { store } = options;
  const { documentClient, tableName } = store.table();
  const seconds = () => Math.floor(options.now() / 1000);
  const iso = () => new Date(options.now()).toISOString();
  const read = async (key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> =>
    ((await documentClient.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  const linkOf = async (id: string): Promise<Link | undefined> => {
    if (!LINK_ID.test(id)) return undefined;
    const { pk: storedPk, sk: storedSk, ...fields } = await read({ pk: `SIGNIN_LINK#${id}`, sk: "META" }) ?? {};
    if (storedPk !== `SIGNIN_LINK#${id}` || storedSk !== "META") return undefined;
    const parsed = LinkRow.safeParse(fields);
    return parsed.success && parsed.data.id === id ? parsed.data : undefined;
  };

  /** The caller's live session, read from this table: theirs, not revoked, not ended, their record on, its method still on. */
  async function liveSession(developerId: string, sessionId: string): Promise<{ session: SessionRecord; developer: DeveloperRecord } | SignInLinkRefusal> {
    const signedOut = refusal("signed_out", SIGN_IN_LINK_TEXT.signedOut);
    const session = await store.getSession(sessionId);
    if (session === undefined || session.developerId !== developerId || session.revokedAt !== undefined || !(session.endsAt > seconds())) return signedOut;
    const developer = await store.getDeveloper(developerId);
    if (developer === undefined || developer.revoked !== false || endedByAdmin(session.startedAt, developer.sessionsEndedAt) || !options.methodLive(session)) return signedOut;
    return { session, developer };
  }
  /** The person's live membership, or undefined when there is none, it was revoked, or it does not read. */
  async function liveMember(company: CompanySignInStore, personId: string): Promise<{ companyId: string; role: string } | undefined> {
    try {
      const member = await company.membership(personId);
      return member === undefined || member.revokedAt !== undefined ? undefined : { companyId: member.companyId, role: member.role };
    } catch { return undefined; }
  }
  /**
   * Whether this method may be linked for a person of `companyId` (checked at start and again at finish). A company with its own sign-in refuses the
   * install's methods, as its sign-in does: GitHub always; Slack unless the install's own workspace is bound to that company and the identity is from it.
   */
  async function methodAllowed(company: CompanySignInStore, companyId: string, method: LinkableSignInMethod, identity?: Proved): Promise<boolean> {
    if (!options.methodEnabled(method)) return false;
    if (!await company.hasOwnIssuer(companyId)) return true;
    if (method !== "slack") return false;
    if (identity !== undefined && identity.slackUserId === undefined) return false;
    return await options.installSlackCompany() === companyId;
  }
  /**
   * A Slack identity is linked only when its workspace speaks for the company: the install's own workspace (Slack named the user in it), or a
   * workspace bound to this very company. A Slack user of any other workspace proves nothing here (their email never links: DEC 254h).
   */
  async function slackAllowed(identity: Proved, companyId: string): Promise<boolean> {
    if (identity.method !== "slack") return true;
    if (identity.slackUserId !== undefined) {
      // The install's own workspace, unless it is bound to another company.
      const bound = await options.installSlackCompany();
      return bound === undefined || bound === IMPLICIT_COMPANY_ID || bound === companyId;
    }
    if (identity.slackTeamId === undefined) return false;
    return await options.slackTeamCompany(identity.slackTeamId) === companyId;
  }
  /** The company owner or admin rule over a person: both live members of ONE company; only an owner acts on an owner (DEC 232e). */
  async function adminOver(company: CompanySignInStore, adminId: string, personId: string): Promise<boolean> {
    const admin = await liveMember(company, adminId);
    if (admin === undefined || (admin.role !== "owner" && admin.role !== "admin")) return false;
    let person;
    try { person = await readingMembership(() => company.membership(personId).catch((error: unknown) => { if (isUnreadableMembershipRow(error)) return undefined; throw error; })); } catch (error) { rethrowMembershipReadFailure(error); return false; }
    if (person === undefined || person.companyId !== admin.companyId) return false;
    return person.role !== "owner" || admin.role === "owner";
  }
  /** A refusal logged with its fixed reason; the answer never says which. */
  const refuse = (event: string, developerId: string, reason: string): SignInLinkRefusal => {
    options.log({ event, developerId, reason });
    return REFUSED();
  };
  async function guarded<T>(operation: string, work: () => Promise<T>): Promise<T | SignInLinkRefusal> {
    try { return await work(); } catch (error) {
      options.log({ event: "signin.link_operation_failed", operation, error: errorName(error) });
      return refusal("unavailable", SIGN_IN_LINK_TEXT.unavailable);
    }
  }

  /** The identity's claim (see `Claim`): read from its own record, the kept-unlinked rules first, then the adopt checks. */
  async function claimOf(linkedId: string, method: LinkableSignInMethod, personId: string, companyId: string): Promise<Claim> {
    const row = await read({ pk: `DEVELOPER#${linkedId}`, sk: "META" });
    if (row === undefined) return { kind: "new" };
    const kept = KeptRecord.safeParse(row);
    if (row.pk === `DEVELOPER#${linkedId}` && row.sk === "META" && kept.success && kept.data.developerId === linkedId && kept.data.provider === method
      && (kept.data.unlinkedCompany === undefined ? kept.data.unlinkedFrom === personId : kept.data.unlinkedCompany === companyId)) {
      return { kind: "relink", relink: { unlinkedAt: kept.data.unlinkedAt, unlinkedFrom: kept.data.unlinkedFrom, ...(kept.data.unlinkedCompany === undefined ? {} : { unlinkedCompany: kept.data.unlinkedCompany }) } };
    }
    const adoptable = await adoptableCompanyLessRecord({ read, linkedId, record: row, method });
    return adoptable.ok ? { kind: "adopt", adopt: adoptable.record } : { kind: "taken" };
  }

  const operations = {
    async start(event: unknown): Promise<SignInLinkStartResponse> {
      const parsed = SignInLinkStartRequestSchema.safeParse(event);
      if (!parsed.success) return refusal("invalid_request", SIGN_IN_LINK_TEXT.invalid);
      const company = options.company();
      if (company === undefined) return refusal("not_set_up", SIGN_IN_LINK_TEXT.notSetUp);
      const { developerId, sessionId, method, challenge, returnTo, state } = parsed.data;
      const live = await liveSession(developerId, sessionId);
      if ("ok" in live) return live;
      // Only the web app's own sign-in client starts a link, and it comes back only to one of that client's exact registered URLs.
      const client = live.session.clientId === undefined ? undefined : await options.registeredClient(live.session.clientId);
      if (client === undefined || client.webApp !== true || client.fullAccess !== true || !client.redirectUris.includes(returnTo)) return refuse("signin.link_refused", developerId, "not_web_app");
      if (live.developer.mergedInto !== undefined || live.developer.provider === method) return refuse("signin.link_refused", developerId, "same_method");
      const member = await liveMember(company, developerId);
      if (member === undefined || member.companyId !== (live.session.companyId ?? IMPLICIT_COMPANY_ID)) return refuse("signin.link_refused", developerId, "not_member");
      if (!await methodAllowed(company, member.companyId, method)) return refuse("signin.link_refused", developerId, "method_refused");
      if (await read({ pk: `SIGNIN_LINKS#${developerId}`, sk: `METHOD#${method}` }) !== undefined) return refuse("signin.link_refused", developerId, "already_has_method");
      const id = `lnk_${randomBytes(32).toString("base64url")}`;
      const nonce = randomBytes(32).toString("base64url");
      const authorizeUrl = await options.provider(method).authorizeUrl({ state: id, nonce, redirectUri: options.endpoint(`/callback/${method}`) });
      await documentClient.send(new PutCommand({ TableName: tableName, ConditionExpression: "attribute_not_exists(pk)", Item: {
        pk: `SIGNIN_LINK#${id}`, sk: "META", entityType: "SIGNIN_LINK", id, developerId, sessionBinding: sessionBindingOf(sessionId), companyId: member.companyId, method, nonce, challenge, returnTo,
        clientState: state, expiresAt: seconds() + SIGN_IN_LINK_SECONDS,
      } }));
      options.log({ event: "signin.link_started", developerId, method });
      return { ok: true, authorizeUrl, linkId: id };
    },

    async finish(event: unknown): Promise<SignInLinkFinishResponse> {
      const parsed = SignInLinkFinishRequestSchema.safeParse(event);
      if (!parsed.success) return refusal("invalid_request", SIGN_IN_LINK_TEXT.invalid);
      const company = options.company();
      if (company === undefined) return refusal("not_set_up", SIGN_IN_LINK_TEXT.notSetUp);
      const { developerId, sessionId, linkId, linkCode, verifier } = parsed.data;
      const live = await liveSession(developerId, sessionId);
      if ("ok" in live) return live;
      const link = await linkOf(linkId);
      // The link is this very session's and person's, proved by its callback, unexpired and never tried before.
      if (link === undefined || link.developerId !== developerId || !sameSessionBinding(link.sessionBinding, sessionBindingOf(sessionId)) || link.verifiedAt === undefined || link.identity === undefined
        || link.codeHash === undefined || link.attemptAt !== undefined || link.finishedAt !== undefined || link.expiresAt <= seconds()) return refuse("signin.link_refused", developerId, "link_not_usable");
      // One attempt per link: a wrong code or verifier spends it.
      const attemptAt = iso();
      try {
        await documentClient.send(new UpdateCommand({ TableName: tableName, Key: { pk: `SIGNIN_LINK#${linkId}`, sk: "META" }, UpdateExpression: "SET attemptAt = :at",
          ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(attemptAt) AND attribute_exists(verifiedAt) AND sessionBinding = :sid AND developerId = :dev AND expiresAt > :now",
          ExpressionAttributeValues: { ":at": attemptAt, ":sid": sessionBindingOf(sessionId), ":dev": developerId, ":now": seconds() } }));
      } catch (error) {
        if (conditionFailed(error)) return refuse("signin.link_refused", developerId, "link_not_usable");
        throw error;
      }
      if (!sameSecret(linkCode, link.codeHash) || !pkceChallengeMatches(verifier, link.challenge)) return refuse("signin.link_refused", developerId, "wrong_proof");
      const identity = link.identity;
      if (identity.method !== link.method) return refuse("signin.link_refused", developerId, "link_not_usable");
      const linkedId = ownerKeyForSubject(identity.issuer, identity.subject);
      const person = live.developer;
      if (linkedId === developerId || person.mergedInto !== undefined || person.provider === link.method) return refuse("signin.link_refused", developerId, "same_method");
      const member = await liveMember(company, developerId);
      if (member === undefined || member.companyId !== link.companyId || member.companyId !== (live.session.companyId ?? IMPLICIT_COMPANY_ID)) return refuse("signin.link_refused", developerId, "not_member");
      if (!await methodAllowed(company, member.companyId, link.method, identity)) return refuse("signin.link_refused", developerId, "method_refused");
      if (!await slackAllowed(identity, member.companyId)) return refuse("signin.link_refused", developerId, "workspace_refused");
      // The identity is nobody's yet: no record of its own (a person, a merged or revoked sign-in) and no membership. Checked again in the transaction.
      // DEC 254zzz39: or its record is one an unlink kept (DEC 254zzz33): unlinked, nobody's, on, never a person of a company, and unlinked from this company (a record unlinked
      // before the company was kept: only by the person it was unlinked from). It is linked again in place; every condition is checked again in the transaction.
      // SLACK-LINK-L2: or it is an unused company-less record of the identity's own sign-in attempt, adopted by the person (`adoptableCompanyLessRecord`); anything else stays taken.
      const claim = await claimOf(linkedId, link.method, developerId, member.companyId);
      if (claim.kind === "taken") return refuse("signin.link_refused", developerId, "identity_taken");
      const slackUserId = identity.method === "slack" ? identity.slackUserId : undefined;
      if (slackUserId !== undefined && ((person.slackUserId !== undefined && person.slackUserId !== slackUserId) || person.linkedSlackUserId !== undefined)) {
        return refuse("signin.link_refused", developerId, "other_slack");
      }
      const at = iso();
      const writes: Write[] = [
        { Update: { TableName: tableName, Key: { pk: `SIGNIN_LINK#${linkId}`, sk: "META" }, UpdateExpression: "SET finishedAt = :at",
          ConditionExpression: "attribute_not_exists(finishedAt) AND attemptAt = :attempt", ExpressionAttributeValues: { ":at": at, ":attempt": attemptAt } } },
        identityWrite(tableName, claim, linkedId, developerId, member.companyId, identity, at),
        slackUserId === undefined
          ? { ConditionCheck: { TableName: tableName, Key: { pk: `DEVELOPER#${developerId}`, sk: "META" },
            ConditionExpression: "attribute_exists(pk) AND revoked = :false AND attribute_not_exists(mergedInto) AND provider <> :method",
            ExpressionAttributeValues: { ":false": false, ":method": link.method } } }
          : { Update: { TableName: tableName, Key: { pk: `DEVELOPER#${developerId}`, sk: "META" }, UpdateExpression: "SET linkedSlackUserId = :su, slackUserId = :su",
            ConditionExpression: "attribute_exists(pk) AND revoked = :false AND attribute_not_exists(mergedInto) AND provider <> :method AND attribute_not_exists(linkedSlackUserId) AND (attribute_not_exists(slackUserId) OR slackUserId = :su)",
            ExpressionAttributeValues: { ":false": false, ":method": link.method, ":su": slackUserId } } },
        { Put: { TableName: tableName, ConditionExpression: "attribute_not_exists(pk)", Item: {
          pk: `SIGNIN_LINKS#${developerId}`, sk: `METHOD#${link.method}`, entityType: "SIGNIN_LINK_ROW", personId: developerId, method: link.method, linkedId, linkedAt: at, linkedBy: developerId,
        } } },
        { ConditionCheck: { TableName: tableName, Key: membershipKey(developerId), ConditionExpression: "companyId = :company AND attribute_not_exists(revokedAt)", ExpressionAttributeValues: { ":company": member.companyId } } },
        { ConditionCheck: { TableName: tableName, Key: membershipKey(linkedId), ConditionExpression: "attribute_not_exists(pk)" } },
        { ConditionCheck: { TableName: tableName, Key: { pk: `SESSION#${sessionId}`, sk: "META" }, ConditionExpression: "developerId = :dev AND attribute_not_exists(revokedAt) AND endsAt > :now",
          ExpressionAttributeValues: { ":dev": developerId, ":now": seconds() } } },
        { Put: { TableName: tableName, ConditionExpression: "attribute_not_exists(pk)", Item: {
          pk: companyScoped(OrgIdSchema.parse(member.companyId), "COMPANY_LOG"), sk: `${at}#${randomBytes(16).toString("hex")}`, entityType: "COMPANY_LOG", event: "company-signin-link",
          companyId: member.companyId, personId: developerId, createdBy: developerId, createdAt: at, method: link.method,
          ...claimMarks(claim, linkedId),
        } } },
      ];
      try { await documentClient.send(new TransactWriteCommand({ TransactItems: writes })); }
      catch (error) {
        if (conditionFailed(error)) return refuse("signin.link_refused", developerId, "changed_meanwhile");
        throw error;
      }
      options.log({ event: "signin.linked", developerId, method: link.method, ...(claim.kind === "relink" ? { relink: true } : {}), ...(claim.kind === "adopt" ? { adopted: true } : {}) });
      return { ok: true, method: link.method };
    },

    async list(event: unknown): Promise<SignInLinksListResponse> {
      const parsed = SignInLinksListRequestSchema.safeParse(event);
      if (!parsed.success) return refusal("invalid_request", SIGN_IN_LINK_TEXT.invalid);
      const company = options.company();
      if (company === undefined) return refusal("not_set_up", SIGN_IN_LINK_TEXT.notSetUp);
      const { developerId, sessionId, personDeveloperId } = parsed.data;
      const live = await liveSession(developerId, sessionId);
      if ("ok" in live) return live;
      if (personDeveloperId !== developerId && !await adminOver(company, developerId, personDeveloperId)) return refusal("forbidden", SIGN_IN_LINK_TEXT.forbidden);
      const person = personDeveloperId === developerId ? live.developer : await store.getDeveloper(personDeveloperId);
      if (person === undefined || person.mergedInto !== undefined) return refusal("not_found", SIGN_IN_LINK_TEXT.notFound);
      const rows = await connectedRows(personDeveloperId);
      const signIns: ConnectedSignIn[] = [{ method: person.provider, primary: true }, ...rows.map((row) => ({ method: row.method, primary: false, linkedAt: row.linkedAt }))];
      return { ok: true, signIns };
    },

    async unlink(event: unknown): Promise<SignInUnlinkResponse> {
      const parsed = SignInUnlinkRequestSchema.safeParse(event);
      if (!parsed.success) return refusal("invalid_request", SIGN_IN_LINK_TEXT.invalid);
      const company = options.company();
      if (company === undefined) return refusal("not_set_up", SIGN_IN_LINK_TEXT.notSetUp);
      const { developerId, sessionId, personDeveloperId, method } = parsed.data;
      const live = await liveSession(developerId, sessionId);
      if ("ok" in live) return live;
      const self = personDeveloperId === developerId;
      if (!self && !await adminOver(company, developerId, personDeveloperId)) return refusal("forbidden", SIGN_IN_LINK_TEXT.forbidden);
      const person = self ? live.developer : await store.getDeveloper(personDeveloperId);
      if (person === undefined || person.mergedInto !== undefined) return refusal("not_found", SIGN_IN_LINK_TEXT.notFound);
      // The first method is never removed, so at least one always remains.
      if (person.provider === method) return refusal("last_method", SIGN_IN_LINK_TEXT.lastMethod);
      const { pk: rowPk, sk: rowSk, ...rowFields } = await read({ pk: `SIGNIN_LINKS#${personDeveloperId}`, sk: `METHOD#${method}` }) ?? {};
      const row = ConnectedRow.safeParse(rowFields);
      if (rowPk !== `SIGNIN_LINKS#${personDeveloperId}` || rowSk !== `METHOD#${method}` || !row.success || row.data.personId !== personDeveloperId || row.data.method !== method) return refusal("not_found", SIGN_IN_LINK_TEXT.notFound);
      const linkedId = row.data.linkedId;
      const linked = await store.getDeveloper(linkedId);
      if (linked?.mergedInto !== personDeveloperId) return refusal("not_found", SIGN_IN_LINK_TEXT.notFound);
      let membership;
      try { membership = await readingMembership(() => company.membership(personDeveloperId).catch((error: unknown) => { if (isUnreadableMembershipRow(error)) return undefined; throw error; })); } catch (error) { rethrowMembershipReadFailure(error); membership = undefined; }
      if (membership === undefined) return refusal("unavailable", SIGN_IN_LINK_TEXT.unavailable);
      const at = iso();
      const slack = method === "slack" && person.linkedSlackUserId !== undefined ? person.linkedSlackUserId : undefined;
      const clearsSlack = slack !== undefined && person.slackUserId === slack;
      const writes: Write[] = [
        { Delete: { TableName: tableName, Key: { pk: `SIGNIN_LINKS#${personDeveloperId}`, sk: `METHOD#${method}` }, ConditionExpression: "linkedId = :linked", ExpressionAttributeValues: { ":linked": linkedId } } },
        // DEC 254zzz33 (4): the linked identity's record is kept, never deleted (the sign-in role deletes no DEVELOPER# row): it no longer points at the person, and records when and
        // from whom it was unlinked. One an admin turned off stays turned off. Any other signs in again as nobody's person, as a deleted record did: `companyless` (DEC 253z) so the
        // kept record is never "legacy" (company-membership.ts join would otherwise seat it in the built-in company with no invitation) and it may take a company-less session.
        // DEC 254zzz39: and the person's company, the only one it may be linked into again; a legacy first-sign-in mark (from the removed step-up factor email, DEC 254zzz73) goes too.
        { Update: { TableName: tableName, Key: { pk: `DEVELOPER#${linkedId}`, sk: "META" },
          UpdateExpression: "REMOVE mergedInto, firstSignInMark SET unlinkedAt = :at, unlinkedFrom = :person, unlinkedCompany = :company, companyless = :true",
          ConditionExpression: "mergedInto = :person AND revoked = :revoked",
          ExpressionAttributeValues: { ":person": personDeveloperId, ":revoked": linked.revoked === true, ":at": at, ":true": true, ":company": membership.companyId } } },
        // An admin's own membership still stands as checked (live, the person's company, owner or admin).
        ...(self ? [] : [{ ConditionCheck: { TableName: tableName, Key: membershipKey(developerId), ConditionExpression: "companyId = :company AND attribute_not_exists(revokedAt) AND (#role = :owner OR #role = :admin)",
          ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":company": membership.companyId, ":owner": "owner", ":admin": "admin" } } } satisfies Write]),
        // Every session of the person ends: one signed in with the removed method must not live on.
        { Update: { TableName: tableName, Key: { pk: `DEVELOPER#${personDeveloperId}`, sk: "META" },
          UpdateExpression: `SET sessionsEndedAt = :at${slack === undefined ? "" : ` REMOVE linkedSlackUserId${clearsSlack ? ", slackUserId" : ""}`}`,
          ConditionExpression: `attribute_exists(pk)${slack === undefined ? "" : " AND linkedSlackUserId = :su"}`,
          ExpressionAttributeValues: { ":at": at, ...(slack === undefined ? {} : { ":su": slack }) } } },
        { Put: { TableName: tableName, ConditionExpression: "attribute_not_exists(pk)", Item: {
          pk: companyScoped(OrgIdSchema.parse(membership.companyId), "COMPANY_LOG"), sk: `${at}#${randomBytes(16).toString("hex")}`, entityType: "COMPANY_LOG", event: "company-signin-unlink",
          companyId: membership.companyId, personId: personDeveloperId, createdBy: developerId, createdAt: at, method,
        } } },
      ];
      try { await documentClient.send(new TransactWriteCommand({ TransactItems: writes })); }
      catch (error) {
        if (conditionFailed(error)) return refusal("not_found", SIGN_IN_LINK_TEXT.notFound);
        throw error;
      }
      options.log({ event: "signin.unlinked", developerId, personDeveloperId, method, by: self ? "self" : "admin" });
      return { ok: true };
    },
  };

  /** A person's connected-method rows, all of them or an error (never a partial list). */
  async function connectedRows(personId: string): Promise<Array<z.infer<typeof ConnectedRow>>> {
    const answer = await documentClient.send(new QueryCommand({ TableName: tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": `SIGNIN_LINKS#${personId}` }, ConsistentRead: true, Limit: LINK_ROWS_MAX + 1 })) as { Items?: unknown[] };
    const items = answer.Items ?? [];
    if (items.length > LINK_ROWS_MAX) throw new Error("too many connected sign-ins");
    return items.map((item) => {
      const { pk: rowPk, sk: rowSk, ...fields } = (item ?? {}) as Record<string, unknown>;
      const row = ConnectedRow.safeParse(fields);
      if (!row.success || rowPk !== `SIGNIN_LINKS#${personId}` || row.data.personId !== personId || rowSk !== `METHOD#${row.data.method}`) throw new Error("unreadable connected sign-in");
      return row.data;
    });
  }

  /**
   * The provider's callback for a link (`state` is a link id; undefined when no link row has it). The row is consumed first (once); every later failure goes back to the web app with a
   * fixed `link_error`, never the provider's words. On success the browser alone gets the one-time code.
   */
  async function callback(method: DeveloperSignInMethod, query: URLSearchParams): Promise<HttpResult | undefined> {
    const expired = () => page("This connect link has expired", "Start connecting the sign-in again from your profile.");
    const id = query.get("state") ?? "";
    // No link row at all: an ordinary sign-in whose random state happens to start like a link id (the sign-in path answers it).
    if (!LINK_ID.test(id) || await read({ pk: `SIGNIN_LINK#${id}`, sk: "META" }) === undefined) return undefined;
    const link = await linkOf(id);
    if (link === undefined || link.method !== method || link.expiresAt <= seconds() || link.consumedAt !== undefined) return expired();
    const consumedAt = iso();
    try {
      await documentClient.send(new UpdateCommand({ TableName: tableName, Key: { pk: `SIGNIN_LINK#${id}`, sk: "META" }, UpdateExpression: "SET consumedAt = :at",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(consumedAt) AND expiresAt > :now AND #method = :method",
        ExpressionAttributeNames: { "#method": "method" }, ExpressionAttributeValues: { ":at": consumedAt, ":now": seconds(), ":method": method } }));
    } catch (error) {
      if (conditionFailed(error)) return expired();
      throw error;
    }
    const code = query.get("code");
    if (code === null) return back(link, { link_error: "cancelled" });
    let identity: Proved;
    try {
      const result = await options.provider(method).complete({ code, nonce: link.nonce, redirectUri: options.endpoint(`/callback/${method}`) });
      if (!result.ok) {
        options.log({ event: "signin.link_refused", developerId: link.developerId, reason: "provider_refused" });
        return back(link, { link_error: "refused" });
      }
      const proved = ProvedIdentity.safeParse({
        method: result.identity.method, issuer: result.identity.issuer, subject: result.identity.subject, displayName: result.identity.displayName.slice(0, 200),
        ...(result.identity.slackUserId === undefined ? {} : { slackUserId: result.identity.slackUserId }),
        ...(result.identity.slackTeam === undefined ? {} : { slackTeamId: result.identity.slackTeam.id }),
      });
      if (!proved.success || proved.data.method !== method) return back(link, { link_error: "refused" });
      identity = proved.data;
    } catch (error) {
      options.log({ event: "signin.link_operation_failed", operation: "callback", error: errorName(error) });
      return back(link, { link_error: "failed" });
    }
    const linkCode = `lnc_${randomBytes(32).toString("base64url")}`;
    try {
      await documentClient.send(new UpdateCommand({ TableName: tableName, Key: { pk: `SIGNIN_LINK#${id}`, sk: "META" }, UpdateExpression: "SET verifiedAt = :at, #identity = :identity, codeHash = :hash",
        ConditionExpression: "consumedAt = :consumed AND attribute_not_exists(verifiedAt)", ExpressionAttributeNames: { "#identity": "identity" }, ExpressionAttributeValues: { ":at": iso(), ":identity": identity, ":hash": sha256Hex(linkCode), ":consumed": consumedAt } }));
    } catch (error) {
      if (conditionFailed(error)) return expired();
      throw error;
    }
    return back(link, { link_id: id, link_code: linkCode });
  }

  return {
    /** Whether a callback's state names a link (rather than a sign-in request). */
    isLinkState: (state: string | null) => state !== null && state.startsWith("lnk_"),
    callback,
    start: (event: unknown) => guarded("start", () => operations.start(event)),
    finish: (event: unknown) => guarded("finish", () => operations.finish(event)),
    list: (event: unknown) => guarded("list", () => operations.list(event)),
    unlink: (event: unknown) => guarded("unlink", () => operations.unlink(event)),
  };
}
