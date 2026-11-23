// Browser testing, Lane B (owner decision 421, MUST): the 90-day expiry renewal of the test accounts, the first failed sign-in read as a setup fault, and the per-account result of the first real check.
// A project approved through the page writes its accounts once; without renewal every company's browser checks would stop signing in on day 90.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  E2E_SYNTHETIC_ACCOUNT_TTL_DAYS, createCandidateManifest, createWorkflowSnapshot, e2eApplicationAccountDefinitionDigest, projectPk, projectRevisionKey, queryAll, type DocumentStore, type E2ESourceSnapshot, type TransactItem,
} from "@agentx/contracts";
import { createApplicationPlanningContext } from "../../packages/broker/src/core/e2e/application-planning.js";
import { accountDefinitionRow, accountLatestRow, definitionOfAccountRef, e2eAccountDefinitionKey, e2eAccountLatestKey, latestAccountRef } from "../../packages/broker/src/e2e/application-account-registry.js";
import { readAccountRegistryEntries } from "../../packages/broker/src/core/e2e/account-registry.js";
import {
  RENEWAL_FAILED_REASON, accountsNeedRenewal, planAccountRenewals, recordSignIns, renewAfterPassedRound, renewWithSnapshot, signInOutcomes, type BrowserRenewalDeps,
} from "../../packages/broker/src/core/setup-agent/browser-testing-renewal.js";
import { BROWSER_SIGNIN_SK_PREFIX, browserStateKey } from "../../packages/broker/src/core/setup-agent/browser-testing-state.js";
import { readApproved } from "../../packages/broker/src/core/setup-agent/browser-testing-proposal.js";
import { E2E_OWNER_SENTENCES } from "../../packages/broker/src/e2e/owner-sentences.js";
import { FAKE_COMPANY } from "../support/core-host-fakes.js";
import { browserGet, browserPost, browserWorld, storeWith } from "../support/browser-testing-world.js";
import { snapshotOf, webApiRow } from "../support/e2e-application-plan-fixtures.js";
import type { ApplicationTask } from "../../packages/broker/src/core/e2e/application-seams.js";
import { contractOf } from "../support/e2e-account-registry-fixtures.js";

const accountsApp = readFileSync(new URL("../fixtures/e2e-accounts-app/package.json", import.meta.url), "utf8");
const ACCOUNTS = snapshotOf({ "package.json": accountsApp, "seed.mjs": "// seeds from the accounts file\n" });
const DAY = 86_400_000;
const APPLICATION = "@agentx/accounts-web-fixture";
const PROFILES = ["orders-viewer", "orders-owner", "orders-owner-b"];
const pairs = PROFILES.map((profileId) => ({ applicationId: APPLICATION, profileId }));

/** A company with browser testing approved on the accounts app: its three accounts written at approval time, expiring in 90 days. */
async function approvedWorld() {
  const w = await browserWorld({ snapshot: () => ACCOUNTS });
  await w.refresh();
  expect((await w.call(browserPost("check", { requestId: randomUUID(), expectedDraftRevision: 1 }), w.owner)).status).toBe(200);
  await w.passCheck();
  const offer = (await w.offered(w.owner))!;
  expect((await w.call(browserPost("decision", { requestId: offer.requestId, outcome: "approve", seen: { revision: offer.revision, artifactDigest: offer.artifactDigest } }), w.owner)).status).toBe(200);
  const approvedAt = w.world.clock.now;
  const row = (await w.world.store.get(projectRevisionKey(FAKE_COMPANY, "payments", 2)))!;
  const approval = row["setupApproval"] as { proposalRef: string; proposalSha256: string; candidateDigest: string };
  const approved = (await readApproved(w.objects, approval, { name: "demo", url: "https://github.com/example/demo.git", defaultBranch: "main" }, row["registeredBy"] as string))!;
  /** The renewal's dependencies at `days` after the approval. */
  const at = (days: number, store: DocumentStore = w.world.store): BrowserRenewalDeps => ({ store, companyId: FAKE_COMPANY, objects: w.objects, now: () => approvedAt + days * DAY, log: () => undefined });
  const entries = async (options: { earlierFor?: () => boolean } = {}) => (await readAccountRegistryEntries({ store: w.world.store }, FAKE_COMPANY, "payments", pairs, options)).entries;
  return { w, approvedAt, approval, approved, at, entries };
}
type Approved = Awaited<ReturnType<typeof approvedWorld>>;

describe("renewing the test accounts' 90-day definitions (same definition, no new approval)", () => {
  it("writes nothing while more than 14 days are left", async () => {
    const a = await approvedWorld();
    expect(await accountsNeedRenewal(a.at(75), "payments")).toBe(false);
    expect(await renewWithSnapshot(a.at(75), "payments", a.approved.snapshot, a.approval.proposalSha256)).toEqual({ status: "none" });
    expect((await a.entries()).map((entry) => entry.definition.revision)).toEqual([1, 1, 1]);
  });

  it("on day 89 renews each account to the NEXT revision of the SAME definition, under the approval already in force", async () => {
    const a = await approvedWorld();
    const before = await a.entries();
    const deps = a.at(89);
    expect(await accountsNeedRenewal(deps, "payments")).toBe(true);
    expect(await renewWithSnapshot(deps, "payments", a.approved.snapshot, a.approval.proposalSha256)).toEqual({ status: "renewed", accounts: 3 });
    const after = await a.entries();
    expect(after.map((entry) => entry.definition.revision)).toEqual([2, 2, 2]);
    for (const [index, entry] of after.entries()) {
      const { revision: _r1, expiresAt: _e1, ...was } = before[index]!.definition;
      const { revision: _r2, expiresAt: now, ...is } = entry.definition;
      void _r1; void _e1; void _r2;
      expect(is).toEqual(was);
      expect(Date.parse(now)).toBe(a.approvedAt + (89 + E2E_SYNTHETIC_ACCOUNT_TTL_DAYS) * DAY);
      // The approval that wrote the account is still the one it records: renewing is not a newer setup.
      expect(entry.setupApprovedAt).toBe(before[index]!.setupApprovedAt);
    }
    // A second planning read the same day finds nothing left to renew.
    expect(await renewWithSnapshot(deps, "payments", a.approved.snapshot, a.approval.proposalSha256)).toEqual({ status: "none" });
  });

  it("on day 91, a LAPSED but unchanged definition is renewed on the next read and usable again, with no approval", async () => {
    const a = await approvedWorld();
    const lapsed = a.at(91);
    const contract = contractOf(accountsApp);
    // Before: expired, so the account check refuses.
    expect(() => latestAccountRef({ contract, entries: [], applicationId: APPLICATION, profileId: "orders-viewer", now: lapsed.now() })).toThrow();
    const expired = (await a.entries())[0]!;
    expect(() => latestAccountRef({ contract, entries: [expired], applicationId: APPLICATION, profileId: "orders-viewer", now: lapsed.now() })).toThrow(/expired/u);
    expect(await renewWithSnapshot(lapsed, "payments", a.approved.snapshot, a.approval.proposalSha256)).toEqual({ status: "renewed", accounts: 3 });
    const renewed = (await a.entries())[0]!;
    expect(latestAccountRef({ contract, entries: [renewed], applicationId: APPLICATION, profileId: "orders-viewer", now: lapsed.now() })).toMatchObject({ profileId: "orders-viewer", revision: 2 });
  });

  it("a task pinned to the old revision still reads its earlier definition", async () => {
    const a = await approvedWorld();
    const first = await a.entries();
    await renewWithSnapshot(a.at(89), "payments", a.approved.snapshot, a.approval.proposalSha256);
    const [viewer] = await a.entries({ earlierFor: () => true });
    expect(viewer!.definition.revision).toBe(2);
    expect(viewer!.earlier?.map((definition) => definition.revision)).toEqual([1]);
    expect(definitionOfAccountRef(viewer!, { revision: 1 })).toEqual(first[0]!.definition);
  });

  it("never carries a change: a registered definition that is not the approved contract's is left alone", async () => {
    const a = await approvedWorld();
    const viewer = (await a.entries())[0]!;
    // The registered viewer is a different role than the approved contract implies (a change nobody approved through this path).
    const tampered = { ...viewer.definition, roleRef: "owner" };
    await a.w.world.store.put({ item: accountDefinitionRow(FAKE_COMPANY, "payments", tampered) as never });
    await a.w.world.store.put({ item: accountLatestRow(FAKE_COMPANY, "payments", APPLICATION, "orders-viewer", { revision: 1, definitionDigest: e2eApplicationAccountDefinitionDigest(tampered) }) as never });
    expect((await planAccountRenewals(a.at(89), "payments", a.approved.snapshot, a.approval.proposalSha256)).accounts).toBe(2);
    expect(await renewWithSnapshot(a.at(89), "payments", a.approved.snapshot, a.approval.proposalSha256)).toEqual({ status: "renewed", accounts: 2 });
    const after = await a.entries();
    expect(after.map((entry) => [entry.definition.profileId, entry.definition.revision, entry.definition.roleRef])).toEqual([["orders-viewer", 1, "owner"], ["orders-owner", 2, "owner"], ["orders-owner-b", 2, "owner"]]);
  });

  it("never creates an account: one that was never written (or whose rows cannot be read) is not renewed into existence", async () => {
    const a = await approvedWorld();
    await a.w.world.store.delete({ key: e2eAccountLatestKey(FAKE_COMPANY, "payments", APPLICATION, "orders-owner-b") });
    await a.w.world.store.delete({ key: e2eAccountDefinitionKey(FAKE_COMPANY, "payments", APPLICATION, "orders-owner", 1) });
    expect(await renewWithSnapshot(a.at(89), "payments", a.approved.snapshot, a.approval.proposalSha256)).toEqual({ status: "renewed", accounts: 1 });
    expect((await a.entries()).map((entry) => [entry.definition.profileId, entry.definition.revision])).toEqual([["orders-viewer", 2]]);
  });

  it("renews from the APPROVED files, never from the repository as it is now: a repository that changed since the approval changes nothing here", async () => {
    const a = await approvedWorld();
    const manifest = JSON.parse(accountsApp) as { agentx: { e2e: { accountProfiles: Array<{ roleRef: string }> } } };
    manifest.agentx.e2e.accountProfiles[0]!.roleRef = "superuser";
    const now = snapshotOf({ "package.json": JSON.stringify(manifest), "seed.mjs": "// seeds\n" });
    // Handed the changed files (which the renewal never is), the viewer's definition is no longer the one registered, and it is skipped.
    expect((await planAccountRenewals(a.at(89), "payments", now, a.approval.proposalSha256)).accounts).toBe(2);
    expect((await planAccountRenewals(a.at(89), "payments", a.approved.snapshot, a.approval.proposalSha256)).accounts).toBe(3);
  });

  it("a failed renewal is a served fault the page shows, and a later success clears it", async () => {
    const a = await approvedWorld();
    const failing = storeWith(a.w.world.store, { transact: async (): Promise<never> => { throw new Error("store down"); } });
    expect(await renewWithSnapshot(a.at(89, failing), "payments", a.approved.snapshot, a.approval.proposalSha256)).toEqual({ status: "failed" });
    expect((await a.w.world.store.get(browserStateKey(FAKE_COMPANY, "payments")))?.["renewalFault"]).toMatchObject({ code: "accounts-refresh-failed" });
    expect(((await a.w.call(browserGet(), a.w.owner)).body as { faults: string[] }).faults).toContain("accounts-refresh-failed");
    expect(await renewWithSnapshot(a.at(89), "payments", a.approved.snapshot, a.approval.proposalSha256)).toEqual({ status: "renewed", accounts: 3 });
    expect((await a.w.world.store.get(browserStateKey(FAKE_COMPANY, "payments")))?.["renewalFault"]).toBeUndefined();
    expect(((await a.w.call(browserGet(), a.w.owner)).body as { faults: string[] }).faults).not.toContain("accounts-refresh-failed");
  });

  it("a renewal that loses a race to another renewal plans again and writes once", async () => {
    const a = await approvedWorld();
    let calls = 0;
    const real = a.w.world.store;
    const racing = storeWith(real, { transact: async (items: readonly TransactItem[]) => { calls += 1; return calls === 1 ? { applied: false as const, reason: "condition_failed" as const, failed: [0] } : real.transact(items); } });
    expect(await renewWithSnapshot(a.at(89, racing), "payments", a.approved.snapshot, a.approval.proposalSha256)).toEqual({ status: "renewed", accounts: 3 });
    expect(calls).toBe(2);
    expect((await a.entries()).map((entry) => entry.definition.revision)).toEqual([2, 2, 2]);
  });
});

describe("the three places renewal runs", () => {
  const taskOf = (a: Approved, revision = 2): ApplicationTask => {
    const workflow = createWorkflowSnapshot({ taskId: "11111111-1111-4111-8111-111111111111", ownerId: "a".repeat(64), now: new Date(a.approvedAt).toISOString() });
    return { pk: `DEVTASK#${workflow.taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: workflow.taskId, companyId: FAKE_COMPANY, project: "payments", startingRevision: revision, workflow,
      preparedBase: [{ repositoryId: "demo", baseCommitSha: ACCOUNTS.commitSha }], developerId: "d", provider: "local-owner", developerName: "D", client: "test", title: "Change", workspaceId: "22222222-2222-4222-8222-222222222222",
      ownerKey: "a".repeat(64), conversationId: "33333333-3333-4333-8333-333333333333", shared: false, createdAt: new Date(a.approvedAt).toISOString(), updatedAt: new Date(a.approvedAt).toISOString(),
      charge: { member: { pk: "m", sk: "LIMIT" }, organization: { pk: "o", sk: "LIMIT" } } };
  };
  const ports = (a: Approved, days: number, store: DocumentStore = a.w.world.store) => {
    const row = webApiRow("web");
    const deps = a.at(days, store);
    return {
      project: async (task: ApplicationTask) => await a.w.world.store.get(projectRevisionKey(FAKE_COMPANY, task.project, task.startingRevision)) as never,
      readText: async (key: string) => { const bytes = a.w.objects.map.get(key); return bytes === undefined ? undefined : Buffer.from(bytes).toString("utf8"); },
      readyRuntimes: async () => [{ kind: "web" as const, profileId: row.profileId, supportedSteps: row.capabilities.supportedSteps, supportedAssertions: row.capabilities.supportedAssertions }],
      accounts: async () => (await readAccountRegistryEntries({ store: a.w.world.store }, FAKE_COMPANY, "payments", pairs)).entries,
      now: deps.now,
      renewAccounts: async (_task: ApplicationTask, approved: { snapshot: E2ESourceSnapshot; proposalSha256: string }) => {
        const result = await renewWithSnapshot(deps, "payments", approved.snapshot, approved.proposalSha256);
        if (result.status !== "failed") return { ok: true as const };
        return { ok: false as const, blocking: await accountsNeedRenewal(deps, "payments", 0), reason: RENEWAL_FAILED_REASON };
      },
    };
  };

  it("on a planning read with 14 days or fewer left", async () => {
    const a = await approvedWorld();
    expect(await createApplicationPlanningContext(ports(a, 40))(taskOf(a))).toMatchObject({ status: "available" });
    expect((await a.entries()).map((entry) => entry.definition.revision)).toEqual([1, 1, 1]);
    expect(await createApplicationPlanningContext(ports(a, 80))(taskOf(a))).toMatchObject({ status: "available" });
    expect((await a.entries()).map((entry) => entry.definition.revision)).toEqual([2, 2, 2]);
  });

  it("a task planned on a repository that changed since the approval still renews from the APPROVED files, never carrying the change", async () => {
    const a = await approvedWorld();
    const manifest = JSON.parse(accountsApp) as { agentx: { e2e: { accountProfiles: Array<{ roleRef: string }> } } };
    manifest.agentx.e2e.accountProfiles[0]!.roleRef = "superuser";
    const drifted = snapshotOf({ "package.json": JSON.stringify(manifest), "seed.mjs": "// seeds\n" });
    const newer = { ...drifted, commitSha: "c".repeat(40), candidate: createCandidateManifest([{ repositoryId: "example/demo", commitSha: "c".repeat(40), treeSha: drifted.treeSha }]) } as E2ESourceSnapshot;
    const task = { ...taskOf(a), preparedBase: [{ repositoryId: "demo", baseCommitSha: newer.commitSha }] } as ApplicationTask;
    const context = await createApplicationPlanningContext({ ...ports(a, 80), capture: async () => newer })(task);
    expect(context).toMatchObject({ status: "available", source: { origin: "prepared-commit", commitSha: newer.commitSha } });
    const after = await a.entries();
    expect(after.map((entry) => [entry.definition.profileId, entry.definition.revision, entry.definition.roleRef])).toEqual([["orders-viewer", 2, "viewer"], ["orders-owner", 2, "owner"], ["orders-owner-b", 2, "owner"]]);
  });

  it("on the next planning read for a project that sat idle past day 90, with the accounts usable in that very context", async () => {
    const a = await approvedWorld();
    const context = await createApplicationPlanningContext(ports(a, 120))(taskOf(a));
    expect(context).toMatchObject({ status: "available" });
    expect((await a.entries()).map((entry) => entry.definition.revision)).toEqual([2, 2, 2]);
    if (context?.status !== "available") throw new Error("expected a context");
    expect((context.runtimeAccountRefs ?? []).map((ref) => ref.profileId).sort()).toEqual(expect.arrayContaining(["orders-viewer"]));
  });

  it("a failed renewal of a lapsed definition says why instead of silently skipping browser checks; one with days left carries on", async () => {
    const a = await approvedWorld();
    const failing = storeWith(a.w.world.store, { transact: async (): Promise<never> => { throw new Error("store down"); } });
    expect(await createApplicationPlanningContext(ports(a, 120, failing))(taskOf(a))).toEqual({ status: "unknown", reason: RENEWAL_FAILED_REASON });
    expect(await createApplicationPlanningContext(ports(a, 80, failing))(taskOf(a))).toMatchObject({ status: "available" });
    expect(RENEWAL_FAILED_REASON).toBe("Rovara couldn't refresh this project's test accounts. Browser checks can't sign in until it does. Try again in a few minutes.");
  });

  it("after a passed browser check, renews near-expiry accounts of the task's pinned approved setup; far from expiry it reads nothing big", async () => {
    const a = await approvedWorld();
    const get = vi.spyOn(a.w.objects, "get");
    expect(await renewAfterPassedRound(a.at(10), "payments", 2)).toEqual({ status: "none" });
    expect(get).not.toHaveBeenCalled();
    expect(await renewAfterPassedRound(a.at(85), "payments", 2)).toEqual({ status: "renewed", accounts: 3 });
    // A task pinned to a revision with no approval renews nothing.
    expect(await renewAfterPassedRound(a.at(200), "payments", 1)).toEqual({ status: "none" });
  });
});

describe("how the first real sign-in went", () => {
  const SENTENCE = E2E_OWNER_SENTENCES.groupSentence("login-failed")!;

  it("reads decided cases as signed in, a refused sign-in as refused, and anything unclear as no record", () => {
    const outcomes = signInOutcomes([
      { accountLabel: "orders-owner", status: "PASSED" }, { accountLabel: "orders-viewer", status: "UNKNOWN", reason: SENTENCE }, { accountLabel: "orders-owner-b", status: "UNKNOWN", reason: "The app didn't answer." },
      { accountLabel: "rovara-anonymous", status: "PASSED" }, { accountLabel: "account", status: "PASSED" }, { accountLabel: "mixed", status: "UNKNOWN", reason: SENTENCE }, { accountLabel: "mixed", status: "FAILED" },
    ], SENTENCE);
    expect([...outcomes.entries()].sort()).toEqual([["mixed", "ok"], ["orders-owner", "ok"], ["orders-viewer", "refused"]]);
  });

  it("is kept per kind of user and served by the page, 'not tried yet' (null) until a real check reports", async () => {
    const a = await approvedWorld();
    const deps = a.at(1);
    const accounts = async () => ((await a.w.call(browserGet(), a.w.owner)).body as { accounts: Array<{ profileId: string; lastSignIn: { status: string } | null }> }).accounts;
    expect((await accounts()).map((account) => account.lastSignIn)).toEqual([null, null, null]);
    await recordSignIns(deps, "payments", new Map([["orders-owner", "ok" as const], ["orders-viewer", "refused" as const]]));
    expect((await accounts()).map((account) => [account.profileId, account.lastSignIn?.status ?? null])).toEqual([["orders-viewer", "refused"], ["orders-owner", "ok"], ["orders-owner-b", null]]);
    expect((await queryAll(a.w.world.store, { pk: projectPk(FAKE_COMPANY, "payments"), sk: { op: "beginsWith", prefix: BROWSER_SIGNIN_SK_PREFIX } })).map((row) => row["profileId"]).sort()).toEqual(["orders-owner", "orders-viewer"]);
  });

  it("the first failed sign-in inside a task reads as a setup fault, not the change's", () => {
    expect(SENTENCE).toContain("problem with the project's browser testing setup, not with this change");
    expect(SENTENCE).toContain("run the project setup again");
    expect(SENTENCE).not.toMatch(/coding agent needs to fix/iu);
  });
});

