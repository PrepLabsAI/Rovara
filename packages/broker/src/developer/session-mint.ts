// packages/broker/src/developer/session-mint.ts
// The two steps every session start shares, factored out of the sign-in server (a pure move: server.ts calls these exactly as it ran them inline) so the beta canary's
// session function (canary-session.ts) builds its session with the same code and never a copy: (1) "may this person hold a session for this company right now" and
// (2) "write the SESSION row, then issue the access token". Nothing here reads a request; every input is a parameter.
import { membershipReadFailed } from "../core/membership-read.js";
import { IMPLICIT_COMPANY_ID, OrgIdSchema, type DeveloperSignInMethod, type SignInClientRecord } from "@agentx/contracts";
import type { CompanySignInStore } from "./company-membership.js";
import type { CodeGrant, DeveloperSignInStore, SessionRecord } from "./store.js";

/** What the membership check reads: the company layer's store, the install's Slack binding, and the companyless rule (a function of the server's own state). */
export interface MintCheckDependencies {
  /** `join` is the legacy seat's (the sign-in server passes the whole store); a caller that never seats a legacy person leaves it out and cannot compile a call to it. */
  company: (Pick<CompanySignInStore, "hasOwnIssuer" | "membership"> & Partial<Pick<CompanySignInStore, "join">>) | undefined;
  slackCompany(): Promise<string | undefined>;
  companyless(personId: string, amr: DeveloperSignInMethod, registered: SignInClientRecord | undefined): Promise<boolean>;
}

/**
 * DEC 254b (a), 254h: whether the company the session names may be signed into by this method now. The built-in company takes anything; another company takes the install's shared
 * method (`installMethod`) exactly when it has no issuer of its own, GitHub only ever as the shared method, and Slack from a company with its own issuer only while the workspace is bound to it.
 */
async function methodFitsCompany(deps: MintCheckDependencies, company: NonNullable<MintCheckDependencies["company"]>, amr: DeveloperSignInMethod, companyId: string | undefined, installMethod: true | undefined): Promise<boolean> {
  if (installMethod === true && (companyId === undefined || companyId === IMPLICIT_COMPANY_ID)) return false;
  // DEC 254h: GitHub is only ever the shared method: outside the built-in company its session must carry that mark.
  if (amr === "github" && installMethod !== true && companyId !== undefined && companyId !== IMPLICIT_COMPANY_ID) return false;
  if (companyId === undefined || companyId === IMPLICIT_COMPANY_ID) return true;
  if (await company.hasOwnIssuer(companyId)) {
    // A company with its own sign-in: never the shared method; its Slack only while the install workspace is bound to it (as before).
    return installMethod !== true && (amr !== "slack" || await deps.slackCompany() === companyId);
  }
  return installMethod === true;
}

/** The person's membership row; with `legacySeat`, a person with none joins the built-in company first (the legacy seat). */
async function memberOf(company: NonNullable<MintCheckDependencies["company"]>, personId: string, legacySeat: boolean) {
  const member = await company.membership(personId);
  if (member !== undefined || !legacySeat || company.join === undefined) return member;
  const joined = await company.join({ personId, companyId: IMPLICIT_COMPANY_ID });
  // A join that could not READ or WRITE is not "not a member": the caller answers the retryable 503 and ends nothing (membership-read.ts).
  if (!joined.ok && joined.readFailed === true) throw membershipReadFailed();
  return joined.ok ? joined.membership : undefined;
}

/**
 * Recheck live membership at each mint. The stored company only selects the method. DEC 254b (a), 254e: a session (OIDC or Slack) for a company
 * other than the built-in one must match how that company signs in NOW: marked `installMethod` exactly when the company has no issuer of its own.
 */
export async function companyMayMint(deps: MintCheckDependencies, personId: string, amr: DeveloperSignInMethod, companyId: string | undefined, registered: SignInClientRecord | undefined, legacy = false, installMethod?: true): Promise<boolean> {
  const { company } = deps;
  if (company === undefined) return true;
  try {
    if (!await methodFitsCompany(deps, company, amr, companyId, installMethod)) return false;
    // DEC 254e: for Slack too, the company is the session's (membership checked below), never the workspace's binding.
    const candidate = companyId ?? IMPLICIT_COMPANY_ID;
    if (!OrgIdSchema.safeParse(candidate).success || (companyId !== undefined && companyId !== candidate)) return false;
    const member = await memberOf(company, personId, legacy && candidate === IMPLICIT_COMPANY_ID);
    // DEC 253z: no membership row at all, no company asked for, the web app: a session with no company, rechecked here at each mint.
    if (member === undefined && companyId === undefined) return await deps.companyless(personId, amr, registered);
    // Company is live membership; a registered audience cannot cross its owner.
    return member !== undefined && member.revokedAt === undefined && member.companyId === candidate
      && (registered === undefined || registered.installLevel === true || member.companyId === (registered.companyId ?? IMPLICIT_COMPANY_ID));
  } catch {
    // Everything read above is a read of membership, the company's sign-in settings or the Slack binding: a THROW is "the read failed", never "may not mint". Only a read that answers decides a refusal,
    // so a failed read can neither refuse a person nor (at the refresh) end their session; the caller answers the retryable 503 (membership-read.ts).
    throw membershipReadFailed();
  }
}

/** One access token as the sign-in server issues it (server.ts `accessToken`, tokens.ts `issueAccessToken`). */
export type IssueAccessToken = (session: SessionRecord) => Promise<{ token: string; expiresIn: number }>;

/**
 * Writes the SESSION row (with its refresh row) and issues the session's access token. `onSession` runs between the two, as the code grant's log line did.
 * A failure of `issue` leaves the row written (as the code grant always did): a caller that must not leave one revokes it (canary-session.ts does).
 */
export async function mintSession(store: Pick<DeveloperSignInStore, "createSession">, grant: CodeGrant & { reviewExpiresAt?: number; endsAt?: number }, issue: IssueAccessToken,
  onSession?: (session: SessionRecord) => void): Promise<{ session: SessionRecord; refreshToken: string; access: { token: string; expiresIn: number } }> {
  const { session, refreshToken } = await store.createSession(grant);
  onSession?.(session);
  return { session, refreshToken, access: await issue(session) };
}
