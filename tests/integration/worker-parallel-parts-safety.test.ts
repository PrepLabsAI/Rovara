import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, lstat, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setCandidateWriteHookForTests } from "../../packages/worker/src/candidate-fs.js";
import { withIsolatedGit } from "../../packages/worker/src/isolated-git.js";
import { PARTS_DIRECTORY, capturePartTree, createPartWorkingCopy, integrateTrees, setPartCreationHookForTests } from "../../packages/worker/src/parallel-parts-git.js";
import { readCandidateRepositories } from "../../packages/worker/src/verification/candidate.js";

// The agent of a part can write everything under its part's folder, and the host worker reads and removes that folder. Nothing the worker does there may follow a link the agent
// planted: a symlink to a host file must never be copied into the project repository (where the sandbox can read it), and a swapped folder must never be removed or written through.

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

let root: string;
let repository: string;
let outside: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "rovara-parts-safe-")));
  repository = join(root, "repo/app");
  outside = join(root, "..", `host-${Math.random().toString(16).slice(2)}`);
  await mkdir(repository, { recursive: true });
  await mkdir(outside, { recursive: true });
  git("init", "--quiet", "--initial-branch=main");
  await writeFile(join(repository, "README.md"), "base\n");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "base");
});
afterEach(async () => {
  setPartCreationHookForTests(undefined);
  setCandidateWriteHookForTests(undefined);
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const treeNow = async (): Promise<string> => (await readCandidateRepositories([{ repositoryId: "app", directory: repository }]))[0]!.treeSha;
const copyOf = async (itemId = A) => createPartWorkingCopy({ rootPath: root, repositoryDirectory: repository, repositoryId: "app", itemId, treeSha: await treeNow() });
const looseFiles = async (objects: string): Promise<string[]> => {
  const names: string[] = [];
  for (const entry of await readdir(objects)) if (/^[0-9a-f]{2}$/.test(entry)) for (const file of await readdir(join(objects, entry))) names.push(`${entry}${file}`);
  return names;
};

describe("capturing a part never reads its object directory", () => {
  it("a loose object that is a symlink to a host file is not copied into the project repository", async () => {
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "TOP SECRET HOST BYTES");
    const copy = await copyOf();
    await mkdir(join(copy.directory, ".git/objects/ab"), { recursive: true });
    await symlink(secret, join(copy.directory, ".git/objects/ab", "c".repeat(38)));
    await writeFile(join(copy.directory, "a.txt"), "from a\n");
    const tree = await capturePartTree(copy, repository);
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(repository, ".git/objects/ab", "c".repeat(38)))).toBe(false);
    for (const name of await looseFiles(join(repository, ".git/objects"))) {
      const bytes = await readFile(join(repository, ".git/objects", name.slice(0, 2), name.slice(2)));
      expect(bytes.includes(Buffer.from("TOP SECRET"))).toBe(false);
    }
    expect(git("show", `${tree}:a.txt`)).toBe("from a");
  });

  it("a pack, an index and a loose object that are symlinks, a directory link and a FIFO in the object directory are all left alone", async () => {
    const secret = join(outside, "pack-source");
    await writeFile(secret, "HOST PACK BYTES");
    const copy = await copyOf();
    const objects = join(copy.directory, ".git/objects");
    await mkdir(join(objects, "pack"), { recursive: true });
    await symlink(secret, join(objects, "pack", `pack-${"d".repeat(40)}.pack`));
    await symlink(secret, join(objects, "pack", `pack-${"d".repeat(40)}.idx`));
    // The linked directory holds a loose-object-shaped host file; if the link were followed, it would be copied under the same name.
    const hostLoose = "e".repeat(38);
    await writeFile(join(outside, hostLoose), "HOST LOOSE BYTES");
    await symlink(outside, join(objects, "cd"));
    execFileSync("mkfifo", [join(objects, "pack", `pack-${"e".repeat(40)}.pack`)]);
    await writeFile(join(copy.directory, "a.txt"), "from a\n");
    await capturePartTree(copy, repository);
    expect(await readdir(join(repository, ".git/objects/pack"))).toEqual([]);
    // Not "objects/cd is absent": the project repository may hold a real object whose id starts with cd (the fixture's own commit id depends on its timestamp). What must never
    // happen is the planted link's file reaching the project repository, or the link itself being copied.
    expect(existsSync(join(repository, ".git/objects/cd", hostLoose))).toBe(false);
    expect((await lstat(join(repository, ".git/objects/cd")).catch(() => undefined))?.isSymbolicLink() ?? false).toBe(false);
    for (const name of await looseFiles(join(repository, ".git/objects"))) {
      expect((await readFile(join(repository, ".git/objects", name.slice(0, 2), name.slice(2)))).includes(Buffer.from("HOST LOOSE"))).toBe(false);
    }
    expect((await readdir(outside)).sort()).toEqual([hostLoose, "pack-source"].sort());
  });

  it("objects the agent created in the part (a commit it made itself) still reach the project repository, because the snapshot is taken again from the files", async () => {
    const copy = await copyOf();
    await writeFile(join(copy.directory, "made.txt"), "made by the agent\n");
    execFileSync("git", ["-C", copy.directory, "add", "."], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    execFileSync("git", ["-C", copy.directory, "-c", "user.name=Agent", "-c", "user.email=a@example.test", "commit", "--quiet", "-m", "agent commit"], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    const tree = await capturePartTree(copy, repository);
    expect(git("show", `${tree}:made.txt`)).toBe("made by the agent");
    // The merge, which reads only the project repository's objects, can use it.
    const base = await treeNow();
    expect((await integrateTrees(repository, { integratedTreeSha: base, baseTreeSha: base, partTreeSha: tree })).ok).toBe(true);
    git("cat-file", "-e", `${tree}^{tree}`);
  });
});

describe("the folders of the parts are never followed through a link", () => {
  it("removes a part whose folder was swapped for a link, without touching what it pointed at", async () => {
    const decoy = join(outside, "decoy");
    await mkdir(join(decoy, "app"), { recursive: true });
    await writeFile(join(decoy, "app/keep.txt"), "keep\n");
    const copy = await copyOf();
    await rm(join(root, PARTS_DIRECTORY, A), { recursive: true, force: true });
    await symlink(decoy, join(root, PARTS_DIRECTORY, A));
    await copy.remove();
    expect(await readFile(join(decoy, "app/keep.txt"), "utf8")).toBe("keep\n");
    expect((await lstat(join(root, PARTS_DIRECTORY, A)).catch(() => undefined))?.isSymbolicLink() ?? false).toBe(false);
  });

  it("removes links the agent planted inside its part (a file link, a folder link, a link in a nested folder) without following them", async () => {
    const decoy = join(outside, "decoy-inner");
    await mkdir(join(decoy, "sub"), { recursive: true });
    await writeFile(join(decoy, "keep.txt"), "keep\n");
    await writeFile(join(decoy, "sub/keep.txt"), "keep\n");
    const copy = await copyOf();
    await symlink(decoy, join(copy.directory, "folder-link"));
    await symlink(join(decoy, "keep.txt"), join(copy.directory, "file-link"));
    await mkdir(join(copy.directory, "nested/deeper"), { recursive: true });
    await symlink(decoy, join(copy.directory, "nested/deeper/link"));
    execFileSync("mkfifo", [join(copy.directory, "nested/fifo")]);
    await copy.remove();
    expect(existsSync(join(root, PARTS_DIRECTORY, A))).toBe(false);
    expect(await readFile(join(decoy, "keep.txt"), "utf8")).toBe("keep\n");
    expect(await readFile(join(decoy, "sub/keep.txt"), "utf8")).toBe("keep\n");
  });

  it("removes a part whose repository folder was swapped for a link, without touching what it pointed at", async () => {
    const decoy = join(outside, "decoy2");
    await mkdir(decoy, { recursive: true });
    await writeFile(join(decoy, "keep.txt"), "keep\n");
    const copy = await copyOf();
    await rm(copy.directory, { recursive: true, force: true });
    await symlink(decoy, copy.directory);
    await copy.remove();
    expect(await readFile(join(decoy, "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("does not remove through a parts folder that is itself a link", async () => {
    const decoy = join(outside, "decoy3");
    await mkdir(join(decoy, A, "app"), { recursive: true });
    await writeFile(join(decoy, A, "app/keep.txt"), "keep\n");
    const copy = await copyOf();
    await rm(join(root, PARTS_DIRECTORY), { recursive: true, force: true });
    await symlink(decoy, join(root, PARTS_DIRECTORY));
    await copy.remove().catch(() => undefined);
    expect(await readFile(join(decoy, A, "app/keep.txt"), "utf8")).toBe("keep\n");
  });

  it("refuses to capture a part whose folder was swapped for a link to another repository", async () => {
    const copy = await copyOf();
    const other = join(outside, "other-repo");
    await mkdir(other, { recursive: true });
    execFileSync("git", ["-C", other, "init", "--quiet"]);
    await writeFile(join(other, "stolen.txt"), "another repository\n");
    await rm(copy.directory, { recursive: true, force: true });
    await symlink(other, copy.directory);
    await expect(capturePartTree(copy, repository)).rejects.toThrow();
    expect(git("count-objects", "-v")).toBeDefined();
    expect(existsSync(join(repository, "stolen.txt"))).toBe(false);
  });

  it("creating a part over a stale folder that is a link replaces the link and writes nothing through it", async () => {
    const decoy = join(outside, "decoy4");
    await mkdir(decoy, { recursive: true });
    await mkdir(join(root, PARTS_DIRECTORY), { recursive: true });
    await symlink(decoy, join(root, PARTS_DIRECTORY, A));
    const copy = await copyOf();
    expect(await readdir(decoy)).toEqual([]);
    expect((await lstat(join(root, PARTS_DIRECTORY, A))).isSymbolicLink()).toBe(false);
    await copy.remove();
  });

  it("refuses to create parts when the parts folder is a link", async () => {
    const decoy = join(outside, "decoy5");
    await mkdir(decoy, { recursive: true });
    await symlink(decoy, join(root, PARTS_DIRECTORY));
    await expect(copyOf()).rejects.toThrow();
    expect(await readdir(decoy)).toEqual([]);
  });

  it("refuses to keep parts inside a project repository (a repository at the workspace root)", async () => {
    await expect(createPartWorkingCopy({ rootPath: root, repositoryDirectory: root, repositoryId: "app", itemId: B, treeSha: await treeNow() })).rejects.toThrow(/inside the project repository|workspace root/);
  });
});

describe("the merge is made of commits", () => {
  it("passes commits, with the common ancestor in their history, to merge-tree (Git before 2.40 has no --merge-base)", async () => {
    const trace = join(outside, "git-trace.txt");
    const previous = process.env.GIT_TRACE;
    process.env.GIT_TRACE = trace;
    try {
      const base = await treeNow();
      const make = async (itemId: string, name: string, text: string) => {
        const copy = await copyOf(itemId);
        await writeFile(join(copy.directory, name), text);
        const tree = await capturePartTree(copy, repository);
        await copy.remove();
        return tree;
      };
      const left = await make(A, "a.txt", "a\n");
      const right = await make(B, "b.txt", "b\n");
      const merged = await integrateTrees(repository, { integratedTreeSha: left, baseTreeSha: base, partTreeSha: right });
      expect(merged.ok).toBe(true);
      const lines = (await readFile(trace, "utf8")).split("\n").filter((line) => /merge-tree/.test(line));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toContain("--merge-base");
        const args = (/merge-tree (.*)$/.exec(line)?.[1] ?? "").split(" ").filter((arg) => /^[0-9a-f]{40}$/.test(arg));
        expect(args).toHaveLength(2);
        for (const id of args) expect(git("cat-file", "-t", id)).toBe("commit");
      }
      if (merged.ok) expect(git("show", `${merged.treeSha}:a.txt`)).toBe("a");
    } finally {
      if (previous === undefined) delete process.env.GIT_TRACE;
      else process.env.GIT_TRACE = previous;
    }
  });
});

describe("building a part's repository in a folder the sandbox can already write", () => {
  const listing = async (folder: string) => (await readdir(folder)).sort();

  it("writes nothing through a `.git` link planted in the gap before the repository is built", async () => {
    const target = join(outside, "git-link-target");
    await mkdir(target, { recursive: true });
    setPartCreationHookForTests(async (_step, directory) => { await symlink(target, join(directory, ".git")); });
    await expect(copyOf()).rejects.toThrow();
    expect(await listing(target)).toEqual([]);
    expect(existsSync(join(root, PARTS_DIRECTORY, A))).toBe(false);
  });

  it("writes nothing through a `gitdir:` file planted in the gap", async () => {
    const target = join(outside, "gitdir-target");
    await mkdir(target, { recursive: true });
    setPartCreationHookForTests(async (_step, directory) => { await writeFile(join(directory, ".git"), `gitdir: ${target}\n`); });
    await expect(copyOf()).rejects.toThrow();
    expect(await listing(target)).toEqual([]);
    expect(existsSync(join(root, PARTS_DIRECTORY, A))).toBe(false);
  });

  it("writes nothing through links planted at the names the repository is built from (objects, refs, HEAD, config)", async () => {
    for (const name of ["objects", "refs", "HEAD", "config"]) {
      // A folder target for the folders; for the two files a path that does not exist, so a write through the link would create it.
      const isFile = name === "HEAD" || name === "config";
      const target = join(outside, `target-${name}`);
      if (!isFile) await mkdir(target, { recursive: true });
      setPartCreationHookForTests(async (_step, directory) => {
        await mkdir(join(directory, ".git"), { recursive: true });
        await symlink(target, join(directory, ".git", name));
      });
      await expect(copyOf()).rejects.toThrow();
      if (isFile) expect(existsSync(target)).toBe(false);
      else expect(await listing(target)).toEqual([]);
    }
  });

  it("builds a repository an ordinary git accepts, with no template, hooks or leftovers", async () => {
    const copy = await copyOf();
    expect(execFileSync("git", ["-C", copy.directory, "rev-parse", "--git-dir"], { encoding: "utf8" }).trim()).toBe(".git");
    expect(execFileSync("git", ["-C", copy.directory, "status", "--porcelain"], { encoding: "utf8" }).trim()).toBe("");
    expect(execFileSync("git", ["-C", copy.directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(copy.startCommit);
    expect(await listing(join(copy.directory, ".git"))).not.toContain("hooks");
    expect(await readFile(join(copy.directory, ".git/config"), "utf8")).toContain("repositoryformatversion = 0");
    expect(existsSync(join(copy.directory, ".git/objects/pack"))).toBe(true);
    expect(existsSync(join(copy.directory, ".git/refs/heads"))).toBe(true);
    await copy.remove();
  });

  it("reads the start tree from the project repository's objects only, never from objects planted in the part's own", async () => {
    // A corrupt loose object, planted where the start tree's object would be in the part, must not be read.
    const tree = await treeNow();
    setPartCreationHookForTests(async (_step, directory) => {
      await mkdir(join(directory, ".git/objects", tree.slice(0, 2)), { recursive: true });
      await writeFile(join(directory, ".git/objects", tree.slice(0, 2), tree.slice(2)), "not a git object");
    });
    const copy = await createPartWorkingCopy({ rootPath: root, repositoryDirectory: repository, repositoryId: "app", itemId: A, treeSha: tree });
    expect(await readFile(join(copy.directory, "README.md"), "utf8")).toBe("base\n");
    await copy.remove();
  });
});

describe.skipIf(process.platform !== "linux")("the part's git files are read through the held .git directory (Linux: descriptors)", () => {
  it("does not read info/exclude, attributes or config from a directory the .git path was swapped to after it was checked", async () => {
    const copy = await copyOf();
    const decoy = join(outside, "decoy-git");
    await mkdir(decoy, { recursive: true });
    // The decoy's config would make the worker refuse (core.excludesFile is refused); a read through the swapped path would see it.
    await writeFile(join(decoy, "config"), "[core]\n\texcludesFile = /host/ignore\n");
    setCandidateWriteHookForTests(async (step) => {
      if (step !== "read git files") return;
      await rm(join(copy.directory, ".git"), { recursive: true, force: true }).catch(() => undefined);
      await symlink(decoy, join(copy.directory, ".git"));
    });
    await expect(withIsolatedGit(copy.directory, "read", async () => "read")).resolves.toBe("read");
  });
});
