import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_TMP_PREFIX } from "../support/test-temp-dir.js";

describe("test temporary directory", () => {
  it("points every test's tmpdir at a per-run directory the run removes at teardown", () => {
    // CDK apps built without an outdir, and every mkdtemp in the suite, land under os.tmpdir(); the
    // global setup redirects it so the whole run's leftovers go when the run ends.
    expect(basename(tmpdir())).toMatch(new RegExp(`^${TEST_TMP_PREFIX}`));
    expect(basename(dirname(tmpdir()))).not.toMatch(new RegExp(`^${TEST_TMP_PREFIX}`));
  });
});
