import { expect, it } from "vitest";
import { parseCoreBackfillArguments } from "../../packages/broker/src/aws/core-backfill-runner.js";
it("defaults operator execution to preview and requires explicit tables/input", () => {
  expect(parseCoreBackfillArguments(["--state-table", "State", "--signin-table", "SignIn", "--input", "mapping.json"])).toMatchObject({ dryRun: true, peopleCheck: false });
  expect(parseCoreBackfillArguments(["--state-table", "State", "--signin-table", "SignIn", "--input", "mapping.json", "--apply"])).toMatchObject({ dryRun: false });
  for (const args of [[], ["--apply"], ["--input", "private-canary", "--unknown"]]) expect(() => parseCoreBackfillArguments(args)).toThrow(/^core backfill arguments refused$/);
});

import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCoreMappingFile } from "../../packages/broker/src/aws/core-backfill-runner.js";
it("reads one bounded regular mapping file and refuses malformed roots, oversized files and links", async () => {
  const dir = await mkdtemp(join(tmpdir(), "core-backfill-runner-"));
  try {
    const file = join(dir, "mapping.json");
    await writeFile(file, JSON.stringify({ companyId: "org_aaaaaaaaaaaaaaaaaaaa", projectNames: [] }));
    expect(await readCoreMappingFile(file)).toEqual({ companyId: "org_aaaaaaaaaaaaaaaaaaaa", projectNames: [] });
    await symlink(file, join(dir, "link"));
    await expect(readCoreMappingFile(join(dir, "link"))).rejects.toThrow(/^core backfill input refused$/);
    for (const content of ["private-canary", "[]", "null", "x".repeat(65_537)]) {
      await writeFile(file, content);
      await expect(readCoreMappingFile(file)).rejects.toThrow(/^core backfill input refused$/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it("accepts explicit catalog commands but never writes on discovery or an implicit mark", () => {
  const base = ["--state-table", "State", "--signin-table", "SignIn", "--input", "mapping.json"];
  expect(parseCoreBackfillArguments([...base, "--discover"])).toMatchObject({ action: "discover", dryRun: true });
  expect(parseCoreBackfillArguments([...base, "--verify", "--mark", "--run-id", "run-a", "--apply"])).toMatchObject({ action: "verify", mark: true, runId: "run-a", dryRun: false });
  expect(parseCoreBackfillArguments([...base, "--unmark", "run-a"])).toMatchObject({ action: "unmark", dryRun: true, runId: "run-a" });
  expect(parseCoreBackfillArguments([...base, "--undo-run", "run-a"])).toMatchObject({ action: "undo-run", dryRun: true });
  for (const flags of [["--discover", "--apply"], ["--mark"], ["--discover", "--verify"], ["--unmark"], ["--verify", "--people-check"], ["--run-id", "bad/run"], ["--run-id", "run-a", "--unmark", "run-b"]]) {
    expect(() => parseCoreBackfillArguments([...base, ...flags])).toThrow(/^core backfill arguments refused$/);
  }
});
