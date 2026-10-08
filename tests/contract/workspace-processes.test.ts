import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pushCommitFromIsolatedRepository, runGitWithCredential } from "../../packages/worker/src/git-auth.js";
import { processesToStop, stopWorkspaceProcesses, unstoppableProcesses, workspaceProcessScope, type ProcessEntry } from "../../packages/worker/src/workspace-processes.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const entry = (pid: number, ppid: number, extra: Partial<ProcessEntry> = {}): ProcessEntry => ({ pid, ppid, uid: 501, state: "S", ...extra });

describe("stopping what the workspace left running before a push (final review I1)", () => {
  it("in the worker container, selects every other process of the worker's user, wherever it moved, but never the worker, its ancestors, other users or zombies", () => {
    const processes = [
      entry(1, 0, { uid: 0 }), entry(7, 1), entry(9, 7), entry(40, 9, { cwd: "/mnt/workspace/repo" }), entry(41, 1, { cwd: "/" }),
      entry(42, 1, { state: "Z" }), entry(43, 1, { uid: 0 }),
    ];
    expect(processesToStop(processes, { selfPid: 9, uid: 501, scope: "container", rootPath: "/mnt/workspace" }).map((found) => found.pid)).toEqual([40, 41]);
  });

  it("in the worker container, fails closed on a live process of another user that is not the worker's ancestor, since it cannot be stopped (docker containment)", async () => {
    const processes = [entry(1, 0, { uid: 0 }), entry(9, 1), entry(42, 1, { uid: 0, state: "Z" })];
    expect(unstoppableProcesses([...processes, entry(43, 1, { uid: 0 })], { selfPid: 9, uid: 501, scope: "container", rootPath: "/mnt/workspace" }).map((found) => found.pid)).toEqual([43]);
    // tini (PID 1) is the worker's ancestor, and a zombie runs nothing: neither blocks the push.
    expect(unstoppableProcesses(processes, { selfPid: 9, uid: 501, scope: "container", rootPath: "/mnt/workspace" })).toEqual([]);
    // Elsewhere, another user's process is not the worker's to judge.
    expect(unstoppableProcesses([...processes, entry(43, 1, { uid: 0 })], { selfPid: 9, uid: 501, scope: "workspace", rootPath: "/mnt/workspace" })).toEqual([]);
    const kill = vi.fn();
    await expect(stopWorkspaceProcesses({ rootPath: "/w", scope: "container", selfPid: 9, uid: 501, kill,
      listProcesses: async () => [entry(1, 0), entry(9, 1), entry(40, 1), entry(43, 1, { uid: 0 })] }))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringMatching(/another user .*cannot stop.*did not push/) as unknown });
    expect(kill).not.toHaveBeenCalled();
    await expect(stopWorkspaceProcesses({ rootPath: "/w", scope: "container", selfPid: 9, uid: 501, kill,
      listProcesses: async () => [entry(1, 0, { uid: 0 }), entry(9, 1)] })).resolves.toEqual({ stopped: 0 });
  });

  it("elsewhere, selects only the user's processes working inside the workspace", () => {
    const processes = [entry(9, 1), entry(40, 9, { cwd: "/w/root/repo" }), entry(41, 1, { cwd: "/w/root" }), entry(42, 1, { cwd: "/w/rootless" }), entry(43, 1)];
    expect(processesToStop(processes, { selfPid: 9, uid: 501, scope: "workspace", rootPath: "/w/root" }).map((found) => found.pid)).toEqual([40, 41]);
  });

  it("reads its scope from the worker image's environment", () => {
    expect(workspaceProcessScope({ AGENTX_WORKER_PROCESS_SCOPE: "container" })).toBe("container");
    expect(workspaceProcessScope({})).toBe("workspace");
  });

  it("fails closed when the processes cannot be listed, or keep running", async () => {
    await expect(stopWorkspaceProcesses({ rootPath: "/w", scope: "container", listProcesses: async () => { throw new Error("no /proc"); } }))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    const kill = vi.fn();
    await expect(stopWorkspaceProcesses({ rootPath: "/w", scope: "container", selfPid: 9, uid: 501, rounds: 2, kill,
      listProcesses: async () => [entry(9, 1), entry(40, 1)] })).rejects.toThrow(/could not stop every process/);
    expect(kill).toHaveBeenCalledWith(40);
  });

  it("stops a detached process working in the workspace, and leaves one elsewhere running", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-reap-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "agentx-reap-other-"));
    directories.push(root, elsewhere);
    const start = (cwd: string) => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd, detached: true, stdio: "ignore" });
      child.unref();
      return child.pid!;
    };
    const inside = start(root);
    const outside = start(elsewhere);
    try {
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      const result = await stopWorkspaceProcesses({ rootPath: root, scope: "workspace" });
      expect(result.stopped).toBeGreaterThanOrEqual(1);
      expect(() => process.kill(inside, 0)).toThrow();
      expect(() => process.kill(outside, 0)).not.toThrow();
    } finally {
      try { process.kill(outside, "SIGKILL"); } catch { /* gone */ }
      try { process.kill(inside, "SIGKILL"); } catch { /* gone */ }
    }
  });
});

describe("the push credential is never in any process's environment (final review I1)", () => {
  const TOKEN = `ghs_${"S3cr3tT0k3n".repeat(3)}`;

  it("gives Git only an askpass helper that reads the token from a private file, and removes the file afterwards", async () => {
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    const directory = await mkdtemp(join(tmpdir(), "agentx-askpass-"));
    directories.push(directory);
    let seen: NodeJS.ProcessEnv | undefined;
    let printed = "";
    let askPassDirectory = "";
    await runGitWithCredential({
      directory, args: ["push", "--porcelain", "https://git.example.invalid/demo.git", `${"a".repeat(40)}:refs/heads/agentx/x`], credential: { token: TOKEN },
      run: async (_args, options) => {
        seen = options.env;
        const askPass = options.env.GIT_ASKPASS!;
        askPassDirectory = join(askPass, "..");
        // What Git's askpass call prints, with Git's own environment.
        printed = (await execFileAsync(askPass, ["Password for 'https://x-access-token@git.example.invalid': "], { env: options.env, encoding: "utf8" })).stdout;
        return { stdout: "", stderr: "" };
      },
    });
    expect(printed).toBe(`${TOKEN}\n`);
    expect(Object.values(seen!).some((value) => value?.includes(TOKEN))).toBe(false);
    await expect(readdir(askPassDirectory)).rejects.toThrow();
  });

  it("pushes by commit ID from a repository of its own, which borrows the workspace's objects and nothing else", async () => {
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    const objectsDirectory = await mkdtemp(join(tmpdir(), "agentx-objects-"));
    directories.push(objectsDirectory);
    let args: readonly string[] = [];
    let env: NodeJS.ProcessEnv = {};
    let alternates = "";
    await pushCommitFromIsolatedRepository({
      objectsDirectory, url: "https://git.example.invalid/demo.git", commit: "b".repeat(40), branch: "agentx/x", credential: { token: TOKEN },
      run: async (given, options) => {
        args = given;
        env = options.env;
        alternates = (await execFileAsync("cat", [join(given[1]!, "objects", "info", "alternates")], { encoding: "utf8" })).stdout;
        return { stdout: "", stderr: "" };
      },
    });
    expect(args.slice(0, 2)).toEqual(["--git-dir", expect.stringContaining("agentx-push-") as string]);
    expect(args.slice(2)).toEqual(["push", "--porcelain", "https://git.example.invalid/demo.git", `${"b".repeat(40)}:refs/heads/agentx/x`]);
    expect(alternates).toBe(`${objectsDirectory}\n`);
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(Object.values(env).some((value) => value?.includes(TOKEN))).toBe(false);
    await expect(pushCommitFromIsolatedRepository({ objectsDirectory, url: "https://git.example.invalid/demo.git", commit: "HEAD", branch: "agentx/x" }))
      .rejects.toThrow(/full object ID/);
  });
});
