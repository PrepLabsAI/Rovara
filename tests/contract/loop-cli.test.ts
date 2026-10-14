// rovara loop (#355): the commands that set a repository up and show where its loops stand.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeCli } from "../../packages/cli/src/main.js";
import { LoopStore } from "../../packages/cli/src/loop/state.js";
import { LoopWorld } from "../support/loop-fakes.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function setUp() {
  const root = await mkdtemp(join(tmpdir(), "rovara-loop-cli-"));
  dirs.push(root);
  const home = join(root, "home");
  const checkout = join(root, "checkout");
  await mkdir(checkout, { recursive: true });
  const world = new LoopWorld();
  const out: string[] = [];
  const err: string[] = [];
  const run = (argv: string[]) => executeCli(argv, {
    environments: { home }, loop: { exec: world.exec, cliCommand: ["/usr/local/bin/node", "/opt/rovara/cli.js"] },
    stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) },
  });
  return { root, home, checkout, world, out, err, run, store: new LoopStore(join(home, ".rovara", "loop")) };
}

describe("rovara loop's setup commands (#355)", () => {
  it("init writes the repository's config with the developer as its one collaborator, once", async () => {
    const h = await setUp();
    expect(await h.run(["loop", "init", h.checkout])).toBe(0);
    const config = await readFile(join(h.checkout, ".rovara", "loop.yaml"), "utf8");
    expect(config).toContain("collaborators:\n  - maya\n");
    expect(config).toContain("name: claude-code");
    expect(await h.run(["loop", "init", h.checkout])).toBe(0);
    expect(h.out.join("")).toContain(".rovara/loop.yaml already exists; nothing changed.");
  });

  it("add registers a configured repository, and refuses one without a config", async () => {
    const h = await setUp();
    expect(await h.run(["loop", "add", h.checkout])).not.toBe(0);
    expect(h.err.join("")).toContain(".rovara/loop.yaml is missing");
    await h.run(["loop", "init", h.checkout]);
    expect(await h.run(["loop", "add", h.checkout])).toBe(0);
    expect(await h.store.repos()).toEqual([{ repo: "acme/payments", path: h.checkout }]);
    expect(await h.run(["loop", "add", h.checkout])).toBe(0);
    expect(await h.store.repos()).toHaveLength(1);
  });

  it("requires an explicit lane mode before writing enrollment state", async () => {
    const h = await setUp();
    await h.run(["loop", "init", h.checkout]);
    await h.run(["loop", "add", h.checkout]);
    const before = await h.store.enrollments();
    expect(await h.run(["loop", "enroll", "acme/payments"])).not.toBe(0);
    expect(await h.store.enrollments()).toEqual(before);
    expect(await h.run(["loop", "enroll", "acme/payments", "--issue", "42"])).not.toBe(0);
    expect(await h.store.enrollments()).toEqual(before);
    expect(await h.run(["loop", "enroll", "acme/payments", "--target", "acme/payments"])).not.toBe(0);
    expect(await h.store.enrollments()).toEqual(before);
    const worldExec = h.world.exec;
    h.world.exec = async (command, args, options) => command === "gh" && args[0] === "api" && args[1] === "repos/acme/payments" && args.at(-1) === ".id"
      ? { code: 0, stdout: "1234\n", stderr: "" }
      : worldExec(command, args, options);
    expect(await h.run(["loop", "enroll", "acme/payments", "--standalone-local"])).toBe(0);
    expect(await h.store.enrollments()).toMatchObject([{ kind: "standalone-local", project: "acme/payments" }]);
  });

  it("refuses a config that names no collaborator, or another agent", async () => {
    const h = await setUp();
    await mkdir(join(h.checkout, ".rovara"), { recursive: true });
    await writeFile(join(h.checkout, ".rovara", "loop.yaml"), "version: 1\ncollaborators: []\n");
    expect(await h.run(["loop", "add", h.checkout])).not.toBe(0);
    expect(h.err.join("")).toContain(".rovara/loop.yaml: collaborators:");
    await writeFile(join(h.checkout, ".rovara", "loop.yaml"), "version: 1\ncollaborators: [maya]\nharness:\n  name: cursor\n");
    expect(await h.run(["loop", "add", h.checkout])).not.toBe(0);
  });

  it("status and check show where each issue's loop stands, and how to watch its agent", async () => {
    const h = await setUp();
    await h.run(["loop", "init", h.checkout]);
    await h.run(["loop", "add", h.checkout]);
    await h.store.saveItem({
      version: 1, repo: "acme/payments", issue: 42, loop: "do", step: "work", startedBy: "maya", instruction: "Fix it",
      startedAt: "2026-10-12T12:00:00.000Z", stepEnteredAt: "2026-10-12T12:00:00.000Z",
      session: { harness: "claude-code", tmux: "rovara-acme_payments-42", id: "11111111-1111-4111-8111-111111111111" },
      worktree: { path: "/tmp/w", branch: "rovara/42" },
    });
    expect(await h.run(["loop", "status"])).toBe(0);
    expect(h.out.join("")).toContain("Daemon: not running (rovara loop start).");
    expect(h.out.join("")).toContain("  #42  do  work  tmux attach -t =rovara-acme_payments-42");
    expect(await h.run(["loop", "check", "42", "--repo", "acme/payments"])).toBe(0);
    expect(h.out.join("")).toContain("acme/payments#42: loop do, step work (agent's turn) since 2026-10-12T12:00:00.000Z");
    expect(h.out.join("")).toContain("The issue should carry the label rovara:working.");
    expect(await h.run(["loop", "check", "7", "--repo", "acme/payments"])).toBe(0);
    expect(h.out.join("")).toContain("No loop has run on acme/payments#7.");
  });

  it("do asks for a Do loop by posting the command on the issue as the developer", async () => {
    const h = await setUp();
    expect(await h.run(["loop", "do", "--issue", "42", "--repo", h.checkout, "Fix", "the", "flaky", "test"])).toBe(0);
    expect(h.world.comments.map((comment) => [comment.issue, comment.author, comment.body])).toEqual([[42, "maya", "/rovara do Fix the flaky test"]]);
    expect(h.out.join("")).toContain("it is not running: rovara loop start");
  });
});
