// L4-GH: "Connect your GitHub" on a person's own profile (briefs/lead4/L4-GH-SCOPE.md). A member links the GitHub account that is theirs to themselves, so hosted Rovara can place the author of a
// commit or a review (a person's edit to a Rovara pull request, the merge approver's account) as a member of the company. The proof is the GitHub App's own user authorization (the same OAuth
// client and callback as "Connect GitHub", `github-connect-routes.ts`), read for ONE fact: GitHub's numeric user id and login. The user token is used for that one read and dropped; only the id and
// the login are kept (core/people/github-links.ts), under the company.
//
//   GET    /v1/dev/me/github              the caller's own link: { linked: false } or { linked: true, login, linkedAt }
//   POST   /v1/dev/me/github/link   {}                       a single-use state and GitHub's authorize address
//   POST   /v1/dev/me/github/link/claim  { state, code }     spend the state, check GitHub, link the account to the caller
//   DELETE /v1/dev/me/github                                 unlink the caller's own account
//
// Rules (the common brief's shared security rules):
//   - Only the Rovara web app's own sign-in client (`caller.webApp`) may call any of these routes; the CLI's token and any other full-access client are refused (403).
//   - Only the signed-in person, for themselves: the company and the person are the caller's LIVE membership (sign-in table) and verified token, read at every call; never a body, query, header or
//     token claim. There is no route that links or unlinks anyone else.
//   - The account is the one GitHub's own answer for the person who completed the authorization names (`GET /user`), never a number the browser sends. The state is 32 random bytes stored only as
//     sha256 with company, person, session, provider and a 10-minute expiry, spent once conditionally on all of those; a state of the install flow never works here and the reverse (a different
//     key family AND provider). Cloud also binds the state to its own cookie.
//   - Everything before the GitHub check passes is ONE answer (403 "Start again from Rovara."), so nothing tells whether a state exists. After it: 409 when the account is another member's of this
//     company (first link wins) or the caller already holds a different account; idempotent 200 when it is already theirs.
//   - One account per person, one person per account, per company: the two rows are written in one conditional transaction.
//   - DEC 254zzz73: no step-up; the web app's own client and the person's live membership are checked at start AND at claim.
//   - Never logged or returned: the code, the state, the user token. The claim's answer names the linked account (GitHub's numeric id and login, to the person who just proved it is theirs); log lines carry
//     event names and the person's id only; audit rows never carry the GitHub id or login.
//   - A member's removal from the company removes their link rows in the same request (company-member-routes.ts, L4-GH2; the person erase and the company purge remove them too), so re-adding the person
//     starts with no link. The identity point also reads the member live, so a removed member resolves to nobody meanwhile.
import { createHash, randomBytes } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { agentXError, companyLog, when, OrgIdSchema, type DocumentStore } from "@agentx/contracts";
import { githubAccountKey, githubAuditPk, githubLinkOf, githubPersonKey, isGithubLogin, linkGithubAccount, unlinkGithubAccount } from "../core/people/github-links.js";
import { Membership, membershipKey } from "./company-check.js";
import type { DeveloperCaller } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";

export const GITHUB_LINK_PATH = "/v1/dev/me/github";
const LINK = `${GITHUB_LINK_PATH}/link`;
const CLAIM = `${GITHUB_LINK_PATH}/link/claim`;
export const START_AGAIN = "Start again from Rovara.";
export const LINK_NOT_SET_UP = "Connecting your GitHub account isn't set up on this Rovara yet. Ask the Rovara team.";
export const LINK_UNAVAILABLE = "Your GitHub account could not be connected just now. Start again from Rovara.";
export const LINK_WEB_ONLY = "Connecting your GitHub account is done in the Rovara web app.";
export const LINK_TAKEN = "This GitHub account is already connected to another member of your company.";
export const LINK_HAS_ANOTHER = "You already have a GitHub account connected. Disconnect it first.";
export const LINK_READ_UNAVAILABLE = "Your GitHub connection could not be read just now; try again.";
export const UNLINK_UNAVAILABLE = "Your GitHub account could not be disconnected just now; try again.";
const SIGN_IN_AGAIN = "your AgentX sign-in has ended; run agentx login <url> again";

/** How long a state lives. */
export const GITHUB_LINK_TTL_SECONDS = 600;
const STATE_PROVIDER = "github-link";
// No TTL attribute on the state row: the guard test tests/contract/admin-health-infrastructure.test.ts pins the files that may name the store's expiry attribute (an owner-approved list). Like the install
// flow's GITHUB_CONNECT# rows, a spent or expired state stays until the company purge (it names its company); it can never be spent again (expiry and status are in the spend's condition).
/** The state's own key family: never the install flow's (`GITHUB_CONNECT#`), whatever the provider field says. */
const STATE_PK_PREFIX = "GITHUB_LINK_STATE#";

export interface GithubLinkWiring {
  /** The links and the states: the core's own store (the State table). */
  store: Pick<DocumentStore, "get" | "put" | "update" | "delete" | "transact">;
  github: {
    oauthClient(): Promise<{ clientId: string; clientSecret: string } | undefined>;
    /** Who the person behind a user authorization code is on GitHub. Throws for anything that is not a clear answer. Never keeps the user token. */
    githubUserOfCode(code: string): Promise<{ id: number; login: string }>;
  };
  /** The broker's log sink; every line goes through companyLog. Event names and ids only. */
  log: (entry: Record<string, unknown>) => void;
  /** Tests only: the 32 random bytes of a state. */
  random?: () => Buffer;
}

export interface GithubLinkContext {
  documentClient: { send(command: unknown): Promise<unknown> };
  /** The sign-in table (memberships). */
  signInTableName: string;
  now: () => number;
  wiring: GithubLinkWiring;
}

/** Whether this module answers the path (the dispatcher sends it here before anything is read). */
export function isGithubLinkPath(path: string): boolean {
  return path === GITHUB_LINK_PATH || path === LINK || path === CLAIM;
}

const Secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const NoBody = z.object({}).strict();
const ClaimBody = z.object({ state: Secret, code: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict();
const StoredState = z.object({
  entityType: z.literal("GITHUB_LINK_STATE"), provider: z.literal(STATE_PROVIDER), status: z.literal("live"),
  companyId: OrgIdSchema, personId: z.string().regex(/^[a-f0-9]{64}$/), sessionId: z.string().min(1).max(256),
  createdAt: z.iso.datetime(), expiresAt: z.number().int().positive(),
}).passthrough();

const startAgain = () => agentXError("FORBIDDEN", START_AGAIN);
const hashOf = (secret: string) => createHash("sha256").update(secret, "utf8").digest("hex");
const stateKey = (secret: string) => ({ pk: `${STATE_PK_PREFIX}${hashOf(secret)}`, sk: "META" });

function body(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { return undefined; }
}

/** The caller's live membership in `companyId`, or 401. Any role: linking one's own account is every member's. */
async function liveMembership(ctx: GithubLinkContext, caller: DeveloperCaller, companyId: string): Promise<z.infer<typeof Membership>> {
  try {
    const response = await ctx.documentClient.send(new GetCommand({ TableName: ctx.signInTableName, Key: membershipKey(caller.developerId), ConsistentRead: true })) as { Item?: unknown };
    const member = Membership.parse(response.Item);
    if (member.personId !== caller.developerId || member.companyId !== companyId || member.revokedAt !== undefined || !OrgIdSchema.safeParse(companyId).success) throw new Error("membership");
    return member;
  } catch { throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN); }
}

/** Spends a live state once, only for the same company, person and session, before its expiry. `true` only when this call spent it. */
async function spend(ctx: GithubLinkContext, secret: string, who: { companyId: string; personId: string; sessionId: string }): Promise<boolean> {
  try {
    const key = stateKey(secret);
    const nowSeconds = Math.floor(ctx.now() / 1000);
    const row = await ctx.wiring.store.get(key);
    if (row === undefined) return false;
    const stored = StoredState.parse(Object.fromEntries(Object.entries(row).filter(([name]) => name !== "pk" && name !== "sk")));
    if (stored.companyId !== who.companyId || stored.personId !== who.personId || stored.sessionId !== who.sessionId || stored.expiresAt <= nowSeconds) return false;
    const spent = await ctx.wiring.store.update({
      key,
      ops: [{ op: "set", path: ["status"], value: "used" }, { op: "set", path: ["usedAt"], value: new Date(ctx.now()).toISOString() }],
      condition: when.and(
        when.eq("status", "live"), when.eq("provider", STATE_PROVIDER), when.eq("companyId", who.companyId), when.eq("personId", who.personId), when.eq("sessionId", who.sessionId),
        when.gt("expiresAt", nowSeconds),
      ),
    });
    return spent.applied;
  } catch { return false; }
}

/**
 * The routes. The caller is authenticated and its route row (`full`) applied; `companyId` is its live membership's company (resolveCompany). The membership row is read again here, so a company
 * that changed since is what counts.
 */
export async function routeGithubLink(ctx: GithubLinkContext, caller: DeveloperCaller, companyId: string, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  // A session that is not a sign-in session (a registered service's own token has none) is never a person linking their own account.
  if (caller.sessionId === "") throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  // Only the Rovara web app's own sign-in client (full access AND marked `webApp` by the operator): another full-access client could show GitHub's page to someone else
  // and pass the code back, which would link that someone's account to this person. Cloud's cookie binding is the only thing tying the browser at GitHub to the person, and it is the web app's.
  if (caller.webApp !== true) throw agentXError("FORBIDDEN", LINK_WEB_ONLY);
  const member = await liveMembership(ctx, caller, companyId);
  const who = { companyId: member.companyId, personId: caller.developerId, sessionId: caller.sessionId };
  const store = ctx.wiring.store;
  const log = companyLog(member.companyId, ctx.wiring.log);

  if (url.pathname === GITHUB_LINK_PATH) {
    if (request.method === "GET") {
      try {
        const link = await githubLinkOf(store, who.companyId, who.personId);
        return link === undefined ? { linked: false as const } : { linked: true as const, login: link.login, linkedAt: link.linkedAt };
      } catch { throw agentXError("RUNTIME_UNAVAILABLE", LINK_READ_UNAVAILABLE); }
    }
    if (request.method !== "DELETE") throw agentXError("NOT_FOUND", "not found");
    if (!NoBody.safeParse(body(request)).success) throw agentXError("CONFIG_INVALID", "disconnecting your GitHub account takes no body");
    let removed: boolean;
    try {
      const at = new Date(ctx.now()).toISOString();
      removed = await unlinkGithubAccount(store, who.companyId, who.personId, { audit: { at, actor: who.personId } });
    } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNLINK_UNAVAILABLE); }
    if (removed) log({ event: "github.account_unlinked", actor: who.personId });
    return { unlinked: removed };
  }

  if (request.method !== "POST") throw agentXError("NOT_FOUND", "not found");

  if (url.pathname === LINK) {
    if (!NoBody.safeParse(body(request)).success) throw agentXError("CONFIG_INVALID", "connecting your GitHub account takes no body");
    let client: { clientId: string } | undefined;
    try { client = await ctx.wiring.github.oauthClient(); } catch { throw agentXError("RUNTIME_UNAVAILABLE", LINK_NOT_SET_UP); }
    if (client === undefined || !/^[A-Za-z0-9.]{1,64}$/.test(client.clientId)) throw agentXError("RUNTIME_UNAVAILABLE", LINK_NOT_SET_UP);
    const bytes = ctx.wiring.random?.() ?? randomBytes(32);
    if (bytes.length !== 32) throw agentXError("RUNTIME_UNAVAILABLE", LINK_UNAVAILABLE);
    const secret = bytes.toString("base64url");
    const nowMs = ctx.now();
    const expiresAt = Math.floor(nowMs / 1000) + GITHUB_LINK_TTL_SECONDS;
    try {
      const written = await store.put({
        item: { ...stateKey(secret), entityType: "GITHUB_LINK_STATE", provider: STATE_PROVIDER, status: "live", ...who, createdAt: new Date(nowMs).toISOString(), expiresAt },
        condition: when.absent(),
      });
      if (!written.applied) throw new Error("state");
    } catch { throw agentXError("RUNTIME_UNAVAILABLE", LINK_UNAVAILABLE); }
    const state = encodeURIComponent(secret);
    return { state: secret, expiresAt: new Date(expiresAt * 1000).toISOString(), authorizeUrl: `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(client.clientId)}&state=${state}` };
  }

  if (url.pathname === CLAIM) {
    const parsed = ClaimBody.safeParse(body(request));
    if (!parsed.success) throw startAgain();
    if (!await spend(ctx, parsed.data.state, who)) throw startAgain();
    let user: { id: number; login: string };
    try { user = await ctx.wiring.github.githubUserOfCode(parsed.data.code); } catch { throw startAgain(); }
    // GitHub's own answer, re-checked: a positive whole id and a plain login, else nothing is linked.
    if (!Number.isSafeInteger(user.id) || user.id <= 0 || !isGithubLogin(user.login)) throw startAgain();
    let outcome: Awaited<ReturnType<typeof linkGithubAccount>>;
    try {
      const at = new Date(ctx.now()).toISOString();
      outcome = await linkGithubAccount(store, { companyId: who.companyId, githubUserId: String(user.id), login: user.login, personId: who.personId, linkedAt: at, audit: { at, actor: who.personId } });
    } catch { throw agentXError("RUNTIME_UNAVAILABLE", LINK_UNAVAILABLE); }
    if (outcome === "taken") throw agentXError("GITHUB_ACCOUNT_TAKEN", LINK_TAKEN);
    if (outcome === "person_has_another") throw agentXError("GITHUB_ACCOUNT_LINK_EXISTS", LINK_HAS_ANOTHER);
    if (outcome === "linked") log({ event: "github.account_linked", actor: who.personId });
    return { status: "linked" as const, alreadyLinked: outcome === "same", githubUser: { id: user.id, login: user.login } };
  }
  throw agentXError("NOT_FOUND", "not found");
}

// Exported for the tests: where the rows live.
export { githubAccountKey, githubPersonKey, githubAuditPk };
