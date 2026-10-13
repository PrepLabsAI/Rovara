// rovara loop (#358): per-PR loops. A plan that names other repositories, once approved, starts one loop per
// repository, each with its own worktree, agent, checks, reviews and pull request; the issue waits until every pull
// request is approved. Feedback on a pull request goes to its loop; a reply on the issue goes to them all, or to one.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseComment } from "../../packages/cli/src/loop/commands-parse.js";
import { PULL_LOOP, QUICK_LOOP, nextStep } from "../../packages/cli/src/loop/definitions.js";
import { planRepositories, splitTargets } from "../../packages/cli/src/loop/exit-checks.js";
import { createLoopHarness, LOOP_ISSUE, LOOP_SESSION, removeAll } from "../support/loop-harness.js";

const dirs: string[] = [];
afterEach(async () => { await removeAll(dirs); });

const HOME = "acme/payments";
const WEB = "acme/web";
const PLAN = ["## Summary", "Retry the payment call on a 503, and say so in the web app.", "", "## Changes", "- payments: src/retry.ts", "- web: src/banner.tsx", "", "## Testing", "- npm test in each", ""];
const SPLIT_PLAN = [...PLAN, "## Repositories", `- ${HOME}: retry the call`, `- \`${WEB}\`: show a "retrying" banner`, ""].join("\n");

/** A Quick loop on the issue, with acme/web registered too, and its plan written. */
async function planned(plan = SPLIT_PLAN, options: { webReviews?: string[]; critic?: string[] } = {}) {
  const h = await createLoopHarness(dirs, { others: [{ repo: WEB, collaborators: ["maya", "wen"], ...(options.webReviews === undefined ? {} : { reviews: options.webReviews }) }], ...(options.critic === undefined ? {} : { critic: options.critic }) });
  await h.comment("maya", "/rovara quick Retry the payment call on a 503, and show it in the web app");
  await h.write("plan", plan);
  return h;
}

describe("a plan's repositories (#358)", () => {
  it("reads ## Repositories, and splits only when it names a repository other than the issue's", () => {
    expect(planRepositories(SPLIT_PLAN)).toEqual([HOME, WEB]);
    expect(planRepositories(PLAN.join("\n"))).toBeUndefined();
    expect(splitTargets(SPLIT_PLAN, HOME)).toEqual([HOME, WEB]);
    expect(splitTargets(`${PLAN.join("\n")}## Repositories\n- ${HOME}: all of it\n`, HOME)).toBeUndefined();
    expect(splitTargets(`${PLAN.join("\n")}## Repositories\n- ${WEB}: all of it\n`, HOME)).toEqual([WEB]);
    expect(nextStep(QUICK_LOOP, "plan-review", "split")).toBe("pulls");
    expect(PULL_LOOP.steps.filter((step) => step.approvable).map((step) => step.id)).toEqual(["review-blocked", "pr-review"]);
    expect(parseComment(`/rovara approve ${WEB}`)).toEqual({ kind: "approve", repo: WEB });
    expect(parseComment("/rovara approve")).toEqual({ kind: "approve" });
    expect(parseComment("/rovara approve looks good")).toEqual({ kind: "approve" });
  });

  it("refuses a plan naming a repository the loop cannot work in on this computer, or an empty list", async () => {
    const h = await planned(`${PLAN.join("\n")}## Repositories\n- ${HOME}: retry\n- acme/mobile: banner\n`);
    expect(await h.complete("Planned it.")).toContain("the loop cannot work in acme/mobile on this computer: ask the person to run `rovara loop add` in its checkout");
    await h.write("plan", `${PLAN.join("\n")}## Repositories\nthe web app too\n`);
    expect(await h.complete("Planned it.")).toContain("the plan's ## Repositories names no repository");
    await h.write("plan", SPLIT_PLAN);
    expect(await h.complete("Planned it.")).toContain("Accepted");
  });

  it("keeps a plan that names only the issue's repository on the one pull request path", async () => {
    const h = await planned(`${PLAN.join("\n")}## Repositories\n- ${HOME}: all of it\n`);
    await h.complete("Planned it.");
    await h.comment("maya", "/rovara approve");
    expect(await h.step()).toBe("code");
    expect(await h.store.pulls(HOME, LOOP_ISSUE)).toEqual([]);
  });
});

describe("per-PR loops (#358)", () => {
  it("runs one loop per repository, waits until both pull requests are approved, and goes back when one is taken back", async () => {
    const h = await planned();
    expect(await h.complete("Planned it.")).toContain("Accepted");
    const web = h.other(WEB);
    web.world.titles.set(LOOP_ISSUE, "A web issue that is not this one");
    await h.comment("maya", "/rovara approve");

    // The issue's loop waits on two per-PR loops; its planning agent's session ended.
    expect(await h.step()).toBe("pulls");
    expect(h.label()).toEqual(["rovara:pull-requests"]);
    expect(h.lastPosted()).toContain(`It changes 2 repositories, so each gets its own loop, agent and pull request: **${HOME}**, **${WEB}**.`);
    expect(h.world.sessions.has(LOOP_SESSION)).toBe(false);
    const home = (await h.pull(HOME))!;
    const webPull = (await h.pull(WEB))!;
    expect(home).toMatchObject({ loop: "pull", step: "code", target: HOME, worktree: { path: h.worktree(), branch: "rovara/42" }, approvals: { plan: { by: "maya" } } });
    const webWorktree = join(h.store.itemDir(HOME, LOOP_ISSUE, WEB), "worktree");
    expect(webPull).toMatchObject({ loop: "pull", step: "code", target: WEB, worktree: { path: webWorktree, branch: "rovara/acme-payments-42" } });
    expect(webPull.approvals).toBeUndefined();
    expect(h.world.calls).toContainEqual(["git", "-C", web.checkout, "worktree", "add", "-b", "rovara/acme-payments-42", webWorktree, "origin/main"]);

    // Each agent has its own session, in its own worktree, told which repository is its own and given the plan.
    const homeSession = h.pullSession(HOME)!;
    const webSession = h.pullSession(WEB)!;
    expect(homeSession.cwd).toBe(h.worktree());
    expect(webSession.cwd).toBe(webWorktree);
    expect(webSession.name).toBe("rovara-acme_payments-42-acme_web");
    const webFirst = webSession.claude.at(-1)!;
    expect(webFirst).toContain(`you make the change in **${WEB}**, and other agents make it in ${HOME}`);
    expect(webFirst).toContain("show a \"retrying\" banner");
    expect(webFirst).toContain("docs/rovara/acme-payments-42/evidence/self-review.md");
    const mcp = JSON.parse(await readFile(join(h.store.sessionDir(HOME, LOOP_ISSUE, WEB), "mcp.json"), "utf8")) as { mcpServers: Record<string, { args: string[] }> };
    expect(mcp.mcpServers["rovara-loop"]!.args.slice(-6)).toEqual(["--repo", HOME, "--issue", "42", "--target", WEB]);

    // Each codes, and the loop runs that repository's checks and reviews, then opens that repository's pull request.
    await h.selfReview(undefined, HOME);
    await h.selfReview(undefined, WEB);
    expect(await h.complete("Added the retry.", HOME)).toContain("Accepted");
    expect(await h.complete("Added the banner.", WEB)).toContain("Accepted");
    await h.runOwnSteps();
    expect(h.checkRuns).toEqual([`npm test @ ${h.worktree()}`, `npm run test:web @ ${webWorktree}`]);
    expect((await h.pull(HOME))?.step).toBe("pr-review");
    expect((await h.pull(WEB))?.step).toBe("pr-review");
    expect(h.world.pullRequests).toHaveLength(1);
    expect(h.world.pullRequests[0]).toMatchObject({ number: 501, head: "rovara/42", base: "main" });
    expect(h.world.pullRequests[0]!.body).toMatch(/^Closes #42\./u);
    expect(web.world.pullRequests).toHaveLength(1);
    const webPr = web.world.pullRequests[0]!;
    expect(webPr).toMatchObject({ number: 601, head: "rovara/acme-payments-42", base: "main", title: "Retry payments on 503" });
    expect(webPr.body).toMatch(/^Part of acme\/payments#42\./u);
    expect(h.world.loopCommits).toContain("docs/rovara/acme-payments-42/evidence/checks.md, docs/rovara/acme-payments-42/evidence/reviews.md: chore(rovara): evidence for acme/payments#42");
    const posted = h.world.posted(LOOP_ISSUE);
    expect(posted.some((body) => body.includes(`**${WEB}**: Opened pull request ${WEB}#601: ${webPr.url}`))).toBe(true);
    expect(posted.some((body) => body.includes(`**${HOME}**: Opened pull request ${HOME}#501`))).toBe(true);
    expect(await h.step()).toBe("pulls");
    expect(h.label()).toEqual(["rovara:pull-requests"]);

    // A review comment on the web pull request, from that repository's collaborator, is a fix round for its loop only.
    web.world.reviewComment(601, "wen", "The banner flickers.", "src/banner.tsx", 8);
    web.world.reviewComment(601, "sam", "Not a web collaborator.");
    await h.daemon.poll();
    expect((await h.pull(WEB))?.step).toBe("code");
    expect((await h.pull(HOME))?.step).toBe("pr-review");
    expect(h.pullSession(WEB)!.received.at(-1)).toContain(`Review comment on pull request ${WEB}#601 on \`src/banner.tsx:8\`:\nThe banner flickers.`);
    expect(h.pullSession(WEB)!.received.join("\n")).not.toContain("Not a web collaborator.");
    expect(await h.complete("Stopped the flicker.", WEB)).toContain("Accepted");
    await h.runOwnSteps();
    expect(web.world.pullRequests).toHaveLength(1);
    expect(h.lastPosted()).toContain(`**${WEB}**: Pushed the update to pull request ${WEB}#601`);

    // Approved one by one: a GitHub approval on the web pull request, `/rovara approve` on the other.
    web.world.review(601, "wen", "APPROVED");
    await h.daemon.poll();
    expect((await h.pull(WEB))?.step).toBe("approved");
    expect(await h.step()).toBe("pulls");
    h.world.say(501, "sam", "/rovara approve");
    await h.daemon.poll();
    expect((await h.pull(HOME))?.step).toBe("approved");
    expect(await h.step()).toBe("pulls-approved");
    expect(h.label()).toEqual(["rovara:pulls-approved"]);
    expect(h.lastPosted()).toContain(`Every pull request is approved:\n\n- ${HOME}#501: ${h.world.pullRequests[0]!.url}\n- ${WEB}#601: ${webPr.url}`);
    expect(h.lastPosted()).toContain(`merging the one in ${HOME} closes this issue`);

    // Taken back: a comment on the web pull request sends its loop back to code, and the issue waits again.
    web.world.say(601, "wen", "One more: hide it after 10 seconds.");
    await h.daemon.poll();
    expect((await h.pull(WEB))?.step).toBe("code");
    expect(await h.step()).toBe("pulls");
    expect(h.lastPosted()).toContain("A pull request went back for more work, so this issue waits for it again.");

    // A reply on the issue that names a repository goes to that loop only.
    const homeReceived = h.pullSession(HOME)!.received.length;
    await h.comment("sam", `${WEB}: and log when it hides.`);
    expect(h.pullSession(WEB)!.received.at(-1)).toContain("and log when it hides.");
    expect(h.pullSession(HOME)!.received).toHaveLength(homeReceived);

    // Closing the issue ends every loop and their sessions.
    h.world.closed.add(LOOP_ISSUE);
    await h.daemon.poll();
    expect(await h.step()).toBe("ended");
    expect((await h.pull(HOME))?.step).toBe("ended");
    expect((await h.pull(WEB))?.step).toBe("ended");
    expect(h.pullSession(HOME)).toBeUndefined();
    expect(h.pullSession(WEB)).toBeUndefined();
    expect(h.label()).toEqual([]);
  });

  it("sends a reply on the issue to every loop still working, and stops one from its pull request", async () => {
    const h = await planned();
    await h.complete("Planned it.");
    await h.comment("maya", "/rovara approve");
    await h.comment("sam", "Use the new logger everywhere.");
    expect(h.pullSession(HOME)!.received.at(-1)).toContain("Use the new logger everywhere.");
    expect(h.pullSession(WEB)!.received.at(-1)).toContain("Use the new logger everywhere.");

    await h.selfReview(undefined, WEB);
    await h.complete("Added the banner.", WEB);
    await h.runOwnSteps();
    h.other(WEB).world.say(601, "wen", "/rovara stop");
    await h.daemon.poll();
    expect((await h.pull(WEB))?.step).toBe("ended");
    expect((await h.pull(HOME))?.step).toBe("code");
    expect(await h.step()).toBe("pulls");
    expect(h.lastPosted()).toContain(`**${WEB}**: Stopped by @wen.`);
  });

  it("publishes a per-PR loop whose reviews still block on `/rovara approve owner/name` from the issue, and sends an issue reply only to loops still working", async () => {
    const blocking = JSON.stringify({ findings: [{ text: "The banner is not announced to screen readers", origin: "INTRODUCED", severity: "MEDIUM" }] });
    const h = await planned(SPLIT_PLAN, { webReviews: ["reviews:", "  maxRounds: 1"], critic: [blocking] });
    await h.complete("Planned it.");
    await h.comment("maya", "/rovara approve");
    await h.selfReview(undefined, WEB);
    await h.complete("Added the banner.", WEB);
    await h.runOwnSteps();
    expect((await h.pull(WEB))?.step).toBe("review-blocked");
    expect(h.lastPosted()).toContain(`**${WEB}**: The reviews still block the change, so a person decides.`);
    expect(h.lastPosted()).toContain(`Publish it as it is with \`/rovara approve ${WEB}\`, or reply with what the agent should do (start the reply with \`${WEB}:\`).`);
    expect(h.other(WEB).world.pullRequests).toHaveLength(0);

    // Approving another repository's reviews, or nothing blocked, is said; the named one publishes.
    await h.comment("maya", `/rovara approve ${HOME}`);
    expect(h.lastPosted()).toContain(`${HOME}'s reviews are not waiting for a person.`);
    await h.comment("maya", `/rovara approve ${WEB}`);
    await h.runOwnSteps();
    expect((await h.pull(WEB))?.step).toBe("pr-review");
    expect(h.other(WEB).world.pullRequests).toHaveLength(1);
    expect(h.world.posted(LOOP_ISSUE).some((body) => body.includes(`**${WEB}**: @maya accepted the review findings, so the change is published as it is.`))).toBe(true);
    await h.comment("maya", "/rovara approve");
    expect(h.lastPosted()).toContain("No pull request's reviews are waiting for a person. Approve a pull request on it");

    // A reply on the issue goes to the loop still coding, not to the one whose pull request is open.
    const webReceived = h.pullSession(WEB)!.received.length;
    await h.comment("sam", "Keep the retry count in one constant.");
    expect(h.pullSession(HOME)!.received.at(-1)).toContain("Keep the retry count in one constant.");
    expect(h.pullSession(WEB)!.received).toHaveLength(webReceived);
    expect((await h.pull(WEB))?.step).toBe("pr-review");
  });
});
