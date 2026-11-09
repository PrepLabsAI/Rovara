// SH22 review F4: the pure pieces of the tracked-file check: the refused .git entries, the origin URL rules, the generated config, the tree listing and the byte-for-byte comparison.
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REFUSED_GIT_ENTRIES, compareTrackedFiles, minimalGitConfig, originUrlIsSafe, originUrlOf, parseLsTree, unsafeGitEntries, type TreeEntry } from "../../packages/worker/src/saved-env/tree-check.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const scratch = async (): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), "tree-check-")); roots.push(dir); return dir; };
const blob = (content: string): string => createHash("sha1").update(`blob ${String(Buffer.byteLength(content))}\u0000${content}`).digest("hex");

describe("refused .git entries", () => {
  it("lists exactly the entries that redirect history", () => {
    expect([...REFUSED_GIT_ENTRIES].sort()).toEqual(["commondir", "gitdir", "info/attributes", "info/grafts", "modules", "objects/info/alternates", "objects/info/http-alternates", "refs/replace", "worktrees"]);
  });
  it("finds each one that is present, even as a link, and nothing else", async () => {
    const git = await scratch();
    expect(await unsafeGitEntries(git)).toEqual([]);
    await mkdir(join(git, "objects", "info"), { recursive: true });
    await writeFile(join(git, "objects", "info", "alternates"), "/x");
    await mkdir(join(git, "info"), { recursive: true });
    await writeFile(join(git, "info", "attributes"), "* filter=evil\n");
    await symlink("/tmp", join(git, "modules"));
    await mkdir(join(git, "refs", "replace"), { recursive: true });
    await writeFile(join(git, "HEAD"), "ref: refs/heads/main");
    expect((await unsafeGitEntries(git)).sort()).toEqual(["info/attributes", "modules", "objects/info/alternates", "refs/replace"]);
  });
});

describe("origin URL", () => {
  it("reads remote.origin.url from a config", () => {
    expect(originUrlOf('[core]\n\tbare = false\n[remote "other"]\n\turl = https://x/y\n[remote "origin"]\n\turl = https://github.com/a/b.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n')).toBe("https://github.com/a/b.git");
    expect(originUrlOf("[core]\n")).toBeUndefined();
  });
  it("accepts a plain URL and the git user, refuses a credential, a quote, a newline, a space and an odd scheme", () => {
    for (const ok of ["https://github.com/a/b.git", "http://git.example.com/a", "git@github.com:a/b.git", "ssh://git@host.example/a/b.git"]) expect(originUrlIsSafe(ok), ok).toBe(true);
    for (const bad of ["https://user:pw@github.com/a", "https://token@github.com/a", "ssh://deploy@host/a", "deploy@host:a/b.git", "file:///etc", "ext::sh -c x", "https://h/a\n[credential]", 'https://h/a"b', "https://h/a b", "", `https://h/${"a".repeat(600)}`, "https://h/a\u0000"]) expect(originUrlIsSafe(bad), JSON.stringify(bad)).toBe(false);
  });
  it("the generated config has two sections and the URL, and refuses an unsafe URL", () => {
    const config = minimalGitConfig("https://github.com/a/b.git");
    expect(config.split("\n").filter((line) => line.startsWith("["))).toEqual(["[core]", '[remote "origin"]']);
    expect(config).toContain("url = https://github.com/a/b.git");
    expect(() => minimalGitConfig("https://u:p@h/a")).toThrow();
  });
});

describe("tree listing", () => {
  it("parses ls-tree -r -z output and refuses anything else", () => {
    const sha = "a".repeat(40);
    expect(parseLsTree(`100644 blob ${sha}\tsrc/a b.js\u0000100755 blob ${sha}\trun.sh\u0000`)).toEqual([{ mode: "100644", type: "blob", sha, path: "src/a b.js" }, { mode: "100755", type: "blob", sha, path: "run.sh" }]);
    expect(() => parseLsTree("garbage\u0000")).toThrow();
    expect(() => parseLsTree(`100644 blob ${sha}\t../escape\u0000`)).toThrow();
    expect(() => parseLsTree(`100644 blob ${sha}\t/abs\u0000`)).toThrow();
  });
});

describe("comparison with the work tree", () => {
  const entry = (path: string, content: string, mode = "100644"): TreeEntry => ({ mode, type: "blob", sha: blob(content), path });
  async function stage(): Promise<string> {
    const root = await scratch();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.js"), "one");
    await writeFile(join(root, "run.sh"), "go");
    await chmod(join(root, "run.sh"), 0o755);
    await symlink("src/a.js", join(root, "alias"));
    return root;
  }
  const entries = (): TreeEntry[] => [entry("src/a.js", "one"), entry("run.sh", "go", "100755"), entry("alias", "src/a.js", "120000")];

  it("passes when every tracked file is the committed one, and untracked files are free", async () => {
    const root = await stage();
    await writeFile(join(root, "untracked.log"), "anything");
    expect(await compareTrackedFiles(entries(), root)).toEqual({ ok: true, files: 3 });
  });
  it("refuses a changed file, a missing one, a wrong mode, a link with another target, a gitlink and a path through a linked directory", async () => {
    const cases: Array<[string, TreeMismatchName, (root: string) => Promise<void>, TreeEntry[]?]> = [
      ["content", "content", async (r) => { await writeFile(join(r, "src", "a.js"), "two"); }],
      ["missing", "missing", async (r) => { await rm(join(r, "run.sh")); }],
      ["mode", "mode", async (r) => { await chmod(join(r, "run.sh"), 0o644); }],
      ["link target", "content", async (r) => { await rm(join(r, "alias")); await symlink("run.sh", join(r, "alias")); }],
      ["file for link", "wrong_kind", async (r) => { await rm(join(r, "alias")); await writeFile(join(r, "alias"), "src/a.js"); }],
      ["submodule", "submodule", async () => undefined, [{ mode: "160000", type: "commit", sha: "a".repeat(40), path: "sub" }]],
      ["linked directory", "linked_directory", async (r) => { await rm(join(r, "src"), { recursive: true }); await mkdir(join(r, "elsewhere")); await writeFile(join(r, "elsewhere", "a.js"), "one"); await symlink("elsewhere", join(r, "src")); }],
    ];
    for (const [name, reason, change, only] of cases) {
      const root = await stage();
      await change(root);
      const result = await compareTrackedFiles(only ?? entries(), root);
      expect(result, name).toMatchObject({ ok: false, reason });
    }
  });
});

type TreeMismatchName = "submodule" | "missing" | "wrong_kind" | "linked_directory" | "content" | "mode" | "unreadable";
