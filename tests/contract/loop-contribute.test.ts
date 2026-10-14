// rovara loop (#359): the Contribute loop. It joins an issue, or someone else's pull request, to meet a goal with
// success criteria, and won't start without them. The agent plans in contribution.md, keeping the criteria as given;
// its change is accepted only when every criterion is ticked with its evidence. On a pull request, its own pull
// request is a follow-up into that pull request's branch, never a push to it.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { briefCriteria, criteriaProblems, missingBriefSections } from "../../packages/cli/src/loop/brief.js";
import { parseComment } from "../../packages/cli/src/loop/commands-parse.js";
import { CONTRIBUTE_TEMPLATE } from "../../packages/cli/src/loop/runtime.js";
import { createLoopHarness, LOOP_SESSION, removeAll, SELF_REVIEW } from "../support/loop-harness.js";

const dirs: string[] = [];
afterEach(async () => { await removeAll(dirs); });

const BRIEF = ["## Goal", "Payments survive a flaky gateway.", "", "## Success criteria", "- A 503 is retried at most 3 times.", "- A refund is never retried.", ""].join("\n");
const contribution = (lines: string[]) => ["## Goal", "Payments survive a flaky gateway.", "", "## Success criteria", ...lines, "", "## Approach", "Wrap send() in a bounded retry; test both cases.", ""].join("\n");
const OPEN = contribution(["- [ ] A 503 is retried at most 3 times.", "- [ ] A refund is never retried."]);
const PROVED = contribution([
  "- [x] A 503 is retried at most 3 times. — Evidence: client.test.ts \"retries a 503 three times\" passes",
  "- [x] A refund is never retried. — Evidence: client.test.ts \"never retries a refund\" passes",
]);

describe("a contribution's brief and criteria (#359)", () => {
  it("needs a goal and success criteria, and holds the document to them: kept as given, then each proved", () => {
    expect(missingBriefSections(BRIEF, ["Goal", "Success criteria"])).toEqual([]);
    expect(missingBriefSections("## Goal\nFaster.\n", ["Goal", "Success criteria"])).toEqual(["Success criteria"]);
    expect(briefCriteria(BRIEF)).toEqual(["a 503 is retried at most 3 times", "a refund is never retried"]);
    const criteria = briefCriteria(BRIEF);
    expect(criteriaProblems(OPEN, criteria, false)).toEqual([]);
    expect(criteriaProblems(OPEN, criteria, true)).toEqual([expect.stringContaining("not proved yet") as unknown]);
    expect(criteriaProblems(PROVED, criteria, true)).toEqual([]);
    expect(criteriaProblems(contribution(["- [x] A refund is never retried. — Evidence:"]), criteria, true)).toEqual([
      expect.stringContaining('not in it as given: "a 503 is retried at most 3 times"') as unknown,
      expect.stringContaining('not proved yet; tick each as `- [x] <criterion> — Evidence: <how you proved it>`: "a refund is never retried"') as unknown,
    ]);
    expect(criteriaProblems(contribution(["- [x] A 503 is retried at most 5 times. — Evidence: yes", "- [x] A refund is never retried. — Evidence: yes"]), criteria, true)[1])
      .toContain('not the brief\'s success criteria; keep exactly those: "a 503 is retried at most 5 times"');
    expect(parseComment("/rovara contribute")).toMatchObject({ kind: "start", loop: { name: "contribute" }, instruction: "" });
  });
});

describe("the Contribute loop on an issue (#359)", () => {
  it("waits for a goal and criteria, plans, and won't accept its change until every criterion is proved", async () => {
    const h = await createLoopHarness(dirs);
    await h.comment("maya", "/rovara contribute");
    expect(await h.step()).toBe("brief");
    expect(h.label()).toEqual(["rovara:contribute-brief"]);
    expect(h.lastPosted()).toContain("It needs a brief before the agent starts.");
    expect(h.lastPosted()).toContain(CONTRIBUTE_TEMPLATE);
    expect(h.world.started).toEqual([]);

    // A brief without criteria is answered with what it lacks; the agent has not started.
    await h.comment("sam", "## Goal\nPayments survive a flaky gateway.");
    expect(await h.step()).toBe("brief");
    expect(h.lastPosted()).toContain("It still needs `## Success criteria`, each with something in it.");
    expect(h.world.started).toEqual([]);
    await h.comment("sam", BRIEF);
    expect(await h.step()).toBe("plan");
    expect(await h.state()).toMatchObject({ criteria: ["a 503 is retried at most 3 times", "a refund is never retried"], instruction: BRIEF.trim() });
    const first = h.world.sessions.get(LOOP_SESSION)!.claude.at(-1)!;
    expect(first).toContain("This is the Contribute loop: you join this issue");
    expect(first).toContain("Write it to docs/rovara/42/contribution.md, with these sections as Markdown headings: `## Goal`, `## Success criteria`, `## Approach`.");

    // The plan keeps the criteria exactly; then coding starts at once.
    await h.write("contribution", contribution(["- [ ] A 503 is retried at most 5 times.", "- [ ] A refund is never retried."]));
    expect(await h.complete("Planned it.")).toContain("these are not the brief's success criteria");
    await h.write("contribution", OPEN);
    expect(await h.complete("Planned it.")).toContain("Your next step follows as a new message.");
    expect(await h.step()).toBe("code");
    expect(h.lastPosted()).toContain("Coding starts. When every success criterion is proved");
    expect(h.lastReceived()).toContain("Your step now: make the change.");

    // Not done until every criterion is ticked with its evidence.
    await h.selfReview();
    expect(await h.complete("Coded it.")).toContain("these success criteria are not proved yet");
    await h.write("contribution", contribution(["- [x] A 503 is retried at most 3 times.", "- [x] A refund is never retried. — Evidence: test passes"]));
    const refused = await h.complete("Coded it.");
    expect(refused).toContain('"a 503 is retried at most 3 times"');
    expect(refused).not.toContain('"a refund is never retried"');
    await h.write("contribution", PROVED);
    expect(await h.complete("Coded and proved both.")).toContain("Accepted");
    await h.runOwnSteps();
    expect(await h.step()).toBe("pr-open");
    const pull = h.world.pullRequests[0]!;
    expect(pull).toMatchObject({ head: "rovara/42", base: "main" });
    expect(pull.body).toMatch(/^Closes #42\./u);
    expect(pull.body).toContain("## Contribution");
    expect(pull.body).toContain("- [x] A refund is never retried. — Evidence:");
  });
});

describe("the Contribute loop on someone else's pull request (#359)", () => {
  it("starts from the pull request's head, is reviewed on what it adds, and opens a follow-up into its branch in the fork", async () => {
    const h = await createLoopHarness(dirs);
    h.world.openPulls.set(77, { base: "main", head: "aaa1111aaaa", open: true, headRepo: "lee/payments", headRef: "retry-fix" });
    h.world.say(77, "maya", `/rovara contribute ${BRIEF}`);
    await h.daemon.poll();
    const item = () => h.store.item(h.world.repo, 77);
    expect(await item()).toMatchObject({ loop: "contribute", step: "plan", upstream: { repo: "lee/payments", branch: "retry-fix", ref: "refs/rovara/contribute/77" } });
    const worktree = (await item())!.worktree!.path;
    expect(h.world.calls).toContainEqual(["git", "-C", h.checkout, "fetch", "--quiet", "origin", "+pull/77/head:refs/rovara/contribute/77"]);
    expect(h.world.calls).toContainEqual(["git", "-C", h.checkout, "worktree", "add", "-b", "rovara/77", worktree, "refs/rovara/contribute/77"]);
    const session = h.world.sessions.get("rovara-acme_payments-77")!;
    expect(session.claude.at(-1)).toContain("into that pull request's branch (lee/payments:retry-fix), so its author decides what to take. Never push to their branch.");

    // Plan, prove, and the loop reviews only what the follow-up adds to the pull request.
    const write = async (text: string) => {
      await mkdir(join(worktree, "docs", "rovara", "77", "evidence"), { recursive: true });
      await writeFile(join(worktree, "docs", "rovara", "77", "contribution.md"), text);
      await writeFile(join(worktree, "docs", "rovara", "77", "evidence", "self-review.md"), SELF_REVIEW);
    };
    const claim = (summary: string) => h.completeOn(77, summary);
    await write(OPEN);
    expect(await claim("Planned.")).toContain("Accepted");
    await write(PROVED);
    expect(await claim("Proved both.")).toContain("Accepted");
    await h.runOwnSteps();
    expect(h.world.calls).toContainEqual(["git", "-C", worktree, "diff", "refs/rovara/contribute/77...HEAD", "--", ".", ":(exclude)docs/rovara/77/evidence/checks.md", ":(exclude)docs/rovara/77/evidence/reviews.md"]);

    // Its own branch is pushed to this repository, and the follow-up opens in the fork, into the pull request's branch.
    expect(h.world.pushes).toEqual(["rovara/77"]);
    const followUp = h.world.pullRequests[0]!;
    expect(h.world.calls.find((call) => call[1] === "pr" && call[2] === "create")).toEqual(expect.arrayContaining(["--repo", "lee/payments", "--head", "acme:rovara/77", "--base", "retry-fix"]));
    expect(followUp.body).toMatch(/^Builds on acme\/payments#77: a follow-up into its branch `retry-fix`, for its author to take or leave\./u);
    expect(h.world.posted(77).at(-1)).toContain("into this pull request's branch `retry-fix`");
    expect((await item())?.step).toBe("pr-open");

    // A closed pull request has nothing to contribute to.
    h.world.openPulls.set(78, { base: "main", head: "bbb", open: false });
    h.world.say(78, "maya", `/rovara contribute ${BRIEF}`);
    await h.daemon.poll();
    expect(await h.store.item(h.world.repo, 78)).toBeUndefined();
    expect(h.world.posted(78).at(-1)).toContain("This pull request is closed");
  });
});

