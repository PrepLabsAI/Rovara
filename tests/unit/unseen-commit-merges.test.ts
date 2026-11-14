// DEC 213, review of PR #608: the walk over versions pushed between checks, on a host stub. A two-parent merge is judged by what it adds over BOTH parents (git show --cc), the walk spends only the reads it needs (and
// one unit of the pass's allowance a page), and each guard the review found untested has a case of its own.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type CodeHost, type PageBudget } from "@agentx/contracts";
import { BASE_HISTORY_READS_MAX, UNSEEN_WALK_MAX, commitFlagsOf, mergeOwnChanges, unseenCommits } from "../../packages/broker/src/core/merge/change-tier-read.js";
import { withUnseenCommits, withRecordedUnseen } from "../../packages/broker/src/core/build-step/tier-checks.js";
import { tierFromDiff } from "../../packages/broker/src/core/decisions/change-tier.js";

const scope = { orgId: IMPLICIT_COMPANY_ID };
const sha = (seed: string) => Buffer.from(seed).toString("hex").padEnd(40, "0");
const fakeKey = () => ["AKIA", "Q".repeat(16)].join("");
const pemLine = () => ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" ");
type F = { path: string; status: string; additions: number; deletions: number; patch?: string; entry?: { head: string; base: string } };
const clean = (path = "src/a.ts"): F => ({ path, status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;" });
const added = (path: string, ...lines: string[]): F => ({ path, status: "added", additions: lines.length, deletions: 0, patch: `@@ -0,0 +1,${String(lines.length)} @@\n${lines.map((line) => `+${line}`).join("\n")}` });
type Node = { parents: string[]; files?: F[]; complete?: unknown; second?: F[]; secondComplete?: unknown };

/** A host stub over a commit graph; every request it serves is counted (`calls`), by kind. */
function stub(graph: Record<string, Node>, extra: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const host = {
    commitParents: async (_r: unknown, rev: string) => { calls.push(`parents:${rev}`); return graph[rev]?.parents ?? [`${rev.slice(0, 39)}f`]; },
    commitChanges: async (_r: unknown, rev: string, _s: unknown, budget?: PageBudget) => {
      calls.push(`changes:${rev}`);
      budget?.beforeRequest();
      const node = graph[rev];
      if (node === undefined) throw new Error("no such commit");
      return { files: node.files ?? [clean()], complete: node.complete ?? true, parents: node.parents };
    },
    compareChanges: async (_r: unknown, base: string, head: string, _s: unknown, budget?: PageBudget) => {
      calls.push(`compare:${head}`);
      budget?.beforeRequest();
      const node = graph[head];
      if (node?.second === undefined || node.parents[1] !== base) throw new Error("no such comparison");
      return { files: node.second, complete: node.secondComplete ?? true };
    },
    baseBranchHead: async () => { calls.push("base-head"); throw new Error("no base branch"); },
    ...extra,
  } as unknown as CodeHost;
  return { host, calls, target: (headSha: string, baseBranch?: string) => [{ host, repositoryId: "demo", repositoryUrl: "https://github.com/example/demo.git", number: 1, headSha, ...(baseBranch === undefined ? {} : { baseBranch }) }] };
}
const [h, merge, mine, main, seen, base, x, y] = ["h", "mg", "mi", "ma", "s", "b", "x", "y"].map(sha) as [string, string, string, string, string, string, string, string];
const codes = (read: { flagged: Array<{ reasons: Array<{ code: string }> }> }) => read.flagged.flatMap((entry) => entry.reasons.map((reason) => reason.code));

describe("a merge's own changes (git show --cc)", () => {
  it("keeps only files changed against both parents, and in them only lines added (or removed) against both", () => {
    const first = { complete: true, files: [
      { path: "tests/fixtures/key.pem", status: "added", additions: 1, deletions: 0, patch: `@@ -0,0 +1 @@\n+${pemLine()}` },
      { path: "src/a.ts", status: "modified", additions: 2, deletions: 2, patch: "@@ -1,3 +1,3 @@\n ctx\n-old one\n+main line\n-old two\n+merge line" },
    ] };
    const second = { complete: true, files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1,2 +1,2 @@\n ctx\n-old two\n+merge line" }] };
    const own = mergeOwnChanges(first, second);
    expect(own.complete).toBe(true);
    expect(own.files.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(own.files[0]).toMatchObject({ additions: 1, deletions: 1, patch: "@@ -1,3 +1,3 @@\n ctx\n-old two\n+merge line" });
  });
  it("is not whole when either list is cut (or says anything but true)", () => {
    for (const [a, b] of [[false, true], [true, false], ["true", true], [true, 1]] as const) {
      expect(mergeOwnChanges({ files: [], complete: a as boolean }, { files: [], complete: b as boolean }).complete).toBe(false);
    }
  });
  it("a mode change against one parent only is not the merge's own; against both it is; the kind is the side's it did not change", () => {
    const changed = { path: "bin/run", status: "changed", additions: 0, deletions: 0 };
    expect(mergeOwnChanges({ files: [changed], complete: true }, { files: [{ ...changed, status: "modified" }], complete: true }).files[0]!.status).toBe("modified");
    expect(mergeOwnChanges({ files: [changed], complete: true }, { files: [changed], complete: true }).files[0]!.status).toBe("changed");
    const link = { ...changed, status: "modified", entry: { head: "symlink", base: "file" } };
    const fromSecond = mergeOwnChanges({ files: [link], complete: true }, { files: [{ ...link, entry: { head: "symlink", base: "symlink" } }], complete: true }).files[0] as F;
    expect(fromSecond.entry).toEqual({ head: "symlink", base: "symlink" });
    const own = mergeOwnChanges({ files: [link], complete: true }, { files: [link], complete: true }).files[0] as F;
    expect(own.entry).toEqual({ head: "symlink", base: "file" });
    expect((mergeOwnChanges({ files: [link], complete: true }, { files: [{ ...link, entry: undefined }], complete: true }).files[0] as F).entry).toBeUndefined();
  });
  it("a no-newline marker goes with the line it belongs to (a dropped line leaves no marker that reads as a link)", () => {
    const first = { complete: true, files: [{ path: "a.txt", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n x\n+y\n\\ No newline at end of file" }] };
    const second = { complete: true, files: [{ path: "a.txt", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-q\n+z" }] };
    const own = mergeOwnChanges(first, second);
    expect(own.files[0]!.patch).toBe("@@ -1 +1,2 @@\n x");
    expect(commitFlagsOf("demo", own)).toEqual([]);
  });
});

describe("the walk judges a merge between checks by its own changes (review probes)", () => {
  it("P1: an \"Update branch\" merge between checks whose main side added a test key fixture: not flagged, and scanned", async () => {
    const fixture = added("tests/fixtures/key.pem", pemLine());
    const t = stub({ [h]: { parents: [merge] }, [merge]: { parents: [seen, main], files: [fixture], second: [clean("src/task.ts")] } }, { baseBranchHead: async () => main });
    expect(await unseenCommits(t.target(h, "main"), new Set([seen, base]), scope)).toMatchObject({ count: 1, capped: false, unscanned: 0, flagged: [] });
    // The same fixture in an ordinary commit IS flagged (the rule fires; only the merge's view hides main's side).
    const plain = stub({ [h]: { parents: [x] }, [x]: { parents: [seen], files: [fixture] } });
    expect(codes(await unseenCommits(plain.target(h), new Set([seen]), scope))).toContain("secret_like_text");
  });
  it("P1b: main's side added a CRLF line and a ZWJ emoji: not flagged", async () => {
    const t = stub({ [h]: { parents: [merge] }, [merge]: { parents: [seen, main], files: [added("docs/win.md", "Hello world\r"), added("docs/emoji.md", "Team \u{1F469}‍\u{1F4BB} rocks")], second: [clean()] } }, { baseBranchHead: async () => main });
    expect(await unseenCommits(t.target(h, "main"), new Set([seen]), scope)).toMatchObject({ unscanned: 0, flagged: [] });
  });
  it("P2: an evil merge adding a .env (no pattern secret), a binary keystore and a workflow (in both diffs): flagged for each; the second read missing, refused or cut: not scanned", async () => {
    const env = added(".env", `${["DB", "PASSWORD"].join("_")}=${["hunter2", "prod", "xyz"].join("-")}`); // built at runtime: no key-shaped text in source
    const bin: F = { path: "certs/prod.p12", status: "added", additions: 0, deletions: 0 };
    const wf = added(".github/workflows/x.yml", "on: push");
    const graph = { [h]: { parents: [merge] }, [merge]: { parents: [mine, main], files: [env, bin, wf], second: [env, bin, wf, clean()] }, [mine]: { parents: [seen] } };
    const read = await unseenCommits(stub(graph, { baseBranchHead: async () => main }).target(h, "main"), new Set([seen]), scope);
    expect(read.flagged.map((entry) => entry.commit)).toEqual([merge]);
    expect(codes(read)).toEqual(expect.arrayContaining(["env_file", "unreadable_content"]));
    expect(read.flagged[0]!.reasons.map((reason) => reason.path)).toEqual(expect.arrayContaining([".env", "certs/prod.p12"]));
    expect(JSON.stringify(read)).not.toContain("hunter2");
    for (const extra of [{ compareChanges: undefined }, { compareChanges: async () => { throw new Error("down"); } }]) {
      expect((await unseenCommits(stub(graph, { baseBranchHead: async () => main, ...extra }).target(h, "main"), new Set([seen]), scope)).unscanned).toBe(1);
    }
    expect((await unseenCommits(stub({ ...graph, [merge]: { ...graph[merge]!, secondComplete: false } }, { baseBranchHead: async () => main }).target(h, "main"), new Set([seen]), scope)).unscanned).toBe(1);
  });
  it("P2b: a merge's own symlink or mode change, taken out by the next push, is flagged", async () => {
    const link: F = { path: "config/settings.json", status: "modified", additions: 0, deletions: 0, entry: { head: "symlink", base: "file" } };
    const mode: F = { path: "scripts/run.sh", status: "changed", additions: 0, deletions: 0, entry: { head: "executable", base: "file" } };
    const read = await unseenCommits(stub({ [h]: { parents: [merge] }, [merge]: { parents: [mine, main], files: [link, mode], second: [link, mode] }, [mine]: { parents: [seen] } }, { baseBranchHead: async () => main }).target(h, "main"), new Set([seen]), scope);
    expect(codes(read)).toEqual(expect.arrayContaining(["symlink_suspected", "mode_or_type_change"]));
  });
  it("P3: a commit on the FIRST-parent line that is also reachable from main's head is scanned (the base branch's history is searched only for a merge's second parent)", async () => {
    const keyed = added("src/k.ts", `k = "${fakeKey()}"`);
    const graph = { [h]: { parents: [y] }, [y]: { parents: [x] }, [x]: { parents: [seen], files: [keyed] }, [main]: { parents: [x] } };
    const t = stub(graph, { baseBranchHead: async () => main });
    expect((await unseenCommits(t.target(h, "main"), new Set([seen]), scope)).flagged.map((entry) => entry.commit)).toEqual([x]);
    expect(t.calls).not.toContain("base-head");
  });
  it("P4: an answer whose `complete` is anything but true is not scanned", async () => {
    for (const complete of ["true", 1, "yes", false]) {
      expect((await unseenCommits(stub({ [h]: { parents: [x] }, [x]: { parents: [seen], complete } }).target(h), new Set([seen]), scope)).unscanned).toBe(1);
    }
  });
  it("P5: the base branch's head cannot be read: main's commits are scanned as the task's", async () => {
    const t = stub({ [h]: { parents: [seen, main] }, [main]: { parents: [base] } });
    expect(await unseenCommits(t.target(h, "main"), new Set([seen, base]), scope)).toMatchObject({ count: 1, unscanned: 0, capped: false });
    expect(t.calls).toEqual([`parents:${h}`, "base-head", `changes:${main}`]);
  });
});

describe("the walk's cost", () => {
  it("an ordinary 3-commit push: 3 host reads (the head's parents and each in-between commit's changes), no base-branch read; a second pass on the same host reads nothing", async () => {
    const [c1, c2, c3, s] = ["c1", "c2", "c3", "s"].map(sha) as [string, string, string, string];
    const t = stub({ [c3]: { parents: [c2] }, [c2]: { parents: [c1] }, [c1]: { parents: [s] } }, { baseBranchHead: async () => sha("mh") });
    let charged = 0;
    const read = await unseenCommits(t.target(c3, "main"), new Set([s]), scope, () => { charged += 1; });
    expect(read).toMatchObject({ count: 2, capped: false, unscanned: 0, flagged: [] });
    expect(t.calls).toEqual([`parents:${c3}`, `changes:${c2}`, `changes:${c1}`]);
    expect(charged).toBe(3);
    t.calls.length = 0;
    expect(await unseenCommits(t.target(c3, "main"), new Set([s]), scope)).toMatchObject({ count: 2, unscanned: 0, flagged: [] });
    expect(t.calls).toEqual([]);
  });
  it("\"Update branch\" then a fix: 4 reads (the head's parents, the merge's two reads, main's head once)", async () => {
    const [fix, mg, mh, s] = ["fx", "mg2", "mh2", "s2"].map(sha) as [string, string, string, string];
    const t = stub({ [fix]: { parents: [mg] }, [mg]: { parents: [s, mh], files: [clean("docs/x.md")], second: [clean()] } }, { baseBranchHead: async () => { t.calls.push("base-head"); return mh; } });
    expect(await unseenCommits(t.target(fix, "main"), new Set([s]), scope)).toMatchObject({ count: 1, unscanned: 0, flagged: [] });
    expect(t.calls).toEqual([`parents:${fix}`, `changes:${mg}`, `compare:${mg}`, "base-head"]);
  });
  it("a flagged commit read from memory is still flagged; a commit that could not be scanned is asked again", async () => {
    const t = stub({ [h]: { parents: [x] }, [x]: { parents: [seen], files: [added("src/k.ts", `k = "${fakeKey()}"`)] } });
    expect((await unseenCommits(t.target(h), new Set([seen]), scope)).flagged.map((entry) => entry.commit)).toEqual([x]);
    t.calls.length = 0;
    expect((await unseenCommits(t.target(h), new Set([seen]), scope)).flagged.map((entry) => entry.commit)).toEqual([x]);
    expect(t.calls).toEqual([]);
    const cut = stub({ [h]: { parents: [x] }, [x]: { parents: [seen], complete: false } });
    await unseenCommits(cut.target(h), new Set([seen]), scope);
    cut.calls.length = 0;
    expect((await unseenCommits(cut.target(h), new Set([seen]), scope)).unscanned).toBe(1);
    expect(cut.calls).toEqual([`changes:${x}`]);
  });
  it("the memory is per organization: another organization's pass reads for itself", async () => {
    const t = stub({ [h]: { parents: [x] }, [x]: { parents: [seen] } });
    await unseenCommits(t.target(h), new Set([seen]), scope);
    t.calls.length = 0;
    await unseenCommits(t.target(h), new Set([seen]), { orgId: "org_other0000000000000000000" });
    expect(t.calls).toEqual([`parents:${h}`, `changes:${x}`]);
  });
  it("one unit of the pass's allowance a page, the deadline checked before each commit and each page; a used-up pass stops the walk (never counted as not scanned)", async () => {
    const pages = (count: number) => async (_r: unknown, rev: string, _s: unknown, budget?: PageBudget) => { for (let page = 0; page < count; page += 1) budget?.beforeRequest(); return { files: [clean()], complete: true, parents: rev === x ? [seen] : [x] }; };
    let charged = 0;
    const t = stub({ [h]: { parents: [x] } }, { commitChanges: pages(3) });
    await unseenCommits(t.target(h), new Set([seen]), scope, () => { charged += 1; });
    expect(charged).toBe(1 + 3); // the head's parents, then three pages of x
    // The allowance runs out on x's second page: the walk stops with it.
    let left = 2;
    const stopped = stub({ [h]: { parents: [x] } }, { commitChanges: pages(3) });
    await expect(unseenCommits(stopped.target(h), new Set([seen]), scope, () => { if (left === 0) throw Object.assign(new Error("used up"), { name: "GithubBudgetExhaustedError" }); left -= 1; })).rejects.toThrow("used up");
    // Before a commit: no read is asked once the pass is over.
    let open = 1;
    const before = stub({ [h]: { parents: [x] }, [x]: { parents: [seen] } });
    await expect(unseenCommits(before.target(h), new Set([seen]), scope, () => { if (open === 0) throw new Error("over"); open -= 1; })).rejects.toThrow("over");
    expect(before.calls).toEqual([`parents:${h}`]);
    // The base branch's head read is charged outside its own failure handling: a used-up pass is not taken for an unreadable branch (the hook refuses only that one request).
    const refuseOnly = (which: number) => { let call = 0; return () => { call += 1; if (call === which) throw new Error("over"); }; };
    const basePass = stub({ [h]: { parents: [seen, main] } }, { baseBranchHead: async () => main });
    await expect(unseenCommits(basePass.target(h, "main"), new Set([seen]), scope, refuseOnly(2))).rejects.toThrow("over");
    // A stop on a later page is thrown on, never taken for a host that could not answer (the hook refuses only x's second page).
    const pageStop = stub({ [h]: { parents: [x] }, [x]: { parents: [seen] } }, { commitChanges: pages(3) });
    await expect(unseenCommits(pageStop.target(h), new Set([seen]), scope, refuseOnly(3))).rejects.toThrow("over");
  });
  it("a merge whose second parent is a recorded base commit needs no base-branch read", async () => {
    const t = stub({ [h]: { parents: [seen, base] } }, { baseBranchHead: async () => { t.calls.push("base-head"); return main; } });
    expect(await unseenCommits(t.target(h, "main"), new Set([seen]), scope, undefined, new Map([["demo", [base]]]))).toMatchObject({ count: 0, unscanned: 0 });
    expect(t.calls).toEqual([`parents:${h}`]);
  });
});

describe("the guards the review found untested", () => {
  it("a head that is itself an octopus merge counts one commit not scanned, and nothing is walked", async () => {
    const t = stub({ [h]: { parents: [x, y, merge] } });
    expect(await unseenCommits(t.target(h), new Set([seen]), scope)).toEqual({ count: 0, capped: false, unscanned: 1, flagged: [] });
    expect(t.calls).toEqual([`parents:${h}`]);
  });
  it("an octopus merge between checks is not scanned even when the host would compare it, and its parents are not walked", async () => {
    const [c1, c2] = ["o1", "o2"].map(sha) as [string, string];
    const t = stub({ [h]: { parents: [merge] }, [merge]: { parents: [seen, c1, c2], files: [clean()], second: [clean()] }, [c1]: { parents: [seen] }, [c2]: { parents: [seen] } });
    expect(await unseenCommits(t.target(h), new Set([seen]), scope)).toEqual({ count: 1, capped: false, unscanned: 1, flagged: [] });
    expect(t.calls).toEqual([`parents:${h}`, `changes:${merge}`]);
  });
  it("an older caller's read (no per-commit results) counts every unseen commit as not scanned", () => {
    const small = tierFromDiff({ files: [], complete: true }, { at: new Date(0).toISOString() });
    const raised = withUnseenCommits(small, { count: 2, capped: false });
    expect(raised.level).toBe("risky");
    expect(raised.reasons[0]).toEqual({ code: "unscanned_commits", path: "2 commits pushed between checks that Rovara could not read in full" });
    expect(withUnseenCommits(small, { count: 2, capped: false, unscanned: 0, flagged: [] })).toEqual(small);
  });
  it("a recorded tier's walk reasons are carried to a head that is not walked again", () => {
    const small = tierFromDiff({ files: [], complete: true }, { at: new Date(0).toISOString() });
    const carried = withRecordedUnseen(small, { reasons: [{ code: "unseen_commit_flagged", path: "commit abc1234: a sensitive file in x" }, { code: "sensitive_path", path: "y" }] });
    expect(carried.level).toBe("risky");
    expect(carried.reasons).toEqual([{ code: "unseen_commit_flagged", path: "commit abc1234: a sensitive file in x" }, ...small.reasons]);
    expect(withRecordedUnseen(small, undefined)).toEqual(small);
    expect(withRecordedUnseen(small, { reasons: [{ code: "sensitive_path", path: "y" }] })).toEqual(small);
  });
  it(`the base branch's history is read at most ${String(BASE_HISTORY_READS_MAX)} commits deep: a second parent within it is seen, one past it is scanned`, async () => {
    const chain = Array.from({ length: BASE_HISTORY_READS_MAX + 5 }, (_, index) => sha(`m${String(index)}`));
    const graph: Record<string, Node> = {};
    chain.forEach((commit, index) => { graph[commit] = { parents: index + 1 < chain.length ? [chain[index + 1]!] : [base] }; });
    const near = chain[BASE_HISTORY_READS_MAX - 1]!;
    const far = chain[BASE_HISTORY_READS_MAX + 2]!;
    graph[h] = { parents: [seen, near] };
    let t = stub(graph, { baseBranchHead: async () => chain[0]! });
    expect(await unseenCommits(t.target(h, "main"), new Set([seen, base]), scope)).toMatchObject({ count: 0, unscanned: 0 });
    graph[h] = { parents: [seen, far] };
    graph[far] = { ...graph[far]!, files: [clean()] };
    t = stub(graph, { baseBranchHead: async () => chain[0]! });
    const read = await unseenCommits(t.target(h, "main"), new Set([seen, base]), scope);
    expect(read.count).toBeGreaterThan(0);
    expect(t.calls.filter((call) => call.startsWith("parents:") && chain.includes(call.slice(8)) && call !== `parents:${far}`).length).toBeLessThanOrEqual(BASE_HISTORY_READS_MAX);
    expect(t.calls).toContain(`changes:${far}`);
  });
  it(`the walk reads at most ${String(UNSEEN_WALK_MAX)} commits`, async () => {
    const chain = Array.from({ length: UNSEEN_WALK_MAX + 5 }, (_, index) => sha(`w${String(index)}`));
    const graph: Record<string, Node> = {};
    chain.forEach((commit, index) => { graph[commit] = { parents: [chain[index + 1] ?? seen] }; });
    const t = stub(graph);
    expect(await unseenCommits(t.target(chain[0]!), new Set([seen]), scope)).toMatchObject({ capped: true, unscanned: 0, count: UNSEEN_WALK_MAX });
    expect(t.calls.length).toBe(UNSEEN_WALK_MAX);
  });
});
