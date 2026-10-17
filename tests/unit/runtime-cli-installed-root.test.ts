import { mkdtemp, mkdir, readlink, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { linkInstalledRuntimeDependencies } from "../../packages/verifier/src/runtime-cli.js";

describe("installed E2E runner dependency root", () => {
  it("links the packaged dependencies when the workspace source root has none", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-installed-runner-root-"));
    const sourceRoot = join(root, "mounted-workspace");
    const project = join(root, "private-evidence", "project");
    await mkdir(sourceRoot, { recursive: true, mode: 0o700 });
    await mkdir(project, { recursive: true, mode: 0o700 });
    try {
      const dependencyRoot = await linkInstalledRuntimeDependencies(project, sourceRoot);
      const link = join(project, "node_modules");
      expect(await readlink(link)).toBe(dependencyRoot);
      expect((await stat(link)).isDirectory()).toBe(true);
      expect(await realpath(link)).toBe(await realpath(dependencyRoot));
      await expect(stat(join(sourceRoot, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
