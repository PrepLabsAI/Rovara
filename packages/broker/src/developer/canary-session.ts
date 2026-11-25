// packages/broker/src/developer/canary-session.ts
// The beta canary's session function (CANARY-SESSION-PLAN): mints a 30-minute session for ONE fixed person in ONE fixed company, so the deploy-time canary lane can act as that
// member through /v1/dev/* and /v1/app/*. The person and company come from the function's own environment, never from a request: a request is exactly {kind:"canary-session"}
// or {kind:"canary-end"}, and every other shape is refused with nothing written. The session is the one a GitHub sign-in builds (session-mint.ts), with a shorter life and no
// refresh token ever leaving this file. Who may call it is the Lambda resource policy alone (infra/lib/canary-session.ts: one permission, the canary stack's step role).
// Nothing here logs or returns a token (except the one answer), a refresh token, a reason or an id of anyone but the session and the canary person.
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { IMPLICIT_COMPANY_ID, OrgIdSchema } from "@agentx/contracts";
import type { CompanySignInStore } from "./company-membership.js";
import { companyMayMint, mintSession } from "./session-mint.js";
import { sessionLogId } from "./session-log-id.js";
import type { DeveloperSignInStore, SessionRecord } from "./store.js";
import { issueAccessToken, type TokenSigner } from "./tokens.js";

/** The session's whole life: every API request re-reads SESSION#<id>.endsAt (aws/developer-routes.ts authenticateSession), so the one-hour access token dies with it. */
export const CANARY_SESSION_SECONDS = 30 * 60;
/** Mints per clock hour (a run mints 1 to 3; Cloud's own counter allows 16 runs a day). */
export const CANARY_MINTS_PER_HOUR = 20;
/** A counter item outlives the session it could hold by an hour or two, then expires by TTL. */
export const CANARY_COUNTER_TTL_SECONDS = 3 * 60 * 60;
export const CANARY_REVOKE_REASON = "canary-end";
const HOUR_MS = 60 * 60 * 1000;
const END_PASSES = 3;
const META = "META";

/** The only two requests. Strict: any other key, any other kind, an array, a string, a huge body: refused before anything is read or written. */
const CanaryRequest = z.union([z.strictObject({ kind: z.literal("canary-session") }), z.strictObject({ kind: z.literal("canary-end") })]);

/** The fixed words an answer may carry. Never a reason, a stack or an id. */
export type CanaryAnswer =
  | { ok: true; token: string; expiresAt: number; sessionId: string; memberCount: number }
  | { ok: true }
  | { ok: false; error: "not_set_up" | "refused" };

export interface CanarySessionConfig {
  /** The canary person (the 64-hex DEVELOPER# id of the owner's real GitHub sign-in) and company. */
  developerId: string;
  companyId: string;
  /** The issuer the token is signed for (the install's own, DEVELOPER_TOKEN_ISSUER) and the environment claim the API checks. */
  issuer: string;
  environment: string;
}

/**
 * The function's settings from its environment, or undefined (answers `not_set_up`). Beta only, by an explicit value and a pinned issuer, never by a stage word: beta's control plane is the
 * legacy layout, so AGENTX_ENV does not say "beta". CANARY_ENVIRONMENT must be exactly `beta`; CANARY_ISSUER (a stack parameter the deployer sets to beta's issuer) must equal the issuer the
 * function signs for; the person and the company must have the shapes the sign-in uses (64 hex; an `org_` id that is not the built-in company).
 */
export function canarySessionConfigFromEnvironment(env: NodeJS.ProcessEnv): CanarySessionConfig | undefined {
  const developerId = env.CANARY_DEVELOPER_ID ?? "";
  const companyId = env.CANARY_COMPANY_ID ?? "";
  const issuer = env.DEVELOPER_TOKEN_ISSUER ?? "";
  const environment = env.AGENTX_ENV ?? "";
  if (env.CANARY_ENVIRONMENT !== "beta" || issuer === "" || environment === "" || (env.CANARY_ISSUER ?? "") !== issuer) return undefined;
  if (!/^[a-f0-9]{64}$/.test(developerId) || !OrgIdSchema.safeParse(companyId).success || companyId === IMPLICIT_COMPANY_ID) return undefined;
  return { developerId, companyId, issuer, environment };
}

/** The mint counter and the session ids this function started, one item per clock hour: CANARY_MINT#<yyyymmddhh>. Read tolerantly (unknown fields ignored); an unreadable item throws. */
const CounterItem = z.object({ mints: z.number().int().nonnegative().optional(), sessionIds: z.array(z.string().min(1).max(64)).max(CANARY_MINTS_PER_HOUR).optional() });
const hourKey = (ms: number): { pk: string; sk: string } => ({ pk: `CANARY_MINT#${new Date(ms).toISOString().slice(0, 13).replace(/\D/g, "")}`, sk: META });
const conditionFailed = (error: unknown) => error instanceof Error && error.name === "ConditionalCheckFailedException";

export class CanaryMintStore {
  constructor(private readonly input: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number }) {}

  /** Takes one of this hour's slots and returns that hour's item key, or undefined when the hour is used up. Any other failure throws. */
  async reserve(): Promise<{ pk: string; sk: string } | undefined> {
    const at = this.input.now();
    const key = hourKey(at);
    try {
      await this.input.documentClient.send(new UpdateCommand({
        TableName: this.input.tableName, Key: key,
        UpdateExpression: "SET entityType = if_not_exists(entityType, :type), expiresAt = if_not_exists(expiresAt, :ttl) ADD mints :one",
        ConditionExpression: "attribute_not_exists(mints) OR mints < :limit",
        ExpressionAttributeValues: { ":type": "CANARY_MINT", ":ttl": Math.floor(at / 1000) + CANARY_COUNTER_TTL_SECONDS, ":one": 1, ":limit": CANARY_MINTS_PER_HOUR },
      }));
      return key;
    } catch (error) {
      if (conditionFailed(error)) return undefined;
      throw error;
    }
  }

  /** Remembers a session this function started, in the item of the hour whose slot it took, for `canary-end`. Throws when the list is full or the item is gone. */
  async record(key: { pk: string; sk: string }, sessionId: string): Promise<void> {
    await this.input.documentClient.send(new UpdateCommand({
      TableName: this.input.tableName, Key: key,
      UpdateExpression: "SET sessionIds = list_append(if_not_exists(sessionIds, :none), :one)",
      ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(sessionIds) OR size(sessionIds) < :cap)",
      ExpressionAttributeValues: { ":none": [], ":one": [sessionId], ":cap": CANARY_MINTS_PER_HOUR },
    }));
  }

  /** The sessions started this hour and the hour before (a session lives 30 minutes), as recorded. */
  async recorded(): Promise<Array<{ key: { pk: string; sk: string }; sessionIds: string[] }>> {
    const at = this.input.now();
    const found: Array<{ key: { pk: string; sk: string }; sessionIds: string[] }> = [];
    for (const key of [hourKey(at - HOUR_MS), hourKey(at)]) {
      const answer = await this.input.documentClient.send(new GetCommand({ TableName: this.input.tableName, Key: key, ConsistentRead: true })) as { Item?: unknown };
      if (answer.Item === undefined) continue;
      found.push({ key, sessionIds: CounterItem.parse(answer.Item).sessionIds ?? [] });
    }
    return found;
  }

  /**
   * Forgets the sessions of one hour's item after they were revoked, only while the list is still exactly the one that was revoked (a session recorded in between stays recorded).
   * Answers false when the list changed; the slot count stays (the hour's limit holds).
   */
  async clear(key: { pk: string; sk: string }, seen: string[]): Promise<boolean> {
    try {
      await this.input.documentClient.send(new UpdateCommand({
        TableName: this.input.tableName, Key: key, UpdateExpression: "SET sessionIds = :none", ConditionExpression: "sessionIds = :seen", ExpressionAttributeValues: { ":none": [], ":seen": seen },
      }));
      return true;
    } catch (error) {
      if (conditionFailed(error)) return false;
      throw error;
    }
  }
}

export interface CanarySessionDependencies {
  /** undefined: the function is not set up here (it answers `not_set_up`). */
  config: CanarySessionConfig | undefined;
  store: Pick<DeveloperSignInStore, "getDeveloper" | "createSession" | "revokeSession">;
  /** No `join`: the canary never seats a legacy person, and the role has no write on memberships. */
  company: Pick<CompanySignInStore, "companyExists" | "hasOwnIssuer" | "membership" | "listMembers">;
  counter: Pick<CanaryMintStore, "reserve" | "record" | "recorded" | "clear">;
  signer: TokenSigner;
  now: () => number;
  /** Fixed fields only: event, session (sessionLogId, never the id), developerId, code. */
  log: (entry: Record<string, unknown>) => void;
}

/** A refusal's log code. `rate` is only ever logged: the answer is `refused` for every code. */
class CanaryRefusal extends Error {
  constructor(readonly code: "refused" | "rate") { super("canary refused"); }
}
const refuse = (code: "refused" | "rate" = "refused"): never => { throw new CanaryRefusal(code); };

export function createCanarySession(deps: CanarySessionDependencies): (event: unknown) => Promise<CanaryAnswer> {
  const { config, store, company, counter } = deps;

  /** The person's row, their membership and their company's members, read fresh: one live member of the company, nobody else but its owner and admins. */
  async function checkPerson(c: CanarySessionConfig): Promise<number> {
    const developer = await store.getDeveloper(c.developerId);
    // The real sign-in's row: a GitHub person, live, never a merged or unlinked identity (the session says amr github, so the row must say it too).
    if (developer === undefined || developer.revoked || developer.provider !== "github" || developer.mergedInto !== undefined || developer.unlinkedAt !== undefined) return refuse();
    if (!await company.companyExists(c.companyId)) return refuse();
    const membership = await company.membership(c.developerId);
    if (membership === undefined || membership.companyId !== c.companyId || membership.revokedAt !== undefined || membership.role !== "member") return refuse();
    const roster = await company.listMembers(c.companyId, undefined, 100);
    if (roster.more) return refuse();
    const plain = roster.members.filter((member) => member.revokedAt === undefined && member.role === "member");
    if (plain.length !== 1 || plain[0]!.personId !== c.developerId) return refuse();
    // The session is a shared-method (installMethod) GitHub session: the same live check the callback and the refresh run, so a company that has its own sign-in is refused.
    const mayMint = await companyMayMint({ company, slackCompany: async () => undefined, companyless: async () => false }, c.developerId, "github", c.companyId, undefined, false, true);
    if (!mayMint) return refuse();
    return plain.length;
  }

  async function mint(c: CanarySessionConfig): Promise<CanaryAnswer> {
    const memberCount = await checkPerson(c);
    const slot = await counter.reserve();
    if (slot === undefined) return refuse("rate");
    const endsAt = Math.floor(deps.now() / 1000) + CANARY_SESSION_SECONDS;
    let started: SessionRecord | undefined;
    try {
      // The refresh token the store makes with the session is never bound to a name: it stays unread and is dropped here.
      const { session, access } = await mintSession(store, { developerId: c.developerId, amr: "github", companyId: c.companyId, installMethod: true, endsAt },
        (row) => issueAccessToken(deps.signer, { issuer: c.issuer, subject: row.developerId, amr: row.amr, env: c.environment, sessionId: row.sessionId, now: deps.now() }),
        (row) => { started = row; });
      await counter.record(slot, session.sessionId);
      deps.log({ event: "signin.canary_session", session: sessionLogId(session.sessionId), developerId: c.developerId });
      return { ok: true, token: access.token, expiresAt: session.endsAt * 1000, sessionId: session.sessionId, memberCount };
    } catch (error) {
      // Never a partial session: a row written whose token or record failed is revoked before answering.
      if (started !== undefined) await store.revokeSession(started.sessionId, CANARY_REVOKE_REASON).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Revokes the sessions this function recorded (this hour and the one before). Idempotent; touches no other session. A list that changed while it was revoked is read and revoked again
   * (three passes at most, then `refused`: the sessions end by themselves within 30 minutes).
   */
  async function end(): Promise<CanaryAnswer> {
    for (let pass = 0; pass < END_PASSES; pass++) {
      let settled = true;
      for (const item of await counter.recorded()) {
        for (const sessionId of item.sessionIds) await store.revokeSession(sessionId, CANARY_REVOKE_REASON);
        if (item.sessionIds.length > 0 && !await counter.clear(item.key, item.sessionIds)) settled = false;
      }
      if (settled) {
        deps.log({ event: "signin.canary_end" });
        return { ok: true };
      }
    }
    return refuse();
  }

  return async (event) => {
    if (config === undefined) {
      deps.log({ event: "signin.canary_refused", code: "not_set_up" });
      return { ok: false, error: "not_set_up" };
    }
    try {
      const request = CanaryRequest.safeParse(event);
      if (!request.success) return refuse();
      return request.data.kind === "canary-session" ? await mint(config) : await end();
    } catch (error) {
      deps.log({ event: "signin.canary_refused", code: error instanceof CanaryRefusal ? error.code : "refused" });
      return { ok: false, error: "refused" };
    }
  };
}
