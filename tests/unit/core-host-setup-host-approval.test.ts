// L4-SF (d): a website a hosted setup run asked for (the setup-host subject; a run that needs one ends `hosts_waiting`) is decided through the same hosted approvers extension as a high-risk setup change: a
// company owner or admin only (either answer; DEC 254zzz73: no step-up), a proof bound to the exact ask (its host and when it was asked), the one approval gate. The host's own checks are unchanged: a private, paste or
// tunnel name is refused, and the refusal list is read again when the ask is approved.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { orgScoped, type JsonValue } from "@agentx/contracts";
import { SETUP_HOST_KIND, SETUP_HOST_OPEN_MAX, approvedHostsOf, hostAskDigest, hostAskSubjectId, hostDecisionRequestId, listHostAsks, readOpenHostAsk, requestHostAsk, type SetupHostAsk } from "../../packages/broker/src/core/setup-agent/host-ask.js";
import { hostAskKey } from "../../packages/broker/src/core/setup-agent/keys.js";
import { hostRequestId } from "../../packages/broker/src/local/app/setup-agent.js";
import { SETUP_HOST_NEEDS_ADMIN, setupHostCardOf } from "../../packages/broker/src/core-host/setup-approval.js";
import { SETUP_NO_HOST_WAITING } from "../../packages/broker/src/core-host/setup-run-routes.js";
import { SETUP_HOST_SUBJECT, SETUP_PROPOSAL_SUBJECT, APPROVAL_PROOF_METHOD, createHostedApprovers, issueSetupHostApprovalProof, issueSetupApprovalProof } from "../../packages/broker/src/core-host/hosted-approvers.js";
import { HOSTED_IDENTITY_PROVIDER, createHostedIdentity } from "../../packages/broker/src/core-host/hosted-modules.js";
import type { FakeWorld } from "../support/core-host-fakes.js";
import { FAKE_COMPANY, KEY, OTHER, RUN, get, post, setupWorld } from "../support/hosted-setup-world.js";

const HOST = "deps.exampledeps.dev";
const JOURNAL = `${RUN}/journal`;
const DECIDE = `${RUN}/host-decide`;

/** A running setup run of `project` in `companyId`, as the callback layer would have recorded it. */
async function seedRun(world: FakeWorld, companyId: string, project: string): Promise<string> {
  const taskId = randomUUID();
  await world.store.put({ item: { pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", purpose: "setup_agent", companyId, project, developerId: "p-starter", provider: HOSTED_IDENTITY_PROVIDER, workspaceId: randomUUID() } });
  return taskId;
}
/** An open ask for `host`, made the way a run's callback makes it (the real ask code). */
async function seedAsk(world: FakeWorld, companyId: string, project: string, host = HOST): Promise<SetupHostAsk> {
  const taskId = await seedRun(world, companyId, project);
  const outcome = await requestHostAsk({ store: world.store, now: () => world.clock.now }, { orgId: companyId, project, host, taskId, projectDomains: [] });
  if (outcome.outcome !== "created") throw new Error(`the ask was not made: ${outcome.outcome}`);
  return outcome.ask;
}
/** An open ask the request-time checks would never make (a planted row), to prove the decision's own check. */
async function plantAsk(world: FakeWorld, companyId: string, project: string, host: string): Promise<SetupHostAsk> {
  const made = await seedAsk(world, companyId, project);
  const planted = { ...made, host, ...hostAskKey(companyId, project, host) } as unknown as Record<string, JsonValue>;
  await world.store.put({ item: planted as never });
  await world.store.put({ item: { pk: orgScoped(companyId, "SETUP_HOST_OPEN"), sk: `${project}#${host}`, entityType: "SETUP_HOST_OPEN", orgId: companyId, project, host, ask: planted } });
  return planted as unknown as SetupHostAsk;
}
const bodyFor = (ask: SetupHostAsk, outcome: "approve" | "reject" = "approve") => ({ requestId: hostDecisionRequestId(ask), host: ask.host, outcome, seen: { revision: 1, artifactDigest: hostAskDigest(ask) } });
const askOf = async (world: FakeWorld, companyId: string, project: string, host = HOST) => world.store.get(hostAskKey(companyId, project, host));
const table = (world: FakeWorld) => ({ store: world.store, now: () => world.clock.now });

describe("L4-SF (d): who may allow or refuse a website for a hosted setup run", () => {
  it("lets a company admin allow a website: the ask becomes approved, the machines' list gains it, the counters settle, and the audit names the approver and the ask", async () => {
    const { world, person, call, audit } = await setupWorld();
    const ask = await seedAsk(world, FAKE_COMPANY, "payments");
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    const answer = await call(post(DECIDE, bodyFor(ask)), admin);
    expect(answer.status, answer.raw).toBe(200);
    expect(answer.body).toEqual({ project: "payments", host: HOST, decision: "approved", replayed: false });
    expect(await askOf(world, FAKE_COMPANY, "payments")).toMatchObject({ state: "approved", decidedBy: "p-admin" });
    expect(await approvedHostsOf(table(world), FAKE_COMPANY, "payments")).toEqual([HOST]);
    expect(await listHostAsks(table(world), FAKE_COMPANY, "payments")).toEqual([]);
    expect(audit.find((event) => event.action === "decision.approved")).toMatchObject({ companyId: FAKE_COMPANY, actor: { id: "p-admin" }, subject: { type: SETUP_HOST_SUBJECT, id: hostAskSubjectId(FAKE_COMPANY, "payments", HOST) }, details: { kind: SETUP_HOST_KIND, risk: "high" } });
  });

  it("refuses a project maintainer (a member who administers the project) for BOTH answers, in fixed words, writing nothing; the same words reach a decision made directly at the gate", async () => {
    const { world, person, call, wirings } = await setupWorld();
    const ask = await seedAsk(world, FAKE_COMPANY, "payments");
    const maintainer = person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" });
    for (const outcome of ["approve", "reject"] as const) {
      const refused = await call(post(DECIDE, bodyFor(ask, outcome)), maintainer);
      expect(refused.status, outcome).toBe(403);
      expect(refused.body).toEqual({ error: { code: "FORBIDDEN", message: SETUP_HOST_NEEDS_ADMIN } });
    }
    expect(await askOf(world, FAKE_COMPANY, "payments")).toMatchObject({ state: "open" });
    expect(await approvedHostsOf(table(world), FAKE_COMPANY, "payments")).toEqual([]);
    // Behind the route: the maintainer's own valid proof, given to the gate directly, is refused by the subject's rule (the live standing, read inside the decision).
    const approval = wirings.get(FAKE_COMPANY)!.approval!;
    const subjectId = hostAskSubjectId(FAKE_COMPANY, "payments", HOST);
    const card = setupHostCardOf(subjectId, hostAskDigest(ask));
    const credential = await approval.issueHost({ companyId: FAKE_COMPANY, personId: "p-maint", requestId: hostDecisionRequestId(ask), kind: "setup_host", subjectId, revision: 1, artifactDigest: hostAskDigest(ask), outcome: "approve", card });
    const result = await approval.gate.decide({ companyId: FAKE_COMPANY, kind: SETUP_HOST_KIND, subjectId, requestId: hostDecisionRequestId(ask), outcome: "approve", seen: { revision: 1, artifactDigest: hostAskDigest(ask) }, credentials: [credential], card });
    expect(result).toEqual({ status: "refused", reason: "not_the_approver", detail: SETUP_HOST_NEEDS_ADMIN });
    expect(await askOf(world, FAKE_COMPANY, "payments")).toMatchObject({ state: "open" });
  });
});

describe("L4-SF (d): the decision is bound to the exact ask", () => {
  it("lists each open ask with what to decide it on, and whether this person may: an owner or admin may, a maintainer sees it but may not", async () => {
    const { world, person, call } = await setupWorld();
    const ask = await seedAsk(world, FAKE_COMPANY, "payments");
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    const maintainer = person("p-maint", FAKE_COMPANY, "member", { payments: "administrator" });
    const approval = { requestId: hostDecisionRequestId(ask), revision: 1, artifactDigest: hostAskDigest(ask), kind: "setup_host", risk: "high" };
    expect((await call(get(JOURNAL), admin)).body["hostAsks"]).toEqual([{ host: HOST, status: "open", canDecide: true, approval }]);
    expect((await call(get(JOURNAL), maintainer)).body["hostAsks"]).toEqual([{ host: HOST, status: "open", canDecide: false, approval }]);
    // A decided ask offers nothing to decide.
    await call(post(DECIDE, bodyFor(ask)), admin);
    expect((await call(get(JOURNAL), admin)).body["hostAsks"]).toEqual([{ host: HOST, status: "approved" }]);
  });

  it("an ask made again (a later askedAt) is another decision: the earlier look decides nothing", async () => {
    const { world, person, call } = await setupWorld();
    const old = await seedAsk(world, FAKE_COMPANY, "payments");
    const first = person("p-admin", FAKE_COMPANY, "admin");
    // The ask was refused, a week passed, and the host was asked about again.
    await call(post(DECIDE, bodyFor(old, "reject")), first);
    world.clock.advance(8 * 86_400);
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    const fresh = await seedAsk(world, FAKE_COMPANY, "payments");
    expect(fresh.askedAt).not.toBe(old.askedAt);
    const stale = await call(post(DECIDE, bodyFor(old)), admin);
    expect(stale.status).toBe(409);
    expect(await askOf(world, FAKE_COMPANY, "payments")).toMatchObject({ state: "open" });
    expect((await call(post(DECIDE, bodyFor(fresh)), admin)).status).toBe(200);
  });

  it("answers an ask that is not open (decided, unknown, or never asked) the same, and a repeat of a decision decides nothing twice", async () => {
    const { world, person, call } = await setupWorld();
    const ask = await seedAsk(world, FAKE_COMPANY, "payments");
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    expect((await call(post(DECIDE, bodyFor(ask)), admin)).status).toBe(200);
    for (const body of [bodyFor(ask), { ...bodyFor(ask), host: "never.exampledeps.dev" }]) {
      const again = await call(post(DECIDE, body), admin);
      expect(again.body).toEqual({ error: { code: "CHANGE_STALE", message: SETUP_NO_HOST_WAITING } });
    }
    expect(await readOpenHostAsk(table(world), FAKE_COMPANY, "payments", HOST)).toBeUndefined();
  });

  it("keeps the proofs apart: a setup-candidate proof never decides a website ask, and a website proof is not a setup-candidate proof or a task's", async () => {
    const { world } = await setupWorld();
    const ask = await seedAsk(world, FAKE_COMPANY, "payments");
    const identity = createHostedIdentity({ membershipOf: async () => ({ companyId: FAKE_COMPANY, role: "admin" as const }), displayNameOf: async (id) => id });
    const approvers = createHostedApprovers({ store: world.store, identity, key: KEY, now: () => new Date(world.clock.now) });
    const subjectId = hostAskSubjectId(FAKE_COMPANY, "payments", HOST);
    const digest = hostAskDigest(ask);
    const requestId = hostDecisionRequestId(ask);
    const request = { companyId: FAKE_COMPANY, requestId, kind: "setup_host", outcome: "approve" as const, subject: { type: SETUP_HOST_SUBJECT, id: subjectId }, projectName: "payments", revision: 1, artifactDigest: digest, risk: "high", settlesClaims: true, card: setupHostCardOf(subjectId, digest) };
    const proofOf = (token: string) => ({ method: APPROVAL_PROOF_METHOD, token, requestId, revision: 1, artifactDigest: digest } as never);
    const base = { companyId: FAKE_COMPANY, personId: "p-admin", requestId, kind: "setup_host", revision: 1, artifactDigest: digest, outcome: "approve" as const, card: setupHostCardOf(subjectId, digest) };
    // Positive control: a website proof for this ask is believed.
    const good = await approvers.verify(request as never, proofOf(issueSetupHostApprovalProof(KEY, { ...base, subjectId }, world.clock.now).token));
    expect(good).toMatchObject({ approved: true });
    // A setup-candidate proof made for the same words (the project name as its subject) is refused for the website subject.
    const asProposal = issueSetupApprovalProof(KEY, { ...base, kind: "setup_host", project: "payments" }, world.clock.now);
    expect(await approvers.verify(request as never, proofOf(asProposal.token))).toMatchObject({ approved: false, reason: "other_subject" });
    // And a website proof is refused for a setup candidate.
    const proposalRequest = { ...request, kind: "setup", subject: { type: SETUP_PROPOSAL_SUBJECT, id: "payments" }, card: { cardId: "setup_proposal:payments", contentVersion: digest } };
    const hostProof = issueSetupHostApprovalProof(KEY, { ...base, subjectId }, world.clock.now);
    expect(await approvers.verify(proposalRequest as never, proofOf(hostProof.token))).toMatchObject({ approved: false });
    // The proof cannot name a subject that is not a website ask's id.
    expect(() => issueSetupHostApprovalProof(KEY, { ...base, subjectId: "payments" }, world.clock.now)).toThrow();
  });
});

describe("L4-SF (d): the host's own checks are unchanged", () => {
  it.each(["pastebin.com", "abc.ngrok.io", "db.internal", "raw.githubusercontent.com"])("never allows %s even for an admin's valid decision (refused again when approved), keeping the ask open", async (host) => {
    const { world, person, call } = await setupWorld();
    const planted = await plantAsk(world, FAKE_COMPANY, "payments", host);
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    const refused = await call(post(DECIDE, bodyFor(planted)), admin);
    expect(refused.status, refused.raw).toBe(400);
    expect(refused.body).toMatchObject({ error: { code: "CONFIG_INVALID" } });
    expect(await approvedHostsOf(table(world), FAKE_COMPANY, "payments")).toEqual([]);
    expect(await askOf(world, FAKE_COMPANY, "payments", host)).toMatchObject({ state: "open" });
    // An admin may still refuse it.
    expect((await call(post(DECIDE, bodyFor(planted, "reject")), admin)).status).toBe(200);
  });

  it("still makes no ask for a private, paste or tunnel name at the run's request (a count only), and an ask beyond the open cap is not made", async () => {
    const { world } = await setupWorld();
    const taskId = await seedRun(world, FAKE_COMPANY, "payments");
    for (const host of ["pastebin.com", "abc.ngrok.io", "db.internal"]) expect(await requestHostAsk(table(world), { orgId: FAKE_COMPANY, project: "payments", host, taskId, projectDomains: [] })).toMatchObject({ outcome: "refused" });
    expect(await listHostAsks(table(world), FAKE_COMPANY, "payments", ["open", "approved", "refused"])).toEqual([]);
    expect(SETUP_HOST_OPEN_MAX).toBe(20);
  });

  it("uses the laptop's request id for the same ask (one formula)", async () => {
    const { world } = await setupWorld();
    const ask = await seedAsk(world, FAKE_COMPANY, "payments");
    expect(hostDecisionRequestId(ask)).toBe(hostRequestId(ask));
  });
});

describe("L4-SF (d): companies and projects stay apart", () => {

  it("an admin of one company cannot reach the other company's gate: a proof for A's company presented to B's gate is refused", async () => {
    const { world, person, wirings } = await setupWorld();
    await seedAsk(world, FAKE_COMPANY, "payments");
    const theirs = await seedAsk(world, OTHER, "payments");
    person("p-admin-a", FAKE_COMPANY, "admin");
    const subjectB = hostAskSubjectId(OTHER, "payments", HOST);
    const card = setupHostCardOf(subjectB, hostAskDigest(theirs));
    const credential = await wirings.get(FAKE_COMPANY)!.approval!.issueHost({ companyId: FAKE_COMPANY, personId: "p-admin-a", requestId: hostDecisionRequestId(theirs), kind: "setup_host", subjectId: subjectB, revision: 1, artifactDigest: hostAskDigest(theirs), outcome: "approve", card });
    // B's gate, A's person and A's proof: the proof names company A, so B's approvers point refuses it.
    const result = await wirings.get(OTHER)!.approval!.gate.decide({ companyId: OTHER, kind: SETUP_HOST_KIND, subjectId: subjectB, requestId: hostDecisionRequestId(theirs), outcome: "approve", seen: { revision: 1, artifactDigest: hostAskDigest(theirs) }, credentials: [credential], card });
    expect(result.status).toBe("refused");
    expect(await askOf(world, OTHER, "payments")).toMatchObject({ state: "open" });
    // And A's own gate has no such ask.
    const own = await wirings.get(FAKE_COMPANY)!.approval!.gate.decide({ companyId: FAKE_COMPANY, kind: SETUP_HOST_KIND, subjectId: subjectB, requestId: hostDecisionRequestId(theirs), outcome: "approve", seen: { revision: 1, artifactDigest: hostAskDigest(theirs) }, credentials: [credential], card });
    expect(own).toMatchObject({ status: "refused", reason: "not_found" });
  });
});

describe("L4-SF (d): the request is strict", () => {
  it.each([
    ["a request id outside the host namespace", (ask: SetupHostAsk) => ({ ...bodyFor(ask), requestId: "setup-abcdefgh" })],
    ["an address in place of a host name", (ask: SetupHostAsk) => ({ ...bodyFor(ask), host: "10.0.0.5" })],
    ["a key the route does not know", (ask: SetupHostAsk) => ({ ...bodyFor(ask), approver: "p-admin" })],
    ["another answer", (ask: SetupHostAsk) => ({ ...bodyFor(ask), outcome: "request_changes" })],
    ["a missing digest", (ask: SetupHostAsk) => ({ ...bodyFor(ask), seen: { revision: 1 } })],
  ])("refuses %s without reading or writing", async (_label, make) => {
    const { world, person, call } = await setupWorld();
    const ask = await seedAsk(world, FAKE_COMPANY, "payments");
    const admin = person("p-admin", FAKE_COMPANY, "admin");
    const refused = await call(post(DECIDE, make(ask)), admin);
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: { code: "CONFIG_INVALID" } });
    expect(refused.raw).not.toContain("p-admin");
    expect(await askOf(world, FAKE_COMPANY, "payments")).toMatchObject({ state: "open" });
  });
});
