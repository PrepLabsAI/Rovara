// TESTPROOF: the pull request shows one or two lines about test-proof.json, only when it is bound to the task's current candidate.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCandidateManifest, createWorkflowSnapshot, WorkflowSnapshotSchema, type TestProof } from "../../packages/contracts/src/index.js";
import { loadTestProofLines, testProofPullRequestLines } from "../../packages/broker/src/developer/test-proof-lines.js";
import { workflowPullRequestStatusLines } from "../../packages/broker/src/aws/developer-tasks.js";

const inert = (line: string) => line.replaceAll("@", "@‍").replace(/<[^>]*>/gu, "").trim();
const DIGEST = "a".repeat(64);
const OLD_DIGEST = "b".repeat(64);
const proof = (items: TestProof["items"], digest = DIGEST): TestProof => ({
  schemaVersion: 1, candidateDigest: digest, status: "checked", note: "completed", changedTests: { added: items.length, changed: 0, deleted: 0 }, items, durationMs: 10,
});
const item = (verdict: TestProof["items"][number]["verdict"], label = "npm test", extra: Partial<TestProof["items"][number]> = {}): TestProof["items"][number] => ({
  checkId: "readiness:0", label, granularity: "check", verdict,
  reason: verdict === "not_applicable" ? "not_a_test_check" : verdict === "proves_change" ? "assertion_failed_on_old" : verdict === "does_not_prove" ? "passed_on_old" : verdict === "could_not_run_on_old" ? "load_failure_on_old" : "timed_out", ...extra,
});

describe("test proof lines for the pull request", () => {
  // 8
  it("says which new tests fail on the original code, and warns about one that passes there too", () => {
    const lines = testProofPullRequestLines(proof([item("proves_change"), item("does_not_prove", "npm test -- unit")]), DIGEST, inert);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("Test proof: 1 check fails on the original code and passes now");
    expect(lines[1]).toContain("Warning");
    expect(lines[1]).toContain("npm test -- unit");
  });

  it("never counts or warns about a check that is not a test runner (lint)", () => {
    const lines = testProofPullRequestLines(proof([item("proves_change"), item("not_applicable", "npm run lint")]), DIGEST, inert);
    expect(lines).toEqual(["Test proof: 1 check fails on the original code and passes now"]);
    expect(testProofPullRequestLines(proof([item("not_applicable", "npm run lint")]), DIGEST, inert)).toEqual([]);
  });

  it("strips an unclosed HTML comment opener and backticks from a quoted name", () => {
    const text = testProofPullRequestLines(proof([item("does_not_prove", "npm test <!-- hide the rest `code`")]), DIGEST, inert).join("\n");
    expect(text).not.toContain("<!--");
    expect(text).not.toContain("`");
    expect(text).toContain("npm test");
  });

  it("ignores a proof bound to an older candidate, and one that does not parse", () => {
    expect(testProofPullRequestLines(proof([item("proves_change")], OLD_DIGEST), DIGEST, inert)).toEqual([]);
    expect(testProofPullRequestLines({ nonsense: true }, DIGEST, inert)).toEqual([]);
    expect(testProofPullRequestLines(proof([item("proves_change")]), undefined, inert)).toEqual([]);
  });

  it("redacts and makes inert every label it quotes", () => {
    const secret = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const lines = testProofPullRequestLines(proof([item("does_not_prove", `ping @everyone <img src=x> token=${secret}`)]), DIGEST, inert);
    const text = lines.join("\n");
    expect(text).toContain("@‍everyone");
    expect(text).not.toContain("<img");
    expect(text).not.toContain(secret);
  });

  it("is silent when no test changed", () => {
    expect(testProofPullRequestLines({ ...proof([]), status: "no_changed_tests", note: "no_changed_tests" }, DIGEST, inert)).toEqual([]);
  });

  it("is part of the pull request status lines when given, and leaves them as they were when not", () => {
    const now = new Date().toISOString();
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
    const workflow = WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId: randomUUID(), ownerId: "b".repeat(64), now }), revision: 5, stage: "PULL_REQUEST", state: "READY", candidate,
      verification: { candidateDigest: candidate.digest, producer: "t", environmentId: "w", recordedAt: now, results: [{ checkId: "required-1", status: "PASS" }] },
      reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: randomUUID(), candidateDigest: candidate.digest, role, provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })) });
    const plain = workflowPullRequestStatusLines(workflow);
    expect(workflowPullRequestStatusLines(workflow, ["Test proof: 1 check fails on the original code and passes now"])).toEqual([...plain, "Test proof: 1 check fails on the original code and passes now"]);
  });

  it("reads the newest test-proof.json bound to the current candidate from the task's own operations, and no other task's", async () => {
    const task = { ownerKey: "owner", workspaceId: "ws" };
    const objects = new Map<string, string>([
      ["private/owner/ws/op-1/a1", JSON.stringify(proof([item("proves_change")], OLD_DIGEST))],
      ["private/owner/ws/op-2/a2", JSON.stringify(proof([item("proves_change")]))],
      ["private/other/ws/op-3/a3", JSON.stringify(proof([item("does_not_prove")]))],
    ]);
    const actions = {
      operations: async () => [
        { id: "op-1", kind: "task", status: "SUCCEEDED", createdAt: "2026-10-27T01:00:00.000Z" },
        { id: "op-2", kind: "task", status: "SUCCEEDED", createdAt: "2026-10-27T02:00:00.000Z" },
        { id: "op-3", kind: "task", status: "SUCCEEDED", createdAt: "2026-10-27T03:00:00.000Z" },
      ],
      artifacts: async (_ws: string, operationId: string) => [{ name: "test-proof.json", objectKey: `private/${operationId === "op-3" ? "other" : "owner"}/ws/${operationId}/a${operationId.slice(-1)}` }],
      readArtifact: async (key: string) => objects.get(key) ?? "",
    };
    expect(await loadTestProofLines(actions, task, DIGEST, inert)).toEqual(["Test proof: 1 check fails on the original code and passes now"]);
    expect(await loadTestProofLines(actions, task, "c".repeat(64), inert)).toEqual([]);
    expect(await loadTestProofLines({ ...actions, readArtifact: async () => { throw new Error("S3 down"); } }, task, DIGEST, inert)).toEqual([]);
  });
});
