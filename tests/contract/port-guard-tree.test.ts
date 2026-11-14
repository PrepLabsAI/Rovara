import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cloudPathRule, importFindings } from "../../scripts/port-guard.js";

// Decision 41 (the Cloud line) and decision 42a (the port): the public tree never holds Cloud-only code and never imports it.
// scripts/port-guard.ts checks a lane's range; this checks the whole tree, so code that got in some other way fails here.

const tracked = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 28 })
  .stdout.split("\0")
  .filter((path) => path !== "");

describe("the repository tree has nothing Cloud-only (decision 41)", () => {
  it("lists the tree", () => {
    expect(tracked.length).toBeGreaterThan(100);
  });

  it("holds no Cloud-only path and no internal build-system detector", () => {
    const hits = tracked.flatMap((path) => {
      const hit = cloudPathRule(path);
      return hit === null ? [] : [`${path}: ${hit.detail}`];
    });
    expect(hits).toEqual([]);
  });

  it("imports no Cloud-only path or package from any TypeScript or JavaScript file", () => {
    const hits: string[] = [];
    for (const path of tracked) {
      if (!/\.[cm]?[jt]sx?$/i.test(path)) continue;
      let source: string;
      try {
        source = readFileSync(path, "utf8");
      } catch {
        continue; // a tracked file that is not on disk (a deleted-but-unstaged one) has nothing to read
      }
      for (const finding of importFindings(path, source)) hits.push(`${path}:${finding.line}: ${finding.detail}`);
    }
    expect(hits).toEqual([]);
  });
});
