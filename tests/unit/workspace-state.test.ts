// Task 25 re-review, carried-over minor: the worker's state folders on the workspace volume must be real directories owned
// by the worker, mode 0700, before a task container is started over them. A link or file planted by an older volume, or a
// folder another user owns, must not be masked as if it were the worker's.
import { mkdir, mkdtemp, lstat, readFile, readdir, realpath, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hiddenWorkspaceDirectories } from "../../packages/worker/src/workspace-state.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const workspace = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-state-")));
  cleanup.push(root);
  return root;
};
const uid = process.getuid?.() ?? 0;

describe("the worker's state folders of the workspace", () => {
  it("are created as private directories when missing", async () => {
    const root = await workspace();
    expect(await hiddenWorkspaceDirectories(root)).toEqual([join(root, ".agentx"), join(root, "agent-sessions")]);
    for (const name of [".agentx", "agent-sessions"]) {
      const info = await lstat(join(root, name));
      expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
      expect(info.mode & 0o777).toBe(0o700);
      expect(info.uid).toBe(uid);
    }
  });

  it("replace a symbolic link with a real directory, leaving what it pointed at alone", async () => {
    const root = await workspace();
    const elsewhere = await workspace();
    await writeFile(join(elsewhere, "keep.txt"), "kept");
    await symlink(elsewhere, join(root, ".agentx"));
    await symlink(join(root, "missing-target"), join(root, "agent-sessions"));
    await hiddenWorkspaceDirectories(root);
    for (const name of [".agentx", "agent-sessions"]) {
      const info = await lstat(join(root, name));
      expect(info.isSymbolicLink()).toBe(false);
      expect(info.isDirectory()).toBe(true);
      expect(await readdir(join(root, name))).toEqual([]);
    }
    expect(await readFile(join(elsewhere, "keep.txt"), "utf8")).toBe("kept");
  });

  it("replace a plain file with a real directory", async () => {
    const root = await workspace();
    await writeFile(join(root, ".agentx"), "planted");
    await hiddenWorkspaceDirectories(root);
    expect((await lstat(join(root, ".agentx"))).isDirectory()).toBe(true);
  });

  it("make an existing directory private and keep what is in it", async () => {
    const root = await workspace();
    await mkdir(join(root, ".agentx"), { mode: 0o755 });
    await chmod(join(root, ".agentx"), 0o755);
    await writeFile(join(root, ".agentx", "preparation-manifest.json"), "{}");
    await hiddenWorkspaceDirectories(root);
    expect((await lstat(join(root, ".agentx"))).mode & 0o777).toBe(0o700);
    expect(await readFile(join(root, ".agentx", "preparation-manifest.json"), "utf8")).toBe("{}");
  });

  it("refuse a directory another user owns, since the worker can neither trust nor fix it", async () => {
    const root = await workspace();
    await mkdir(join(root, ".agentx"), { mode: 0o700 });
    await expect(hiddenWorkspaceDirectories(root, { uid: uid + 1 })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("leave a root that does not exist alone", async () => {
    await expect(hiddenWorkspaceDirectories(join(tmpdir(), `agentx-no-such-${Date.now()}`))).resolves.toEqual([]);
  });
});
