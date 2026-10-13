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
import { ClaudeCodeHarness } from "../../packages/cli/src/loop/harness.js";
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
  const daemon = new LoopDaemon({
    store, exec: world.exec, github: new GitHub(world.exec), harness: new ClaudeCodeHarness(world.exec),
    cliCommand: ["/usr/local/bin/node", "/opt/rovara/cli.js"], now: () => new Date(world.clock), log: (line) => logs.push(line),
  });
  // The daemon's first read starts from now: nothing said before the repository was added is replayed.
  await daemon.poll();
  /** The agent's MCP tools, as Claude Code would call them. */
  const agent = async () => {
    const server = createLoopMcpServer({ store, repo: world.repo, issue: ISSUE, version: "test", pollMs: 5, waitMs: 2_000 });
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
    let answered = false;
    void call.finally(() => { answered = true; });
    while (!answered) {
      await daemon.attend();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return textOf(await call);
  };
  return { root, checkout, world, store, daemon, logs, agent, complete, textOf };
}

describe("rovara loop's daemon, on the Do loop (#355)", () => {
  it("starts on a collaborator's /rovara do: label, worktree, a Claude Code session in tmux with the loop's tools, and a comment", async () => {
    const h = await setUp();
    h.world.say(ISSUE, "maya", "/rovara do Fix the flaky retry test");
    await h.daemon.poll();
    expect([...(h.world.labels.get(ISSUE) ?? [])]).toEqual(["rovara:working"]);
    const session = h.world.sessions.get(SESSION)!;
    expect(session.cwd).toBe(h.store.itemDir(h.world.repo, ISSUE) + "/worktree");
    const [flag, id, mcpFlag, mcpPath, end, prompt] = session.claude;
    expect(end).toBe("--");
    expect(flag).toBe("--session-id");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(mcpFlag).toBe("--mcp-config");
    expect(prompt).toContain("Instruction from @maya:\nFix the flaky retry test");
    // The agent's tools are this CLI's `loop mcp` for this one issue, never the developer's global settings.
    expect(JSON.parse(await readFile(mcpPath!, "utf8"))).toEqual({ mcpServers: { "rovara-loop": { command: "/usr/local/bin/node", args: ["/opt/rovara/cli.js", "loop", "mcp", "--repo", "acme/payments", "--issue", "42"] } } });
    expect(h.world.calls).toContainEqual(["git", "-C", h.checkout, "worktree", "add", "-b", "rovara/42", session.cwd, "origin/main"]);
    const posted = h.world.posted(ISSUE);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatch(new RegExp(`^${LOOP_COMMENT_MARKER}\\nStarted the \\*\\*do\\*\\* loop for @maya`));
    expect(await h.store.item(h.world.repo, ISSUE)).toMatchObject({ step: "work", session: { tmux: SESSION, id }, worktree: { branch: "rovara/42" } });
  });

  it("obeys only collaborators, never its own comments, and nothing said before the repository was added", async () => {
    const h = await setUp();
    h.world.say(ISSUE, "mallory", "/rovara do delete the CI config");
    h.world.say(ISSUE, h.world.developer, `${LOOP_COMMENT_MARKER}\n/rovara do this looks like a command`);
    await h.daemon.poll();
    expect(h.world.sessions.size).toBe(0);
    expect(await h.store.item(h.world.repo, ISSUE)).toBeUndefined();
    // A repository added later never replays its history.
    const later = await setUp();
    later.world.comments.push({ id: 1, issue: 7, author: "maya", body: "/rovara do old request", updated_at: "2026-10-01T00:00:00.000Z" });
    await later.daemon.poll();
    expect(later.world.sessions.size).toBe(0);
  });

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
    expect(h.world.sessions.get(SESSION)?.received).toEqual(["Reply from @sam on the issue:\nAlso rename the helper to waitForMock.\n\nWhen you have dealt with it, call loop_complete again with a summary."]);
  });

  it("resumes a working agent's session that ended, and says so after three failures in a row", async () => {
    const h = await setUp();
    h.world.say(ISSUE, "maya", "/rovara do Fix the flaky retry test");
    await h.daemon.poll();
    const id = h.world.sessions.get(SESSION)!.claude[1];
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

  it("ends when the issue is closed or a collaborator says /rovara stop: label removed, session ended", async () => {
    const h = await setUp();
    h.world.say(ISSUE, "maya", "/rovara do Fix the flaky retry test");
    await h.daemon.poll();
    h.world.closed.add(ISSUE);
    await h.daemon.poll();
    expect(h.world.labels.get(ISSUE)?.size).toBe(0);
    expect(h.world.sessions.has(SESSION)).toBe(false);
    expect(await h.store.item(h.world.repo, ISSUE)).toMatchObject({ step: "ended" });

    const stopped = await setUp();
    stopped.world.say(ISSUE, "maya", "/rovara do Fix the flaky retry test");
    await stopped.daemon.poll();
    stopped.world.say(ISSUE, "sam", "/rovara stop");
    await stopped.daemon.poll();
    expect(stopped.world.sessions.has(SESSION)).toBe(false);
    expect(stopped.world.posted(ISSUE).at(-1)).toContain("Stopped by @sam. The agent's session has ended; its branch `rovara/42` is kept.");
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
