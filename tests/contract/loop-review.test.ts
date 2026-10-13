// rovara loop (#359): the Review loop. It waits for a collaborator's brief, then reviews a pull request (or every open
// pull request that mentions an issue) round after round, read-only: no agent session, no branch, no commit, no push.
// New commits or a reply start the next round; `/rovara file <n>` files a numbered finding as an issue.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseComment } from "../../packages/cli/src/loop/commands-parse.js";
import { REVIEW_LOOP } from "../../packages/cli/src/loop/definitions.js";
import { BRIEF_TEMPLATE } from "../../packages/cli/src/loop/runtime.js";
import { createLoopHarness, LOOP_ISSUE, LOOP_SESSION, NO_FINDINGS, removeAll, SELF_REVIEW } from "../support/loop-harness.js";

const dirs: string[] = [];
afterEach(async () => { await removeAll(dirs); });

const PULL = 77;
const answer = (summary: string, findings: Array<Record<string, unknown>> = []) => JSON.stringify({ summary, findings });
const DOUBLE_BILL = { text: "Retrying a charge can bill the card twice", severity: "HIGH", file: "src/retry.ts", line: 3 };
const NO_LOG = { text: "Retries are not logged", severity: "LOW" };

describe("the Review loop's commands (#359)", () => {
  it("starts with or without a brief, and reads /rovara file with one finding or several", () => {
    expect(parseComment("/rovara review")).toMatchObject({ kind: "start", loop: { name: "review" }, instruction: "" });
    expect(parseComment("/rovara review Is the retry idempotent?")).toMatchObject({ kind: "start", instruction: "Is the retry idempotent?" });
    expect(parseComment("/rovara quick")).toMatchObject({ kind: "invalid" });
    expect(parseComment("/rovara file 2")).toEqual({ kind: "file", numbers: [2] });
    expect(parseComment("/rovara file 2, 4 2")).toEqual({ kind: "file", numbers: [2, 4] });
    expect(parseComment("/rovara file two")).toMatchObject({ kind: "invalid", reason: expect.stringContaining("by number") as unknown });
    expect(REVIEW_LOOP.steps.some((step) => step.actor === "agent")).toBe(false);
  });
});

describe("the Review loop on a pull request (#359)", () => {
  it("waits for its brief, then reviews round after round, changing no code, and files a finding on request", async () => {
    const h = await createLoopHarness(dirs, { critic: [answer("The retry is not idempotent.", [DOUBLE_BILL]), answer("Idempotent now.", [NO_LOG]), answer("Logging checked.")] });
    h.world.openPulls.set(PULL, { base: "main", head: "aaa1111aaaa", open: true });
    const posted = () => h.world.posted(PULL).at(-1) ?? "";
    const say = async (author: string, body: string) => { h.world.say(PULL, author, body); await h.daemon.poll(); };
    const review = () => h.store.item(h.world.repo, PULL);

    // No brief: the template, and nothing reviewed until a collaborator gives one.
    await say("maya", "/rovara review");
    expect((await review())?.step).toBe("brief");
    expect(h.world.labels.get(PULL)).toEqual(new Set(["rovara:review-brief"]));
    expect(posted()).toContain("It reads and comments, and changes no code.");
    expect(posted()).toContain(BRIEF_TEMPLATE);
    await h.runOwnSteps();
    expect(h.reviewerRuns).toEqual([]);
    await say("mallory", "## Questions\n- Anything at all?");
    expect((await review())?.step).toBe("brief");
    await say("maya", "## Questions\n- Is the retry idempotent?");
    expect(posted()).toContain("Thanks @maya: reviewing with this brief.");

    // Round 1: the pull request's head, checked out detached in the review's own worktree, reviewed read-only.
    await h.runOwnSteps();
    const worktree = join(h.store.itemDir(h.world.repo, PULL), "reviews", "acme__payments-77");
    expect(h.world.checkedOut).toEqual(["fetch +pull/77/head:refs/rovara/review/77", `refs/rovara/review/77 @ ${worktree}`]);
    expect(h.reviewerRuns).toHaveLength(1);
    expect(h.reviewerRuns[0]).toMatchObject({ cwd: worktree, harness: "claude-code" });
    expect(h.reviewerRuns[0]!.prompt).toContain("Is the retry idempotent?");
    expect(h.reviewerRuns[0]!.prompt).toContain(h.world.diff);
    expect((await review())?.step).toBe("waiting");
    expect(h.world.labels.get(PULL)).toEqual(new Set(["rovara:reviewed"]));
    expect(posted()).toContain("### Review, round 1\n\n**acme/payments#77** at `aaa1111`\n\nThe retry is not idempotent.\n\n1. **HIGH** Retrying a charge can bill the card twice (`src/retry.ts:3`)");
    expect(posted()).toContain("`/rovara file <n>` files a finding as an issue");

    // Nothing new, nothing reviewed; new commits start round 2, numbered on, told the earlier findings.
    await h.daemon.poll();
    expect((await review())?.step).toBe("waiting");
    h.world.openPulls.set(PULL, { base: "main", head: "bbb2222bbbb", open: true });
    await h.daemon.poll();
    expect(posted()).toContain("New commits on acme/payments#77 (`bbb2222`): reviewing again.");
    await h.runOwnSteps();
    expect(h.world.checkedOut.at(-1)).toBe(`refs/rovara/review/77 @ ${worktree}`);
    expect(h.reviewerRuns[1]!.prompt).toContain("Findings from earlier rounds.");
    expect(h.reviewerRuns[1]!.prompt).toContain("- Retrying a charge can bill the card twice (src/retry.ts:3)");
    expect(posted()).toContain("### Review, round 2");
    expect(posted()).toContain("2. **LOW** Retries are not logged");

    // A reply asks round 3 to look at more; it is used once.
    await say("sam", "Also check what is logged on each retry.");
    expect(posted()).toContain("Reviewing again, with what @sam asked to look at.");
    await h.runOwnSteps();
    expect(h.reviewerRuns[2]!.prompt).toContain("Also look at, as asked since the last round:\nAlso check what is logged on each retry.");
    expect((await review())?.focus).toBeUndefined();
    expect((await review())?.rounds).toBe(3);

    // It changed nothing: no agent, no commit, no push, no pull request.
    expect(h.world.started).toEqual([]);
    expect(h.world.pushes).toEqual([]);
    expect(h.world.loopCommits).toEqual([]);
    expect(h.world.pullRequests).toEqual([]);

    // A finding is filed as an issue only when a collaborator asks, and once.
    await say("maya", "/rovara file 1");
    expect(h.world.filed).toHaveLength(1);
    expect(h.world.filed[0]!.title).toBe("Retrying a charge can bill the card twice");
    expect(h.world.filed[0]!.body).toContain("Found by a rovara loop review of acme/payments#77, and filed by @maya.");
    expect(h.world.filed[0]!.body).toContain("**HIGH** Retrying a charge can bill the card twice (`src/retry.ts:3`)");
    expect(posted()).toContain("- 1: filed as acme/payments#901.");
    await say("maya", "/rovara file 1,9");
    expect(h.world.filed).toHaveLength(1);
    expect(posted()).toContain("- 1: already filed as acme/payments#901.");
    expect(posted()).toContain("- 9: there is no finding 9.");

    await say("maya", "/rovara stop");
    expect((await review())?.step).toBe("ended");
    expect(posted()).toContain("Stopped by @maya.");
    expect(posted()).not.toContain("branch");
  });
});

describe("the Review loop on an issue (#359)", () => {
  it("reviews every open pull request that mentions the issue, in each repository, and says when there is none", async () => {
    const h = await createLoopHarness(dirs, {
      others: [{ repo: "acme/web" }],
      critic: [answer("Payments side is fine.", [DOUBLE_BILL]), answer("The banner matches.", [NO_LOG])],
    });
    h.world.openPulls.set(PULL, { base: "main", head: "aaa1111aaaa", open: true });
    h.world.openPulls.set(79, { base: "main", head: "ccc3333cccc", open: false });
    h.other("acme/web").world.openPulls.set(88, { base: "trunk", head: "ddd4444dddd", open: true });
    h.world.links.set(LOOP_ISSUE, [{ repo: "acme/payments", number: PULL }, { repo: "acme/payments", number: 79 }, { repo: "acme/web", number: 88 }]);
    await h.comment("maya", "/rovara review Do the retry and the banner agree on when a payment is retried?");
    expect(h.lastPosted()).toContain("The first round is running.");
    await h.runOwnSteps();
    expect(h.reviewerRuns.map((run) => run.cwd)).toEqual([
      join(h.store.itemDir(h.world.repo, LOOP_ISSUE), "reviews", "acme__payments-77"),
      join(h.store.itemDir(h.world.repo, LOOP_ISSUE), "reviews", "acme__web-88"),
    ]);
    expect(h.world.calls).toContainEqual(["git", "-C", h.other("acme/web").checkout, "fetch", "--quiet", "origin", "+pull/88/head:refs/rovara/review/88", "+refs/heads/trunk:refs/remotes/origin/trunk"]);
    const report = h.lastPosted();
    expect(report).toContain("**acme/payments#77** at `aaa1111`");
    expect(report).toContain("**acme/web#88** at `ddd4444`");
    expect(report).not.toContain("#79");
    expect(report).toContain("1. **HIGH** Retrying a charge");
    expect(report).toContain("2. **LOW** Retries are not logged");

    // Filed in the repository of the pull request the finding is about.
    await h.comment("sam", "/rovara file 2");
    expect(h.other("acme/web").world.filed).toHaveLength(1);
    expect(h.lastPosted()).toContain("- 2: filed as acme/web#901.");

    const none = await createLoopHarness(dirs);
    await none.comment("maya", "/rovara review Anything?");
    await none.runOwnSteps();
    expect(await none.step()).toBe("waiting");
    expect(none.lastPosted()).toContain("There is no open pull request to review. Mention this issue in a pull request, then reply here to review it.");
  });
});

describe("the Review loop on a pull request another loop opened (#359)", () => {
  it("runs on the pull request, and has its conversation, while review comments still reach the delivering agent", async () => {
    const h = await createLoopHarness(dirs, { critic: [NO_FINDINGS, answer("Looks safe.", [NO_LOG]), answer("Still fine.")] });
    await h.comment("maya", "/rovara quick Retry the payment call on a 503");
    await h.write("plan", ["## Summary", "Retry.", "", "## Changes", "- src/retry.ts", "", "## Testing", "- npm test", ""].join("\n"));
    await h.complete("Planned.");
    await h.comment("maya", "/rovara approve");
    await h.selfReview(SELF_REVIEW);
    await h.complete("Coded.");
    await h.runOwnSteps();
    expect(await h.step()).toBe("pr-open");
    const delivering = h.world.sessions.get(LOOP_SESSION)!;
    const received = delivering.received.length;

    // `/rovara review` on the loop's own pull request starts a review there, not a reply to the delivering agent.
    h.world.say(501, "sam", "/rovara review Is a retried charge ever billed twice?");
    await h.daemon.poll();
    await h.runOwnSteps();
    expect((await h.store.item(h.world.repo, 501))).toMatchObject({ loop: "review", step: "waiting", rounds: 1 });
    expect(h.world.posted(501).at(-1)).toContain("**acme/payments#501** at `head-50`");
    expect(delivering.received).toHaveLength(received);
    expect(await h.step()).toBe("pr-open");

    // Its conversation is the review's; an inline review comment still reaches the delivering agent.
    h.world.say(501, "sam", "Look at the timeout too.");
    h.world.reviewComment(501, "sam", "Name this constant.");
    await h.daemon.poll();
    expect((await h.store.item(h.world.repo, 501))?.focus).toBe("Look at the timeout too.");
    expect(delivering.received.at(-1)).toContain("Review comment on pull request #501");
    expect(delivering.received.join("\n")).not.toContain("Look at the timeout too.");
  });
});
