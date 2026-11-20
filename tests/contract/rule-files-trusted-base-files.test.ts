import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

const entry = (mode: string, name: string, oid: string) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, "hex")]);

const exdev = async () => { throw Object.assign(new Error("cross-device link"), { code: "EXDEV" }); };

describe("files from the workspace's object store are linked or copied safely (C84)", () => {

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

  it("a deadline that passes in the middle of the read stops it, whichever step is running", async () => {
    const subject = await repository();
    git(subject.directory, "gc", "--quiet", "--prune=now");
    const { link } = await import("node:fs/promises");
    const slowLink = async (source: string, target: string) => { await new Promise((resolve) => setTimeout(resolve, 700)); await link(source, target); };
    expect(await unverified(read(subject, { deadlineMs: 300, linkFile: slowLink }))).toBe(UNVERIFIED);
  });
});

describe("tree modes (C84)", () => {

  it("a mode that is not octal still stops the read", () => {
    expect(() => parseTreeEntries(entry("1x0644", "AGENTS.md", "1".repeat(40)), 20, new Set(["AGENTS.md"]))).toThrow();
  });
});

describe("the scratch directory is where a hard link from the workspace works (C84)", () => {
  /** A temporary directory that is on the workspace's device but is a different mount point, as a bind mount is: a link from the workspace into it fails with EXDEV. */
  async function withTemporaryArea<T>(body: (area: string) => Promise<T>): Promise<T> {
    const area = await realpath(await mkdtemp(join(tmpdir(), "agentx-trusted-mount-")));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = area;
    try {
      return await body(area);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    }
  }
  const linkExceptInto = (area: string, linked: string[]) => async (source: string, target: string) => {
    if (target.startsWith(`${area}/`)) return exdev();
    const { link } = await import("node:fs/promises");
    linked.push(target);
    await link(source, target);
  };

  it("the scratch directory is the workspace's own runtime directory when a link into the temporary directory fails with EXDEV, and nothing is copied", async () => {
    const subject = await repository();
    await withTemporaryArea(async (area) => {
      git(subject.directory, "gc", "--quiet", "--prune=now");
      const runtime = join(subject.root, ".agentx-runtime", "tmp");
      await mkdir(runtime, { recursive: true, mode: 0o700 });
      const linked: string[] = [];
      let scratch = "";
      // A copy of any size stops the read, so a read that gives the rule file linked every file it brought in.
      const found = await read(subject, { linkFile: linkExceptInto(area, linked), copyLimitBytes: 0, onScratchReady: async (paths) => { scratch = paths.scratch; } });
      expect(text(found)).toBe(BASE_RULE);
      expect(scratch.startsWith(`${runtime}/`)).toBe(true);
      expect(linked.some((target) => target.endsWith(".pack") && target.startsWith(`${runtime}/`))).toBe(true);
      expect(readdirSync(area)).toEqual([]);
    });
  });

  it("when every candidate fails with EXDEV the files are copied, under the copy limit", async () => {
    const subject = await repository();
    await withTemporaryArea(async (area) => {
      git(subject.directory, "gc", "--quiet", "--prune=now");
      await mkdir(join(subject.root, ".agentx-runtime", "tmp"), { recursive: true, mode: 0o700 });
      let scratch = "";
      expect(text(await read(subject, { linkFile: exdev, onScratchReady: async (paths) => { scratch = paths.scratch; } }))).toBe(BASE_RULE);
      expect(scratch.startsWith(`${area}/`)).toBe(true);
      expect(await unverified(read(subject, { linkFile: exdev, copyLimitBytes: 16 }))).toBe(UNVERIFIED);
    });
  });

});

describe("the test link that decides where the scratch directory goes leaves nothing behind and trusts nothing (C84)", () => {
  async function withTemporaryArea<T>(body: (area: string) => Promise<T>): Promise<T> {
    const area = await realpath(await mkdtemp(join(tmpdir(), "agentx-trusted-probe-")));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = area;
    try {
      return await body(area);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    }
  }
  const OLD = () => new Date(Date.now() - 3 * 60 * 60 * 1000);


  it("a runtime tmp directory with the wrong mode is skipped: nothing is made in it, and the scratch directory goes elsewhere", async () => {
    const subject = await repository();
    await withTemporaryArea(async () => {
      git(subject.directory, "gc", "--quiet", "--prune=now");
      const runtime = join(subject.root, ".agentx-runtime", "tmp");
      await mkdir(runtime, { recursive: true });
      await chmod(runtime, 0o755);
      let scratch = "";
      expect(text(await read(subject, { onScratchReady: async (paths) => { scratch = paths.scratch; } }))).toBe(BASE_RULE);
      expect(scratch.startsWith(`${runtime}/`)).toBe(false);
      expect(readdirSync(runtime)).toEqual([]);
    });
  });

  it("a runtime tmp directory reached through a link is skipped: nothing is made where the link leads", async () => {
    const subject = await repository();
    await withTemporaryArea(async () => {
      git(subject.directory, "gc", "--quiet", "--prune=now");
      const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "agentx-trusted-elsewhere-")));
      await chmod(elsewhere, 0o700);
      await mkdir(join(subject.root, ".agentx-runtime"), { recursive: true });
      await symlink(elsewhere, join(subject.root, ".agentx-runtime", "tmp"));
      let scratch = "";
      expect(text(await read(subject, { onScratchReady: async (paths) => { scratch = paths.scratch; } }))).toBe(BASE_RULE);
      expect(scratch.startsWith(`${elsewhere}/`)).toBe(false);
      expect(readdirSync(elsewhere)).toEqual([]);
    });
  });

  it("probe files an earlier read left behind (a killed worker) are removed once they are old by both their times, wherever probes are made", async () => {
    const subject = await repository();
    const outside = join(subject.root, "outside-target");
    writeFileSync(outside, "keep\n");
    utimesSync(outside, OLD(), OLD());
    await withTemporaryArea(async (area) => {
      git(subject.directory, "gc", "--quiet", "--prune=now");
      const runtime = join(subject.root, ".agentx-runtime", "tmp");
      await mkdir(runtime, { recursive: true, mode: 0o700 });
      const pack = join(subject.objects, "pack", readdirSync(join(subject.objects, "pack")).find((name) => name.endsWith(".pack"))!);
      const old = OLD();
      const names = { stale: "agentx-link-probe-1-aaaaaaaaaaaa", recent: "agentx-link-probe-2-bbbbbbbbbbbb", link: "agentx-link-probe-3-cccccccccccc", fifo: "agentx-link-probe-4-dddddddddddd", dir: "agentx-link-probe-5-eeeeeeeeeeee", other: "unrelated-old-file" };
      for (const directory of [runtime, area, subject.objects]) {
        // A hard link to a pack (what a killed worker leaves in a candidate) is the stale one in the scratch candidates; an empty file is the stale one in objects.
        if (directory === subject.objects) writeFileSync(join(directory, names.stale), ""); else await link(pack, join(directory, names.stale));
        writeFileSync(join(directory, names.recent), "");
        await symlink(outside, join(directory, names.link));
        execFileSync("mkfifo", [join(directory, names.fifo)]);
        mkdirSync(join(directory, names.dir));
        writeFileSync(join(directory, names.other), "");
        for (const name of [names.stale, names.other]) utimesSync(join(directory, name), old, old);
        // Old, but not regular files: these are never touched.
        utimesSync(join(directory, names.dir), old, old);
      }
      // Made a moment ago: an old modification time alone (a link to an old pack has one) does not make a leftover old, so nothing is removed yet.
      expect(text(await read(subject, { linkFile: exdev }))).toBe(BASE_RULE);
      for (const directory of [runtime, area, subject.objects]) {
        const left = readdirSync(directory).filter((name) => name.startsWith("agentx-link-probe-") || name === names.other).sort();
        expect(left).toEqual([names.stale, names.recent, names.link, names.fifo, names.dir, names.other].sort());
      }
      // Two hours on, the regular leftovers are removed; links, pipes, directories and other names are not. The link's target is old by then too, so
      // only opening without following the link keeps it.
      const later = Date.now() + 2 * 60 * 60 * 1000;
      expect(text(await read(subject, { linkFile: exdev, now: () => later }))).toBe(BASE_RULE);
      for (const directory of [runtime, area, subject.objects]) {
        const left = readdirSync(directory).filter((name) => name.startsWith("agentx-link-probe-") || name === names.other).sort();
        expect(left).toEqual([names.link, names.fifo, names.dir, names.other].sort());
        expect(lstatSync(join(directory, names.link)).isSymbolicLink()).toBe(true);
      }
      expect(readFileSync(outside, "utf8")).toBe("keep\n");
      // Removing the leftover link removed only its name: the pack is still there, and no other name of it is.
      expect(existsSync(pack)).toBe(true);
      expect(statSync(pack).nlink).toBe(1);
    });
  });
});

describe("the scratch directory (C84)", () => {

  it("is a private directory under the workspace root when the temporary directory is on another file system", async () => {
    const subject = await repository();
    const chosen = await chooseScratchRoot(subject.root, statSync(subject.root).dev, "/dev");
    expect(chosen).toBe(join(subject.root, ".agentx", "scratch"));
    expect(statSync(chosen).mode & 0o777).toBe(0o700);
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

  describe("the empty git directory is refused unless it is read-only throughout", () => {
    const made: string[] = [];
    afterEach(() => { for (const root of made.splice(0)) removeEmptyGitDirectories(root); });
    const make = () => {
      const root = join(realpathSync(mkdtempSync(join(tmpdir(), "agentx-empty-git-"))), "dirs");
      createEmptyGitDirectories(root);
      made.push(root);
      return root;
    };

    it("one whose directory the worker could write is refused", async () => {
      const subject = await repository();
      const root = make();
      await chmod(join(root, "empty-sha1.git"), 0o755);
      expect(await unverified(read(subject, { emptyGitDirectoryRoot: root }))).toBe(UNVERIFIED);
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

  it("a blob larger than the hashing limit stops the read, and one within it is skipped as oversized", async () => {
    const subject = await repository({ "AGENTS.md": "x".repeat(70_000) });
    expect(await unverified(read(subject, { maxBlobBytes: 1000 }))).toBe(UNVERIFIED);
    expect(await read(subject, { maxBlobBytes: 70_000 })).toMatchObject({ kind: "oversize", size: 70_000 });
  });
});
