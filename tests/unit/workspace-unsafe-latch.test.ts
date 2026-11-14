// FIX-RUNNER-ABORT-JOIN review fixes: the latch (H1), the quarantine (M3), the zombie branch (L2).
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunnerKillUnconfirmedError, groupAlive, type GroupProbe } from "../../packages/worker/src/collected-process.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { TaskSandbox } from "../../packages/worker/src/task-sandbox.js";
import { prepareWorkspace } from "../../packages/worker/src/prepare.js";
import { runChecks, type CheckPlan, type CheckRunners } from "../../packages/worker/src/verification/checks.js";
import {
  assertWorkspaceReset, forgetUnwritableMarkers, markWorkspaceUnsafeOnDisk, readWorkspaceUnsafeMarker, withWorkspaceGuard, workspaceUnsafeMarkerPath, type UnsafeWorkspaceRecord,
} from "../../packages/worker/src/workspace-quarantine.js";
import { WorkspaceSafety, currentWorkspaceSafety, markWorkspaceUnsafe, withWorkspaceSafety } from "../../packages/worker/src/workspace-safety.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function directory(): Promise<string> {
  const made = await realpath(await mkdtemp(join(tmpdir(), "unsafe-latch-")));
  cleanup.push(made);
  return made;
}

describe("the workspace-safety latch (H1)", () => {
  it("is set by making a RunnerKillUnconfirmedError inside the task's context, wherever it is caught afterwards", async () => {
    const safety = new WorkspaceSafety();
    await withWorkspaceSafety(safety, async () => {
      // Pi turns a throwing tool into a result: the error is swallowed here, the latch is not.
      await Promise.resolve().then(() => { throw new RunnerKillUnconfirmedError({ kind: "local", pgid: 4242 }); }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(safety.unsafe).toBe(true);
    expect(safety.unconfirmed).toEqual([{ kind: "local", pgid: 4242 }]);
    expect(safety.failure).toBeInstanceOf(RunnerKillUnconfirmedError);
  });

  it("two tasks do not share a latch, and outside a task nothing is recorded", async () => {
    const first = new WorkspaceSafety();
    const second = new WorkspaceSafety();
    await Promise.all([
      withWorkspaceSafety(first, async () => { await new Promise((resolve) => setTimeout(resolve, 5)); markWorkspaceUnsafe({ kind: "sandbox" }); }),
      withWorkspaceSafety(second, async () => { await new Promise((resolve) => setTimeout(resolve, 1)); expect(currentWorkspaceSafety()).toBe(second); }),
    ]);
    expect(first.unsafe).toBe(true);
    expect(second.unsafe).toBe(false);
    expect(currentWorkspaceSafety()).toBeUndefined();
    expect(() => new RunnerKillUnconfirmedError({ kind: "local" })).not.toThrow();
  });

  it("calls a listener for each stop, and for the ones that came before it", () => {
    const safety = new WorkspaceSafety();
    safety.markUnsafe({ kind: "sandbox" });
    const seen: string[] = [];
    safety.onUnsafe((stop) => { seen.push(stop.kind); });
    safety.markUnsafe({ kind: "local" });
    safety.onUnsafe(() => { throw new Error("a failing listener does not hide the latch"); });
    expect(seen).toEqual(["sandbox", "local"]);
    expect(safety.unsafe).toBe(true);
  });
});

describe("the unsafe-stop marker (M3)", () => {
  const record = (over: Partial<UnsafeWorkspaceRecord> = {}): UnsafeWorkspaceRecord => ({ at: new Date().toISOString(), stops: [{ kind: "devcontainer" }], sandboxes: [], ...over });
  /** A fake docker: `inspect` answers by container state. */
  const docker = (state: Record<string, "running" | "stopped" | "gone">): DockerCli => ({
    async run(args) {
      const name = args.at(-1)!;
      const found = state[name] ?? "gone";
      if (args[0] === "inspect") {
        return found === "gone"
          ? { exitCode: 1, stdout: "", stderr: `Error: No such object: ${name}` }
          : { exitCode: 0, stdout: found === "running" ? "true\n" : "false\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  it("is written under the worker's own state directory, and read back", async () => {
    const root = await directory();
    await markWorkspaceUnsafeOnDisk(root, record());
    expect(workspaceUnsafeMarkerPath(root)).toBe(join(root, ".agentx", "workspace-unsafe.json"));
    expect(await readWorkspaceUnsafeMarker(root)).toMatchObject({ stops: [{ kind: "devcontainer" }] });
    expect(await readWorkspaceUnsafeMarker(await directory())).toBeUndefined();
  });

  it("is never cleared for a devcontainer: the next task is refused until an operator resets the workspace", async () => {
    const root = await directory();
    await markWorkspaceUnsafeOnDisk(root, record());
    await expect(assertWorkspaceReset(root)).rejects.toThrow(/could not be confirmed stopped/u);
    await expect(stat(workspaceUnsafeMarkerPath(root))).resolves.toBeDefined();
  });

  it("refuses on a marker it cannot read", async () => {
    const root = await directory();
    await mkdir(join(root, ".agentx"));
    await writeFile(workspaceUnsafeMarkerPath(root), "{ not json");
    await expect(assertWorkspaceReset(root)).rejects.toThrow(/could not be confirmed stopped/u);
  });

  it("refuses while a host process group named in it is alive, and clears the marker when it is gone", async () => {
    const root = await directory();
    await markWorkspaceUnsafeOnDisk(root, record({ stops: [{ kind: "local", pgid: 4242 }] }));
    await expect(assertWorkspaceReset(root, { groupAlive: () => true })).rejects.toThrow(/could not be confirmed stopped/u);
    await assertWorkspaceReset(root, { groupAlive: () => false });
    await expect(stat(workspaceUnsafeMarkerPath(root))).rejects.toThrow(/ENOENT/u);
    // A host stop whose group is unknown cannot be verified.
    await markWorkspaceUnsafeOnDisk(root, record({ stops: [{ kind: "local" }] }));
    await expect(assertWorkspaceReset(root, { groupAlive: () => false })).rejects.toThrow(/could not be confirmed stopped/u);
  });

  it("clears a sandbox stop only when every sandbox in it is verified gone now", async () => {
    const root = await directory();
    await markWorkspaceUnsafeOnDisk(root, record({ stops: [{ kind: "sandbox" }], sandboxes: [{ name: "agentx-task-a", verified: true }] }));
    await expect(assertWorkspaceReset(root, { docker: docker({ "agentx-task-a": "running" }) })).rejects.toThrow(/could not be confirmed stopped/u);
    await assertWorkspaceReset(root, { docker: docker({ "agentx-task-a": "gone" }) });
    await expect(stat(workspaceUnsafeMarkerPath(root))).rejects.toThrow(/ENOENT/u);
    // A sandbox stop with no sandbox on record cannot be verified.
    await markWorkspaceUnsafeOnDisk(root, record({ stops: [{ kind: "sandbox" }], sandboxes: [] }));
    await expect(assertWorkspaceReset(root, { docker: docker({}) })).rejects.toThrow(/could not be confirmed stopped/u);
  });
});

describe("TaskSandbox.quarantine (M3)", () => {
  /** A fake docker with one container: `kill` stops it unless it is stubborn, `rm --force` removes it unless it is stuck. */
  function fakeDocker(options: { stubborn?: boolean } = {}) {
    const calls: string[][] = [];
    const state = { running: false, exists: false };
    const docker: DockerCli = {
      async run(args) {
        calls.push([...args]);
        if (args[0] === "network") return { exitCode: 0, stdout: "bridge {} false", stderr: "" };
        if (args[0] === "run") { state.running = true; state.exists = true; return { exitCode: 0, stdout: "id\n", stderr: "" }; }
        if (args[0] === "kill") { if (!options.stubborn) state.running = false; return { exitCode: 0, stdout: "", stderr: "" }; }
        if (args[0] === "rm") {
          if (options.stubborn) return { exitCode: 1, stdout: "", stderr: "Error response from daemon: cannot remove container: device busy" };
          state.running = false; state.exists = false;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "inspect") {
          if (!state.exists) return { exitCode: 1, stdout: "", stderr: "Error: No such object: x" };
          return { exitCode: 0, stdout: state.running ? "true\n" : "false\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    return { docker, calls, state };
  }
  const IMAGE = "123456789012.dkr.ecr.us-west-2.amazonaws.com/agentx-staging/worker@sha256:" + "b".repeat(64);

  it("kills and removes the container and verifies it is gone before saying so", async () => {
    const root = await directory();
    const fake = fakeDocker();
    const sandbox = new TaskSandbox({ rootPath: root, taskId: "t", docker: fake.docker, image: IMAGE, log: () => undefined });
    await sandbox.start();
    const result = await sandbox.quarantine();
    expect(result).toEqual({ name: sandbox.name, verified: true });
    expect(fake.state).toEqual({ running: false, exists: false });
    const verbs = fake.calls.map((call) => call[0]);
    expect(verbs.indexOf("kill")).toBeLessThan(verbs.indexOf("rm"));
    expect(verbs.lastIndexOf("inspect")).toBeGreaterThan(verbs.indexOf("rm"));
  });

  it("says it is NOT verified when the container is still running afterwards", async () => {
    const root = await directory();
    const fake = fakeDocker({ stubborn: true });
    const sandbox = new TaskSandbox({ rootPath: root, taskId: "t", docker: fake.docker, image: IMAGE, log: () => undefined });
    await sandbox.start();
    expect(await sandbox.quarantine()).toEqual({ name: sandbox.name, verified: false });
  });

  it("has nothing to quarantine when the sandbox never started", async () => {
    const root = await directory();
    const fake = fakeDocker();
    const sandbox = new TaskSandbox({ rootPath: root, taskId: "t", docker: fake.docker, image: IMAGE, log: () => undefined });
    expect(await sandbox.quarantine()).toEqual({ name: sandbox.name, verified: true });
    expect(fake.calls).toEqual([]);
  });
});

describe("the zombie branch of the group probe (L2)", () => {
  /** A fake /proc: one folder per process, each with the `stat` line the kernel writes ("pid (comm) state ppid pgrp ..."). */
  async function proc(members: Array<{ pid: number; comm?: string; state: string; ppid?: number; pgrp: number }>): Promise<GroupProbe> {
    const root = await directory();
    for (const member of members) {
      await mkdir(join(root, String(member.pid)));
      await writeFile(join(root, String(member.pid), "stat"), `${String(member.pid)} (${member.comm ?? "sleep"}) ${member.state} ${String(member.ppid ?? 1)} ${String(member.pgrp)} 0 0 -1 0\n`);
    }
    await mkdir(join(root, "self-not-a-pid"));
    return { kill: () => undefined, platform: "linux", procRoot: root };
  }

  it("a group whose only members are zombies (a killed member under a PID 1 that does not reap) is gone", async () => {
    expect(groupAlive(100, await proc([{ pid: 101, state: "Z", pgrp: 100 }, { pid: 102, state: "Z", pgrp: 100 }]))).toBe(false);
  });

  it("a live member makes the group alive, a member of another group does not, and a comm with spaces and parentheses is read right", async () => {
    expect(groupAlive(100, await proc([{ pid: 101, state: "Z", pgrp: 100 }, { pid: 103, state: "S", pgrp: 100 }]))).toBe(true);
    expect(groupAlive(100, await proc([{ pid: 104, state: "S", pgrp: 200 }]))).toBe(false);
    expect(groupAlive(100, await proc([{ pid: 105, comm: "a b) S 1 100", state: "Z", pgrp: 100 }]))).toBe(false);
    expect(groupAlive(100, await proc([{ pid: 106, comm: "evil) (x", state: "S", pgrp: 100 }]))).toBe(true);
  });

  it("an unreadable /proc counts as alive, and a missing group (ESRCH) as gone, a group of another user (EPERM) as alive", async () => {
    expect(groupAlive(100, { kill: () => undefined, platform: "linux", procRoot: join(await directory(), "no-such-proc") })).toBe(true);
    const failing = (code: string): GroupProbe => ({ kill: () => { throw Object.assign(new Error(code), { code }); }, platform: "linux", procRoot: "/nonexistent" });
    expect(groupAlive(100, failing("ESRCH"))).toBe(false);
    expect(groupAlive(100, failing("EPERM"))).toBe(true);
  });
});

describe("the join timeout belongs to the task that asked for the work (review M-A)", () => {
  const plan: CheckPlan = { source: "project", readiness: [{ cwd: ".", executable: "x", args: [], timeoutSeconds: 5 }], projectBefore: ["passed"] };
  const hanging = (kind?: CheckRunners["kind"]): CheckRunners => ({ ...(kind === undefined ? {} : { kind }), runProjectCommand: () => new Promise(() => undefined), runAgentCommand: async () => { throw new Error("not used"); } });
  const round = (runners: CheckRunners, stop: AbortController) => runChecks(plan, runners, { budgetMs: 60_000, signal: stop.signal, abortJoinMs: 100 });

  it("an abort from the task's own context latches that task, with the runners' own kind", async () => {
    const safety = new WorkspaceSafety();
    const stop = new AbortController();
    const running = withWorkspaceSafety(safety, () => round(hanging("sandbox"), stop));
    withWorkspaceSafety(safety, () => setTimeout(() => stop.abort(), 20));
    await expect(running).rejects.toBeInstanceOf(RunnerKillUnconfirmedError);
    expect(safety.unconfirmed).toEqual([{ kind: "sandbox" }]);
  });

  it("an abort from a context that is in no task (a cancel invocation) still latches the task that asked", async () => {
    const safety = new WorkspaceSafety();
    const stop = new AbortController();
    const running = withWorkspaceSafety(safety, () => round(hanging(), stop));
    setTimeout(() => stop.abort(), 20);
    await expect(running).rejects.toBeInstanceOf(RunnerKillUnconfirmedError);
    // A runner that does not say where it runs is "local" (never the devcontainer default, which no reset could verify).
    expect(safety.unconfirmed).toEqual([{ kind: "local" }]);
  });

  it("an abort from ANOTHER task's context latches the task that asked, and not the other", async () => {
    const asking = new WorkspaceSafety();
    const other = new WorkspaceSafety();
    const stop = new AbortController();
    const running = withWorkspaceSafety(asking, () => round(hanging("devcontainer"), stop));
    withWorkspaceSafety(other, () => setTimeout(() => stop.abort(), 20));
    await expect(running).rejects.toBeInstanceOf(RunnerKillUnconfirmedError);
    expect(asking.unsafe).toBe(true);
    expect(other.unsafe).toBe(false);
  });
});

describe("the guard around every invocation (review M-B, L-3, L-5)", () => {
  it("opens a latch for work that is not a task, quarantines what is registered on it and marks the workspace", async () => {
    const root = await directory();
    const quarantined: string[] = [];
    await withWorkspaceGuard(root, async (safety) => {
      safety.quarantinables.push([{ name: "agentx-task-x", quarantine: async () => { quarantined.push("agentx-task-x"); return { name: "agentx-task-x", verified: true }; } }]);
      expect(currentWorkspaceSafety()).toBe(safety);
      markWorkspaceUnsafe({ kind: "sandbox" });
    });
    expect(quarantined).toEqual(["agentx-task-x"]);
    expect(await readWorkspaceUnsafeMarker(root)).toMatchObject({ stops: [{ kind: "sandbox" }], sandboxes: [{ name: "agentx-task-x", verified: true }] });
  });

  it("an inner guard joins the outer latch instead of opening a second one", async () => {
    const root = await directory();
    await withWorkspaceGuard(root, async (outer) => {
      await withWorkspaceGuard(root, async (inner) => { expect(inner).toBe(outer); });
    });
  });

  it.skipIf(process.getuid?.() === 0)("L-3: a marker that cannot be written fails closed: the next task is refused from memory", async () => {
    const root = await directory();
    // The state directory exists but cannot be written to: the marker cannot be written, and reading it says "no marker" (so only the in-memory refusal can refuse).
    await mkdir(join(root, ".agentx"), { mode: 0o500 });
    await chmod(join(root, ".agentx"), 0o500);
    try {
      await withWorkspaceGuard(root, async () => { markWorkspaceUnsafe({ kind: "local", pgid: 1 }); });
      await expect(readWorkspaceUnsafeMarker(root)).resolves.toBeUndefined();
      await expect(assertWorkspaceReset(root)).rejects.toThrow(/could not be confirmed stopped/u);
    } finally {
      forgetUnwritableMarkers();
      await chmod(join(root, ".agentx"), 0o700);
    }
    await expect(assertWorkspaceReset(root)).resolves.toBeUndefined();
  });

  it("L-5: preparation refuses while the marker stands (it is the first thing prepareWorkspace does)", async () => {
    const root = await directory();
    await markWorkspaceUnsafeOnDisk(root, { at: "x", stops: [{ kind: "devcontainer" }], sandboxes: [] });
    await expect(prepareWorkspace({ rootPath: root, project: {} as never })).rejects.toThrow(/could not be confirmed stopped/u);
  });

  it("main.ts runs every kind of invocation inside the guard (prepare, publish, maintain, task)", async () => {
    const source = await readFile(join(import.meta.dirname, "../../packages/worker/src/main.ts"), "utf8");
    expect(source).toMatch(/execute: \(invocation: WorkerInvocation\): Promise<unknown> => withWorkspaceGuard\(rootPath, async \(\) => \{/u);
  });
});
