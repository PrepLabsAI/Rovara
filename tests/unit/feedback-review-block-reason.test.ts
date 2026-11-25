// REDACT-BLOCK-REASON (Opus review F1): the legacy hosted PR feedback review view (getWorkflowFeedbackReview) shows the stored block reason redacted and cut to 500. The review's report and comment records are
// built here with their real digests and read through the same checks the route runs.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot } from "@agentx/contracts";
import { getWorkflowFeedbackReview } from "../../packages/broker/src/aws/developer-tasks.js";
import { OWNER_KEY, PRIYA, pageTask } from "../support/page-tasks.js";

// Built at run time: no key-shaped literal is in this file.
const token = (): string => ["ghp_", "Ab12".repeat(9)].join("");
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const raw = (): string => `Rovara stopped while planning: clone failed https://x-access-token:${token()}@github.com/org/repo (password Tr0ub4dor&3)`;

function reviewedTask(blockReason: string | undefined) {
  const f = pageTask({ shared: false });
  const task = f.db.get(`DEVTASK#${f.taskId}`, "META") as unknown as { workspaceId: string; ownerKey: string };
  const now = "2026-11-25T10:00:00.000Z";
  const candidate = createCandidateManifest([{ repositoryId: "payments", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
  const body = "please add a retry";
  const comments = [{ id: "comment-1", kind: "DISCUSSION" as const, url: "https://github.com/acme/payments/pull/11#issuecomment-1", author: "reviewer", updatedAt: now,
    bodyDigest: sha(body), bodyBytes: Buffer.byteLength(body, "utf8"), body }];
  const bundleMeta = { schemaVersion: 1 as const, taskId: f.taskId, repositoryId: "payments", number: 11, headSha: "a".repeat(40), candidateDigest: candidate.digest,
    commentSetDigest: sha(JSON.stringify(comments)), producer: "agentx-github-reconciler", version: "1", recordedAt: now };
  const bundleText = JSON.stringify({ ...bundleMeta, comments, sourceDeliveryIds: [] });
  const bundleDigest = sha(bundleText);
  const bundleKey = `private/${task.ownerKey}/${task.workspaceId}/feedback/${bundleDigest}.json`;
  f.objects.set(bundleKey, bundleText);
  const findingRef = { id: "finding-1", bundleDigest, commentIds: ["comment-1"], priority: "MUST_FIX" as const, assessment: "ACTIONABLE" as const, recommended: true };
  const reviewMeta = { schemaVersion: 1 as const, taskId: f.taskId, workflowRevision: 4, operationMode: "FEEDBACK_REVIEW" as const, qualification: "AI_GENERATED_ADVISORY" as const,
    proposalDigest: "f".repeat(64), taskRequirementsDigest: "1".repeat(64),
    candidateBindings: [{ repositoryId: "payments", number: 11, headSha: "a".repeat(40), candidateDigest: candidate.digest, commentSetDigest: bundleMeta.commentSetDigest, bundleDigest }],
    operationId: "11111111-1111-4111-8111-111111111111", provider: "scripted", version: "1", status: "COMPLETE" as const, bundleDigests: [bundleDigest], findingRefs: [findingRef], recordedAt: now };
  const reportText = JSON.stringify({ ...reviewMeta, findings: [{ ...findingRef, evidence: [{ source: "candidate", reference: "src/retry.ts" }], rationale: "The failure needs a bounded retry.",
    confidence: { level: "HIGH", reason: "The candidate lacks a retry." }, proposedDisposition: "IMPLEMENT",
    fixProposal: { summary: "Handle the failure.", fileChanges: [{ repositoryId: "payments", path: "src/retry.ts", operation: "MODIFY", change: "Add a bounded retry." }], tests: [] } }] });
  const reportDigest = sha(reportText);
  const reportKey = `private/${task.ownerKey}/${task.workspaceId}/feedback-reviews/${reportDigest}.json`;
  f.objects.set(reportKey, reportText);
  f.setWorkflow(WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: f.taskId, ownerId: OWNER_KEY, now }), revision: 4, stage: "WAIT_FOR_MERGE", state: blockReason === undefined ? "WAITING" : "BLOCKED", ...(blockReason === undefined ? {} : { blockReason }), candidate,
    verification: { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "test", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: ["CRITIC", "SECURITY"].map(role => ({ operationId: "22222222-2222-4222-8222-222222222222", candidateDigest: candidate.digest, role, provider: "scripted", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })),
    pullRequests: [{ repositoryId: "payments", number: 11, url: "https://github.com/acme/payments/pull/11", candidateDigest: candidate.digest, required: true, state: "OPEN" }],
    feedbackReview: { status: "PENDING",
      bundleRefs: [{ ...bundleMeta, comments: comments.map((comment) => ({ id: comment.id, kind: comment.kind, url: comment.url, author: comment.author, updatedAt: comment.updatedAt, bodyDigest: comment.bodyDigest, bodyBytes: comment.bodyBytes })), sha256: bundleDigest, objectKey: bundleKey }],
      reviewRef: { ...reviewMeta, sha256: reportDigest, objectKey: reportKey } },
  }));
  return f;
}

describe("the PR feedback review view of the hosted engine", () => {
  it("shows a block reason stored raw redacted, and cut to 500 after the redaction", async () => {
    const f = reviewedTask(raw());
    const view = await getWorkflowFeedbackReview(f.deps, PRIYA, f.taskId);
    expect(view["findings"]).toHaveLength(1);
    const shown = String(view["blockReason"]);
    expect(shown).toContain("[REDACTED]");
    expect(shown).not.toContain(token());
    expect(shown).not.toContain("Tr0ub4dor");
    expect(shown.length).toBeLessThanOrEqual(500);
    // Never rewrite history: the stored workflow holds what it held.
    expect((f.db.get(`DEVTASK#${f.taskId}`, "META") as { workflow: { blockReason: string } }).workflow.blockReason).toBe(raw());
  });

  it("leaves a view with no reason without one", async () => {
    const f = reviewedTask(undefined);
    const view = await getWorkflowFeedbackReview(f.deps, PRIYA, f.taskId);
    expect(view["findings"]).toHaveLength(1);
    expect(view).not.toHaveProperty("blockReason");
  });
});
