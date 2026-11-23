// Private packages P2a: the token folder's rules (a secure tmpfs, nothing left behind, no sandbox while anything is in it) and the central guard in every start path.
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INSTALL_SECRETS_ROOT, InstallTmpfsRefused, TMPFS_MAGIC, assertNoInstallSecrets, assertSecureInstallTmpfs, installDirectoryName, openInstallDirectory, sweepInstallSecrets,
} from "../../packages/worker/src/install-secrets.js";
import { RegistryTokenLeakError } from "../../packages/worker/src/registry-guard.js";
import { removeLeftoverPrivateInstall } from "../../packages/worker/src/private-install.js";
import { ensureDevcontainer, type DevcontainerCli, type DevcontainerTarget } from "../../packages/worker/src/devcontainer.js";
import { TaskSandbox } from "../../packages/worker/src/task-sandbox.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const temp = () => mkdtemp(join(tmpdir(), "rovara-install-secrets-"));
const dockerThatRecords = () => {
  const calls: string[][] = [];
  const docker: DockerCli = { run: (args) => { calls.push([...args]); return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }); } };
  return { calls, docker };
};

describe("the token folder must be a private tmpfs of its own", () => {
  const stats = (over: Partial<{ dir: boolean; link: boolean; uid: number; mode: number; dev: number }> = {}) => ({ isDirectory: () => over.dir ?? true, isSymbolicLink: () => over.link ?? false, uid: over.uid ?? 1000, mode: over.mode ?? 0o40700, dev: over.dev ?? 7 });
  const seams = (root: ReturnType<typeof stats>, type = TMPFS_MAGIC, parent = stats({ dev: 3 })) => ({
    lstat: (path: string) => Promise.resolve(path === INSTALL_SECRETS_ROOT ? root : parent), statfs: () => Promise.resolve({ type }), uid: 1000,
  });

  it("accepts a directory that is its own mountpoint, of type tmpfs, owned by the worker, mode 0700", async () => {
    await expect(assertSecureInstallTmpfs(INSTALL_SECRETS_ROOT, seams(stats()))).resolves.toBeUndefined();
  });

  it.each([
    ["not tmpfs (the workspace's disk)", seams(stats(), 0xef53)],
    ["not a mountpoint of its own (the same device as /run)", seams(stats({ dev: 3 }))],
    ["another owner", seams(stats({ uid: 0 }))],
    ["a looser mode", seams(stats({ mode: 0o40755 }))],
    ["a link", seams(stats({ link: true }))],
    ["a file", seams(stats({ dir: false }))],
  ])("refuses %s, in fixed words and with no path", async (_label, given) => {
    const error = await assertSecureInstallTmpfs(INSTALL_SECRETS_ROOT, given).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(InstallTmpfsRefused);
    expect((error as Error).message).not.toContain("/run");
  });

  it("refuses a folder that does not exist, and a real directory on a laptop's disk", async () => {
    await expect(assertSecureInstallTmpfs(join(await temp(), "missing"))).rejects.toBeInstanceOf(InstallTmpfsRefused);
    const directory = await temp();
    await chmod(directory, 0o700);
    await expect(assertSecureInstallTmpfs(directory)).rejects.toBeInstanceOf(InstallTmpfsRefused);
  });
});

describe("the central guard", () => {
  it("passes when the folder does not exist or is empty, and refuses while ANY entry is in it", async () => {
    const root = await temp();
    await expect(assertNoInstallSecrets(join(root, "none"))).resolves.toBeUndefined();
    await expect(assertNoInstallSecrets(root)).resolves.toBeUndefined();
    await writeFile(join(root, "anything"), "x");
    await expect(assertNoInstallSecrets(root)).rejects.toThrow(/package token file is still on this machine/u);
  });

  it("treats a folder it cannot read as holding a secret", async () => {
    const root = await temp();
    await writeFile(join(root, "a-file-not-a-folder"), "x");
    await expect(assertNoInstallSecrets(join(root, "a-file-not-a-folder"))).rejects.toThrow(/package token file is still on this machine/u);
  });

  it("a task sandbox does not start while the folder holds a file: no docker command runs", async () => {
    const root = await temp();
    await mkdir(join(root, "op"));
    const { calls, docker } = dockerThatRecords();
    const sandbox = new TaskSandbox({ rootPath: await temp(), taskId: "t", docker, image: "i", environment: { AGENTX_SANDBOX_NETWORK: "n" }, installSecretsRoot: root });
    await expect(sandbox.start()).rejects.toThrow(/package token file is still on this machine/u);
    expect(calls).toEqual([]);
  });

  it("the same sandbox starts once the folder is empty (the guard does not get in the way)", async () => {
    const root = await temp();
    const { calls, docker } = dockerThatRecords();
    const sandbox = new TaskSandbox({ rootPath: await temp(), taskId: "t", docker, image: "i", environment: { AGENTX_SANDBOX_NETWORK: "n" }, installSecretsRoot: root });
    await sandbox.start().catch(() => undefined);
    expect(calls.some((call) => call[0] === "run")).toBe(true);
  });

  it("a dev container does not start while the folder holds a file", async () => {
    const root = await temp();
    await writeFile(join(root, "x"), "x");
    let touched = false;
    const cli = new Proxy({}, { get: () => () => { touched = true; return Promise.resolve({}); } }) as unknown as DevcontainerCli;
    const target = { rootPath: await temp(), workspaceFolder: "/w", configPath: "/w/.devcontainer/devcontainer.json" } as unknown as DevcontainerTarget;
    await expect(ensureDevcontainer(cli, target, { installSecretsRoot: root })).rejects.toThrow(/package token file is still on this machine/u);
    expect(touched).toBe(false);
  });
});

describe("the per-operation folder", () => {
  it("is 0700 with files 0600 made exclusively, named by a hash, and removed with its absence asserted", async () => {
    const root = await temp();
    const directory = await openInstallDirectory(root, "operation-with-a-long-id");
    expect(directory.directory).toBe(join(root, installDirectoryName("operation-with-a-long-id")));
    expect(directory.directory).not.toContain("operation-with-a-long-id");
    expect((await stat(directory.directory)).mode & 0o777).toBe(0o700);
    const file = await directory.write("npmrc", "x");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(directory.write("npmrc", "again")).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("x");
    await directory.remove();
    expect(await readdir(root)).toEqual([]);
    await expect(assertNoInstallSecrets(root)).resolves.toBeUndefined();
  });

  it("a folder an earlier attempt of the same operation left is removed before the new one is made", async () => {
    const root = await temp();
    const first = await openInstallDirectory(root, "op");
    await first.write("old", "stale");
    const second = await openInstallDirectory(root, "op");
    expect(await readdir(second.directory)).toEqual([]);
    await second.remove();
  });

  it.runIf(process.getuid?.() !== 0)("a removal that fails is a leak: the workspace is tainted, not trusted", async () => {
    const root = await temp();
    const directory = await openInstallDirectory(root, "op");
    await directory.write("npmrc", "x");
    await chmod(root, 0o500);
    try {
      await expect(directory.remove()).rejects.toBeInstanceOf(RegistryTokenLeakError);
    } finally {
      await chmod(root, 0o700);
    }
  });
});

describe("the worker's start sweeps what a crash left", () => {
  it("removes the token folders and their files, answers how many, and leaves the root itself", async () => {
    const root = await temp();
    for (const name of ["a", "b"]) { await mkdir(join(root, name)); await writeFile(join(root, name, "npmrc"), "x"); }
    expect(await sweepInstallSecrets(root)).toBe(2);
    expect(await readdir(root)).toEqual([]);
    expect(await sweepInstallSecrets(join(root, "does-not-exist"))).toBe(0);
  });

  it("also removes this workspace's install containers and bridges by label, and no other workspace's", async () => {
    const root = await temp();
    await mkdir(join(root, "left"));
    const calls: string[][] = [];
    const docker: DockerCli = { run: (args) => {
      calls.push([...args]);
      const text = args.join(" ");
      return Promise.resolve({ exitCode: 0, stdout: text.startsWith("ps") ? "rovara-install-aaaaaaaaaaaa\n" : text.startsWith("network ls") ? "net1\n" : "", stderr: "" });
    } };
    const removed = await removeLeftoverPrivateInstall("ws-key", docker, root);
    expect(removed).toEqual({ files: 1, containers: 1, networks: 1 });
    const text = calls.map((call) => call.join(" "));
    expect(text).toContain("ps --all --quiet --filter label=rovara.install --filter label=rovara.install-workspace=ws-key");
    expect(text).toContain("rm --force rovara-install-aaaaaaaaaaaa");
    expect(text).toContain("network rm net1");
    expect(await readdir(root)).toEqual([]);
  });
});
