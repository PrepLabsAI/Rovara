import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCandidateManifest, type E2ESourceSnapshot } from "@agentx/contracts";
import { validateE2EApplicationBuildSourceManifest } from "../../packages/verifier/src/application-build-source.js";
import { createProcessCandidateGit } from "../../packages/worker/src/e2e-candidate-source.js";
import { MAX_BUILD_SOURCE_MANIFEST_BYTES, exportCandidateBuildSource } from "../../packages/worker/src/e2e-build-source-export.js";
import { readCommittedCandidateSourceExport } from "../../packages/worker/src/verification/candidate.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp(prefix: string) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); roots.push(dir); return dir; }
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.safecrlf=false", "-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const signal = () => new AbortController().signal;

type Tree = Record<string, string | Buffer>;
async function repository(tree: Tree, options: { executable?: string[]; symlinks?: Record<string, string>; gitlinks?: string[]; afterCommit?: (root: string) => Promise<void> } = {}) {
  const root = await temp("build-source-repo-");
  git(root, "init", "-q");
  for (const [path, content] of Object.entries(tree)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
    if (options.executable?.includes(path)) await chmod(join(root, path), 0o755);
  }
  for (const [path, target] of Object.entries(options.symlinks ?? {})) { await mkdir(dirname(join(root, path)), { recursive: true }); await symlink(target, join(root, path)); }
  git(root, "add", "-A");
  for (const path of options.gitlinks ?? []) git(root, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},${path}`);
  git(root, "commit", "-q", "-m", "candidate");
  const commitSha = git(root, "rev-parse", "HEAD");
  const treeSha = git(root, "rev-parse", "HEAD^{tree}");
  // Set after the commit: the booby traps must only ever fire if the export runs git in this repository.
  await options.afterCommit?.(root);
  return { root, commitSha, treeSha, candidate: createCandidateManifest([{ repositoryId: "fixture/app", commitSha, treeSha }]) };
}
async function exported(repo: Awaited<ReturnType<typeof repository>>, extra: { maxManifestBytes?: number; signal?: AbortSignal } = {}) {
  return exportCandidateBuildSource({ git: createProcessCandidateGit(await temp("build-source-scratch-")), repositoryRoot: repo.root, candidate: repo.candidate,
    signal: extra.signal ?? signal(), ...(extra.maxManifestBytes === undefined ? {} : { maxManifestBytes: extra.maxManifestBytes }) });
}
/** What the broker holds: the worker's own first-party committed export, turned into the inspection snapshot the validator wants. */
async function inspectionOf(repo: Awaited<ReturnType<typeof repository>>): Promise<E2ESourceSnapshot> {
  const source = await readCommittedCandidateSourceExport([{ repositoryId: "fixture/app", directory: repo.root }],
    [{ repositoryId: "fixture/app", commitSha: repo.commitSha, treeSha: repo.treeSha }]);
  const repository = source.repositories[0]!;
  return { candidate: source.candidate, commitSha: repository.commitSha, treeSha: repository.treeSha, treeComplete: true, treePaths: repository.treePaths,
    sources: repository.sources.map((item) => ({ path: item.path, sha256: item.sha256, kind: "blob" as const, bytes: Buffer.from(item.bytesBase64, "base64") })) };
}
function ready(result: Awaited<ReturnType<typeof exported>>) {
  if (result.status !== "READY") throw new Error(`expected a manifest, got: ${result.reason}`);
  return result.manifest;
}

describe("the worker exports the build source manifest for the committed candidate", () => {
  it("covers the whole tree: every path once, as a permitted file with its identity or as an explicit omission", async () => {
    const binary = Buffer.from([0, 1, 2, 255, 254, 0, 13, 10]);
    const tree: Tree = { "package.json": "{\"name\":\"app\"}", "src/server.js": "console.log(1)\n", "bin/run.sh": "#!/bin/sh\n", "data/blob.bin": binary, "empty.txt": "", "crlf.txt": "a\r\nb\r\n",
      ".env": "SECRET=1\n", ".github/workflows/ci.yml": "on: push\n", "config/secrets/db.json": "{}" };
    const repo = await repository(tree, { executable: ["bin/run.sh"], symlinks: { "link-to-passwd": "/etc/passwd" }, gitlinks: ["vendor/sub"] });
    const result = await exported(repo);
    const manifest = ready(result);

    const listed = git(repo.root, "ls-tree", "-r", "--full-tree", repo.commitSha).split("\n").map((line) => /^(\d{6}) \w+ ([0-9a-f]{40})\t(.+)$/.exec(line)!.slice(1));
    expect(manifest.treeEntries.map((entry) => [entry.mode, entry.objectId, entry.path]).sort()).toEqual(listed.map(([mode, objectId, path]) => [mode, objectId, path]).sort());
    expect(manifest.files.length + manifest.omissions.length).toBe(listed.length);
    expect(new Set([...manifest.files, ...manifest.omissions].map((entry) => entry.path)).size).toBe(listed.length);

    const files = new Map(manifest.files.map((file) => [file.path, file]));
    expect([...files.keys()].sort()).toEqual(["bin/run.sh", "crlf.txt", "data/blob.bin", "empty.txt", "package.json", "src/server.js"]);
    for (const [path, content] of Object.entries(tree)) {
      const file = files.get(path);
      if (file === undefined) continue;
      const bytes = Buffer.from(content);
      expect(file, path).toMatchObject({ sha256: sha256(bytes), byteLength: bytes.byteLength, gitBlobId: git(repo.root, "rev-parse", `${repo.commitSha}:${path}`) });
    }
    expect(files.get("bin/run.sh")!.mode).toBe("100755");
    expect(files.get("package.json")!.mode).toBe("100644");

    const omissions = new Map(manifest.omissions.map((omission) => [omission.path, omission]));
    expect(omissions.get("link-to-passwd")).toMatchObject({ mode: "120000", reason: "symlink" });
    expect(omissions.get("vendor/sub")).toMatchObject({ mode: "160000", reason: "submodule", objectId: "1".repeat(40) });
    for (const blocked of [".env", ".github/workflows/ci.yml", "config/secrets/db.json"]) expect(omissions.get(blocked), blocked).toMatchObject({ mode: "100644", reason: "blocked-path" });
    expect(manifest.omissions).toHaveLength(5);
    expect(manifest.repository).toEqual({ repositoryId: "fixture/app", commitSha: repo.commitSha, treeSha: repo.treeSha });
    expect(manifest.candidateDigest).toBe(repo.candidate.digest);
    expect(manifest.sourceState).toBe("committed-tree");

    // The broker's validator, against the worker's own committed export, accepts exactly this manifest.
    const reference = { artifactId: "candidate-build-source", sha256: manifest.archive.sha256, byteLength: manifest.archive.byteLength, manifestDigest: manifest.manifestDigest };
    expect(validateE2EApplicationBuildSourceManifest({ manifest, reference, expectedCandidate: repo.candidate, inspectionSnapshot: await inspectionOf(repo) })).toEqual(manifest);
  });

  it("is deterministic for one commit", async () => {
    const repo = await repository({ "a.js": "a", "b/c.js": "c", ".env": "x" }, { symlinks: { l: "a.js" } });
    expect(ready(await exported(repo))).toEqual(ready(await exported(repo)));
  });

  it("carries the base commit of the candidate identity", async () => {
    const repo = await repository({ "a.js": "a" });
    const base = "b".repeat(40);
    const candidate = createCandidateManifest([{ repositoryId: "fixture/app", commitSha: repo.commitSha, treeSha: repo.treeSha, baseCommitSha: base }]);
    const manifest = ready(await exported({ ...repo, candidate }));
    expect(manifest.repository.baseCommitSha).toBe(base);
    expect(manifest.candidateDigest).toBe(candidate.digest);
  });

  it("never runs a repo-local filter, hook, fsmonitor or attribute while computing the manifest", async () => {
    const markers = await temp("markers-");
    const repo = await repository({ ".gitattributes": "* filter=x\n*.txt export-subst\n*.txt text eol=crlf\n", "version.txt": "commit $Format:%H$\n", "unix.txt": "one\ntwo\n" }, {
      afterCommit: async (root) => {
        const touch = (name: string) => `sh -c 'touch ${join(markers, name)}; cat'`;
        git(root, "config", "filter.x.smudge", touch("smudge"));
        git(root, "config", "filter.x.clean", touch("clean"));
        git(root, "config", "filter.x.process", touch("process"));
        git(root, "config", "core.fsmonitor", `sh -c 'touch ${join(markers, "fsmonitor")}'`);
        git(root, "config", "core.pager", touch("pager"));
        await mkdir(join(root, ".git", "hooks"), { recursive: true });
        for (const hook of ["post-checkout", "post-merge", "reference-transaction", "pre-auto-gc", "post-index-change"]) await writeFile(join(root, ".git", "hooks", hook), `#!/bin/sh\ntouch ${join(markers, hook)}\n`, { mode: 0o755 });
        git(root, "config", "core.hooksPath", join(root, ".git", "hooks"));
        appendFileSync(join(root, ".git", "info", "attributes"), "* filter=x\n* export-subst\n");
      } });
    const manifest = ready(await exported(repo));
    expect(await readdir(markers)).toEqual([]);
    // The recorded bytes are the blobs, not any filter's or export-subst's rewrite of them.
    expect(manifest.files.find((file) => file.path === "version.txt")).toMatchObject({ sha256: sha256(Buffer.from("commit $Format:%H$\n")) });
    expect(manifest.files.find((file) => file.path === "unix.txt")).toMatchObject({ sha256: sha256(Buffer.from("one\ntwo\n")) });
  });

  it("leaves no throwaway repository behind", async () => {
    const repo = await repository({ "a.js": "a" });
    const scratch = await temp("build-source-scratch-");
    await exportCandidateBuildSource({ git: createProcessCandidateGit(scratch), repositoryRoot: repo.root, candidate: repo.candidate, signal: signal() });
    expect(await readdir(scratch)).toEqual([]);
  });
});

describe("the worker refuses, with a reason, what the build source cannot hold", () => {
  it("refuses a candidate whose regular file is over the per-file cap, naming it, and never truncates", async () => {
    const repo = await repository({ "package.json": "{}", "big.bin": Buffer.alloc(8 * 1024 * 1024 + 1, 1) });
    const result = await exported(repo);
    expect(result).toMatchObject({ status: "UNAVAILABLE" });
    expect((result as { reason: string }).reason).toMatch(/big\.bin.*(over|exceeds).*8 MiB/);
  });

  it("refuses a candidate with more permitted files than the build source allows", async () => {
    const root = await temp("build-source-many-");
    git(root, "init", "-q");
    const blob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], { input: "x", encoding: "utf8" }).trim();
    const lines = Array.from({ length: 10_001 }, (_, index) => `100644 ${blob}\t0\tf/${String(index).padStart(5, "0")}.txt`).join("\n");
    execFileSync("git", ["-C", root, "update-index", "--index-info"], { input: `${lines}\n` });
    git(root, "commit", "-q", "-m", "many");
    const commitSha = git(root, "rev-parse", "HEAD"); const treeSha = git(root, "rev-parse", "HEAD^{tree}");
    const result = await exported({ root, commitSha, treeSha, candidate: createCandidateManifest([{ repositoryId: "fixture/app", commitSha, treeSha }]) });
    expect(result).toMatchObject({ status: "UNAVAILABLE" });
    expect((result as { reason: string }).reason).toMatch(/more files than the build source allows/);
  });

  it("refuses when the manifest itself would be over its cap, with the sizes in the reason", async () => {
    const repo = await repository({ "package.json": "{}", "src/a.js": "a" });
    const result = await exported(repo, { maxManifestBytes: 512 });
    expect(result).toMatchObject({ status: "UNAVAILABLE" });
    expect((result as { reason: string }).reason).toMatch(/manifest is \d+ bytes.*512/);
    expect(MAX_BUILD_SOURCE_MANIFEST_BYTES).toBe(8 * 1024 * 1024);
  });

  it("refuses a candidate that has more than one repository", async () => {
    const repo = await repository({ "a.js": "a" });
    const candidate = createCandidateManifest([{ repositoryId: "fixture/app", commitSha: repo.commitSha, treeSha: repo.treeSha }, { repositoryId: "fixture/other", commitSha: "c".repeat(40), treeSha: "d".repeat(40) }]);
    expect(await exported({ ...repo, candidate })).toMatchObject({ status: "UNAVAILABLE", reason: (expect.stringMatching(/exactly one repository/) as string) });
  });

  it("refuses a commit whose tree is not the candidate's tree, and an empty tree", async () => {
    const repo = await repository({ "a.js": "a" });
    const other = createCandidateManifest([{ repositoryId: "fixture/app", commitSha: repo.commitSha, treeSha: "e".repeat(40) }]);
    expect(await exported({ ...repo, candidate: other })).toMatchObject({ status: "UNAVAILABLE", reason: (expect.stringMatching(/tree does not match/) as string) });
    const empty = await temp("build-source-empty-");
    git(empty, "init", "-q");
    git(empty, "commit", "-q", "--allow-empty", "-m", "empty");
    const commitSha = git(empty, "rev-parse", "HEAD"); const treeSha = git(empty, "rev-parse", "HEAD^{tree}");
    expect(await exported({ root: empty, commitSha, treeSha, candidate: createCandidateManifest([{ repositoryId: "fixture/app", commitSha, treeSha }]) }))
      .toMatchObject({ status: "UNAVAILABLE", reason: (expect.stringMatching(/empty/) as string) });
  });

  it("refuses a repository that is not a plain git directory instead of throwing", async () => {
    const repo = await repository({ "a.js": "a" });
    const result = await exported({ ...repo, root: await temp("not-a-repo-") });
    expect(result).toMatchObject({ status: "UNAVAILABLE", reason: (expect.stringMatching(/plain git directory/) as string) });
  });

  it("is cancelled by the operation, not turned into a refusal", async () => {
    const repo = await repository({ "a.js": "a" });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(exported(repo, { signal: controller.signal })).rejects.toThrow("cancelled");
  });
});
