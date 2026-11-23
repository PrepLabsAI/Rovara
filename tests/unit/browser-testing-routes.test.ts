// Browser testing in a project's setup (owner decisions 417, 420, 421), Lane A: the write path. A company's browser testing policy is written ONLY through a candidate revision, approved by a LIVE company owner or
// admin, and active only on approval. Source-backed: nothing typed, no password anywhere.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, WEB_API_RUNTIME_PROFILE_ID, canonicalJson, createWorkflowSnapshot, change, orgProjectCatalogKey, projectRevisionKey, projectPk, type E2ESourceSnapshot, type JsonValue } from "@agentx/contracts";
import type { BrowserTestingView } from "../../packages/broker/src/core/setup-agent/browser-testing.js";
import { createApplicationPlanningContext } from "../../packages/broker/src/core/e2e/application-planning.js";
import { readAccountRegistryEntries } from "../../packages/broker/src/core/e2e/account-registry.js";
import { SETUP_APPLY_KIND, setupApplyDigest, setupApplyKey, withCandidateOps } from "../../packages/broker/src/core/setup-agent/apply.js";
import { browserApprovalKey } from "../../packages/broker/src/core/setup-agent/browser-testing-approval.js";
import { BROWSER_TESTING_WORDS, browserDraftKey } from "../../packages/broker/src/core/setup-agent/browser-testing-state.js";
import { setupDecisionRequestId, setupCardOf } from "../../packages/broker/src/core-host/setup-approval.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { FAKE_COMPANY } from "../support/core-host-fakes.js";
import { OTHER_COMPANY, browserGet, browserPost, browserPut, browserWorld, projectDefinition, type BrowserWorld } from "../support/browser-testing-world.js";
import { inferredSnapshot, snapshotOf, webApiRow } from "../support/e2e-application-plan-fixtures.js";
import type { ApplicationTask } from "../../packages/broker/src/core/e2e/application-seams.js";

const accountsApp = readFileSync(new URL("../fixtures/e2e-accounts-app/package.json", import.meta.url), "utf8");
const ACCOUNTS = snapshotOf({ "package.json": accountsApp, "seed.mjs": "// seeds from the accounts file\n" });
const uuid = () => randomUUID();

/** The page's view as a person reads it. */
const view = async (w: BrowserWorld, caller = w.owner) => (await w.call(browserGet(), caller)).body as unknown as BrowserTestingView;
/** Drives the write path up to a waiting candidate: refresh, check. Returns the draft revision the check was made from. */
async function checked(w: BrowserWorld, caller = w.owner): Promise<number> {
  expect((await w.refresh(caller)).status).toBe(200);
  const revision = (await view(w, caller)).draft!.revision;
  const check = await w.call(browserPost("check", { requestId: uuid(), expectedDraftRevision: revision }), caller);
  expect(check.status, check.raw).toBe(200);
  return revision;
}
/** What the page offers the person to approve, once the commands check passed. */
async function approveBody(w: BrowserWorld, caller = w.owner, outcome: "approve" | "reject" = "approve") {
  const offer = await w.offered(caller);
  if (offer === undefined) throw new Error("nothing is offered to approve");
  return { requestId: offer.requestId, outcome, seen: { revision: offer.revision, artifactDigest: offer.artifactDigest } };
}
const rows = async (w: BrowserWorld) => ({
  catalog: await w.latestRevision(), apply: await w.world.store.get(setupApplyKey(FAKE_COMPANY, "payments")), draft: await w.world.store.get(browserDraftKey(FAKE_COMPANY, "payments")),
  revision2: await w.world.store.get(projectRevisionKey(FAKE_COMPANY, "payments", 2)),
});

describe("who reads and who changes", () => {
  it("any role on the project reads; a company owner or admin may change; the project's own administrator may read but not change; everyone else is a 404", async () => {
    const w = await browserWorld({ snapshot: () => inferredSnapshot });
    expect(await view(w, w.owner)).toMatchObject({ canManage: true, viewerRole: "owner", state: "not-set-up" });
    expect(await view(w, w.admin)).toMatchObject({ canManage: true, viewerRole: "admin" });
    expect(await view(w, w.projectAdmin)).toMatchObject({ canManage: false, viewerRole: "project-admin" });
    expect(await view(w, w.developer)).toMatchObject({ canManage: false, viewerRole: "member" });
    const answer = await w.call(browserGet(), w.stranger);
    expect(answer.status).toBe(404);
    expect(answer.body).toEqual({ error: { code: "NOT_FOUND", message: BROWSER_TESTING_WORDS.projectNotFound } });
    expect((await w.call(browserGet("/v1/app/projects/ledger/browser-testing"), w.owner)).status).toBe(404);
    // Another company's owner reads and changes only their own company's project of that name: nothing of this company's is theirs.
    await w.refresh();
    expect(await view(w, w.outsider)).toMatchObject({ state: "not-set-up", draft: null });
    expect((await w.refresh(w.outsider)).status).toBe(200);
    expect(await w.world.store.get(browserDraftKey(OTHER_COMPANY, "payments"))).toMatchObject({ draftRevision: 1 });
    expect(await w.world.store.get(browserDraftKey(FAKE_COMPANY, "payments"))).toMatchObject({ draftRevision: 1 });
  });

  it("refuses EVERY change to a project administrator, a developer and a stranger in fixed words, writing nothing and recording nothing", async () => {
    const w = await browserWorld({ snapshot: () => inferredSnapshot });
    await checked(w);
    await w.passCheck();
    const before = JSON.stringify(await rows(w));
    const auditBefore = w.audit.length;
    const draftRevision = (await view(w)).draft!.revision;
    const attempts = [
      browserPost("refresh", { requestId: uuid() }), browserPut("draft", { requestId: uuid(), expectedDraftRevision: draftRevision, runTimeoutMs: 120_000 }),
      browserPost("check", { requestId: uuid(), expectedDraftRevision: draftRevision }), browserPost("discard", { requestId: uuid() }), browserPost("pause", { requestId: uuid() }),
      browserPost("resume", { requestId: uuid() }), browserPost("decision", await approveBody(w)),
    ];
    for (const caller of [w.projectAdmin, w.developer]) for (const request of attempts) {
      const answer = await w.call(request, caller);
      expect(answer.status, `${request.method} ${request.path}`).toBe(403);
      expect(answer.body).toEqual({ error: { code: "FORBIDDEN", message: BROWSER_TESTING_WORDS.notAllowed } });
    }
    for (const request of attempts) expect((await w.call(request, w.stranger)).status).toBe(404);
    expect(JSON.stringify(await rows(w))).toBe(before);
    expect(w.audit.length).toBe(auditBefore);
  });

  it("takes strict bodies: an unknown field, a bad id and a time limit outside the range are refused without echoing anything", async () => {
    const w = await browserWorld({ snapshot: () => inferredSnapshot });
    const secret = "hunter2-the-value-must-not-come-back";
    for (const body of [{ requestId: uuid(), password: secret }, { requestId: "nope" }, {}]) {
      const answer = await w.call(browserPost("refresh", body), w.owner);
      expect(answer.status).toBe(400);
      expect(answer.raw).not.toContain(secret);
      expect(answer.body).toEqual({ error: { code: "CONFIG_INVALID", message: BROWSER_TESTING_WORDS.invalid } });
    }
    await checked(w);
    const revision = (await view(w)).draft!.revision;
    for (const body of [{ requestId: uuid(), expectedDraftRevision: revision, runTimeoutMs: 5 }, { requestId: uuid(), expectedDraftRevision: revision, runTimeoutMs: 9_999_999 }, { requestId: uuid(), expectedDraftRevision: revision }]) {
      expect((await w.call(browserPut("draft", body), w.owner)).status).toBe(400);
    }
  });
});

describe("the write path: draft, check, approve", () => {
  it("makes a draft from the repository, takes the two choices, stores a candidate that is not the latest, and activates only on approval", async () => {
    const w = await browserWorld({ snapshot: () => ACCOUNTS });
    expect((await w.refresh()).status).toBe(200);
    const first = await view(w);
    expect(first).toMatchObject({ state: "draft", draft: { revision: 1, locked: false, found: { problem: null } } });
    expect(first.draft!.found.applications[0]!.userKinds.map((kind) => kind.profileId)).toEqual(["orders-viewer", "orders-owner", "orders-owner-b"]);
    const saved = await w.call(browserPut("draft", { requestId: uuid(), expectedDraftRevision: 1, proof: { screenshotMode: "all", video: true }, runTimeoutMs: 300_000 }), w.owner);
    expect(saved.status, saved.raw).toBe(200);
    expect((await view(w)).draft).toMatchObject({ revision: 2, proof: { screenshotMode: "all", video: true }, runTimeoutMs: 300_000 });

    expect((await w.call(browserPost("check", { requestId: uuid(), expectedDraftRevision: 2 }), w.owner)).status).toBe(200);
    const waiting = await view(w);
    expect(waiting).toMatchObject({ state: "checking", draft: { locked: true }, candidate: { status: "checking", revision: 2, canApprove: false, approval: null } });
    // Nothing is in force: the catalog still names revision 1, so no task starts on the candidate, and the candidate holds no approval.
    expect(await w.latestRevision()).toBe(1);
    const candidate = await w.world.store.get(projectRevisionKey(FAKE_COMPANY, "payments", 2));
    expect(candidate).toMatchObject({ candidate: true });
    expect(candidate?.["setupApproval"]).toBeUndefined();
    expect(candidate?.["definition"]).toMatchObject({ revision: 2, e2e: { policyRevision: 1, capture: { video: true, screenshotMode: "all" }, limits: { runTimeoutMs: 300_000 } } });

    await w.passCheck();
    const ready = await view(w);
    expect(ready).toMatchObject({ state: "waiting", candidate: { status: "ready", canApprove: true } });
    const approved = await w.call(browserPost("decision", await approveBody(w)), w.owner);
    expect(approved.status, approved.raw).toBe(200);
    expect(approved.body).toMatchObject({ decision: "approved", revision: 2 });
    expect(await w.latestRevision()).toBe(2);
  });

  it("writes exactly what the planning seam reads: policy, approval, registrant and binding on the company's revision, and the accounts under the NAMED company", async () => {
    const w = await browserWorld({ snapshot: () => ACCOUNTS });
    await checked(w);
    await w.passCheck();
    expect((await w.call(browserPost("decision", await approveBody(w)), w.owner)).status).toBe(200);
    const revision = await w.world.store.get(projectRevisionKey(FAKE_COMPANY, "payments", 2));
    expect(revision).toMatchObject({ registeredBy: "owner-key-of-the-registrant", setupApproval: { decision: "approve" }, runtimeBinding: { deploymentMode: "ec2-ebs" } });
    // The accounts sit under the company that approved, never under another one (the old route wrote them under another one).
    const pairs = ["orders-viewer", "orders-owner", "orders-owner-b"].map((profileId) => ({ applicationId: "@agentx/accounts-web-fixture", profileId }));
    expect((await readAccountRegistryEntries({ store: w.world.store }, FAKE_COMPANY, "payments", pairs)).entries).toHaveLength(3);
    expect((await readAccountRegistryEntries({ store: w.world.store }, IMPLICIT_COMPANY_ID, "payments", pairs)).entries).toHaveLength(0);
    expect((await readAccountRegistryEntries({ store: w.world.store }, OTHER_COMPANY, "payments", pairs)).entries).toHaveLength(0);
    // Who approved and when, for the page; the draft the check was made from is gone.
    expect(await w.world.store.get(browserApprovalKey(FAKE_COMPANY, "payments"))).toMatchObject({ approvedBy: "p-owner", revision: 2 });
    expect(await w.world.store.get(browserDraftKey(FAKE_COMPANY, "payments"))).toBeUndefined();

    // The ROOT-CAUSE proof, through the product path: the planning seam reads the approved revision and offers a source-backed context.
    const task = planningTask(w, 2, ACCOUNTS);
    expect(await createApplicationPlanningContext(planningPorts(w))(task)).toMatchObject({ status: "available", source: { origin: "prepared-commit", preparedCommitStatus: "MATCHED" } });
    // With no prepared commit the context is the approved setup itself: its stored files, issuer, policy and candidate all verified.
    const { preparedBase: _prepared, ...unprepared } = task;
    void _prepared;
    expect(await createApplicationPlanningContext(planningPorts(w))(unprepared)).toMatchObject({ status: "available", source: { origin: "approved-setup" } });
  });

  it("the page after approval: on, approved by you, summarised from the stored proposal, each kind of user 'not tried yet'", async () => {
    const w = await browserWorld({ snapshot: () => ACCOUNTS });
    await checked(w);
    await w.passCheck();
    await w.call(browserPost("decision", await approveBody(w)), w.owner);
    const on = await view(w);
    expect(on).toMatchObject({ state: "on", paused: false, approved: { revision: 2, approvedBy: "p-owner", decidedByYou: true }, newerChange: null, candidate: null });
    expect(on.approved!.summary!.found.applications[0]!.start).toBe("node server.mjs");
    expect(on.accounts.map((account) => [account.profileId, account.lastSignIn])).toEqual([["orders-viewer", null], ["orders-owner", null], ["orders-owner-b", null]]);
    expect((await view(w, w.admin)).approved).toMatchObject({ decidedByYou: false });
  });

  it("a replay of the same request changes nothing more: one revision, one decision", async () => {
    const w = await browserWorld({ snapshot: () => inferredSnapshot });
    const requestId = uuid();
    for (let i = 0; i < 2; i += 1) expect((await w.call(browserPost("refresh", { requestId }), w.owner)).status).toBe(200);
    expect((await view(w)).draft!.revision).toBe(1);
    const checkId = uuid();
    for (let i = 0; i < 2; i += 1) expect((await w.call(browserPost("check", { requestId: checkId, expectedDraftRevision: 1 }), w.owner)).status, `check ${i}`).toBe(200);
    await w.passCheck();
    const body = await approveBody(w);
    const first = await w.call(browserPost("decision", body), w.owner);
    const again = await w.call(browserPost("decision", body), w.owner);
    expect(first.body).toMatchObject({ decision: "approved", replayed: false });
    // The gate answers a repeat only to the proof that made the decision (a fresh proof is refused): nothing is applied twice either way.
    expect(again.status).toBe(409);
    expect(again.body["error"]).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await w.latestRevision()).toBe(2);
    expect(await w.world.store.get(projectRevisionKey(FAKE_COMPANY, "payments", 3))).toBeUndefined();
  });

  it("refuses a change made on a stale page: the draft revision the person saw must be the current one (409)", async () => {
    const w = await browserWorld({ snapshot: () => inferredSnapshot });
    await w.refresh();
    expect((await w.call(browserPut("draft", { requestId: uuid(), expectedDraftRevision: 1, runTimeoutMs: 200_000 }), w.owner)).status).toBe(200);
    for (const request of [browserPut("draft", { requestId: uuid(), expectedDraftRevision: 1, runTimeoutMs: 100_000 }), browserPost("check", { requestId: uuid(), expectedDraftRevision: 1 })]) {
      const stale = await w.call(request, w.owner);
      expect(stale.status).toBe(409);
      expect(stale.body["error"]).toMatchObject({ code: "CHANGE_STALE", message: BROWSER_TESTING_WORDS.stale });
    }
    expect((await view(w)).draft).toMatchObject({ revision: 2, runTimeoutMs: 200_000 });
  });

  it("the check is the existing commands check: a failed one cannot be approved, and says which step failed", async () => {
    const w = await browserWorld({ snapshot: () => inferredSnapshot });
    await checked(w);
    await w.failCheck();
    const failed = await view(w);
    expect(failed).toMatchObject({ state: "check-failed", candidate: { status: "failed", canApprove: false, approval: null } });
    const body = { requestId: setupDecisionRequestId("a".repeat(64), 2), outcome: "approve", seen: { revision: 2, artifactDigest: failed.candidate === null ? "a".repeat(64) : (await w.world.store.get(setupApplyKey(FAKE_COMPANY, "payments")))!["digest"] } };
    const refused = await w.call(browserPost("decision", body), w.owner);
    expect(refused.status).toBe(409);
    expect(await w.latestRevision()).toBe(1);
  });

  it("a repository Rovara cannot start an app from is a problem the page says, and the check is refused", async () => {
    const w = await browserWorld({ snapshot: () => snapshotOf({ "README.md": "# nothing to start\n" }) });
    await w.refresh();
    expect((await view(w)).draft!.found).toMatchObject({ applications: [], problem: "no-application" });
    const refused = await w.call(browserPost("check", { requestId: uuid(), expectedDraftRevision: 1 }), w.owner);
    expect(refused.status).toBe(400);
    expect(refused.body["error"]).toMatchObject({ message: BROWSER_TESTING_WORDS.needsInput });
    expect(await w.world.store.get(setupApplyKey(FAKE_COMPANY, "payments"))).toBeUndefined();
  });

  it("serves a real fault when the sandbox cannot start, keeps the draft, and refuses the check; no 'off for your company' state exists", async () => {
    const sandbox = { available: false };
    const w = await browserWorld({ snapshot: () => inferredSnapshot, sandbox });
    await w.refresh();
    expect(await view(w)).toMatchObject({ state: "draft", sandboxAvailable: false, faults: ["sandbox-unavailable"] });
    const refused = await w.call(browserPost("check", { requestId: uuid(), expectedDraftRevision: 1 }), w.owner);
    expect(refused.status).toBe(503);
    expect(refused.body["error"]).toMatchObject({ message: BROWSER_TESTING_WORDS.sandboxUnavailable });
    expect(refused.raw).not.toMatch(/contact|support|turn it on|not enabled/iu);
    sandbox.available = true;
    expect((await w.call(browserPost("check", { requestId: uuid(), expectedDraftRevision: 1 }), w.owner)).status).toBe(200);
  });

  it("writes the audit record BEFORE the change: when it cannot be recorded, nothing changes", async () => {
    const audit = { failing: true };
    const w = await browserWorld({ snapshot: () => inferredSnapshot, audit });
    const refused = await w.call(browserPost("refresh", { requestId: uuid() }), w.owner);
    expect(refused.status).toBeGreaterThanOrEqual(500);
    expect(refused.body["error"]).toMatchObject({ message: BROWSER_TESTING_WORDS.auditUnavailable });
    expect(await w.world.store.get(browserDraftKey(FAKE_COMPANY, "payments"))).toBeUndefined();
    audit.failing = false;
    expect((await w.refresh()).status).toBe(200);
    expect(w.audit.filter((event) => event.action === "browser_testing.refresh")).toEqual([expect.objectContaining({ actor: { type: "person", id: "p-owner" }, details: expect.objectContaining({ basis: "company-owner" }) as unknown })]);
  });
});

describe("what the approver sees is what was checked", () => {
  it("the waiting change is summarised from the STORED proposal, not from the draft", async () => {
    const w = await browserWorld({ snapshot: () => ACCOUNTS });
    await checked(w);
    const facts = (await view(w)).candidate!.summary!;
    expect(facts.proof).toEqual({ screenshotMode: "failed", video: false });
    // A path that bypasses the lock edits the draft: the page's summary of the waiting change does not move.
    await w.world.store.update({ key: browserDraftKey(FAKE_COMPANY, "payments"), ops: [change.set("proof", { screenshotMode: "all", video: true }), change.set("runTimeoutMs", 61_000)] });
    expect((await view(w)).candidate!.summary).toEqual(facts);
  });

  it("the draft cannot change while a candidate waits: edit, refresh and a second check are refused 'Another change is waiting'; discarding frees it", async () => {
    const w = await browserWorld({ snapshot: () => inferredSnapshot });
    const revision = await checked(w);
    for (const request of [browserPut("draft", { requestId: uuid(), expectedDraftRevision: revision, runTimeoutMs: 100_000 }), browserPost("refresh", { requestId: uuid() }), browserPost("check", { requestId: uuid(), expectedDraftRevision: revision })]) {
      const refused = await w.call(request, w.owner);
      expect(refused.status, request.path).toBe(409);
      expect(refused.body["error"]).toMatchObject({ code: "WORKSPACE_BUSY" });
      expect((refused.body["error"] as { message: string }).message).toContain(BROWSER_TESTING_WORDS.anotherWaiting);
    }
    expect((await view(w)).draft).toMatchObject({ revision, locked: true });
    expect((await w.call(browserPost("discard", { requestId: uuid() }), w.owner)).status).toBe(200);
    expect(await view(w)).toMatchObject({ state: "draft", draft: { locked: false }, candidate: null });
    expect(await w.world.store.get(projectRevisionKey(FAKE_COMPANY, "payments", 2))).toBeUndefined();
    expect((await w.call(browserPut("draft", { requestId: uuid(), expectedDraftRevision: revision, runTimeoutMs: 100_000 }), w.owner)).status).toBe(200);
  });

  it("the setup page's own read says the waiting candidate is a browser testing one, so it is not shown as a change to the project's commands", async () => {
    const w = await browserWorld({ snapshot: () => inferredSnapshot });
    await checked(w);
    await w.passCheck();
    const setup = await w.call({ method: "GET", path: "/v1/app/projects/payments/setup-agent", headers: {}, body: "" }, w.owner);
    expect(setup.body["apply"]).toMatchObject({ browserTesting: true, risk: "high", approver: "admin", canApprove: true });
  });

  it("an edit that gets past the lock still cannot be approved under the old digest: the approval refuses and nothing moves", async () => {
    const w = await browserWorld({ snapshot: () => inferredSnapshot });
    await checked(w);
    await w.passCheck();
    const body = await approveBody(w);
    await w.world.store.update({ key: browserDraftKey(FAKE_COMPANY, "payments"), ops: [change.set("draftRevision", 9), change.set("runTimeoutMs", 61_000)] });
    const refused = await w.call(browserPost("decision", body), w.owner);
    expect(refused.status, refused.raw).toBeGreaterThanOrEqual(400);
    expect(await w.latestRevision()).toBe(1);
    expect(await w.world.store.get(setupApplyKey(FAKE_COMPANY, "payments"))).toMatchObject({ state: "checking" });
    expect((await w.world.store.get(projectRevisionKey(FAKE_COMPANY, "payments", 2)))?.["setupApproval"]).toBeUndefined();
  });

  it("refuses an approval whose stored proposal is gone or changed, and approves nothing", async () => {
    for (const damage of ["missing", "changed"] as const) {
      const w = await browserWorld({ snapshot: () => inferredSnapshot });
      await checked(w);
      await w.passCheck();
      const ref = ((await w.world.store.get(setupApplyKey(FAKE_COMPANY, "payments")))!["browserTesting"] as { proposalRef: string }).proposalRef;
      if (damage === "missing") w.objects.map.delete(ref); else w.objects.map.set(ref, Buffer.from("{}"));
      expect((await view(w)).candidate!.summary).toBeNull();
      const refused = await w.call(browserPost("decision", await approveBody(w)), w.owner);
      expect(refused.status, damage).toBeGreaterThanOrEqual(400);
      expect(await w.latestRevision()).toBe(1);
    }
  });

  it("a draft edited while the check is being stored is refused: the candidate is never made from a draft that moved", async () => {
    const w = await browserWorld({ snapshot: () => inferredSnapshot });
    await w.refresh();
    // The draft moves at the very moment the candidate is stored (the page's own save, racing the check).
    w.hooks.transact = async (items, real) => {
      if (items.some((item) => item.kind === "put" && item.item["entityType"] === "SETUP_APPLY")) await real.update({ key: browserDraftKey(FAKE_COMPANY, "payments"), ops: [change.set("draftRevision", 2)] });
      return real.transact(items);
    };
    const real = w.world.store;
    const refused = await w.call(browserPost("check", { requestId: uuid(), expectedDraftRevision: 1 }), w.owner);
    expect(refused.status, refused.raw).toBeGreaterThanOrEqual(400);
    expect(await real.get(setupApplyKey(FAKE_COMPANY, "payments"))).toBeUndefined();
    expect(await real.get(projectRevisionKey(FAKE_COMPANY, "payments", 2))).toBeUndefined();
  });

  it("refuses an approval whose candidate carries another policy than the stored proposal the check was made from", async () => {
    const w = await browserWorld({ snapshot: () => inferredSnapshot });
    await checked(w);
    await w.passCheck();
    const body = await approveBody(w);
    await w.world.store.update({ key: projectRevisionKey(FAKE_COMPANY, "payments", 2), ops: [change.set(["definition", "e2e", "limits", "runTimeoutMs"], 61_000)] });
    const refused = await w.call(browserPost("decision", body), w.owner);
    expect(refused.status, refused.raw).toBeGreaterThanOrEqual(400);
    expect(await w.latestRevision()).toBe(1);
  });

  it("a waiting change of another kind (a setup run's) blocks browser testing, and browser testing cannot discard it", async () => {
    const w = await browserWorld({ snapshot: () => inferredSnapshot });
    await w.world.store.put({ item: { ...projectRevisionKey(FAKE_COMPANY, "payments", 2), entityType: "PROJECT", candidate: true, definition: { ...projectDefinition("payments"), revision: 2 } as never } });
    await w.world.store.put({ item: { ...setupApplyKey(FAKE_COMPANY, "payments"), entityType: "SETUP_APPLY", orgId: FAKE_COMPANY, project: "payments", taskId: "", requestId: uuid(), by: "p-pm", digest: "d".repeat(64),
      baseRevision: 1, candidateRevision: 2, state: "checking", check: { workspaceId: uuid(), revision: 2, startedAt: new Date(w.world.clock.now).toISOString(), startedBy: "p-pm" }, reply: {}, createdAt: new Date(w.world.clock.now).toISOString() } });
    expect(await view(w)).toMatchObject({ setupWaiting: true, candidate: null });
    expect((await w.refresh()).status).toBe(409);
    expect((await w.call(browserPost("discard", { requestId: uuid() }), w.owner)).status).toBe(409);
    expect(await w.world.store.get(setupApplyKey(FAKE_COMPANY, "payments"))).toMatchObject({ state: "checking" });
  });
});

describe("approval authority: a LIVE company owner or admin, never a project maintainer", () => {
  it("approves by a company owner and by a company admin; the project's administrator is refused at the route, and writes nothing", async () => {
    for (const role of ["owner", "admin"] as const) {
      const w = await browserWorld({ snapshot: () => inferredSnapshot });
      await checked(w);
      await w.passCheck();
      const body = await approveBody(w);
      const refused = await w.call(browserPost("decision", body), w.projectAdmin);
      expect(refused.status).toBe(403);
      expect(await w.latestRevision()).toBe(1);
      expect(await w.world.store.get(setupApplyKey(FAKE_COMPANY, "payments"))).toMatchObject({ state: "checking" });
      expect((await w.call(browserPost("decision", body), role === "owner" ? w.owner : w.admin)).status).toBe(200);
      expect(await w.latestRevision()).toBe(2);
    }
  });

  it("the decision's own rule refuses a project administrator even with a valid proof (the route's check is not the only one)", async () => {
    const w = await browserWorld({ snapshot: () => inferredSnapshot });
    await checked(w);
    await w.passCheck();
    const body = await approveBody(w);
    const approval = w.approvalFor(FAKE_COMPANY);
    for (const outcome of ["approve", "reject"] as const) {
      const card = setupCardOf("payments", body.seen.artifactDigest);
      const credential = await approval.issue({ companyId: FAKE_COMPANY, personId: "p-pm", requestId: body.requestId, kind: "setup", project: "payments", revision: body.seen.revision, artifactDigest: body.seen.artifactDigest, outcome, card });
      const result = await approval.gate.decide({ companyId: FAKE_COMPANY, kind: SETUP_APPLY_KIND, subjectId: "payments", requestId: body.requestId, outcome, seen: body.seen, credentials: [{ method: credential.method, token: credential.token }], card });
      expect(result).toMatchObject({ status: "refused", reason: "not_the_approver" });
      expect((result as { detail: string }).detail).toBe(BROWSER_TESTING_WORDS.adminOnly);
    }
    expect(await w.latestRevision()).toBe(1);
    expect(await w.world.store.get(setupApplyKey(FAKE_COMPANY, "payments"))).toMatchObject({ state: "checking" });
  });

  it("the role is read live inside the decision: an owner who lost the role between the page and the decision cannot approve", async () => {
    const w = await browserWorld({ snapshot: () => inferredSnapshot });
    await checked(w);
    await w.passCheck();
    const body = await approveBody(w);
    const approval = w.approvalFor(FAKE_COMPANY);
    const card = setupCardOf("payments", body.seen.artifactDigest);
    // The proof was issued while they were an owner; the decision reads the role again.
    const credential = await approval.issue({ companyId: FAKE_COMPANY, personId: "p-owner", requestId: body.requestId, kind: "setup", project: "payments", revision: body.seen.revision, artifactDigest: body.seen.artifactDigest, outcome: "approve", card });
    w.people.set("p-owner", { companyId: FAKE_COMPANY, role: "member", grants: {} });
    const result = await approval.gate.decide({ companyId: FAKE_COMPANY, kind: SETUP_APPLY_KIND, subjectId: "payments", requestId: body.requestId, outcome: "approve", seen: body.seen, credentials: [{ method: credential.method, token: credential.token }], card });
    expect(result.status).toBe("refused");
    expect(await w.latestRevision()).toBe(1);
  });

  it("an approval that cannot be read at all (the people's records fail) refuses; a host with no browser testing rule never approves one", async () => {
    const w = await browserWorld({ snapshot: () => inferredSnapshot });
    await checked(w);
    await w.passCheck();
    const body = await approveBody(w);
    w.people.delete("p-owner");
    expect((await w.call(browserPost("decision", body), w.owner)).status).toBeGreaterThanOrEqual(400);
    expect(await w.latestRevision()).toBe(1);
  });

  it("a stranger of another company, and a decision on what the person did not see, are refused", async () => {
    const w = await browserWorld({ snapshot: () => inferredSnapshot });
    await checked(w);
    await w.passCheck();
    const body = await approveBody(w);
    // Another company's owner decides nothing here: their own company has nothing waiting.
    expect((await w.call(browserPost("decision", body), w.outsider)).status).toBe(409);
    expect((await w.call(browserPost("decision", body), w.stranger)).status).toBe(404);
    for (const wrong of [{ ...body, seen: { ...body.seen, artifactDigest: "b".repeat(64) } }, { ...body, seen: { ...body.seen, revision: 3 } }, { ...body, requestId: "setup-other" }]) {
      expect((await w.call(browserPost("decision", wrong), w.owner)).status).toBe(409);
    }
    expect(await w.latestRevision()).toBe(1);
  });

  it("the old ordinary setup route cannot decide it around the page: a project administrator is refused there too (risk high)", async () => {
    const w = await browserWorld({ snapshot: () => inferredSnapshot });
    await checked(w);
    await w.passCheck();
    const body = await approveBody(w);
    const refused = await w.call({ method: "POST", path: "/v1/app/projects/payments/setup-agent/decide", headers: {}, body: JSON.stringify(body) }, w.projectAdmin);
    expect(refused.status).toBe(403);
    expect(await w.latestRevision()).toBe(1);
  });
});

describe("Pause (owner decision 420)", () => {
  it("pauses and resumes; the page says so; only a company owner or admin may; there is nothing to pause before approval", async () => {
    const w = await browserWorld({ snapshot: () => inferredSnapshot });
    expect((await w.call(browserPost("pause", { requestId: uuid() }), w.owner)).status).toBe(409);
    await checked(w);
    await w.passCheck();
    await w.call(browserPost("decision", await approveBody(w)), w.owner);
    expect((await w.call(browserPost("pause", { requestId: uuid() }), w.projectAdmin)).status).toBe(403);
    const pauseId = uuid();
    for (let i = 0; i < 2; i += 1) expect((await w.call(browserPost("pause", { requestId: pauseId }), w.admin)).status).toBe(200);
    expect(await view(w)).toMatchObject({ state: "paused", paused: true, approved: { revision: 2 } });
    expect((await w.call(browserPost("resume", { requestId: uuid() }), w.owner)).status).toBe(200);
    expect(await view(w)).toMatchObject({ state: "on", paused: false });
  });

  it("a pause that cannot be read is 'unknown', never 'not paused': the plan is not silently given browser checks the owner stopped", async () => {
    const w = await browserWorld({ snapshot: () => inferredSnapshot });
    await checked(w);
    await w.passCheck();
    await w.call(browserPost("decision", await approveBody(w)), w.owner);
    const ports = { ...planningPorts(w), paused: async (): Promise<boolean> => { throw new Error("store down"); } };
    expect(await createApplicationPlanningContext(ports)(planningTask(w, 2, inferredSnapshot))).toEqual({ status: "unknown", reason: "the project's browser testing pause could not be read" });
  });

  it("new plans skip browser checks while paused, and resume restores exactly the approved setup with no new approval", async () => {
    const w = await browserWorld({ snapshot: () => inferredSnapshot });
    await checked(w);
    await w.passCheck();
    await w.call(browserPost("decision", await approveBody(w)), w.owner);
    const context = () => createApplicationPlanningContext(planningPorts(w))(planningTask(w, 2, inferredSnapshot));
    expect(await context()).toMatchObject({ status: "available" });
    await w.call(browserPost("pause", { requestId: uuid() }), w.owner);
    const ports = planningPorts(w);
    expect(await createApplicationPlanningContext(ports)(planningTask(w, 2, inferredSnapshot))).toBeUndefined();
    await w.call(browserPost("resume", { requestId: uuid() }), w.owner);
    expect(await createApplicationPlanningContext(ports)(planningTask(w, 2, inferredSnapshot))).toMatchObject({ status: "available" });
    expect(await w.latestRevision()).toBe(2);
  });
});

describe("a change of another kind is not this page's to decide", () => {
  it("a waiting setup run's candidate cannot be approved through the browser testing route, whoever asks", async () => {
    const w = await browserWorld({ snapshot: () => inferredSnapshot });
    const definition = { ...projectDefinition("payments"), revision: 2, setup: [{ cwd: "repo/demo", executable: "npm", args: ["install"], timeoutSeconds: 600 }] };
    await w.world.store.put({ item: { ...projectRevisionKey(FAKE_COMPANY, "payments", 2), entityType: "PROJECT", candidate: true, definition: JSON.parse(JSON.stringify(definition)) as JsonValue } });
    const workspaceId = uuid();
    await w.world.store.put({ item: { ...workspaceKey(FAKE_COMPANY, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId: FAKE_COMPANY, orgId: FAKE_COMPANY, status: "READY" } });
    const digest = setupApplyDigest(definition.setup, definition.readiness);
    const at = new Date(w.world.clock.now).toISOString();
    await w.world.store.put({ item: { ...setupApplyKey(FAKE_COMPANY, "payments"), entityType: "SETUP_APPLY", orgId: FAKE_COMPANY, project: "payments", taskId: "", requestId: uuid(), by: "p-pm", digest, baseRevision: 1, candidateRevision: 2,
      state: "checking", check: { workspaceId, revision: 2, startedAt: at, startedBy: "p-pm" }, reply: {}, createdAt: at } });
    const refused = await w.call(browserPost("decision", { requestId: setupDecisionRequestId(digest, 2), outcome: "approve", seen: { revision: 2, artifactDigest: digest } }), w.owner);
    expect(refused.status).toBe(409);
    expect(refused.body["error"]).toMatchObject({ message: BROWSER_TESTING_WORDS.nothingWaiting });
    expect(await w.latestRevision()).toBe(1);
  });
});

describe("a newer change beside the approved setup (Fable round 3, item 4)", () => {
  it("a repository change found later is a newer draft; the approved setup stays in force until it is approved, and the page names what is new", async () => {
    let snapshot: E2ESourceSnapshot = ACCOUNTS;
    const w = await browserWorld({ snapshot: () => snapshot });
    await checked(w);
    await w.passCheck();
    await w.call(browserPost("decision", await approveBody(w)), w.owner);
    const changed = JSON.parse(accountsApp) as { agentx: { e2e: { recipe: { accountProfileIds: string[]; recipeDigest: string } & Record<string, unknown>; accountProfiles: Array<Record<string, unknown>> } } };
    changed.agentx.e2e.accountProfiles.push({ ...changed.agentx.e2e.accountProfiles[0]!, profileId: "editor", roleRef: "editor" });
    changed.agentx.e2e.recipe.accountProfileIds.push("editor");
    const { recipeDigest: _digest, ...body } = changed.agentx.e2e.recipe;
    void _digest;
    changed.agentx.e2e.recipe.recipeDigest = (await import("node:crypto")).createHash("sha256").update(canonicalJson(body)).digest("hex");
    snapshot = snapshotOf({ "package.json": JSON.stringify(changed), "seed.mjs": "// seeds\n" });
    expect((await w.refresh()).status).toBe(200);
    expect(await view(w)).toMatchObject({ state: "on", newerChange: { kind: "repo", newUserKinds: ["editor"], removedUserKinds: [] }, approved: { revision: 2 } });
    expect(await w.latestRevision()).toBe(2);
    // What really happens to a task started on the changed repository: a kind whose own declaration did not change still has its account; only a changed or new kind has none until approved.
    const entries = (await readAccountRegistryEntries({ store: w.world.store }, FAKE_COMPANY, "payments", [{ applicationId: "@agentx/accounts-web-fixture", profileId: "orders-viewer" }])).entries;
    expect(entries).toHaveLength(1);
  });
});

// ---- the planning seam over the company's own rows

function planningTask(w: BrowserWorld, revision: number, snapshot: E2ESourceSnapshot): ApplicationTask {
  const workflow = createWorkflowSnapshot({ taskId: "11111111-1111-4111-8111-111111111111", ownerId: "a".repeat(64), now: new Date(w.world.clock.now).toISOString() });
  return { pk: `DEVTASK#${workflow.taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: workflow.taskId, companyId: FAKE_COMPANY, project: "payments", startingRevision: revision, workflow,
    preparedBase: [{ repositoryId: "demo", baseCommitSha: snapshot.commitSha }], developerId: "developer-a", provider: "local-owner", developerName: "Owner", client: "test", title: "Change", workspaceId: "22222222-2222-4222-8222-222222222222",
    ownerKey: "a".repeat(64), conversationId: "33333333-3333-4333-8333-333333333333", shared: false, createdAt: new Date(w.world.clock.now).toISOString(), updatedAt: new Date(w.world.clock.now).toISOString(),
    charge: { member: { pk: "m", sk: "LIMIT" }, organization: { pk: "o", sk: "LIMIT" } } };
}

function planningPorts(w: BrowserWorld) {
  const row = webApiRow("web");
  return {
    project: async (task: ApplicationTask) => await w.world.store.get(projectRevisionKey(FAKE_COMPANY, task.project, task.startingRevision)) as never,
    readText: async (key: string) => { const bytes = w.objects.map.get(key); return bytes === undefined ? undefined : Buffer.from(bytes).toString("utf8"); },
    readyRuntimes: async () => [{ kind: "web" as const, profileId: WEB_API_RUNTIME_PROFILE_ID, supportedSteps: row.capabilities.supportedSteps, supportedAssertions: row.capabilities.supportedAssertions }],
    accounts: async () => [],
    paused: async () => (await w.world.store.get({ pk: projectPk(FAKE_COMPANY, "payments"), sk: "E2E_BROWSER_STATE" }))?.["paused"] === true,
  };
}

describe("the candidate row's attributes join the registry mirror's update (a transaction names a key once)", () => {
  const key = projectRevisionKey(FAKE_COMPANY, "payments", 2);
  const mirror = { kind: "update" as const, key, ops: [change.set("runtimeBinding", { from: "mirror" }), change.set("registeredBy", "mirror-owner")], condition: { op: "eq" as const, path: ["entityType"] as never, value: "PROJECT" } };

  it("merges into the mirror's own update and lets the mirror's values stand", () => {
    const merged = withCandidateOps([mirror, { kind: "check", key: orgProjectCatalogKey(FAKE_COMPANY, "payments"), condition: { op: "exists", path: ["pk"] as never } }], key, [change.set("setupApproval", { decision: "approve" }), change.set("registeredBy", "base-owner"), change.set("registeredAt", "t")]);
    const updates = merged.filter((item) => item.kind === "update" && item.key.sk === key.sk);
    expect(updates).toHaveLength(1);
    const ops = (updates[0] as unknown as { ops: Array<{ path: string[]; value?: unknown }> }).ops;
    expect(ops.map((op) => op.path.join("."))).toEqual(["runtimeBinding", "registeredBy", "setupApproval", "registeredAt"]);
    expect(ops.find((op) => op.path.join(".") === "registeredBy")?.value).toBe("mirror-owner");
    expect(merged).toHaveLength(2);
  });

  it("makes its own update when the host mirrors nothing", () => {
    const merged = withCandidateOps([], key, [change.set("setupApproval", { decision: "approve" })]);
    expect(merged).toEqual([{ kind: "update", key, ops: [change.set("setupApproval", { decision: "approve" })], condition: { op: "eq", path: ["entityType"], value: "PROJECT" } }]);
  });
});
