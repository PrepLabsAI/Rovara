import { mkdtemp, mkdir, readlink, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { linkInstalledRuntimeDependencies } from "../../packages/verifier/src/runtime-cli.js";

describe("installed E2E runner dependency root", () => {
  it("links the packaged dependencies when the workspace source root has none", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-installed-runner-root-")));
    // The packaged root is the host profile's fixed location (/opt/agentx on Linux), which a CI
    // host such as CodeBuild does not have; the test supplies its own packaged root instead.
    const installedRoot = join(root, "installed-worker");
    await mkdir(join(installedRoot, "node_modules"), { recursive: true, mode: 0o700 });
    const sourceRoot = join(root, "mounted-workspace");
    const project = join(root, "private-evidence", "project");
    await mkdir(sourceRoot, { recursive: true, mode: 0o700 });
    await mkdir(project, { recursive: true, mode: 0o700 });
    try {
      const dependencyRoot = await linkInstalledRuntimeDependencies(project, sourceRoot, installedRoot);
      expect(dependencyRoot).toBe(join(installedRoot, "node_modules"));
      const link = join(project, "node_modules");
      expect(await readlink(link)).toBe(dependencyRoot);
      expect((await stat(link)).isDirectory()).toBe(true);
      expect(await realpath(link)).toBe(await realpath(dependencyRoot));
      await expect(stat(join(sourceRoot, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a packaged root with no dependencies instead of falling back to the workspace", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-installed-runner-missing-")));
    const project = join(root, "project");
    await mkdir(project, { mode: 0o700 });
    try {
      await expect(linkInstalledRuntimeDependencies(project, root, join(root, "no-such-install"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(project, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
