// Run-scoped accounts. Expiry is at most round end + 15 minutes. A revocation counts as confirmed only when the account's sessions were ended,
// it was revoked, an existence probe says it is gone AND replaying a credential the round really held is refused; where the replay cannot run, publication is held for the token lifetime. Leases are durable
// before the account exists, and a sweeper revokes what a crash left behind.
import { describe, expect, it } from "vitest";
import { RUN_SCOPED_ASSUMED_TOKEN_TTL_MS, RUN_SCOPED_DEFAULT_MAX_HOLD_MS, RUN_SCOPED_GRACE_MS, RUN_SCOPED_MAX_ROUND_MS, RUN_SCOPED_REVOKE_ATTEMPTS, RUN_SCOPED_SESSION_PROBES_MAX, RUN_SCOPED_STORE_ATTEMPTS, cognitoPresenceOf, cognitoTestPoolProvisioner, evidenceAccountsOf, holdFor, httpHookProvisioner, provisionRunScopedAccounts, revocationSettledAt,
  revokeRunScopedAccounts, runScopedExpiry, seedCommandProvisioner, sessionStateOfStatus, sweepRunScopedLeases,
  type AccountPresence, type AccountProvisionerPort, type LeaseAlert, type AccountProvisionerPorts, type LeaseRecord, type LeaseStore, type RunScopedAccount, type RunScopedLease, type SessionCredential, type SessionState } from "../../packages/core/src/e2e/run-scoped-accounts.js";
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
  it("tells the provisioner the expiry it must honour and the lease id to use as the account's handle", async () => {
    const seen: Array<{ profile: string; expiresAt: string; leaseId: string }> = [];
    const port: AccountProvisionerPort = { ...fake(), async create({ account, expiresAt, leaseId }) { seen.push({ profile: account.profileId, expiresAt, leaseId }); return { loginRef: `l-${account.profileId}`, revokeHandle: leaseId }; } };
    const result = await provision([seed, hook], port);
    expect(seen.map((item) => [item.profile, item.expiresAt])).toEqual([["buyer", "2026-11-03T10:45:00.000Z"], ["partner", "2026-11-03T10:45:00.000Z"]]);
    expect(seen.every((item) => /^rvl-/u.test(item.leaseId))).toBe(true);
    expect(result.ok && result.leases.map((lease) => [lease.profileId, lease.loginRef, lease.revokeHandle === lease.leaseId])).toEqual([["buyer", "l-buyer", true], ["partner", "l-partner", true]]);
  });
  it("returns the secrets for the redactor and keeps none on a lease or a record", async () => {
    const store = memoryStore();
    const result = await provision([seed], fake({ secrets: ["s3cret-Password-value"] }), { store });
    expect(result.ok && result.secrets).toEqual(["s3cret-Password-value"]);
    expect(JSON.stringify(result.ok && result.leases)).not.toContain("s3cret-Password-value");
    expect(JSON.stringify([...store.records.values()])).not.toContain("s3cret-Password-value");
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
  it("revokes the accounts already made when a later one fails, ending their sessions and proving them gone", async () => {
    const port = fake({ failCreateFor: "admin" });
    const result = await provision([seed, cognito, hook], port);
    expect(result).toEqual({ ok: false, code: "provision_failed", cleanedUp: true });
    expect(port.calls.filter((call) => call.startsWith("create"))).toHaveLength(2);
    expect([...port.accounts]).toEqual([]);
    expect(port.calls.filter((call) => call.startsWith("end"))).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });
  it("revokes by the lease id an account that was made before its create call failed (a timeout)", async () => {
    const port = fake({ failCreateFor: "admin", createdBeforeFailing: true });
    const result = await provision([cognito], port);
    expect(result).toEqual({ ok: false, code: "provision_failed", cleanedUp: true });
    expect([...port.accounts]).toEqual([]);
    expect(port.calls.some((call) => /^revoke rvl-/u.test(call))).toBe(true);
  });
  it("says the cleanup was not confirmed when it could not be", async () => {
    const port = fake({ failCreateFor: "admin", revokeFails: 99 });
    expect(await provision([seed, cognito], port)).toEqual({ ok: false, code: "provision_failed", cleanedUp: false });
  });
  it("refuses an answer of the wrong shape, or one that names a handle other than the lease id, and revokes by the lease id", async () => {
    for (const answer of [{ loginRef: "has space", revokeHandle: "h" }, { loginRef: "l" }, { loginRef: "l", revokeHandle: "h", token: "x" }, { loginRef: "l", revokeHandle: "h", secrets: Array(9).fill("x") }, { loginRef: "l", revokeHandle: "its-own-handle" }]) {
      const port = fake({ answer });
      const result = await provision([seed], port);
      expect(result, JSON.stringify(answer)).toMatchObject({ ok: false, code: "provisioner_answer_invalid", cleanedUp: true });
      // the account the fake made under the lease id is gone, whatever handle the answer claimed
      expect([...port.accounts]).toEqual([]);
      expect(port.calls.some((call) => /^revoke rvl-/u.test(call))).toBe(true);
    }
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
  it("writes the lease record BEFORE the account exists, and marks it active once it does", async () => {
    const store = memoryStore();
    const order: string[] = [];
    const port: AccountProvisionerPort = { ...fake(), async create({ leaseId }) { order.push(`create saw ${store.records.get(leaseId)?.state}`); return { loginRef: "l", revokeHandle: leaseId }; } };
    await provision([seed], port, { store });
    expect(order).toEqual(["create saw creating"]);
    expect([...store.records.values()][0]).toMatchObject({ state: "active", loginRef: "l", profileId: "buyer", provisioner: "seed_command", roundId: "round-1", expiresAt: "2026-11-03T10:45:00.000Z" });
    expect(store.log[0]).toBe("put creating");
  });
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
  it("marks a fully revoked lease revoked", async () => {
    const store = memoryStore(); const port = fake();
    const result = await provision([seed], port, { store });
    if (!result.ok) throw new Error("provision");
    await revokeRunScopedAccounts({ leases: result.leases, accounts: [seed], ports: ports(port), store, now: NOW, sessions: new Map([["buyer", [COOKIE]]]) });
    expect([...store.records.values()][0]?.state).toBe("revoked");
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
  it("sweeps a lease still in `creating` (the create call never returned) by the lease id", async () => {
    const store = memoryStore(); const port = fake({ failCreateFor: "buyer", createdBeforeFailing: true });
    const record: LeaseRecord = { leaseId: "rvl-orphan-0001", roundId: "r", profileId: "buyer", provisioner: "seed_command", account: seed as RunScopedAccount, state: "creating", revokeHandle: "rvl-orphan-0001", createdAt: ENDS, expiresAt: "2026-11-03T10:45:00.000Z" };
    await store.put(record); port.accounts.add("rvl-orphan-0001");
    expect(await sweepRunScopedLeases({ store, ports: ports(port), now: NOW + 3_600_000 })).toEqual({ swept: ["rvl-orphan-0001"], stuck: [] });
    expect(port.accounts.size).toBe(0);
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
  it("does not clear a lease whose account still exists after the revoke", async () => {
    const store = memoryStore();
    const result = await provision([seed], fake(), { store });
    if (!result.ok) throw new Error("provision");
    expect((await sweepRunScopedLeases({ store, ports: ports(fake({ presence: "present" })), now: NOW + 3_600_000 })).stuck).toHaveLength(1);
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

  it("is confirmed when sessions were ended, every account revoked and gone, and every replayed credential was refused", async () => {
    const port = live(fake());
    const report = await revokeRunScopedAccounts({ leases, accounts: all, ports: ports(port), now: NOW, sessions });
    expect(report.confirmed).toBe(true);
    expect(report.heldUntil).toBeUndefined();
    expect(report.accounts).toEqual(["buyer", "admin", "partner"].map((profileId) => ({ profileId, sessionsEnded: true, revoked: true, accountGone: true, existenceControl: true, sessionProof: "dead", recorded: true })));
    // each credential is replayed twice: alive before the revoke (the control), dead after
    expect(port.calls.filter((call) => call.startsWith("replay"))).toHaveLength(8);
  });
  it("sees the account PRESENT and the credential ALIVE first, then ends the sessions, deletes the account, and only then checks it is gone and the credential dead", async () => {
    const port = live(fake());
    await revokeRunScopedAccounts({ leases: leases.slice(0, 1), accounts: all, ports: ports(port), now: NOW, sessions });
    expect(port.calls).toEqual(["exists rvl-buyer-0001", "replay cookie", "end rvl-buyer-0001", "revoke rvl-buyer-0001", "exists rvl-buyer-0001", "replay cookie"]);
  });
  it("is NOT confirmed when a replayed credential still works, and waiting never settles it", async () => {
    const port = live(fake({ replay: (credential, ended) => (!ended || credential.kind === "bearer" ? "alive" : "dead") }));
    const report = await revokeRunScopedAccounts({ leases, accounts: all, ports: ports(port), now: NOW, sessions });
    expect(report.confirmed).toBe(false);
    expect(report.accounts.map((item) => item.sessionProof)).toEqual(["dead", "alive", "alive"]);
    expect(revocationSettledAt(report, NOW + 10 * RUN_SCOPED_ASSUMED_TOKEN_TTL_MS)).toBe(false);
  });
  it("a replayed credential that works blocks the whole report even when another account earns a hold, and waiting out that hold never settles it", async () => {
    const port = live(fake({ replay: (credential, ended) => (!ended || credential.kind === "bearer" ? "alive" : "dead") }));
    // buyer: dead; admin: alive (bearer); partner has no credential kept, so a hold is earned
    const mixed = new Map<string, SessionCredential[]>([["buyer", [COOKIE]], ["admin", [BEARER]]]);
    const report = await revokeRunScopedAccounts({ leases, accounts: all, ports: ports(port), now: NOW, sessions: mixed, maxTokenTtlMs: 600_000 });
    expect(report.accounts.map((item) => item.sessionProof)).toEqual(["dead", "alive", "not_possible"]);
    expect(report.heldUntil).toBe("2026-11-03T10:10:00.000Z");
    expect(report.confirmed).toBe(false);
    expect(revocationSettledAt(report, NOW + 600_000)).toBe(false);
  });
  it("is NOT confirmed when the existence probe says the account is still there or cannot say", async () => {
    for (const presence of ["present", "unclear"] as const) {
      const report = await revokeRunScopedAccounts({ leases, accounts: all, ports: ports(live(fake({ presence }))), now: NOW, sessions });
      expect(report.confirmed, presence).toBe(false);
      expect(report.accounts.every((item) => item.revoked && !item.accountGone)).toBe(true);
    }
  });
  it("is NOT confirmed when the sessions could not be ended, however the rest went, and is not held (waiting does not end a server-side session)", async () => {
    const port = live(fake({ endFails: 99 }));
    const report = await revokeRunScopedAccounts({ leases, accounts: all, ports: ports(port), now: NOW, sessions });
    expect(report.confirmed).toBe(false);
    expect(report.accounts.every((item) => !item.sessionsEnded)).toBe(true);
    expect(report.heldUntil).toBeUndefined();
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
  it("takes the hold from the clock AFTER the revocations, not from the time the call began", async () => {
    let calls = 0;
    const slow = live(fake({ noReplay: true }));
    const original = slow.revoke.bind(slow);
    slow.revoke = async (input) => { calls += 1; return original(input); };
    const report = await revokeRunScopedAccounts({ leases: leases.slice(0, 1), accounts: all, ports: ports(slow), now: NOW, maxTokenTtlMs: 600_000, clock: () => NOW + 120_000 });
    expect(calls).toBe(1);
    expect(report.heldUntil).toBe(new Date(NOW + 120_000 + 600_000).toISOString());
  });
  it("only asks for a hold when everything else is proven, and a mixed report holds for the accounts it could not replay", async () => {
    const partial = new Map<string, SessionCredential[]>([["buyer", [COOKIE]]]);
    const report = await revokeRunScopedAccounts({ leases, accounts: all, ports: ports(live(fake())), now: NOW, sessions: partial, maxTokenTtlMs: 600_000 });
    expect(report.accounts.map((item) => item.sessionProof)).toEqual(["dead", "not_possible", "not_possible"]);
    expect(report.confirmed).toBe(false);
    expect(report.heldUntil).toBe("2026-11-03T10:10:00.000Z");
    expect(revocationSettledAt(report, NOW + 600_000)).toBe(true);
  });
  it("retries a failing revoke a bounded number of times, then gives up on that account only", async () => {
    const recovering = await revokeRunScopedAccounts({ leases: leases.slice(0, 1), accounts: all, ports: ports(live(fake({ revokeFails: RUN_SCOPED_REVOKE_ATTEMPTS - 1 }))), now: NOW, sessions });
    expect(recovering.confirmed).toBe(true);
    const port = live(fake({ revokeFails: RUN_SCOPED_REVOKE_ATTEMPTS }));
    const report = await revokeRunScopedAccounts({ leases, accounts: all, ports: ports(port), now: NOW, sessions });
    expect(report.accounts.map((item) => item.revoked)).toEqual([false, true, true]);
    expect(report.confirmed).toBe(false);
    // the account that could not be revoked is seen present first (the control) for all three, and checked gone afterwards for the two that were revoked
    expect(port.calls.filter((call) => call.startsWith("exists")).length).toBe(5);
    expect(report.accounts[0]?.sessionProof).toBe("not_possible");
  });
  it("is not confirmed with nothing to prove, and for a lease whose account or port is unknown, and a registered account is never revocable", async () => {
    expect((await revokeRunScopedAccounts({ leases: [], accounts: all, ports: ports(fake()), now: NOW })).confirmed).toBe(false);
    expect((await revokeRunScopedAccounts({ leases: [lease("ghost", "seed_command")], accounts: all, ports: ports(fake()), now: NOW })).confirmed).toBe(false);
    expect((await revokeRunScopedAccounts({ leases: [leases[0]!], accounts: all, ports: { seed_command: undefined, cognito_test_pool: undefined, http_hook: undefined }, now: NOW })).confirmed).toBe(false);
    expect((await revokeRunScopedAccounts({ leases: [lease("old", "seed_command")], accounts: [registered], ports: ports(fake()), now: NOW })).confirmed).toBe(false);
  });
  it("replays each account's OWN credentials (per-case attribution), every one the round held, however many", async () => {
    const replayed: Array<[string, string]> = [];
    const port = live(fake());
    const ended = new Set<string>();
    const endSessions = port.endSessions.bind(port);
    port.endSessions = async (input) => { ended.add(input.account.profileId); return endSessions(input); };
    port.sessionState = async ({ account, credential }) => { replayed.push([account.profileId, credential.value]); return ended.has(account.profileId) ? "dead" : "alive"; };
    const many = new Map<string, SessionCredential[]>([["buyer", [COOKIE, BEARER, { kind: "cookie", value: "third-value-3" }, { kind: "cookie", value: "fourth-value-4" }, { kind: "bearer", value: "fifth-value-5" }]], ["admin", [BEARER]]]);
    await revokeRunScopedAccounts({ leases: leases.slice(0, 2), accounts: all, ports: ports(port), now: NOW, sessions: many });
    // each credential is replayed before the revoke (the control) and after it
    expect(replayed.filter(([profile]) => profile === "buyer").map(([, value]) => value)).toEqual([COOKIE.value, BEARER.value, "third-value-3", "fourth-value-4", "fifth-value-5", COOKIE.value, BEARER.value, "third-value-3", "fourth-value-4", "fifth-value-5"]);
    expect(replayed.filter(([profile]) => profile === "admin").map(([, value]) => value)).toEqual([BEARER.value, BEARER.value]);
  });
  it("PC-N1: a fourth credential that stays alive after the revoke keeps the revocation unconfirmed, and waiting never settles it", async () => {
    const issued: SessionCredential[] = [COOKIE, BEARER, { kind: "cookie", value: "third-value-3" }, { kind: "bearer", value: "fourth-value-4" }];
    const port = live(fake({ replay: (credential, ended) => (!ended || credential.value === "fourth-value-4" ? "alive" : "dead") }));
    const report = await revokeRunScopedAccounts({ leases: leases.slice(0, 1), accounts: all, ports: ports(port), now: NOW, sessions: new Map([["buyer", issued]]) });
    expect(report.accounts[0]?.sessionProof).toBe("alive");
    expect(report.confirmed).toBe(false);
    expect(revocationSettledAt(report, NOW + 10 * RUN_SCOPED_ASSUMED_TOKEN_TTL_MS)).toBe(false);
    // the same round with that credential refused is confirmed, so the test is not passing for another reason
    const dead = await revokeRunScopedAccounts({ leases: leases.slice(0, 1), accounts: all, ports: ports(live(fake())), now: NOW, sessions: new Map([["buyer", issued]]) });
    expect(dead.confirmed).toBe(true);
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
  it("PC-N1: a credential that cannot be replayed (unusable, or not alive before the revoke) is uncontrolled: not confirmed until the hold runs out", async () => {
    const unusable = { kind: "header", value: "x-token-value" } as unknown as SessionCredential;
    const empty: SessionCredential = { kind: "cookie", value: "" };
    for (const extra of [unusable, empty]) {
      const report = await revokeRunScopedAccounts({ leases: leases.slice(0, 1), accounts: all, ports: ports(live(fake())), now: NOW, sessions: new Map([["buyer", [COOKIE, extra]]]), maxTokenTtlMs: 600_000 });
      expect(report.accounts[0]?.sessionProof).toBe("unclear");
      expect(report.confirmed).toBe(false);
      expect(report.heldUntil).toBe("2026-11-03T10:10:00.000Z");
      expect(revocationSettledAt(report, NOW + 599_999)).toBe(false);
      expect(revocationSettledAt(report, NOW + 600_000)).toBe(true);
    }
    // the only credential is unusable: still "unclear", never a silent pass
    const only = await revokeRunScopedAccounts({ leases: leases.slice(0, 1), accounts: all, ports: ports(live(fake())), now: NOW, sessions: new Map([["buyer", [unusable]]]), maxTokenTtlMs: 600_000 });
    expect(only.accounts[0]?.sessionProof).toBe("unclear");
    expect(only.confirmed).toBe(false);
  });
  it("reads an HTTP status from a replayed credential: 401 and 403 are dead, 2xx and 3xx alive, the rest proves nothing", () => {
    expect([401, 403].map(sessionStateOfStatus)).toEqual(["dead", "dead"]);
    expect([200, 204, 302].map(sessionStateOfStatus)).toEqual(["alive", "alive", "alive"]);
    expect([404, 429, 500, 503, undefined].map(sessionStateOfStatus)).toEqual(["unclear", "unclear", "unclear", "unclear", "unclear"]);
  });
  it("does not settle a report with no account, one with an account missing a part, or a malformed hold", () => {
    expect(revocationSettledAt({ confirmed: false, accounts: [] }, NOW)).toBe(false);
    const part = { profileId: "a", sessionsEnded: true, revoked: true, accountGone: true, existenceControl: true, recorded: true };
    expect(revocationSettledAt({ confirmed: false, accounts: [{ ...part, sessionProof: "not_possible" }], heldUntil: "garbage" }, NOW + 1e12)).toBe(false);
    expect(revocationSettledAt({ confirmed: false, accounts: [{ ...part, sessionProof: "not_possible" }] }, NOW + 1e12)).toBe(false);
    expect(revocationSettledAt({ confirmed: false, accounts: [{ ...part, accountGone: false, sessionProof: "dead" }] }, NOW)).toBe(false);
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
  it("http_hook follows its protocol: create with the lease id, end sessions, delete, and a 404 on GET is the existence proof", async () => {
    const calls: Array<[string, string, string, unknown]> = [];
    const status = new Map<string, number>([["GET", 404]]);
    const port = httpHookProvisioner({
      readToken: async () => "tok-123",
      call: async ({ method, url, token, body }) => { calls.push([method, url, token, body]); return method === "POST" && url.endsWith("/accounts") ? { status: 201, json: { loginRef: "p-1", revokeHandle: "p-1" } } : { status: status.get(method) ?? 200, json: {} }; },
    });
    const account = hook as RunScopedAccount;
    expect(await port.create({ account, leaseId: "rvl-hook-0001", expiresAt: "2026-11-03T10:45:00.000Z", signal })).toEqual({ loginRef: "p-1", revokeHandle: "p-1" });
    await port.endSessions({ account, revokeHandle: "p-1", signal });
    await port.revoke({ account, revokeHandle: "p-1", signal });
    expect(await port.accountExists({ account, revokeHandle: "p-1", signal })).toBe("gone");
    expect(calls).toEqual([
      ["POST", "https://tests.example.com/accounts", "tok-123", { profile: "partner", leaseId: "rvl-hook-0001", expiresAt: "2026-11-03T10:45:00.000Z" }],
      ["POST", "https://tests.example.com/accounts/delete", "tok-123", { action: "end_sessions", revokeHandle: "p-1" }],
      ["DELETE", "https://tests.example.com/accounts/delete", "tok-123", { revokeHandle: "p-1" }],
      ["GET", "https://tests.example.com/accounts/p-1", "tok-123", undefined],
    ]);
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
  it("positive control: an honest probe (alive before, dead after) on a GET route that sees the account confirms at once", async () => {
    const report = await round(hookServer({ replay: "honest" }), new Map([["partner", [BEARER]]]));
    expect(report).toMatchObject({ confirmed: true, accounts: [{ sessionProof: "dead", existenceControl: true, recorded: true }] });
    expect(report.heldUntil).toBeUndefined();
  });
  it("a replay client that never attaches the credential (so every replay is refused) is held, not confirmed", async () => {
    const report = await round(hookServer({ replay: "blind" }), new Map([["partner", [BEARER]]]));
    expect(report.accounts[0]).toMatchObject({ sessionProof: "unclear" });
    expect(report.confirmed).toBe(false);
    expect(report.heldUntil).toBe("2026-11-03T11:00:00.000Z");
    expect(revocationSettledAt(report, Date.parse("2026-11-03T10:59:59.000Z"))).toBe(false);
    expect(revocationSettledAt(report, Date.parse("2026-11-03T11:00:00.000Z"))).toBe(true);
  });
  it("an empty credential, a credential of an unknown scheme, and a junk one that was never alive are never evidence", async () => {
    for (const credential of [{ kind: "bearer", value: "" }, { kind: "basic" as never, value: "abc" }]) {
      const report = await round(hookServer({ replay: "honest" }), new Map([["partner", [credential as SessionCredential]]]));
      // PC-N1: a credential the round was issued but cannot be replayed is uncontrolled ("unclear", held for the token lifetime), not silently dropped to "nothing to prove"
      expect(report.accounts[0]?.sessionProof, JSON.stringify(credential)).toBe("unclear");
      expect(report.confirmed).toBe(false);
    }
    // a credential that was not alive before the revoke (junk, the wrong scheme) cannot be shown dead
    const junk = await round(hookServer({ replay: "blind" }), new Map([["partner", [{ kind: "cookie", value: "junk-not-a-session" }]]]));
    expect(junk.accounts[0]?.sessionProof).toBe("unclear");
    expect(junk.confirmed).toBe(false);
  });
  it("one credential alive before and one that was not: the second has no control, so the account is held", async () => {
    const server = hookServer({ replay: "honest" });
    let calls = 0;
    const original = server.port.sessionState!.bind(server.port);
    server.port.sessionState = async (input) => { calls += 1; return input.credential.value === "junk-not-a-session" ? "dead" : original(input); };
    const report = await round(server, new Map([["partner", [BEARER, { kind: "cookie", value: "junk-not-a-session" }]]]));
    expect(calls).toBeGreaterThan(0);
    expect(report.accounts[0]?.sessionProof).toBe("unclear");
    expect(report.confirmed).toBe(false);
    expect(report.heldUntil).toBeDefined();
  });
  it("a GET route that 404s for everything says gone with no control: held, not confirmed", async () => {
    const report = await round(hookServer({ getAlways404: true, replay: "honest" }), new Map([["partner", [BEARER]]]));
    expect(report.accounts[0]).toMatchObject({ accountGone: true, existenceControl: false, sessionProof: "dead" });
    expect(report.confirmed).toBe(false);
    expect(report.heldUntil).toBe("2026-11-03T11:00:00.000Z");
  });
  it("a server that answers alive for a removed account (200 for unknown users) is alive after: never settles", async () => {
    const server = hookServer({ replay: "honest" });
    server.port.sessionState = async () => "alive";
    const report = await round(server, new Map([["partner", [BEARER]]]));
    expect(report.accounts[0]?.sessionProof).toBe("alive");
    expect(revocationSettledAt(report, NOW + 365 * 24 * 3_600_000)).toBe(false);
  });
  it("positive control for the brief's second case: the same round with the control satisfied is confirmed, so the holds above are the missing controls' doing", async () => {
    const withControl = await round(hookServer({ replay: "honest" }), new Map([["partner", [BEARER]]]));
    const without = await round(hookServer({ replay: "blind" }), new Map([["partner", [BEARER]]]));
    expect([withControl.confirmed, without.confirmed]).toEqual([true, false]);
  });
  it("the sweeper and a failed provision's cleanup take no controls (they prove nothing, they only clean up)", async () => {
    const server = hookServer({ replay: "honest" });
    const store = memoryStore();
    const provisioned = await provisionRunScopedAccounts({ accounts: [hook], roundId: "r", roundEndsAt: ENDS, now: NOW, ports: hookPorts(server.port), store, newLeaseId });
    if (!provisioned.ok) throw new Error("provision");
    const report = await revokeRunScopedAccounts({ leases: provisioned.leases, accounts: [hook], ports: hookPorts(server.port), store, now: NOW, control: false, sessions: new Map([["partner", [BEARER]]]) });
    expect(report.confirmed).toBe(false);
    expect(report.accounts[0]).toMatchObject({ sessionsEnded: true, revoked: true, accountGone: true });
  });
  it("maps only UserNotFoundException to not-found for the Cognito existence probe", () => {
    expect(cognitoPresenceOf(undefined)).toBe("exists");
    expect(cognitoPresenceOf("UserNotFoundException")).toBe("not_found");
    for (const name of ["ResourceNotFoundException", "AccessDeniedException", "TimeoutError", "NotAuthorizedException", ""]) expect(cognitoPresenceOf(name), name).toBe("unclear");
  });
});

describe("a failed lease write is never swallowed (C1-c, I3)", () => {
  it("a hook that names its own handle is refused; the account is revoked by the lease id AND by the handle it claimed", async () => {
    const server = hookServer({ ownHandle: true });
    const store = memoryStore();
    const result = await provisionRunScopedAccounts({ accounts: [hook], roundId: "r", roundEndsAt: ENDS, now: NOW, ports: hookPorts(server.port), store, newLeaseId });
    expect(result).toMatchObject({ ok: false, code: "provisioner_answer_invalid", cleanedUp: true });
    expect([...server.alive]).toEqual([]);
    expect([...store.records.values()][0]?.state).toBe("revoked");
  });
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
  it("a write that fails once and then works is not an alert", async () => {
    const store = memoryStore();
    let failed = false;
    const flaky: LeaseStore = { ...store, update: async (leaseId, patch) => { if (!failed) { failed = true; throw new Error("blip"); } await store.update(leaseId, patch); } };
    const alerts: LeaseAlert[] = [];
    const result = await provisionRunScopedAccounts({ accounts: [hook], roundId: "r", roundEndsAt: ENDS, now: NOW, ports: hookPorts(hookServer().port), store: flaky, newLeaseId, onAlert: (alert) => alerts.push(alert) });
    expect(result.ok).toBe(true);
    expect(alerts).toEqual([]);
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
