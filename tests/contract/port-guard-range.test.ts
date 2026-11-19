import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { DEFAULT_NAMES, formatFinding, runGuard } from "../../scripts/port-guard.js";

// The port-guard job in CI runs the guard over everything code/next holds beyond mainline (origin/mainline..HEAD, docs/porting.md). New rules once
// turned that job red on legitimate public code and old public history, because no test ran the guard over the real range. This one does: what the
// range holds must pass, with the guard's own files excused as CI does (--allow-guard-edits). It needs the full history (CI's `test` job may check
// out less, and then there is no origin/mainline to measure from, so the test is skipped there; the port-guard job is the check in that case).
const git = (...args: string[]): string => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
};
// #1124: on mainline itself (the release build checks out mainline) the range is empty: there is nothing beyond mainline to guard, so skip there too.
const haveRange =
  git("rev-parse", "--verify", "--quiet", "origin/mainline^{commit}") !== "" &&
  git("rev-parse", "--is-shallow-repository") === "false" &&
  Number(git("rev-list", "--count", "origin/mainline..HEAD") || "0") > 0;

describe("the guard over the real CI range", () => {
  it.skipIf(!haveRange)(
    "finds nothing in origin/mainline..HEAD (the secret scan is the port-guard job's)",
    () => {
      const result = runGuard({ cwd: process.cwd(), range: "origin/mainline..HEAD", allowGuardEdits: true, gitleaks: "off", names: DEFAULT_NAMES });
      expect(result.findings.map(formatFinding)).toEqual([]);
      expect(result.commits).toBeGreaterThan(0);
    },
    900_000,
  );
});
