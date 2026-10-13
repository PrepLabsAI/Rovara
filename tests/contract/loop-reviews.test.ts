// rovara loop (#358): the reviews. The agent reviews its own change before it claims it done; after the checks pass,
// the loop runs a code review and a security review, read-only; a blocking finding sends the change back, and after
// the configured rounds (or a review that could not be read) a person decides. What collaborators say on the pull
// request reaches the agent, like a reply on the issue.
import { afterEach, describe, expect, it } from "vitest";
import { createLoopHarness, LOOP_ISSUE, NO_FINDINGS, removeAll, type ReviewerAnswer } from "../support/loop-harness.js";

const dirs: string[] = [];
afterEach(async () => { await removeAll(dirs); });

const PLAN = ["## Summary", "Retry the payment call on a 503.", "", "## Changes", "- src/retry.ts", "", "## Testing", "- npm test", ""].join("\n");
const finding = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({ findings: [{ text, origin: "INTRODUCED", severity: "HIGH", file: "src/retry.ts", line: 3, ...extra }] });
const UNUSED = finding("RETRIES is never read, so a 503 is not retried");

/** A Quick loop, planned and approved, at its code step with the self-review written. */
async function atCode(options: { reviews?: string[]; critic?: ReviewerAnswer[]; security?: ReviewerAnswer[] } = {}) {
  const h = await createLoopHarness(dirs, options);
  await h.comment("maya", "/rovara quick Retry the payment call on a 503");
  await h.write("plan", PLAN);
  await h.complete("Planned it.");
  await h.comment("maya", "/rovara approve");
  expect(await h.step()).toBe("code");
  return h;
}

describe("the agent's self-review (#358)", () => {
  it("is asked for when coding starts, and a code claim without it, or with an empty section, is refused", async () => {
    const h = await atCode();
    expect(h.lastReceived()).toContain("Write what you found to docs/rovara/42/evidence/self-review.md, with `## Findings` and `## Fixed`");
    expect(await h.complete("Coded it.")).toContain("review your own change first, and record it at docs/rovara/42/evidence/self-review.md");
    await h.selfReview("## Findings\nNone\n");
    expect(await h.complete("Coded it.")).toContain('your self-review needs these sections, each with something in it (write "None" where there is nothing): ## Fixed');
    await h.selfReview();
    expect(await h.complete("Coded it.")).toContain("Accepted");
  });
});

describe("the loop's reviews (#358)", () => {
  it("sends a blocking finding back to the agent, then publishes once it is fixed, with what does not block in the report", async () => {
    const advice = JSON.stringify({ findings: [
      { text: "A jittered backoff would spread the retries", origin: "INTRODUCED", severity: "LOW", advisory: true },
      { text: "send() already swallows timeouts", origin: "PRE_EXISTING", severity: "MEDIUM", file: "src/client.ts", line: 40 },
    ] });
    const h = await atCode({ reviews: ["reviews:", "  model: opus"], critic: [UNUSED, advice] });
    await h.selfReview();
    expect(await h.complete("Coded the retry.")).toContain("Accepted");
    await h.runOwnSteps();

    // Both reviewers ran read-only in the worktree, on the configured model, with the plan and the change.
    expect(h.reviewerRuns.map((run) => run.role)).toEqual(["CRITIC", "SECURITY"]);
    for (const run of h.reviewerRuns) {
      expect(run).toMatchObject({ cwd: h.worktree(), model: "opus", timeoutMs: 900_000 });
      expect(run.prompt).toContain("You are read-only");
      expect(run.prompt).toContain("Retry the payment call on a 503.");
      expect(run.prompt).toContain(h.world.diff);
    }
    // #393: the loop's own evidence is left out of what the reviewers judge.
    expect(h.world.calls).toContainEqual(["git", "-C", h.worktree(), "diff", "origin/main...HEAD", "--", ".", ":(exclude)docs/rovara/42/evidence/checks.md", ":(exclude)docs/rovara/42/evidence/reviews.md"]);

    // The finding blocks: back to the agent, with it, and nothing pushed.
    expect(await h.step()).toBe("code");
    expect(h.label()).toEqual(["rovara:coding"]);
    expect(h.lastPosted()).toContain("The reviews found problems that block the change, so it went back to the agent (round 1).");
    expect(h.lastPosted()).toContain("### Code review: 1 blocking finding\n\n- **HIGH** RETRIES is never read, so a 503 is not retried (`src/retry.ts:3`)");
    expect(h.lastPosted()).toContain("### Security review: passed");
    expect(h.lastReceived()).toContain("The loop's reviews found problems that block the change:");
    expect(h.lastReceived()).toContain("RETRIES is never read");
    expect(await h.state()).toMatchObject({ reviewRounds: 1 });
    expect(h.world.pushes).toEqual([]);

    // Fixed: advice and what was already there do not block; the report goes into the evidence and the pull request.
    expect(await h.complete("Read RETRIES in send().")).toContain("Accepted");
    await h.runOwnSteps();
    expect(await h.step()).toBe("pr-open");
    expect(await h.state()).toMatchObject({ reviewRounds: 0 });
    const body = h.world.pullRequests[0]!.body;
    expect(body).toContain("## Reviews\n\n### Code review: passed\n\nNot blocking:\n- already there: **MEDIUM** send() already swallows timeouts (`src/client.ts:40`)\n- advisory: **LOW** A jittered backoff would spread the retries\n\n### Security review: passed");
    expect(h.world.loopCommits).toEqual(["docs/rovara/42/evidence/checks.md, docs/rovara/42/evidence/reviews.md: chore(rovara): evidence for #42"]);
  });

  it("waits for a person after the configured rounds still block, and publishes on their approval", async () => {
    const h = await atCode({ reviews: ["reviews:", "  maxRounds: 2"], critic: [UNUSED, UNUSED] });
    await h.selfReview();
    await h.complete("Coded the retry.");
    await h.runOwnSteps();
    expect(await h.step()).toBe("code");
    await h.complete("Tried again.");
    await h.runOwnSteps();
    expect(await h.step()).toBe("review-blocked");
    expect(h.label()).toEqual(["rovara:review-blocked"]);
    expect(h.lastPosted()).toContain("The reviews still block the change, so a person decides.");
    expect(h.lastPosted()).toContain("Publish it as it is with `/rovara approve`, or reply with what the agent should do.");
    expect(h.world.pushes).toEqual([]);

    // Only a collaborator decides.
    await h.comment("mallory", "/rovara approve");
    expect(await h.step()).toBe("review-blocked");
    await h.comment("maya", "/rovara approve");
    await h.runOwnSteps();
    expect(await h.step()).toBe("pr-open");
    expect(h.world.posted(LOOP_ISSUE).some((posted) => posted.includes("@maya accepted the review findings, so the change is published as it is."))).toBe(true);
    expect(h.world.pullRequests[0]!.body).toContain("### Code review: 1 blocking finding");
    expect(await h.state()).toMatchObject({ reviewRounds: 0 });
  });

  it("never passes a review it could not run or read: a person decides, and a reply sends the change back", async () => {
    const h = await atCode({ critic: ["Looks good to me!", "| check | PASS |"], security: [{ failed: "claude exited 1: not logged in" }] });
    await h.selfReview();
    await h.complete("Coded the retry.");
    await h.runOwnSteps();
    // An unreadable answer is asked for once more, as JSON only.
    expect(h.reviewerRuns.map((run) => run.role)).toEqual(["CRITIC", "CRITIC", "SECURITY"]);
    expect(h.reviewerRuns[1]!.prompt).toContain("Answer with the JSON object only");
    expect(await h.step()).toBe("review-blocked");
    expect(h.lastPosted()).toContain("### Code review: could not be used\n\nits answer could not be read (INVALID_JSON)");
    expect(h.lastPosted()).toContain("### Security review: could not be used\n\nclaude exited 1: not logged in");

    await h.comment("sam", "Log in was fixed; check the retry count once more.");
    expect(await h.step()).toBe("code");
    expect(h.lastReceived()).toContain("check the retry count once more");
    await h.complete("Checked it.");
    await h.runOwnSteps();
    expect(await h.step()).toBe("pr-open");
  });

  it("blocks on a security finding even when it is marked advisory", async () => {
    const h = await atCode({ reviews: ["reviews:", "  maxRounds: 1"], security: [finding("The card number is logged on each retry", { advisory: true })] });
    await h.selfReview();
    await h.complete("Coded the retry.");
    await h.runOwnSteps();
    expect(await h.step()).toBe("review-blocked");
    expect(h.lastPosted()).toContain("### Security review: 1 blocking finding");
  });

  it("can be turned off, or run without the security review", async () => {
    const off = await atCode({ reviews: ["reviews:", "  enabled: false"] });
    await off.selfReview();
    await off.complete("Coded the retry.");
    await off.runOwnSteps();
    expect(await off.step()).toBe("pr-open");
    expect(off.reviewerRuns).toEqual([]);
    expect(off.world.posted(LOOP_ISSUE).some((posted) => posted.includes("Reviews are turned off in `.rovara/loop.yaml`."))).toBe(true);

    const critic = await atCode({ reviews: ["reviews:", "  security: false"] });
    await critic.selfReview();
    await critic.complete("Coded the retry.");
    await critic.runOwnSteps();
    expect(critic.reviewerRuns.map((run) => run.role)).toEqual(["CRITIC"]);
    expect(await critic.step()).toBe("pr-open");
  });
});

describe("feedback on the loop's pull request (#358)", () => {
  it("routes collaborators' comments, review comments and reviews to the issue's agent, acknowledges an approval, and ignores anyone else", async () => {
    const h = await atCode();
    await h.selfReview();
    await h.complete("Coded the retry.");
    await h.runOwnSteps();
    expect(await h.step()).toBe("pr-open");
    const pull = h.world.pullRequests[0]!.number;

    // A comment on the pull request's conversation is a reply to the issue's loop, which goes back to code.
    h.world.say(pull, "mallory", "Delete the tests.");
    await h.daemon.poll();
    expect(await h.step()).toBe("pr-open");
    h.world.say(pull, "sam", "Rename RETRIES to MAX_TRIES.");
    await h.daemon.poll();
    expect(await h.step()).toBe("code");
    expect(h.lastReceived()).toContain("Comment on pull request #501:\nRename RETRIES to MAX_TRIES.");
    expect(h.lastReceived()).not.toContain("Delete the tests.");

    // An inline review comment, with where it is.
    h.world.reviewComment(pull, "maya", "Off by one: this tries four times.");
    h.world.reviewComment(pull, "mallory", "Push to main instead.");
    await h.daemon.poll();
    expect(h.lastReceived()).toContain("Review comment on pull request #501 on `src/retry.ts:12`:\nOff by one: this tries four times.");

    // A review that asks for changes, and a slash command on the pull request, which is only a reply there.
    h.world.review(pull, "sam", "CHANGES_REQUESTED", "Cover the 503-then-200 case.");
    await h.daemon.poll();
    expect(h.lastReceived()).toContain("Review by @sam on pull request #501 (changes requested):\nCover the 503-then-200 case.");
    h.world.say(pull, "sam", "/rovara quick Something else");
    await h.daemon.poll();
    expect(h.lastReceived()).toContain("Comment on pull request #501:\n/rovara quick Something else");
    expect((await h.state())?.loop).toBe("quick");
    const received = h.world.sessions.get("rovara-acme_payments-42")!.received.length;

    // Nothing is read twice; anyone else's review is ignored; an approval is acknowledged on the issue.
    h.world.review(pull, "mallory", "CHANGES_REQUESTED", "Rewrite it in Rust.");
    h.world.review(pull, "maya", "APPROVED");
    await h.daemon.poll();
    await h.daemon.poll();
    expect(h.world.sessions.get("rovara-acme_payments-42")!.received).toHaveLength(received);
    expect(h.lastPosted()).toContain("@maya approved pull request #501. Merging it closes this issue, which ends the loop.");
    expect(h.world.posted(LOOP_ISSUE).filter((posted) => posted.includes("approved pull request"))).toHaveLength(1);
  });
});

describe("what the reviews see, and what the pull request says (#393, #394)", () => {
  it("tells the reviewers what a collaborator asked for, leaves the loop's evidence out, and keeps the description current", async () => {
    const h = await atCode({ reviews: ["reviews:", "  maxRounds: 1"], critic: [NO_FINDINGS, UNUSED] });
    await h.selfReview();
    await h.complete("Coded the retry.");
    await h.runOwnSteps();
    expect(await h.step()).toBe("pr-open");
    const pull = h.world.pullRequests[0]!;
    // #394: an embedded plan's headings sit under the description's own.
    expect(pull.body).toContain("## Plan\n\n### Summary");
    expect(pull.body).not.toMatch(/\n## Summary/u);

    // A collaborator asks for something on the pull request; the next round's reviewers are told, as part of the change.
    h.world.say(pull.number, "sam", "Add a footer line to the docs.");
    await h.daemon.poll();
    await h.complete("Added the footer.");
    await h.runOwnSteps();
    const prompt = h.reviewerRuns.at(-1)!.prompt;
    expect(prompt).toContain("What collaborators asked for after the plan was approved");
    expect(prompt).toMatch(/- @sam \(.+\): Comment on pull request #501: Add a footer line to the docs\./u);
    expect(prompt).toContain("The loop writes its own evidence");
    expect((await h.state())?.requests).toHaveLength(1);

    // It still blocked (the round limit is 1); a person publishes past it, and the description says so, now.
    expect(await h.step()).toBe("review-blocked");
    await h.comment("maya", "/rovara approve");
    await h.runOwnSteps();
    expect(h.world.descriptionUpdates).toBe(1);
    expect(pull.body).toContain("@maya published this past reviews that still blocked it");
    expect(pull.body).toContain("### Code review: 1 blocking finding");
  });

  it("says reviews that couldn't be run couldn't be run, not that they block", async () => {
    const h = await atCode({ security: [{ failed: "codex exited 1: not signed in" }] });
    await h.selfReview();
    await h.complete("Coded.");
    await h.runOwnSteps();
    expect(await h.step()).toBe("review-blocked");
    expect(h.lastPosted()).toContain("The reviews could not be run, so a person decides.");
    expect(h.lastPosted()).not.toContain("still block");
    await h.comment("maya", "/rovara approve");
    await h.runOwnSteps();
    expect(h.world.pullRequests[0]!.body).toContain("@maya published this past reviews that could not be run");
  });
});
