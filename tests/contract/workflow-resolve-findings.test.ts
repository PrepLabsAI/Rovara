import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as workflowContracts from "../../packages/contracts/src/task-workflow.js";
import {
  WorkflowSnapshotSchema, WorkflowTransitionError, createCandidateManifest, createWorkflowSnapshot, submitWorkflowReview,
} from "../../packages/contracts/src/task-workflow.js";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const ownerId = "a".repeat(64);

describe("the owner resolves each blocking review finding", () => {
  const at = "2026-10-05T12:10:00.000Z";
  const candidate = createCandidateManifest([{ repositoryId: "payments", commitSha: "a".repeat(40), treeSha: "1".repeat(40) }]);
  const other = createCandidateManifest([{ repositoryId: "payments", commitSha: "b".repeat(40), treeSha: "2".repeat(40) }]);
  const verification = (digest: string) => ({ candidateDigest: digest, producer: "agentx-broker", environmentId: "ci", recordedAt: "2026-10-05T12:01:00.000Z", results: [{ checkId: "unit", status: "PASS" }] });
  const report = (role: "CRITIC" | "SECURITY", status: "PASS" | "FINDINGS" | "FAILED", findings: unknown[], digest = candidate.digest) =>
    ({ operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: digest, role, provider: "scripted", version: "1", status, findings, readOnly: true, recordedAt: "2026-10-05T12:03:00.000Z" });
  const parser = { text: "New parser drops the last line.", origin: "INTRODUCED" as const, file: "src/parse.ts", line: 12 };
  const token = { text: "Token is logged.", origin: "INTRODUCED" as const };
  const blockedWith = (reviews: unknown[], extra: Record<string, unknown> = {}) => WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-05T12:00:00.000Z" }), stage: "REVIEW", state: "BLOCKED", blockReason: "the critic review did not pass",
    revision: 6, candidate, verification: verification(candidate.digest), reviews, ...extra });
  const request = (workflow: { revision: number }, resolutions: Array<{ findingId: string; action: "ACCEPT" | "FIX"; note: string }>, requestId = "22222222-2222-4222-8222-222222222222") =>
    ({ requestId, expectedRevision: workflow.revision, candidateDigest: candidate.digest, resolutions });
  const id = (role: "CRITIC" | "SECURITY", finding: { text: string; file?: string; line?: number }) => workflowContracts.workflowFindingFingerprint(role, finding);
  const resolve = (workflow: unknown, input: unknown, actorId = ownerId) => workflowContracts.resolveWorkflowReviewFindings(workflow, input, { actorId }, { now: at });

  it("fingerprints a finding from its role, text, file and line, and lists the open ones", () => {
    expect(id("CRITIC", parser)).toMatch(/^[a-f0-9]{64}$/);
    expect(id("CRITIC", parser)).toBe(id("CRITIC", { ...parser }));
    expect(id("SECURITY", parser)).not.toBe(id("CRITIC", parser));
    expect(id("CRITIC", { text: parser.text })).not.toBe(id("CRITIC", parser));
    expect(id("CRITIC", { ...parser, line: 13 })).not.toBe(id("CRITIC", parser));
    const workflow = blockedWith([report("CRITIC", "FINDINGS", [parser, { text: "Old code", origin: "PRE_EXISTING" }]), report("SECURITY", "FINDINGS", [token])]);
    expect(workflowContracts.openReviewFindings(workflow)).toEqual([
      { findingId: id("CRITIC", parser), role: "CRITIC", text: parser.text, file: "src/parse.ts", line: 12 },
      { findingId: id("SECURITY", token), role: "SECURITY", text: token.text },
    ]);
  });

  it("moves to the pull request stage when every finding is accepted, recording each with its reason, candidate, owner and time", () => {
    const workflow = blockedWith([report("CRITIC", "FINDINGS", [parser]), report("SECURITY", "FINDINGS", [token])]);
    const next = resolve(workflow, request(workflow, [{ findingId: id("CRITIC", parser), action: "ACCEPT", note: "  The last line is a footer we drop on purpose. " }, { findingId: id("SECURITY", token), action: "ACCEPT", note: "Test token only." }]));
    expect(next).toMatchObject({ stage: "PULL_REQUEST", state: "READY", revision: 7 });
    expect(next.blockReason).toBeUndefined();
    expect(next.acceptedFindings).toEqual([
      { candidateDigest: candidate.digest, role: "CRITIC", fingerprint: id("CRITIC", parser), text: parser.text, reason: "The last line is a footer we drop on purpose.", actorId: ownerId, at },
      { candidateDigest: candidate.digest, role: "SECURITY", fingerprint: id("SECURITY", token), text: token.text, reason: "Test token only.", actorId: ownerId, at },
    ]);
    expect(next.decisions.at(-1)).toMatchObject({ requestId: "22222222-2222-4222-8222-222222222222", source: "FINDINGS", actorId: ownerId, actorRole: "TASK_OWNER" });
    // The stored reviews are untouched, and no finding is open or sent back any more.
    expect(next.reviews).toEqual(workflow.reviews);
    expect(workflowContracts.openReviewFindings(next)).toEqual([]);
    expect(workflowContracts.sendBackProblems(next)).toEqual([]);
  });

  it("sends only the fix findings back to coding, and still records the accepted one", () => {
    const workflow = blockedWith([report("CRITIC", "FINDINGS", [parser]), report("SECURITY", "FINDINGS", [token])]);
    const next = resolve(workflow, request(workflow, [{ findingId: id("CRITIC", parser), action: "FIX", note: "Keep the footer line." }, { findingId: id("SECURITY", token), action: "ACCEPT", note: "Test token only." }]));
    expect(next).toMatchObject({ stage: "IMPLEMENT", state: "READY", revision: 7 });
    expect(next.decisions.at(-1)).toMatchObject({ decision: "REQUEST_CHANGES", source: "FINDINGS" });
    expect(next.acceptedFindings?.map((entry) => entry.fingerprint)).toEqual([id("SECURITY", token)]);
    expect(workflowContracts.sendBackProblems(next)).toEqual([{ source: "code review", text: "New parser drops the last line. (src/parse.ts:12)" }]);
  });

  it("refuses an accept with no reason, a missing, unknown or repeated finding, a stale revision or digest, and anyone but the owner", () => {
    const workflow = blockedWith([report("CRITIC", "FINDINGS", [parser]), report("SECURITY", "FINDINGS", [token])]);
    const both = [{ findingId: id("CRITIC", parser), action: "ACCEPT" as const, note: "ok" }, { findingId: id("SECURITY", token), action: "ACCEPT" as const, note: "ok" }];
    expect(() => resolve(workflow, request(workflow, [{ ...both[0]!, note: "   " }, both[1]!]))).toThrow(/reason/);
    expect(() => resolve(workflow, request(workflow, [{ ...both[0]!, note: "x".repeat(501) }, both[1]!]))).toThrow(WorkflowTransitionError);
    expect(() => resolve(workflow, request(workflow, [{ findingId: id("CRITIC", parser), action: "FIX", note: "x".repeat(1_001) }, both[1]!]))).toThrow(WorkflowTransitionError);
    expect(() => resolve(workflow, request(workflow, [both[0]!]))).toThrow(/every blocking finding/);
    expect(() => resolve(workflow, request(workflow, [...both, { findingId: "f".repeat(64), action: "FIX", note: "" }]))).toThrow(/not a current blocking finding/);
    expect(() => resolve(workflow, request(workflow, [both[0]!, both[0]!]))).toThrow(WorkflowTransitionError);
    expect(() => resolve(workflow, request(workflow, []))).toThrow(WorkflowTransitionError);
    expect(() => resolve(workflow, { ...request(workflow, both), expectedRevision: 5 })).toThrow(/stale/);
    expect(() => resolve(workflow, { ...request(workflow, both), candidateDigest: other.digest })).toThrow(/candidate/);
    expect(() => resolve(workflow, request(workflow, both), "c".repeat(64))).toThrow(/owner/);
    // Not at a blocked review: nothing to resolve.
    expect(() => resolve({ ...workflow, state: "WAITING" }, request(workflow, both))).toThrow(WorkflowTransitionError);
  });

  it("is idempotent by request ID", () => {
    const workflow = blockedWith([report("CRITIC", "FINDINGS", [parser]), report("SECURITY", "PASS", [])]);
    const input = request(workflow, [{ findingId: id("CRITIC", parser), action: "ACCEPT", note: "Fine." }]);
    const next = resolve(workflow, input);
    expect(resolve(next, input)).toEqual(next);
    expect(() => resolve(next, { ...input, expectedRevision: workflow.revision + 5 })).toThrow(WorkflowTransitionError);
  });

  it("stays blocked after an accept when another review has not passed, and never weakens PR readiness", () => {
    const workflow = blockedWith([report("CRITIC", "FINDINGS", [parser]), report("SECURITY", "FAILED", [])]);
    const next = resolve(workflow, request(workflow, [{ findingId: id("CRITIC", parser), action: "ACCEPT", note: "Fine." }]));
    expect(next).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    expect(next.acceptedFindings).toHaveLength(1);
    // Accepted findings do not make an unaccepted, failed or other-candidate review pass.
    const ready = (reviews: unknown[], accepted: unknown[]) => WorkflowSnapshotSchema.safeParse({ ...next, stage: "PULL_REQUEST", state: "READY", reviews, acceptedFindings: accepted }).success;
    const accepted = next.acceptedFindings!;
    expect(ready([report("CRITIC", "FINDINGS", [parser]), report("SECURITY", "PASS", [])], accepted)).toBe(true);
    expect(ready([report("CRITIC", "FINDINGS", [parser]), report("SECURITY", "PASS", [])], [])).toBe(false);
    expect(ready([report("CRITIC", "FINDINGS", [parser, token]), report("SECURITY", "PASS", [])], accepted)).toBe(false);
    expect(ready([report("CRITIC", "FINDINGS", [parser]), report("SECURITY", "FAILED", [])], accepted)).toBe(false);
    expect(ready([report("CRITIC", "FINDINGS", [parser]), report("SECURITY", "PASS", [])], accepted.map((entry) => ({ ...entry, candidateDigest: other.digest })))).toBe(false);
    expect(ready([report("CRITIC", "FINDINGS", [parser]), report("SECURITY", "PASS", [])], accepted.map((entry) => ({ ...entry, role: "SECURITY" })))).toBe(false);
  });

  it("does not block a retried review on the same candidate for a finding already accepted, but does for a new one", () => {
    const first = blockedWith([report("CRITIC", "FINDINGS", [parser]), report("SECURITY", "PASS", [])]);
    const accepted = resolve(first, request(first, [{ findingId: id("CRITIC", parser), action: "ACCEPT", note: "Fine." }]));
    // The owner retried the reviews instead: the stored reviews are cleared and the same findings come back.
    const retrying = WorkflowSnapshotSchema.parse({ ...first, stage: "REVIEW", state: "WAITING", reviews: [], acceptedFindings: accepted.acceptedFindings });
    const repeated = submitWorkflowReview(submitWorkflowReview(retrying, report("SECURITY", "PASS", []), at), report("CRITIC", "FINDINGS", [parser]), at);
    expect(repeated).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
    const fresh = submitWorkflowReview(submitWorkflowReview(retrying, report("SECURITY", "PASS", []), at), report("CRITIC", "FINDINGS", [parser, { text: "Another problem.", origin: "INTRODUCED" }]), at);
    expect(fresh).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    expect(workflowContracts.openReviewFindings(fresh).map((entry) => entry.text)).toEqual(["Another problem."]);
  });

  it("does not apply accepted findings to a new candidate", () => {
    const first = blockedWith([report("CRITIC", "FINDINGS", [parser]), report("SECURITY", "PASS", [])]);
    const mixed = resolve(first, request(first, [{ findingId: id("CRITIC", parser), action: "ACCEPT", note: "Fine." }]));
    expect(mixed.acceptedFindings).toHaveLength(1);
    // The same finding on another candidate is open again.
    const again = blockedWith([report("CRITIC", "FINDINGS", [parser], other.digest), report("SECURITY", "PASS", [], other.digest)],
      { candidate: other, acceptedFindings: mixed.acceptedFindings, verification: verification(other.digest) });
    expect(workflowContracts.openReviewFindings(again).map((entry) => entry.findingId)).toEqual([id("CRITIC", parser)]);
    expect(workflowContracts.workflowSendBackOffered(again)).toBe(true);
    expect(workflowContracts.sendBackProblems(again)).toHaveLength(1);
  });

  it("keeps at most 100 accepted findings, dropping the oldest", () => {
    const old = Array.from({ length: 100 }, (_, index) => ({ candidateDigest: other.digest, role: "CRITIC", fingerprint: createHash("sha256").update(String(index)).digest("hex"), text: `old ${index}`, reason: "ok", actorId: ownerId, at }));
    const workflow = blockedWith([report("CRITIC", "FINDINGS", [parser]), report("SECURITY", "PASS", [])], { acceptedFindings: old });
    const next = resolve(workflow, request(workflow, [{ findingId: id("CRITIC", parser), action: "ACCEPT", note: "ok" }]));
    expect(next.acceptedFindings).toHaveLength(100);
    expect(next.acceptedFindings?.at(-1)?.text).toBe(parser.text);
    expect(next.acceptedFindings?.[0]?.text).toBe("old 1");
  });

  it("refuses more than 20 findings in one resolution", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ text: `Problem ${index}`, origin: "INTRODUCED" as const }));
    const workflow = blockedWith([report("CRITIC", "FINDINGS", many), report("SECURITY", "FINDINGS", [token])]);
    const all = [...many.map((finding) => id("CRITIC", finding)), id("SECURITY", token)].map((findingId) => ({ findingId, action: "ACCEPT" as const, note: "ok" }));
    expect(() => resolve(workflow, request(workflow, all))).toThrow(/at most 20/);
  });
});
