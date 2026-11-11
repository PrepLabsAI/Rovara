// The current authority of an application round on Code's own records: every way the round's footing can move is a refusal with a fixed reason, and an install with no runtime registration
// to ask judges nothing.
import { describe, expect, it } from "vitest";
import { createLocalE2EAuthority, localOwnerAuthority, type LocalAuthorityDeps } from "../../packages/broker/src/core/e2e/local-authority.js";
import type { E2EVerificationDiagnostic } from "../../packages/broker/src/core/e2e/authority.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";

const COMPANY = "org_00000000000000000000";
const store = new MemoryDocumentStore();
const base = (over: Partial<LocalAuthorityDeps> = {}): LocalAuthorityDeps => ({ companyId: COMPANY, state: { store }, objects: createDocumentObjectStorage(store, { companyId: COMPANY }),
  projects: { latest: async () => undefined, revision: async () => undefined }, access: { checkStep: async () => ({ allowed: true }) }, operationsOf: async () => [], ...over });
const candidate = { digest: "c".repeat(64) } as never;
const admission = {} as never;
const taskWith = (workflow: unknown, extra: Record<string, unknown> = {}) => ({ taskId: "t1", project: "payments", developerId: "maya", startingRevision: 1, workflow, ...extra }) as never;
const judge = async (deps: LocalAuthorityDeps, task: never) => {
  const diagnostic: E2EVerificationDiagnostic = {};
  const ok = await createLocalE2EAuthority(deps).application({ task, candidate, admission }, diagnostic);
  return { ok, diagnostic };
};

describe("the local owner's proof", () => {
  it("is a direct administrator grant under a fixed grant id, a shape Cloud's admission schema reads", () => {
    expect(localOwnerAuthority("maya", "payments")).toEqual({ kind: "direct-membership", developerId: "maya", project: "payments", role: "administrator", grantId: "local-owner" });
  });
});

describe("judging an application round's current authority", () => {
  it("refuses a task with no required checks, on another candidate, or already closed", async () => {
    for (const task of [taskWith(undefined), taskWith({ e2e: { required: false }, candidate: { digest: "c".repeat(64) }, artifacts: [] }),
      taskWith({ e2e: { required: true }, candidate: { digest: "d".repeat(64) }, artifacts: [] }),
      taskWith({ e2e: { required: true }, candidate: { digest: "c".repeat(64) }, artifacts: [] }, { closedAt: "2026-11-10T00:00:00.000Z" })]) {
      const { ok, diagnostic } = await judge(base(), task);
      expect(ok).toBe(false);
      expect(diagnostic.reason).toBe("current-task-or-approval-missing");
      expect(diagnostic.authorityEvaluated).toBe(true);
      expect(diagnostic.authorityChecks).toBeUndefined();
    }
  });

  it("refuses a task whose latest plan is not the one the checks were approved for", async () => {
    const task = taskWith({ e2e: { required: true, contractDigest: "a".repeat(64) }, candidate: { digest: "c".repeat(64) }, artifacts: [{ type: "plan", id: "p", sha256: "b".repeat(64) }] });
    expect((await judge(base(), task)).diagnostic.reason).toBe("current-canonical-plan-missing-or-stale");
  });

  it("refuses when the plan's object is missing or is not the bytes its digest names", async () => {
    const task = taskWith({ e2e: { required: true, contractDigest: "a".repeat(64) }, candidate: { digest: "c".repeat(64) },
      artifacts: [{ type: "plan", id: "p", sha256: "a".repeat(64), objectKey: "plans/missing", format: "structured" }] });
    expect((await judge(base(), task)).diagnostic.reason).toBe("canonical-artifact-or-owner-decision-mismatch");
  });
});
