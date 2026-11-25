// Opus review of F1 L0 + L1a-0 + L1b (2026-11-24, uncommitted): two checks the lane does not make.
//  1. The tombstone lint runs over the repository, not only over fixtures (with an empty list it finds nothing; a fixture tombstone proves the walk reaches real files).
//  2. A config key that writes its row's own stack parameter agrees with the row: a oneOf validator offers exactly the template's AllowedValues, and the config default is the row's.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CODE_SETTING_ROWS, SETTING_TOMBSTONES } from "@agentx/contracts";
import { tombstoneProblems } from "../../scripts/settings-lints.js";

const SKIP = new Set(["node_modules", "dist", "cdk.out", ".release-synth", ".git", ".timings", "golden"]);
function walk(directory: string, found: Map<string, string>): void {
  for (const name of readdirSync(directory)) {
    if (SKIP.has(name)) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path, found);
    else if (/\.(ts|tsx|js|mjs|json|sh)$/u.test(name) && !name.endsWith(".d.ts")) found.set(path, readFileSync(path, "utf8"));
  }
}
const files = new Map<string, string>();
for (const root of ["packages", "infra", "scripts", "tests"]) walk(root, files);

describe("review: the tombstone lint over the repository", () => {
  it("finds no retired key outside the allowed places", () => {
    expect(files.size).toBeGreaterThan(500);
    expect(tombstoneProblems(SETTING_TOMBSTONES, files)).toEqual([]);
  });

  it("reaches real files (a fixture tombstone of a name the CLI uses is found)", () => {
    const problems = tombstoneProblems([{ key: "OPERATOR_PARAMETERS", storedAs: "OPERATOR_PARAMETERS" }], files);
    expect(problems.some((line) => line.startsWith("packages/cli/src/deploy/parameters.ts "))).toBe(true);
  });
});

describe("review: a config key agrees with its own row", () => {
  const ownParameterRows = CODE_SETTING_ROWS.filter((row) => row.configKey?.target.kind === "stack-parameter" && row.install !== undefined);

  it("covers the stack-parameter keys", () => {
    expect(ownParameterRows.length).toBeGreaterThan(20);
  });

  it.each(ownParameterRows.map((row) => [row.configKey!.key, row] as const))("%s: oneOf values equal the template's AllowedValues, default equals the row's", (_key, row) => {
    const validator = row.configKey!.validator;
    if (validator.kind === "oneOf" && row.type.kind === "choice") expect([...validator.values].sort()).toEqual([...row.type.values].sort());
    if (row.configKey!.defaultValue !== undefined && row.default !== "REQUIRED") expect(row.configKey!.defaultValue).toBe(row.default);
  });
});
