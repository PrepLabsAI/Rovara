// TESTPROOF: the pull request shows one or two lines about test-proof.json, only when it is bound to the task's current candidate.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCandidateManifest, createWorkflowSnapshot, WorkflowSnapshotSchema, AGENT_REPLIES_UNCONFIRMED_WORDS, type TestProof } from "../../packages/contracts/src/index.js";
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

  it("cannot be made to rebuild a comment opener or a backtick by nesting", () => {
    for (const nasty of ["a <!<!<!------ b", "a <!<!<!<!--------", "a ``<<!-`-- b"]) {
      const text = testProofPullRequestLines(proof([item("does_not_prove", nasty)]), DIGEST, (line) => line).join("\n");
      expect(text.replace(/^Warning[^(]*\(/u, "")).not.toMatch(/[<>`]/u);
    }
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


describe("v1 reply provenance", () => {
  const task = { ownerKey: "owner", workspaceId: "ws" };
  const facts = (checkId = "readiness:0", taskMade = 1) => [{ checkId, taskMade, counted: 0 }];
  const load = async (newest: unknown, older: unknown = proof([item("proves_change")])) => {
    const reads: string[] = [];
    const listings: string[] = [];
    const lines = await loadTestProofLines({
      operations: async () => ["old", "new"].map((id, i) => ({ id, kind: "task", status: "SUCCEEDED", createdAt: `2026-11-14T0${i}:00:00.000Z` })),
      artifacts: async (_ws, id) => { listings.push(id); return [{ name: "test-proof.json", objectKey: `private/owner/ws/${id}/proof` }]; },
      readArtifact: async (key) => { reads.push(key); const value = key.includes("/new/") ? newest : older; return typeof value === "string" ? value : JSON.stringify(value); },
    }, task, DIGEST, inert);
    return { lines, reads, listings };
  };
  const countLine = "Test proof: 1 check fails on the original code and passes now";
  it("qualifies only a marked proving check on the newest candidate", async () => {
    const value = { ...proof([item("proves_change"), item("does_not_prove", "vacuous")]), scriptedReplies: facts() };
    const result = await load(value);
    expect(result.lines).toEqual([`${AGENT_REPLIES_UNCONFIRMED_WORDS}: ${countLine}`, "Warning: 1 check also passes on the original code, so it does not prove the change (vacuous)"]);
    expect(result.reads).toEqual(["private/owner/ws/new/proof"]);
    for (const scriptedReplies of [undefined, [], facts("readiness:0", 0), facts("readiness:1")]) {
      expect((await load({ ...proof([item("proves_change")]), scriptedReplies })).lines).toEqual([countLine]);
    }
    expect((await load({ ...proof([item("does_not_prove", "vacuous")]), scriptedReplies: facts() })).lines).toEqual(["Warning: 1 check also passes on the original code, so it does not prove the change (vacuous)"]);
    expect((await load({ ...proof([item("proves_change")], OLD_DIGEST), scriptedReplies: facts() })).lines).toEqual([countLine]);
  });
  it("never revives older proof after unreadable reply facts or a malformed marked proof", async () => {
    const secret = `gh${"p"}_${"z".repeat(36)}`;
    const valid = { ...proof([item("proves_change")]), scriptedReplies: facts() };
    const bad = [null, secret, {}, [{ checkId: "readiness:0" }], [{ ...facts()[0], taskMade: "1" }], [...facts(), ...facts()]];
    for (const value of [...bad.map((scriptedReplies) => ({ ...valid, scriptedReplies })), { ...valid, status: secret }, { ...valid, items: [{ ...item("proves_change"), verdict: secret }] }, { ...valid, candidateDigest: secret }, JSON.stringify(valid).slice(0, -1)]) {
      const result = await load(value);
      expect(result.lines).toEqual([]);
      expect(result.listings).toEqual(["new"]);
      expect(result.reads).toEqual(["private/owner/ws/new/proof"]);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });
  it("preserves legacy bytes for missing provenance and malformed unmarked roots", async () => {
    expect((await load(proof([item("proves_change")]))).lines.join("\n")).toBe(countLine);
    for (const value of [{ invalid: true }, null, 42]) expect((await load(value)).lines.join("\n")).toBe(countLine);
    expect((await load("{broken")).lines).toEqual([]);
  });
  it("uses fixed qualifier words without leaking hostile proving labels and bounds large input", async () => {
    const secret = `gh${"p"}_${"q".repeat(36)}`;
    const hostile = `[nested [link]](https://evil.example) ![image][ref]\n[ref]: https://evil.example\n@team #123 <img>\n# heading\n> quote\n---\n\`\`\`\n~~~\n\u200b\u202e\ufe0f ${secret}`;
    const started = performance.now();
    const value = { ...proof([item("proves_change", hostile)]), scriptedReplies: facts() };
    expect((await load(value)).lines).toEqual([`${AGENT_REPLIES_UNCONFIRMED_WORDS}: ${countLine}`]);
    expect((await load({ ...value, items: [item("proves_change", hostile + "x".repeat(1_048_576))] })).lines).toEqual([]);
    const items = Array.from({ length: 200 }, (_, i) => item("proves_change", "x".repeat(1024), { checkId: `readiness:${i}` }));
    expect((await load({ ...proof(items), scriptedReplies: items.map(({ checkId }) => ({ checkId, taskMade: 1, counted: 0 })) })).lines).toEqual([`${AGENT_REPLIES_UNCONFIRMED_WORDS}: Test proof: 200 checks fail on the original code and pass now`]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
