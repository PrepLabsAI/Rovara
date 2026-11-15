import type * as FsPromises from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCgroupPeakMemoryMiB } from "../../packages/worker/src/machine-measurement.js";
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, open: vi.fn(actual.open) };
});
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const dir = await mkdtemp(join(await realpath(tmpdir()), "te-c5-cgroup-")); directories.push(dir); return dir; }
it("reads a bounded byte count, including the maximum, from a regular memory.peak file", async () => {
  const dir = await directory();
  expect(dirname(dir)).toBe(await realpath(tmpdir()));
  for (const mib of [0, 6144, 1_048_576]) { await writeFile(join(dir, "memory.peak"), `${mib * 1048576}\n`); expect(await readCgroupPeakMemoryMiB(dir)).toBe(mib); }
});
it("returns unknown for missing, garbage, huge, negative or non-file input", async () => {
  const dir = await directory(); expect(await readCgroupPeakMemoryMiB(dir)).toBeUndefined();
  for (const value of ["garbage", "NaN", "-1", "1e6", "1099511627777", "1".repeat(1_000_000), "1048576" + " ".repeat(60) + "garbage"]) { await writeFile(join(dir, "memory.peak"), value); expect(await readCgroupPeakMemoryMiB(dir)).toBeUndefined(); }
  await rm(join(dir, "memory.peak")); await mkdir(join(dir, "memory.peak")); expect(await readCgroupPeakMemoryMiB(dir)).toBeUndefined();
});
it("refuses file and ancestor symlinks", async () => {
  const dir = await directory(), target = await directory(); await writeFile(join(target, "memory.peak"), "1048576\n");
  await symlink(join(target, "memory.peak"), join(dir, "memory.peak")); expect(await readCgroupPeakMemoryMiB(dir)).toBeUndefined();
  await symlink(target, join(dir, "linked")); expect(await readCgroupPeakMemoryMiB(join(dir, "linked"))).toBeUndefined();
});

it("rejects a non-regular file even if the reader could return numeric bytes", async () => {
 const dir = await directory(); let read = false, closed = false;
 vi.mocked(open).mockResolvedValueOnce({ stat: async () => ({ isFile: () => false }), close: async () => { closed = true; }, read: async (buffer: Buffer) => { read = true; buffer.write("1048576"); return { bytesRead: 7 }; } } as unknown as Awaited<ReturnType<typeof open>>);
 expect(await readCgroupPeakMemoryMiB(dir)).toBeUndefined(); expect(read).toBe(false); expect(closed).toBe(true);
});
