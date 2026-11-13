// TE-F2 part B (DECISIONS 161): provenance is decided by the WORKER from the task's BASE COMMIT, never by a file the sandbox could write. Run against real git repositories in a temp directory.
//   a reply equal to the base commit's is `before_task`; an edited one, a new one, or any reply whose base file is absent, unreadable or invalid is `task_made`; the working tree and the candidate's own commits never raise a
//   reply's provenance; a file that carries a provenance or origin field is refused (it is not a reply-set file); a symlink is unreadable; the failure pack never counts.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// The worker reads the contracts through the package name: the constructor must come from the same module copy (its registry is module-private).
import { createRovaraIndependentDecision, modelReplyEntrySha256, parseModelReplySetFileBytes, replyCountsTowardProof, type ModelReplyFileEntry } from "@agentx/contracts";
import { loadModelReplySets, modelReplyFilePath, createRepoReplySetSource, readFileAtCommit, readFileInWorkingTree, type ReplyFileRead, type ReplySetSource } from "../../packages/worker/src/model-reply-set-load.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "rsrl-"));
  dirs.push(dir);
  return dir;
};
const GIT_ENV = { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: "/nonexistent" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
const FAMILY = "openai_compatible" as const;
const file = (replies: Array<Record<string, unknown>>): string => JSON.stringify({ version: 1, family: FAMILY, replies: replies.map((reply) => ({ match: {}, response: { text: "scripted", finish: "stop" }, ...reply })) });
const write = (root: string, text: string): void => {
  mkdirSync(join(root, ".rovara/mocks/model"), { recursive: true });
  writeFileSync(join(root, modelReplyFilePath(FAMILY)), text);
};
const signal = new AbortController().signal;

function repoWithBase(baseText: string | undefined): { root: string; base: string; scratch: string } {
  const root = tmp();
  git(root, "init", "--quiet");
  writeFileSync(join(root, "README.md"), "x");
  if (baseText !== undefined) write(root, baseText);
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "base");
  return { root, base: git(root, "rev-parse", "HEAD"), scratch: tmp() };
}
const sourceOf = (r: { root: string; base: string; scratch: string }) => createRepoReplySetSource({ repositoryRoot: r.root, baseCommit: r.base, workingRoot: r.root, scratchRoot: r.scratch });
const counts = async (source: ReplySetSource) => (await loadModelReplySets(source, signal)).families.find((entry) => entry.family === FAMILY)?.counts;

describe("provenance from the base commit", () => {
  it("a reply equal to the base commit's is before_task; an edited one and a new one are task_made", async () => {
    const r = repoWithBase(file([{ id: "keep", response: { text: "A", finish: "stop" } }, { id: "edit", response: { text: "B", finish: "stop" } }]));
    write(r.root, file([{ id: "keep", response: { text: "A", finish: "stop" } }, { id: "edit", response: { text: "B changed", finish: "stop" } }, { id: "fresh" }]));
    const loaded = await loadModelReplySets(sourceOf(r), signal);
    const set = loaded.sets.find((entry) => entry.family === FAMILY);
    expect(set?.replies.map((reply) => [reply.id, reply.provenance])).toEqual([["keep", "before_task"], ["edit", "task_made"], ["fresh", "task_made"]]);
    expect(set?.replies[0]).toMatchObject({ origin: "repo_file_at_base" });
    expect(set?.replies.map((reply) => replyCountsTowardProof(reply.provenance))).toEqual([true, false, false]);
  });
  it("reads the BASE COMMIT, not the working tree: the agent editing the file and committing it cannot make its edit before_task", async () => {
    const r = repoWithBase(file([{ id: "a", response: { text: "original", finish: "stop" } }]));
    write(r.root, file([{ id: "a", response: { text: "rigged", finish: "stop" } }]));
    git(r.root, "add", "-A");
    git(r.root, "commit", "--quiet", "-m", "agent");
    // working tree AND HEAD now hold the rigged reply; the base commit still holds the original
    expect(await counts(sourceOf(r))).toEqual({ before_task: 0, independent: 0, task_made: 1 });
    const base = await sourceOf(r).readBase(FAMILY, signal);
    expect(base.kind === "file" && Buffer.from(base.bytes).toString()).toContain("original");
  });
  it("a reply absent at base, a base file that is absent, invalid or unreadable: all task_made", async () => {
    const none = repoWithBase(undefined);
    write(none.root, file([{ id: "a" }]));
    expect(await counts(sourceOf(none))).toEqual({ before_task: 0, independent: 0, task_made: 1 });
    const broken = repoWithBase("{not json");
    write(broken.root, file([{ id: "a" }]));
    expect(await counts(sourceOf(broken))).toMatchObject({ before_task: 0, task_made: 1 });
    const same = file([{ id: "a" }]);
    const unreadable: ReplySetSource = { readBase: () => Promise.reject(new Error("boom")), readCandidate: () => Promise.resolve({ kind: "file", bytes: new TextEncoder().encode(same) } as ReplyFileRead) };
    expect(await counts(unreadable)).toMatchObject({ before_task: 0, task_made: 1 });
  });
  it("a file that carries a provenance or origin field is not a reply-set file: that family has no set (fail closed)", async () => {
    const r = repoWithBase(file([{ id: "a" }]));
    write(r.root, file([{ id: "a", provenance: "before_task" }]));
    const loaded = await loadModelReplySets(sourceOf(r), signal);
    expect(loaded.sets).toHaveLength(0);
    expect(loaded.families.find((entry) => entry.family === FAMILY)?.status).toBe("invalid");
    write(r.root, file([{ id: "a", origin: "customer_written" }]));
    expect((await loadModelReplySets(sourceOf(r), signal)).sets).toHaveLength(0);
  });
  it("a file of another family, a missing file, an oversize file and a symlinked folder or file are no set", async () => {
    const r = repoWithBase(file([{ id: "a" }]));
    write(r.root, JSON.stringify({ version: 1, family: "gemini", replies: [] }));
    expect(await counts(sourceOf(r))).toEqual({ before_task: 0, independent: 0, task_made: 0 });
    rmSync(join(r.root, ".rovara"), { recursive: true });
    expect((await loadModelReplySets(sourceOf(r), signal)).families.find((entry) => entry.family === FAMILY)?.status).toBe("absent");
    const outside = tmp();
    writeFileSync(join(outside, "x.json"), file([{ id: "a" }]));
    mkdirSync(join(r.root, ".rovara/mocks/model"), { recursive: true });
    symlinkSync(join(outside, "x.json"), join(r.root, modelReplyFilePath(FAMILY)));
    expect((await loadModelReplySets(sourceOf(r), signal)).families.find((entry) => entry.family === FAMILY)?.status).toBe("unreadable");
    rmSync(join(r.root, ".rovara"), { recursive: true });
    symlinkSync(outside, join(r.root, ".rovara"));
    expect((await loadModelReplySets(sourceOf(r), signal)).families.find((entry) => entry.family === FAMILY)?.status).toBe("unreadable");
  });
  it("the base read refuses a symlink in the tree, a bad sha, a missing commit and a non-plain repository; it never runs the candidate's own git config", async () => {
    const r = repoWithBase(undefined);
    mkdirSync(join(r.root, ".rovara/mocks/model"), { recursive: true });
    symlinkSync("/etc/passwd", join(r.root, modelReplyFilePath(FAMILY)));
    git(r.root, "add", "-A");
    git(r.root, "commit", "--quiet", "-m", "link");
    const linked = git(r.root, "rev-parse", "HEAD");
    const read = (commitSha: string, root = r.root) => readFileAtCommit({ repositoryRoot: root, commitSha, path: modelReplyFilePath(FAMILY), scratchRoot: r.scratch, maxBytes: 1_000_000, signal });
    expect(await read(linked)).toEqual({ kind: "unreadable" });
    expect(await read("nothex")).toEqual({ kind: "unreadable" });
    expect(await read("1".repeat(40))).toEqual({ kind: "unreadable" });
    expect(await read(r.base, tmp())).toEqual({ kind: "unreadable" });
    expect(await read(r.base)).toEqual({ kind: "absent" });
    // a hostile config in the candidate's repository (a core.fsmonitor or an alias) is never read
    const marker = join(tmp(), "ran");
    git(r.root, "config", "core.fsmonitor", `touch ${marker}`);
    await read(r.base);
    expect(() => execFileSync("test", ["-e", marker])).toThrow();
  });
  it("a base reply the candidate deleted is restored from the base as before_task, in BASE order, and an edit takes its base reply's place", async () => {
    const r = repoWithBase(file([{ id: "one", response: { text: "1", finish: "stop" } }, { id: "two", response: { text: "2", finish: "stop" } }, { id: "three", response: { text: "3", finish: "stop" } }]));
    write(r.root, file([{ id: "three", response: { text: "3", finish: "stop" } }, { id: "two", response: { text: "2 rigged", finish: "stop" } }, { id: "new" }]));
    const set = (await loadModelReplySets(sourceOf(r), signal)).sets[0];
    expect(set?.replies.map((reply) => [reply.id, reply.provenance])).toEqual([["one", "before_task"], ["two", "task_made"], ["three", "before_task"], ["new", "task_made"]]);
  });
  it("independent is reachable only through Rovara's constructor: a plain object from the seam is task_made, and nothing in a file can say it", async () => {
    const r = repoWithBase(file([{ id: "a" }]));
    const entry = parseModelReplySetFileBytes(new TextEncoder().encode(file([{ id: "ind" }]))) as { ok: true; set: { replies: ModelReplyFileEntry[] } };
    const reply = entry.set.replies[0] as ModelReplyFileEntry;
    const sound = { read: () => Promise.resolve({ replies: [reply], decisions: new Map([["ind", createRovaraIndependentDecision(modelReplyEntrySha256(reply))]]) }) };
    const forged = { read: () => Promise.resolve({ replies: [reply], decisions: new Map([["ind", { provenance: "independent", contentSha256: modelReplyEntrySha256(reply) } as never]]) }) };
    const withSeam = async (independent: typeof sound) => (await loadModelReplySets(sourceOf(r), signal, { independent })).sets[0]?.replies.find((item) => item.id === "ind")?.provenance;
    expect(await withSeam(sound)).toBe("independent");
    expect(await withSeam(forged)).toBe("task_made");
    expect(modelReplyEntrySha256(reply)).toMatch(/^[0-9a-f]{64}$/u);
  });
  // H1 and the chain: EVERY object on the way (the commit, the root tree, each subtree, the blob) must hash to its id. A swapped object of any level, loose or packed, makes the file unreadable: the agent's replies are task_made.
  const forged = file([{ id: "a", response: { text: "FORGED", finish: "stop" } }]);
  const objectOf = (type: string, body: Buffer): Buffer => Buffer.concat([Buffer.from(`${type} ${String(body.length)}\0`), body]);
  const treeEntry = (mode: string, name: string, id: string): Buffer => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(id, "hex")]);
  const mktree = (root: string, line: string): string => execFileSync("git", ["mktree"], { cwd: root, env: GIT_ENV, input: line, encoding: "utf8" }).trim();
  const hashObject = (root: string, text: string): string => execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, env: GIT_ENV, input: text, encoding: "utf8" }).trim();
  /** Puts `body` in the object store under `id` (valid zlib, valid header, WRONG hash): as a loose object, or as the only object of a pack named for it (the real loose object is removed). */
  function forgeObject(root: string, id: string, type: "commit" | "tree" | "blob", body: Buffer, how: "loose" | "packed"): void {
    const loose = join(root, ".git/objects", id.slice(0, 2), id.slice(2));
    rmSync(loose, { force: true });
    if (how === "loose") {
      mkdirSync(join(root, ".git/objects", id.slice(0, 2)), { recursive: true });
      writeFileSync(loose, deflateSync(objectOf(type, body)), { mode: 0o444 });
      return;
    }
    const packDir = join(root, ".git/objects/pack");
    mkdirSync(packDir, { recursive: true });
    const code = { commit: 1, tree: 2, blob: 3 }[type];
    const head: number[] = [(code << 4) | (body.length & 15)];
    let rest = body.length >> 4;
    while (rest > 0) { head[head.length - 1] = (head.at(-1) as number) | 0x80; head.push(rest & 0x7f); rest >>= 7; }
    const packHead = Buffer.alloc(12);
    packHead.write("PACK", 0);
    packHead.writeUInt32BE(2, 4);
    packHead.writeUInt32BE(1, 8);
    const packNoSum = Buffer.concat([packHead, Buffer.from(head), deflateSync(body)]);
    const packSum = createHash("sha1").update(packNoSum).digest();
    const fan = Buffer.alloc(256 * 4);
    for (let i = Number.parseInt(id.slice(0, 2), 16); i < 256; i += 1) fan.writeUInt32BE(1, i * 4);
    const idxBody = Buffer.concat([Buffer.from([0xff, 0x74, 0x4f, 0x63, 0, 0, 0, 2]), fan, Buffer.from(id, "hex"), Buffer.alloc(4), Buffer.from([0, 0, 0, 12]), packSum]);
    writeFileSync(join(packDir, `pack-forged-${id.slice(0, 8)}.pack`), Buffer.concat([packNoSum, packSum]));
    writeFileSync(join(packDir, `pack-forged-${id.slice(0, 8)}.idx`), Buffer.concat([idxBody, createHash("sha1").update(idxBody).digest()]));
  }
  const LEVELS = ["blob", "tree (.rovara/mocks/model)", "tree (.rovara/mocks)", "tree (.rovara)", "root tree", "commit"] as const;
  for (const how of ["loose", "packed"] as const) {
    for (const level of LEVELS) {
      it(`a swapped ${how} ${level} under its id is refused: the agent's identical replies are task_made, never before_task`, async () => {
        const r = repoWithBase(file([{ id: "a", response: { text: "original", finish: "stop" } }]));
        const id = (path: string): string => git(r.root, "rev-parse", `HEAD:${path}`);
        const attackerBlob = hashObject(r.root, forged);
        const modelTree = mktree(r.root, `100644 blob ${attackerBlob}\topenai_compatible.json\n`);
        const mocksTree = mktree(r.root, `040000 tree ${modelTree}\tmodel\n`);
        const rovaraTree = mktree(r.root, `040000 tree ${mocksTree}\tmocks\n`);
        const rootTree = mktree(r.root, `040000 tree ${rovaraTree}\t.rovara\n`);
        // the working tree carries the same forged reply: only a swapped base would make it before_task
        write(r.root, forged);
        const targets = {
          blob: () => forgeObject(r.root, id(modelReplyFilePath(FAMILY)), "blob", Buffer.from(forged), how),
          "tree (.rovara/mocks/model)": () => forgeObject(r.root, id(".rovara/mocks/model"), "tree", treeEntry("100644", "openai_compatible.json", attackerBlob), how),
          "tree (.rovara/mocks)": () => forgeObject(r.root, id(".rovara/mocks"), "tree", treeEntry("40000", "model", modelTree), how),
          "tree (.rovara)": () => forgeObject(r.root, id(".rovara"), "tree", treeEntry("40000", "mocks", mocksTree), how),
          "root tree": () => forgeObject(r.root, git(r.root, "rev-parse", "HEAD^{tree}"), "tree", treeEntry("40000", ".rovara", rovaraTree), how),
          commit: () => forgeObject(r.root, r.base, "commit", Buffer.from(`tree ${rootTree}\nauthor t <t@t.invalid> 0 +0000\ncommitter t <t@t.invalid> 0 +0000\n\nbase\n`), how),
        } as const;
        targets[level]();
        expect(await readFileAtCommit({ repositoryRoot: r.root, commitSha: r.base, path: modelReplyFilePath(FAMILY), scratchRoot: r.scratch, maxBytes: 1_000_000, signal })).toEqual({ kind: "unreadable" });
        expect(await counts(sourceOf(r))).toEqual({ before_task: 0, independent: 0, task_made: 1 });
      });
    }
  }
  it("an honest object still reads (the recomputed id matches)", async () => {
    const r = repoWithBase(file([{ id: "a" }]));
    expect((await sourceOf(r).readBase(FAMILY, signal)).kind).toBe("file");
  });
  it("a LINKED WORKTREE (.git is a file with gitdir) reads the base commit's objects from the main repository's store", async () => {
    const r = repoWithBase(file([{ id: "a", response: { text: "original", finish: "stop" } }]));
    const worktree = join(tmp(), "wt");
    git(r.root, "worktree", "add", "--quiet", "-b", "agent", worktree);
    write(worktree, file([{ id: "a", response: { text: "original", finish: "stop" } }, { id: "mine" }]));
    const source = createRepoReplySetSource({ repositoryRoot: worktree, baseCommit: r.base, workingRoot: worktree, scratchRoot: r.scratch });
    expect(await counts(source)).toEqual({ before_task: 1, independent: 0, task_made: 1 });
    // a .git file that points nowhere, or names a path with a NUL, is unreadable
    const bad = tmp();
    writeFileSync(join(bad, ".git"), "gitdir: /nonexistent/place\n");
    expect(await readFileAtCommit({ repositoryRoot: bad, commitSha: r.base, path: modelReplyFilePath(FAMILY), scratchRoot: r.scratch, maxBytes: 1000, signal })).toEqual({ kind: "unreadable" });
  });
  it("L5: a file swapped for another (or for a symlink) between the check and the open is refused", async () => {
    const root = tmp();
    mkdirSync(join(root, ".rovara/mocks/model"), { recursive: true });
    const target = join(root, modelReplyFilePath(FAMILY));
    writeFileSync(target, file([{ id: "a" }]));
    const other = join(root, "other.json");
    // a different file (a different inode) takes the path after lstat
    const swapped = await readFileInWorkingTree(root, modelReplyFilePath(FAMILY), 1_000_000, { beforeOpen: () => { rmSync(target); writeFileSync(other, file([{ id: "b" }])); renameSync(other, target); } });
    expect(swapped).toEqual({ kind: "unreadable" });
    // a symlink takes the path after lstat: O_NOFOLLOW refuses it
    writeFileSync(target, file([{ id: "a" }]));
    const linked = await readFileInWorkingTree(root, modelReplyFilePath(FAMILY), 1_000_000, { beforeOpen: () => { rmSync(target); symlinkSync(other, target); } });
    expect(linked).toEqual({ kind: "unreadable" });
    rmSync(target);
    writeFileSync(target, file([{ id: "a" }]));
    expect((await readFileInWorkingTree(root, modelReplyFilePath(FAMILY), 1_000_000)).kind).toBe("file");
  });
});
