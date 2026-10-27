import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyGitDirectories, removeEmptyGitDirectories } from "../support/empty-git-directories.js";
import { REPOSITORY_CONTEXT_FILE_CANDIDATES } from "../../packages/worker/src/repository-context.js";
import { chooseScratchRoot, parseTreeEntries, readVerifiedBaseRuleFile } from "../../packages/worker/src/trusted-base-objects.js";

// C84 (files): how the verified read of a base commit's objects handles the workspace's files. Files are linked or copied from regular files only,
// under limits and a deadline; a loose copy that does not match does not hide a genuine packed copy; and oversized, padded-mode and stale-scratch
// cases behave as the working-tree read always did.
const BASE_RULE = "Flag every TODO you find.\n";
const LIMIT = 65_536;

const git = (directory: string, ...args: string[]) =>
  execFileSync("git", ["-C", directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args], { encoding: "utf8" }).trim();

async function repository(files: Record<string, string> = { "AGENTS.md": BASE_RULE }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-trusted-files-")));
  const directory = join(root, "repo");
  await mkdir(directory, { recursive: true });
  git(directory, "init", "--quiet", "--initial-branch=main");
  for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content);
  await writeFile(join(directory, "keep.txt"), "x\n");
  git(directory, "add", ".");
  git(directory, "commit", "--quiet", "-m", "base");
  const base = git(directory, "rev-parse", "HEAD");
  const blob = "AGENTS.md" in files ? git(directory, "rev-parse", `${base}:AGENTS.md`) : "";
  return { root, directory, base, blob, objects: join(directory, ".git/objects") };
}
type Subject = Awaited<ReturnType<typeof repository>>;

const read = (subject: Subject, options: Parameters<typeof readVerifiedBaseRuleFile>[4] = {}, commit = subject.base) =>
  readVerifiedBaseRuleFile(subject.directory, commit, REPOSITORY_CONTEXT_FILE_CANDIDATES, LIMIT, { workspaceRoot: subject.root, ...options });
const text = (found: Awaited<ReturnType<typeof read>>) => (found.kind === "file" ? found.content.toString("utf8") : found.kind);
const unverified = (promise: Promise<unknown>) => promise.then(() => "read", (error: Error) => error.message);
const UNVERIFIED = "base objects could not be verified";

const framed = (type: string, body: Buffer) => Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
const idOf = (type: string, body: Buffer) => createHash("sha1").update(framed(type, body)).digest("hex");
async function putLoose(subject: Subject, oid: string, bytes: Buffer) {
  const path = join(subject.objects, oid.slice(0, 2), oid.slice(2));
  await mkdir(dirname(path), { recursive: true });
  await rm(path, { force: true });
  await writeFile(path, bytes, { mode: 0o444 });
}
const entry = (mode: string, name: string, oid: string) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, "hex")]);

const exdev = async () => { throw Object.assign(new Error("cross-device link"), { code: "EXDEV" }); };

describe("files from the workspace's object store are linked or copied safely (C84)", () => {
  it("control: a read with hard links gives the rule file", async () => {
    const subject = await repository();
    expect(text(await read(subject))).toBe(BASE_RULE);
  });

  it("when a hard link is not possible (another file system) the files are copied and the rule file is read", async () => {
    const subject = await repository();
    git(subject.directory, "gc", "--quiet", "--prune=now");
    let attempts = 0;
    const linkFile = async (source: string, target: string) => { attempts += 1; return exdev(); void source; void target; };
    expect(text(await read(subject, { linkFile }))).toBe(BASE_RULE);
    // The packs (and the loose files, when there are any) were each tried with a link first.
    expect(attempts).toBeGreaterThan(0);
  });

  it("a copy over the copy limit gives a quick visible stop", async () => {
    const subject = await repository();
    git(subject.directory, "gc", "--quiet", "--prune=now");
    expect(await unverified(read(subject, { linkFile: exdev, copyLimitBytes: 16 }))).toBe(UNVERIFIED);
  });

  it("a pack that claims a huge size is not copied: the stop is quick and the disk is not filled", async () => {
    const subject = await repository();
    const pack = join(subject.objects, "pack", `pack-${"a".repeat(40)}.pack`);
    writeFileSync(pack, "PACK");
    truncateSync(pack, 1024 * 1024 * 1024 * 1024);
    const started = Date.now();
    expect(await unverified(read(subject, { linkFile: exdev }))).toBe(UNVERIFIED);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("a pipe in the place of a pack, and a link in the place of one, are passed over without waiting", async () => {
    const subject = await repository();
    const packs = join(subject.objects, "pack");
    mkdirSync(packs, { recursive: true });
    execFileSync("mkfifo", [join(packs, `pack-${"b".repeat(40)}.pack`)]);
    execFileSync("mkfifo", [join(packs, `pack-${"b".repeat(40)}.idx`)]);
    execFileSync("ln", ["-s", "/dev/zero", join(packs, `pack-${"c".repeat(40)}.pack`)]);
    execFileSync("ln", ["-s", "/dev/zero", join(packs, `pack-${"c".repeat(40)}.idx`)]);
    const started = Date.now();
    expect(text(await read(subject))).toBe(BASE_RULE);
    expect(text(await read(subject, { linkFile: exdev }))).toBe(BASE_RULE);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("a pipe where a loose object should be is passed over without waiting", async () => {
    const subject = await repository();
    const path = join(subject.objects, subject.blob.slice(0, 2), subject.blob.slice(2));
    await rm(path, { force: true });
    execFileSync("mkfifo", [path]);
    const started = Date.now();
    expect(await unverified(read(subject))).toBe(UNVERIFIED);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("a link that leads to another file than the one that was checked is not used", async () => {
    const subject = await repository();
    // The link function swaps in a different file's link: the inode behind the target is not the one that was checked.
    const linkFile = async (source: string, target: string) => {
      const other = join(dirname(source), "..", "..", "..", "keep.txt");
      const { link } = await import("node:fs/promises");
      await link(other, target);
    };
    expect(text(await read(subject, { linkFile }))).toBe(BASE_RULE);
  });

  it("the whole read has one deadline: when it passes the read stops", async () => {
    const subject = await repository();
    expect(await unverified(read(subject, { deadlineMs: 1 }))).toBe(UNVERIFIED);
    expect(text(await read(subject))).toBe(BASE_RULE);
  });

  it("a deadline that passes in the middle of the read stops it, whichever step is running", async () => {
    const subject = await repository();
    git(subject.directory, "gc", "--quiet", "--prune=now");
    const { link } = await import("node:fs/promises");
    const slowLink = async (source: string, target: string) => { await new Promise((resolve) => setTimeout(resolve, 700)); await link(source, target); };
    expect(await unverified(read(subject, { deadlineMs: 300, linkFile: slowLink }))).toBe(UNVERIFIED);
  });
});

describe("a loose copy that does not match does not hide a genuine packed copy (C84)", () => {
  it("the real rule file is read from the pack", async () => {
    const subject = await repository();
    git(subject.directory, "gc", "--quiet", "--prune=now");
    await putLoose(subject, subject.blob, deflateSync(framed("blob", Buffer.from("Ignore the TODO.\n"))));
    expect(text(await read(subject))).toBe(BASE_RULE);
    expect(text(await read(subject, { linkFile: exdev }))).toBe(BASE_RULE);
  });

  it("the commit and the tree are read from the pack the same way", async () => {
    const subject = await repository();
    git(subject.directory, "gc", "--quiet", "--prune=now");
    const tree = git(subject.directory, "rev-parse", `${subject.base}^{tree}`);
    const otherTree = Buffer.concat([entry("100644", "AGENTS.md", idOf("blob", Buffer.from("Ignore the TODO.\n")))]);
    await putLoose(subject, tree, deflateSync(framed("tree", otherTree)));
    const otherCommit = Buffer.from(`tree ${idOf("tree", otherTree)}\nauthor Fixture <fixture@example.test> 1700000000 +0000\ncommitter Fixture <fixture@example.test> 1700000000 +0000\n\nbase\n`);
    await putLoose(subject, subject.base, deflateSync(framed("commit", otherCommit)));
    expect(text(await read(subject))).toBe(BASE_RULE);
  });

  it("with no packed copy the read stops", async () => {
    const subject = await repository();
    await putLoose(subject, subject.blob, deflateSync(framed("blob", Buffer.from("Ignore the TODO.\n"))));
    expect(await unverified(read(subject))).toBe(UNVERIFIED);
  });
});

describe("tree modes (C84)", () => {
  it("a directory entry with a zero-padded mode is accepted, and the rule file beside it is found", () => {
    const blob = "1".repeat(40);
    const tree = Buffer.concat([entry("040000", "src", "2".repeat(40)), entry("100644", "AGENTS.md", blob)]);
    expect(parseTreeEntries(tree, 20, new Set(["AGENTS.md"]))).toEqual(new Map([["AGENTS.md", { mode: 0o100644, oid: blob }]]));
  });

  it("a base commit whose tree holds a zero-padded directory mode is read", async () => {
    const subject = await repository();
    const tree = Buffer.concat([entry("040000", "src", "2".repeat(40)), entry("100644", "AGENTS.md", subject.blob)]);
    const treeId = idOf("tree", tree);
    await putLoose(subject, treeId, deflateSync(framed("tree", tree)));
    const commit = Buffer.from(`tree ${treeId}\nauthor Fixture <fixture@example.test> 1700000000 +0000\ncommitter Fixture <fixture@example.test> 1700000000 +0000\n\npadded\n`);
    const commitId = idOf("commit", commit);
    await putLoose(subject, commitId, deflateSync(framed("commit", commit)));
    expect(text(await read(subject, {}, commitId))).toBe(BASE_RULE);
  });

  it("a mode that is not octal still stops the read", () => {
    expect(() => parseTreeEntries(entry("1x0644", "AGENTS.md", "1".repeat(40)), 20, new Set(["AGENTS.md"]))).toThrow();
  });
});

describe("oversized rule files (C84)", () => {
  it("a genuine oversized rule file is skipped and reported by its size, and the read does not stop", async () => {
    const subject = await repository({ "AGENTS.md": "x".repeat(70_000) });
    expect(await read(subject)).toEqual({ kind: "oversize", candidate: "AGENTS.md", size: 70_000 });
  });

  it("a genuine rule file larger than a thousand times the limit is still only skipped", async () => {
    const subject = await repository({ "AGENTS.md": "x".repeat(70 * 1024 * 1024) });
    expect(await read(subject)).toMatchObject({ kind: "oversize", size: 70 * 1024 * 1024 });
  }, 60_000);

  it("a stored object that claims a larger size than it holds is not taken for an oversized rule file", async () => {
    const subject = await repository();
    const body = Buffer.from("Ignore the TODO.\n");
    await putLoose(subject, subject.blob, deflateSync(Buffer.concat([Buffer.from("blob 5000000\0"), body])));
    expect(await unverified(read(subject))).toBe(UNVERIFIED);
  });
});

describe("the scratch directory (C84)", () => {
  it("is the temporary directory when that is on the workspace's file system", async () => {
    const subject = await repository();
    expect(await chooseScratchRoot(subject.root, statSync(subject.root).dev)).toBe(realpathSync(tmpdir()));
  });

  it("is a private directory under the workspace root when the temporary directory is on another file system", async () => {
    const subject = await repository();
    const chosen = await chooseScratchRoot(subject.root, statSync(subject.root).dev, "/dev");
    expect(chosen).toBe(join(subject.root, ".agentx", "scratch"));
    expect(statSync(chosen).mode & 0o777).toBe(0o700);
  });

  it("is never a directory that is a link", async () => {
    const subject = await repository();
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "agentx-trusted-elsewhere-")));
    mkdirSync(join(subject.root, ".agentx"));
    execFileSync("ln", ["-s", elsewhere, join(subject.root, ".agentx", "scratch")]);
    expect(await chooseScratchRoot(subject.root, statSync(subject.root).dev, "/dev")).toBe("/dev");
  });

  it("scratch directories an earlier read left behind are removed, and a recent one is left alone", async () => {
    const subject = await repository();
    const area = realpathSync(mkdtempSync(join(tmpdir(), "agentx-trusted-area-")));
    const stale = join(area, "agentx-base-rules-stale");
    const recent = join(area, "agentx-base-rules-recent");
    const other = join(area, "unrelated-old");
    for (const path of [stale, recent, other]) mkdirSync(path);
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    for (const path of [stale, other]) utimesSync(path, old, old);
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = area;
    try {
      expect(text(await read(subject))).toBe(BASE_RULE);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
    expect(readdirSync(area).sort()).toEqual(["agentx-base-rules-recent", "unrelated-old"]);
    void readdir;
  });
});

describe("git runs only in a read-only, empty git directory (C84)", () => {
  /** A repository-style config that makes a missing object fetch from a remote whose url runs a command, and allows that transport. */
  async function fetchingConfig(marker: string) {
    const script = join(realpathSync(mkdtempSync(join(tmpdir(), "agentx-planted-"))), "run.sh");
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    return `[core]\n\trepositoryformatversion = 1\n[extensions]\n\tpartialClone = planted\n[remote "planted"]\n\turl = ext::sh ${script}\n\tpromisor = true\n[protocol "ext"]\n\tallow = always\n`;
  }

  it("positive control: such a config, in a git directory that is read, runs its command when an object is missing", async () => {
    const area = realpathSync(mkdtempSync(join(tmpdir(), "agentx-planted-")));
    const marker = join(area, "ran");
    const gitDir = join(area, "planted.git");
    execFileSync("git", ["init", "--bare", "--quiet", "--template=", gitDir]);
    await writeFile(join(gitDir, "config"), await fetchingConfig(marker));
    // Git 2.45 and later can be told not to fetch lazily; the image's Git cannot, so the control does not tell it to.
    try { execFileSync("git", ["cat-file", "-s", "1".repeat(40)], { env: { ...process.env, GIT_DIR: gitDir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: "ignore" }); } catch { /* the object is missing */ }
    expect(existsSync(marker)).toBe(true);
  });

  /** The base blob is gone, so a read that honoured a planted config would try to fetch it. */
  async function withoutBaseBlob() {
    const subject = await repository();
    await rm(join(subject.objects, subject.blob.slice(0, 2), subject.blob.slice(2)), { force: true });
    const area = realpathSync(mkdtempSync(join(tmpdir(), "agentx-planted-")));
    const marker = join(area, "ran");
    return { subject, marker, config: await fetchingConfig(marker) };
  }
  /** A git directory the session could have written, holding `config`. */
  async function plantGitDirectory(path: string, config: string) {
    execFileSync("git", ["init", "--bare", "--quiet", "--template=", path], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    await writeFile(join(path, "config"), config);
  }
  const hardeningOff = { protocolBans: false, noLazyFetch: false };

  it("a config planted where the session can write (the scratch directory, its objects directory, a git directory made there) never runs its command", async () => {
    const { subject, marker, config } = await withoutBaseBlob();
    const onScratchReady = async ({ scratch, objects }: { scratch: string; objects: string }) => {
      await writeFile(join(scratch, "config"), config);
      await writeFile(join(objects, "config"), config);
      await mkdir(join(scratch, "base.git"), { recursive: true });
      await writeFile(join(scratch, "base.git", "config"), config);
      await writeFile(join(objects, "pack", "pack-0000000000000000000000000000000000000000.promisor"), "");
    };
    expect(await unverified(read(subject, { onScratchReady }))).toBe(UNVERIFIED);
    expect(existsSync(marker)).toBe(false);
  });

  it("with the protocol bans and the lazy-fetch setting off, such a config still never runs its command: the read-only git directory is what stops it", async () => {
    const { subject, marker, config } = await withoutBaseBlob();
    const onScratchReady = async ({ scratch, objects }: { scratch: string; objects: string }) => {
      await writeFile(join(scratch, "config"), config);
      await writeFile(join(objects, "config"), config);
      await plantGitDirectory(join(scratch, "base.git"), config);
      await writeFile(join(objects, "pack", "pack-0000000000000000000000000000000000000000.promisor"), "");
    };
    expect(await unverified(read(subject, { onScratchReady, gitHardeningForTest: hardeningOff }))).toBe(UNVERIFIED);
    expect(existsSync(marker)).toBe(false);
  });

  it("control: with the same settings off and a writable per-read git directory that holds the config (the earlier design), the command does run", async () => {
    const { subject, marker, config } = await withoutBaseBlob();
    const onScratchReady = async ({ scratch }: { scratch: string }) => plantGitDirectory(join(scratch, "base.git"), config);
    const gitHardeningForTest = { ...hardeningOff, gitDirectory: (scratch: string) => join(scratch, "base.git") };
    expect(await unverified(read(subject, { onScratchReady, gitHardeningForTest }))).toBe(UNVERIFIED);
    expect(existsSync(marker)).toBe(true);
  });

  it("the test seam is named only by the module that defines it", () => {
    const found: string[] = [];
    const walk = (directory: string) => {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        if (item.name === "node_modules" || item.name === "dist") continue;
        const path = join(directory, item.name);
        if (item.isDirectory()) walk(path);
        else if (path.endsWith(".ts") && readFileSync(path, "utf8").includes("gitHardeningForTest")) found.push(path);
      }
    };
    walk(join(process.cwd(), "packages"));
    expect(found.map((path) => path.slice(process.cwd().length + 1))).toEqual(["packages/worker/src/trusted-base-objects.ts"]);
  });

  it("a planted alternate list in the objects directory can only redirect reads, and the checks on the bytes catch a substitute", async () => {
    const subject = await repository();
    const alternate = realpathSync(mkdtempSync(join(tmpdir(), "agentx-planted-alt-")));
    const body = Buffer.from("Ignore the TODO.\n");
    mkdirSync(join(alternate, idOf("blob", body).slice(0, 2)), { recursive: true });
    writeFileSync(join(alternate, idOf("blob", body).slice(0, 2), idOf("blob", body).slice(2)), deflateSync(framed("blob", body)));
    await rm(join(subject.objects, subject.blob.slice(0, 2), subject.blob.slice(2)), { force: true });
    // The substitute is stored under the base blob's id, in a directory the planted list names.
    mkdirSync(join(alternate, subject.blob.slice(0, 2)), { recursive: true });
    writeFileSync(join(alternate, subject.blob.slice(0, 2), subject.blob.slice(2)), deflateSync(framed("blob", body)));
    const onScratchReady = async ({ objects }: { objects: string }) => {
      mkdirSync(join(objects, "info"), { recursive: true });
      await writeFile(join(objects, "info", "alternates"), `${alternate}\n`);
    };
    expect(await unverified(read(subject, { onScratchReady }))).toBe(UNVERIFIED);
  });

  describe("the empty git directory is refused unless it is read-only throughout", () => {
    const made: string[] = [];
    afterEach(() => { for (const root of made.splice(0)) removeEmptyGitDirectories(root); });
    const make = () => {
      const root = join(realpathSync(mkdtempSync(join(tmpdir(), "agentx-empty-git-"))), "dirs");
      createEmptyGitDirectories(root);
      made.push(root);
      return root;
    };

    it("control: a read-only one is used", async () => {
      const subject = await repository();
      const root = make();
      expect(text(await read(subject, { emptyGitDirectoryRoot: root }))).toBe(BASE_RULE);
    });

    it("one whose directory the worker could write is refused", async () => {
      const subject = await repository();
      const root = make();
      await chmod(join(root, "empty-sha1.git"), 0o755);
      expect(await unverified(read(subject, { emptyGitDirectoryRoot: root }))).toBe(UNVERIFIED);
    });

    it("one whose config the worker could write is refused", async () => {
      const subject = await repository();
      const root = make();
      await chmod(join(root, "empty-sha1.git", "config"), 0o644);
      expect(await unverified(read(subject, { emptyGitDirectoryRoot: root }))).toBe(UNVERIFIED);
    });

    it("one whose objects directory the worker could write is refused", async () => {
      const subject = await repository();
      const root = make();
      await chmod(join(root, "empty-sha1.git", "objects"), 0o755);
      expect(await unverified(read(subject, { emptyGitDirectoryRoot: root }))).toBe(UNVERIFIED);
    });

    it("one that is a link is refused", async () => {
      const subject = await repository();
      const real = make();
      const root = realpathSync(mkdtempSync(join(tmpdir(), "agentx-empty-git-links-")));
      await symlink(join(real, "empty-sha1.git"), join(root, "empty-sha1.git"));
      expect(await unverified(read(subject, { emptyGitDirectoryRoot: root }))).toBe(UNVERIFIED);
    });

    it("a missing one is refused, and no other git directory is used instead", async () => {
      const subject = await repository();
      const root = join(realpathSync(mkdtempSync(join(tmpdir(), "agentx-empty-git-"))), "none");
      mkdirSync(root);
      expect(await unverified(read(subject, { emptyGitDirectoryRoot: root }))).toBe(UNVERIFIED);
    });

    it("the 64-character one is checked on its own", async () => {
      const subject = await repository();
      const root = make();
      await chmod(join(root, "empty-sha256.git"), 0o755);
      expect(text(await read(subject, { emptyGitDirectoryRoot: root }))).toBe(BASE_RULE);
    });
  });
});

describe("limits on what is brought in and hashed (C84)", () => {
  async function withJunkPacks(subject: Subject, count: number) {
    const packs = join(subject.objects, "pack");
    mkdirSync(packs, { recursive: true });
    for (let index = 0; index < count; index += 1) writeFileSync(join(packs, `pack-${String(index).padStart(40, "0")}.pack`), "x");
  }

  it("more pack files than the limit stop the read; the limit itself is allowed", async () => {
    const subject = await repository();
    await withJunkPacks(subject, 4);
    expect(await unverified(read(subject, { maxPackFiles: 3 }))).toBe(UNVERIFIED);
    expect(text(await read(subject, { maxPackFiles: 4 }))).toBe(BASE_RULE);
  });

  it("the pack file limit is 10,000", async () => {
    const subject = await repository();
    await withJunkPacks(subject, 10_001);
    expect(await unverified(read(subject))).toBe(UNVERIFIED);
  }, 120_000);

  it("a deadline that passes while the packs are being linked stops before the next one", async () => {
    const subject = await repository();
    await withJunkPacks(subject, 6);
    const { link } = await import("node:fs/promises");
    let calls = 0;
    const slowLink = async (source: string, target: string) => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 250)); await link(source, target); };
    expect(await unverified(read(subject, { deadlineMs: 400, linkFile: slowLink }))).toBe(UNVERIFIED);
    expect(calls).toBeLessThanOrEqual(3);
  });

  it("a blob larger than the hashing limit stops the read, and one within it is skipped as oversized", async () => {
    const subject = await repository({ "AGENTS.md": "x".repeat(70_000) });
    expect(await unverified(read(subject, { maxBlobBytes: 1000 }))).toBe(UNVERIFIED);
    expect(await read(subject, { maxBlobBytes: 70_000 })).toMatchObject({ kind: "oversize", size: 70_000 });
  });
});
