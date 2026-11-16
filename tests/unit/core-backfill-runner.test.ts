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
