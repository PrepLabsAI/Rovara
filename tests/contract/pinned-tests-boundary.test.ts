import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validatePinnedGitHistory, validatePinnedTests } from "../support/pinned-tests.js";

// CI always adds this boundary in affected mode. Read source only: never execute pinned tests.
describe("reviewed test boundary (DEC 254zzz333)", () => {
  it("retains every pinned file or explicit replacement at its reviewed minimum", () => {
    const root = new URL("../../", import.meta.url);
    const registry: unknown = JSON.parse(readFileSync(new URL("tests/pinned-tests.json", root), "utf8"));
    const findings = validatePinnedTests(registry, (path) => {
      try { return readFileSync(fileURLToPath(new URL(path, root)), "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    });
    const options = { cwd: fileURLToPath(root), encoding: "utf8", stdio: "pipe" } as const;
    findings.push(...validatePinnedGitHistory(registry, (args) => execFileSync("git", args, options)));
    expect(findings, findings.join("\n")).toEqual([]);
  });
});
