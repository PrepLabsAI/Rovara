import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { candidateUnchangedSinceBase, commitCandidateWorktree, readCandidateRepositories, readCommittedCandidateSourceExport } from "../../packages/worker/src/verification/candidate.js";

// Real git, no mocks. The coding agent controls the candidate repository's `.git/config`, `.gitattributes` and hooks, and keeps running while the
// worker reads it, so no worker git call may honour that repository's config at any moment, not only when the worker first looked at it.
const execFile = promisify(execFileCallback);
const REAL_GIT = (await execFile("sh", ["-c", "command -v git"])).stdout.trim();
const sandboxes: string[] = [];
const originalEnvironment = { ...process.env };

type Sandbox = { root: string; directory: string; markers: string; log: string };

async function git(directory: string, ...args: string[]): Promise<string> {
  return (await execFile("git", ["-C", directory, ...args], { encoding: "utf8" })).stdout.trim();
}

/** A shim first on PATH: it logs every git invocation, and (when SHIM_INJECT is set) rewrites the candidate's config right before `git add` runs. */
async function installGitShim(root: string): Promise<void> {
  const bin = join(root, "bin");
  await mkdir(bin);
  const script = `#!/bin/sh
{ printf 'BEGIN\\n'; printf 'CWD\\t%s\\n' "$PWD"; printf 'GIT_DIR\\t%s\\n' "\${GIT_DIR-}"; for a in "$@"; do printf 'ARG\\t%s\\n' "$a"; done; } >> "$SHIM_LOG"
if [ -n "\${SHIM_INJECT-}" ]; then
  for a in "$@"; do
    if [ "$a" = add ]; then
      CLEAN="sh -c 'touch $SHIM_MARKERS/injected-filter; cat'"
      case "$SHIM_INJECT" in
        filter)
          "$SHIM_REAL_GIT" config --file "$SHIM_CANDIDATE/.git/config" filter.y.clean "$CLEAN"
          printf '* filter=y\\n' > "$SHIM_CANDIDATE/.gitattributes" ;;
        include)
          printf '[filter "y"]\\n\\tclean = "%s"\\n' "$CLEAN" > "$SHIM_CANDIDATE/../evil.inc"
          "$SHIM_REAL_GIT" config --file "$SHIM_CANDIDATE/.git/config" include.path "$SHIM_CANDIDATE/../evil.inc"
          printf '* filter=y\\n' > "$SHIM_CANDIDATE/.gitattributes" ;;
        nested)
          if [ -d "$SHIM_CANDIDATE/../nested-hidden" ]; then rmdir "$SHIM_CANDIDATE/nested" && mv "$SHIM_CANDIDATE/../nested-hidden" "$SHIM_CANDIDATE/nested"; fi ;;
        embedded)
          "$SHIM_REAL_GIT" init -q "$SHIM_CANDIDATE/embedded"
          printf 's\\n' > "$SHIM_CANDIDATE/embedded/inner.txt"
          "$SHIM_REAL_GIT" -C "$SHIM_CANDIDATE/embedded" add inner.txt
          "$SHIM_REAL_GIT" -C "$SHIM_CANDIDATE/embedded" -c user.name=A -c user.email=a@example.invalid commit -q -m inner
          "$SHIM_REAL_GIT" config --file "$SHIM_CANDIDATE/embedded/.git/config" filter.inner.clean "$CLEAN"
          printf '*.txt filter=inner\\n' > "$SHIM_CANDIDATE/embedded/.gitattributes"
          printf 't\\n' > "$SHIM_CANDIDATE/embedded/inner.txt" ;;
        movehead)
          COUNT=$(cat "$SHIM_MARKERS/../add-count" 2>/dev/null || echo 0)
          echo $((COUNT + 1)) > "$SHIM_MARKERS/../add-count"
          if [ "$COUNT" = 1 ]; then "$SHIM_REAL_GIT" --git-dir="$SHIM_CANDIDATE/.git" update-ref HEAD "$SHIM_OTHER_COMMIT"; fi ;;
      esac
    fi
  done
fi
exec "$SHIM_REAL_GIT" "$@"
`;
  await writeFile(join(bin, "git"), script);
  await chmod(join(bin, "git"), 0o755);
}

async function sandbox(): Promise<Sandbox> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-h3-")));
  sandboxes.push(root);
  const directory = join(root, "repo");
  const markers = join(root, "markers");
  await mkdir(markers);
  await mkdir(directory);
  await installGitShim(root);
  const log = join(root, "git-calls.log");
  await writeFile(log, "");
  Object.assign(process.env, { PATH: `${join(root, "bin")}:${originalEnvironment.PATH ?? ""}`, SHIM_LOG: log, SHIM_REAL_GIT: REAL_GIT, SHIM_MARKERS: markers, SHIM_CANDIDATE: directory });
  delete process.env.SHIM_INJECT;
  await git(directory, "init", "--quiet");
  await git(directory, "config", "user.email", "agentx@example.invalid");
  await git(directory, "config", "user.name", "AgentX Test");
  await writeFile(join(directory, "tracked.txt"), "baseline\n");
  await git(directory, "add", "tracked.txt");
  await git(directory, "commit", "--quiet", "-m", "baseline");
  await writeFile(log, "");
  return { root, directory, markers, log };
}

beforeEach(() => {
  delete process.env.GIT_AUTHOR_DATE;
  delete process.env.GIT_COMMITTER_DATE;
});

afterEach(async () => {
  for (const name of Object.keys(process.env)) if (!(name in originalEnvironment)) delete process.env[name];
  Object.assign(process.env, originalEnvironment);
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fired = async (box: Sandbox): Promise<string[]> => (await readdir(box.markers)).sort();
const inputOf = (box: Sandbox, baseCommitSha?: string) => [{ repositoryId: "payments", directory: box.directory, ...(baseCommitSha === undefined ? {} : { baseCommitSha }) }];
const hex = (value: string): string => value.trim();

describe("worker git calls on a candidate repository never honour its repo-local config", () => {

  it("does not run a filter written to the config after the worker looked at it, while publication computes the workspace tree (temporaryIndexTree)", async () => {
    const { temporaryIndexTree } = await import("../../packages/worker/src/publish.js");
    const box = await sandbox();
    await writeFile(join(box.directory, "tracked.txt"), "changed\n");
    const [captured] = await readCandidateRepositories(inputOf(box));
    process.env.SHIM_INJECT = "filter";
    const tree = await temporaryIndexTree({ directory: box.directory });
    expect(await fired(box)).toEqual([]);
    // The same tree capture computes, apart from the .gitattributes file this test's injection adds to the work tree.
    expect(tree).toMatch(/^[a-f0-9]{40}$/);
    expect(tree).not.toBe(captured?.treeSha);
    delete process.env.SHIM_INJECT;
    await rm(join(box.directory, ".gitattributes"));
    expect(await temporaryIndexTree({ directory: box.directory })).toBe(captured?.treeSha);
  });

  it("does not run a filter written to the config after the worker looked at it, while committing the candidate (commitCandidateWorktree)", async () => {
    const box = await sandbox();
    await writeFile(join(box.directory, "tracked.txt"), "changed\n");
    process.env.SHIM_INJECT = "filter";
    const [committed] = await commitCandidateWorktree(inputOf(box));
    expect(committed?.commitSha).toMatch(/^[a-f0-9]{40}$/);
    expect(await fired(box)).toEqual([]);
  });

  it("does not run Git inside a nested repository that appears at a tracked submodule path after the worker checked for one", async () => {
    const box = await sandbox();
    const hidden = join(box.root, "nested-hidden");
    await mkdir(hidden);
    await git(hidden, "init", "--quiet");
    await git(hidden, "config", "user.email", "a@example.invalid");
    await git(hidden, "config", "user.name", "A");
    await writeFile(join(hidden, "inner.txt"), "s\n");
    await git(hidden, "add", "inner.txt");
    await git(hidden, "commit", "--quiet", "-m", "inner");
    await rename(hidden, join(box.directory, "nested"));
    await git(box.directory, "add", "nested");
    await writeFile(join(box.directory, ".gitmodules"), '[submodule "nested"]\n\tpath = nested\n\turl = x\n\tignore = none\n');
    await git(box.directory, "add", ".gitmodules");
    await git(box.directory, "commit", "--quiet", "-m", "nested");
    const nested = join(box.directory, "nested");
    await git(nested, "config", "filter.inner.clean", `sh -c 'touch ${join(box.markers, "nested-clean")}; cat'`);
    await writeFile(join(nested, ".gitattributes"), "*.txt filter=inner\n");
    await writeFile(join(nested, "inner.txt"), "t\n");
    // The nested repository leaves, so the worker sees an empty (uninitialised) submodule directory, and returns just before `git add` runs.
    await rename(nested, hidden);
    await mkdir(nested);
    process.env.SHIM_INJECT = "nested";
    await readCandidateRepositories(inputOf(box)).catch(() => undefined);
    expect(await fired(box)).toEqual([]);
  });

  it("refuses a setting the worker copies from the candidate's config when its value is not plain", async () => {
    const box = await sandbox();
    await git(box.directory, "config", "core.autocrlf", `input; touch ${join(box.markers, "value")}`);
    await expect(readCandidateRepositories(inputOf(box))).rejects.toThrow(/candidate repository payments is not a readable Git worktree/);
    expect(await fired(box)).toEqual([]);
  });

  it("refuses a candidate whose .git is a symlink, and a HEAD that is not a commit or a plain branch name", async () => {
    const box = await sandbox();
    await writeFile(join(box.directory, ".git", "HEAD"), "ref: refs/heads/../../../outside\n");
    await expect(readCandidateRepositories(inputOf(box))).rejects.toThrow(/not a readable Git worktree/);
    await writeFile(join(box.directory, ".git", "HEAD"), "ref: refs/heads/master\n");
    const moved = join(box.root, "moved.git");
    await rename(join(box.directory, ".git"), moved);
    await symlink(moved, join(box.directory, ".git"));
    await expect(readCandidateRepositories(inputOf(box))).rejects.toThrow(/not a readable Git worktree/);
    await expect(candidateUnchangedSinceBase(inputOf(box, "a".repeat(40)), [{ repositoryId: "payments", commitSha: "b".repeat(40), treeSha: "c".repeat(40), baseCommitSha: "a".repeat(40) }])).rejects.toThrow();
  });

  it("does not overwrite a HEAD that moved while the commit was being saved", async () => {
    const box = await sandbox();
    const head = await git(box.directory, "rev-parse", "HEAD");
    const other = await git(box.directory, "commit-tree", `${head}^{tree}`, "-p", head, "-m", "moved by someone else");
    await writeFile(join(box.directory, "tracked.txt"), "changed\n");
    process.env.SHIM_INJECT = "movehead";
    process.env.SHIM_OTHER_COMMIT = other;
    await expect(commitCandidateWorktree(inputOf(box))).rejects.toThrow(/could not be safely committed|changed while AgentX/);
    expect(await git(box.directory, "rev-parse", "HEAD")).toBe(other);
    await expect(readFile(join(box.directory, ".git", "index.lock"))).rejects.toThrow();
    await expect(readFile(join(box.directory, ".git", "refs", "heads", "master.lock"))).rejects.toThrow();
  });

});

describe("honest repositories give the same trees, commits and exports as plain git", () => {
  async function plainTree(directory: string, root: string): Promise<string> {
    // The reference runs under the same config isolation as the worker: a runner's own global or system config (git-lfs filters, autocrlf, excludes) must not decide the expected tree.
    const rest: NodeJS.ProcessEnv = { ...process.env };
    delete rest.HOME;
    delete rest.XDG_CONFIG_HOME;
    const env = { ...rest, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_INDEX_FILE: join(root, `reference-index-${randomUUID()}`) };
    await execFile("git", ["-C", directory, "read-tree", "HEAD"], { env });
    await execFile("git", ["-C", directory, "add", "--all", "--", "."], { env });
    return hex((await execFile("git", ["-C", directory, "write-tree"], { env, encoding: "utf8" })).stdout);
  }

  async function richRepository(box: Sandbox, config: Array<[string, string]> = []): Promise<void> {
    await writeFile(join(box.directory, ".gitignore"), "ignored.log\n");
    await writeFile(join(box.directory, ".gitattributes"), "*.eol text eol=lf\n");
    await writeFile(join(box.directory, "gone.txt"), "to be deleted\n");
    await git(box.directory, "add", ".");
    await git(box.directory, "commit", "--quiet", "-m", "more");
    for (const [key, value] of config) await git(box.directory, "config", key, value);
    await writeFile(join(box.directory, ".git", "info", "exclude"), "secret.local\n");
    await writeFile(join(box.directory, "ignored.log"), "ignored\n");
    await writeFile(join(box.directory, "secret.local"), "excluded\n");
    await writeFile(join(box.directory, "dos.dat"), "a\r\nb\r\n");
    await writeFile(join(box.directory, "dos.eol"), "a\r\nb\r\n");
    await writeFile(join(box.directory, "run.sh"), "#!/bin/sh\n");
    await chmod(join(box.directory, "run.sh"), 0o755);
    await symlink("tracked.txt", join(box.directory, "link"));
    await mkdir(join(box.directory, "sub"));
    await writeFile(join(box.directory, "sub", "é.txt"), "unicode\n");
    await writeFile(join(box.directory, "tracked.txt"), "edited\n");
    await rm(join(box.directory, "gone.txt"));
    await mkdir(join(box.directory, "empty-directory"));
  }

  for (const [label, config] of [["default config", []]] as Array<[string, Array<[string, string]>]>) {
    it(`captures and commits the tree plain git computes (${label})`, async () => {
      const box = await sandbox();
      await richRepository(box, config);
      const expectedTree = await plainTree(box.directory, box.root);
      const head = await git(box.directory, "rev-parse", "HEAD");
      const inputs = inputOf(box, head);

      const [captured] = await readCandidateRepositories(inputs);
      expect(captured).toEqual({ repositoryId: "payments", commitSha: head, treeSha: expectedTree, baseCommitSha: head });
      // The tree object is readable from the candidate repository afterwards: the review diff reads it there.
      expect(await git(box.directory, "cat-file", "-t", expectedTree)).toBe("tree");

      process.env.GIT_AUTHOR_DATE = "2026-01-02T03:04:05Z";
      process.env.GIT_COMMITTER_DATE = "2026-01-02T03:04:05Z";
      const expectedCommit = hex((await execFile("git", ["-C", box.directory, "-c", "user.name=AgentX", "-c", "user.email=agentx@localhost", "commit-tree", expectedTree, "-p", head,
        "-m", "AgentX IMPLEMENT candidate snapshot"], { env: process.env, encoding: "utf8" })).stdout);
      const [committed] = await commitCandidateWorktree(inputs);
      expect(committed).toEqual({ repositoryId: "payments", commitSha: expectedCommit, treeSha: expectedTree, baseCommitSha: head });
      expect(await git(box.directory, "rev-parse", "HEAD")).toBe(expectedCommit);
      expect(await git(box.directory, "status", "--porcelain")).toBe("");
      expect(await git(box.directory, "diff", "--cached", "--name-only")).toBe("");

      const exported = await readCommittedCandidateSourceExport(inputs, [committed!]);
      const paths = (await execFile("git", ["-C", box.directory, "ls-tree", "-rz", "--name-only", "HEAD"], { encoding: "utf8" })).stdout.split("\0").filter(Boolean).sort();
      expect([...(exported.repositories[0]?.treePaths ?? [])].sort()).toEqual(paths);
      for (const source of exported.repositories[0]?.sources ?? []) {
        expect(Buffer.from(source.bytesBase64, "base64").toString("utf8")).toBe((await execFile("git", ["-C", box.directory, "show", `HEAD:${source.path}`], { encoding: "utf8" })).stdout);
      }
      expect(await candidateUnchangedSinceBase(inputs, [committed!])).toBe(false);
    });
  }

  it("commits on a detached HEAD and on a branch kept only in packed-refs, and says so when nothing changed", async () => {
    for (const mode of ["detached", "packed"] as const) {
      const box = await sandbox();
      const head = await git(box.directory, "rev-parse", "HEAD");
      if (mode === "detached") await git(box.directory, "checkout", "--quiet", "--detach");
      else await git(box.directory, "pack-refs", "--all");
      const inputs = inputOf(box, head);
      const unchanged = await commitCandidateWorktree(inputs);
      expect(unchanged[0]?.commitSha).toBe(head);
      await writeFile(join(box.directory, "tracked.txt"), `${mode}\n`);
      const [committed] = await commitCandidateWorktree(inputs);
      expect(committed?.commitSha).not.toBe(head);
      expect(await git(box.directory, "rev-parse", "HEAD")).toBe(committed?.commitSha);
      expect(await git(box.directory, "rev-parse", "HEAD^")).toBe(head);
      expect(await git(box.directory, "status", "--porcelain")).toBe("");
      expect(await git(box.directory, "fsck", "--no-dangling")).not.toMatch(/error|missing/i);
    }
  });

  it("leaves HEAD alone when another process holds the index lock", async () => {
    const box = await sandbox();
    const head = await git(box.directory, "rev-parse", "HEAD");
    await writeFile(join(box.directory, "tracked.txt"), "changed\n");
    await writeFile(join(box.directory, ".git", "index.lock"), "");
    await expect(commitCandidateWorktree(inputOf(box))).rejects.toThrow(/the repository is locked by .*index\.lock/);
    expect(await git(box.directory, "rev-parse", "HEAD")).toBe(head);
  });
});

describe("fix round 1: the worker's own ref writer, excludesFile, locks", () => {
  /** Every file (not directory) under `root`, relative. */
  async function filesUnder(root: string, prefix = ""): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) found.push(...await filesUnder(root, path));
      else found.push(path);
    }
    return found.sort();
  }
  /** Moves `.git/<relative>` out of the repository and leaves a symlink to it. */
  async function relocate(box: Sandbox, relative: string): Promise<string> {
    const outside = join(box.root, `outside-${randomUUID()}`);
    await rename(join(box.directory, ".git", relative), outside);
    await symlink(outside, join(box.directory, ".git", relative));
    return outside;
  }
  async function refusesAndTouchesNothing(box: Sandbox, outside: string): Promise<void> {
    const before = await filesUnder(outside);
    await writeFile(join(box.directory, "tracked.txt"), "changed\n");
    await expect(commitCandidateWorktree(inputOf(box))).rejects.toThrow();
    await expect(readCandidateRepositories(inputOf(box))).rejects.toThrow(/not a readable Git worktree/);
    expect(await filesUnder(outside)).toEqual(before);
    await expect(readFile(join(box.directory, ".git", "index.lock"))).rejects.toThrow();
  }

  it("refuses a symlinked .git/refs and writes nothing through it", async () => {
    const box = await sandbox();
    await git(box.directory, "pack-refs", "--all");
    await refusesAndTouchesNothing(box, await relocate(box, "refs"));
  });

  it("refuses a candidate whose own config sets core.excludesFile, and says why", async () => {
    const box = await sandbox();
    await writeFile(join(box.root, "ignore-list"), "*.secret\n");
    await git(box.directory, "config", "core.excludesFile", join(box.root, "ignore-list"));
    await writeFile(join(box.directory, "a.secret"), "x\n");
    const refusal = await readCandidateRepositories(inputOf(box)).then(() => undefined, (error: unknown) => error);
    expect(refusal).toMatchObject({ code: "CONFIG_INVALID" });
    expect((refusal as Error).message).toMatch(/core\.excludesFile/);
    await expect(commitCandidateWorktree(inputOf(box))).rejects.toThrow(/core\.excludesFile/);
    await expect(candidateUnchangedSinceBase(inputOf(box, "a".repeat(40)), [{ repositoryId: "payments", commitSha: "b".repeat(40), treeSha: "c".repeat(40), baseCommitSha: "a".repeat(40) }])).rejects.toThrow(/core\.excludesFile/);
  });

});
