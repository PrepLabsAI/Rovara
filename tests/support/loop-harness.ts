// rovara loop (#357): a daemon over the fake world, with the agent's real MCP tool, for loop tests that walk a
// whole loop: write a document in the item's worktree, claim the step, answer a gate, run the loop's own steps.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CheckRun } from "../../packages/cli/src/loop/check-runner.js";
import { LoopDaemon } from "../../packages/cli/src/loop/daemon.js";
import type { Artifact } from "../../packages/cli/src/loop/definitions.js";
import { GitHub } from "../../packages/cli/src/loop/github.js";
import { ClaudeCodeHarness } from "../../packages/cli/src/loop/harness.js";
import { createLoopMcpServer } from "../../packages/cli/src/loop/mcp.js";
import { artifactPath } from "../../packages/cli/src/loop/naming.js";
import { LoopStore } from "../../packages/cli/src/loop/state.js";
import { LoopWorld } from "./loop-fakes.js";

export const LOOP_ISSUE = 42;
export const LOOP_SESSION = "rovara-acme_payments-42";

export async function createLoopHarness(dirs: string[], options: { checks?: boolean[]; collaborators?: string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "rovara-loop-"));
  dirs.push(root);
  const checkout = join(root, "checkout");
  await mkdir(join(checkout, ".rovara"), { recursive: true });
  await writeFile(join(checkout, ".rovara", "loop.yaml"), [
    "version: 1", `collaborators: [${(options.collaborators ?? ["maya", "sam"]).join(", ")}]`, "checks:", "  - name: tests", "    run: npm test", "",
  ].join("\n"));
  const world = new LoopWorld();
  world.titles.set(LOOP_ISSUE, "Retry payments on 503");
  const store = new LoopStore(join(root, "home", ".rovara", "loop"));
  await store.saveRepos([{ repo: world.repo, path: checkout }]);
  const outcomes = [...(options.checks ?? [])];
  const checkRun: CheckRun = async () => (outcomes.shift() ?? true) ? { code: 0, timedOut: false, output: "all good" } : { code: 1, timedOut: false, output: "FAIL retries" };
  const daemon = new LoopDaemon({
    store, exec: world.exec, github: new GitHub(world.exec), harness: new ClaudeCodeHarness(world.exec),
    cliCommand: ["/usr/local/bin/node", "/opt/rovara/cli.js"], now: () => new Date(world.clock), log: () => undefined, checkRun,
  });
  await daemon.poll();
  const worktree = () => join(store.itemDir(world.repo, LOOP_ISSUE), "worktree");
  const write = async (artifact: Artifact, text: string) => {
    const path = join(worktree(), artifactPath(LOOP_ISSUE, artifact));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
  };
  const read = (artifact: Artifact) => readFile(join(worktree(), artifactPath(LOOP_ISSUE, artifact)), "utf8");
  /** The agent claims its step done through its MCP tool, while the daemon attends to its inbox. */
  const complete = async (summary: string) => {
    const server = createLoopMcpServer({ store, repo: world.repo, issue: LOOP_ISSUE, version: "test", pollMs: 5, waitMs: 2_000 });
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
  /** The loop's own steps (checks, publishing) run in the background: attend, let them finish, attend again. */
  const runOwnSteps = async () => {
    for (let round = 0; round < 3; round += 1) {
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
  return { root, world, store, daemon, checkout, worktree, write, read, complete, comment, runOwnSteps, state, step, label, lastPosted, lastReceived };
}

export async function removeAll(dirs: string[]): Promise<void> {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}
