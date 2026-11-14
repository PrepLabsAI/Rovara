// TE-R1: a worker-only, candidate-bound execution scope. Nothing here changes the candidate identity or preparation contracts.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readlink, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { matchTestCommand, parseCommandLine, type ProjectCommand } from "@agentx/contracts";
import { createPartWorkingCopy } from "./parallel-parts-git.js";
import { snapshotTree, withIsolatedGit, isSafeRefName } from "./isolated-git.js";
import { AGENTX_GIT_IDENTITY_ENVIRONMENT } from "./git.js";
import { runIsolatedGit } from "./isolated-repository.js";
import { wireMultiRepoDependencies } from "./multi-repo-wiring.js";
import { coverageSpecsOf } from "./verification/cobertura-lcov-coverage.js";
import { RunnerKillUnconfirmedError } from "./collected-process.js";
import { openDirectory } from "./candidate-fs.js";
import { CheckNotRunError, type CheckPlan, type CheckRunners } from "./verification/checks.js";
import { gitOriginalCode, isUnconfirmedStop, type OriginalCodeRepository } from "./verification/original-code.js";
import { readContainedReport } from "./verification/report-file.js";
import { reportSpecOf } from "./verification/test-proof.js";
import { sarifPathOf } from "./verification/sarif.js";

/** Worker-only input: the task coordinator supplies selection; the worker does not read broker/core state. */
export interface MultiRepoChecks {
  rootPath: string;
  repositories: readonly { repositoryId: string; path: string; baseCommit: string; taskBranch?: string }[];
  dependencies: readonly { consumer: string; provider: string; language: string }[];
  setup: readonly ProjectCommand[];
  coveragePaths?: ReadonlyArray<string | undefined> | undefined;
}

function inside(root: string, path: string): string {
  const target = resolve(root, path);
  const from = relative(root, target);
  if (isAbsolute(path) || from === ".." || from.startsWith(`..${sep}`)) throw new Error("multi-repository path leaves the check root");
  return target;
}

/** Every round is fresh. The AsyncLocalStorage carries only the old-code selection, never a wired tree or a candidate identity. */
export function withMultiRepoChecks(input: MultiRepoChecks, base: CheckRunners): CheckRunners {
  const phase = new AsyncLocalStorage<readonly OriginalCodeRepository[]>();
  return {
    ...base,
    originalCode: (repositories) => ({ run: (work) => phase.run(repositories, work) }),
    async scopeRound(plan, signal, run) {
      const workspace = await openDirectory(resolve(input.rootPath));
      let root: string | undefined;
      let unconfirmed = false;
      try {
        const ids = new Set<string>();
        const sources: string[] = [];
        for (const repository of input.repositories) {
          const source = inside(workspace.path, repository.path);
          const canonical = await realpath(source);
          if (canonical !== source || source === workspace.path || ids.has(repository.repositoryId) || sources.some((other) => other === source || source.startsWith(`${other}${sep}`) || other.startsWith(`${source}${sep}`))) throw new Error("multi-repository paths must be distinct contained repositories");
          ids.add(repository.repositoryId); sources.push(source);
        }
        root = await mkdtemp(join(workspace.path, ".agentx-check-"));
        const copies = new Map<string, string>();
        for (const repository of input.repositories) {
          if (signal.aborted) throw new Error("aborted");
          const source = inside(workspace.path, repository.path);
          const destination = inside(root, repository.path);
          // Matching task branch for affected repositories, pinned base for the others. Dirty candidate files are retained in both cases.
          if (repository.taskBranch !== undefined && !isSafeRefName(repository.taskBranch)) throw new Error("multi-repository task branch is invalid");
          const selected = (await runIsolatedGit(source, ["rev-parse", "--verify", `${repository.taskBranch ?? repository.baseCommit}^{commit}`])).trim();
          const tree = await withIsolatedGit(source, "write", async (git) => {
            const head = await git.headCommit();
            if (head !== selected) throw new Error("multi-repository checkout does not match the selected branch or base");
            const tree = await snapshotTree(git, head, repository.baseCommit);
            if (repository.taskBranch === undefined && tree !== (await git.text(["rev-parse", `${repository.baseCommit}^{tree}`])).trim()) throw new Error("multi-repository unaffected repository differs from its base");
            return tree;
          });
          const copy = await createPartWorkingCopy({ rootPath: root, repositoryDirectory: source, repositoryId: `repo-${copies.size}`, itemId: randomUUID(), treeSha: tree });
          await mkdir(dirname(destination), { recursive: true });
          await rename(copy.directory, destination);
          copies.set(source, destination);
        }
        const old = phase.getStore();
        // Coverage overrides index the full candidate plan. Old-code test/SARIF subsets only carry their own command-declared reports.
        const coveragePaths = old === undefined ? input.coveragePaths : undefined;
        const execute = async () => {
          await remapLinks(root!, copies);
          const wiring = await wireMultiRepoDependencies(input, root!);
          const mapped = (command: ProjectCommand): ProjectCommand => ({ ...wiring.command(command), cwd: relative(workspace.path, inside(root!, command.cwd)) });
          let snapshots: Map<string, string> | undefined;
          const scoped: CheckRunners = {
            ...base,
            async endRound() {
              try { await base.endRound?.(); } catch { unconfirmed = true; }
            },
            runProjectCommand: (command, stop) => base.runProjectCommand(mapped(command), stop),
            async runAgentCommand(replay, timeoutMs, stop) {
              if (matchTestCommand(replay) !== replay) throw new CheckNotRunError("AgentX replays only a simple test command, and this is not one.");
              const cd = /^cd (\S+) && (.+)$/s.exec(replay);
              const parsed = parseCommandLine(cd?.[2] ?? replay, cd?.[1] ?? ".", timeoutMs / 1_000);
              const words = [parsed.executable, ...parsed.args];
              const env: Record<string, string> = { ...AGENTX_GIT_IDENTITY_ENVIRONMENT };
              while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0]!)) {
                const assignment = words.shift()!;
                Object.defineProperty(env, assignment.slice(0, assignment.indexOf("=")), { value: assignment.slice(assignment.indexOf("=") + 1), enumerable: true, configurable: true, writable: true });
              }
              const prefix = words[0] === "timeout" ? words.splice(0, 2) : [];
              const command = mapped({ ...parsed, executable: words[0]!, args: words.slice(1), env });
              const result = await base.runProjectCommand(prefix.length === 0 ? command : { ...command, executable: prefix[0]!, args: [prefix[1]!, command.executable, ...command.args] }, stop);
              return { exitCode: result.exitCode, timedOut: result.timedOut, output: `${result.stdout}${result.stderr}` };
            },
            async prepareRound(stop) {
              for (const command of wiring.setup) {
                const result = await base.runProjectCommand(mapped(command), stop);
                if (result.exitCode !== 0 || result.timedOut) throw new Error("multi-repository setup failed");
              }
              snapshots = await captureTrees(copies.values());
              for (const command of input.setup) {
                const result = await base.runProjectCommand(mapped(command), stop);
                if (result.exitCode !== 0 || result.timedOut) throw new Error("multi-repository setup failed");
              }
              // Checkout and setup can give old reports fresh mtimes. Only a check may produce a forwarded report.
              await discardReports(plan, root!, coveragePaths);
            },
          };
          delete scoped.scopeRound;
          const started = Date.now();
          const result = await run(scoped);
          if (unconfirmed) throw new RunnerKillUnconfirmedError({ kind: base.kind ?? "local" });
          if (snapshots !== undefined && result.entries.some((entry) => entry.after === "passed" || entry.after === "failed")) await assertNoSourceDrift(copies.values(), snapshots, reportPaths(plan, root!, coveragePaths));
          await preserveReports(plan, root!, workspace.path, started, result.entries.some((entry) => entry.after === "passed" || entry.after === "failed"), coveragePaths);
          return wiring.notes.length === 0 ? result : { ...result, entries: result.entries.map((entry) => ({ ...entry, output: entry.after === "not_run" ? entry.output : `${wiring.notes.join("\n")}\n${entry.output}` })) };
        };
        return old === undefined ? await execute() : await gitOriginalCode(old.map((repository) => {
          const directory = copies.get(resolve(repository.directory));
          if (directory === undefined) throw new Error("multi-repository original-code selection is incomplete");
          return { ...repository, directory };
        })).run(execute);
      } catch (error) {
        unconfirmed ||= isUnconfirmedStop(error);
        throw error;
      } finally {
        // runChecks joins every aborted command. If it could not confirm a stop, workspace quarantine owns recovery; never race a late writer.
        if (root !== undefined && !unconfirmed) await rm(root, { recursive: true, force: true });
        await workspace.close();
      }
    },
  };
}

async function remapLinks(root: string, copies: ReadonlyMap<string, string>, directory = root): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await remapLinks(root, copies, path);
    else if (entry.isSymbolicLink()) {
      const target = resolve(directory, await readlink(path));
      let mapped = target;
      for (const [source, destination] of copies) if (target === source || target.startsWith(`${source}${sep}`)) mapped = join(destination, relative(source, target));
      if (mapped !== root && !mapped.startsWith(`${root}${sep}`)) throw new Error("multi-repository link leaves the check root");
      if (mapped !== target) { await unlink(path); await symlink(relative(directory, mapped), path); }
      const actual = await realpath(path);
      if (actual !== root && !actual.startsWith(`${root}${sep}`)) throw new Error("multi-repository link leaves the check root");
    }
  }
}

async function captureTrees(directories: Iterable<string>): Promise<Map<string, string>> {
  const trees = new Map<string, string>();
  for (const directory of directories) trees.set(directory, await withIsolatedGit(directory, "write", async (git) => snapshotTree(git, await git.headCommit())));
  return trees;
}

async function assertNoSourceDrift(directories: Iterable<string>, before: ReadonlyMap<string, string>, reports: ReadonlySet<string>): Promise<void> {
  for (const directory of directories) await withIsolatedGit(directory, "read", async (git) => {
    const after = await snapshotTree(git, await git.headCommit());
    const changed = (await git.text(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", before.get(directory)!, after])).split("\0").filter(Boolean);
    if (changed.some((path) => !reports.has(join(directory, path)))) throw new Error("multi-repository check changed candidate source");
  });
}

function reportPaths(plan: CheckPlan, root: string, coverage?: ReadonlyArray<string | undefined>): Set<string> {
  return new Set((plan.readiness ?? []).flatMap((command, index) => [reportSpecOf(command)?.argument, sarifPathOf(command), ...coverageSpecsOf(command, coverage?.[index]).map((spec) => spec.argument)]
    .filter((path): path is string => path !== undefined).map((path) => inside(root, join(command.cwd, path)))));
}

function reportRelativePath(root: string, source: string): string {
  const path = relative(root, source);
  if (path.split(sep).some((part) => part === ".git" || part.startsWith(".agentx"))) throw new Error("multi-repository report names worker or Git state");
  return path;
}

async function discardReports(plan: CheckPlan, root: string, coverage?: ReadonlyArray<string | undefined>): Promise<void> {
  const discard = async (source: string) => {
    const path = reportRelativePath(root, source);
    let parent = await openDirectory(root);
    try {
      for (const segment of relative(root, dirname(source)).split(sep).filter(Boolean)) {
        const next = await parent.subdirectory(segment, false);
        if (next === undefined) return;
        await parent.close(); parent = next;
      }
      await rm(parent.entry(basename(path)), { force: true });
    } finally { await parent.close(); }
  };
  for (const source of reportPaths(plan, root, coverage)) await discard(source);
}

async function preserveReports(plan: CheckPlan, root: string, destination: string, started: number, checked: boolean, coverage?: ReadonlyArray<string | undefined>): Promise<void> {
  for (const source of reportPaths(plan, root, coverage)) {
    const path = reportRelativePath(root, source);
    const read = checked ? await readContainedReport({ root, cwd: ".", argument: path, maxBytes: 16 * 1024 * 1024, notBeforeMs: started }) : { ok: false as const };
    const target = inside(destination, path);
    let parent = await openDirectory(destination);
    try {
      for (const segment of relative(destination, dirname(target)).split(sep).filter(Boolean)) {
        const next = (await parent.subdirectory(segment, true))!;
        await parent.close(); parent = next;
      }
      const existing = await lstat(parent.entry(basename(target))).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
      if (existing !== undefined && !existing.isFile()) throw new Error("multi-repository report destination is not a regular file");
      if (!read.ok) { await rm(parent.entry(basename(target)), { force: true }); continue; }
      const temporary = parent.entry(`.agentx-report-${randomUUID()}`);
      try {
        await writeFile(temporary, read.bytes, { flag: "wx", mode: 0o600 });
        await rename(temporary, parent.entry(basename(target)));
      } finally { await rm(temporary, { force: true }); }
    } finally { await parent.close(); }
  }
}
