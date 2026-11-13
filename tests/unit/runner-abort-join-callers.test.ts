// FIX-RUNNER-ABORT-JOIN: the callers of a stop. A stop that cannot be confirmed (RunnerKillUnconfirmedError) is a failure that
// nothing absorbs, and no caller touches the working tree after it. Also the container path, with a fake runner.
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectCommand } from "@agentx/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunnerKillUnconfirmedError, TIMEOUT_KILL_GRACE_MS, runCollected } from "../../packages/worker/src/collected-process.js";
import { CONTAINER_KILL_SCRIPT, CONTAINER_STOP_BOUND_MS, containerBashOperations, runContainerCommand, type ContainerExec } from "../../packages/worker/src/devcontainer.js";
import { runSeeds } from "../../packages/worker/src/service-reset.js";
import { ABORT_JOIN_MS, runChecks, type CheckPlan, type CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { AgentFilesRestoreError, git as runGit, gitOriginalCode, isWorkspaceUnsafe, ORIGINAL_CODE_REF, recoverAgentFiles } from "../../packages/worker/src/verification/original-code.js";

const cleanupDirectories: string[] = [];
afterEach(async () => { await Promise.all(cleanupDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const command: ProjectCommand = { cwd: ".", executable: "make", args: ["test"], timeoutSeconds: 60 };
const plan: CheckPlan = { source: "project", readiness: [command], projectBefore: ["passed"] };
const budget = (signal: AbortSignal, abortJoinMs?: number) => ({ budgetMs: 600_000, signal, ...(abortJoinMs === undefined ? {} : { abortJoinMs }) });
const runnersOf = (runProjectCommand: CheckRunners["runProjectCommand"]): CheckRunners => ({
  runProjectCommand,
  runAgentCommand: async () => { throw new Error("not used"); },
});

describe("runChecks joins an abort", () => {
  it("returns only after the runner it stopped has reported that it has", async () => {
    const controller = new AbortController();
    let runnerSettledAt = 0;
    const runners = runnersOf((_command, signal) => new Promise((_resolve, reject) => {
      // A runner that needs 300 ms after the abort to be really gone, as a TERM-resistant command does.
      signal.addEventListener("abort", () => setTimeout(() => { runnerSettledAt = Date.now(); reject(new Error("aborted")); }, 300), { once: true });
    }));
    setTimeout(() => controller.abort(), 20);
    const round = await runChecks(plan, runners, budget(controller.signal));
    const returnedAt = Date.now();
    expect(runnerSettledAt).toBeGreaterThan(0);
    expect(returnedAt).toBeGreaterThanOrEqual(runnerSettledAt);
    expect(round.stopped).toBe(true);
    expect(round.entries.map((entry) => entry.after)).toEqual(["not_run"]);
  });

  it("throws RunnerKillUnconfirmedError when the runner has not reported within the bound", async () => {
    const controller = new AbortController();
    const runners = runnersOf(() => new Promise(() => undefined));
    setTimeout(() => controller.abort(), 20);
    const startedAt = Date.now();
    await expect(runChecks(plan, runners, budget(controller.signal, 150))).rejects.toBeInstanceOf(RunnerKillUnconfirmedError);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });

  it("rethrows a runner's own kill-unconfirmed, not an 'aborted' check entry", async () => {
    const controller = new AbortController();
    const runners = runnersOf((_command, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new RunnerKillUnconfirmedError({ kind: "local" })), { once: true });
    }));
    setTimeout(() => controller.abort(), 20);
    await expect(runChecks(plan, runners, budget(controller.signal, 5_000))).rejects.toBeInstanceOf(RunnerKillUnconfirmedError);
  });

  it("closes the round (endRound) even when the stop could not be confirmed", async () => {
    const controller = new AbortController();
    const endRound = vi.fn(async () => undefined);
    const runners: CheckRunners = { ...runnersOf(() => new Promise(() => undefined)), endRound };
    setTimeout(() => controller.abort(), 20);
    await expect(runChecks(plan, runners, budget(controller.signal, 50))).rejects.toBeInstanceOf(RunnerKillUnconfirmedError);
    expect(endRound).toHaveBeenCalledTimes(1);
  });

  it("a seed's unconfirmed stop is not turned into 'stopped' or 'seed_failed' (and the round's reset step rethrows it)", async () => {
    const controller = new AbortController();
    controller.abort();
    const seeds = [{ command }] as unknown as Parameters<typeof runSeeds>[1];
    const ports = { runCommand: async () => { throw new RunnerKillUnconfirmedError({ kind: "local" }); }, applyFixture: async () => undefined } as unknown as Parameters<typeof runSeeds>[2];
    // The signal is aborted AFTER the first check, so the seed command is reached.
    const live = new AbortController();
    const running = runSeeds("db", seeds, ports, live.signal);
    live.abort();
    await expect(running).rejects.toBeInstanceOf(RunnerKillUnconfirmedError);
    const reset = runnersOf(async () => ({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }));
    const failing: CheckRunners = {
      ...reset,
      freshServices: async () => { throw new RunnerKillUnconfirmedError({ kind: "local" }); },
    };
    await expect(runChecks(plan, failing, budget(new AbortController().signal))).rejects.toBeInstanceOf(RunnerKillUnconfirmedError);
  });
});

describe("gitOriginalCode after a stop that could not be confirmed", () => {
  const cleanup: string[] = [];
  afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
  const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, ...args], { env: { ...process.env, ...identity }, encoding: "utf8" }).trim();

  async function repository() {
    const directory = realpathSync(await mkdtemp(join(tmpdir(), "abort-join-original-")));
    cleanup.push(directory);
    git(directory, "init", "-q", "-b", "main");
    await writeFile(join(directory, "value.ts"), "original\n");
    git(directory, "add", "-A");
    git(directory, "commit", "-q", "-m", "start");
    const start = git(directory, "rev-parse", "HEAD");
    await writeFile(join(directory, "value.ts"), "the agent's version\n");
    return { directory, start };
  }

  it("does not restore (and so cannot be overwritten by a late write): the agent's files stay under the private ref, the task must stop", async () => {
    const { directory, start } = await repository();
    const work = async () => { throw new RunnerKillUnconfirmedError({ kind: "local" }); };
    const failure = await gitOriginalCode([{ directory, commit: start }]).run(work).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentFilesRestoreError);
    expect(isWorkspaceUnsafe(failure)).toBe(true);
    // The workspace was not touched after the stop: it still shows the original code, which is what a late write would race.
    expect(await readFile(join(directory, "value.ts"), "utf8")).toBe("original\n");
    expect(git(directory, "rev-parse", "--verify", ORIGINAL_CODE_REF)).toMatch(/^[0-9a-f]{40}$/);
    // The next task start puts the agent's files back, as for any worker that stopped mid-way.
    expect(await recoverAgentFiles([directory])).toEqual([directory]);
    expect(await readFile(join(directory, "value.ts"), "utf8")).toBe("the agent's version\n");
    expect(await runGit(directory, ["status", "--porcelain"])).toBe("M value.ts");
  });

  it("rethrows an unconfirmed stop as it is when nothing was swapped", async () => {
    const { directory } = await repository();
    // The agent's tree is the shown tree (the commit it started from is its own head): nothing is swapped.
    git(directory, "add", "-A");
    git(directory, "commit", "-q", "-m", "agent");
    const head = git(directory, "rev-parse", "HEAD");
    const failure = await gitOriginalCode([{ directory, commit: head }]).run(async () => { throw new RunnerKillUnconfirmedError({ kind: "local" }); }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RunnerKillUnconfirmedError);
    expect(isWorkspaceUnsafe(failure)).toBe(true);
  });

  it("still restores after a stop that was confirmed (an ordinary failure of the work)", async () => {
    const { directory, start } = await repository();
    await expect(gitOriginalCode([{ directory, commit: start }]).run(async () => { throw new Error("aborted"); })).rejects.toThrow("aborted");
    expect(await readFile(join(directory, "value.ts"), "utf8")).toBe("the agent's version\n");
    expect(() => git(directory, "rev-parse", "--verify", "--quiet", ORIGINAL_CODE_REF)).toThrow();
  });
});

describe("a container's stop is joined (a fake container runner)", () => {
  /**
   * A fake container: the command runs until the group is signalled (TERM, when `obeysTerm`) or killed (KILL). The local client (the
   * main exec) returns when the command is gone or its client is aborted. `events` records what happened in order.
   */
  function fakeContainer(behaviour: { obeysTerm: boolean; failStep?: "TERM" | "KILL"; noProcessGroup?: boolean; clientIgnoresAbort?: boolean }) {
    const events: string[] = [];
    const state = { commandRunning: false };
    let leaderReturned: (() => void) | undefined;
    const exec: ContainerExec = (argv, options) => {
      const script = argv[2] ?? "";
      if (script.includes("kill -TERM")) {
        events.push("TERM");
        if (behaviour.noProcessGroup) {
          // The wrapper's group file is not there: the command has not started yet, or it has already ended and removed it.
          if (behaviour.obeysTerm) { state.commandRunning = false; leaderReturned?.(); }
          return Promise.resolve({ exitCode: 3, stdout: "no process group\n", stderr: "" });
        }
        if (behaviour.failStep === "TERM") return Promise.resolve({ exitCode: 1, stdout: "kill: Operation not permitted\n", stderr: "" });
        if (behaviour.obeysTerm) { state.commandRunning = false; leaderReturned?.(); }
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      }
      if (script.includes("kill -KILL")) {
        events.push("KILL");
        if (behaviour.noProcessGroup) return Promise.resolve({ exitCode: 3, stdout: "no process group\n", stderr: "" });
        if (behaviour.failStep === "KILL") return Promise.resolve({ exitCode: 1, stdout: "kill: Operation not permitted\n", stderr: "" });
        state.commandRunning = false;
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      }
      // The command itself.
      state.commandRunning = true;
      return new Promise((resolve) => {
        leaderReturned = () => resolve({ exitCode: 143, stdout: "", stderr: "" });
        if (behaviour.clientIgnoresAbort) return;
        options.signal?.addEventListener("abort", () => { events.push("client-aborted"); resolve({ exitCode: null, stdout: "", stderr: "" }); }, { once: true });
      });
    };
    return { exec, events, state };
  }

  it("a command that ignores TERM: an abort settles only after the grace period and the KILL, when the command is dead", async () => {
    vi.useFakeTimers();
    try {
      const { exec, events, state } = fakeContainer({ obeysTerm: false });
      const controller = new AbortController();
      let settled = false;
      const running = containerBashOperations(exec).exec("sleep 60", "/w", { onData: () => undefined, signal: controller.signal });
      const outcome = running.then(() => "returned", (error: unknown) => (error instanceof Error ? error.message : "?"));
      void outcome.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(state.commandRunning).toBe(true);
      controller.abort();
      await vi.advanceTimersByTimeAsync(TIMEOUT_KILL_GRACE_MS - 1);
      // Not settled before the KILL: the command is still running, and a caller that touched the workspace now would race it.
      expect(settled).toBe(false);
      expect(state.commandRunning).toBe(true);
      await vi.advanceTimersByTimeAsync(2);
      expect(await outcome).toBe("aborted");
      expect(state.commandRunning).toBe(false);
      expect(events).toEqual(["TERM", "KILL", "client-aborted"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a command that obeys TERM: the abort does not wait out the grace period", async () => {
    vi.useFakeTimers();
    try {
      const { exec, events, state } = fakeContainer({ obeysTerm: true });
      const controller = new AbortController();
      const running = containerBashOperations(exec).exec("sleep 60", "/w", { onData: () => undefined, signal: controller.signal });
      const outcome = running.then(() => "returned", (error: unknown) => (error instanceof Error ? error.message : "?"));
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(100);
      expect(await outcome).toBe("aborted");
      expect(state.commandRunning).toBe(false);
      // What is left of the group is still killed.
      expect(events.slice(0, 2)).toEqual(["TERM", "KILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["TERM", "KILL"] as const)("a failed %s step is kill-unconfirmed, for the agent's shell and for a project command", async (failStep) => {
    vi.useFakeTimers();
    try {
      for (const mode of ["shell", "project"] as const) {
        const { exec } = fakeContainer({ obeysTerm: false, failStep });
        const controller = new AbortController();
        const running = mode === "shell"
          ? containerBashOperations(exec).exec("sleep 60", "/w", { onData: () => undefined, signal: controller.signal })
          : runContainerCommand(exec, "/w", { cwd: ".", executable: "sleep", args: ["60"], timeoutSeconds: 600 }, controller.signal);
        const outcome = running.then(() => "returned", (error: unknown) => error);
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        await vi.advanceTimersByTimeAsync(TIMEOUT_KILL_GRACE_MS + 1_000);
        expect(await outcome).toBeInstanceOf(RunnerKillUnconfirmedError);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("a confirmed abort of a project command still returns the usual aborted result for the check round to discard", async () => {
    vi.useFakeTimers();
    try {
      const { exec } = fakeContainer({ obeysTerm: false });
      const controller = new AbortController();
      const running = runContainerCommand(exec, "/w", { cwd: ".", executable: "sleep", args: ["60"], timeoutSeconds: 600 }, controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(TIMEOUT_KILL_GRACE_MS + 1_000);
      await expect(running).resolves.toMatchObject({ exitCode: -1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a container's stop: timeouts, a missing process group, a client that will not end, the bounds (review M1, M2, L3, L5)", () => {
  // Reuses the fake from the describe above through a second copy of its shape: kept local so each test names exactly what it fakes.
  function container(behaviour: { obeysTerm: boolean; failStep?: "TERM" | "KILL"; noProcessGroup?: boolean; clientIgnoresAbort?: boolean }) {
    const state = { commandRunning: true };
    let endCommand: (() => void) | undefined;
    const exec: ContainerExec = (argv, options) => {
      const script = argv[2] ?? "";
      const step = script.includes("kill -TERM") ? "TERM" : script.includes("kill -KILL") ? "KILL" : undefined;
      if (step !== undefined) {
        if (behaviour.failStep === step) return Promise.resolve({ exitCode: 1, stdout: "kill: Operation not permitted\n", stderr: "" });
        if (step === "TERM" && behaviour.obeysTerm) endCommand?.();
        return Promise.resolve(behaviour.noProcessGroup ? { exitCode: 3, stdout: "no process group\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
      }
      return new Promise((resolve) => {
        endCommand = () => resolve({ exitCode: 143, stdout: "", stderr: "" });
        if (!behaviour.clientIgnoresAbort) options.signal?.addEventListener("abort", () => resolve({ exitCode: null, stdout: "", stderr: "" }), { once: true });
      });
    };
    return { exec, state };
  }
  const outcomeOf = (running: Promise<unknown>) => running.then(() => "returned", (error: unknown) => error);

  it.each(["TERM", "KILL"] as const)("M1: a TIMED-OUT command whose %s step failed is an unconfirmed stop, for the agent's shell and for a project command", async (failStep) => {
    vi.useFakeTimers();
    try {
      for (const mode of ["shell", "project"] as const) {
        const { exec } = container({ obeysTerm: false, failStep });
        const running = mode === "shell"
          ? containerBashOperations(exec).exec("sleep 60", "/w", { onData: () => undefined, timeout: 1 })
          : runContainerCommand(exec, "/w", { cwd: ".", executable: "sleep", args: ["60"], timeoutSeconds: 1 });
        const outcome = outcomeOf(running);
        await vi.advanceTimersByTimeAsync(1_000 + TIMEOUT_KILL_GRACE_MS + 1_000);
        expect(await outcome, mode).toBeInstanceOf(RunnerKillUnconfirmedError);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("M1: a timed-out command whose stop worked is still just a timeout", async () => {
    vi.useFakeTimers();
    try {
      const { exec } = container({ obeysTerm: true });
      const running = containerBashOperations(exec).exec("sleep 60", "/w", { onData: () => undefined, timeout: 1 });
      const outcome = outcomeOf(running);
      await vi.advanceTimersByTimeAsync(1_000 + TIMEOUT_KILL_GRACE_MS + 1_000);
      expect(String(await outcome)).toContain("timeout:1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("M2: no process group while the command's own exec has not returned is unconfirmed (it may not have started yet)", async () => {
    vi.useFakeTimers();
    try {
      const { exec } = container({ obeysTerm: false, noProcessGroup: true });
      const controller = new AbortController();
      const running = containerBashOperations(exec).exec("sleep 60", "/w", { onData: () => undefined, signal: controller.signal });
      const outcome = outcomeOf(running);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(TIMEOUT_KILL_GRACE_MS + 1_000);
      expect(await outcome).toBeInstanceOf(RunnerKillUnconfirmedError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("M2: no process group because the command already ended (its exec returned first) is a confirmed stop", async () => {
    vi.useFakeTimers();
    try {
      const { exec } = container({ obeysTerm: true, noProcessGroup: true });
      const controller = new AbortController();
      const running = containerBashOperations(exec).exec("sleep 60", "/w", { onData: () => undefined, signal: controller.signal });
      const outcome = outcomeOf(running);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await outcome).toEqual(new Error("aborted"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("M2: the KILL script looks again after the kill, and a group that is still alive is not a confirmed stop (real bash, bounded)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "abort-join-kill-"));
    cleanupDirectories.push(directory);
    const groupFile = join(directory, "group.pgid");
    // A group that signals cannot end: `kill` here reports success for KILL and does nothing, as a process stuck in the kernel would look.
    const stubborn = join(directory, "stubborn.sh");
    await writeFile(stubborn, 'kill() { case "$1" in -KILL) return 0;; esac; builtin kill "$@"; }\n');
    const member = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    member.unref();
    try {
      await writeFile(groupFile, String(member.pid));
      const startedAt = Date.now();
      const result = await runCollected("bash", ["-c", CONTAINER_KILL_SCRIPT, "bash", groupFile], { env: { PATH: process.env.PATH, BASH_ENV: stubborn }, timeoutMs: 20_000 });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("still running after KILL");
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_500);
      // And with a kill that works, the same script confirms.
      await writeFile(groupFile, String(member.pid));
      const worked = await runCollected("bash", ["-c", CONTAINER_KILL_SCRIPT, "bash", groupFile], { timeoutMs: 20_000 });
      expect(worked.exitCode).toBe(0);
      // No group ID at all is exit 3, never 0.
      const none = await runCollected("bash", ["-c", CONTAINER_KILL_SCRIPT, "bash", join(directory, "missing.pgid")], { timeoutMs: 20_000 });
      expect(none.exitCode).toBe(3);
    } finally {
      try { process.kill(-member.pid!, "SIGKILL"); } catch { /* gone */ }
    }
  }, 40_000);

  it("L5: a local client that ignores its abort does not hold the caller for ever: unconfirmed once the stop sequence and CLIENT_END_BOUND have passed", async () => {
    vi.useFakeTimers();
    try {
      const { exec } = container({ obeysTerm: false, clientIgnoresAbort: true });
      const controller = new AbortController();
      const running = containerBashOperations(exec).exec("sleep 60", "/w", { onData: () => undefined, signal: controller.signal });
      const outcome = outcomeOf(running);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(CONTAINER_STOP_BOUND_MS + 1_000);
      expect(await outcome).toBeInstanceOf(RunnerKillUnconfirmedError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("L3: runChecks waits longer than the container's own worst case, so a stop still inside its bound is never given up on", () => {
    expect(CONTAINER_STOP_BOUND_MS).toBeGreaterThanOrEqual(35_000);
    expect(ABORT_JOIN_MS).toBeGreaterThan(CONTAINER_STOP_BOUND_MS);
  });
});
