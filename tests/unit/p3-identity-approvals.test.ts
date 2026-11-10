// Lane P3 (owner decisions 60 and 62): identity abilities (I1), one neutral outside account and an open sign-in method id (I2), any role name (I3), the sign-in time on approvals (A1), and the approvers plug-in naming its strong
// methods (A3), with the company's fresh sign-in window. Approvals are authority, so each rule has a test that it does not WIDEN anything: a comment is never a rejection or a high-risk approval, a missing sign-in time fails closed.
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest's expect.* matchers are typed any */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AppMeResponseSchema, BUILT_IN_SIGN_IN_METHODS, DeveloperSummarySchema, ExternalAccountRefSchema, FRESH_SIGN_IN_SECONDS, IMPLICIT_COMPANY_ID, KNOWN_ORG_ROLES, LinkedIdentitySchema, OrgRoleNameSchema, OrgRoleSchema, SignInMethodIdSchema, ownRoleEntry,
  actorOfExternalAccount, checkApprovalSignIn, checkApprovalSignInSetting, createWorkflowSnapshot, externalAccountKey, externalAccountOfActor, externalAccountOfHostAccount, isKnownOrgRole, readExternalAccount,
  submitWorkflowArtifact, DEFAULT_APPROVAL_SIGN_IN_SETTING,
  type ApprovalProof, type ApprovalRequest, type ApprovalRequirement, type ApprovalVerdict, type Approvers, type AuditEvent, type AuditSink, type IdentityProvider, type Principal, type TransactItem, type WorkflowSnapshot,
} from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { CODE_HOST_COMMENT_METHOD, LOCAL_SESSION_METHOD, createLocalOwnerApprovers, createLocalOwnerIdentity, createNoopAuditSink, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createDecisionGate, approvalRecordKey, type DecisionAttempt } from "../../packages/broker/src/core/decisions/approval-gate.js";
import { isCommentMethod, strictMethodsFor } from "../../packages/broker/src/core/decisions/strong-methods.js";
import { createWorkflowDocumentSubject, workflowTaskKey, waitingDocumentDigest } from "../../packages/broker/src/core/decisions/workflow-subject.js";
import { approvalSignInSettingKey, changeApprovalSignInSetting, readApprovalSignInRule, readApprovalSignInSetting } from "../../packages/broker/src/core/decisions/sign-in-setting.js";
import { createIdentityMergePeople, soleOwnerPeople } from "../../packages/broker/src/core/merge/people.js";
import { mergeReadiness, prepareMerge, pressMerge } from "../../packages/broker/src/core/merge/index.js";
import { TASK_ID as MERGE_TASK, mergeWorld, OWNER_SESSION } from "../support/merge-world.js";
import { commentReads, freshComment } from "../support/comment-fakes.js";

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
  it("a plug-in whose session method has another name approves a high-risk request once it names that method; before, it could approve none", async () => {
    const unnamed = world(plugin());
    await unnamed.ready;
    expect(await unnamed.gate.decide(attempt())).toMatchObject({ status: "refused", reason: "method_not_allowed" });
    expect(await revisionOf(unnamed.store)).toBe(R0);
    const named = world(plugin({ requirement: { strongMethods: [STEP_UP] } }));
    await named.ready;
    expect(await named.gate.decide(attempt())).toMatchObject({ status: "decided", approver: { personId: "maya" } });
  });

  it("naming a method does not make it work for a method the plug-in does not offer", async () => {
    const { gate, ready } = world(plugin({ requirement: { methods: [CODE_HOST_COMMENT_METHOD], strongMethods: [STEP_UP] } }));
    await ready;
    expect(await gate.decide(attempt())).toMatchObject({ status: "refused", reason: "method_not_allowed" });
  });

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

  it("rejecting needs the method the plug-in names for it; with none named it needs the local session", async () => {
    const unnamed = world(plugin(), { risk: "low" });
    await unnamed.ready;
    expect(await unnamed.gate.decide(attempt({ outcome: "reject" }))).toMatchObject({ reason: "method_not_allowed" });
    const named = world(plugin({ requirement: { rejectMethods: [STEP_UP] } }), { risk: "low" });
    await named.ready;
    expect(await named.gate.decide(attempt({ outcome: "reject", reason: "No." }))).toMatchObject({ status: "decided" });
  });

  it("asking for changes by a comment is allowed; a plug-in may name other methods for it", () => {
    expect(strictMethodsFor("request_changes", "high", {})).toEqual([LOCAL_SESSION_METHOD, CODE_HOST_COMMENT_METHOD]);
    expect(strictMethodsFor("request_changes", "low", { changesMethods: [STEP_UP] })).toEqual([STEP_UP]);
  });

  it("the gate's policy option can only NARROW what the plug-in names (review L2), and cannot let a comment in", async () => {
    expect(strictMethodsFor("approve", "high", { strongMethods: [STEP_UP, "emailed-link"] }, { highRiskMethods: [STEP_UP] })).toEqual([STEP_UP]);
    // A method the plug-in left out is not re-admitted by the policy.
    expect(strictMethodsFor("approve", "high", { strongMethods: [STEP_UP] }, { highRiskMethods: [STEP_UP, "emailed-link"] })).toEqual([STEP_UP]);
    expect(strictMethodsFor("approve", "high", { strongMethods: [STEP_UP] }, { highRiskMethods: [LOCAL_SESSION_METHOD] })).toEqual([]);
    expect(strictMethodsFor("approve", "high", {}, { highRiskMethods: [CODE_HOST_COMMENT_METHOD] })).toEqual([]);
    const { gate, ready } = world(plugin({ requirement: { strongMethods: [STEP_UP] } }), { policy: { highRiskMethods: [LOCAL_SESSION_METHOD] } });
    await ready;
    expect(await gate.decide(attempt())).toMatchObject({ reason: "method_not_allowed" });
    const widened = world(plugin({ requirement: { methods: [STEP_UP, "emailed-link"], strongMethods: [STEP_UP] } }), { policy: { highRiskMethods: [STEP_UP, "emailed-link"] } });
    await widened.ready;
    expect(await widened.gate.decide(attempt({ credentials: [{ method: "emailed-link", token: TOKEN }] }))).toMatchObject({ reason: "method_not_allowed" });
  });

  it("a policy is intersected with the default too when the plug-in names no set, so it never admits a method the default leaves out (review N2)", async () => {
    expect(strictMethodsFor("approve", "high", {}, { highRiskMethods: [STEP_UP] })).toEqual([]);
    expect(strictMethodsFor("approve", "high", {}, { highRiskMethods: [STEP_UP, LOCAL_SESSION_METHOD] })).toEqual([LOCAL_SESSION_METHOD]);
    expect(strictMethodsFor("reject", "low", {}, { rejectMethods: [STEP_UP] })).toEqual([]);
    expect(strictMethodsFor("request_changes", "low", {}, { changesMethods: [STEP_UP, CODE_HOST_COMMENT_METHOD] })).toEqual([CODE_HOST_COMMENT_METHOD]);
    const { gate, ready, store } = world(plugin(), { policy: { highRiskMethods: [STEP_UP] } });
    await ready;
    expect(await gate.decide(attempt())).toMatchObject({ reason: "method_not_allowed" });
    expect(await revisionOf(store)).toBe(R0);
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

  it("a comment is recognised by KIND, not one exact name: code-host-* and the plug-in's own commentMethods are never strong or a rejection (review L1)", async () => {
    expect(isCommentMethod("code-host-comment")).toBe(true);
    expect(isCommentMethod("code-host-review-button")).toBe(true);
    expect(isCommentMethod("slack-comment")).toBe(false);
    expect(isCommentMethod("slack-comment", { commentMethods: ["slack-comment"] })).toBe(true);
    const requirement = { strongMethods: [STEP_UP, "slack-comment", "code-host-review-button"], rejectMethods: [STEP_UP, "slack-comment", "code-host-review-button"], commentMethods: ["slack-comment"] };
    expect(strictMethodsFor("approve", "high", requirement)).toEqual([STEP_UP]);
    expect(strictMethodsFor("reject", "low", requirement)).toEqual([STEP_UP]);
    const asked = plugin({ requirement: { methods: [STEP_UP, "slack-comment"], ...requirement } });
    const high = world(asked);
    await high.ready;
    expect(await high.gate.decide(attempt({ credentials: [{ method: "slack-comment", token: TOKEN }] }))).toMatchObject({ reason: "method_not_allowed" });
    expect(await revisionOf(high.store)).toBe(R0);
  });

  it("a low or medium risk approval is limited only by the methods the plug-in offers", () => {
    expect(strictMethodsFor("approve", "low", { strongMethods: [STEP_UP] })).toBeUndefined();
    expect(strictMethodsFor("approve", "medium", {})).toBeUndefined();
  });

  it("Code's local approvers name the local session as strong and for rejecting, and still accept a comment for changes", async () => {
    const approvers = createLocalOwnerApprovers({ verifySession: () => true, fetchComment: () => undefined });
    const requirement = await approvers.requirement({ companyId: COMPANY, requestId: "r", kind: "plan", subject: { type: "task", id: "t" }, revision: 1, artifactDigest: "d" });
    expect(requirement).toMatchObject({ methods: [LOCAL_SESSION_METHOD, CODE_HOST_COMMENT_METHOD], strongMethods: [LOCAL_SESSION_METHOD], rejectMethods: [LOCAL_SESSION_METHOD], changesMethods: [LOCAL_SESSION_METHOD, CODE_HOST_COMMENT_METHOD] });
    expect(requirement.signIn).toBeUndefined();
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

  it("a window: a recent sign-in approves a high-risk request, an old one or none is refused and nothing changes", async () => {
    const rule = { mode: "window" as const, seconds: 600 };
    const base = { strongMethods: [STEP_UP], rejectMethods: [STEP_UP], signIn: rule };
    const fresh = world(plugin({ requirement: base, authTime: iso(599) }));
    await fresh.ready;
    expect(await fresh.gate.decide(attempt())).toMatchObject({ status: "decided" });
    for (const authTime of [iso(601), undefined, "not a time", iso(-3600)]) {
      const stale = world(plugin({ requirement: base, authTime }));
      await stale.ready;
      expect(await stale.gate.decide(attempt())).toMatchObject({ status: "refused", reason: "sign_in_not_fresh" });
      expect(await revisionOf(stale.store)).toBe(R0);
    }
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

  it("a plug-in's malformed window (Infinity, zero) refuses the approval instead of switching the rule off (review L3)", async () => {
    for (const seconds of [Number.POSITIVE_INFINITY, 0]) {
      const { gate, ready, store } = world(plugin({ requirement: { strongMethods: [STEP_UP], signIn: { mode: "window", seconds } }, authTime: iso(1) }));
      await ready;
      expect(await gate.decide(attempt())).toMatchObject({ status: "refused", reason: "sign_in_not_fresh" });
      expect(await revisionOf(store)).toBe(R0);
    }
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

  it("the default window is ten minutes", () => {
    expect(DEFAULT_APPROVAL_SIGN_IN_SETTING).toEqual({ mode: "window", seconds: FRESH_SIGN_IN_SECONDS });
    expect(FRESH_SIGN_IN_SECONDS).toBe(600);
  });
});

describe("the company's sign-in setting", () => {
  const owner = person({ roles: ["owner"] });
  const deps = (store: MemoryDocumentStore, audit: AuditSink = createNoopAuditSink(), sso = false) => ({ store, audit, identity: identityWith(sso), now: () => NOW });
  const noSso = identityWith(false);
  const sso = identityWith(true);

  it("a company that chose nothing has the default window", async () => {
    const store = new MemoryDocumentStore();
    expect(await readApprovalSignInSetting(store, COMPANY, noSso)).toEqual({ setting: DEFAULT_APPROVAL_SIGN_IN_SETTING, revision: 0, isDefault: true });
  });

  it("an owner or an admin sets a window; the rule read back is what the plug-in puts in its requirement", async () => {
    const store = new MemoryDocumentStore();
    expect(await changeApprovalSignInSetting(deps(store), { companyId: COMPANY, by: owner, setting: { mode: "window", seconds: 1800 }, expectedRevision: 0 })).toEqual({ ok: true, setting: { mode: "window", seconds: 1800 }, revision: 1 });
    expect(await readApprovalSignInRule(store, COMPANY, noSso)).toEqual({ mode: "window", seconds: 1800 });
    const admin = person({ personId: "ravi", roles: ["admin"] });
    expect(await changeApprovalSignInSetting(deps(store), { companyId: COMPANY, by: admin, setting: { mode: "window", seconds: 300 }, expectedRevision: 1 })).toMatchObject({ ok: true, revision: 2 });
  });

  it("a member, a role the core does not know, and a person of another company may not change it", async () => {
    const store = new MemoryDocumentStore();
    for (const by of [person({ roles: ["member"] }), person({ roles: ["auditor"] }), person({ roles: [] }), person({ companyId: "org_zzzzzzzzzzzzzzzzzzzz" })]) {
      expect(await changeApprovalSignInSetting(deps(store, undefined, true), { companyId: COMPANY, by, setting: { mode: "window", seconds: 600 }, expectedRevision: 0 })).toEqual({ ok: false, reason: "not_allowed" });
    }
    expect(await store.get(approvalSignInSettingKey(COMPANY))).toBeUndefined();
  });

  it("'trust any active company sign-in' is allowed only when the IDENTITY ADAPTER says it has the company's own sign-in, read inside the function (review M3)", async () => {
    const store = new MemoryDocumentStore();
    const any = { companyId: COMPANY, by: owner, setting: { mode: "any-active" }, expectedRevision: 0 };
    expect(await changeApprovalSignInSetting(deps(store), any)).toEqual({ ok: false, reason: "needs_company_sign_in" });
    // No caller flag exists to turn it on: an input that claims the capability changes nothing.
    expect(await changeApprovalSignInSetting(deps(store), { ...any, companyOwnSignIn: true } as never)).toEqual({ ok: false, reason: "needs_company_sign_in" });
    expect(await changeApprovalSignInSetting({ ...deps(store), identity: { capabilities: { interactiveSignIn: true, externalAccounts: false } } }, any)).toEqual({ ok: false, reason: "needs_company_sign_in" });
    expect(await changeApprovalSignInSetting(deps(store, undefined, true), any)).toMatchObject({ ok: true });
    expect(await readApprovalSignInRule(store, COMPANY, sso)).toEqual({ mode: "any-active" });
    // The company later loses its own sign-in: the stored choice is not used, the default window is.
    expect(await readApprovalSignInRule(store, COMPANY, noSso)).toEqual(DEFAULT_APPROVAL_SIGN_IN_SETTING);
  });

  it("refuses a window outside the limits and anything that is not a setting", async () => {
    const store = new MemoryDocumentStore();
    for (const setting of [{ mode: "window", seconds: 59 }, { mode: "window", seconds: 86_401 }, { mode: "window", seconds: 600.5 }, { mode: "never" }, { mode: "window" }, "any-active", null, { mode: "any-active", seconds: 5 }]) {
      expect(await changeApprovalSignInSetting(deps(store, undefined, true), { companyId: COMPANY, by: owner, setting, expectedRevision: 0 })).toEqual({ ok: false, reason: "invalid" });
    }
    expect(checkApprovalSignInSetting({ mode: "window", seconds: 60 }, { companyOwnSignIn: false })).toMatchObject({ ok: true });
  });

  it("a change that lost a race (an old revision) is refused and changes nothing; the audit step commits with the change", async () => {
    const store = new MemoryDocumentStore();
    const staged: AuditEvent[] = [];
    const audit: AuditSink = { stage: (event) => { staged.push(event); return [{ kind: "put", item: { pk: `AUDIT#${event.eventId}`, sk: "EVENT", action: event.action } } satisfies TransactItem]; }, async record() {} };
    expect(await changeApprovalSignInSetting(deps(store, audit), { companyId: COMPANY, by: owner, setting: { mode: "window", seconds: 900 }, expectedRevision: 0 })).toMatchObject({ ok: true, revision: 1 });
    expect(staged[0]).toMatchObject({ action: "setting.approval_sign_in_changed", actor: { id: "maya" }, details: { mode: "window", seconds: 900, revision: 1 } });
    expect(await store.get({ pk: "AUDIT#setting:approval-sign-in:" + COMPANY + ":1", sk: "EVENT" })).toBeDefined();
    expect(await changeApprovalSignInSetting(deps(store, audit), { companyId: COMPANY, by: owner, setting: { mode: "window", seconds: 60 }, expectedRevision: 0 })).toEqual({ ok: false, reason: "stale" });
    expect((await readApprovalSignInSetting(store, COMPANY, noSso)).setting).toEqual({ mode: "window", seconds: 900 });
  });

  it("the audit record of a change carries the new seconds and the value it replaced (review L4)", async () => {
    const store = new MemoryDocumentStore();
    const staged: AuditEvent[] = [];
    const audit: AuditSink = { stage: (event) => { staged.push(event); return []; }, async record() {} };
    await changeApprovalSignInSetting(deps(store, audit), { companyId: COMPANY, by: owner, setting: { mode: "window", seconds: 600 }, expectedRevision: 0 });
    await changeApprovalSignInSetting(deps(store, audit), { companyId: COMPANY, by: owner, setting: { mode: "window", seconds: 86_400 }, expectedRevision: 1 });
    await changeApprovalSignInSetting(deps(store, audit, true), { companyId: COMPANY, by: owner, setting: { mode: "any-active" }, expectedRevision: 2 });
    expect(staged.map((event) => event.details)).toEqual([
      { mode: "window", seconds: 600, revision: 1, previous: { mode: "window", seconds: 600, isDefault: true } },
      { mode: "window", seconds: 86_400, revision: 2, previous: { mode: "window", seconds: 600, isDefault: false } },
      { mode: "any-active", revision: 3, previous: { mode: "window", seconds: 86_400, isDefault: false } },
    ]);
  });

  it("a stored row that cannot be read gives the default window, not 'no rule'", async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: { ...approvalSignInSettingKey(COMPANY), revision: 3, setting: { mode: "window", seconds: 5 } } });
    expect(await readApprovalSignInSetting(store, COMPANY, sso)).toMatchObject({ setting: DEFAULT_APPROVAL_SIGN_IN_SETTING, revision: 3, isDefault: true });
  });
});

const refusedMessage = async (run: () => Promise<unknown>): Promise<string> => { try { await run(); } catch (error) { const e = error as { code?: string; message: string }; return e.code !== undefined && e.message.startsWith(`${e.code}: `) ? e.message.slice(e.code.length + 2) : e.message; } return "merged"; };

describe("A1 and A3 on the merge press", () => {
  async function highRiskWorld(approvers: Approvers) {
    const world = await mergeWorld();
    await world.seedTracking();
    await world.setWorkflow({ risk: { level: "high", reasons: ["auth"], candidateDigest: "c".repeat(64) } });
    return { world, deps: { ...world.deps, approvers } };
  }
  const press = async (w: Awaited<ReturnType<typeof highRiskWorld>>, method = STEP_UP) => {
    const prepared = await prepareMerge(w.deps, { taskId: MERGE_TASK, requestId: w.world.requestId() });
    return pressMerge(w.deps, { taskId: MERGE_TASK, requestId: prepared.request.requestId, proof: w.world.proofFor(prepared, { method, token: TOKEN }) });
  };
  const refused = async (run: () => Promise<unknown>): Promise<string> => { try { await run(); } catch (error) { return (error as { message: string }).message; } return "merged"; };

  it("a high-risk merge by a method the plug-in does not call strong is refused; by a strong one it merges", async () => {
    const weak = await highRiskWorld(plugin({ requirement: { methods: [STEP_UP, "emailed-link"], strongMethods: [STEP_UP] } }));
    expect(await refused(() => press(weak, "emailed-link"))).toContain("Nobody approved");
    expect(weak.world.prs[0]!.model.getChangeRequest(String(weak.world.prs[0]!.number)).state).toBe("open");
    const strong = await highRiskWorld(plugin({ requirement: { strongMethods: [STEP_UP] } }));
    expect((await press(strong)).status).toBe("MERGED");
  });

  it("a comment never merges a high-risk change even when the plug-in names it", async () => {
    const w = await highRiskWorld(plugin({ requirement: { strongMethods: [STEP_UP, CODE_HOST_COMMENT_METHOD] } }));
    expect(await refused(() => press(w, CODE_HOST_COMMENT_METHOD))).toContain("Nobody approved");
  });

  it("the sign-in window holds for a high-risk merge: an old or missing sign-in time merges nothing", async () => {
    const rule = { mode: "window" as const, seconds: 600 };
    for (const authTime of [iso(3600), undefined]) {
      const w = await highRiskWorld(plugin({ requirement: { strongMethods: [STEP_UP], signIn: rule }, authTime }));
      expect(await refused(() => press(w))).toContain("recent sign-in");
      expect(w.world.prs[0]!.model.getChangeRequest(String(w.world.prs[0]!.number)).state).toBe("open");
    }
    // The world's clock is its own: use the time it reports.
    const fresh = await highRiskWorld(plugin({ requirement: { strongMethods: [STEP_UP], signIn: rule } }));
    const recent = new Date(fresh.world.now.value - 60_000).toISOString();
    fresh.deps.approvers = plugin({ requirement: { strongMethods: [STEP_UP], signIn: rule }, authTime: recent });
    expect((await press(fresh)).status).toBe("MERGED");
  });

  it("a low-risk merge is not held to the rule, and a plug-in that names nothing is unchanged", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const low = { ...world.deps, approvers: plugin({ requirement: { strongMethods: [STEP_UP], signIn: { mode: "window", seconds: 60 } }, authTime: iso(86_400) }) };
    const prepared = await prepareMerge(low, { taskId: MERGE_TASK, requestId: world.requestId() });
    expect((await pressMerge(low, { taskId: MERGE_TASK, requestId: prepared.request.requestId, proof: world.proofFor(prepared, { method: STEP_UP, token: TOKEN }) })).status).toBe("MERGED");
  });

  it("a plug-in that names no strong methods gets the gate's default for a high-risk merge: the local session, never a comment (review M2)", async () => {
    const w = await highRiskWorld(plugin());
    expect(await refused(() => press(w))).toContain("Nobody approved");
    expect(await refused(() => press(w, CODE_HOST_COMMENT_METHOD))).toContain("Nobody approved");
    expect(w.world.prs[0]!.model.getChangeRequest(String(w.world.prs[0]!.number)).state).toBe("open");
    // The same plug-in, asked about a low-risk merge, is limited only by its own methods.
    expect(strictMethodsFor("approve", "low", {})).toBeUndefined();
    const sameAsGate = strictMethodsFor("approve", "high", {});
    expect(sameAsGate).toEqual([LOCAL_SESSION_METHOD]);
  });

  it("any comment kind is refused for a high-risk merge, by name or by plug-in marking (review L1)", async () => {
    const w = await highRiskWorld(plugin({ requirement: { methods: [STEP_UP, "slack-comment", "code-host-button"], strongMethods: [STEP_UP, "slack-comment", "code-host-button"], commentMethods: ["slack-comment"] } }));
    for (const method of ["slack-comment", "code-host-button"]) expect(await refused(() => press(w, method))).toContain("Nobody approved");
    expect((await press(w)).status).toBe("MERGED");
  });

  it("in Code a high-risk merge proved by a code host comment is refused, and the local session still merges it (review L5)", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    await world.setWorkflow({ risk: { level: "high", reasons: ["auth"], candidateDigest: "c".repeat(64) } });
    const approvers = createLocalOwnerApprovers({ owner: localOwnerPrincipal(), verifySession: (token) => token === OWNER_SESSION, ...commentReads(freshComment({ provider: "github", tenant: "", accountId: "priya" })) });
    const deps = { ...world.deps, approvers };
    const prepared = await prepareMerge(deps, { taskId: MERGE_TASK, requestId: world.requestId() });
    expect(prepared.requirement.methods).toContain(CODE_HOST_COMMENT_METHOD);
    const byComment = await refused(() => pressMerge(deps, { taskId: MERGE_TASK, requestId: prepared.request.requestId, proof: world.proofFor(prepared, { method: CODE_HOST_COMMENT_METHOD, token: "comment-9001" }) }));
    expect(byComment).toContain("Nobody approved");
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("open");
    expect((await pressMerge(deps, { taskId: MERGE_TASK, requestId: prepared.request.requestId, proof: world.proofFor(prepared) })).status).toBe("MERGED");
  });

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
      return pressMerge(deps, { taskId: MERGE_TASK, requestId: prepared.request.requestId, proof: world.proofFor(prepared), presserPersonId: "presser-1" });
    };
    // The presser's accounts are "999" and the approver's: refused, nothing merged.
    expect(await refusedMessage(() => press(["999", priya]))).toBe("You approved this pull request, so someone else must press Merge.");
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("open");
    // Control: the presser has only "999" (a different person from the approver): it merges.
    expect((await press(["999"])).status).toBe("MERGED");
  });

  it("the merge press also checks the identity capability for 'any active sign-in' (review M3), and a malformed window (review L3)", async () => {
    const rule = { mode: "any-active" as const };
    const recent = (w: Awaited<ReturnType<typeof highRiskWorld>>) => new Date(w.world.now.value - 60_000).toISOString();
    for (const identity of [undefined, identityWith(false)]) {
      const w = await highRiskWorld(plugin());
      w.deps.approvers = plugin({ requirement: { strongMethods: [STEP_UP], signIn: rule }, authTime: recent(w) });
      if (identity !== undefined) (w.deps as { identity?: unknown }).identity = identity;
      expect(await refused(() => press(w))).toContain("recent sign-in");
    }
    const ok = await highRiskWorld(plugin());
    ok.deps.approvers = plugin({ requirement: { strongMethods: [STEP_UP], signIn: rule }, authTime: recent(ok) });
    (ok.deps as { identity?: unknown }).identity = identityWith(true);
    expect((await press(ok)).status).toBe("MERGED");
    for (const seconds of [Number.POSITIVE_INFINITY, 0]) {
      const w = await highRiskWorld(plugin());
      w.deps.approvers = plugin({ requirement: { strongMethods: [STEP_UP], signIn: { mode: "window", seconds } }, authTime: recent(w) });
      expect(await refused(() => press(w))).toContain("recent sign-in");
    }
  });

  it("Code's own approvers still merge a high-risk change with the local session", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    await world.setWorkflow({ risk: { level: "high", reasons: ["auth"], candidateDigest: "c".repeat(64) } });
    const prepared = await world.prepare();
    expect(prepared.requirement.strongMethods).toEqual([LOCAL_SESSION_METHOD]);
    expect((await pressMerge(world.deps, { taskId: MERGE_TASK, requestId: prepared.request.requestId, proof: world.proofFor(prepared, { token: OWNER_SESSION }) })).status).toBe("MERGED");
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
    const approvals = new Map([["app#7", { approved: true as const, by: { githubUserId: "4712", login: "dana" }, commitId: "a".repeat(40), approvers: [{ githubUserId: "4712", login: "dana" }] }]]);
    const ready = mergeReadiness({
      pullRequests: [readinessFact()], approvals, workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING" }, recordedBases: new Map([["app#7", "main"]]),
      presser: { githubUserId: "4711", otherGithubUserIds: ["4712"] }, requirePresserAccount: true, allowSelfApproval: false, requesterName: "Owner",
    });
    expect(ready).toMatchObject({ ready: false });
    const sameWithoutOthers = mergeReadiness({
      pullRequests: [readinessFact()], approvals, workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING" }, recordedBases: new Map([["app#7", "main"]]),
      presser: { githubUserId: "4711" }, requirePresserAccount: true, allowSelfApproval: false, requesterName: "Owner",
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

  it("a person carries a sign-in time and the methods used; both are optional", () => {
    const principal: Principal = { ...localOwnerPrincipal(), authTime: iso(5), methods: ["company-sso"] };
    expect(principal.authTime).toBeDefined();
    expect(localOwnerPrincipal().authTime).toBeUndefined();
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
