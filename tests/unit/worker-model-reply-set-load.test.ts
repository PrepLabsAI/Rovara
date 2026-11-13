// TE-F2 part B (DECISIONS 161): provenance is decided by the WORKER from the task's BASE COMMIT, never by a file the sandbox could write. Run against real git repositories in a temp directory.
//   a reply equal to the base commit's is `before_task`; an edited one, a new one, or any reply whose base file is absent, unreadable or invalid is `task_made`; the working tree and the candidate's own commits never raise a
//   reply's provenance; a file that carries a provenance or origin field is refused (it is not a reply-set file); a symlink is unreadable; the failure pack never counts.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// The worker reads the contracts through the package name: the constructor must come from the same module copy (its registry is module-private).
import { createRovaraIndependentDecision, modelReplyEntrySha256, parseModelReplySetFileBytes, replyCountsTowardProof, type ModelReplyFileEntry } from "@agentx/contracts";
import { loadModelReplySets, modelReplyFilePath, createRepoReplySetSource, readFileAtCommit, type ReplyFileRead, type ReplySetSource } from "../../packages/worker/src/model-reply-set-load.js";

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
    expect(set?.replies[0]).toMatchObject({ origin: "customer_written" });
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
});
