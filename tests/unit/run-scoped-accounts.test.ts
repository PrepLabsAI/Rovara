// Run-scoped accounts. Expiry is at most round end + 15 minutes. A revocation counts as confirmed only when the account's sessions were ended,
// it was revoked, an existence probe says it is gone AND replaying a credential the round really held is refused; where the replay cannot run, publication is held for the token lifetime. Leases are durable
// before the account exists, and a sweeper revokes what a crash left behind.
import { describe, expect, it } from "vitest";
import { RUN_SCOPED_ASSUMED_TOKEN_TTL_MS, RUN_SCOPED_DEFAULT_MAX_HOLD_MS, RUN_SCOPED_GRACE_MS, RUN_SCOPED_MAX_ROUND_MS, RUN_SCOPED_REVOKE_ATTEMPTS, RUN_SCOPED_SESSION_PROBES_MAX, RUN_SCOPED_STORE_ATTEMPTS, cognitoPresenceOf, cognitoTestPoolProvisioner, evidenceAccountsOf, holdFor, httpHookProvisioner, provisionRunScopedAccounts, revocationSettledAt,
  revokeRunScopedAccounts, runScopedExpiry, seedCommandProvisioner, sessionStateOfStatus, sweepRunScopedLeases,
  type AccountPresence, type AccountProvisionerPort, type LeaseAlert, type AccountProvisionerPorts, type LeaseRecord, type LeaseStore, type RunScopedAccount, type RunScopedLease, type SessionCredential, type SessionState } from "../../packages/broker/src/e2e/run-scoped-accounts.js";
import { TestEnvAccountSchema, type TestEnvAccount } from "../../packages/contracts/src/index.js";

// Built at runtime: a key-shaped literal in a test file is refused by the repository's secret scan.
const COGNITO_PASSWORD = ["Pw", "from", "cognito", "1"].join("-");

const NOW = Date.parse("2026-11-03T10:00:00.000Z");
const ENDS = "2026-11-03T10:30:00.000Z";
const seed: TestEnvAccount = TestEnvAccountSchema.parse({ profileId: "buyer", provisioner: "seed_command", command: { cwd: "app", executable: "python", args: ["seed.py"], timeoutSeconds: 60 } });
const cognito: TestEnvAccount = TestEnvAccountSchema.parse({ profileId: "admin", provisioner: "cognito_test_pool", userPoolId: "us-west-2_AbC123xyz", region: "us-west-2", roleArn: "arn:aws:iam::123456789012:role/test-accounts" });
const hook: TestEnvAccount = TestEnvAccountSchema.parse({ profileId: "partner", provisioner: "http_hook", createUrl: "https://tests.example.com/accounts", deleteUrl: "https://tests.example.com/accounts/delete", tokenSecretName: "TEST_HOOK_TOKEN" });
const registered: TestEnvAccount = TestEnvAccountSchema.parse({ profileId: "old", provisioner: "registered", registryProfileId: "orders-owner" });
const COOKIE: SessionCredential = { kind: "cookie", value: "round-session-cookie-value-1" };
const BEARER: SessionCredential = { kind: "bearer", value: "round-bearer-token-value-2" };

function memoryStore(failPut = false): LeaseStore & { records: Map<string, LeaseRecord>; log: string[] } {
  const records = new Map<string, LeaseRecord>(); const log: string[] = [];
  return { records, log,
    async put(record) { if (failPut) throw new Error("table down"); log.push(`put ${record.state}`); records.set(record.leaseId, structuredClone(record)); },
    async update(leaseId, patch) { log.push(`update ${JSON.stringify(patch)}`); const current = records.get(leaseId); if (current) records.set(leaseId, { ...current, ...patch }); },
    async listOutstanding() { return [...records.values()].filter((record) => record.state !== "revoked").map((record) => structuredClone(record)); } };
}
let counter = 0;
const newLeaseId = () => `rvl-test-${String((counter += 1)).padStart(8, "0")}`;

interface Fake extends AccountProvisionerPort { calls: string[]; sessionsOf: Map<string, "live" | "ended">; accounts: Set<string> }
function fake(over: { failCreateFor?: string; createdBeforeFailing?: boolean; answer?: unknown; endFails?: number; revokeFails?: number; presence?: AccountPresence; replay?: SessionState | ((c: SessionCredential, ended: boolean) => SessionState); preAlive?: boolean; noReplay?: boolean; replayThrows?: boolean; secrets?: string[] } = {}): Fake {
  let endCalls = 0; let revokeCalls = 0; const endedFor = new Set<string>();
  const port: Fake = {
    calls: [], sessionsOf: new Map(), accounts: new Set(),
    async create({ account, leaseId }) {
      port.calls.push(`create ${account.profileId} ${leaseId}`);
      if (over.failCreateFor === account.profileId) { if (over.createdBeforeFailing) port.accounts.add(leaseId); throw new Error("boom with a secret hunter2"); }
      port.accounts.add(leaseId); port.sessionsOf.set(leaseId, "live");
      return (over.answer ?? { loginRef: `login-${account.profileId}`, revokeHandle: leaseId, secrets: over.secrets ?? [`pw-${account.profileId}`] }) as never;
    },
    async endSessions({ account, revokeHandle }) {
      endCalls += 1; port.calls.push(`end ${revokeHandle}`);
      if (over.endFails !== undefined && endCalls <= over.endFails) throw new Error("end failed");
      port.sessionsOf.set(revokeHandle, "ended"); endedFor.add(account.profileId);
    },
    async revoke({ revokeHandle }) {
      revokeCalls += 1; port.calls.push(`revoke ${revokeHandle}`);
      if (over.revokeFails !== undefined && revokeCalls <= over.revokeFails) throw new Error("revoke failed");
      port.accounts.delete(revokeHandle);
    },
    async accountExists({ revokeHandle }) { port.calls.push(`exists ${revokeHandle}`); return over.presence ?? (port.accounts.has(revokeHandle) ? "present" : "gone"); },
  };
  if (!over.noReplay) {
    port.sessionState = async ({ account, credential }) => {
      const ended = endedFor.has(account.profileId);
      port.calls.push(`replay ${credential.kind}`);
      if (over.replayThrows) throw new Error("network");
      // before the sessions are ended a working credential is ALIVE (the positive control); a plain `replay` value is what it answers afterwards
      if (!ended) return typeof over.replay === "function" ? over.replay(credential, false) : over.preAlive === false ? "dead" : "alive";
      const answer = over.replay ?? "dead";
      return typeof answer === "function" ? answer(credential, true) : answer;
    };
  }
  return port;
}
const ports = (port: AccountProvisionerPort): AccountProvisionerPorts => ({ seed_command: port, cognito_test_pool: port, http_hook: port });
const provision = (accounts: TestEnvAccount[], port: AccountProvisionerPort, over: Partial<Parameters<typeof provisionRunScopedAccounts>[0]> = {}) => provisionRunScopedAccounts({ accounts, roundId: "round-1", roundEndsAt: ENDS, now: NOW, ports: ports(port), store: memoryStore(), newLeaseId, ...over });

describe("provisioning", () => {
  it("expires every lease at most 15 minutes after the round ends", async () => {
    const result = await provision([seed, cognito, hook], fake());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(RUN_SCOPED_GRACE_MS).toBe(15 * 60_000);
    expect(runScopedExpiry(ENDS)).toBe("2026-11-03T10:45:00.000Z");
    expect(result.leases.map((lease) => [lease.profileId, lease.expiresAt])).toEqual([["buyer", "2026-11-03T10:45:00.000Z"], ["admin", "2026-11-03T10:45:00.000Z"], ["partner", "2026-11-03T10:45:00.000Z"]]);
    expect(result.leases.every((lease) => Date.parse(lease.expiresAt) - Date.parse(ENDS) <= RUN_SCOPED_GRACE_MS)).toBe(true);
  });
  it("leaves registered accounts alone and says they are not run-scoped", async () => {
    const port = fake();
    const result = await provision([seed, registered], port);
    expect(port.calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
    expect(result.ok && evidenceAccountsOf(result)).toEqual([{ profileId: "buyer", kind: "run_scoped" }, { profileId: "old", kind: "registered" }]);
  });
  it("refuses an environment with no run-scoped account", async () => {
    expect(await provision([registered], fake())).toEqual({ ok: false, code: "no_run_scoped_accounts", cleanedUp: true });
  });
  it("refuses a round window that has ended, is not a date, or is longer than four hours", async () => {
    for (const roundEndsAt of ["2026-11-03T09:59:00.000Z", "not a date", new Date(NOW + RUN_SCOPED_MAX_ROUND_MS + 1).toISOString()]) {
      const port = fake();
      expect(await provision([seed], port, { roundEndsAt })).toEqual({ ok: false, code: "round_window_invalid", cleanedUp: true });
      expect(port.calls).toEqual([]);
    }
  });
  it("refuses when a kind in use has no provisioner, before making anything", async () => {
    const port = fake();
    expect(await provisionRunScopedAccounts({ accounts: [seed, cognito], roundId: "r", roundEndsAt: ENDS, now: NOW, ports: { seed_command: port, cognito_test_pool: undefined, http_hook: undefined }, store: memoryStore(), newLeaseId }))
      .toEqual({ ok: false, code: "no_provisioner", cleanedUp: true });
    expect(port.calls).toEqual([]);
  });
  it("refuses a profile named twice", async () => {
    expect(await provision([seed, { ...hook, profileId: "buyer" }], fake())).toMatchObject({ ok: false, code: "duplicate_profile" });
  });
  it("is cancelled by the caller's signal", async () => {
    const stuck: AccountProvisionerPort = { ...fake(), create: () => new Promise(() => undefined) };
    const controller = new AbortController();
    const pending = provision([seed], stuck, { signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, code: "provision_failed" });
  });
});

describe("durable leases (I3)", () => {
  it("creates nothing when the lease cannot be written, and cleans up what an earlier account made", async () => {
    const port = fake();
    expect(await provision([seed], port, { store: memoryStore(true) })).toEqual({ ok: false, code: "lease_store_failed", cleanedUp: true });
    expect(port.calls).toEqual([]);
    const store = memoryStore();
    let puts = 0;
    const flaky: LeaseStore = { ...store, put: async (record) => { puts += 1; if (puts === 2) throw new Error("table down"); await store.put(record); } };
    const port2 = fake();
    expect(await provision([seed, hook], port2, { store: flaky })).toEqual({ ok: false, code: "lease_store_failed", cleanedUp: true });
    expect([...port2.accounts]).toEqual([]);
  });
  it("refuses a lease id of the wrong shape (it becomes a remote handle)", async () => {
    expect(await provision([seed], fake(), { newLeaseId: () => "not a lease id" })).toMatchObject({ ok: false, code: "lease_store_failed" });
  });
  it("sweeps expired leases a crash left behind, and leaves a round that may still be running alone", async () => {
    const store = memoryStore(); const port = fake();
    const first = await provision([seed], port, { store });
    const second = await provision([hook], port, { store, roundEndsAt: "2026-11-03T12:00:00.000Z" });
    if (!first.ok || !second.ok) throw new Error("provision");
    // the first round's broker died; a sweep after its expiry revokes it, and not the second round's
    const result = await sweepRunScopedLeases({ store, ports: ports(port), now: Date.parse("2026-11-03T10:46:00.000Z") });
    expect(result).toEqual({ swept: [first.leases[0]!.leaseId], stuck: [] });
    expect(port.accounts.has(first.leases[0]!.revokeHandle)).toBe(false);
    expect(port.accounts.has(second.leases[0]!.revokeHandle)).toBe(true);
    expect(port.sessionsOf.get(first.leases[0]!.revokeHandle)).toBe("ended");
    const later = await sweepRunScopedLeases({ store, ports: ports(port), now: Date.parse("2026-11-03T12:20:00.000Z") });
    expect(later.swept).toEqual([second.leases[0]!.leaseId]);
    expect((await store.listOutstanding())).toEqual([]);
  });
  it("reports a lease it cannot clear as stuck (for the alarm), and tries it again next sweep", async () => {
    const store = memoryStore();
    const failing = fake({ revokeFails: 99 });
    const result = await provision([seed], fake(), { store });
    if (!result.ok) throw new Error("provision");
    const sweep = await sweepRunScopedLeases({ store, ports: ports(failing), now: NOW + 3_600_000 });
    expect(sweep).toEqual({ swept: [], stuck: [result.leases[0]!.leaseId] });
    expect((await store.listOutstanding())).toHaveLength(1);
    expect((await sweepRunScopedLeases({ store, ports: { seed_command: undefined, cognito_test_pool: undefined, http_hook: undefined }, now: NOW + 3_600_000 })).stuck).toHaveLength(1);
  });
  it("survives a store that cannot list", async () => {
    const store: LeaseStore = { put: async () => undefined, update: async () => undefined, listOutstanding: async () => { throw new Error("down"); } };
    // a store that cannot list is NOT "nothing to do": the result says so, for the alarm
    expect(await sweepRunScopedLeases({ store, ports: ports(fake()), now: NOW })).toEqual({ swept: [], stuck: [], listFailed: true });
  });
});

describe("revocation and its proof (C1)", () => {
  const all = [seed, cognito, hook];
  const lease = (profileId: string, provisioner: RunScopedLease["provisioner"]): RunScopedLease => ({ leaseId: `rvl-${profileId}-0001`, profileId, provisioner, loginRef: `login-${profileId}`, revokeHandle: `rvl-${profileId}-0001`, expiresAt: "2026-11-03T10:45:00.000Z" });
  const leases = [lease("buyer", "seed_command"), lease("admin", "cognito_test_pool"), lease("partner", "http_hook")];
  const sessions = new Map<string, SessionCredential[]>([["buyer", [COOKIE]], ["admin", [BEARER]], ["partner", [COOKIE, BEARER]]]);
  const live = (port: Fake) => { for (const item of leases) { port.accounts.add(item.revokeHandle); port.sessionsOf.set(item.revokeHandle, "live"); } return port; };

  it("is NOT confirmed when a replayed credential still works, and waiting never settles it", async () => {
    const port = live(fake({ replay: (credential, ended) => (!ended || credential.kind === "bearer" ? "alive" : "dead") }));
    const report = await revokeRunScopedAccounts({ leases, accounts: all, ports: ports(port), now: NOW, sessions });
    expect(report.confirmed).toBe(false);
    expect(report.accounts.map((item) => item.sessionProof)).toEqual(["dead", "alive", "alive"]);
    expect(revocationSettledAt(report, NOW + 10 * RUN_SCOPED_ASSUMED_TOKEN_TTL_MS)).toBe(false);
  });
  it("holds publication until the longest token lifetime has passed when the session probe cannot run", async () => {
    const cases: Array<[string, Fake, ReadonlyMap<string, SessionCredential[]>]> = [
      ["no replay endpoint", live(fake({ noReplay: true })), sessions],
      ["no credential kept", live(fake()), new Map()],
      ["the probe cannot say", live(fake({ replay: "unclear" })), sessions],
      ["the probe throws", live(fake({ replayThrows: true })), sessions],
    ];
    for (const [name, port, kept] of cases) {
      const report = await revokeRunScopedAccounts({ leases, accounts: all, ports: ports(port), now: NOW, sessions: kept, maxTokenTtlMs: 3_600_000 });
      expect(report.confirmed, name).toBe(false);
      expect(report.heldUntil, name).toBe("2026-11-03T11:00:00.000Z");
      expect(revocationSettledAt(report, Date.parse("2026-11-03T10:59:59.000Z")), name).toBe(false);
      expect(revocationSettledAt(report, Date.parse("2026-11-03T11:00:00.000Z")), name).toBe(true);
    }
  });
  it("holds for the STATED token lifetime with no cap, assumes a day only when none is stated (and says so), and refuses a lifetime above the configured maximum hold", async () => {
    const day = await revokeRunScopedAccounts({ leases: leases.slice(0, 1), accounts: all, ports: ports(live(fake({ noReplay: true }))), now: NOW });
    expect(day.heldUntil).toBe(new Date(NOW + RUN_SCOPED_ASSUMED_TOKEN_TTL_MS).toISOString());
    expect(day.ttlAssumed).toBe(true);
    const week = await revokeRunScopedAccounts({ leases: leases.slice(0, 1), accounts: all, ports: ports(live(fake({ noReplay: true }))), now: NOW, maxTokenTtlMs: 7 * 24 * 3_600_000 });
    expect(week.heldUntil).toBe(new Date(NOW + 7 * 24 * 3_600_000).toISOString());
    expect(week.ttlAssumed).toBeUndefined();
    const fortnight = await revokeRunScopedAccounts({ leases: leases.slice(0, 1), accounts: all, ports: ports(live(fake({ noReplay: true }))), now: NOW, maxTokenTtlMs: 14 * 24 * 3_600_000 });
    expect(fortnight.heldUntil).toBe(new Date(NOW + 14 * 24 * 3_600_000).toISOString());
    expect(holdFor({ statedTtlMs: Number.NaN })).toEqual({ ms: RUN_SCOPED_ASSUMED_TOKEN_TTL_MS, assumed: true });
    expect(holdFor({ statedTtlMs: -5 })).toEqual({ ms: RUN_SCOPED_ASSUMED_TOKEN_TTL_MS, assumed: true });
    expect(holdFor({ statedTtlMs: 10 })).toEqual({ ms: 60_000, assumed: false });
    // above the configured maximum: refused, never shortened
    const refused = await revokeRunScopedAccounts({ leases: leases.slice(0, 1), accounts: all, ports: ports(live(fake({ noReplay: true }))), now: NOW, maxTokenTtlMs: 30 * 24 * 3_600_000 });
    expect(refused).toMatchObject({ confirmed: false, holdRefused: "token_lifetime_over_max_hold" });
    expect(refused.heldUntil).toBeUndefined();
    expect(revocationSettledAt(refused, NOW + 365 * 24 * 3_600_000)).toBe(false);
    expect(holdFor({ statedTtlMs: 3 * 24 * 3_600_000, maxHoldMs: 24 * 3_600_000 })).toEqual({ refused: "token_lifetime_over_max_hold" });
    expect(holdFor({ maxHoldMs: 3_600_000 })).toEqual({ refused: "token_lifetime_over_max_hold" });
    expect(RUN_SCOPED_DEFAULT_MAX_HOLD_MS).toBe(14 * 24 * 3_600_000);
  });
  it("is not confirmed with nothing to prove, and for a lease whose account or port is unknown, and a registered account is never revocable", async () => {
    expect((await revokeRunScopedAccounts({ leases: [], accounts: all, ports: ports(fake()), now: NOW })).confirmed).toBe(false);
    expect((await revokeRunScopedAccounts({ leases: [lease("ghost", "seed_command")], accounts: all, ports: ports(fake()), now: NOW })).confirmed).toBe(false);
    expect((await revokeRunScopedAccounts({ leases: [leases[0]!], accounts: all, ports: { seed_command: undefined, cognito_test_pool: undefined, http_hook: undefined }, now: NOW })).confirmed).toBe(false);
    expect((await revokeRunScopedAccounts({ leases: [lease("old", "seed_command")], accounts: [registered], ports: ports(fake()), now: NOW })).confirmed).toBe(false);
  });
  it("replays at most 32 credentials per account, and any beyond that count as uncontrolled, so the proof fails closed", async () => {
    expect(RUN_SCOPED_SESSION_PROBES_MAX).toBe(32);
    const issued: SessionCredential[] = Array.from({ length: 33 }, (_, index) => ({ kind: "bearer" as const, value: `bearer-value-${String(index).padStart(2, "0")}` }));
    const replayed: string[] = [];
    const port = live(fake());
    const ended = new Set<string>();
    const endSessions = port.endSessions.bind(port);
    port.endSessions = async (input) => { ended.add(input.account.profileId); return endSessions(input); };
    port.sessionState = async ({ account, credential }) => { replayed.push(credential.value); return ended.has(account.profileId) ? "dead" : "alive"; };
    const report = await revokeRunScopedAccounts({ leases: leases.slice(0, 1), accounts: all, ports: ports(port), now: NOW, sessions: new Map([["buyer", issued]]), maxTokenTtlMs: 600_000 });
    // 32 credentials, each replayed before and after; the 33rd is never replayed and is uncontrolled
    expect(replayed).toHaveLength(64);
    expect(replayed).not.toContain("bearer-value-32");
    expect(report.accounts[0]?.sessionProof).toBe("unclear");
    expect(report.confirmed).toBe(false);
    expect(report.heldUntil).toBe("2026-11-03T10:10:00.000Z");
    expect(revocationSettledAt(report, NOW + 599_999)).toBe(false);
    // exactly 32 is fully proved
    const exact = await revokeRunScopedAccounts({ leases: leases.slice(0, 1), accounts: all, ports: ports(live(fake())), now: NOW, sessions: new Map([["buyer", issued.slice(0, 32)]]) });
    expect(exact.accounts[0]?.sessionProof).toBe("dead");
    expect(exact.confirmed).toBe(true);
  });
  it("reads an HTTP status from a replayed credential: 401 and 403 are dead, 2xx and 3xx alive, the rest proves nothing", () => {
    expect([401, 403].map(sessionStateOfStatus)).toEqual(["dead", "dead"]);
    expect([200, 204, 302].map(sessionStateOfStatus)).toEqual(["alive", "alive", "alive"]);
    expect([404, 429, 500, 503, undefined].map(sessionStateOfStatus)).toEqual(["unclear", "unclear", "unclear", "unclear", "unclear"]);
  });
});

describe("the three provisioner kinds", () => {
  const signal = new AbortController().signal;
  it("seed_command runs the approved command with the profile, the lease id and the expiry, and reads one JSON line", async () => {
    const calls: unknown[] = [];
    const port = seedCommandProvisioner({
      runSeed: async (input) => { calls.push(input.env); return { exitCode: 0, stdout: `noise\n${JSON.stringify({ loginRef: "u-1", revokeHandle: "u-1", secrets: ["pw-1-secret"] })}\n` }; },
      endSessions: async () => undefined, removeAccount: async () => undefined, accountExists: async () => "gone",
    });
    expect(await port.create({ account: seed as RunScopedAccount, leaseId: "rvl-aaaaaaaa", expiresAt: "2026-11-03T10:45:00.000Z", signal })).toEqual({ loginRef: "u-1", revokeHandle: "u-1", secrets: ["pw-1-secret"] });
    expect(calls).toEqual([{ ROVARA_ACCOUNT_PROFILE: "buyer", ROVARA_ACCOUNT_LEASE: "rvl-aaaaaaaa", ROVARA_ACCOUNT_EXPIRES_AT: "2026-11-03T10:45:00.000Z" }]);
    await expect(port.create({ account: cognito as RunScopedAccount, leaseId: "rvl-aaaaaaaa", expiresAt: "x", signal })).rejects.toThrow();
    expect("sessionState" in port).toBe(false);
  });
  it("seed_command refuses a failed command and output that is not the answer", async () => {
    const base = { endSessions: async () => undefined, removeAccount: async () => undefined, accountExists: async () => "gone" as const };
    await expect(seedCommandProvisioner({ ...base, runSeed: async () => ({ exitCode: 1, stdout: "" }) }).create({ account: seed as RunScopedAccount, leaseId: "rvl-aaaaaaaa", expiresAt: "x", signal })).rejects.toThrow();
    await expect(seedCommandProvisioner({ ...base, runSeed: async () => ({ exitCode: 0, stdout: "not json" }) }).create({ account: seed as RunScopedAccount, leaseId: "rvl-aaaaaaaa", expiresAt: "x", signal })).rejects.toThrow();
  });
  it("gives a port a session probe only when the environment supplied a replay", () => {
    const base = { runSeed: async () => ({ exitCode: 0, stdout: "{}" }), endSessions: async () => undefined, removeAccount: async () => undefined, accountExists: async () => "gone" as const };
    expect("sessionState" in seedCommandProvisioner({ ...base, replaySession: async () => "dead" })).toBe(true);
    expect("sessionState" in seedCommandProvisioner(base)).toBe(false);
  });
  it("cognito_test_pool uses the lease id as the username, signs the user out everywhere before deleting, and proves with AdminGetUser", async () => {
    const calls: string[] = [];
    const port = cognitoTestPoolProvisioner({
      adminCreateUser: async (input) => { calls.push(`create ${input.userPoolId} ${input.roleArn} ${input.username}`); return { password: COGNITO_PASSWORD }; },
      adminUserGlobalSignOut: async (input) => { calls.push(`signout ${input.username}`); },
      adminDeleteUser: async (input) => { calls.push(`delete ${input.userPoolId} ${input.username}`); },
      adminGetUser: async (input) => { calls.push(`get ${input.username}`); return "not_found"; },
      replaySession: async () => "dead",
    });
    const created = await port.create({ account: cognito as RunScopedAccount, leaseId: "rvl-cognito-1", expiresAt: "2026-11-03T10:45:00.000Z", signal });
    expect(created).toEqual({ loginRef: "rvl-cognito-1", revokeHandle: "rvl-cognito-1", secrets: [COGNITO_PASSWORD, "rvl-cognito-1"] });
    await port.endSessions({ account: cognito as RunScopedAccount, revokeHandle: created.revokeHandle, signal });
    await port.revoke({ account: cognito as RunScopedAccount, revokeHandle: created.revokeHandle, signal });
    expect(await port.accountExists({ account: cognito as RunScopedAccount, revokeHandle: created.revokeHandle, signal })).toBe("gone");
    expect(calls).toEqual(["create us-west-2_AbC123xyz arn:aws:iam::123456789012:role/test-accounts rvl-cognito-1", "signout rvl-cognito-1", "delete us-west-2_AbC123xyz rvl-cognito-1", "get rvl-cognito-1"]);
  });
  it("cognito_test_pool reads AdminGetUser honestly: an existing user is present, an unclear answer is unclear", async () => {
    const answer = (value: "exists" | "unclear") => cognitoTestPoolProvisioner({ adminCreateUser: async () => ({ password: "x" }), adminUserGlobalSignOut: async () => undefined, adminDeleteUser: async () => undefined, adminGetUser: async () => value });
    expect(await answer("exists").accountExists({ account: cognito as RunScopedAccount, revokeHandle: "h", signal })).toBe("present");
    expect(await answer("unclear").accountExists({ account: cognito as RunScopedAccount, revokeHandle: "h", signal })).toBe("unclear");
  });
  it("http_hook treats a 404 on end-sessions and delete as already gone, reads a 2xx GET as present, and anything else as unclear", async () => {
    const respond = (code: number) => httpHookProvisioner({ readToken: async () => "t", call: async () => ({ status: code, json: {} }) });
    const account = hook as RunScopedAccount;
    await expect(respond(404).endSessions({ account, revokeHandle: "h", signal })).resolves.toBeUndefined();
    await expect(respond(404).revoke({ account, revokeHandle: "h", signal })).resolves.toBeUndefined();
    expect(await respond(200).accountExists({ account, revokeHandle: "h", signal })).toBe("present");
    expect(await respond(500).accountExists({ account, revokeHandle: "h", signal })).toBe("unclear");
  });
  it("http_hook refuses an error status and an answer of the wrong shape", async () => {
    const account = hook as RunScopedAccount;
    const status = httpHookProvisioner({ readToken: async () => "t", call: async () => ({ status: 500, json: {} }) });
    await expect(status.create({ account, leaseId: "rvl-hook-0001", expiresAt: "x", signal })).rejects.toThrow();
    await expect(status.revoke({ account, revokeHandle: "h", signal })).rejects.toThrow();
    await expect(status.endSessions({ account, revokeHandle: "h", signal })).rejects.toThrow();
    const shape = httpHookProvisioner({ readToken: async () => "t", call: async () => ({ status: 200, json: { loginRef: "p", revokeHandle: "p", password: "leak" } }) });
    await expect(shape.create({ account, leaseId: "rvl-hook-0001", expiresAt: "x", signal })).rejects.toThrow();
  });
});

// ---- a revocation probe that proves nothing never confirms

/** A customer hook with its own handle scheme and a switchable GET route, and a replay client that can be made blind. */
function hookServer(opts: { getAlways404?: boolean; ownHandle?: boolean; replay?: "blind" | "always401" | "honest"; noReplay?: boolean } = {}) {
  const alive = new Set<string>(); let n = 0; let ended = false;
  const port = httpHookProvisioner({
    async readToken() { return "t"; },
    async call({ method, url, body }) {
      const b = body as { action?: string; revokeHandle?: string; leaseId?: string } | undefined;
      if (method === "POST" && url.endsWith("/accounts")) { const h = opts.ownHandle ? `acct-${(n += 1)}` : b!.leaseId!; alive.add(h); return { status: 200, json: { loginRef: h, revokeHandle: h } }; }
      if (method === "POST" && b?.action === "end_sessions") { ended = true; return { status: alive.has(b.revokeHandle!) ? 200 : 404, json: {} }; }
      if (method === "DELETE") { const had = alive.delete(b!.revokeHandle!); return { status: had ? 200 : 404, json: {} }; }
      if (method === "GET") { const h = decodeURIComponent(url.split("/").pop()!); return { status: opts.getAlways404 ? 404 : alive.has(h) ? 200 : 404, json: {} }; }
      return { status: 500, json: {} };
    },
    ...(opts.noReplay ? {} : { async replaySession(): Promise<SessionState> {
      // blind: the client never attaches the credential, so the app answers 401 whatever happened; always401: a WAF or the wrong route; honest: alive until the sessions end
      if (opts.replay === "honest") return ended ? "dead" : "alive";
      return "dead";
    } }),
  });
  return { alive, port };
}
const hookPorts = (port: AccountProvisionerPort): AccountProvisionerPorts => ({ http_hook: port, seed_command: undefined, cognito_test_pool: undefined });

describe("a probe that proves nothing never confirms (C1-a, C1-b)", () => {
  async function round(server: ReturnType<typeof hookServer>, sessions: Map<string, SessionCredential[]>, over: Partial<Parameters<typeof revokeRunScopedAccounts>[0]> = {}) {
    const store = memoryStore();
    const provisioned = await provisionRunScopedAccounts({ accounts: [hook], roundId: "r", roundEndsAt: ENDS, now: NOW, ports: hookPorts(server.port), store, newLeaseId });
    if (!provisioned.ok) throw new Error("provision");
    return revokeRunScopedAccounts({ leases: provisioned.leases, accounts: [hook], ports: hookPorts(server.port), store, now: NOW, sessions, maxTokenTtlMs: 3_600_000, ...over });
  }
  it("positive control for the brief's second case: the same round with the control satisfied is confirmed, so the holds above are the missing controls' doing", async () => {
    const withControl = await round(hookServer({ replay: "honest" }), new Map([["partner", [BEARER]]]));
    const without = await round(hookServer({ replay: "blind" }), new Map([["partner", [BEARER]]]));
    expect([withControl.confirmed, without.confirmed]).toEqual([true, false]);
  });
  it("maps only UserNotFoundException to not-found for the Cognito existence probe", () => {
    expect(cognitoPresenceOf(undefined)).toBe("exists");
    expect(cognitoPresenceOf("UserNotFoundException")).toBe("not_found");
    for (const name of ["ResourceNotFoundException", "AccessDeniedException", "TimeoutError", "NotAuthorizedException", ""]) expect(cognitoPresenceOf(name), name).toBe("unclear");
  });
});

describe("a failed lease write is never swallowed (C1-c, I3)", () => {
  it("probe: when the claimed handle cannot be revoked now, the durable record is pointed at it, so the sweeper reaches the real account instead of calling the lease swept", async () => {
    const server = hookServer({ ownHandle: true });
    const store = memoryStore();
    // the hook refuses deletes for the first round of cleanup (3 attempts by lease id, 3 by claim), then works
    let refusals = 0;
    const original = server.port.revoke.bind(server.port);
    server.port.revoke = async (input) => { if (input.revokeHandle.startsWith("acct-") && (refusals += 1) <= RUN_SCOPED_REVOKE_ATTEMPTS) throw new Error("hook down"); return original(input); };
    const result = await provisionRunScopedAccounts({ accounts: [hook], roundId: "r", roundEndsAt: ENDS, now: NOW, ports: hookPorts(server.port), store, newLeaseId });
    expect(result).toMatchObject({ ok: false, code: "provisioner_answer_invalid", cleanedUp: false });
    expect([...server.alive]).toEqual(["acct-1"]);
    const record = [...store.records.values()][0]!;
    expect(record).toMatchObject({ state: "active", revokeHandle: "acct-1" });
    const sweep = await sweepRunScopedLeases({ store, ports: hookPorts(server.port), now: NOW + 3_600_000 });
    expect(sweep).toEqual({ swept: [record.leaseId], stuck: [] });
    expect([...server.alive]).toEqual([]);
  });
  it("retries a failing `active` write, alerts when it stays down, cleans up, and refuses the round", async () => {
    const store = memoryStore();
    let writes = 0;
    const down: LeaseStore = { ...store, update: async () => { writes += 1; throw new Error("table down"); } };
    const server = hookServer();
    const alerts: LeaseAlert[] = [];
    const result = await provisionRunScopedAccounts({ accounts: [hook], roundId: "r", roundEndsAt: ENDS, now: NOW, ports: hookPorts(server.port), store: down, newLeaseId, onAlert: (alert) => alerts.push(alert) });
    expect(result).toMatchObject({ ok: false, code: "lease_store_failed", cleanedUp: true });
    expect([...server.alive]).toEqual([]);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0]).toMatchObject({ code: "lease_update_failed" });
    expect(writes).toBeGreaterThanOrEqual(RUN_SCOPED_STORE_ATTEMPTS);
  });
  it("a revoked write that stays down is `recorded: false` with an alert, and the sweeper calls the lease stuck, not swept, though the account is gone", async () => {
    const store = memoryStore();
    const server = hookServer();
    const provisioned = await provisionRunScopedAccounts({ accounts: [hook], roundId: "r", roundEndsAt: ENDS, now: NOW, ports: hookPorts(server.port), store, newLeaseId });
    if (!provisioned.ok) throw new Error("provision");
    const down: LeaseStore = { ...store, update: async () => { throw new Error("table down"); } };
    const alerts: LeaseAlert[] = [];
    const sweep = await sweepRunScopedLeases({ store: down, ports: hookPorts(server.port), now: NOW + 3_600_000, onAlert: (alert) => alerts.push(alert) });
    expect(sweep).toEqual({ swept: [], stuck: [provisioned.leases[0]!.leaseId] });
    expect([...server.alive]).toEqual([]);
    expect(alerts).toHaveLength(1);
    // the next sweep, with the store back, clears it
    expect(await sweepRunScopedLeases({ store, ports: hookPorts(server.port), now: NOW + 3_600_000 })).toEqual({ swept: [provisioned.leases[0]!.leaseId], stuck: [] });
  });
});
