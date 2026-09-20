import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const roots: string[] = [];
async function fixture() { const dir = await mkdtemp(join(tmpdir(), "team-tasks-check-")); roots.push(dir); return dir; }
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
const checker = resolve("environments/team-tasks/check-workspace.mjs");
describe("Team Tasks workspace admission", () => {
  it("counts files and rejects at the storage limit, not only above it", async () => {
    const dir = await fixture();
    await writeFile(join(dir, "sample"), Buffer.alloc(64));
    expect((await run(process.execPath, [checker, dir, "128"])).stdout.trim()).toBe("64");
    for (const limit of ["32", "64", "0", "NaN"]) {
      await expect(run(process.execPath, [checker, dir, limit])).rejects.toThrow();
    }
  });
  it("rejects escaping and broken links but does not double-count contained links", async () => {
    const dir = await fixture();
    await writeFile(join(dir, "sample"), "1234");
    await symlink("sample", join(dir, "inside"));
    expect((await run(process.execPath, [checker, dir, "128"])).stdout.trim()).toBe("4");
    await symlink("missing", join(dir, "broken"));
    await expect(run(process.execPath, [checker, dir, "128"])).rejects.toThrow(/SYMLINK/);
    await rm(join(dir, "broken"));
    await symlink(tmpdir(), join(dir, "escape"));
    await expect(run(process.execPath, [checker, dir, "128"])).rejects.toThrow(/SYMLINK/);
  });
  it("refuses modified tool download bytes before extraction", async () => {
    const dir = await fixture(); const file = join(dir, "changed.tar");
    await writeFile(file, "not the tool archive");
    await expect(run(process.execPath, [resolve("environments/team-tasks/verify-download.mjs"), "appNode", file])).rejects.toThrow(/DIGEST_MISMATCH/);
  });
});
