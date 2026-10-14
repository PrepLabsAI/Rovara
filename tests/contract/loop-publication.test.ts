import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LoopDaemon } from "../../packages/cli/src/loop/daemon.js";
import { GitHub } from "../../packages/cli/src/loop/github.js";
import { AgentHarness } from "../../packages/cli/src/loop/harness.js";
import { LoopStore } from "../../packages/cli/src/loop/state.js";
import { LoopWorld } from "../support/loop-fakes.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function setup(options: { driftBeforePush?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "rovara-publish-"));
  dirs.push(root);
  const checkout = join(root, "checkout");
  const worktree = join(root, "worktree");
  await mkdir(join(checkout, ".rovara"), { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(join(checkout, ".rovara", "loop.yaml"), "version: 1\ncollaborators: [maya]\n");
  const world = new LoopWorld();
  const store = new LoopStore(join(root, "home", ".rovara", "loop"));
  await store.saveRepos([{ repo: world.repo, path: checkout }]);
  const checked = { branch: "rovara/42", commitSha: "a".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "c".repeat(40) };
  const changed = { ...checked, commitSha: "d".repeat(40) };
  let capture = 0;
  const daemon = new LoopDaemon({
    store, exec: world.exec, github: new GitHub(world.exec), harness: new AgentHarness(world.exec),
    cliCommand: ["node", "/opt/rovara/cli.js"], now: () => new Date(world.clock), log: () => undefined,
    captureCandidate: async () => options.driftBeforePush && ++capture >= 2 ? changed : checked,
    resolvePublicationContext: async () => ({ kind: "hold", reasonCode: "native_join_unavailable" }),
  });
  await store.saveItem({
    version: 1, repo: world.repo, issue: 42, loop: "quick", step: "publish", startedBy: "maya", instruction: "Retry payment",
    startedAt: new Date(world.clock).toISOString(), stepEnteredAt: new Date(world.clock).toISOString(),
    worktree: { path: worktree, branch: "rovara/42" }, checks: "Checks passed.", reviews: "Reviews passed.",
    checksCandidate: checked, reviewsCandidate: checked,
  });
  return { world, store, daemon };
}

describe("the LoopDaemon publication boundary", () => {
  it("holds a registered lane with missing native join and performs zero push or PR effects", async () => {
    const h = await setup();
    await h.daemon.attend();
    await h.daemon.settle();
    await h.daemon.attend();
    expect((await h.store.item(h.world.repo, 42))?.step).toBe("publication-blocked");
    expect(h.world.pushes).toEqual([]);
    expect(h.world.pullRequests).toEqual([]);
    expect(h.world.calls.some((call) => call[0] === "git" && call.includes("push"))).toBe(false);
    expect(h.world.posted(42).at(-1)).toContain("Publication is on hold: native_join_unavailable");
  });

  it("holds an equal-tree replacement commit detected immediately before push", async () => {
    const h = await setup({ driftBeforePush: true });
    await h.daemon.attend();
    await h.daemon.settle();
    await h.daemon.attend();
    expect((await h.store.item(h.world.repo, 42))?.step).toBe("publication-blocked");
    expect(h.world.pushes).toEqual([]);
    expect(h.world.pullRequests).toEqual([]);
    expect(h.world.posted(42).at(-1)).toContain("candidate changed after qualification");
  });
});
