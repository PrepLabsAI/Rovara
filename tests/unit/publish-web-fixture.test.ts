import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPublishPlan,
  FIXTURE_COMMIT_MESSAGE,
  listStarterFiles,
  parsePublishArguments,
  run,
  STARTER_DIRECTORY,
} from "../../scripts/fixtures/publish-web-fixture.js";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function tree(files: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "starter-tree-"));
  temporary.push(root);
  for (const file of files) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "x");
  }
  return root;
}

describe("listStarterFiles", () => {
  it("excludes defects, node_modules, .git and .DS_Store at any depth, and keeps dot directories", () => {
    const root = tree([
      "server.mjs", ".DS_Store", "public/.DS_Store", "public/index.html", "defects/a.json", "defects/nested/b.json",
      "node_modules/pkg/index.js", "sub/node_modules/pkg/index.js", ".git/config", ".github/workflows/ci.yml",
    ]);
    expect(listStarterFiles(root)).toEqual([".github/workflows/ci.yml", "public/index.html", "server.mjs"]);
  });

  it("lists the committed starter with the files the fixture repository needs", () => {
    const files = listStarterFiles(join(import.meta.dirname, "../..", STARTER_DIRECTORY));
    expect(files).toEqual(expect.arrayContaining([
      ".github/workflows/ci.yml", "server.mjs", "public/index.html", "public/app.js", "fixtures/orders.json",
      "test/orders.test.mjs", "README.md", "package.json",
    ]));
    expect(files.some((file) => file.startsWith("defects/") || file.includes("node_modules") || file.endsWith(".DS_Store"))).toBe(false);
  });
});

describe("buildPublishPlan", () => {
  const files = ["README.md", "server.mjs"];
  it("seeds an empty remote on main with the fixed commit message", () => {
    expect(buildPublishPlan({ repo: "owner/name", files, remoteHasCommits: false, forceReseed: false, dryRun: false }))
      .toEqual({ repo: "owner/name", branch: "main", commitMessage: FIXTURE_COMMIT_MESSAGE, files, dryRun: false, mode: "seed" });
  });
  it("refuses a remote that already has commits without --force-reseed", () => {
    expect(() => buildPublishPlan({ repo: "owner/name", files, remoteHasCommits: true, forceReseed: false, dryRun: false })).toThrow(/force-reseed/);
  });
  it("reseeds on top of existing history with --force-reseed", () => {
    expect(buildPublishPlan({ repo: "owner/name", files, remoteHasCommits: true, forceReseed: true, dryRun: false }).mode).toBe("reseed");
  });
  it("needs a remote check unless it is a dry run", () => {
    expect(() => buildPublishPlan({ repo: "owner/name", files, remoteHasCommits: null, forceReseed: false, dryRun: false })).toThrow(/checked/);
    expect(buildPublishPlan({ repo: "owner/name", files, remoteHasCommits: null, forceReseed: false, dryRun: true }).mode).toBe("unchecked");
  });
  it("rejects malformed repositories and empty file lists", () => {
    for (const repo of ["name", "a/b/c", "https://github.com/a/b", "a b/c", ""]) {
      expect(() => buildPublishPlan({ repo, files, remoteHasCommits: false, forceReseed: false, dryRun: false })).toThrow(/--repo/);
    }
    expect(() => buildPublishPlan({ repo: "o/n", files: [], remoteHasCommits: false, forceReseed: false, dryRun: false })).toThrow(/no files/);
  });
});

describe("parsePublishArguments and dry run", () => {
  it("requires --repo and rejects unknown arguments", () => {
    expect(() => parsePublishArguments([])).toThrow(/--repo/);
    expect(() => parsePublishArguments(["--repo"])).toThrow(/--repo/);
    expect(() => parsePublishArguments(["--repo", "o/n", "--token", "x"])).toThrow(/unknown argument/);
    expect(parsePublishArguments(["--repo", "o/n", "--dry-run", "--force-reseed"])).toEqual({ repo: "o/n", dryRun: true, forceReseed: true });
  });
  it("prints the file list and target on --dry-run and exits 0 without touching the network", () => {
    const lines: string[] = [];
    expect(run(["--repo", "owner/name", "--dry-run"], (line) => lines.push(line))).toBe(0);
    expect(lines[0]).toContain("https://github.com/owner/name");
    expect(lines).toContain("  .github/workflows/ci.yml");
    expect(lines).toContain("  server.mjs");
    expect(lines.some((line) => line.includes("defects"))).toBe(false);
  });
});
