import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { isolatedGitEnvironment } from "../../packages/worker/src/git.js";
import { resolvePolicy } from "../../packages/contracts/src/policy.js";

const BASE = "c93edabcba4b9ae45cc3e0390d55fca62105222b";
it("keeps the existing policy port byte-identical to the approved base", () => {
  const base = spawnSync("git", ["show", `${BASE}:packages/contracts/src/ports/policy.ts`], { env: isolatedGitEnvironment(process.cwd()), encoding: "utf8" });
  expect(base.status, base.stderr).toBe(0);
  expect(readFileSync("packages/contracts/src/ports/policy.ts", "utf8")).toBe(base.stdout);
});
it("has no production callers outside contracts/testing", () => {
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() && !["node_modules", "dist"].includes(entry.name) ? walk(join(directory, entry.name)) : entry.isFile() && /\.tsx?$/u.test(entry.name) ? [join(directory, entry.name)] : []);
  const callers = walk("packages").filter((file) => !file.startsWith("packages/contracts/") && !file.startsWith("packages/testing/")).filter((file) => /\b(resolvePolicy|createDefaultPolicySource|createRowsPolicySource|PolicySource|POLICY_PRESETS|POLICY_FIELDS)\b/u.test(readFileSync(file, "utf8")));
  expect(callers).toEqual([]);
});
it("bounds all rule/path lists and refuses polluted arrays and duplicate branch overrides", () => {
  expect(resolvePolicy({ branchRules: Array(51).fill({ pattern: "*", values: {} }), pathRules: Array(50).fill({ pattern: "*", values: {} }) }).status).toBe("refused");
  for (const name of ["branchRules", "pathRules", "branchOverrides"]) expect(resolvePolicy({ [name]: Array(101).fill(name === "branchOverrides" ? { branch: "x", values: {} } : { pattern: "*", values: {} }) }).status).toBe("refused");
  const paths = ["x"]; Object.defineProperty(paths, "__proto__", { value: { polluted: true }, enumerable: true });
  expect(resolvePolicy({ changedPaths: paths }).status).toBe("refused");
  expect(resolvePolicy({ branch: "x", branchOverrides: [{ branch: "x", values: {} }, { branch: "x", values: {} }] }).status).toBe("refused");
});
