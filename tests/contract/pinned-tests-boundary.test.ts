import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validatePinnedHistory, validatePinnedTests } from "../support/pinned-tests.js";

// The lane gate always selects *boundary*.test.ts. Read source only: never execute pinned tests.
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
    // HEAD catches uncommitted edits; merge parents catch PR/queue resets with CI's depth-2 checkout.
    // The cached target also protects multi-commit lanes. Nothing fetches or writes git state.
    const options = { cwd: fileURLToPath(root), encoding: "utf8", stdio: "pipe" } as const;
    for (const ref of ["HEAD", "HEAD^1", "HEAD^2", "origin/code/next"]) {
      try { execFileSync("git", ["rev-parse", "--verify", ref], options); }
      catch (error) {
        if (ref !== "HEAD" && (error as { status?: number }).status === 128) continue;
        throw error;
      }
      // No registry at a valid base is the first-install case, not permission to discard a row.
      if (execFileSync("git", ["ls-tree", "--name-only", ref, "--", "tests/pinned-tests.json"], options).trim() === "") continue;
      const prior: unknown = JSON.parse(execFileSync("git", ["show", `${ref}:tests/pinned-tests.json`], options));
      findings.push(...validatePinnedHistory(registry, prior).map((finding) => `${ref}: ${finding}`));
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });
});
