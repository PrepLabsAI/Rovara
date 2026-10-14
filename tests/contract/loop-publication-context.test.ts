import { describe, expect, it } from "vitest";
import {
  RegisteredEnrollmentSchema,
  RegisteredPendingEnrollmentSchema,
  StandaloneEnrollmentSchema,
  resolveLoopEnrollment,
  resolvePublicationScopes,
  resolveRegisteredPublication,
  type LoopEnrollment,
} from "../../packages/cli/src/loop/enrollment.js";

const host = { hostId: "host-a", uid: 501, account: "maya", repo: "acme/payments", repositoryId: 1234, checkoutPath: "/work/payments", commonGitDir: "/work/payments/.git" };
const standalone: LoopEnrollment = {
  schemaVersion: 1, kind: "standalone-local", enrollmentId: "local-1", namespace: "local:host-a:maya:1234",
  hostId: "host-a", uid: 501, account: "maya", project: "acme/payments", repositoryId: 1234,
  checkoutPath: "/work/payments", commonGitDir: "/work/payments/.git", enrolledAt: "2026-10-14T10:00:00.000Z",
};
const registered: LoopEnrollment = {
  schemaVersion: 1, kind: "registered", enrollmentId: "native-1", namespace: "https://agentx.example/env-a",
  hostId: "host-a", uid: 501, account: "maya", project: "payments-service", projectRevision: 4,
  repository: "acme/payments", repositoryId: 1234, checkoutPath: "/work/payments", commonGitDir: "/work/payments/.git", sourceBindingRef: "binding-1",
  enrolledAt: "2026-10-14T10:00:00.000Z",
};
const pending: LoopEnrollment = {
  schemaVersion: 1, kind: "registered-pending", enrollmentId: "pending-1", namespace: "https://agentx.example/env-a",
  hostId: "host-a", uid: 501, registeredBy: "owner-1", project: "payments-service", projectRevision: 4,
  sources: [{ name: "payments", repository: "acme/payments", repositoryUrl: "https://github.com/acme/payments.git" }],
  enrolledAt: "2026-10-14T10:00:00.000Z",
};
const subject = { projectName: "payments-service", projectRevision: 4, repositoryId: 1234, commitSha: "a".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "c".repeat(40) };

describe("registered CLI publication context", () => {
  it("holds when enrollment is missing instead of inferring standalone from an empty registry", () => {
    expect(resolveLoopEnrollment([], host)).toEqual({ kind: "hold", reasonCode: "provenance_unknown" });
  });

  it("holds when a saved enrollment is corrupt instead of treating its absence as unmanaged", () => {
    expect(StandaloneEnrollmentSchema.safeParse({ ...standalone, repositoryId: 0 }).success).toBe(false);
    expect(RegisteredEnrollmentSchema.safeParse({ ...registered, sourceBindingRef: "" }).success).toBe(false);
    expect(RegisteredPendingEnrollmentSchema.safeParse({ ...pending, sources: [] }).success).toBe(false);
  });

  it("admits only an explicit standalone receipt matching the current host, account, project and source", () => {
    expect(resolveLoopEnrollment([standalone], host)).toMatchObject({ kind: "unmanaged-local", enrollmentId: "local-1" });
    expect(resolveLoopEnrollment([standalone], { ...host, repositoryId: 9999 })).toEqual({ kind: "hold", reasonCode: "identity_changed" });
    expect(resolveLoopEnrollment([standalone], { ...host, hostId: "host-b" })).toEqual({ kind: "hold", reasonCode: "identity_changed" });
  });

  it("keeps a registered source sticky when a standalone receipt or fork context appears later", () => {
    expect(resolveLoopEnrollment([standalone, registered], host)).toMatchObject({ kind: "registered", project: "payments-service", repositoryId: 1234 });
    expect(resolveLoopEnrollment([registered], { ...host, repo: "fork/payments" })).toEqual({ kind: "hold", reasonCode: "identity_changed" });
    expect(resolveLoopEnrollment([registered], { ...host, repo: "fork/payments", repositoryId: 5678 })).toEqual({ kind: "hold", reasonCode: "identity_changed" });
  });

  it("requires the original source and actual changed target to resolve before a standalone lane is admitted", () => {
    const target = { ...host, repo: "acme/web", repositoryId: 5678, checkoutPath: "/work/web", commonGitDir: "/work/web/.git" };
    const targetRegistered = { ...registered, repository: "acme/web", repositoryId: 5678, checkoutPath: "/work/web", commonGitDir: "/work/web/.git" };
    expect(resolvePublicationScopes({ records: [standalone, targetRegistered], source: host, target, destinationRepo: "acme/web" }))
      .toMatchObject({ kind: "hold", reasonCode: "registered_target_join_unavailable" });

    const targetStandalone = { ...standalone, project: "acme/web", repositoryId: 5678, checkoutPath: "/work/web", commonGitDir: "/work/web/.git" };
    expect(resolvePublicationScopes({ records: [standalone, targetStandalone], source: host, target, destinationRepo: "acme/web" }))
      .toMatchObject({ kind: "unmanaged-local" });
    expect(resolvePublicationScopes({ records: [standalone, targetStandalone], source: host, target, destinationRepo: "fork/web" }))
      .toMatchObject({ kind: "hold", reasonCode: "identity_changed" });
  });

  it("keeps a successful native registration pending when source reconciliation fails", () => {
    expect(resolveLoopEnrollment([standalone, pending], host)).toEqual({ kind: "hold", reasonCode: "native_enrollment_pending" });
  });

  it("requires a server join and holds if the native task reference is missing", async () => {
    await expect(resolveRegisteredPublication({ enrollment: registered, subject, taskRef: undefined, transport: undefined, now: Date.parse("2026-10-14T10:01:00.000Z") }))
      .resolves.toEqual({ kind: "hold", reasonCode: "task_binding_missing" });
  });

  it("accepts only a fresh server READY bound to the exact observed subject", async () => {
    const transport = { load: async () => ({
      schemaVersion: 1, status: "READY", subject, candidateDigest: "d".repeat(64), contractDigest: "e".repeat(64),
      policyDigest: "f".repeat(64), planDigest: "1".repeat(64), roundId: "round-1", evidenceSetDigest: "2".repeat(64), checkedAt: "2026-10-14T10:01:00.000Z",
    }) };
    await expect(resolveRegisteredPublication({ enrollment: registered, subject, taskRef: "task-1", transport, now: Date.parse("2026-10-14T10:01:10.000Z") }))
      .resolves.toMatchObject({ kind: "ready", subject, response: { candidateDigest: "d".repeat(64) } });
    await expect(resolveRegisteredPublication({ enrollment: registered, subject: { ...subject, treeSha: "3".repeat(40) }, taskRef: "task-1", transport, now: Date.parse("2026-10-14T10:01:10.000Z") }))
      .resolves.toMatchObject({ kind: "hold", reasonCode: "subject_mismatch" });
  });

  it("holds server UNKNOWN, stale READY, and malformed responses", async () => {
    const run = (response: unknown, now = Date.parse("2026-10-14T10:01:00.000Z")) => resolveRegisteredPublication({
      enrollment: registered, subject, taskRef: "task-1", transport: { load: async () => response }, now,
    });
    await expect(run({ schemaVersion: 1, status: "UNKNOWN", subject, reasonCode: "missing_evidence", checkedAt: "2026-10-14T10:00:59.000Z" }))
      .resolves.toMatchObject({ kind: "hold", reasonCode: "missing_evidence" });
    await expect(run({ schemaVersion: 1, status: "READY", subject, candidateDigest: "d".repeat(64), contractDigest: "e".repeat(64), policyDigest: "f".repeat(64), planDigest: "1".repeat(64), roundId: "round-1", evidenceSetDigest: "2".repeat(64), checkedAt: "2026-10-14T09:58:00.000Z" }))
      .resolves.toMatchObject({ kind: "hold", reasonCode: "server_observation_stale" });
    await expect(run({ schemaVersion: 1, status: "READY", subject, checkedAt: "2026-10-14T10:01:00.000Z" }))
      .resolves.toMatchObject({ kind: "hold", reasonCode: "server_response_invalid" });
  });
});
