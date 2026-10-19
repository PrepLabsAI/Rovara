import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertStarterClean,
  buildPublishPlan,
  FIXTURE_COMMIT_MESSAGE,
  listStarterFiles,
  parsePublishArguments,
  run,
  STARTER_DIRECTORY,
} from "../../scripts/fixtures/publish-web-fixture.js";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });
};

function write(root: string, file: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), "x");
}

/** A temp git repository whose starter directory holds the given committed files. */
function repository(committed: readonly string[], outside: readonly string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "starter-repo-"));
  temporary.push(root);
  git(root, "init", "--quiet", "-b", "main");
  for (const file of committed) write(root, `${STARTER_DIRECTORY}/${file}`);
  for (const file of outside) write(root, file);
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "seed");
  return root;
}

describe("listStarterFiles", () => {
  it("lists committed files only, excluding defects, node_modules, .git and .DS_Store at any depth", () => {
    const root = repository([
      "server.mjs", ".DS_Store", "public/.DS_Store", "public/index.html", "defects/a.json", "defects/nested/b.json",
      "node_modules/pkg/index.js", "sub/node_modules/pkg/index.js", ".github/workflows/ci.yml",
    ], ["other/file.txt"]);
    expect(listStarterFiles(root)).toEqual([".github/workflows/ci.yml", "public/index.html", "server.mjs"]);
  });

  it("never lists untracked or gitignored local files such as a seed or .env", () => {
    const root = repository(["server.mjs", ".gitignore"]);
    write(root, `${STARTER_DIRECTORY}/.owned/seed.json`);
    write(root, `${STARTER_DIRECTORY}/.env`);
    expect(listStarterFiles(root)).toEqual([".gitignore", "server.mjs"]);
  });

  it("lists exactly the committed starter files", () => {
    expect(listStarterFiles(join(import.meta.dirname, "../.."))).toEqual([
      ".github/workflows/ci.yml", ".gitignore", "README.md", "fixtures/orders.json", "package.json", "public/app.js",
      "public/index.html", "server.mjs", "test/orders.test.mjs",
    ]);
  });
});

describe("assertStarterClean", () => {
  it("accepts a clean starter directory and ignores changes elsewhere", () => {
    const root = repository(["server.mjs"]);
    write(root, "elsewhere.txt");
    expect(() => assertStarterClean(root)).not.toThrow();
  });
  it("refuses untracked, modified and staged changes under the starter directory", () => {
    const root = repository(["server.mjs"]);
    write(root, `${STARTER_DIRECTORY}/.owned/seed.json`);
    expect(() => assertStarterClean(root)).toThrow(/uncommitted or untracked/);
    rmSync(join(root, STARTER_DIRECTORY, ".owned"), { recursive: true });
    writeFileSync(join(root, STARTER_DIRECTORY, "server.mjs"), "changed");
    expect(() => assertStarterClean(root)).toThrow(/uncommitted or untracked/);
    git(root, "add", "-A");
    expect(() => assertStarterClean(root)).toThrow(/uncommitted or untracked/);
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
    const root = repository(["server.mjs", ".github/workflows/ci.yml", "defects/a.json"]);
    const lines: string[] = [];
    expect(run(["--repo", "owner/name", "--dry-run"], (line) => lines.push(line), root)).toBe(0);
    expect(lines[0]).toContain("https://github.com/owner/name");
    expect(lines.slice(1)).toEqual(["  .github/workflows/ci.yml", "  server.mjs"]);
  });
  it("refuses to run, dry run or not, when the starter has untracked files", () => {
    const root = repository(["server.mjs"]);
    write(root, `${STARTER_DIRECTORY}/.owned/seed.json`);
    expect(() => run(["--repo", "owner/name", "--dry-run"], () => undefined, root)).toThrow(/uncommitted or untracked/);
    expect(() => run(["--repo", "owner/name"], () => undefined, root)).toThrow(/uncommitted or untracked/);
  });
});
