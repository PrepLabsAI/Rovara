import { describe, expect, it } from "vitest";
import { ciProof, githubCheckRuns, latestGateRun, type CheckRun } from "../../scripts/release-ci-proof.js";

// #1145: the release skips its own checks only when CI's gate passed on exactly the code it releases.
const MERGE = "a".repeat(40), BASE = "b".repeat(40), HEAD = "c".repeat(40);
const TREE = "1".repeat(40), OTHER_TREE = "2".repeat(40);

function gitOf(trees: Record<string, string>, parents: Record<string, string[]>) {
  return (...args: string[]): string | undefined => {
    if (args[0] === "rev-parse" && args[1] === "--verify") { const sha = args[2]!.replace("^{commit}", ""); return sha === "HEAD" ? MERGE : trees[sha] === undefined ? undefined : sha; }
    if (args[0] === "rev-parse") return trees[args[1]!.replace("^{tree}", "")];
    if (args[0] === "rev-list") return [args[4]!, ...(parents[args[4]!] ?? [])].join(" ");
    return undefined;
  };
}
const run = (over: Partial<CheckRun> = {}): CheckRun => ({ id: 10, status: "completed", conclusion: "success", completed_at: "2026-11-19T15:00:00Z", app: { slug: "github-actions" }, ...over });
const merge = { [MERGE]: TREE, [BASE]: OTHER_TREE, [HEAD]: TREE };

describe("the release's CI proof", () => {
  it("is proven for a merge whose tree is the pull request head's, when the head's latest gate run passed", async () => {
    const asked: string[] = [];
    const proof = await ciProof({ repository: "o/r", commit: "HEAD", git: gitOf(merge, { [MERGE]: [BASE, HEAD] }), checkRuns: async (sha) => { asked.push(sha); return [run()]; } });
    expect(proof).toMatchObject({ proven: true, candidate: HEAD });
    expect(asked).toEqual([HEAD]);
  });

  it("is not proven when the pull request was behind mainline (the merge's code differs from what CI ran)", async () => {
    const trees = { [MERGE]: TREE, [BASE]: OTHER_TREE, [HEAD]: OTHER_TREE };
    const proof = await ciProof({ repository: "o/r", commit: "HEAD", git: gitOf(trees, { [MERGE]: [BASE, HEAD] }), checkRuns: async () => [] });
    expect(proof.proven).toBe(false);
    expect(proof.reason).toContain("different code");
  });

  it("is not proven when the latest gate run failed, even if an older run passed", async () => {
    const proof = await ciProof({ repository: "o/r", commit: "HEAD", git: gitOf(merge, { [MERGE]: [BASE, HEAD] }), checkRuns: async () => [run({ id: 1 }), run({ id: 2, conclusion: "failure" })] });
    expect(proof.proven).toBe(false);
    expect(proof.reason).toContain("completed/failure");
  });

  it("is not proven while the gate is still running, or when GitHub cannot be read", async () => {
    const git = gitOf(merge, { [MERGE]: [BASE, HEAD] });
    expect((await ciProof({ repository: "o/r", commit: "HEAD", git, checkRuns: async () => [run({ status: "in_progress", conclusion: null })] })).proven).toBe(false);
    expect((await ciProof({ repository: "o/r", commit: "HEAD", git, checkRuns: async () => undefined })).proven).toBe(false);
  });

  it("ignores a gate check reported by anything but GitHub Actions", async () => {
    const proof = await ciProof({ repository: "o/r", commit: "HEAD", git: gitOf(merge, { [MERGE]: [BASE, HEAD] }), checkRuns: async () => [run({ app: { slug: "someone-else" } })] });
    expect(proof.proven).toBe(false);
  });

  it("can prove a commit CI ran on directly (no merge), and refuses a commit that is not in the checkout", async () => {
    const solo = { [MERGE]: TREE, [BASE]: OTHER_TREE };
    expect(await ciProof({ repository: "o/r", commit: "HEAD", git: gitOf(solo, { [MERGE]: [BASE] }), checkRuns: async () => [run()] })).toMatchObject({ proven: true, candidate: MERGE });
    expect((await ciProof({ repository: "o/r", commit: "d".repeat(40), git: gitOf(solo, {}), checkRuns: async () => [run()] })).proven).toBe(false);
  });

  it("takes the newest GitHub Actions run as the gate's result", () => {
    expect(latestGateRun([run({ id: 3, conclusion: "failure" }), run({ id: 7 }), run({ id: 9, app: { slug: "other" } })])?.id).toBe(7);
  });

  it("reads check runs from GitHub without a token, and answers unknown on an error status or a network failure", async () => {
    const urls: string[] = [];
    const ok = githubCheckRuns("o/r", (async (url: string) => { urls.push(url); return new Response(JSON.stringify({ check_runs: [run()] }), { status: 200 }); }) as typeof fetch);
    expect(await ok(HEAD)).toHaveLength(1);
    expect(urls[0]).toBe(`https://api.github.com/repos/o/r/commits/${HEAD}/check-runs?check_name=local&per_page=100`);
    expect(await githubCheckRuns("o/r", (async () => new Response("rate limited", { status: 403 })))(HEAD)).toBeUndefined();
    expect(await githubCheckRuns("o/r", (async () => { throw new Error("offline"); }))(HEAD)).toBeUndefined();
  });
});
