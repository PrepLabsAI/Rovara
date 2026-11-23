import { describe, expect, it } from "vitest";

import { buildTaskClosePreview, type TaskClosePreviewFacts } from "../../packages/broker/src/developer/task-close-preview.js";

const facts = {
  action: "discard", taskId: "11111111-1111-4111-8111-111111111111",
  companyId: "company-a", workspaceId: "22222222-2222-4222-8222-222222222222", actorId: "owner-a",
  taskStatus: "SUCCEEDED", workflow: { revision: 3, stage: "PLAN", state: "BLOCKED" },
  workspace: { status: "READY", fence: 7, activeOperationId: null },
  unpublished: [{ repository: "z", reasons: ["unpushed_head", "worktree_changes"] }, { repository: "a", reasons: ["untracked_files"] }],
  inspection: { operationId: "33333333-3333-4333-8333-333333333333", workspaceFence: 7, contentDigest: "a".repeat(64) },
} satisfies TaskClosePreviewFacts;
function build(value: TaskClosePreviewFacts = facts) {
  return buildTaskClosePreview(value);
}

describe("the facts a close confirmation shows", () => {
  it("shows exactly the canonical list covered by its digest", () => {
    const preview = build();
    expect(preview.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.unpublished).toEqual([{ repository: "a", reasons: ["untracked_files"] }, { repository: "z", reasons: ["worktree_changes", "unpushed_head"] }]);
    expect(preview).not.toHaveProperty("actorId");
    expect(preview).not.toHaveProperty("companyId");
  });
  it("normalizes equivalent list and reason ordering", () => {
    const reversed = { ...facts, unpublished: [...facts.unpublished].reverse().map((r) => ({ ...r, reasons: [...r.reasons].reverse() })) };
    expect(build(reversed)).toEqual(build());
  });
  it.each<Partial<TaskClosePreviewFacts>>([
    { action: "close" }, { workspaceId: "55555555-5555-4555-8555-555555555555" },
    { workspace: { ...facts.workspace, status: "STOPPED" } },
    { workspace: { ...facts.workspace, activeOperationId: "66666666-6666-4666-8666-666666666666" } },
    { inspection: { ...facts.inspection, operationId: "77777777-7777-4777-8777-777777777777" } }, { taskId: "44444444-4444-4444-8444-444444444444" }, { companyId: "company-b" }, { actorId: "owner-b" },
    { workspace: { ...facts.workspace, fence: 8 }, inspection: { ...facts.inspection, workspaceFence: 8 } }, { taskStatus: "FAILED" },
    { workflow: { ...facts.workflow, revision: 4 } },
    { inspection: { ...facts.inspection, contentDigest: "b".repeat(64) } },
    { unpublished: [{ repository: "z", reasons: ["untracked_files"] }] },
  ])("changes consent when a shown or scoped fact changes: %j", (changed) => {
    expect(build({ ...facts, ...changed }).digest).not.toBe(build().digest);
  });
  it("ignores unrelated comments, usage, followers and timestamps", () => {
    const unrelated = { ...facts, comments: ["new"], usage: 9, followers: ["new"], updatedAt: "later" };
    expect(build(unrelated).digest).toBe(build().digest);
  });
  it("rejects duplicate repository identities and reasons", () => {
    expect(() => build({ ...facts, unpublished: [facts.unpublished[0]!, facts.unpublished[0]!] })).toThrow();
    expect(() => build({ ...facts, unpublished: [{ repository: "z", reasons: ["untracked_files", "untracked_files"] }] })).toThrow();
  });
  it("cannot certify discard without a fingerprinted inspection", () => {
    expect(() => build({ ...facts, inspection: null as unknown as typeof facts.inspection })).toThrow();
  });
});
