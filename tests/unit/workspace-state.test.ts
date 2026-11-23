// Task 25 re-review, carried-over minor: the worker's state folders on the workspace volume must be real directories owned
// by the worker, mode 0700, before a task container is started over them. A link or file planted by an older volume, or a
// folder another user owns, must not be masked as if it were the worker's.
import { chmod, mkdir, mkdtemp, lstat, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

  it("refuse a directory another user owns, since the worker can neither trust nor fix it", async () => {
    const root = await workspace();
    await mkdir(join(root, ".agentx"), { mode: 0o700 });
    await expect(hiddenWorkspaceDirectories(root, { uid: uid + 1 })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("leave a root that does not exist alone", async () => {
    await expect(hiddenWorkspaceDirectories(join(tmpdir(), `agentx-no-such-${Date.now()}`))).resolves.toEqual([]);
  });
});

it("always creates and masks the control directory for legacy and migrated layouts", async () => {
  for (const layout of ["legacy", "migrated"]) {
    const root = await workspace();
    if (layout === "migrated") await mkdir(join(root, "data"));
    expect(await hiddenWorkspaceDirectories(root)).toContain(join(root, ".agentx-control"));
    expect((await lstat(join(root, ".agentx-control"))).isDirectory()).toBe(true);
  }
});
it("refuses a planted control symlink or file instead of hiding invalid authority", async () => {
  const root = await workspace(), target = await workspace();
  await symlink(target, join(root, ".agentx-control"));
  await expect(hiddenWorkspaceDirectories(root)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  await rm(join(root, ".agentx-control")); await writeFile(join(root, ".agentx-control"), "planted");
  await expect(hiddenWorkspaceDirectories(root)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
});

it("refuses group or world writable control state", async () => {
  const root = await workspace(); await hiddenWorkspaceDirectories(root);
  await chmod(join(root, ".agentx-control"), 0o777);
  await expect(hiddenWorkspaceDirectories(root)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
});

it.skipIf(process.getuid?.() === 0)("preserves a control-directory creation refusal instead of swallowing a permission error", async () => {
  const root = await workspace(); await hiddenWorkspaceDirectories(root);
  await rm(join(root, ".agentx-control"), { recursive: true }); await chmod(root, 0o500);
  try { await expect(hiddenWorkspaceDirectories(root)).rejects.toMatchObject({ code: "EACCES" }); }
  finally { await chmod(root, 0o700); }
});
