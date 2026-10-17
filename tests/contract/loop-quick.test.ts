// rovara loop (#356): the Quick loop. The agent plans; a collaborator approves the plan (or asks for changes,
// which go into the plan); the agent codes it; the loop runs the repository's checks and opens a pull request.
// Nothing is pushed before the plan is approved and the checks pass.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { checksReport, runChecks, shellCheckRun, type CheckRun } from "../../packages/cli/src/loop/check-runner.js";
import { parseComment } from "../../packages/cli/src/loop/commands-parse.js";
import { LoopDaemon } from "../../packages/cli/src/loop/daemon.js";
import { artifactDigest, failedExitChecks, missingSections } from "../../packages/cli/src/loop/exit-checks.js";
import { ARTIFACT_SECTIONS } from "../../packages/cli/src/loop/instructions.js";
import { GitHub } from "../../packages/cli/src/loop/github.js";
import { AgentHarness } from "../../packages/cli/src/loop/harness.js";
import { createLoopMcpServer } from "../../packages/cli/src/loop/mcp.js";
import { LOOP_COMMENT_MARKER, evidencePath } from "../../packages/cli/src/loop/naming.js";
import { LoopStore } from "../../packages/cli/src/loop/state.js";
import { LoopWorld } from "../support/loop-fakes.js";
import { NO_FINDINGS, SELF_REVIEW } from "../support/loop-harness.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const ISSUE = 42;
const SESSION = "rovara-acme_payments-42";
const PLAN = ["# Plan", "", "## Summary", "Retry the payment call on a 503.", "", "## Changes", "- src/client.ts: wrap send() in a retry.", "", "## Testing", "- npm test covers a 503 then a 200.", ""].join("\n");

async function setUp(options: { checks?: boolean[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "rovara-quick-"));
  dirs.push(root);
  const checkout = join(root, "checkout");
  await mkdir(join(checkout, ".rovara"), { recursive: true });
  await writeFile(join(checkout, ".rovara", "loop.yaml"), ["version: 1", "collaborators: [maya, sam]", "checks:", "  - name: tests", "    run: npm test", ""].join("\n"));
  const world = new LoopWorld();
  const candidate = { branch: "rovara/42", commitSha: "a".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "c".repeat(40) };
  world.titles.set(ISSUE, "Retry payments on 503");
  const store = new LoopStore(join(root, "home", ".rovara", "loop"));
  await store.saveRepos([{ repo: world.repo, path: checkout }]);
  // The checks pass or fail in the order given, then pass.
  const outcomes = [...(options.checks ?? [])];
  const checkRuns: string[] = [];
  const checkRun: CheckRun = async (command, runOptions) => {
    checkRuns.push(`${command} @ ${runOptions.cwd}`);
    const passed = outcomes.shift() ?? true;
    return passed ? { code: 0, timedOut: false, output: "all good" } : { code: 1, timedOut: false, output: "FAIL client.test.ts > retries on 503\nexpected 2 calls, got 1" };
  };
  const daemon = new LoopDaemon({
    store, exec: world.exec, github: new GitHub(world.exec), harness: new AgentHarness(world.exec, { claudeHome: join(root, "claude") }),
    cliCommand: ["/usr/local/bin/node", "/opt/rovara/cli.js"], now: () => new Date(world.clock), log: () => undefined, checkRun,
    reviewerRun: async () => ({ ok: true, text: NO_FINDINGS }),
    captureCandidate: async () => candidate,
    resolvePublicationContext: async () => ({ kind: "unmanaged-local" }),
  });
  await daemon.poll();
  const worktree = () => join(store.itemDir(world.repo, ISSUE), "worktree");
  /** The agent records its self-review, which a code claim needs (#358). */
  const selfReview = async () => {
    await mkdir(join(worktree(), "docs", "rovara", String(ISSUE), "evidence"), { recursive: true });
    await writeFile(join(worktree(), evidencePath(ISSUE, "self-review.md")), SELF_REVIEW);
  };
  const writePlan = async (text: string) => {
    await mkdir(join(worktree(), "docs", "rovara", String(ISSUE)), { recursive: true });
    await writeFile(join(worktree(), "docs", "rovara", String(ISSUE), "plan.md"), text);
  };
  const readPlanFile = () => readFile(join(worktree(), "docs", "rovara", String(ISSUE), "plan.md"), "utf8");
  /** The agent claims its step done through its MCP tool, while the daemon attends to its inbox. */
  const complete = async (summary: string, afterAttend?: () => Promise<void>) => {
    const server = createLoopMcpServer({
      store, repo: world.repo, issue: ISSUE, version: "test", pollMs: 5, waitMs: 2_000,
      sleep: async () => { await daemon.attend(); await afterAttend?.(); },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "claude-code", version: "test" });
    await client.connect(clientSide);
    const call = client.callTool({ name: "loop_complete", arguments: { summary } });
    return ((await call) as { content: Array<{ text: string }> }).content[0]?.text ?? "";
  };
  /** The loop's own steps (checks, publishing) run in the background: attend, let them finish, attend again. */
  const runOwnSteps = async () => {
    for (let round = 0; round < 4; round += 1) {
      await daemon.attend();
      await daemon.settle();
    }
    await daemon.attend();
  };
  const step = async () => (await store.item(world.repo, ISSUE))?.step;
  const label = () => [...(world.labels.get(ISSUE) ?? [])];
  return { world, store, daemon, checkout, worktree, writePlan, readPlanFile, selfReview, complete, runOwnSteps, step, label, checkRuns };
}

describe("the Quick loop's commands (#356)", () => {
  it("reads /rovara quick, /rovara approve, and /rovara changes with its request", () => {
    expect(parseComment("/rovara quick add retries to the payments client")).toMatchObject({ kind: "start", loop: { name: "quick" }, instruction: "add retries to the payments client" });
    expect(parseComment("/rovara approve")).toEqual({ kind: "approve" });
    expect(parseComment("/rovara changes: use exponential backoff\nand cap it at 3 tries")).toEqual({ kind: "changes", text: "use exponential backoff\nand cap it at 3 tries" });
    expect(parseComment("/rovara changes keep the old API")).toEqual({ kind: "changes", text: "keep the old API" });
    expect(parseComment("/rovara changes:")).toMatchObject({ kind: "invalid" });
  });
});

describe("the checks on a Quick claim (#356)", () => {
  it("wants a plan with each section filled in, and refuses a changed plan once it is approved", async () => {
    expect(missingSections(PLAN, ARTIFACT_SECTIONS.plan)).toEqual([]);
    expect(missingSections("## Summary\nx\n## Changes\n\n## testing\ny\n", ARTIFACT_SECTIONS.plan)).toEqual(["Changes"]);
    const dir = await mkdtemp(join(tmpdir(), "rovara-exit-"));
    dirs.push(dir);
    const facts = { summary: "planned", issue: ISSUE, worktree: dir, artifact: "plan" as const, approvals: undefined };
    expect(await failedExitChecks(["artifact-sections"], facts)).toEqual(["there is no plan at docs/rovara/42/plan.md; write it there"]);
    await mkdir(join(dir, "docs", "rovara", "42"), { recursive: true });
    await writeFile(join(dir, "docs", "rovara", "42", "plan.md"), "## Summary\nx\n");
    expect(await failedExitChecks(["artifact-sections"], facts)).toEqual(["the plan needs these sections, each with something in it: ## Changes, ## Testing"]);
    await writeFile(join(dir, "docs", "rovara", "42", "plan.md"), PLAN);
    const approved = (digest: string) => ({ plan: { digest, by: "maya", at: "2026-10-13T00:00:00.000Z" } });
    expect(await failedExitChecks(["require-summary", "artifact-sections", "approved-unchanged"], { ...facts, approvals: approved(artifactDigest(PLAN)) })).toEqual([]);
    expect(await failedExitChecks(["approved-unchanged"], { ...facts, approvals: approved(artifactDigest("something else")) })).toEqual(["the approved plan at docs/rovara/42/plan.md was changed; put it back as approved"]);
    expect(await failedExitChecks(["require-summary"], { ...facts, summary: " " })).toEqual(["give a summary of what you did; it is posted on the issue"]);
  });
});

describe("the repository's checks, through a real shell (#356)", () => {
  it("passes and fails by exit code, keeps a failure's last output redacted, and stops a check that runs too long with everything it started", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rovara-checks-"));
    dirs.push(dir);
    const results = await runChecks([
      { name: "ok", run: "echo fine", timeoutSeconds: 30 },
      { name: "bad", run: "echo 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789'; echo nope >&2; exit 3", timeoutSeconds: 30 },
      { name: "slow", run: "sleep 60 & sleep 60", timeoutSeconds: 10 },
    ], dir, shellCheckRun);
    expect(results.map((result) => [result.name, result.passed])).toEqual([["ok", true], ["bad", false], ["slow", false]]);
    expect(results[1]!.detail).toMatch(/^exited 3\n/);
    expect(results[1]!.detail).toContain("nope");
    expect(results[1]!.detail).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(results[2]!.detail).toMatch(/^timed out after 10s/);
    expect(results[2]!.seconds).toBeLessThan(20);
    const report = checksReport(results);
    expect(report).toContain("- ✅ **ok**");
    expect(report).toContain("- ❌ **bad**");
    expect(checksReport([])).toContain("No checks are configured");
  }, 60_000);
});

describe("the Quick loop end to end (#356)", () => {
  it("does not advance past a written verdict while MCP response observation is delayed", async () => {
    const h = await setUp({ checks: [false] });
    h.world.say(ISSUE, "maya", "/rovara quick Retry the payment call on a 503");
    await h.daemon.poll();
    await h.writePlan(PLAN);
    expect(await h.complete("Planned the retry.")).toContain("Accepted");
    h.world.say(ISSUE, "maya", "/rovara approve");
    await h.daemon.poll();
    await h.writePlan(PLAN);
    await h.selfReview();

    let releasePoll!: () => void;
    let sawMissingVerdict!: () => void;
    const missingVerdict = new Promise<void>((resolve) => { sawMissingVerdict = resolve; });
    const delayedPoll = new Promise<void>((resolve) => { releasePoll = resolve; });
    const completion = h.complete("Coded the retry.", async () => {
      sawMissingVerdict();
      await delayedPoll;
    });
    await missingVerdict;
    // Let the instant failed check finish while its MCP acknowledgement is withheld.
    await h.daemon.settle();
    await new Promise((resolve) => setTimeout(resolve, 30));
    releasePoll();
    expect(await completion).toContain("Accepted");
    expect(h.label()).toEqual(["rovara:checking"]);
  });

  it("plans, takes changes into the plan, waits for approval, codes, sends a failing check back, then opens one pull request", async () => {
    const h = await setUp({ checks: [false] });
    // Like this repository: the default branch is mainline, which GitHub says; origin/HEAD is never asked.
    h.world.defaultBranch = "mainline";
    h.world.say(ISSUE, "maya", "/rovara quick Retry the payment call on a 503");
    await h.daemon.poll();
    expect(h.label()).toEqual(["rovara:planning"]);
    expect(h.world.posted(ISSUE).at(-1)).toContain("Nothing is pushed until every document is approved and the checks pass.");
    expect(h.world.sessions.get(SESSION)!.claude.at(-1)).toContain("Your step now: write the plan:");
    expect(h.world.sessions.get(SESSION)!.claude.at(-1)).toContain("Do not change any code yet.");
    expect(h.world.calls).toContainEqual(["git", "-C", h.checkout, "worktree", "add", "-b", "rovara/42", h.worktree(), "origin/mainline"]);

    // A claim is held to the plan's shape.
    expect(await h.complete("Planned it.")).toBe("Not accepted: there is no plan at docs/rovara/42/plan.md; write it there");
    await h.writePlan("## Summary\nRetry on 503.\n");
    expect(await h.complete("Planned it.")).toContain("## Changes, ## Testing");
    await h.writePlan(PLAN);
    expect(await h.complete("Planned the retry.")).toContain("Accepted");
    expect(h.label()).toEqual(["rovara:plan-review"]);
    const review = h.world.posted(ISSUE).at(-1)!;
    expect(review).toContain("<summary>The plan</summary>");
    expect(review).toContain("Retry the payment call on a 503.");
    expect(review).toContain("Approve the plan with `/rovara approve`, or reply with what to change.");

    // Someone else's approval is ignored; a collaborator's reply is a change request that goes into the plan.
    h.world.say(ISSUE, "mallory", "/rovara approve");
    h.world.say(ISSUE, "sam", "Use exponential backoff, capped at 3 tries.");
    await h.daemon.poll();
    expect(await h.step()).toBe("plan");
    expect(h.label()).toEqual(["rovara:planning"]);
    expect(await h.readPlanFile()).toMatch(/\n## Review feedback\n\n- @sam \(.+\): Use exponential backoff, capped at 3 tries\.\n$/u);
    expect(h.world.sessions.get(SESSION)!.received.at(-1)).toContain("@sam asked for changes to the plan");
    const revised = await h.readPlanFile();
    expect(await h.complete("Added backoff to the plan.")).toContain("Accepted");

    // The approval locks the plan; nothing has been pushed.
    h.world.say(ISSUE, "maya", "/rovara approve");
    await h.daemon.poll();
    expect(await h.step()).toBe("code");
    expect(h.label()).toEqual(["rovara:coding"]);
    expect(h.world.posted(ISSUE).at(-1)).toContain("The plan was approved by @maya, and is locked at `docs/rovara/42/plan.md`.");
    expect(h.world.sessions.get(SESSION)!.received.at(-1)).toContain("@maya approved the plan. Your step now: implement it.");
    expect(await h.store.item(h.world.repo, ISSUE)).toMatchObject({ approvals: { plan: { digest: artifactDigest(revised), by: "maya" } } });
    expect(h.world.pushes).toEqual([]);

    // A changed plan is refused, and so is code without a self-review; the code claim goes to the checks.
    await h.writePlan(`${revised}\nOne more idea.\n`);
    const refused = await h.complete("Coded it.");
    expect(refused).toContain("the approved plan at docs/rovara/42/plan.md was changed; put it back as approved");
    expect(refused).toContain("review your own change first, and record it at docs/rovara/42/evidence/self-review.md");
    await h.writePlan(revised);
    await h.selfReview();
    expect(await h.complete("Coded the retry with backoff.")).toContain("Accepted");
    expect(h.label()).toEqual(["rovara:checking"]);
    expect(h.world.posted(ISSUE).at(-1)).toContain("Running the checks.");

    // The first check run fails: back to the agent with the output, and still nothing pushed.
    await h.runOwnSteps();
    expect(h.checkRuns).toEqual([`npm test @ ${h.worktree()}`]);
    expect(await h.step()).toBe("code");
    expect(h.world.posted(ISSUE).at(-1)).toContain("The checks failed, so the change went back to the agent.");
    expect(h.world.sessions.get(SESSION)!.received.at(-1)).toContain("expected 2 calls, got 1");
    expect(h.world.pushes).toEqual([]);

    // Fixed: the checks pass, the branch is pushed, and one pull request opens, linked to the issue.
    expect(await h.complete("Fixed the retry count.")).toContain("Accepted");
    await h.runOwnSteps();
    expect(await h.step()).toBe("pr-open");
    expect(h.label()).toEqual(["rovara:pr-open"]);
    expect(h.world.pushes).toEqual(["rovara/42"]);
    expect(h.world.pullRequests).toHaveLength(1);
    const pull = h.world.pullRequests[0]!;
    expect(pull).toMatchObject({ head: "rovara/42", base: "mainline", title: "Retry payments on 503" });
    expect(pull.body).toContain("Closes #42.");
    expect(pull.body).toContain("Approved: the plan by @maya.");
    // Check and review reports remain outside the committed candidate.
    expect(h.world.loopCommits).toEqual([]);
    expect(pull.body).toContain("## Plan");
    expect(pull.body).toContain("- ✅ **tests**");
    expect(pull.body).toContain("## Reviews\n\n### Code review: passed\n\n### Security review: passed");
    const posted = h.world.posted(ISSUE);
    expect(posted.some((body) => body.includes("The checks passed."))).toBe(true);
    expect(posted.some((body) => body.includes("The reviews passed."))).toBe(true);
    expect(posted.at(-1)).toContain(`Opened pull request #501: ${pull.url}`);
    expect(await h.store.item(h.world.repo, ISSUE)).toMatchObject({ pullRequest: { number: 501, url: pull.url } });

    // A reply on the issue: code, checks again, and the same pull request is updated.
    h.world.say(ISSUE, "sam", "Please also log each retry.");
    await h.daemon.poll();
    expect(await h.step()).toBe("code");
    expect(await h.complete("Logged each retry.")).toContain("Accepted");
    await h.runOwnSteps();
    expect(h.world.pullRequests).toHaveLength(1);
    expect(h.world.pushes).toEqual(["rovara/42", "rovara/42"]);
    expect(h.world.posted(ISSUE).at(-1)).toContain("Pushed the update to pull request #501");
    expect(posted.every((body) => body.startsWith(LOOP_COMMENT_MARKER))).toBe(true);
  });

  it("says a refused push, and tries again on the next reply", async () => {
    const h = await setUp();
    h.world.say(ISSUE, "maya", "/rovara quick Retry the payment call on a 503");
    await h.daemon.poll();
    await h.writePlan(PLAN);
    await h.complete("Planned.");
    h.world.say(ISSUE, "maya", "/rovara approve");
    await h.daemon.poll();
    await h.selfReview();
    h.world.pushRefused = true;
    await h.complete("Coded.");
    await h.runOwnSteps();
    expect(await h.step()).toBe("pr-open");
    expect(h.world.pullRequests).toHaveLength(0);
    expect(h.world.posted(ISSUE).at(-1)).toContain("I couldn't publish the change: git push failed: ! [rejected] (fetch first)");
    h.world.say(ISSUE, "maya", "I rebased the branch; try again.");
    await h.daemon.poll();
    await h.complete("Nothing to change; ready.");
    await h.runOwnSteps();
    expect(h.world.pullRequests).toHaveLength(1);
  });

  it("refuses an approval when nothing waits for one", async () => {
    const h = await setUp();
    h.world.say(ISSUE, "maya", "/rovara quick Retry the payment call on a 503");
    await h.daemon.poll();
    h.world.say(ISSUE, "maya", "/rovara approve");
    await h.daemon.poll();
    expect(await h.step()).toBe("plan");
    expect(h.world.posted(ISSUE).at(-1)).toContain("Nothing is waiting for approval right now.");
  });
});

describe("an agent waiting on a permission prompt (#356, from the #362 smoke test)", () => {
  it("is told on the issue once, after it has waited a minute", async () => {
    const h = await setUp();
    h.world.say(ISSUE, "maya", "/rovara do Fix the flaky retry test");
    await h.daemon.poll();
    const told = () => h.world.posted(ISSUE).filter((body) => body.includes("waiting for your approval")).length;
    h.world.sessions.get(SESSION)!.screen = "Bash command\n git commit -m x\nThis command requires approval\nDo you want to proceed?\n❯ 1. Yes";
    await h.daemon.attend();
    expect(told()).toBe(0);
    h.world.clock += 61_000;
    await h.daemon.attend();
    await h.daemon.attend();
    expect(told()).toBe(1);
    expect(h.world.posted(ISSUE).at(-1)).toContain(`tmux attach -t =${SESSION}`);
    // Answered: the next prompt is a new one, told again after its own minute.
    h.world.sessions.get(SESSION)!.screen = "working…";
    await h.daemon.attend();
    h.world.sessions.get(SESSION)!.screen = "Do you want to proceed?";
    await h.daemon.attend();
    h.world.clock += 61_000;
    await h.daemon.attend();
    expect(told()).toBe(2);
  });
});
