// Lane P3 (owner decisions 60 and 62): identity abilities (I1), one neutral outside account and an open sign-in method id (I2), any role name (I3), the sign-in time on approvals (A1), and the approvers plug-in naming its strong
// methods (A3). DEC 254zzz73 removed the company's own fresh sign-in setting (core/decisions/sign-in-setting.ts); the rule stays a port capability a plug-in may state. Approvals are authority, so each rule has a test that it does not WIDEN anything: a comment is never a rejection or a high-risk approval, a missing sign-in time fails closed.
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest's expect.* matchers are typed any */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AppMeResponseSchema, BUILT_IN_SIGN_IN_METHODS, DeveloperSummarySchema, ExternalAccountRefSchema, IMPLICIT_COMPANY_ID, KNOWN_ORG_ROLES, LinkedIdentitySchema, OrgRoleNameSchema, OrgRoleSchema, SignInMethodIdSchema, ownRoleEntry,
  actorOfExternalAccount, checkApprovalSignIn, createWorkflowSnapshot, externalAccountKey, externalAccountOfActor, externalAccountOfHostAccount, isKnownOrgRole, readExternalAccount,
  submitWorkflowArtifact,
  type ApprovalProof, type ApprovalRequest, type ApprovalRequirement, type ApprovalVerdict, type Approvers, type AuditSink, type IdentityProvider, type Principal, type WorkflowSnapshot,
} from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { CODE_HOST_COMMENT_METHOD, LOCAL_SESSION_METHOD, createLocalOwnerIdentity, createNoopAuditSink, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createDecisionGate, approvalRecordKey, type DecisionAttempt } from "../../packages/broker/src/core/decisions/approval-gate.js";
import { createWorkflowDocumentSubject, workflowTaskKey, waitingDocumentDigest } from "../../packages/broker/src/core/decisions/workflow-subject.js";
import { createIdentityMergePeople, soleOwnerPeople } from "../../packages/broker/src/core/merge/people.js";
import { mergeReadiness, prepareMerge } from "../../packages/broker/src/core/merge/index.js";
import { TASK_ID as MERGE_TASK, mergeWorld, pressAsOwner } from "../support/merge-world.js";

const COMPANY = IMPLICIT_COMPANY_ID;
const NOW = new Date("2026-11-10T12:00:00.000Z");
const TASK_ID = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const OWNER_HEX = "a".repeat(64);
const STEP_UP = "browser-step-up";
// Tokens are built at run time: nothing in this file looks like a key.
const TOKEN = ["step", "up", "proof", "for", "tests"].join("-");
const NO_SSO = { companySignIn: false };
const SSO = { companySignIn: true };
const iso = (secondsAgo: number): string => new Date(NOW.getTime() - secondsAgo * 1000).toISOString();

const person = (overrides: Partial<Principal> = {}): Principal => ({ companyId: COMPANY, personId: "maya", displayName: "Maya", roles: ["owner"], provider: "example-sso", ...overrides });

// ---- a plug-in with its own method names (a browser step-up), as Cloud's would be ----

interface PluginOptions {
  requirement?: Partial<ApprovalRequirement>;
  /** The sign-in time the plug-in reports for the person who proves with TOKEN (absent: it reports none). */
  authTime?: string | undefined;
}
function plugin(options: PluginOptions = {}): Approvers {
  return {
    requirement: async () => ({ methods: [STEP_UP, CODE_HOST_COMMENT_METHOD], minApprovers: 1, selfApprovalAllowed: true, ...options.requirement }),
    verify: async (_request: ApprovalRequest, proof: ApprovalProof): Promise<ApprovalVerdict> =>
      proof.token === TOKEN || proof.method === CODE_HOST_COMMENT_METHOD
        ? { approved: true, approver: person(options.authTime === undefined ? {} : { authTime: options.authTime }), method: proof.method, proofId: proof.proofId }
        : { approved: false, reason: "not_the_person" },
  };
}

const readinessFact = () => ({ repositoryId: "app", number: 7, headSha: "a".repeat(40), state: "open" as const, draft: false, baseBranch: "main", ci: "passing" as const, branch: "up_to_date" as const, behindRequired: false });
const identityWith = (companySignIn: boolean): Pick<IdentityProvider, "capabilities"> => ({ capabilities: { interactiveSignIn: true, externalAccounts: false, companySignIn } });

const planArtifact = (version: number, sha: string) => ({
  id: `plan-v${String(version)}`, type: "plan" as const, version, sha256: sha, producer: "agentx-planner",
  objectKey: `tasks/${TASK_ID}/plan-v${String(version)}.json`, createdAt: "2026-11-10T10:00:00.000Z", format: "structured" as const,
});
function waiting(): WorkflowSnapshot {
  const initial = createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER_HEX, now: "2026-11-10T09:59:00.000Z" });
  return submitWorkflowArtifact(initial, { expectedRevision: initial.revision, artifact: planArtifact(1, "b".repeat(64)), now: "2026-11-10T10:00:00.000Z" });
}
const R0 = waiting().revision;

function world(approvers: Approvers, options: { risk?: "low" | "medium" | "high"; policy?: Parameters<typeof createDecisionGate>[0]["policy"]; audit?: AuditSink; companySignIn?: boolean } = {}) {
  const store = new MemoryDocumentStore();
  const ready = store.put({ item: { ...workflowTaskKey(TASK_ID), entityType: "DEVELOPER_TASK", orgId: COMPANY, project: "web", workflow: JSON.parse(JSON.stringify(waiting())) } });
  const subject = createWorkflowDocumentSubject({ store, riskOf: () => options.risk ?? "high" });
  const gate = createDecisionGate({ store, approvers, audit: options.audit ?? createNoopAuditSink(), subjects: [subject], now: () => NOW, ...(options.policy === undefined ? {} : { policy: options.policy }), ...(options.companySignIn === undefined ? {} : { identity: identityWith(options.companySignIn) }) });
  return { store, gate, ready };
}
function attempt(overrides: Partial<DecisionAttempt> = {}): DecisionAttempt {
  const workflow = waiting();
  return {
    companyId: COMPANY, kind: "workflow-document", subjectId: TASK_ID, requestId: randomUUID(), outcome: "approve",
    seen: { revision: workflow.revision, artifactDigest: waitingDocumentDigest(workflow)! }, credentials: [{ method: STEP_UP, token: TOKEN }], ...overrides,
  };
}
const revisionOf = async (store: MemoryDocumentStore): Promise<number> => ((await store.get(workflowTaskKey(TASK_ID)))!["workflow"] as unknown as WorkflowSnapshot).revision;

describe("A3: the approvers plug-in names its strong methods", () => {

  it("a comment is never strong or a rejection, even when the plug-in names it (Code: reject and high-risk approve stay session-only)", async () => {
    const asked = plugin({ requirement: { strongMethods: [STEP_UP, CODE_HOST_COMMENT_METHOD], rejectMethods: [STEP_UP, CODE_HOST_COMMENT_METHOD] } });
    const high = world(asked);
    await high.ready;
    expect(await high.gate.decide(attempt({ credentials: [{ method: CODE_HOST_COMMENT_METHOD, token: "comment-1" }] }))).toMatchObject({ reason: "method_not_allowed" });
    const reject = world(asked, { risk: "low" });
    await reject.ready;
    expect(await reject.gate.decide(attempt({ outcome: "reject", credentials: [{ method: CODE_HOST_COMMENT_METHOD, token: "comment-1" }] }))).toMatchObject({ reason: "method_not_allowed" });
    expect(await revisionOf(reject.store)).toBe(R0);
    // The session method still rejects.
    expect(await reject.gate.decide(attempt({ outcome: "reject", reason: "No." }))).toMatchObject({ status: "decided" });
  });

  it("a policy that can only lock the gate out is refused when the gate is built (comment methods only) or at startup (disjoint from the plug-in) (review N2)", async () => {
    const build = (policy: NonNullable<Parameters<typeof createDecisionGate>[0]["policy"]>, approvers: Approvers = plugin()) =>
      createDecisionGate({ store: new MemoryDocumentStore(), approvers, audit: createNoopAuditSink(), subjects: [], policy });
    expect(() => build({ highRiskMethods: [CODE_HOST_COMMENT_METHOD] })).toThrow(/highRiskMethods names only comment methods/);
    expect(() => build({ rejectMethods: ["code-host-comment", "code-host-button"] })).toThrow(/rejectMethods names only comment methods/);
    expect(() => build({ highRiskMethods: [LOCAL_SESSION_METHOD, CODE_HOST_COMMENT_METHOD] })).not.toThrow();
    expect(() => build({ highRiskMethods: [] })).not.toThrow();
    // Disjoint from what the plug-in names: found by the startup check, before the first decision.
    const named = plugin({ requirement: { strongMethods: [STEP_UP], rejectMethods: [STEP_UP] } });
    await expect(build({ highRiskMethods: [LOCAL_SESSION_METHOD] }, named).verifyPolicy(COMPANY)).rejects.toThrow(/highRiskMethods.*always be refused/);
    await expect(build({ highRiskMethods: [STEP_UP], rejectMethods: [LOCAL_SESSION_METHOD] }, named).verifyPolicy(COMPANY)).rejects.toThrow(/rejectMethods/);
    await expect(build({ highRiskMethods: [STEP_UP, LOCAL_SESSION_METHOD], rejectMethods: [STEP_UP] }, named).verifyPolicy(COMPANY)).resolves.toBeUndefined();
    // With no named set, a policy outside the default is found too.
    const offersSession = plugin({ requirement: { methods: [LOCAL_SESSION_METHOD, STEP_UP] } });
    await expect(build({ highRiskMethods: [STEP_UP] }, offersSession).verifyPolicy(COMPANY)).rejects.toThrow(/highRiskMethods/);
    // No policy: nothing to check, and a gate with an empty set the plug-in itself made is not the policy's fault.
    await expect(createDecisionGate({ store: new MemoryDocumentStore(), approvers: named, audit: createNoopAuditSink(), subjects: [] }).verifyPolicy(COMPANY)).resolves.toBeUndefined();
  });

});

describe("A1 and decision 62: the sign-in time, and the company's window", () => {
  it("the decision record carries the approver's sign-in time; the gate does not use it when no rule is set (Code)", async () => {
    const { store, gate, ready } = world(plugin({ requirement: { strongMethods: [STEP_UP] }, authTime: iso(86_400 * 30) }));
    await ready;
    const request = attempt();
    expect(await gate.decide(request)).toMatchObject({ status: "decided", record: { approvers: [{ personId: "maya", method: STEP_UP, authTime: iso(86_400 * 30) }] } });
    expect(await store.get(approvalRecordKey(COMPANY, request.requestId))).toMatchObject({ approvers: [{ authTime: iso(86_400 * 30) }] });
  });

  it("the window also holds for a rejection, but not for a low-risk approval or a request for changes", async () => {
    const base = { strongMethods: [STEP_UP], rejectMethods: [STEP_UP], changesMethods: [STEP_UP], signIn: { mode: "window" as const, seconds: 600 } };
    const old = iso(7200);
    const reject = world(plugin({ requirement: base, authTime: old }), { risk: "low" });
    await reject.ready;
    expect(await reject.gate.decide(attempt({ outcome: "reject", reason: "No." }))).toMatchObject({ reason: "sign_in_not_fresh" });
    const low = world(plugin({ requirement: base, authTime: old }), { risk: "low" });
    await low.ready;
    expect(await low.gate.decide(attempt())).toMatchObject({ status: "decided" });
    const changes = world(plugin({ requirement: base, authTime: old }));
    await changes.ready;
    expect(await changes.gate.decide(attempt({ outcome: "request_changes", reason: "Use the other table." }))).toMatchObject({ status: "decided" });
  });

  it("'trust any active company sign-in' needs the identity adapter's company sign-in and a real sign-in time, but not a recent one (review M3)", async () => {
    const requirement = { strongMethods: [STEP_UP], signIn: { mode: "any-active" as const } };
    const ok = world(plugin({ requirement, authTime: iso(86_400 * 30) }), { companySignIn: true });
    await ok.ready;
    expect(await ok.gate.decide(attempt())).toMatchObject({ status: "decided" });
    // A plug-in cannot switch freshness off for a company with no sign-in of its own: no identity given, or one without the capability.
    for (const options of [{}, { companySignIn: false }]) {
      const refused = world(plugin({ requirement, authTime: iso(1) }), options);
      await refused.ready;
      expect(await refused.gate.decide(attempt())).toMatchObject({ status: "refused", reason: "sign_in_not_fresh" });
      expect(await revisionOf(refused.store)).toBe(R0);
    }
    // And it still wants a sign-in time that exists.
    const noTime = world(plugin({ requirement }), { companySignIn: true });
    await noTime.ready;
    expect(await noTime.gate.decide(attempt())).toMatchObject({ reason: "sign_in_not_fresh" });
  });

  it("checkApprovalSignIn fails closed on a missing, unreadable or future time, and holds the window edge inclusive", () => {
    const rule = { mode: "window" as const, seconds: 600 };
    const at = NOW.getTime();
    expect(checkApprovalSignIn(rule, {}, at, NO_SSO)).toEqual({ ok: false, reason: "no_sign_in_time" });
    expect(checkApprovalSignIn(rule, { authTime: "yesterday" }, at, NO_SSO)).toEqual({ ok: false, reason: "no_sign_in_time" });
    expect(checkApprovalSignIn(rule, { authTime: iso(-600) }, at, NO_SSO)).toEqual({ ok: false, reason: "sign_in_in_future" });
    expect(checkApprovalSignIn(rule, { authTime: iso(-60) }, at, NO_SSO)).toEqual({ ok: true });
    expect(checkApprovalSignIn(rule, { authTime: iso(600) }, at, NO_SSO)).toEqual({ ok: true });
    expect(checkApprovalSignIn(rule, { authTime: iso(601) }, at, NO_SSO)).toEqual({ ok: false, reason: "sign_in_too_old" });
    // Review L3: a plug-in's rule is data. Infinity, zero, a fraction and a negative number refuse; they never disable the window.
    for (const seconds of [Number.POSITIVE_INFINITY, 0, -5, 59, 86_401, 600.5, Number.NaN]) expect(checkApprovalSignIn({ mode: "window", seconds }, { authTime: iso(1) }, at, NO_SSO)).toEqual({ ok: false, reason: "invalid_rule" });
    expect(checkApprovalSignIn({ mode: "never" } as never, { authTime: iso(1) }, at, SSO)).toEqual({ ok: false, reason: "invalid_rule" });
    // Review M3: 'any active sign-in' still needs a readable, non-future sign-in time, and the identity adapter's own company sign-in.
    expect(checkApprovalSignIn({ mode: "any-active" }, { authTime: iso(86_400 * 30) }, at, SSO)).toEqual({ ok: true });
    expect(checkApprovalSignIn({ mode: "any-active" }, {}, at, SSO)).toEqual({ ok: false, reason: "no_sign_in_time" });
    expect(checkApprovalSignIn({ mode: "any-active" }, { authTime: "yesterday" }, at, SSO)).toEqual({ ok: false, reason: "no_sign_in_time" });
    expect(checkApprovalSignIn({ mode: "any-active" }, { authTime: iso(-600) }, at, SSO)).toEqual({ ok: false, reason: "sign_in_in_future" });
    expect(checkApprovalSignIn({ mode: "any-active" }, { authTime: iso(1) }, at, NO_SSO)).toEqual({ ok: false, reason: "no_company_sign_in" });
  });
});

const refusedMessage = async (run: () => Promise<unknown>): Promise<string> => { try { await run(); } catch (error) { const e = error as { code?: string; message: string }; return e.code !== undefined && e.message.startsWith(`${e.code}: `) ? e.message.slice(e.code.length + 2) : e.message; } return "merged"; };

describe("the presser on the merge press", () => {
  // The press that carried an approver proof (strong methods, comment methods, the sign-in window on a high-risk merge) was deleted (DEC 254zzz527): nothing in production called it.
  const refused = refusedMessage;

  it("the presser half of M1 end to end: a presser whose SECOND account is the only approver cannot press Merge (review N1)", async () => {
    const world = await mergeWorld({ allowSelfApproval: false });
    await world.seedTracking();
    const priya = world.prs[0]!.model.accounts.get("priya")!.hostUserId;
    const people = (accounts: string[]) => ({
      requestersOf: async () => ["requester-account"],
      linkedAmong: async (_org: unknown, ids: readonly string[]) => new Set(ids),
      nonWritersAmong: async () => new Set<string>(),
      hostAccountOf: async () => accounts[0],
      hostAccountsOf: async () => accounts,
    });
    const press = async (accounts: string[]) => {
      const deps = { ...world.deps, people: people(accounts) as never };
      const prepared = await prepareMerge(deps, { taskId: MERGE_TASK, requestId: world.requestId(), presserPersonId: "presser-1" });
      return pressAsOwner(deps, prepared, { presserPersonId: "presser-1" });
    };
    // The presser's accounts are "999" and the approver's: refused, nothing merged.
    expect(await refused(() => press(["999", priya]))).toBe("You approved this pull request, so someone else must press Merge.");
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("open");
    // Control: the presser has only "999" (a different person from the approver): it merges.
    expect((await press(["999"])).status).toBe("MERGED");
  });
});

describe("I1: the identity abilities", () => {
  const linked = { provider: "examplehost", tenant: "", accountId: "4711" };

  it("the local owner lists its one member and its linked accounts, and offers no sign-in flow", async () => {
    const identity = createLocalOwnerIdentity({ linkedAccounts: [linked] });
    const owner = localOwnerPrincipal();
    expect(identity.capabilities).toMatchObject({ interactiveSignIn: false, externalAccounts: true, members: true, companySignIn: false });
    expect(typeof identity.beginSignIn).toBe("undefined");
    expect(await identity.listMembers!(COMPANY)).toEqual({ members: [owner] });
    expect(await identity.listMembers!("org_zzzzzzzzzzzzzzzzzzzz")).toEqual({ members: [] });
    expect(await identity.accountsOf!(COMPANY, owner.personId)).toEqual([linked]);
    expect(await identity.accountsOf!(COMPANY, "someone")).toEqual([]);
    expect(await identity.accountsOf!("org_zzzzzzzzzzzzzzzzzzzz", owner.personId)).toEqual([]);
  });

  it("MergePeople folds into the identity port: the same lookups from accountsOf and resolveExternalAccount", async () => {
    const owner = localOwnerPrincipal();
    const auditor = person({ personId: "audra", roles: ["auditor"] });
    const identity: IdentityProvider = {
      capabilities: { interactiveSignIn: false, externalAccounts: true },
      authenticate: async () => ({ ok: false, reason: "refused" }),
      resolveExternalAccount: async (companyId, account) => (companyId !== COMPANY || account.provider !== "examplehost" ? undefined : account.accountId === "4711" ? owner : account.accountId === "9" ? auditor : undefined),
      getPrincipal: async () => undefined,
      accountsOf: async (companyId, personId) => (companyId === COMPANY && personId === owner.personId ? [linked, { provider: "other-host", tenant: "", accountId: "1" }] : []),
    };
    const people = createIdentityMergePeople(identity, { hostProvider: "examplehost" });
    expect(await people.hostAccountOf(COMPANY as never, owner.personId)).toBe("4711");
    expect(await people.hostAccountOf(COMPANY as never, "nobody")).toBeUndefined();
    expect([...(await people.linkedAmong(COMPANY as never, ["4711", "9", "55"]))]).toEqual(["4711"]);
    expect([...(await people.nonWritersAmong(COMPANY as never, ["4711", "9", "55"]))]).toEqual(["9"]);
    const task = { taskId: "t", project: "web", startingRevision: 1, workspaceId: "w", ownerId: owner.personId, ownerName: "Owner" };
    expect(await people.requestersOf(COMPANY as never, task)).toEqual(["4711"]);
    expect(await people.requestersOf(COMPANY as never, { ...task, creatorId: "unlinked-person" })).toBe("unlinked");
  });

  it("a person with two code host accounts is excluded by BOTH: as a requester and as the presser (review M1)", async () => {
    const requester = localOwnerPrincipal();
    const second = { provider: "examplehost", tenant: "", accountId: "4712" };
    const identity: IdentityProvider = {
      capabilities: { interactiveSignIn: false, externalAccounts: true },
      authenticate: async () => ({ ok: false, reason: "refused" }),
      resolveExternalAccount: async (_company, account) => (["4711", "4712"].includes(account.accountId) ? requester : undefined),
      getPrincipal: async () => undefined,
      accountsOf: async () => [linked, second],
    };
    const people = createIdentityMergePeople(identity, { hostProvider: "examplehost" });
    const task = { taskId: "t", project: "web", startingRevision: 1, workspaceId: "w", ownerId: requester.personId, ownerName: "Owner" };
    // Both accounts are the requester's: approving with the second one is self-approval.
    expect(await people.requestersOf(COMPANY as never, task)).toEqual(["4711", "4712"]);
    expect(await people.hostAccountsOf!(COMPANY as never, requester.personId)).toEqual(["4711", "4712"]);
    expect(await people.hostAccountOf(COMPANY as never, requester.personId)).toBe("4711");
    // The presser rule in the readiness check: the only approver is the presser's SECOND account.
    const approvals = new Map([["app#7", { approved: true as const, by: { hostUserId: "4712", login: "dana" }, commitId: "a".repeat(40), approvers: [{ hostUserId: "4712", login: "dana" }] }]]);
    const ready = mergeReadiness({
      pullRequests: [readinessFact()], approvals, workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING" }, recordedBases: new Map([["app#7", "main"]]),
      presser: { hostUserId: "4711", otherHostUserIds: ["4712"] }, requirePresserAccount: true, allowSelfApproval: false, requesterName: "Owner",
    });
    expect(ready).toMatchObject({ ready: false });
    const sameWithoutOthers = mergeReadiness({
      pullRequests: [readinessFact()], approvals, workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING" }, recordedBases: new Map([["app#7", "main"]]),
      presser: { hostUserId: "4711" }, requirePresserAccount: true, allowSelfApproval: false, requesterName: "Owner",
    });
    expect(sameWithoutOthers).toMatchObject({ ready: true });
  });

  it("an identity that cannot say who has which account links nobody, as the sole-owner default does", async () => {
    const bare: IdentityProvider = { capabilities: { interactiveSignIn: false, externalAccounts: false }, authenticate: async () => ({ ok: false, reason: "refused" }), resolveExternalAccount: async () => undefined, getPrincipal: async () => undefined };
    const people = createIdentityMergePeople(bare, { hostProvider: "examplehost" });
    const task = { taskId: "t", project: "web", startingRevision: 1, workspaceId: "w", ownerId: "o", ownerName: "O" };
    expect(await people.requestersOf(COMPANY as never, task)).toEqual(await soleOwnerPeople.requestersOf(COMPANY as never, task));
    expect(await people.hostAccountOf(COMPANY as never, "o")).toBeUndefined();
  });

});

describe("I2: one neutral outside account, an open sign-in method, a legacy alias", () => {
  it("the account is { provider, tenant, accountId }; a tenant may be empty; extra keys and bad ids are refused", () => {
    expect(ExternalAccountRefSchema.safeParse({ provider: "examplehost", tenant: "", accountId: "4711" }).success).toBe(true);
    expect(ExternalAccountRefSchema.safeParse({ provider: "examplehost", tenant: "acme", accountId: "u_1" }).success).toBe(true);
    for (const bad of [{ provider: "Example", tenant: "", accountId: "1" }, { provider: "examplehost", tenant: "", accountId: "" }, { provider: "examplehost", tenant: "", accountId: "a b" }, { provider: "examplehost", tenant: "", accountId: "1", extra: 1 }, { provider: "examplehost", accountId: "1" }]) {
      expect(ExternalAccountRefSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("a chat actor and a code host login convert to the neutral shape and back; a login with no stable id is no account", () => {
    const actor = { channel: "examplechat", tenant: "T1", userId: "U1" };
    expect(externalAccountOfActor(actor)).toEqual({ provider: "examplechat", tenant: "T1", accountId: "U1" });
    expect(actorOfExternalAccount(externalAccountOfActor(actor))).toEqual(actor);
    expect(externalAccountOfHostAccount("examplehost", "", { login: "maya", hostUserId: "4711" })).toEqual({ provider: "examplehost", tenant: "", accountId: "4711" });
    expect(externalAccountOfHostAccount("examplehost", "", { login: "maya" })).toBeUndefined();
  });

  it("two different accounts never share a key", () => {
    expect(externalAccountKey({ provider: "a", tenant: "bc", accountId: "d" })).not.toBe(externalAccountKey({ provider: "a", tenant: "b", accountId: "cd" }));
  });

  it("the legacy slackUserId is read as an account of the 'slack' provider; the neutral field wins; a disagreement is no answer", () => {
    expect(readExternalAccount({ slackUserId: "U0123ABCD" }, "T0ABC")).toEqual({ provider: "slack", tenant: "T0ABC", accountId: "U0123ABCD" });
    expect(readExternalAccount({})).toBeUndefined();
    const neutral = { provider: "examplechat", tenant: "T9", accountId: "U7" };
    expect(readExternalAccount({ account: neutral })).toEqual(neutral);
    expect(readExternalAccount({ account: neutral, slackUserId: "U7" })).toBeUndefined();
    const same = { provider: "slack", tenant: "T0ABC", accountId: "U0123ABCD" };
    expect(readExternalAccount({ account: same, slackUserId: "U0123ABCD" }, "T0ABC")).toEqual(same);
    expect(readExternalAccount({ account: same, slackUserId: "UOTHER" }, "T0ABC")).toBeUndefined();
    expect(readExternalAccount({ account: { ...same, tenant: "T1" }, slackUserId: "U0123ABCD" }, "T0ABC")).toBeUndefined();
  });

  it("a sign-in method id is open: a new adapter's id is valid, the built-in ones still are, a bad one is not", () => {
    for (const id of [...BUILT_IN_SIGN_IN_METHODS, "company-sso", "passkey"]) expect(SignInMethodIdSchema.safeParse(id).success).toBe(true);
    for (const id of ["", "A", "x", "has space", "-a", "a".repeat(40)]) expect(SignInMethodIdSchema.safeParse(id).success).toBe(false);
    const linked = { provider: "company-sso", email: "a@example.test", linkedAt: iso(9), lastSignInAt: iso(1) };
    expect(LinkedIdentitySchema.safeParse(linked).success).toBe(true);
    expect(LinkedIdentitySchema.safeParse({ ...linked, provider: "Not A Method" }).success).toBe(false);
    expect(AppMeResponseSchema.shape.identities.element.safeParse(linked).success).toBe(true);
  });

  it("the developer summary takes the neutral account beside the legacy field", () => {
    const base = { id: "a".repeat(64), name: "Maya", provider: "company-sso" };
    expect(DeveloperSummarySchema.safeParse({ ...base, account: { provider: "examplechat", tenant: "T1", accountId: "U1" } }).success).toBe(true);
    expect(DeveloperSummarySchema.safeParse({ ...base, slackUserId: "U0123ABCD" }).success).toBe(true);
    expect(DeveloperSummarySchema.safeParse({ ...base, account: { provider: "Bad", tenant: "", accountId: "1" } }).success).toBe(false);
  });

  it("a summary whose account and slackUserId name different accounts is refused; one that agrees is fine (review L6)", () => {
    const base = { id: "a".repeat(64), name: "Maya", provider: "company-sso" };
    const account = { provider: "slack", tenant: "T0ABC", accountId: "U0123ABCD" };
    expect(DeveloperSummarySchema.safeParse({ ...base, account, slackUserId: "U0123ABCD" }).success).toBe(true);
    expect(DeveloperSummarySchema.safeParse({ ...base, account, slackUserId: "U0999OTHER" }).success).toBe(false);
    expect(DeveloperSummarySchema.safeParse({ ...base, account: { provider: "examplechat", tenant: "", accountId: "U0123ABCD" }, slackUserId: "U0123ABCD" }).success).toBe(false);
  });
});

describe("I3: role names; the core acts only on the ones it knows", () => {
  it("the closed schema stays closed, so a check that parses a role never passes an unknown one (review M4)", () => {
    expect(KNOWN_ORG_ROLES).toEqual(["owner", "admin", "member"]);
    for (const role of ["owner", "admin", "member"]) expect(OrgRoleSchema.safeParse(role).success).toBe(true);
    for (const role of ["auditor", "billing-contact", "constructor", "", "Owner"]) expect(OrgRoleSchema.safeParse(role).success).toBe(false);
    expect(isKnownOrgRole("owner")).toBe(true);
    expect(isKnownOrgRole("auditor")).toBe(false);
    expect(isKnownOrgRole("constructor")).toBe(false);
  });

  it("the open name schema takes a role the core does not know, but never a name that is a property of every object", () => {
    for (const role of ["owner", "auditor", "billing-contact"]) expect(OrgRoleNameSchema.safeParse(role).success).toBe(true);
    for (const role of ["", "Owner", "a b", "9lives", "x".repeat(41), "constructor", "tostring", "__proto__", "valueof", "hasownproperty"]) {
      // 'tostring' and the like are only refused when they are real property names; the regex lower-cases away the rest.
      const real = role in Object.prototype;
      expect(OrgRoleNameSchema.safeParse(role).success).toBe(!real && /^[a-z][a-z0-9_-]{0,39}$/.test(role));
    }
    expect(OrgRoleNameSchema.safeParse("constructor").success).toBe(false);
  });

  it("a table lookup by role uses the table's own keys, not its prototype", () => {
    const rank = { owner: 3, admin: 2, member: 1 };
    expect(ownRoleEntry(rank, "admin")).toBe(2);
    expect(ownRoleEntry(rank, "auditor")).toBeUndefined();
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) expect(ownRoleEntry(rank, name)).toBeUndefined();
  });

  it("a shared answer about an auditor parses", () => {
    const answer = { csrf: undefined, developer: { id: "a".repeat(64), name: "Audra", orgRole: "auditor" }, org: { orgId: "org_00000000000000000000", name: "Acme", plan: "team" }, identities: [] };
    expect(AppMeResponseSchema.safeParse(answer).success).toBe(true);
    expect(AppMeResponseSchema.safeParse({ ...answer, developer: { ...answer.developer, orgRole: "constructor" } }).success).toBe(false);
  });
});
