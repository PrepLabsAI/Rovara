// Run-scoped test accounts. For each browser/API round the environment's account provisioner makes FRESH accounts that die with the round, so a trace or a video kept as evidence
// holds only credentials that no longer work. This module is the lifecycle and nothing else: it records a durable lease, provisions, bounds the expiry, ends the account's sessions, revokes it,
// and PROVES the revocation. The result of that proof is what lets the evidence pack publish a video or a trace; a pack never gets it from the worker.
//
// What "revoked" means here (revocation). A refused NEW login proves almost nothing: a session or token the round was already issued can outlive the account (a Cognito JWT is checked offline until `exp`;
// a deleted user row often leaves server-side sessions or signed cookies valid). So the proof has three parts, all required:
//   1. the account's sessions were ended (`endSessions`, before the delete) and the account was revoked;
//   2. an EXISTENCE probe says the account is gone (the user is not found, the hook answers 404);
//   3. a SESSION probe replays a real credential the round held (a cookie or bearer, kept in memory by the round controller, never persisted) against an authenticated endpoint the environment names and
//      gets 401/403 for every one.
// A probe that proves nothing must never confirm: a replay with no secret, the wrong scheme, or an endpoint that answers 401/404 to everyone looks "dead" for ever. So BEFORE anything is revoked each
// credential is replayed and must answer ALIVE, and the account must answer PRESENT; only a credential that was alive before can show "dead" after, and only a probe that saw the account can show it gone.
// Where that positive control is missing, or the session probe cannot be run at all (no credential kept, no endpoint named, the port has none, the answer is unclear), publication is HELD until the stated token
// lifetime has passed since the revocation (`heldUntil`; an unstated lifetime is assumed to be a day and the report says so); `confirmed` stays false until then. A stated lifetime above the configured
// maximum hold REFUSES (the media is not published) rather than being shortened. A replayed credential that still WORKS is never confirmed, however long one waits.
// The replay endpoint must be the APP's own authenticated route. A Cognito resource server that checks JWTs offline accepts an access token until `exp` even after AdminUserGlobalSignOut, so a "dead" answer from a
// Cognito API proves nothing about the app. Publication reads the report ONLY through `revocationSettledAt(report, now)`.
//
// Durable leases (leases). Before `create` is called, a lease record is written (the id doubles as the handle the remote side is told to use, so a create that times out can still be revoked), and
// `sweepRunScopedLeases` revokes the leases a crash left behind once they are past their expiry. The record holds no secret: the approved account entry (pool id, role ARN, hook URLs, a secret NAME), the
// handle and the expiry.
//
// Everything that touches the outside world (the sandbox, a Cognito test pool, the customer's hook, the replay) is an injected port, so this file has no network, no AWS SDK and no clock of its own. A real
// binding to a customer's account is deployed and called through the install's own wrapper only.
//
// Rules, all fail closed:
//   - a lease expires at most `RUN_SCOPED_GRACE_MS` after the round ends, and never in the past;
//   - one account failing to provision revokes the ones already made (and the one that was being made) and refuses the round's media;
//   - nothing secret is kept on a lease: the secrets a provisioner returns go to the caller's redactor list and nowhere else; refs are short plain identifiers.
import { z } from "zod";
import { provisionerIsRunScoped, TestEnvAccountSchema, type TestEnvAccount } from "@agentx/contracts";

/** A lease may outlive its round by at most this long (round end + 15 minutes). */
export const RUN_SCOPED_GRACE_MS = 15 * 60_000;
/** A round longer than this is refused: an account that lives longer than a working session is not run-scoped. */
export const RUN_SCOPED_MAX_ROUND_MS = 4 * 3_600_000;
/** Each port call is given this long. */
export const RUN_SCOPED_CALL_MS = 30_000;
/** A revoke (and an end-sessions) is tried this many times before it counts as failed. */
export const RUN_SCOPED_REVOKE_ATTEMPTS = 3;
/** The token lifetime ASSUMED when the environment states none: a day, the most a Cognito access or ID token can last. It is a guess for any other app, and the report says it was assumed. */
export const RUN_SCOPED_ASSUMED_TOKEN_TTL_MS = 24 * 3_600_000;
/** The longest hold publication will wait out by default (two weeks). A stated lifetime above the configured maximum refuses media instead of shortening the wait. */
export const RUN_SCOPED_DEFAULT_MAX_HOLD_MS = 14 * 24 * 3_600_000;
const MIN_HOLD_MS = 60_000;
/** A store write is tried this many times before it is an alert. */
export const RUN_SCOPED_STORE_ATTEMPTS = 3;
/** At most this many credentials are replayed per account (a generous bound; the real issued set is a few). Any beyond it count as uncontrolled, never as proved. */
export const RUN_SCOPED_SESSION_PROBES_MAX = 32;
const SECRETS_MAX = 8;
const SECRET_MAX_LENGTH = 512;

export type RunScopedProvisioner = "seed_command" | "cognito_test_pool" | "http_hook";
export type RunScopedAccount = Exclude<TestEnvAccount, { provisioner: "registered" }>;

/** What the round controller kept in memory of a session the round really held. Never stored, never logged, never on a lease. */
export type SessionCredential = Readonly<{ kind: "cookie" | "bearer"; value: string }>;
export type SessionState = "dead" | "alive" | "unclear";
export type AccountPresence = "gone" | "present" | "unclear";

type Created = { loginRef: string; revokeHandle: string; secrets?: string[] | undefined };

/**
 * The ports one provisioner kind needs. All three kinds share this shape. A call about an account that does not exist (UserNotFound, a 404) is a SUCCESS for `endSessions` and `revoke`: cleaning up after a
 * `create` that never made the account must not look like a failure.
 */
export interface AccountProvisionerPort {
  /**
   * Makes a fresh account that must not be usable after `expiresAt`. `leaseId` is the id of the durable lease written before this call: use it as the account's handle (a username, a hook id) so the account
   * can be revoked even if this call never returns. `secrets` are the values the account's login holds (password, token): they are handed to the redactor, never kept.
   */
  create(input: { account: RunScopedAccount; leaseId: string; expiresAt: string; signal: AbortSignal }): Promise<Created>;
  /** Ends every session of the account (Cognito AdminUserGlobalSignOut, the hook's end-sessions call, the sandbox's session table). Resolves when the provisioner says they are ended. */
  endSessions(input: { account: RunScopedAccount; revokeHandle: string; signal: AbortSignal }): Promise<void>;
  /** Deletes or disables the account. Resolves when the provisioner says it is gone. */
  revoke(input: { account: RunScopedAccount; revokeHandle: string; signal: AbortSignal }): Promise<void>;
  /** An EXISTENCE probe: "gone" only when the provisioner says the account is not there (UserNotFound, a 404). Anything else is not a proof. */
  accountExists(input: { account: RunScopedAccount; revokeHandle: string; signal: AbortSignal }): Promise<AccountPresence>;
  /**
   * A SESSION probe: replays one credential the round held against an authenticated endpoint the environment names and answers "dead" only for a 401/403. Absent when the provisioner has no endpoint to
   * replay against; publication is then held for the token lifetime.
   */
  sessionState?(input: { account: RunScopedAccount; credential: SessionCredential; signal: AbortSignal }): Promise<SessionState>;
}
export type AccountProvisionerPorts = Readonly<Record<RunScopedProvisioner, AccountProvisionerPort | undefined>>;

/** The one reading of an HTTP status from a replayed credential: 401 and 403 are dead, 2xx and 3xx are alive, anything else (a 5xx, a network failure, a 404 of a missing route) proves nothing. */
export function sessionStateOfStatus(status: number | undefined): SessionState {
  if (status === 401 || status === 403) return "dead";
  if (status !== undefined && status >= 200 && status < 400) return "alive";
  return "unclear";
}

const REF = /^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,199}$/u;
const CreatedSchema = z.object({ loginRef: z.string().regex(REF), revokeHandle: z.string().regex(REF), secrets: z.array(z.string().min(1).max(SECRET_MAX_LENGTH)).max(SECRETS_MAX).optional() }).strict();

export interface RunScopedLease {
  /** The id of the durable lease record; also the handle a provisioner is told to use. */
  leaseId: string;
  profileId: string;
  provisioner: RunScopedProvisioner;
  loginRef: string;
  revokeHandle: string;
  expiresAt: string;
}

// ---- the durable lease store (leases)

export type LeaseState = "creating" | "active" | "revoked";
/** What is written about a lease. No secret: the approved account entry holds names and addresses only (a secret NAME for a hook, never its value). */
export interface LeaseRecord {
  leaseId: string;
  roundId: string;
  profileId: string;
  provisioner: RunScopedProvisioner;
  account: RunScopedAccount;
  state: LeaseState;
  /** The handle to revoke by: the lease id until the provisioner answers with its own. */
  revokeHandle: string;
  loginRef?: string;
  createdAt: string;
  expiresAt: string;
}
export interface LeaseStore {
  /** Writes the record and resolves only once it is durable. A rejection refuses the round: nothing is created without a record. */
  put(record: LeaseRecord): Promise<void>;
  update(leaseId: string, patch: Partial<Pick<LeaseRecord, "state" | "revokeHandle" | "loginRef">>): Promise<void>;
  /** Every lease that is not `revoked`. */
  listOutstanding(): Promise<LeaseRecord[]>;
}

const LEASE_ID = /^rvl-[A-Za-z0-9-]{8,60}$/u;

/** A lease write that failed every attempt: for the caller's alarm. Fixed code and the lease id only. */
export interface LeaseAlert { code: "lease_update_failed"; leaseId: string }
export type LeaseAlertHook = (alert: LeaseAlert) => void;

/** Writes a lease update, tried a few times. A failure is never swallowed: it is an alert, and the caller learns it from the `false`. */
async function updateLease(store: LeaseStore, leaseId: string, patch: Parameters<LeaseStore["update"]>[1], onAlert: LeaseAlertHook | undefined): Promise<boolean> {
  for (let attempt = 0; attempt < RUN_SCOPED_STORE_ATTEMPTS; attempt += 1) {
    try { await store.update(leaseId, patch); return true; } catch { /* tried again, then an alert */ }
  }
  try { onAlert?.({ code: "lease_update_failed", leaseId }); } catch { /* the alarm failing changes nothing here */ }
  return false;
}

async function bounded<T>(call: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
  const signal = outer === undefined ? AbortSignal.timeout(RUN_SCOPED_CALL_MS) : AbortSignal.any([outer, AbortSignal.timeout(RUN_SCOPED_CALL_MS)]);
  if (signal.aborted) throw new Error("aborted");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(new Error("aborted")); signal.addEventListener("abort", onAbort, { once: true }); });
  try {
    return await Promise.race([call(signal), aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/** The latest moment a lease for a round ending at `roundEndsAt` may expire. */
export function runScopedExpiry(roundEndsAt: string): string {
  return new Date(Date.parse(roundEndsAt) + RUN_SCOPED_GRACE_MS).toISOString();
}

export interface HoldPlan { ms: number; assumed: boolean }
/**
 * How long publication is held when the session proof is not whole. The STATED token lifetime is used as it is (never capped down; at least a minute); unstated or unusable is assumed to be a day
 * (`assumed: true`). Above `maxHoldMs` (the configured maximum) there is no hold at all: `refused`, and the media is not published.
 */
export function holdFor(input: { statedTtlMs?: number | undefined; maxHoldMs?: number | undefined }): HoldPlan | { refused: "token_lifetime_over_max_hold" } {
  const stated = input.statedTtlMs !== undefined && Number.isFinite(input.statedTtlMs) && input.statedTtlMs > 0 ? Math.max(MIN_HOLD_MS, Math.floor(input.statedTtlMs)) : undefined;
  const ms = stated ?? RUN_SCOPED_ASSUMED_TOKEN_TTL_MS;
  const max = input.maxHoldMs !== undefined && Number.isFinite(input.maxHoldMs) && input.maxHoldMs > 0 ? input.maxHoldMs : RUN_SCOPED_DEFAULT_MAX_HOLD_MS;
  return ms > max ? { refused: "token_lifetime_over_max_hold" } : { ms, assumed: stated === undefined };
}

/** Fixed reasons, never a provisioner's or an error's own words. */
export const RUN_SCOPED_FAILURES = ["no_run_scoped_accounts", "round_window_invalid", "no_provisioner", "provision_failed", "provisioner_answer_invalid", "duplicate_profile", "lease_store_failed"] as const;
export type RunScopedFailure = (typeof RUN_SCOPED_FAILURES)[number];

export type ProvisionResult =
  | { ok: true; leases: RunScopedLease[]; secrets: string[]; /** Profiles that are long-lived registry accounts: not run-scoped, so no video or trace. */ registered: string[] }
  | { ok: false; code: RunScopedFailure; /** The accounts made before the failure (and the one being made) were revoked and proved gone. */ cleanedUp: boolean };

async function retried(call: (signal: AbortSignal) => Promise<unknown>, signal: AbortSignal | undefined): Promise<boolean> {
  for (let attempt = 0; attempt < RUN_SCOPED_REVOKE_ATTEMPTS; attempt += 1) {
    try { await bounded(call, signal); return true; } catch { /* tried again, then counted as failed */ }
  }
  return false;
}

/**
 * Provisions every run-scoped account of the approved environment for one round. `registered` accounts are listed and left alone. Refuses a round window that is not in the future or is longer than
 * `RUN_SCOPED_MAX_ROUND_MS`, a missing provisioner for a kind in use, a port answer of the wrong shape, a profile named twice, and a lease that cannot be written. If one account fails, the ones already made
 * AND the one being made (by its pre-known lease id) are revoked first.
 */
export async function provisionRunScopedAccounts(input: { accounts: readonly TestEnvAccount[]; roundId: string; roundEndsAt: string; now: number; ports: AccountProvisionerPorts; store: LeaseStore;
  newLeaseId(): string; onAlert?: LeaseAlertHook; signal?: AbortSignal }): Promise<ProvisionResult> {
  const accounts = input.accounts.map((account) => TestEnvAccountSchema.parse(account));
  const registered = accounts.filter((account) => !provisionerIsRunScoped(account.provisioner)).map((account) => account.profileId);
  const scoped = accounts.filter((account): account is RunScopedAccount => provisionerIsRunScoped(account.provisioner));
  if (scoped.length === 0) return { ok: false, code: "no_run_scoped_accounts", cleanedUp: true };
  if (new Set(accounts.map((account) => account.profileId)).size !== accounts.length) return { ok: false, code: "duplicate_profile", cleanedUp: true };
  const endsAt = Date.parse(input.roundEndsAt);
  if (!Number.isFinite(endsAt) || endsAt <= input.now || endsAt - input.now > RUN_SCOPED_MAX_ROUND_MS) return { ok: false, code: "round_window_invalid", cleanedUp: true };
  if (scoped.some((account) => input.ports[account.provisioner] === undefined)) return { ok: false, code: "no_provisioner", cleanedUp: true };

  const expiresAt = runScopedExpiry(input.roundEndsAt);
  const leases: RunScopedLease[] = [];
  const records: LeaseRecord[] = [];
  const secrets: string[] = [];
  const cleaned = (report: RevocationReport) => report.accounts.every((item) => item.sessionsEnded && item.revoked && item.accountGone);
  const revokeAll = (leasesToRevoke: readonly RunScopedLease[], store: LeaseStore | undefined) => revokeRunScopedAccounts({ leases: leasesToRevoke, accounts, ports: input.ports, ...(store === undefined ? {} : { store }), now: input.now, control: false,
    ...(input.onAlert === undefined ? {} : { onAlert: input.onAlert }), ...(input.signal === undefined ? {} : { signal: input.signal }) });
  /**
   * Revokes what was made. `claimed` is a handle the provisioner named in an answer that was refused: the account may live under it, so it is revoked by it too, and when that cannot be proven the
   * durable record is pointed at it (state "active"), so the sweeper reaches the real account and alarms until it is gone.
   */
  const cleanUp = async (claimed?: string): Promise<boolean> => {
    const last = records.at(-1);
    if (claimed === undefined || last === undefined) return cleaned(await revokeAll(records.map(leaseOf), input.store));
    const ofOthers = cleaned(await revokeAll(records.slice(0, -1).map(leaseOf), input.store));
    // by the lease id it was told to use (no record update: a 404 here proves nothing about an account under another handle) and by the handle it claimed
    const byLeaseId = cleaned(await revokeAll([leaseOf(last)], undefined));
    const byClaim = cleaned(await revokeAll([{ ...leaseOf(last), revokeHandle: claimed }], input.store));
    if (!byClaim) await updateLease(input.store, last.leaseId, { state: "active", revokeHandle: claimed }, input.onAlert);
    return ofOthers && byLeaseId && byClaim;
  };
  for (const account of scoped) {
    const port = input.ports[account.provisioner]!;
    const leaseId = input.newLeaseId();
    if (!LEASE_ID.test(leaseId)) return { ok: false, code: "lease_store_failed", cleanedUp: records.length === 0 || (await cleanUp()) };
    const record: LeaseRecord = { leaseId, roundId: input.roundId, profileId: account.profileId, provisioner: account.provisioner, account, state: "creating", revokeHandle: leaseId,
      createdAt: new Date(input.now).toISOString(), expiresAt };
    // The record is durable BEFORE the account exists: a crash between the two leaves a lease the sweeper revokes, never an account nobody knows about.
    try { await input.store.put(record); } catch { return { ok: false, code: "lease_store_failed", cleanedUp: records.length === 0 || (await cleanUp()) }; }
    records.push(record);
    let failure: RunScopedFailure | undefined;
    let claimed: string | undefined;
    try {
      const created = await bounded((signal) => port.create({ account, leaseId, expiresAt, signal }), input.signal);
      const parsed = CreatedSchema.safeParse(created);
      // The account's handle IS the lease id: the durable record names it before the account exists, so a revoke by the record (the sweeper, after a crash) always reaches the real
      // account. An answer that names another handle is refused, and the account is revoked by the lease id it was told to use.
      if (!parsed.success || parsed.data.revokeHandle !== leaseId) {
        failure = "provisioner_answer_invalid";
        if (parsed.success) claimed = parsed.data.revokeHandle;
      } else {
        record.state = "active";
        record.loginRef = parsed.data.loginRef;
        // A failed update is not swallowed: the record would say "creating" for an account that is now live. It is retried, alerted, and the round is cleaned up and refused.
        if (!(await updateLease(input.store, leaseId, { state: "active", loginRef: record.loginRef }, input.onAlert))) failure = "lease_store_failed";
        else {
          leases.push(leaseOf(record));
          secrets.push(...(parsed.data.secrets ?? []));
        }
      }
    } catch {
      // The remote side may have made the account before the call failed (a timeout): it is revoked by the lease id it was told to use.
      failure = "provision_failed";
    }
    if (failure !== undefined) return { ok: false, code: failure, cleanedUp: await cleanUp(claimed) };
  }
  return { ok: true, leases, secrets, registered };
}

function leaseOf(record: LeaseRecord): RunScopedLease {
  return { leaseId: record.leaseId, profileId: record.profileId, provisioner: record.provisioner, loginRef: record.loginRef ?? "unknown", revokeHandle: record.revokeHandle, expiresAt: record.expiresAt };
}

export interface RevokedAccount {
  profileId: string;
  /** Every session of the account was ended before it was deleted. */
  sessionsEnded: boolean;
  revoked: boolean;
  /** The existence probe said the account is not there AFTER the revoke. */
  accountGone: boolean;
  /** The same probe said the account WAS there before the revoke: the positive control. Without it a "gone" proves nothing (a route that 404s for everyone). */
  existenceControl: boolean;
  /**
   * What replaying the round's real credentials showed. "dead": every credential was ALIVE before the revoke and refused after. "alive": one still works after. "unclear": a probe could not say, or a credential
   * had no positive control (it was not alive before). "not_possible": no valid credential, no probe, or no endpoint.
   */
  sessionProof: "dead" | "alive" | "unclear" | "not_possible";
  /** The lease record says revoked. False when the store could not be written (after retries, with an alert): the lease must not be called swept. */
  recorded: boolean;
}

export interface RevocationReport {
  /**
   * True only when every account passed all three parts of the proof WITH their positive controls, and where a control or the session probe was missing, the hold has run out. This is the value at the moment
   * the report was made; publication must ask `revocationSettledAt(report, now)` instead.
   */
  confirmed: boolean;
  /** When a proof was not whole for some account: the instant after which every token the round held has expired (revocation time plus the token lifetime). Absent when every proof was whole. */
  heldUntil?: string;
  /** The hold used the day ASSUMED because the environment states no token lifetime. Say so wherever the hold is shown. */
  ttlAssumed?: true;
  /** The environment's stated token lifetime is above the configured maximum hold: the media is refused, never published, whatever is waited. */
  holdRefused?: "token_lifetime_over_max_hold";
  accounts: RevokedAccount[];
}

const wholeProof = (item: RevokedAccount) => item.sessionProof === "dead" && item.existenceControl;

/**
 * Whether a report is confirmed at `now`: its parts all hold, and any hold has run out. Publication reads the proof through THIS and nothing else. A replayed credential that still works never settles, and neither
 * does a refused hold or a report with no account.
 */
export function revocationSettledAt(report: RevocationReport, now: number): boolean {
  if (report.holdRefused !== undefined || report.accounts.length === 0 || !report.accounts.every((item) => item.sessionsEnded && item.revoked && item.accountGone && item.sessionProof !== "alive")) return false;
  if (report.accounts.every(wholeProof)) return true;
  return report.heldUntil !== undefined && Number.isFinite(Date.parse(report.heldUntil)) && now >= Date.parse(report.heldUntil);
}

/**
 * Ends the sessions of every lease, revokes the account, and proves it (see the top of the file). `sessions` are the credentials the round really held, by profile id, in memory only. Retried and bounded;
 * never throws, and keeps going after a failure so one stuck account does not leave the others alive. Marks each fully revoked lease in the store (retried; a failure is an alert and `recorded: false`).
 * `control: false` skips the positive controls (the sweeper and a failed provision's cleanup have no proof to give, only a cleanup to make). `clock` reads the time AFTER the revocations, for the hold.
 */
export async function revokeRunScopedAccounts(input: { leases: readonly RunScopedLease[]; accounts: readonly TestEnvAccount[]; ports: AccountProvisionerPorts; store?: LeaseStore; now: number;
  sessions?: ReadonlyMap<string, readonly SessionCredential[]>; maxTokenTtlMs?: number; maxHoldMs?: number; control?: boolean; clock?: () => number; onAlert?: LeaseAlertHook; signal?: AbortSignal }): Promise<RevocationReport> {
  const report: RevokedAccount[] = [];
  const control = input.control !== false;
  let needsHold = false;
  for (const lease of input.leases) {
    const account = input.accounts.find((item) => item.profileId === lease.profileId && item.provisioner === lease.provisioner);
    const port = input.ports[lease.provisioner];
    if (account === undefined || !provisionerIsRunScoped(account.provisioner) || port === undefined) { report.push({ profileId: lease.profileId, sessionsEnded: false, revoked: false, accountGone: false, existenceControl: false, sessionProof: "not_possible", recorded: false }); continue; }
    const scoped = account as RunScopedAccount;
    const probe = <T>(call: (signal: AbortSignal) => Promise<T>, fallback: T) => bounded(call, input.signal).catch(() => fallback);

    // The positive controls, BEFORE anything is revoked: the account must be seen PRESENT, and each credential seen ALIVE. A probe that cannot see them proves nothing afterwards.
    let existenceControl = false;
    const controlled: SessionCredential[] = [];
    // EVERY credential the round was issued is checked (PC-N1): the set is bounded by what the round really held, not by a constant, so a credential past some count can never stay alive unseen. One that cannot be
    // replayed at all (an unknown kind, no value) is UNCONTROLLED, the same as one that was not alive before the revoke: it can never show "dead", so the proof is at best "unclear" (held for the token lifetime).
    const issued = input.sessions?.get(lease.profileId) ?? [];
    // A generous bound on the replays (two probes each, each with its own timeout): a credential past it is never replayed and counts as uncontrolled, so the proof still fails closed.
    const credentials = issued.filter((credential) => (credential?.kind === "cookie" || credential?.kind === "bearer") && typeof credential.value === "string" && credential.value.length > 0).slice(0, RUN_SCOPED_SESSION_PROBES_MAX);
    let uncontrolled = issued.length - credentials.length;
    if (control) {
      existenceControl = (await probe((signal) => port.accountExists({ account: scoped, revokeHandle: lease.revokeHandle, signal }), "unclear")) === "present";
      for (const credential of credentials) {
        const before = port.sessionState === undefined ? "unclear" : await probe((signal) => port.sessionState!({ account: scoped, credential, signal }), "unclear");
        if (before === "alive") controlled.push(credential); else uncontrolled += 1;
      }
    }

    const sessionsEnded = await retried((signal) => port.endSessions({ account: scoped, revokeHandle: lease.revokeHandle, signal }), input.signal);
    const revoked = await retried((signal) => port.revoke({ account: scoped, revokeHandle: lease.revokeHandle, signal }), input.signal);
    const accountGone = revoked && (await probe((signal) => port.accountExists({ account: scoped, revokeHandle: lease.revokeHandle, signal }), "unclear")) === "gone";

    let sessionProof: RevokedAccount["sessionProof"] = "not_possible";
    if (control && sessionsEnded && revoked && controlled.length > 0) {
      sessionProof = uncontrolled > 0 ? "unclear" : "dead";
      for (const credential of controlled) {
        const after = await probe((signal) => port.sessionState!({ account: scoped, credential, signal }), "unclear");
        if (after === "alive") { sessionProof = "alive"; break; }
        if (after !== "dead") sessionProof = "unclear";
      }
    } else if (control && sessionsEnded && revoked && issued.length > 0) {
      sessionProof = "unclear";
    }
    if (control && sessionsEnded && revoked && accountGone && (sessionProof === "not_possible" || sessionProof === "unclear" || !existenceControl)) needsHold = true;
    let recorded = input.store === undefined;
    if (sessionsEnded && revoked && accountGone && input.store !== undefined) recorded = await updateLease(input.store, lease.leaseId, { state: "revoked" }, input.onAlert);
    report.push({ profileId: lease.profileId, sessionsEnded, revoked, accountGone, existenceControl, sessionProof, recorded });
  }
  const revokedAt = (input.clock ?? (() => input.now))();
  const plan = needsHold ? holdFor({ statedTtlMs: input.maxTokenTtlMs, maxHoldMs: input.maxHoldMs }) : undefined;
  const refused = plan !== undefined && "refused" in plan;
  const result: RevocationReport = { confirmed: false, accounts: report,
    ...(plan === undefined || refused ? {} : { heldUntil: new Date(revokedAt + plan.ms).toISOString() }),
    ...(plan !== undefined && !refused && plan.assumed ? { ttlAssumed: true as const } : {}),
    ...(refused ? { holdRefused: plan.refused } : {}) };
  return { ...result, confirmed: control && revocationSettledAt(result, revokedAt) };
}

/** The pack's `environment.accounts` for a round: run-scoped for each lease, registered for the rest. */
export function evidenceAccountsOf(result: Extract<ProvisionResult, { ok: true }>): Array<{ profileId: string; kind: "run_scoped" | "registered" }> {
  return [...result.leases.map((lease) => ({ profileId: lease.profileId, kind: "run_scoped" as const })), ...result.registered.map((profileId) => ({ profileId, kind: "registered" as const }))];
}

// ---- the sweeper (leases)

export interface SweepResult {
  /** Leases that were past their expiry and are now revoked, proved gone and RECORDED as revoked. */
  swept: string[];
  /** Leases that are past their expiry and could not be cleared (or whose record could not be written): the caller raises an alarm for each. */
  stuck: string[];
  /** The store could not list its outstanding leases: nothing was swept, and this is NOT "nothing to do". Alarm on it. */
  listFailed?: true;
}

/**
 * Revokes the leases a crash or a timeout left behind: every outstanding lease past its `expiresAt` has its sessions ended, is revoked by the lease id, and must be proved gone AND recorded before it is called
 * swept. A lease whose round may still be running (not yet expired) is left alone. Never throws; a lease it cannot clear is `stuck`, for the caller's alarm, and is tried again by the next sweep.
 */
export async function sweepRunScopedLeases(input: { store: LeaseStore; ports: AccountProvisionerPorts; now: number; onAlert?: LeaseAlertHook; signal?: AbortSignal }): Promise<SweepResult> {
  const swept: string[] = [];
  const stuck: string[] = [];
  let outstanding: LeaseRecord[];
  try { outstanding = await input.store.listOutstanding(); } catch { return { swept, stuck, listFailed: true }; }
  for (const record of outstanding) {
    if (record.state === "revoked" || !(Date.parse(record.expiresAt) <= input.now)) continue;
    const port = input.ports[record.provisioner];
    if (port === undefined) { stuck.push(record.leaseId); continue; }
    const report = await revokeRunScopedAccounts({ leases: [leaseOf(record)], accounts: [record.account], ports: input.ports, store: input.store, now: input.now, control: false, ...(input.onAlert === undefined ? {} : { onAlert: input.onAlert }), ...(input.signal === undefined ? {} : { signal: input.signal }) });
    const item = report.accounts[0];
    if (item !== undefined && item.sessionsEnded && item.revoked && item.accountGone && item.recorded) swept.push(record.leaseId); else stuck.push(record.leaseId);
  }
  return { swept, stuck };
}

// ---- the three provisioner kinds, each over injected clients

/**
 * `seed_command`: the approved command creates a user in the sandbox's synthetic database and prints one JSON line `{loginRef, revokeHandle, secrets?}`. `revokeHandle` MUST be the `ROVARA_ACCOUNT_LEASE` it was given (an answer with another handle is refused). The account dies with the sandbox; revoking it removes
 * it and its sessions from the database now so the proof does not wait for teardown. `replaySession` replays a credential against the sandbox app's authenticated endpoint (the environment names it).
 */
export function seedCommandProvisioner(clients: {
  runSeed(input: { command: Extract<RunScopedAccount, { provisioner: "seed_command" }>["command"]; env: Readonly<Record<string, string>>; signal: AbortSignal }): Promise<{ exitCode: number; stdout: string }>;
  endSessions(input: { revokeHandle: string; signal: AbortSignal }): Promise<void>;
  removeAccount(input: { revokeHandle: string; signal: AbortSignal }): Promise<void>;
  accountExists(input: { revokeHandle: string; signal: AbortSignal }): Promise<AccountPresence>;
  replaySession?(input: { credential: SessionCredential; signal: AbortSignal }): Promise<SessionState>;
}): AccountProvisionerPort {
  return {
    async create({ account, leaseId, expiresAt, signal }) {
      if (account.provisioner !== "seed_command") throw new Error("wrong provisioner");
      const out = await clients.runSeed({ command: account.command, env: { ROVARA_ACCOUNT_PROFILE: account.profileId, ROVARA_ACCOUNT_LEASE: leaseId, ROVARA_ACCOUNT_EXPIRES_AT: expiresAt }, signal });
      if (out.exitCode !== 0 || out.stdout.length > 8_192) throw new Error("seed failed");
      const line = out.stdout.trim().split("\n").filter((item) => item.trim() !== "").at(-1) ?? "";
      return CreatedSchema.parse(JSON.parse(line));
    },
    async endSessions({ revokeHandle, signal }) { await clients.endSessions({ revokeHandle, signal }); },
    async revoke({ revokeHandle, signal }) { await clients.removeAccount({ revokeHandle, signal }); },
    async accountExists({ revokeHandle, signal }) { return clients.accountExists({ revokeHandle, signal }); },
    ...(clients.replaySession === undefined ? {} : { async sessionState({ credential, signal }: { credential: SessionCredential; signal: AbortSignal }) { return clients.replaySession!({ credential, signal }); } }),
  };
}

/**
 * `cognito_test_pool`: AdminCreateUser in a test-only user pool through the customer's role (the username IS the lease id), then AdminUserGlobalSignOut and AdminDeleteUser after the round; AdminGetUser
 * answering UserNotFound is the existence proof. A JWT already issued stays valid until `exp` (it is checked offline), so the session proof replays a real token against the environment's authenticated
 * endpoint, and without one publication is held for the token lifetime.
 */
export function cognitoTestPoolProvisioner(clients: {
  adminCreateUser(input: { userPoolId: string; region: string; roleArn: string; username: string; expiresAt: string; signal: AbortSignal }): Promise<{ password: string }>;
  adminUserGlobalSignOut(input: { userPoolId: string; region: string; roleArn: string; username: string; signal: AbortSignal }): Promise<void>;
  adminDeleteUser(input: { userPoolId: string; region: string; roleArn: string; username: string; signal: AbortSignal }): Promise<void>;
  adminGetUser(input: { userPoolId: string; region: string; roleArn: string; username: string; signal: AbortSignal }): Promise<"exists" | "not_found" | "unclear">;
  replaySession?(input: { credential: SessionCredential; signal: AbortSignal }): Promise<SessionState>;
}): AccountProvisionerPort {
  const find = (account: RunScopedAccount) => { if (account.provisioner !== "cognito_test_pool") throw new Error("wrong provisioner"); return account; };
  return {
    async create({ account, leaseId, expiresAt, signal }) {
      const pool = find(account);
      const { password } = await clients.adminCreateUser({ userPoolId: pool.userPoolId, region: pool.region, roleArn: pool.roleArn, username: leaseId, expiresAt, signal });
      return CreatedSchema.parse({ loginRef: leaseId, revokeHandle: leaseId, secrets: [password, leaseId] });
    },
    async endSessions({ account, revokeHandle, signal }) {
      const pool = find(account);
      await clients.adminUserGlobalSignOut({ userPoolId: pool.userPoolId, region: pool.region, roleArn: pool.roleArn, username: revokeHandle, signal });
    },
    async revoke({ account, revokeHandle, signal }) {
      const pool = find(account);
      await clients.adminDeleteUser({ userPoolId: pool.userPoolId, region: pool.region, roleArn: pool.roleArn, username: revokeHandle, signal });
    },
    async accountExists({ account, revokeHandle, signal }) {
      const pool = find(account);
      const answer = await clients.adminGetUser({ userPoolId: pool.userPoolId, region: pool.region, roleArn: pool.roleArn, username: revokeHandle, signal });
      return answer === "not_found" ? "gone" : answer === "exists" ? "present" : "unclear";
    },
    ...(clients.replaySession === undefined ? {} : { async sessionState({ credential, signal }: { account: RunScopedAccount; credential: SessionCredential; signal: AbortSignal }) { return clients.replaySession!({ credential, signal }); } }),
  };
}

/**
 * `http_hook`: the customer's own endpoints, called with a short-lived token read by NAME from the project's secrets (the token itself is only ever in the client's header). The hook's protocol:
 *   POST <createUrl> {profile, leaseId, expiresAt}      -> 2xx {loginRef, revokeHandle, secrets?}  (the hook uses `leaseId` as the account's handle: `revokeHandle` must equal it)
 *   POST <deleteUrl> {action: "end_sessions", revokeHandle} -> 2xx once every session of the account is ended
 *   DELETE <deleteUrl> {revokeHandle}                    -> 2xx, or 404 when it is already gone
 *   GET <createUrl>/<revokeHandle>                       -> 404 once the account is gone (the existence proof); 2xx while it exists
 */
export function httpHookProvisioner(clients: {
  readToken(name: string): Promise<string>;
  call(input: { method: "GET" | "POST" | "DELETE"; url: string; token: string; body: unknown; signal: AbortSignal }): Promise<{ status: number; json: unknown }>;
  replaySession?(input: { credential: SessionCredential; signal: AbortSignal }): Promise<SessionState>;
}): AccountProvisionerPort {
  const hook = (account: RunScopedAccount) => { if (account.provisioner !== "http_hook") throw new Error("wrong provisioner"); return account; };
  return {
    async create({ account, leaseId, expiresAt, signal }) {
      const config = hook(account);
      const token = await clients.readToken(config.tokenSecretName);
      const answer = await clients.call({ method: "POST", url: config.createUrl, token, body: { profile: account.profileId, leaseId, expiresAt }, signal });
      if (answer.status < 200 || answer.status > 299) throw new Error("hook refused");
      return CreatedSchema.parse(answer.json);
    },
    async endSessions({ account, revokeHandle, signal }) {
      const config = hook(account);
      const token = await clients.readToken(config.tokenSecretName);
      const answer = await clients.call({ method: "POST", url: config.deleteUrl, token, body: { action: "end_sessions", revokeHandle }, signal });
      // An account that is already gone has no sessions left.
      if ((answer.status < 200 || answer.status > 299) && answer.status !== 404) throw new Error("hook refused");
    },
    async revoke({ account, revokeHandle, signal }) {
      const config = hook(account);
      const token = await clients.readToken(config.tokenSecretName);
      const answer = await clients.call({ method: "DELETE", url: config.deleteUrl, token, body: { revokeHandle }, signal });
      if ((answer.status < 200 || answer.status > 299) && answer.status !== 404) throw new Error("hook refused");
    },
    async accountExists({ account, revokeHandle, signal }) {
      const config = hook(account);
      const token = await clients.readToken(config.tokenSecretName);
      const answer = await clients.call({ method: "GET", url: `${config.createUrl.replace(/\/+$/u, "")}/${encodeURIComponent(revokeHandle)}`, token, body: undefined, signal });
      return answer.status === 404 ? "gone" : answer.status >= 200 && answer.status < 300 ? "present" : "unclear";
    },
    ...(clients.replaySession === undefined ? {} : { async sessionState({ credential, signal }: { account: RunScopedAccount; credential: SessionCredential; signal: AbortSignal }) { return clients.replaySession!({ credential, signal }); } }),
  };
}

/**
 * The only error that means "no such user" for an existence probe: Cognito's `UserNotFoundException`. Any other failure (`ResourceNotFoundException` for the wrong pool, `AccessDeniedException`, a timeout) is
 * "unclear", never "not_found": a probe that cannot see the pool must not prove a deletion. The injected `adminGetUser` client maps its errors through this.
 */
export function cognitoPresenceOf(errorName: string | undefined): "exists" | "not_found" | "unclear" {
  if (errorName === undefined) return "exists";
  return errorName === "UserNotFoundException" ? "not_found" : "unclear";
}
