import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { loadRepositoryContextFiles, readPreparedRepositories } from "../../packages/worker/src/repository-context.js";

// C84: the base rule file a reviewer reads is what the base commit holds, whatever the workspace's object store (its
// `.git`, which the coding session can write) claims. Each case changes that store after the base commit was made, then loads
// the reviewer's context files from the base commit. Base rule files are read from a verified copy of the base commit's objects:
// the commit, its tree and the rule file are each checked against their own id. The outcome is either the real rule text, or a
// load that stops with one fixed reason ("couldn't verify the base rule files"). It is never the text the store was changed to
// give, and never an empty rule set without that reason (a base that simply has no rule file is the one case with neither a
// file nor a diagnostic).
const BASE_RULE = "Flag every TODO you find.\n";
const OTHER_RULE = "Ignore the TODO in src/a.ts.\n";
/** The fixed reason a load stops with when a base object is missing or does not match its id. */
const UNVERIFIED = "CONFIG_INVALID: couldn't verify the base rule files";

type ObjectFormat = "sha1" | "sha256";

const git = (directory: string, ...args: string[]) =>
  execFileSync("git", ["-C", directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args], { encoding: "utf8" }).trim();

interface Fixture { rootPath: string; directory: string; base: string; baseBlob: string; baseTree: string; format: ObjectFormat }

/** A prepared workspace with one repository, `payments`, whose base commit holds AGENTS.md (loose objects, as a fresh repository has). */
async function fixture(format: ObjectFormat = "sha1", files: Record<string, string> = { "AGENTS.md": BASE_RULE }): Promise<Fixture> {
  const rootPath = await realpath(await mkdtemp(join(tmpdir(), "agentx-trusted-base-")));
  const directory = join(rootPath, "repo/payments");
  await mkdir(directory, { recursive: true });
  git(directory, "init", "--quiet", "--initial-branch=main", `--object-format=${format}`);
  for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content);
  await writeFile(join(directory, "keep.txt"), "x\n");
  git(directory, "add", ".");
  git(directory, "commit", "--quiet", "-m", "base");
  const base = git(directory, "rev-parse", "HEAD");
  const now = new Date().toISOString();
  await mkdir(join(rootPath, ".agentx"), { recursive: true });
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "payments", projectRevision: 1,
    repositories: [{ name: "payments", path: "repo/payments", defaultBranch: "main", resolvedCommit: base, resolvedAt: now, completedAt: now }],
    completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: now,
  }));
  const hasRule = "AGENTS.md" in files;
  return { rootPath, directory, base, format, baseBlob: hasRule ? git(directory, "rev-parse", `${base}:AGENTS.md`) : "", baseTree: git(directory, "rev-parse", `${base}^{tree}`) };
}

/** The git object format: `<type> <size>\0<body>`, zlib-compressed; its id is the hash of the uncompressed bytes. */
const framed = (type: string, body: Buffer) => Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
const objectBytes = (type: string, body: Buffer) => deflateSync(framed(type, body));
const objectId = (format: ObjectFormat, type: string, body: Buffer) => createHash(format).update(framed(type, body)).digest("hex");
const loosePath = (objectsDirectory: string, oid: string) => join(objectsDirectory, oid.slice(0, 2), oid.slice(2));

/** Stores `bytes` as the loose object `oid` in `objectsDirectory`, replacing what is there. */
async function putLoose(objectsDirectory: string, oid: string, bytes: Buffer): Promise<void> {
  const path = loosePath(objectsDirectory, oid);
  await mkdir(dirname(path), { recursive: true });
  await rm(path, { force: true });
  await writeFile(path, bytes, { mode: 0o444 });
}

/** The checksum a zlib stream ends with. */
function adler32(bytes: Buffer): number {
  let low = 1;
  let high = 0;
  for (const byte of bytes) { low = (low + byte) % 65521; high = (high + low) % 65521; }
  return ((high << 16) | low) >>> 0;
}

const objectsOf = (subject: Fixture) => join(subject.directory, ".git/objects");
const entry = (mode: string, name: string, oid: string) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, "hex")]);

/** Stores the other rule text as a blob and a tree that names it as AGENTS.md (with the repository's keep.txt); returns the tree's id. */
async function putOtherTree(subject: Fixture): Promise<string> {
  const body = Buffer.from(OTHER_RULE);
  const blob = objectId(subject.format, "blob", body);
  await putLoose(objectsOf(subject), blob, objectBytes("blob", body));
  const keepBlob = git(subject.directory, "rev-parse", "HEAD:keep.txt");
  const tree = Buffer.concat([entry("100644", "AGENTS.md", blob), entry("100644", "keep.txt", keepBlob)]);
  const treeId = objectId(subject.format, "tree", tree);
  await putLoose(objectsOf(subject), treeId, objectBytes("tree", tree));
  return treeId;
}

/** What the reviewer is given for the repository: the context files and the diagnostics. */
async function reviewerView({ rootPath, base }: Fixture, baseCommit: string = base) {
  const repositories = (await readPreparedRepositories(rootPath)).map((repository) => ({ ...repository, baseCommit }));
  const { files, diagnostics } = await loadRepositoryContextFiles(rootPath, repositories, { at: "base-commit" });
  return { files, diagnostics, everything: [...files.map(({ content }) => content), ...diagnostics].join("\n---\n") };
}

/** The real rule text, with no diagnostic. */
async function expectRealRule(subject: Fixture): Promise<void> {
  const { files, diagnostics, everything } = await reviewerView(subject);
  expect(everything).not.toContain("Ignore the TODO");
  expect(diagnostics).toEqual([]);
  expect(files).toHaveLength(1);
  expect(files[0]!.content).toContain("Flag every TODO");
}

/** The load stops with the fixed reason, which carries nothing but itself (no path, id or text from the store). */
async function expectUnverified(subject: Fixture, baseCommit: string = subject.base): Promise<void> {
  const error = await reviewerView(subject, baseCommit).then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(UNVERIFIED);
}

describe("the base rule file does not depend on the workspace's object store (C84)", () => {
  it("control: an unchanged repository gives the base commit's rule file", async () => {
    const { files, diagnostics } = await reviewerView(await fixture());
    expect(diagnostics).toEqual([]);
    expect(files).toHaveLength(1);
    expect(files[0]!.content).toContain("Flag every TODO");
  });

  it("control: a base commit with no rule file gives no file and no diagnostic", async () => {
    const { files, diagnostics } = await reviewerView(await fixture("sha1", {}));
    expect(files).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("control: an unchanged repository that uses 64-character object ids gives the base commit's rule file", async () => {
    const subject = await fixture("sha256");
    expect(subject.base).toHaveLength(64);
    const { files, diagnostics } = await reviewerView(subject);
    expect(diagnostics).toEqual([]);
    expect(files).toHaveLength(1);
    expect(files[0]!.content).toContain("Flag every TODO");
  });

  it("a different loose object stored under the base blob's id is not used for the rule file", async () => {
    const subject = await fixture();
    await putLoose(objectsOf(subject), subject.baseBlob, objectBytes("blob", Buffer.from(OTHER_RULE)));
    await expectUnverified(subject);
  });

  it("a different loose object stored under the base blob's id does not change the rule file (64-character object ids)", async () => {
    const subject = await fixture("sha256");
    await putLoose(objectsOf(subject), subject.baseBlob, objectBytes("blob", Buffer.from(OTHER_RULE)));
    await expectUnverified(subject);
  });

  it("a different loose tree stored under the base commit's tree id is not used for the rule file", async () => {
    const subject = await fixture();
    const other = await putOtherTree(subject);
    const body = execFileSync("git", ["-C", subject.directory, "cat-file", "tree", other]);
    await putLoose(objectsOf(subject), subject.baseTree, objectBytes("tree", body));
    await expectUnverified(subject);
  });

  it("a different loose commit stored under the base commit's id is not used for the rule file", async () => {
    const subject = await fixture();
    const other = await putOtherTree(subject);
    const body = Buffer.from(`tree ${other}\nauthor Fixture <fixture@example.test> 1700000000 +0000\ncommitter Fixture <fixture@example.test> 1700000000 +0000\n\nbase\n`);
    await putLoose(objectsOf(subject), subject.base, objectBytes("commit", body));
    await expectUnverified(subject);
  });

  it("a replace ref for the base blob is not used for the rule file", async () => {
    const subject = await fixture();
    const replacement = execFileSync("git", ["-C", subject.directory, "hash-object", "-w", "--stdin"], { input: OTHER_RULE, encoding: "utf8" }).trim();
    git(subject.directory, "replace", subject.baseBlob, replacement);
    await expectRealRule(subject);
  });

  it("a replace ref for the base commit is not used for the rule file", async () => {
    const subject = await fixture();
    const tree = await putOtherTree(subject);
    git(subject.directory, "replace", subject.base, git(subject.directory, "commit-tree", tree, "-m", "other"));
    await expectRealRule(subject);
  });

  it("an alternate object directory listed in the workspace's store is not used for the rule file", async () => {
    const subject = await fixture();
    const alternate = await realpath(await mkdtemp(join(tmpdir(), "agentx-trusted-alt-")));
    await putLoose(alternate, subject.baseBlob, objectBytes("blob", Buffer.from(OTHER_RULE)));
    // The workspace's own copy of the blob is gone, so its alternate directories are consulted for that id.
    await rm(loosePath(objectsOf(subject), subject.baseBlob), { force: true });
    await mkdir(join(objectsOf(subject), "info"), { recursive: true });
    await writeFile(join(objectsOf(subject), "info/alternates"), `${alternate}\n`);
    await expectUnverified(subject);
  });

  it("a graft file in the workspace's store is not used for the rule file", async () => {
    const subject = await fixture();
    // Grafts only rewrite a commit's parents; the base commit's tree is what the rule file comes from.
    await mkdir(join(subject.directory, ".git/info"), { recursive: true });
    await writeFile(join(subject.directory, ".git/info/grafts"), `${subject.base}\n`);
    await expectRealRule(subject);
  });

  // Each of these stops the load with the fixed reason, which is not the same as a base that has no rule file (the control above).
  for (const [label, oid] of [["blob", (s: Fixture) => s.baseBlob], ["tree", (s: Fixture) => s.baseTree], ["commit", (s: Fixture) => s.base]] as const) {
    it(`a missing base ${label} stops the load with the fixed reason`, async () => {
      const subject = await fixture();
      await rm(loosePath(objectsOf(subject), oid(subject)), { force: true });
      await expectUnverified(subject);
    });
    it(`a missing base ${label} stops the load with the fixed reason (64-character object ids)`, async () => {
      const subject = await fixture("sha256");
      await rm(loosePath(objectsOf(subject), oid(subject)), { force: true });
      await expectUnverified(subject);
    });
    it(`a base ${label} whose stored bytes are not an object stops the load with the fixed reason`, async () => {
      const subject = await fixture();
      await putLoose(objectsOf(subject), oid(subject), Buffer.from("not a zlib stream"));
      await expectUnverified(subject);
    });
  }

  it("a different loose tree stored under the base commit's tree id is not used for the rule file (64-character object ids)", async () => {
    const subject = await fixture("sha256");
    const other = await putOtherTree(subject);
    const body = execFileSync("git", ["-C", subject.directory, "cat-file", "tree", other]);
    await putLoose(objectsOf(subject), subject.baseTree, objectBytes("tree", body));
    await expectUnverified(subject);
  });

  it("a different loose commit stored under the base commit's id is not used for the rule file (64-character object ids)", async () => {
    const subject = await fixture("sha256");
    const other = await putOtherTree(subject);
    const body = Buffer.from(`tree ${other}\nauthor Fixture <fixture@example.test> 1700000000 +0000\ncommitter Fixture <fixture@example.test> 1700000000 +0000\n\nbase\n`);
    await putLoose(objectsOf(subject), subject.base, objectBytes("commit", body));
    await expectUnverified(subject);
  });

  it("an alternate list that leads to another alternate is not followed, and the real object there is not used either", async () => {
    const subject = await fixture();
    const first = await realpath(await mkdtemp(join(tmpdir(), "agentx-trusted-alt-")));
    const second = await realpath(await mkdtemp(join(tmpdir(), "agentx-trusted-alt-")));
    await putLoose(second, subject.baseBlob, objectBytes("blob", Buffer.from(OTHER_RULE)));
    await mkdir(join(first, "info"), { recursive: true });
    await writeFile(join(first, "info/alternates"), `${second}\n`);
    await rm(loosePath(objectsOf(subject), subject.baseBlob), { force: true });
    await mkdir(join(objectsOf(subject), "info"), { recursive: true });
    await writeFile(join(objectsOf(subject), "info/alternates"), `${first}\n`);
    await expectUnverified(subject);
  });

  it("a stale commit-graph file in the workspace's store changes nothing", async () => {
    const subject = await fixture();
    await mkdir(join(objectsOf(subject), "info"), { recursive: true });
    await writeFile(join(objectsOf(subject), "info/commit-graph"), "CGPH not a real graph");
    await expectRealRule(subject);
  });

  it("control: objects packed by the workspace's own git are read from the pack", async () => {
    const subject = await fixture();
    git(subject.directory, "gc", "--quiet", "--prune=now");
    expect(execFileSync("git", ["-C", subject.directory, "count-objects", "-v"], { encoding: "utf8" })).toMatch(/^in-pack: [1-9]/mu);
    await expectRealRule(subject);
  });

  it("a different blob stored in a pack under the base blob's id does not change the rule file", async () => {
    const subject = await fixture();
    // Stored (uncompressed) pack entries keep the text readable in the pack, so a same-length edit with a matching zlib checksum is a well-formed object under the wrong id.
    git(subject.directory, "-c", "pack.compression=0", "repack", "-a", "-d", "--quiet");
    const packs = join(objectsOf(subject), "pack");
    let edited = 0;
    for (const name of readdirSync(packs).filter((entry) => entry.endsWith(".pack"))) {
      const path = join(packs, name);
      const bytes = readFileSync(path);
      const at = bytes.indexOf(BASE_RULE);
      if (at < 0) continue;
      const replacement = Buffer.from(BASE_RULE.replace("Flag", "Skip"));
      replacement.copy(bytes, at);
      bytes.writeUInt32BE(adler32(replacement), at + replacement.length);
      chmodSync(path, 0o644);
      writeFileSync(path, bytes);
      edited += 1;
    }
    expect(edited).toBe(1);
    // Positive control: the workspace's own git now hands out the edited text for the base blob, so the edit is a live one.
    expect(execFileSync("git", ["-C", subject.directory, "cat-file", "blob", subject.baseBlob], { encoding: "utf8" })).toContain("Skip every TODO");
    await expectUnverified(subject);
  });

  it("a base commit id that is not a hexadecimal id stops the load with the fixed reason", async () => {
    const subject = await fixture();
    await expectUnverified(subject, "not-a-commit");
    await expectUnverified(subject, subject.base.toUpperCase());
    await expectUnverified(subject, subject.base.slice(0, 39));
  });

  it("a base commit id of the wrong length for the repository's object format stops the load with the fixed reason", async () => {
    const subject = await fixture("sha256");
    // 40 hexadecimal characters name a SHA-1 object; none exists in a 64-character repository.
    await expectUnverified(subject, subject.base.slice(0, 40));
  });

  it("a base commit that is not in the repository stops the load with the fixed reason", async () => {
    const subject = await fixture();
    await expectUnverified(subject, "1".repeat(40));
  });

  it("a rule file that is a symbolic link in the base commit is skipped with a diagnostic, not loaded", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "agentx-trusted-link-")));
    const rootPath = directory;
    const repository = join(rootPath, "repo/payments");
    await mkdir(repository, { recursive: true });
    git(repository, "init", "--quiet", "--initial-branch=main");
    await writeFile(join(repository, "elsewhere.md"), BASE_RULE);
    execFileSync("ln", ["-s", "elsewhere.md", join(repository, "AGENTS.md")]);
    git(repository, "add", ".");
    git(repository, "commit", "--quiet", "-m", "base");
    const base = git(repository, "rev-parse", "HEAD");
    const { files, diagnostics } = await loadRepositoryContextFiles(rootPath, [{ name: "payments", path: "repo/payments", baseCommit: base }], { at: "base-commit" });
    expect(files).toEqual([]);
    expect(diagnostics.join("\n")).toContain("symbolic link");
  });

  it("a rule file over the size limit is skipped with a diagnostic that names its size", async () => {
    const subject = await fixture("sha1", { "AGENTS.md": "x".repeat(70_000) });
    const { files, diagnostics } = await reviewerView(subject);
    expect(files).toEqual([]);
    expect(diagnostics.join("\n")).toContain("70000 bytes exceeds");
  });

  it("an oversized rule file whose stored bytes were changed stops the load with the fixed reason", async () => {
    const subject = await fixture("sha1", { "AGENTS.md": "x".repeat(70_000) });
    await putLoose(objectsOf(subject), subject.baseBlob, objectBytes("blob", Buffer.from("y".repeat(70_000))));
    await expectUnverified(subject);
  });

  it("the candidate order is kept: AGENTS.override.md wins over AGENTS.md", async () => {
    const subject = await fixture("sha1", { "AGENTS.md": BASE_RULE, "AGENTS.override.md": "Override rule.\n" });
    const { files } = await reviewerView(subject);
    expect(files).toHaveLength(1);
    expect(files[0]!.content).toContain("Override rule.");
  });

  it("hidden characters are still removed from the verified rule file", async () => {
    const subject = await fixture("sha1", { "AGENTS.md": `${BASE_RULE}hidden\u200bword\n` });
    const { files, diagnostics } = await reviewerView(subject);
    expect(files[0]!.content).toContain("hiddenword");
    expect(files[0]!.content).not.toContain("\u200b");
    expect(diagnostics.join("\n")).toContain("removed 1 hidden characters");
  });

  it("the load leaves the workspace's git directory as it was", async () => {
    const subject = await fixture();
    const listing = () => execFileSync("find", [join(subject.directory, ".git"), "-type", "f", "-exec", "stat", "-f", "%N %z %m", "{}", "+"], { encoding: "utf8" }).split("\n").sort().join("\n");
    const before = listing();
    await expectRealRule(subject);
    expect(listing()).toBe(before);
  });

  it("the load removes the temporary repository it made", async () => {
    const subject = await fixture();
    const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith("agentx-base-rules-"));
    const before = leftovers();
    await expectRealRule(subject);
    await expectUnverified(await (async () => { const broken = await fixture(); await rm(loosePath(objectsOf(broken), broken.baseTree), { force: true }); return broken; })());
    expect(leftovers()).toEqual(before);
  });
});

// Nothing planted in the workspace's `.git` (hooks, config, includes) runs while the base rule files load. Each case plants a
// script that records its run in a marker directory, first shows with the repository's own git that the plant is live, then
// clears the markers and loads the reviewer's context files.
describe("loading the base rule file runs nothing from the workspace's git directory (C84)", () => {
  async function plantArea(subject: Fixture) {
    const area = await realpath(await mkdtemp(join(tmpdir(), "agentx-planted-")));
    const markers = join(area, "markers");
    await mkdir(markers);
    const script = async (name: string) => {
      const path = join(area, `${name}.sh`);
      await writeFile(path, `#!/bin/sh\ntouch '${markers}/${name}'\nexit 0\n`);
      await chmod(path, 0o755);
      return path;
    };
    const ran = () => readdir(markers);
    const clear = async () => { for (const name of await ran()) await rm(join(markers, name)); };
    return { area, script, ran, clear, config: (...args: string[]) => git(subject.directory, "config", ...args) };
  }

  /** The plant is live (the repository's own git runs it), and the reviewer's load then runs nothing and still reads the real rule file. */
  async function expectNotRun(subject: Fixture, plant: Awaited<ReturnType<typeof plantArea>>, live: () => void | Array<() => void>, expected: string[]): Promise<void> {
    // The plant may make a command fail; only the markers matter.
    const commands = live();
    for (const command of Array.isArray(commands) ? commands : []) { try { command(); } catch { /* see above */ } }
    expect((await plant.ran()).sort()).toEqual(expect.arrayContaining(expected));
    await plant.clear();
    await expectRealRule(subject);
    expect(await plant.ran()).toEqual([]);
  }

  it("a hook in the workspace's hooks directory", async () => {
    const subject = await fixture();
    const plant = await plantArea(subject);
    for (const hook of ["post-checkout", "post-commit", "post-merge", "reference-transaction", "post-rewrite"]) {
      const path = join(subject.directory, ".git/hooks", hook);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `#!/bin/sh\ntouch '${join(plant.area, "markers", hook)}'\n`);
      await chmod(path, 0o755);
    }
    await expectNotRun(subject, plant, () => [() => git(subject.directory, "commit", "--allow-empty", "-m", "live")], ["post-commit"]);
  });

  it("a hooks path set in the workspace's config", async () => {
    const subject = await fixture();
    const plant = await plantArea(subject);
    const hooks = join(plant.area, "hooks");
    await mkdir(hooks);
    await writeFile(join(hooks, "post-commit"), `#!/bin/sh\ntouch '${join(plant.area, "markers", "post-commit")}'\n`);
    await chmod(join(hooks, "post-commit"), 0o755);
    plant.config("core.hooksPath", hooks);
    await expectNotRun(subject, plant, () => [() => git(subject.directory, "commit", "--allow-empty", "-m", "live")], ["post-commit"]);
  });

  it("a file system monitor set in the workspace's config", async () => {
    const subject = await fixture();
    const plant = await plantArea(subject);
    plant.config("core.fsmonitor", await plant.script("monitor"));
    await expectNotRun(subject, plant, () => [() => git(subject.directory, "status")], ["monitor"]);
  });

  it("a clean and smudge filter and a text conversion for AGENTS.md, named by the work tree's attributes and by the workspace's attributes file", async () => {
    const subject = await fixture();
    const plant = await plantArea(subject);
    plant.config("filter.planted.clean", await plant.script("clean"));
    plant.config("filter.planted.smudge", await plant.script("smudge"));
    plant.config("diff.planted.textconv", await plant.script("textconv"));
    await writeFile(join(subject.directory, ".gitattributes"), "AGENTS.md filter=planted diff=planted\n");
    await mkdir(join(subject.directory, ".git/info"), { recursive: true });
    await writeFile(join(subject.directory, ".git/info/attributes"), "AGENTS.md filter=planted diff=planted\n");
    await writeFile(join(subject.directory, "AGENTS.md"), "edited\n");
    await expectNotRun(subject, plant, () => [
      () => git(subject.directory, "diff", "--textconv", "--", "AGENTS.md"),
      () => git(subject.directory, "add", "AGENTS.md"),
    ], ["clean", "textconv"]);
  });

  it("a long-running filter process for AGENTS.md", async () => {
    const subject = await fixture();
    const plant = await plantArea(subject);
    plant.config("filter.planted.process", await plant.script("process"));
    await writeFile(join(subject.directory, ".gitattributes"), "AGENTS.md filter=planted\n");
    await writeFile(join(subject.directory, "AGENTS.md"), "edited\n");
    await expectNotRun(subject, plant, () => [() => git(subject.directory, "add", "AGENTS.md")], ["process"]);
  });

  it("an external diff command for AGENTS.md", async () => {
    const subject = await fixture();
    const plant = await plantArea(subject);
    plant.config("diff.planted.command", await plant.script("diff"));
    await writeFile(join(subject.directory, ".gitattributes"), "AGENTS.md diff=planted\n");
    await writeFile(join(subject.directory, "AGENTS.md"), "edited\n");
    await expectNotRun(subject, plant, () => [() => git(subject.directory, "diff", "--ext-diff", "--", "AGENTS.md")], ["diff"]);
  });

  it("an included config file, and a conditionally included one, that set a file system monitor", async () => {
    const subject = await fixture();
    const plant = await plantArea(subject);
    const included = join(plant.area, "included.config");
    const conditional = join(plant.area, "conditional.config");
    await writeFile(included, `[core]\n\tfsmonitor = ${await plant.script("monitor-included")}\n`);
    await writeFile(conditional, `[core]\n\tfsmonitor = ${await plant.script("monitor-conditional")}\n`);
    const configPath = join(subject.directory, ".git/config");
    const existing = execFileSync("cat", [configPath], { encoding: "utf8" });
    await writeFile(configPath, `${existing}[include]\n\tpath = ${included}\n[includeIf "gitdir:${subject.directory}/.git/"]\n\tpath = ${conditional}\n`);
    await expectNotRun(subject, plant, () => [() => git(subject.directory, "status")], ["monitor-included"]);
  });

  // The pager is planted too; git does not start it for a command run without a terminal, so it is not part of the live check.
  it("an SSH command, a pager and an alternate-refs command set in the workspace's config", async () => {
    const subject = await fixture();
    const plant = await plantArea(subject);
    const alternate = await realpath(await mkdtemp(join(tmpdir(), "agentx-trusted-alt-")));
    execFileSync("git", ["init", "--quiet", "--bare", alternate]);
    await mkdir(join(objectsOf(subject), "info"), { recursive: true });
    await writeFile(join(objectsOf(subject), "info/alternates"), `${join(alternate, "objects")}\n`);
    plant.config("core.sshCommand", await plant.script("ssh"));
    plant.config("core.pager", await plant.script("pager"));
    plant.config("core.alternateRefsCommand", await plant.script("alternate-refs"));
    await expectNotRun(subject, plant, () => [
      () => git(subject.directory, "ls-remote", "ssh://planted.invalid/repository.git"),
      () => git(subject.directory, "-p", "log", "-1"),
      () => git(subject.directory, "rev-list", "--alternate-refs", "--all"),
    ], ["ssh", "alternate-refs"]);
  });
});
