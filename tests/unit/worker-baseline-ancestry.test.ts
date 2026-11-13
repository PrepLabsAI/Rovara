// TE-C1, the worker's half: at the start of its checks round the worker checks the engine's candidate commits against the task's base commit, in the isolated git environment (a throwaway repository that sees the
// candidate's objects and nothing else: no refs, no replace refs, no shallow file, no inherited GIT_* settings), and keeps the nearest ancestor within 50 commits. Real temporary repositories, real git.
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_ENV_BASELINE_FEATURE, WORKER_INVOCATION_FEATURES } from "../../packages/contracts/src/index.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import { findBaselineAncestor } from "../../packages/worker/src/verification/baseline-ancestry.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const clean = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
const git = async (directory: string, ...args: string[]): Promise<string> => (await execFile("git", ["-C", directory, ...args], { encoding: "utf8", env: { ...clean(), GIT_CONFIG_NOSYSTEM: "1", HOME: directory } })).stdout.trim();
async function repository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentx-baseline-"));
  roots.push(directory);
  await git(directory, "init", "--quiet", "-b", "main");
  await git(directory, "config", "user.email", "agentx@example.invalid");
  await git(directory, "config", "user.name", "AgentX Test");
  await git(directory, "config", "commit.gpgsign", "false");
  return directory;
}
let counter = 0;
const commit = async (directory: string, message = "c", file = "file.txt"): Promise<string> => {
  counter += 1;
  await writeFile(join(directory, file), `${message} ${String(counter)}\n`);
  await git(directory, "add", "-A");
  await git(directory, "commit", "--quiet", "-m", `${message} ${String(counter)}`);
  return git(directory, "rev-parse", "HEAD");
};
/** A line of `count` commits; returns them oldest first. */
async function line(directory: string, count: number, file = "file.txt"): Promise<string[]> {
  const shas: string[] = [];
  for (let n = 0; n < count; n += 1) shas.push(await commit(directory, "c", file));
  return shas;
}
const ask = (directory: string, base: string | undefined, candidates: string[]) => findBaselineAncestor({ directory, baseCommit: base, candidates: candidates.map((sha) => ({ sha })) });

describe("the nearest trusted ancestor of the task's base", () => {
  it("is a feature this worker lists and the contract knows", () => {
    expect(WORKER_INVOCATION_FEATURES).toContain(TEST_ENV_BASELINE_FEATURE);
    expect(WORKER_IMPLEMENTED_FEATURES).toContain(TEST_ENV_BASELINE_FEATURE);
  });

  it("finds the base itself (0 back), the parent (1), and exactly 50 back; 51 back is a miss", async () => {
    const directory = await repository();
    const shas = await line(directory, 60);
    const base = shas[59]!;
    expect(await ask(directory, base, [base])).toEqual({ sha: base, commitsBack: 0 });
    expect(await ask(directory, base, [shas[58]!])).toEqual({ sha: shas[58], commitsBack: 1 });
    expect(await ask(directory, base, [shas[9]!])).toEqual({ sha: shas[9], commitsBack: 50 });
    expect(await ask(directory, base, [shas[8]!])).toBeUndefined();
    expect(await ask(directory, base, [shas[0]!])).toBeUndefined();
  }, 60_000);

  it("keeps the nearest of several, in whatever order they are given", async () => {
    const directory = await repository();
    const shas = await line(directory, 12);
    const base = shas[11]!;
    expect(await ask(directory, base, [shas[2]!, shas[8]!, shas[5]!])).toEqual({ sha: shas[8], commitsBack: 3 });
    expect(await ask(directory, base, [shas[8]!, shas[5]!, shas[2]!])).toEqual({ sha: shas[8], commitsBack: 3 });
  });

  it("through a merge commit, counts the commits on the base's own line, and a commit only on the merged side is not counted", async () => {
    const directory = await repository();
    const [root] = await line(directory, 1);
    await git(directory, "checkout", "--quiet", "-b", "feature");
    const side = await line(directory, 2, "side.txt");
    await git(directory, "checkout", "--quiet", "main");
    const mainLine = await line(directory, 3);
    await git(directory, "merge", "--quiet", "--no-ff", "-m", "merge feature", "feature");
    const merged = await git(directory, "rev-parse", "HEAD");
    const after = await commit(directory);
    expect(await ask(directory, after, [merged])).toEqual({ sha: merged, commitsBack: 1 });
    expect(await ask(directory, after, [mainLine[0]!])).toEqual({ sha: mainLine[0], commitsBack: 4 });
    // First-parent only, consistently: a commit that is only on the merged side is not "on the base's line".
    expect(await ask(directory, after, [side[1]!])).toBeUndefined();
    expect(await ask(directory, after, [root!])).toEqual({ sha: root, commitsBack: 5 });
  });

  it("a force-pushed or rewritten base: a candidate that is not an ancestor, or not here at all, is a miss, never a match", async () => {
    const directory = await repository();
    const shas = await line(directory, 6);
    await git(directory, "checkout", "--quiet", "-b", "old", shas[3]!);
    const orphan = await commit(directory, "rewritten");
    await git(directory, "checkout", "--quiet", "main");
    expect(await ask(directory, shas[5], [orphan])).toBeUndefined();
    expect(await ask(directory, shas[5], [orphan, "f".repeat(40)])).toBeUndefined();
    expect(await ask(directory, shas[5], [orphan, shas[4]!])).toEqual({ sha: shas[4], commitsBack: 1 });
    // A sha that names a tree or a blob is not a commit.
    expect(await ask(directory, shas[5], [await git(directory, "rev-parse", "HEAD^{tree}")])).toBeUndefined();
  });

  it("a shallow clone that lacks the candidate is a miss, and one that holds it is a match", async () => {
    const source = await repository();
    const shas = await line(source, 5);
    const target = await mkdtemp(join(tmpdir(), "agentx-baseline-shallow-"));
    roots.push(target);
    await execFile("git", ["clone", "--quiet", "--depth", "1", `file://${source}`, join(target, "clone")], { env: clean() });
    const clone = join(target, "clone");
    expect(await ask(clone, shas[4], [shas[2]!])).toBeUndefined();
    expect(await ask(clone, shas[4], [shas[4]!, shas[2]!])).toEqual({ sha: shas[4], commitsBack: 0 });
  });

  it("answers only from the objects: refs rewritten, a replace ref, a shallow file or grafts the agent left change nothing (control: plain git is fooled by them)", async () => {
    const directory = await repository();
    const shas = await line(directory, 8);
    const base = shas[7]!;
    await git(directory, "checkout", "--quiet", "-b", "side", shas[1]!);
    const stranger = await commit(directory, "stranger");
    await git(directory, "checkout", "--quiet", "main");
    const truth = await ask(directory, base, [stranger, shas[4]!]);
    expect(truth).toEqual({ sha: shas[4], commitsBack: 3 });
    // Control: the attack works on plain git on the repository's own .git (a replace ref makes the stranger an ancestor; a shallow file hides a real ancestor).
    const plain = async (candidate: string): Promise<boolean> => execFile("git", ["-C", directory, "merge-base", "--is-ancestor", candidate, base], { env: { ...clean(), HOME: directory } }).then(() => true, () => false);
    expect(await plain(stranger)).toBe(false);
    expect(await plain(shas[4]!)).toBe(true);
    const fake = await git(directory, "commit-tree", "-p", stranger, "-p", shas[6]!, "-m", "fake", `${base}^{tree}`);
    await git(directory, "replace", base, fake);
    await mkdir(join(directory, ".git", "info"), { recursive: true });
    await writeFile(join(directory, ".git", "shallow"), `${shas[6]!}\n`);
    await git(directory, "update-ref", "refs/heads/main", shas[0]!);
    await git(directory, "update-ref", "refs/remotes/origin/main", stranger);
    await writeFile(join(directory, ".git", "packed-refs"), `${stranger} refs/heads/main\n`);
    await writeFile(join(directory, ".git", "info", "grafts"), `${base} ${stranger}\n`);
    expect(await plain(stranger)).toBe(true);
    expect(await plain(shas[4]!)).toBe(false);
    // The worker's answer is the one from the objects.
    expect(await ask(directory, base, [stranger, shas[4]!])).toEqual(truth);
  });

  it("is not changed by GIT_* variables the worker's own environment carries", async () => {
    const directory = await repository();
    const shas = await line(directory, 5);
    const decoy = await repository();
    await line(decoy, 2);
    const before = await ask(directory, shas[4], [shas[2]!]);
    expect(before).toEqual({ sha: shas[2], commitsBack: 2 });
    const names = ["GIT_DIR", "GIT_WORK_TREE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_SHALLOW_FILE", "GIT_GRAFT_FILE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_CEILING_DIRECTORIES"];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      process.env["GIT_DIR"] = join(decoy, ".git");
      process.env["GIT_WORK_TREE"] = decoy;
      process.env["GIT_OBJECT_DIRECTORY"] = join(decoy, ".git", "objects");
      process.env["GIT_ALTERNATE_OBJECT_DIRECTORIES"] = join(decoy, ".git", "objects");
      process.env["GIT_NO_REPLACE_OBJECTS"] = "0";
      process.env["GIT_REPLACE_REF_BASE"] = "refs/nothing/";
      process.env["GIT_SHALLOW_FILE"] = join(decoy, "no-such-shallow");
      process.env["GIT_GRAFT_FILE"] = join(decoy, "no-such-grafts");
      process.env["GIT_COMMON_DIR"] = join(decoy, ".git");
      process.env["GIT_INDEX_FILE"] = join(decoy, "no-such-index");
      process.env["GIT_CEILING_DIRECTORIES"] = tmpdir();
      expect(await ask(directory, shas[4], [shas[2]!])).toEqual(before);
    } finally {
      for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    }
  });

  it("refuses what is not a commit sha, takes at most five candidates, and never throws", async () => {
    const directory = await repository();
    const shas = await line(directory, 3);
    expect(await ask(directory, undefined, [shas[1]!])).toBeUndefined();
    expect(await ask(directory, "main", [shas[1]!])).toBeUndefined();
    expect(await ask(directory, shas[2], [])).toBeUndefined();
    expect(await findBaselineAncestor({ directory, baseCommit: shas[2]!, candidates: undefined })).toBeUndefined();
    expect(await ask(directory, shas[2], ["HEAD", "main", "--all", "-1", shas[1]!.toUpperCase(), shas[1]!.slice(0, 12)])).toBeUndefined();
    expect(await ask(join(directory, "missing"), shas[2], [shas[1]!])).toBeUndefined();
    // Only the first five are looked at: the sixth is not even asked about.
    expect(await ask(directory, shas[2], ["a".repeat(40), "b".repeat(40), "c".repeat(40), "d".repeat(40), "e".repeat(40), shas[1]!])).toBeUndefined();
    expect(await ask(directory, shas[2], [shas[1]!, shas[1]!, shas[0]!])).toEqual({ sha: shas[1], commitsBack: 1 });
  });
});

// The agent owns .git/objects from the coding step on. Git does not re-hash a commit's parents while it walks, so an object the agent rewrote can make `merge-base --is-ancestor` say yes.
// The worker therefore reads every commit on the base's first-parent line itself and re-hashes it: a commit whose bytes do not hash to its own name ends the answer (a miss).
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const forgedBody = (parent: string, message: string): string => `tree ${EMPTY_TREE}\nparent ${parent}\nauthor a <a@b> 1 +0000\ncommitter a <a@b> 1 +0000\n\n${message}\n`;

describe("an object store the agent rewrote", () => {
  it("a genuine line is still vouched for commit by commit (control for the refusals below)", async () => {
    const directory = await repository();
    const shas = await line(directory, 4);
    expect(await ask(directory, shas[3], [shas[0]!])).toEqual({ sha: shas[0], commitsBack: 3 });
  });

  /** X, Y on main; an orphan line P, B. Then the loose object of P is overwritten with a commit that names X as its parent. */
  async function forgedLoose(): Promise<{ directory: string; x: string; b: string }> {
    const directory = await repository();
    await git(directory, "commit", "-q", "--allow-empty", "-m", "X");
    const x = await git(directory, "rev-parse", "HEAD");
    await git(directory, "commit", "-q", "--allow-empty", "-m", "Y");
    await git(directory, "checkout", "-q", "--orphan", "other");
    await git(directory, "commit", "-q", "--allow-empty", "-m", "P");
    const p = await git(directory, "rev-parse", "HEAD");
    await git(directory, "commit", "-q", "--allow-empty", "-m", "B");
    const b = await git(directory, "rev-parse", "HEAD");
    const loose = join(directory, ".git", "objects", p.slice(0, 2), p.slice(2));
    await chmod(loose, 0o644);
    const body = forgedBody(x, "P");
    await writeFile(loose, deflateSync(Buffer.concat([Buffer.from(`commit ${String(Buffer.byteLength(body))}\0`), Buffer.from(body)])));
    return { directory, x, b };
  }

  it("a loose commit rewritten to claim a parent is refused (control: plain git answers yes)", async () => {
    const { directory, x, b } = await forgedLoose();
    const plain = await execFile("git", ["-C", directory, "merge-base", "--is-ancestor", x, b], { env: { ...clean(), HOME: directory } }).then(() => true, () => false);
    expect(plain).toBe(true);
    expect(await ask(directory, b, [x])).toBeUndefined();
    expect(await ask(directory, b, [b])).toEqual({ sha: b, commitsBack: 0 });
  });

  const gitInput = (directory: string, input: string, ...args: string[]): string => {
    const run = spawnSync("git", ["-C", directory, ...args], { input, encoding: "utf8", env: { ...clean(), GIT_CONFIG_NOSYSTEM: "1", HOME: directory } });
    if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr}`);
    return run.stdout.trim();
  };

  /** X, Y on main; an orphan B, packed. A second, newer pack holds a hand-made commit (tree empty, parent X) whose index entry is relabelled with B's name. */
  async function forgedPack(): Promise<{ directory: string; x: string; b: string }> {
    const directory = await repository();
    await git(directory, "commit", "-q", "--allow-empty", "-m", "X");
    const x = await git(directory, "rev-parse", "HEAD");
    await git(directory, "commit", "-q", "--allow-empty", "-m", "Y");
    await git(directory, "checkout", "-q", "--orphan", "other");
    await git(directory, "commit", "-q", "--allow-empty", "-m", "B");
    const b = await git(directory, "rev-parse", "HEAD");
    await git(directory, "gc", "-q");
    const side = await repository();
    const f = gitInput(side, forgedBody(x, "B"), "hash-object", "-t", "commit", "-w", "--stdin");
    gitInput(side, `${f}\n`, "pack-objects", "-q", join(side, "forged"));
    const packName = (await readdir(side)).find((name) => /^forged-.*\.pack$/u.test(name))!;
    const pack = join(side, packName);
    const index = pack.replace(/\.pack$/u, ".idx");
    const data = Buffer.from(await readFile(index));
    // Version 2 index with one object: fanout from byte 8, then the object name at 8 + 1024. Relabel F as B.
    expect(data.subarray(0, 4).toString("hex")).toBe("ff744f63");
    const bytes = Buffer.from(b, "hex");
    for (let i = 0; i < 256; i += 1) data.writeUInt32BE(i < bytes[0]! ? 0 : 1, 8 + i * 4);
    expect(data.subarray(8 + 1024, 8 + 1024 + 20).toString("hex")).toBe(f);
    bytes.copy(data, 8 + 1024);
    const target = join(directory, ".git", "objects", "pack");
    await writeFile(join(target, packName), await readFile(pack));
    await writeFile(join(target, packName.replace(/\.pack$/u, ".idx")), data);
    // Newer than the real pack, so git prefers it.
    const later = new Date(Date.now() + 60_000);
    await utimes(join(target, packName), later, later);
    return { directory, x, b };
  }

  it("a newer hand-made pack that relabels a forged commit as the base is refused, whether the candidate is its claimed parent or the base itself", async () => {
    const { directory, x, b } = await forgedPack();
    // Control: git reads the forged commit under the base's name (it names X as the parent of the base).
    expect(await git(directory, "cat-file", "-p", b)).toContain(`parent ${x}`);
    expect(await ask(directory, b, [x])).toBeUndefined();
    // The base itself is not vouched for either (its bytes do not hash to its name).
    expect(await ask(directory, b, [b])).toBeUndefined();
    // Positive control: with the forged pack removed the same repository vouches for its own base.
    const packs = join(directory, ".git", "objects", "pack");
    for (const name of await readdir(packs)) if (name.startsWith("forged-")) await rm(join(packs, name), { force: true });
    expect(await ask(directory, b, [b])).toEqual({ sha: b, commitsBack: 0 });
  });
});
