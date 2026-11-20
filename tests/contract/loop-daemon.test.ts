// rovara loop (#355): the daemon end to end on the Do loop, against a fake GitHub, git and tmux with real
// state, and the agent's own MCP tool talking to it through the item's inbox.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { LoopDaemon } from "../../packages/cli/src/loop/daemon.js";
import { GitHub } from "../../packages/cli/src/loop/github.js";
import { AgentHarness } from "../../packages/cli/src/loop/harness.js";
import { createLoopMcpServer } from "../../packages/cli/src/loop/mcp.js";
import { LOOP_COMMENT_MARKER } from "../../packages/cli/src/loop/naming.js";
import { LoopStore } from "../../packages/cli/src/loop/state.js";
import { LoopWorld } from "../support/loop-fakes.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const ISSUE = 42;
const SESSION = "rovara-acme_payments-42";

async function setUp(options: { collaborators?: string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "rovara-loop-"));
  dirs.push(root);
  const checkout = join(root, "checkout");
  await mkdir(join(checkout, ".rovara"), { recursive: true });
  await writeFile(join(checkout, ".rovara", "loop.yaml"), ["version: 1", "collaborators:", ...(options.collaborators ?? ["maya", "sam"]).map((login) => `  - ${login}`), ""].join("\n"));
  const world = new LoopWorld();
  const store = new LoopStore(join(root, "home", ".rovara", "loop"));
  await store.saveRepos([{ repo: world.repo, path: checkout }]);
  const logs: string[] = [];
  // Where Claude Code keeps its conversations, for these tests alone (#391).
  const claudeHome = join(root, "claude");
  /** Claude Code saved a conversation for session `id`, so it can be resumed. */
  const converse = async (id: string) => {
    await mkdir(join(claudeHome, "projects", "-w"), { recursive: true });
    await writeFile(join(claudeHome, "projects", "-w", `${id}.jsonl`), "{}\n");
  };
  const daemon = new LoopDaemon({
    store, exec: world.exec, github: new GitHub(world.exec), harness: new AgentHarness(world.exec, { claudeHome }),
    cliCommand: ["/usr/local/bin/node", "/opt/rovara/cli.js"], now: () => new Date(world.clock), log: (line) => logs.push(line),
  });
  // The daemon's first read starts from now: nothing said before the repository was added is replayed.
  await daemon.poll();
  /** The agent's MCP tools, as Claude Code would call them. */
  const agent = async () => {
    const server = createLoopMcpServer({ store, repo: world.repo, issue: ISSUE, version: "test", pollMs: 5, waitMs: 2_000, sleep: async () => { await daemon.attend(); } });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "claude-code", version: "test" });
    await client.connect(clientSide);
    return client;
  };
  const textOf = (result: unknown) => ((result as { content: Array<{ text: string }> }).content[0]?.text ?? "");
  /** The agent claims its step done, while the daemon attends to its inbox. */
  const complete = async (summary: string) => {
    const client = await agent();
    const call = client.callTool({ name: "loop_complete", arguments: { summary } });
    return textOf(await call);
  };
  return { root, checkout, world, store, daemon, logs, agent, complete, textOf, converse, claudeHome };
}

describe("rovara loop's daemon, on the Do loop (#355)", () => {

  it("takes the agent's claim through its MCP tool, posts the summary, waits, and sends the next reply to the session", async () => {
    const h = await setUp();
    h.world.say(ISSUE, "maya", "/rovara do Fix the flaky retry test");
    await h.daemon.poll();
    expect(await h.complete("  ")).toBe("Not accepted: give a summary of what you did; it is posted on the issue");
    expect(await h.complete("Fixed it: the test now waits on the mock. Committed on rovara/42.")).toContain("Accepted: done: step work is complete");
    expect([...(h.world.labels.get(ISSUE) ?? [])]).toEqual(["rovara:waiting"]);
    expect(h.world.posted(ISSUE).at(-1)).toBe(`${LOOP_COMMENT_MARKER}\nFixed it: the test now waits on the mock. Committed on rovara/42.\n\n---\nReply to continue, or close the issue to finish.`);
    const client = await h.agent();
    expect(h.textOf(await client.callTool({ name: "loop_status", arguments: {} }))).toContain("step waiting. It is the person's turn");
    h.world.say(ISSUE, "sam", "Also rename the helper to waitForMock.");
    await h.daemon.poll();
    expect([...(h.world.labels.get(ISSUE) ?? [])]).toEqual(["rovara:working"]);
    expect(h.world.sessions.get(SESSION)?.received).toEqual(["Reply from @sam on the issue:\nAlso rename the helper to waitForMock.\n\nWhen you have dealt with it, commit, then call loop_complete again with a summary."]);
  });

  it("resumes a working agent's session that ended, and says so after three failures in a row", async () => {
    const h = await setUp();
    h.world.say(ISSUE, "maya", "/rovara do Fix the flaky retry test");
    await h.daemon.poll();
    const id = h.world.sessions.get(SESSION)!.claude[1]!;
    await h.converse(id);
    h.world.sessions.delete(SESSION);
    await h.daemon.attend();
    expect(h.world.started.at(-1)?.claude.slice(0, 2)).toEqual(["--resume", id]);
    expect(h.world.sessions.has(SESSION)).toBe(true);
    // A `claude` that keeps exiting is tried three times, then the issue is told, once.
    h.world.sessionsDie = true;
    h.world.sessions.delete(SESSION);
    for (let attempt = 0; attempt < 5; attempt += 1) await h.daemon.attend();
    expect(h.world.started.length).toBe(1 + 3);
    expect(h.world.posted(ISSUE).filter((body) => body.includes("ended 3 times in a row"))).toHaveLength(1);
  });

  it("starts a session that never began again, with its assignment, instead of resuming nothing (#391)", async () => {
    const h = await setUp();
    h.world.say(ISSUE, "maya", "/rovara do Fix the flaky retry test");
    await h.daemon.poll();
    const first = h.world.sessions.get(SESSION)!.claude;
    const id = first[1]!;
    // It stopped at Claude Code's folder-trust dialog and exited, so Claude Code saved no conversation.
    h.world.sessions.delete(SESSION);
    await h.daemon.attend();
    const again = h.world.started.at(-1)!.claude;
    expect(again.slice(0, 2)).toEqual(["--session-id", id]);
    expect(again.at(-1)).toContain("Fix the flaky retry test");
    expect(again.at(-1)).toContain("Your earlier session ended before it began, so this is your assignment again.");
    // A reply that restarts it is given after the assignment.
    h.world.sessions.delete(SESSION);
    h.world.say(ISSUE, "maya", "Use the retry helper.");
    await h.daemon.poll();
    expect(h.world.started.at(-1)!.claude.at(-1)).toMatch(/Fix the flaky retry test[\s\S]*Since then:\nReply from @maya on the issue:\nUse the retry helper\./u);
  });

  it("holds a message while the agent shows a prompt or dialog, and gives it once the screen is clear (#391)", async () => {
    const h = await setUp();
    h.world.say(ISSUE, "maya", "/rovara do Fix the flaky retry test");
    await h.daemon.poll();
    const session = h.world.sessions.get(SESSION)!;
    session.screen = " Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder";
    h.world.say(ISSUE, "maya", "Also cover a timeout.");
    await h.daemon.poll();
    await h.daemon.attend();
    expect(session.received).toEqual([]);
    session.screen = "";
    await h.daemon.attend();
    expect(session.received).toHaveLength(1);
    expect(session.received[0]).toContain("Also cover a timeout.");
    await h.daemon.attend();
    expect(session.received).toHaveLength(1);
  });

  it("answers a command it cannot run, and records every event", async () => {
    const h = await setUp();
    h.world.say(ISSUE, "maya", "/rovara do");
    await h.daemon.poll();
    expect(h.world.posted(ISSUE).at(-1)).toContain("Say what to do after `/rovara do`");
    h.world.say(ISSUE, "maya", "/rovara do Fix it");
    await h.daemon.poll();
    const events = (await readFile(join(h.store.itemDir(h.world.repo, ISSUE), "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toEqual([expect.objectContaining({ event: "start", author: "maya", from: null, to: "work", effects: ["label", "assign", "comment"] })]);
  });
});
