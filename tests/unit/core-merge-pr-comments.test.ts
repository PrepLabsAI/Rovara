// Lane L4-C B5: the comments of the CI fix loop and of a passing marked check (design pr-redesign.md 2.6): a comment is an event that needs a person, so a pass is silent, a fix round is told only after the pull request is out of
// draft, a stop is told once, and every name a repository wrote is inert.
import { describe, expect, it } from "vitest";
import { CI_FIX_COMMENT_MAX, ciFixComment, fixRoundComment, postCiFixComment, stuckComment } from "../../packages/broker/src/core/merge/pr-comments.js";
import { commentWorthy } from "../../packages/broker/src/core/ci-evidence/tracking.js";

const action = (kind: "fixing" | "stuck", slot: "ci_fix" | "branch_sync" = "ci_fix") => ({ slot, milestones: [{ n: 1, milestone: { kind } }] }) as never;

describe("which results are told in a comment", () => {
  // Mutant M8: a passed marked check posts a comment. Killed by the first assertion (and by tests/unit/ci-evidence-tracking.test.ts through the real pass).
  it("a failure is, a pass is not, and a pass that reverses a failure told before is", () => {
    expect(commentWorthy({ state: "failed" })).toBe(true);
    expect(commentWorthy({ state: "passed" })).toBe(false);
    const entry = { state: "passed" as const };
    expect(commentWorthy(entry, new Set([entry]))).toBe(true);
    expect(commentWorthy({ state: "passed" }, new Set([entry]))).toBe(false);
  });
});

describe("the CI fix loop's comments", () => {
  const input = { draft: false, rounds: 2, failing: ["Integration tests"] };
  it("a round after the pull request is out of draft is told with its number and what failed", () => {
    expect(ciFixComment(action("fixing"), input)).toBe("Rovara is fixing failing CI (round 2 of 3): Integration tests. The description is updated when the fix is pushed.");
  });
  // Mutant M9: a fix round on a draft is told (nobody has looked at a draft yet, so nothing they read can be stale).
  it("a round on a draft is silent", () => {
    expect(ciFixComment(action("fixing"), { ...input, draft: true })).toBeUndefined();
  });
  it("a stop is told whatever the draft state, once per decision", () => {
    expect(ciFixComment(action("stuck"), { ...input, draft: true })).toBe("Rovara could not fix Integration tests and has stopped. It needs a person: open this task in Rovara to see why and to let it go on.");
    expect(ciFixComment(action("stuck"), input)).toContain("has stopped");
  });
  it("another slot's decision, or no decision, is silent", () => {
    expect(ciFixComment(action("fixing", "branch_sync"), input)).toBeUndefined();
    expect(ciFixComment(undefined, input)).toBeUndefined();
    expect(ciFixComment({ slot: "ci_fix", milestones: [] } as never, input)).toBeUndefined();
  });
  it("names what a repository wrote inertly, at most three, and stays one short line", () => {
    const text = fixRoundComment({ round: 1, failing: ["@everyone [x](https://evil.example) Fixes ENG-1", "b", "c", "d", "e"] });
    expect(text).not.toMatch(/@(?!‍)|\]\(|https?:\/\/(?!‍)|\bENG-\d/u);
    expect(text).toContain("and 2 more");
    expect(text).not.toContain("\n");
    const long = stuckComment({ failing: ["x".repeat(5_000)] });
    expect(Array.from(long).length).toBeLessThanOrEqual(CI_FIX_COMMENT_MAX);
    expect(stuckComment({ failing: [] })).toContain("a check");
  });
  it("posts once, best effort: a host with no comments or a failure posts nothing and never throws", async () => {
    const posted: string[] = [];
    const host = { postComment: async (_ref: unknown, text: string) => { posted.push(text); } } as never;
    expect(await postCiFixComment(host, {} as never, "hello", {} as never, undefined)).toBe(true);
    expect(posted).toEqual(["hello"]);
    expect(await postCiFixComment(host, {} as never, undefined, {} as never, undefined)).toBe(false);
    expect(await postCiFixComment({}, {} as never, "x", {} as never, undefined)).toBe(false);
    const logged: string[] = [];
    expect(await postCiFixComment({ postComment: async () => { throw new TypeError("denied"); } }, {} as never, "x", {} as never, undefined, (event, fields) => logged.push(`${event}${JSON.stringify(fields)}`))).toBe(false);
    expect(logged).toEqual(['merge_tracking.ci_fix_comment_not_posted{"error":"TypeError"}']);
  });
});
