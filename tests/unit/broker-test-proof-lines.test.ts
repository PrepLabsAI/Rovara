// TESTPROOF: the pull request shows one or two lines about test-proof.json, only when it is bound to the task's current candidate.
import { describe, expect, it } from "vitest";
import { type TestProof } from "../../packages/contracts/src/index.js";
import { testProofPullRequestLines } from "../../packages/broker/src/developer/test-proof-lines.js";
import { expectLinearScaling } from "../support/scaling.js";

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

  it("ignores a proof bound to an older candidate, and one that does not parse", () => {
    expect(testProofPullRequestLines(proof([item("proves_change")], OLD_DIGEST), DIGEST, inert)).toEqual([]);
    expect(testProofPullRequestLines({ nonsense: true }, DIGEST, inert)).toEqual([]);
    expect(testProofPullRequestLines(proof([item("proves_change")]), undefined, inert)).toEqual([]);
  });

  it("is silent when no test changed", () => {
    expect(testProofPullRequestLines({ ...proof([]), status: "no_changed_tests", note: "no_changed_tests" }, DIGEST, inert)).toEqual([]);
  });
  // Re-pointed (D1-2 test review E4): this was proved through the deleted v1 loader; the live reader the core's PR text uses is testProofPullRequestLines (core/proof/proof-table.ts).
  it("says the vacuous check without leaking a hostile proving label, refuses an oversize label whole, and scales linearly", () => {
    const secret = `gh${"p"}_${"q".repeat(36)}`;
    const hostile = `[nested [link]](https://evil.example) ![image][ref]\n[ref]: https://evil.example\n@team #123 <img>\n# heading\n> quote\n---\n\`\`\`\n~~~\n\u200b\u202e\ufe0f ${secret}`;
    // with an identity `inert`, so what is checked is the function's own sanitising (backticks, angle brackets, newlines, the secret), not the caller's
    const lines = testProofPullRequestLines(proof([item("does_not_prove", hostile)]), DIGEST, (line) => line);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("does not prove the change");
    // no secret, no markup that could reshape the description, and one line
    for (const forbidden of [secret, "<", ">", "`", "\n"]) expect(lines[0], forbidden).not.toContain(forbidden);
    // the cost of refusing an oversize label does not grow faster than the label, and the 1 MiB label is refused whole (the proof is then ignored)
    let refused: string[] | undefined;
    expectLinearScaling((size) => {
      const oversize = proof([item("does_not_prove", hostile + "x".repeat(size))]);
      return () => { refused = testProofPullRequestLines(oversize, DIGEST, inert); };
    }, { n: 32_768, label: "refusing an oversize proof label" });
    expect(refused).toEqual([]);
    expect(testProofPullRequestLines(proof([item("does_not_prove", hostile + "x".repeat(1_048_576))]), DIGEST, inert)).toEqual([]);
    // 200 checks are said once, in one line, and the cost scales with their number
    let counted: string[] | undefined;
    expectLinearScaling((count) => {
      const items = Array.from({ length: count }, (_, i) => item("proves_change", "x".repeat(1024), { checkId: `readiness:${i}` }));
      const many = proof(items);
      return () => { counted = testProofPullRequestLines(many, DIGEST, inert); };
    }, { n: 25, unitBytes: 1200, label: "200 proof checks" });
    expect(counted).toEqual(["Test proof: 200 checks fail on the original code and pass now"]);
  });
});
