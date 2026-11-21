import { describe, expect, it } from "vitest";
import { QUEUE_STATUS_CONTEXT, QUEUE_STATUS_CREATOR, findQueueReuse, queuePullRequest, queueReuseOutputs, type QueueReuseInput, type QueueStatus } from "../../scripts/ci-plan.js";
import { gateVerdict } from "../../scripts/ci-gate.js";

// #1262: the merge queue reuses a pull request's passing run only for byte-identical code on the same base, and only on github-actions[bot]'s own mark.
const BASE = "b".repeat(40), MERGE = "a".repeat(40), PR_HEAD = "c".repeat(40), QUEUE = "d".repeat(40), TREE = "1".repeat(40), OTHER_TREE = "2".repeat(40);
const HEAD_REF = `refs/heads/gh-readonly-queue/mainline/pr-42-${PR_HEAD}`;
const RUN = "https://github.com/o/r/actions/runs/123";
const passed = (over: Partial<QueueStatus> = {}): QueueStatus => ({ id: 10, context: QUEUE_STATUS_CONTEXT, state: "success", target_url: RUN, creator: { login: QUEUE_STATUS_CREATOR }, ...over });

/** A repository where refs/pull/42/merge is MERGE (tree TREE, first parent BASE) and HEAD is the queue's commit (tree TREE, first parent BASE). */
function gitOf(over: { mergeTree?: string; mergeParent?: string; queueTree?: string; queueParent?: string; fetchFails?: boolean } = {}) {
  const calls: string[][] = [];
  const git = (...args: string[]): string | undefined => {
    calls.push(args);
    if (args[0] === "fetch") return over.fetchFails === true ? undefined : "";
    if (args[0] !== "rev-parse") return undefined;
    const ref = args[args.length - 1]!;
    if (ref === "refs/ci/queue-reuse^{commit}") return over.fetchFails === true ? undefined : MERGE;
    if (ref === `${MERGE}^{tree}`) return over.mergeTree ?? TREE;
    if (ref === `${MERGE}^1`) return over.mergeParent ?? BASE;
    if (ref === "HEAD^{tree}") return over.queueTree ?? TREE;
    if (ref === "HEAD^1") return over.queueParent ?? BASE;
    return undefined;
  };
  return { git, calls };
}
const input = (over: Partial<QueueReuseInput> = {}): QueueReuseInput => ({ repository: "o/r", headRef: HEAD_REF, baseSha: BASE, git: gitOf().git, statuses: async () => [passed()], ...over });

describe("the merge queue's reuse of a pull request's pass (findQueueReuse)", () => {
  it("reuses when the queue's tree is the merge commit's, both stand on the queue's base, and github-actions[bot]'s newest mark is a success naming a run", async () => {
    const { git, calls } = gitOf();
    const asked: string[] = [];
    expect(await findQueueReuse(input({ git, statuses: async (sha) => { asked.push(sha); return [passed()]; } }))).toEqual({ reused: true, pullRequest: 42, mergeCommit: MERGE, runUrl: RUN });
    expect(calls[0]).toEqual(["fetch", "--no-tags", "--depth=2", "origin", "+refs/pull/42/merge:refs/ci/queue-reuse"]);
    expect(asked).toEqual([MERGE]);
  });

  it("never reuses when the code differs, or the pull request's run tested it on another base, or the queue holds more than this pull request", async () => {
    expect((await findQueueReuse(input({ git: gitOf({ queueTree: OTHER_TREE }).git }))).reused).toBe(false);
    expect((await findQueueReuse(input({ git: gitOf({ mergeParent: "e".repeat(40) }).git }))).reused).toBe(false);
    // A later entry of a group stands on the entry ahead of it, not on mainline.
    expect((await findQueueReuse(input({ git: gitOf({ queueParent: QUEUE }).git }))).reused).toBe(false);
  });

  it("never reuses on a mark anyone but github-actions[bot] set, or a mark that is not a success", async () => {
    for (const status of [passed({ creator: { login: "someone" } }), passed({ creator: null }), passed({ state: "failure" }), passed({ state: "pending" }), passed({ state: "error" })]) {
      expect((await findQueueReuse(input({ statuses: async () => [status] }))).reused, JSON.stringify(status)).toBe(false);
    }
  });

  it("judges only the newest mark: a later failure (a rerun that failed) cancels an earlier success, and other contexts don't count", async () => {
    expect((await findQueueReuse(input({ statuses: async () => [passed({ id: 1 }), passed({ id: 2, state: "failure" })] }))).reused).toBe(false);
    expect((await findQueueReuse(input({ statuses: async () => [passed({ id: 5, state: "failure" }), passed({ id: 9 })] }))).reused).toBe(true);
    expect((await findQueueReuse(input({ statuses: async () => [passed({ context: "ci/other" })] }))).reused).toBe(false);
  });

  it("never reuses on a mark that names no run of this repository", async () => {
    for (const target_url of [null, "", "https://github.com/evil/r/actions/runs/1", "https://example.com/o/r/actions/runs/1", `${RUN}/extra`]) {
      expect((await findQueueReuse(input({ statuses: async () => [passed({ target_url })] }))).reused, String(target_url)).toBe(false);
    }
  });

  it("plans as usual when the queue's branch names no pull request, the base is not a commit, the merge ref can't be fetched, or GitHub can't be read", async () => {
    for (const headRef of ["", "refs/heads/mainline", `refs/heads/gh-readonly-queue/other/pr-42-${PR_HEAD}`, "refs/heads/gh-readonly-queue/mainline/pr-42-short"]) {
      expect((await findQueueReuse(input({ headRef }))).reused, headRef).toBe(false);
    }
    expect((await findQueueReuse(input({ baseSha: "main" }))).reused).toBe(false);
    expect((await findQueueReuse(input({ git: gitOf({ fetchFails: true }).git }))).reused).toBe(false);
    expect((await findQueueReuse(input({ statuses: async () => undefined }))).reused).toBe(false);
    expect((await findQueueReuse(input({ statuses: async () => [] }))).reused).toBe(false);
  });

  it("reads the pull request from the queue's branch name only", () => {
    expect(queuePullRequest(HEAD_REF)).toBe(42);
    // #1295: code/next has a merge queue too.
    expect(queuePullRequest(`refs/heads/gh-readonly-queue/code/next/pr-42-${PR_HEAD}`)).toBe(42);
    expect(queuePullRequest(`refs/heads/gh-readonly-queue/code/other/pr-42-${PR_HEAD}`)).toBeUndefined();
    expect(queuePullRequest(`refs/heads/gh-readonly-queue/mainline/pr-0-${PR_HEAD}`)).toBeUndefined();
    expect(queuePullRequest(`gh-readonly-queue/mainline/pr-42-${PR_HEAD}`)).toBeUndefined();
  });
});

describe("the gate behind local, for a merge-queue reuse", () => {
  const skippedAll = { plan: "success", quick: "skipped", build: "skipped", test: "skipped", "linux-runtime": "skipped", "ci-mode": "skipped", "release-check": "skipped" };
  const plan = queueReuseOutputs(RUN);

  it("passes a merge-queue run whose plan reused a named run and every job was skipped", () => {
    expect(gateVerdict({ plan, results: skippedAll, event: "merge_group" })).toMatchObject({ ok: true });
  });

  it("refuses a reuse outside the merge queue, a reuse that names no run, and a reuse in which any job ran", () => {
    for (const event of ["pull_request", "push", "workflow_dispatch", undefined]) {
      expect(gateVerdict({ plan, results: skippedAll, ...(event === undefined ? {} : { event }) }).ok, String(event)).toBe(false);
    }
    expect(gateVerdict({ plan: { ...plan, reuse_run: "" }, results: skippedAll, event: "merge_group" }).ok).toBe(false);
    expect(gateVerdict({ plan: { ...plan, reuse_run: "https://example.com/x" }, results: skippedAll, event: "merge_group" }).ok).toBe(false);
    expect(gateVerdict({ plan: { ...plan, tests: "changed" }, results: skippedAll, event: "merge_group" }).ok).toBe(false);
    expect(gateVerdict({ plan, results: { ...skippedAll, quick: "success" }, event: "merge_group" }).ok).toBe(false);
    expect(gateVerdict({ plan, results: { ...skippedAll, plan: "failure" }, event: "merge_group" }).ok).toBe(false);
  });
});
