import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadRollback0212Parser } from "../support/rollback-0212-parser.js";


describe("immutable 0.2.12 parser fixture", () => {
  it("loads only the checksum-pinned pure schema bundle", async () => {
    const parser = await loadRollback0212Parser();
    expect(parser.exports).toEqual(["WorkerInvocationSchema", "WorkflowSnapshotSchema"]);
    expect(parser.WorkflowSnapshotSchema.safeParse({}).success).toBe(false);
    expect(parser.WorkerInvocationSchema.safeParse({}).success).toBe(false);
  });

  it("aborts on changed fixture bytes before writing an importable module", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rollback-0212-corrupt-"));
    try {
      const fixtureDirectory = join(directory, "fixture");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(fixtureDirectory);
      const root = new URL("../fixtures/rollback-0.2.12/", import.meta.url);
      await writeFile(join(fixtureDirectory, "provenance.json"), await readFile(new URL("provenance.json", root)));
      const bytes = await readFile(new URL("parser-bundle.txt", root));
      await writeFile(join(fixtureDirectory, "parser-bundle.txt"), Buffer.concat([bytes, Buffer.from("\ncorrupt")]));

      const importModule = vi.fn(async () => ({}));
      await expect(loadRollback0212Parser({ fixtureDirectory, importModule })).rejects.toThrow(/sha-256|integrity|checksum/i);
      expect(importModule).not.toHaveBeenCalled();
      await expect(readdir(directory)).resolves.toEqual(["fixture"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

});
