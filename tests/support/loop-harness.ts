// rovara loop (#357, #358): a daemon over the fake world, with the agent's real MCP tool, for loop tests that walk a
// whole loop: write a document in the item's worktree, claim the step, answer a gate, run the loop's own steps. The
// reviewers answer from a queue, by role, and pass when it is empty. Other repositories (#358) each get a checkout
// with their own configuration, registered beside the issue's, and the agent of a per-PR loop can be acted as too.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CheckRun } from "../../packages/cli/src/loop/check-runner.js";
import { LoopDaemon } from "../../packages/cli/src/loop/daemon.js";
import type { Artifact } from "../../packages/cli/src/loop/definitions.js";
import { GitHub } from "../../packages/cli/src/loop/github.js";
import { AgentHarness } from "../../packages/cli/src/loop/harness.js";
import { createLoopMcpServer } from "../../packages/cli/src/loop/mcp.js";
import { artifactPath, docsDir, evidencePath, tmuxSessionName } from "../../packages/cli/src/loop/naming.js";
import type { ReviewerInput, ReviewerRun } from "../../packages/cli/src/loop/reviews.js";
import { LoopStore } from "../../packages/cli/src/loop/state.js";
import { LoopWorld, routeWorlds } from "./loop-fakes.js";

export const LOOP_ISSUE = 42;
export const LOOP_SESSION = "rovara-acme_payments-42";

/** A reviewer's answer: its text, or a run that failed with this reason. */
export type ReviewerAnswer = string | { failed: string };
export const NO_FINDINGS = '{"findings":[]}';
export const SELF_REVIEW = ["# Self-review", "", "## Findings", "- The retry count was off by one.", "", "## Fixed", "- Counted from zero.", ""].join("\n");

export async function createLoopHarness(dirs: string[], options: {
  checks?: boolean[]; collaborators?: string[]; reviews?: string[]; critic?: ReviewerAnswer[]; security?: ReviewerAnswer[];
  /** More lines of .rovara/loop.yaml (#359: `harness:` to run on Codex). */
  config?: string[];
  /** #358: other repositories, registered on this computer, each with its own checkout, collaborators and checks. */
  others?: Array<{ repo: string; collaborators?: string[]; reviews?: string[] }>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "rovara-loop-"));
  dirs.push(root);
  const checkout = join(root, "checkout");
  await mkdir(join(checkout, ".rovara"), { recursive: true });
  await writeFile(join(checkout, ".rovara", "loop.yaml"), [
    "version: 1", `collaborators: [${(options.collaborators ?? ["maya", "sam"]).join(", ")}]`, "checks:", "  - name: tests", "    run: npm test", ...(options.reviews ?? []), ...(options.config ?? []), "",
  ].join("\n"));
  const world = new LoopWorld();
  world.titles.set(LOOP_ISSUE, "Retry payments on 503");
  const others = new Map<string, { world: LoopWorld; checkout: string }>();
  for (const [index, other] of (options.others ?? []).entries()) {
    const otherCheckout = join(root, `checkout-${index + 1}`);
    await mkdir(join(otherCheckout, ".rovara"), { recursive: true });
    await writeFile(join(otherCheckout, ".rovara", "loop.yaml"), [
      "version: 1", `collaborators: [${(other.collaborators ?? ["maya", "sam"]).join(", ")}]`, "checks:", "  - name: web tests", "    run: npm run test:web", ...(other.reviews ?? []), "",
    ].join("\n"));
    const otherWorld = new LoopWorld(other.repo, world.developer, world);
    otherWorld.pullBase = 600 + index * 100;
    others.set(other.repo, { world: otherWorld, checkout: otherCheckout });
  }
  const store = new LoopStore(join(root, "home", ".rovara", "loop"));
  await store.saveRepos([{ repo: world.repo, path: checkout }, ...[...others].map(([repo, other]) => ({ repo, path: other.checkout }))]);
  const exec = others.size === 0 ? world.exec : routeWorlds(world, [...others.values()].map((other) => other.world));
  const outcomes = [...(options.checks ?? [])];
  /** Each check run, as "<command> @ <directory>". */
  const checkRuns: string[] = [];
  const checkRun: CheckRun = async (command, runOptions) => {
    checkRuns.push(`${command} @ ${runOptions.cwd}`);
    return (outcomes.shift() ?? true) ? { code: 0, timedOut: false, output: "all good" } : { code: 1, timedOut: false, output: "FAIL retries" };
  };
  const answers = { CRITIC: [...(options.critic ?? [])], SECURITY: [...(options.security ?? [])] };
  const reviewerRuns: Array<ReviewerInput & { role: "CRITIC" | "SECURITY" }> = [];
  const reviewerRun: ReviewerRun = async (input) => {
    const role = input.prompt.includes("Review role: SECURITY.") ? "SECURITY" : "CRITIC";
    reviewerRuns.push({ ...input, role });
    const answer = answers[role].shift() ?? NO_FINDINGS;
    return typeof answer === "string" ? { ok: true, text: answer } : { ok: false, reason: answer.failed };
  };
  const daemon = new LoopDaemon({
    store, exec, github: new GitHub(exec), harness: new AgentHarness(exec),
    cliCommand: ["/usr/local/bin/node", "/opt/rovara/cli.js"], now: () => new Date(world.clock), log: () => undefined, checkRun, reviewerRun,
  });
  await daemon.poll();
  const worktree = () => join(store.itemDir(world.repo, LOOP_ISSUE), "worktree");
  const write = async (artifact: Artifact, text: string) => {
    const path = join(worktree(), artifactPath(LOOP_ISSUE, artifact));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
  };
  const read = (artifact: Artifact) => readFile(join(worktree(), artifactPath(LOOP_ISSUE, artifact)), "utf8");
  /** #358: a per-PR loop's state, and its agent's session. */
  const pull = (target: string) => store.item(world.repo, LOOP_ISSUE, target);
  const pullSession = (target: string) => world.sessions.get(tmuxSessionName(world.repo, LOOP_ISSUE, target));
  /** The agent records its self-review, which a code claim needs: in the issue's worktree, or a per-PR loop's. */
  const selfReview = async (text = SELF_REVIEW, target?: string) => {
    const state = target === undefined ? undefined : await pull(target);
    const base = state?.worktree?.path ?? worktree();
    const path = join(base, evidencePath(LOOP_ISSUE, "self-review.md", docsDir({ repo: world.repo, issue: LOOP_ISSUE, target })));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
  };
  /** The agent claims its step done through its MCP tool, while the daemon attends to its inbox; `target`: a per-PR loop's agent. */
  const complete = async (summary: string, target?: string) => {
    const server = createLoopMcpServer({ store, repo: world.repo, issue: LOOP_ISSUE, version: "test", pollMs: 5, waitMs: 2_000, ...(target === undefined ? {} : { target }) });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "claude-code", version: "test" });
    await client.connect(clientSide);
    const call = client.callTool({ name: "loop_complete", arguments: { summary } });
    let answered = false;
    void call.finally(() => { answered = true; });
    while (!answered) {
      await daemon.attend();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return ((await call) as { content: Array<{ text: string }> }).content[0]?.text ?? "";
  };
  /** A collaborator comments, and the daemon reads it. */
  const comment = async (author: string, body: string) => {
    world.say(LOOP_ISSUE, author, body);
    await daemon.poll();
  };
  /** The loop's own steps (checks, reviews, publishing) run in the background: attend, let them finish, attend again. */
  const runOwnSteps = async () => {
    for (let round = 0; round < 4; round += 1) {
      await daemon.attend();
      await daemon.settle();
    }
    await daemon.attend();
  };
  const state = () => store.item(world.repo, LOOP_ISSUE);
  const step = async () => (await state())?.step;
  const label = () => [...(world.labels.get(LOOP_ISSUE) ?? [])];
  const lastPosted = () => world.posted(LOOP_ISSUE).at(-1) ?? "";
  const lastReceived = () => world.sessions.get(LOOP_SESSION)?.received.at(-1) ?? "";
  /** #358: another repository's world and checkout. */
  const other = (repo: string) => others.get(repo)!;
  return { root, world, store, daemon, checkout, worktree, write, read, selfReview, complete, comment, runOwnSteps, state, step, label, lastPosted, lastReceived, reviewerRuns, checkRuns, pull, pullSession, other };
}

export async function removeAll(dirs: string[]): Promise<void> {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}
