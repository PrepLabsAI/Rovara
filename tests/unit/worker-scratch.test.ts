// TF12: the worker's throwaway Git repositories and credential folders are made on a file system the workspace volume is not on.
import { execFile as execFileCallback } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runGitWithCredential, pushCommitFromIsolatedRepository } from "../../packages/worker/src/git-auth.js";
import { exportCandidateBuildSourceInScratch } from "../../packages/worker/src/e2e-build-source-export.js";
import { withIsolatedGit } from "../../packages/worker/src/isolated-git.js";
import { isEc2WorkerRuntime } from "../../packages/worker/src/task-sandbox.js";
import { assertWorkerScratchReady, checkWorkerScratch, ec2WorkerRuntime, makeWorkerScratch, useScratchDeviceProbeForTests, workerScratchBase } from "../../packages/worker/src/worker-scratch.js";

const execFile = promisify(execFileCallback);
const WORKSPACE = "/mnt/test-workspace-root";
const VOLUME = 11;
const CONTAINER = 22;

/** The workspace volume holds the workspace root and the temporary directory (TMPDIR=/mnt/agentx-runtime/tmp on EC2); the container's /tmp and /var/tmp are another file system. */
const productionLayout = (path: string): Promise<number | undefined> => Promise.resolve(
  path === WORKSPACE || path === tmpdir() ? VOLUME : path === "/tmp" || path === "/var/tmp" ? CONTAINER : undefined,
);
const environment = { AGENTX_WORKSPACE_ROOT: WORKSPACE };

const undo: Array<() => void> = [];
const cleanup: string[] = [];
afterEach(async () => {
  for (const restore of undo.splice(0)) restore();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("worker scratch is not made on the workspace volume (TF12)", () => {
  it("is the temporary directory when it is not on the workspace's file system", async () => {
    undo.push(useScratchDeviceProbeForTests(async (path) => (path === WORKSPACE ? VOLUME : CONTAINER)));
    expect(await workerScratchBase({ environment })).toBe(tmpdir());
  });

  it("moves off the temporary directory when it is on the workspace volume", async () => {
    undo.push(useScratchDeviceProbeForTests(productionLayout));
    const base = await workerScratchBase({ environment });
    expect(base).not.toBe(tmpdir());
    expect(["/tmp", "/var/tmp"]).toContain(base);
  });

  it("uses the temporary directory where the workspace has no volume of its own (a developer's machine)", async () => {
    undo.push(useScratchDeviceProbeForTests(async () => undefined));
    expect(await workerScratchBase({ environment })).toBe(tmpdir());
    undo.push(useScratchDeviceProbeForTests(async () => VOLUME));
    expect(await workerScratchBase({ environment })).toBe(tmpdir());
  });

  it("fails closed on an EC2 worker when every candidate is on the workspace volume", async () => {
    undo.push(useScratchDeviceProbeForTests(async () => VOLUME));
    await expect(workerScratchBase({ environment: { ...environment, AGENTX_WORKER_PROCESS_SCOPE: "container" } })).rejects.toThrow("outside the workspace volume");
    await expect(workerScratchBase({ environment: { ...environment, AGENTX_RUNTIME: "ec2" } })).rejects.toThrow("outside the workspace volume");
  });

  it("makes a private directory in that base", async () => {
    undo.push(useScratchDeviceProbeForTests(productionLayout));
    const made = await makeWorkerScratch("agentx-scratch-test-", { environment });
    cleanup.push(made);
    expect(["/tmp", "/var/tmp"]).toContain(dirname(await realpath(made)).replace(/^\/private/u, ""));
  });

  it("names the EC2 runtime by the same markers as the task sandbox", () => {
    for (const env of [{}, { AGENTX_RUNTIME: "ec2" }, { AGENTX_RUNTIME: "local" }, { AGENTX_WORKER_PROCESS_SCOPE: "container" }, { AGENTX_WORKER_PROCESS_SCOPE: "host" }]) {
      expect(ec2WorkerRuntime(env)).toBe(isEc2WorkerRuntime(env));
    }
  });
});

describe("the throwaway Git repository and the credential folder use it (TF12)", () => {
  it("withIsolatedGit makes its repository outside the workspace volume", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentx-scratch-repo-"));
    cleanup.push(directory);
    await execFile("git", ["init", "--quiet", "--initial-branch=main", directory]);
    await writeFile(join(directory, "a.txt"), "a\n");
    undo.push(useScratchDeviceProbeForTests(productionLayout));
    const previous = process.env.AGENTX_WORKSPACE_ROOT;
    process.env.AGENTX_WORKSPACE_ROOT = WORKSPACE;
    undo.push(() => { if (previous === undefined) delete process.env.AGENTX_WORKSPACE_ROOT; else process.env.AGENTX_WORKSPACE_ROOT = previous; });
    const scratch = await withIsolatedGit(directory, "read", async (session) => session.scratch);
    expect(dirname(scratch)).not.toBe(tmpdir());
    expect(["/tmp", "/var/tmp"]).toContain(dirname(scratch));
  });

  it("the folder that holds a credential for one command is made there", async () => {
    undo.push(useScratchDeviceProbeForTests(productionLayout));
    const previous = process.env.AGENTX_WORKSPACE_ROOT;
    process.env.AGENTX_WORKSPACE_ROOT = WORKSPACE;
    undo.push(() => { if (previous === undefined) delete process.env.AGENTX_WORKSPACE_ROOT; else process.env.AGENTX_WORKSPACE_ROOT = previous; });
    let askpass: string | undefined;
    await runGitWithCredential({
      directory: tmpdir(), args: ["--version"], credential: { username: "u", password: "p" },
      run: async (_args, options) => { askpass = options.env.GIT_ASKPASS; return { stdout: "", stderr: "" }; },
    });
    expect(askpass).toBeDefined();
    expect(["/tmp", "/var/tmp"]).toContain(dirname(dirname(askpass!)));
    expect(dirname(dirname(askpass!))).not.toBe(tmpdir());
  });

  it("the repository a push is made from is created there", async () => {
    undo.push(useScratchDeviceProbeForTests(productionLayout));
    const previous = process.env.AGENTX_WORKSPACE_ROOT;
    process.env.AGENTX_WORKSPACE_ROOT = WORKSPACE;
    undo.push(() => { if (previous === undefined) delete process.env.AGENTX_WORKSPACE_ROOT; else process.env.AGENTX_WORKSPACE_ROOT = previous; });
    const objects = join(await mkdtemp(join(tmpdir(), "agentx-scratch-objects-")), "objects");
    cleanup.push(dirname(objects));
    await mkdir(objects, { recursive: true });
    let cwd: string | undefined;
    await pushCommitFromIsolatedRepository({
      objectsDirectory: objects, url: "https://example.test/org/repo.git", commit: "a".repeat(40), branch: "feature/x",
      run: async (_args, options) => { cwd = options.cwd; return { stdout: "", stderr: "" }; },
    });
    expect(cwd).toBeDefined();
    expect(["/tmp", "/var/tmp"]).toContain(dirname(cwd!));
  });
});

describe("the other throwaway Git users take worker scratch too (TF12, M1)", () => {
  it("the build source export's default scratch is made through worker scratch", async () => {
    const probed: string[] = [];
    undo.push(useScratchDeviceProbeForTests(async (path) => { probed.push(path); return productionLayout(path); }));
    const previous = process.env.AGENTX_WORKSPACE_ROOT;
    process.env.AGENTX_WORKSPACE_ROOT = WORKSPACE;
    undo.push(() => { if (previous === undefined) delete process.env.AGENTX_WORKSPACE_ROOT; else process.env.AGENTX_WORKSPACE_ROOT = previous; });
    const result = await exportCandidateBuildSourceInScratch({
      repositoryRoot: join(tmpdir(), "agentx-no-such-repository"), signal: new AbortController().signal,
      candidate: { schemaVersion: "workflow-candidate/v1", repositories: [], digest: "x" } as never,
    });
    expect(result.status).toBe("UNAVAILABLE");
    expect(probed).toContain(WORKSPACE);
  });
});

const READY = { status: "ready", base: "/tmp", offWorkspaceVolume: true } as const;

describe("the worker checks its scratch once, at start (TF12, M3)", () => {
  it("is ready, and says where, when scratch is made off the workspace volume", async () => {
    undo.push(useScratchDeviceProbeForTests(productionLayout));
    const status = await checkWorkerScratch({ environment });
    expect(status).toMatchObject({ status: "ready", offWorkspaceVolume: true });
    expect(["/tmp", "/var/tmp"]).toContain((status as { base: string }).base);
  });

  it("is ready but says so when the workspace has no volume of its own (a developer's machine)", async () => {
    undo.push(useScratchDeviceProbeForTests(async () => VOLUME));
    expect(await checkWorkerScratch({ environment })).toMatchObject({ status: "ready", offWorkspaceVolume: false });
  });

  it("is unavailable, with a reason, on an EC2 worker that has no such scratch, and every task is then refused clearly", async () => {
    undo.push(useScratchDeviceProbeForTests(async () => VOLUME));
    const status = await checkWorkerScratch({ environment: { ...environment, AGENTX_RUNTIME: "ec2" } });
    expect(status.status).toBe("unavailable");
    expect(() => assertWorkerScratchReady(status)).toThrow(/did not run the task/u);
    expect(() => assertWorkerScratchReady(status)).toThrow(expect.objectContaining({ code: "RUNTIME_UNAVAILABLE" }) as never);
  });

  it("lets a ready worker's tasks through", async () => {
    expect(() => assertWorkerScratchReady(READY)).not.toThrow();
  });
});
