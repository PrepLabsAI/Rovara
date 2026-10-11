// Review focus 1: the journey suites never turn the harness's realism off. Any opt-out (DynamoDB map order or expression
// checks, GitHub's head lag) in tests/integration/workflow-e2e/** fails here; the harness itself refuses lag(0).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeGitHub } from "../support/workflow-e2e-github.js";

const SUITES = join(import.meta.dirname, "..", "integration", "workflow-e2e");
const OPT_OUTS = [/realism\s*:/, /mapOrder\s*:/, /validateExpressions\s*:/, /lag\s*:\s*false/, /prHeadReads\s*:\s*0\b/, /consistency\s*:\s*"strong"/];

describe("workflow E2E realism", () => {
  it("no journey suite turns realism off", async () => {
    const files = (await readdir(SUITES, { recursive: true })).filter((file) => String(file).endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const found: string[] = [];
    for (const file of files) {
      const text = await readFile(join(SUITES, String(file)), "utf8");
      for (const pattern of OPT_OUTS) if (pattern.test(text)) found.push(`${String(file)}: ${pattern.source}`);
    }
    expect(found).toEqual([]);
  });

  it("refuses to turn GitHub's head lag off through lag()", () => {
    const github = new FakeGitHub();
    expect(() => github.lag({ prHeadReads: 0 })).toThrow(/realism: \{ lag: false \}/);
    github.lag({ prHeadReads: 2 });
  });
});
