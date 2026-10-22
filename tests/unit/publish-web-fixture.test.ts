import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertStarterClean,
  backupBranchName,
  buildPublishPlan,
  FIXTURE_COMMIT_MESSAGE,
  FIXTURE_VARIANTS,
  listStarterFiles,
  parsePublishArguments,
  publish,
  readVariantFiles,
  renderFixtureVariant,
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

const M13 = "tests/fixtures/orders-web-m13";

describe("variants", () => {
  it("knows the starter and m13 and rejects anything else", () => {
    expect(Object.keys(FIXTURE_VARIANTS).sort()).toEqual(["m13", "starter"]);
    expect(parsePublishArguments(["--repo", "o/n", "--variant", "m13"]).variant).toBe("m13");
    expect(parsePublishArguments(["--repo", "o/n"]).variant).toBeUndefined();
    expect(() => parsePublishArguments(["--repo", "o/n", "--variant", "m99"])).toThrow(/unknown variant/);
    expect(() => parsePublishArguments(["--repo", "o/n", "--variant"])).toThrow(/--variant/);
    expect(() => renderFixtureVariant("constructor", new Map())).toThrow(/unknown variant/);
  });

  it("dry-runs the m13 variant from its committed directory: the file list is printed and nothing is changed", () => {
    const root = repository([], ["seed.txt"]);
    for (const file of ["server.mjs", "scripts/seed.mjs", "defects/a.json", "node_modules/p/i.js", ".github/workflows/ci.yml"]) write(root, `${M13}/${file}`);
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", "m13");
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    const lines: string[] = [];
    expect(run(["--repo", "owner/name", "--variant", "m13", "--dry-run", "--force-reseed"], (line) => lines.push(line), root)).toBe(0);
    expect(lines[0]).toContain(M13);
    expect(lines[0]).toContain("variant m13");
    expect(lines.slice(1, 4)).toEqual(["  .github/workflows/ci.yml", "  scripts/seed.mjs", "  server.mjs"]);
    expect(lines[4]).toContain("backup/pre-m13-");
    expect(lines).toHaveLength(5);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })).toBe(before);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })).toBe(head);
    expect(readVariantFiles(root, "m13").size).toBe(3);
  });

  it("does not mention a backup in a dry run without --force-reseed", () => {
    const root = repository([], ["seed.txt"]);
    write(root, `${M13}/server.mjs`);
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", "m13");
    const lines: string[] = [];
    run(["--repo", "owner/name", "--variant", "m13", "--dry-run"], (line) => lines.push(line), root);
    expect(lines).toHaveLength(2);
  });
});

describe("backup branch before a force-reseed", () => {
  const files = new Map([["README.md", "new readme\n"], ["server.mjs", "new server\n"]]);
  const at = (): Date => new Date("2026-10-21T15:30:45.678Z");
  // The script commits with the ambient git identity; CI runners have none configured.
  beforeEach(() => {
    for (const role of ["AUTHOR", "COMMITTER"]) {
      vi.stubEnv(`GIT_${role}_NAME`, "test");
      vi.stubEnv(`GIT_${role}_EMAIL`, "test@example.test");
    }
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  /** A bare remote whose main already has two commits, like the live fixture repository. Returns its path and the main sha. */
  function remote(): { path: string; main: string } {
    const path = mkdtempSync(join(tmpdir(), "fixture-remote-"));
    temporary.push(path);
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", path], { stdio: "pipe" });
    const work = mkdtempSync(join(tmpdir(), "fixture-seed-"));
    temporary.push(work);
    git(work, "init", "--quiet", "-b", "main");
    write(work, "old.txt");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "first");
    write(work, "older.txt");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "second");
    git(work, "push", "--quiet", path, "main:main");
    return { path, main: execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim() };
  }
  const refs = (path: string): Map<string, string> => new Map(execFileSync("git", ["for-each-ref", "--format=%(refname) %(objectname)"], { cwd: path, encoding: "utf8" })
    .trim().split("\n").filter(Boolean).map((line) => [line.split(" ")[0]!, line.split(" ")[1]!]));

  it("names the backup by variant and a UTC timestamp", () => {
    expect(backupBranchName("m13", at())).toBe("backup/pre-m13-20261021T153045Z");
    expect(backupBranchName("starter", new Date("2027-01-02T03:04:05.000Z"))).toBe("backup/pre-starter-20270102T030405Z");
  });

  it("saves the current main as backup/pre-<variant>-<timestamp> and then adds the seed commit on top of it", () => {
    const { path, main } = remote();
    const result = publish({ repo: "owner/name", dryRun: false, forceReseed: true, variant: "m13" }, files, { remoteUrl: path, now: at });
    expect(result.mode).toBe("reseed");
    expect(result.backupBranch).toBe("backup/pre-m13-20261021T153045Z");
    const heads = refs(path);
    expect(heads.get("refs/heads/backup/pre-m13-20261021T153045Z")).toBe(main);
    const newMain = heads.get("refs/heads/main")!;
    expect(newMain).not.toBe(main);
    expect(execFileSync("git", ["rev-parse", `${newMain}^`], { cwd: path, encoding: "utf8" }).trim()).toBe(main);
    expect(execFileSync("git", ["ls-tree", "-r", "--name-only", newMain], { cwd: path, encoding: "utf8" }).trim().split("\n")).toEqual(["README.md", "server.mjs"]);
  });

  it("creates no backup when the remote is empty (a first seed)", () => {
    const path = mkdtempSync(join(tmpdir(), "fixture-empty-"));
    temporary.push(path);
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", path], { stdio: "pipe" });
    const result = publish({ repo: "owner/name", dryRun: false, forceReseed: false, variant: "m13" }, files, { remoteUrl: path, now: at });
    expect(result.mode).toBe("seed");
    expect(result.backupBranch).toBeNull();
    expect([...refs(path).keys()]).toEqual(["refs/heads/main"]);
  });

  it("refuses a remote with commits without --force-reseed and changes nothing", () => {
    const { path, main } = remote();
    expect(() => publish({ repo: "owner/name", dryRun: false, forceReseed: false, variant: "m13" }, files, { remoteUrl: path, now: at })).toThrow(/force-reseed/);
    expect([...refs(path)]).toEqual([["refs/heads/main", main]]);
  });

  it("does not touch main when the backup branch cannot be created", () => {
    const { path, main } = remote();
    // A branch named "backup" blocks every "backup/..." name on the remote.
    execFileSync("git", ["update-ref", "refs/heads/backup", main], { cwd: path });
    expect(() => publish({ repo: "owner/name", dryRun: false, forceReseed: true, variant: "m13" }, files, { remoteUrl: path, now: at })).toThrow();
    expect(refs(path).get("refs/heads/main")).toBe(main);
    expect([...refs(path).keys()].sort()).toEqual(["refs/heads/backup", "refs/heads/main"]);
  });

  it("never overwrites an existing backup of the same name", () => {
    const { path, main } = remote();
    publish({ repo: "owner/name", dryRun: false, forceReseed: true, variant: "m13" }, files, { remoteUrl: path, now: at });
    const afterFirst = refs(path).get("refs/heads/main")!;
    expect(() => publish({ repo: "owner/name", dryRun: false, forceReseed: true, variant: "m13" }, files, { remoteUrl: path, now: at })).toThrow();
    expect(refs(path).get("refs/heads/backup/pre-m13-20261021T153045Z")).toBe(main);
    expect(refs(path).get("refs/heads/main")).toBe(afterFirst);
  });
});
