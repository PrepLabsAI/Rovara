// Additive: no run-task hook, evidence producer or Cloud mirror. Each control and mutant gets a NEW copy,
// and a NEW CheckRunners binding to that copy. A late writer never receives the candidate as cwd.
// The runner factory is trusted worker plumbing: it must isolate/mount this root, not close over the
// candidate or give test programs access to it. This module is not itself a process/network sandbox.
import { mkdtemp, realpath, rmdir } from "node:fs/promises";
import { transform, type Loader } from "esbuild";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import {
  isRerunnableTestId, mutationLanguage, mutationLimits, mutationPathFingerprint, mutationPathRefused, planMutants,
  type MutationLimits, type MutationLines, type MutationMethod, type MutationOutcome, type MutationReason, type MutationSpotResult, type ProjectCommand,
} from "@agentx/contracts";
import { withIsolatedGit } from "../isolated-git.js";
import type { CheckRunners } from "./checks.js";
import { candidateChanges } from "./diff.js";
import { checkTimeLimitMs, commandWithSelection, selectTests, type CoverageMap, type ImportGraph } from "./selection.js";
import { readReportPartsFile } from "./report-file.js";
import { withTestIds } from "./test-ids.js";
import type { ReportedTest } from "./test-report.js";
import { reportSpecOf } from "./test-proof.js";
import { MutationCopyTooLarge, discardMutationCopy, clearScratchReport, createMutationCopy, readMutationSource, snapshotCandidate, writeScratchMutant, type CandidateSnapshot } from "./mutation-restore.js";

export interface MutationRepository { directory: string; startCommit: string; candidateTreeSha: string }
export interface MutationSelection {
  command: ProjectCommand;
  check: { id: string; selectArgs?: readonly string[] };
  inventory: readonly string[];
  /** The worker's already-computed affected set; never a model-supplied list. */
  affectedTests: readonly string[];
  coverageMap?: CoverageMap;
  importGraph?: ImportGraph;
}
export interface MutationSpotOptions {
  repositories: readonly MutationRepository[];
  /** Compatibility hint only: NEVER used as mutation authority. Diff is recomputed from the pinned Git objects. */
  changes?: readonly MutationLines[];
  /** One approved test command/selection per repository, in the same order. */
  selection: readonly MutationSelection[];
  runners(directory: string, repositoryIndex: number): CheckRunners;
  clock?: () => number;
  seed: string;
  limits?: Partial<MutationLimits>;
  /** Required task-owned scratch parent outside all candidate trees. The caller owns timeout reclamation. */
  scratchRoot: string;
  signal?: AbortSignal;
}
class BudgetExpired extends Error {}
const empty = (): MutationSpotResult => ({ status: "not_run", trustedAfter: false, caught: 0, counted: 0, mutants: [], refusals: [] });

function selectedCommand(selection: MutationSelection, path: string): { command: ProjectCommand; method: MutationMethod; tests: readonly string[] } | undefined {
  const template = selection.check.selectArgs;
  if (template === undefined || template.filter((arg) => arg === "{tests}").length !== 1) return undefined;
  const common = { check: selection.check, changes: [{ path, status: "modified" as const }], inventory: selection.inventory, now: new Date() };
  for (const method of ["coverage_map", "import_graph"] as const) {
    const result = selectTests({ ...common, config: { method, alwaysRun: [], fullSuiteOn: [] },
      ...(selection.coverageMap === undefined ? {} : { coverageMap: selection.coverageMap }),
      ...(selection.importGraph === undefined ? {} : { importGraph: selection.importGraph }) });
    if (result.mode === "selected" && result.tests.length > 0) return { command: commandWithSelection(selection.command, template, result.tests), method, tests: result.tests };
  }
  const tests = [...new Set(selection.affectedTests)];
  const inventory = new Set(selection.inventory);
  if (tests.length === 0 || tests.length > 2_000 || tests.some((id) => !inventory.has(id) || !isRerunnableTestId(id) || id.includes(" ")) || tests.reduce((n, id) => n + Buffer.byteLength(id) + 1, 0) > 64 * 1024) return undefined;
  return { command: commandWithSelection(selection.command, template, tests), method: "affected", tests };
}

async function execute(runners: CheckRunners, command: ProjectCommand, ms: number, parent: AbortSignal, clock: () => number): Promise<{ outcome?: MutationOutcome; exitCode?: number | null; unconfirmedStop?: boolean }> {
  const started = clock(); const abort = new AbortController(); let expired = false;
  const stop = () => { expired = true; abort.abort(); };
  const timeout = setTimeout(stop, ms);
  parent.addEventListener("abort", stop, { once: true });
  try {
    if (parent.aborted) stop();
    // Await the runner's settlement after abort. The pinned runner can still settle before child
    // exit, so an aborted/timed-out result is NEVER a workspace-trust acknowledgement.
    const returned = abort.signal.aborted ? undefined : await runners.runProjectCommand({ ...command, timeoutSeconds: Math.max(1, Math.ceil(ms / 1_000)) }, abort.signal);
    if (expired || parent.aborted || returned?.timedOut === true) return { outcome: "timed_out", unconfirmedStop: true };
    if (clock() - started >= ms) return { outcome: "timed_out" };
    if (returned === undefined) return { outcome: "not_run" };
    return { exitCode: returned.exitCode };
  } catch (error) {
    // The runner-owner error carries quarantine state. It must reach the hook unchanged.
    if (error instanceof Error && (error.name === "RunnerKillUnconfirmedError" || error.constructor.name === "RunnerKillUnconfirmedError")) throw error;
    if (expired || parent.aborted) return { outcome: "timed_out", unconfirmedStop: true };
    throw error;
  } finally { clearTimeout(timeout); parent.removeEventListener("abort", stop); }
}

/** Fixed words/counts only; stdout, stderr, report names and source paths never cross this boundary. */
export async function runMutationSpotCheck(options: MutationSpotOptions): Promise<MutationSpotResult> {
  const limits = mutationLimits(options.limits); const clock = options.clock ?? (() => performance.now());
  const start = clock(); const abort = new AbortController(); const result = empty();
  // Small caller budgets still reserve half for integrity; ordinary runs reserve >= 10 seconds.
  const reserve = Math.min(limits.totalTimeMs / 2, Math.max(10_000, limits.totalTimeMs * 0.05));
  const workBudget = limits.totalTimeMs - reserve;
  const checkpoint = (budget = workBudget) => { if (abort.signal.aborted || !Number.isFinite(clock()) || clock() - start >= budget) throw new BudgetExpired(); };
  const integrityCheckpoint = () => checkpoint(limits.totalTimeMs);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let stop: () => void = () => undefined;
  const expired = new Promise<MutationSpotResult>((resolve) => {
    stop = () => { abort.abort(); resolve({ ...empty(), reason: "timed_out", mutants: result.mutants.map((m) => ({ ...m })) }); };
    timeout = setTimeout(stop, limits.totalTimeMs);
    options.signal?.addEventListener("abort", stop, { once: true });
  });
  const work = async (): Promise<MutationSpotResult> => {
    const before: CandidateSnapshot[] = [];
    let reason: MutationReason | undefined;
    let unconfirmedStop = false;
    let runDir: string | undefined;
    try {
      checkpoint();
      if (options.repositories.length === 0 || options.repositories.length > limits.maxFiles || options.selection.length !== options.repositories.length || typeof options.scratchRoot !== "string" || options.scratchRoot === "") throw new Error("mutation input refused");
      for (const repository of options.repositories) before.push(await snapshotCandidate(repository.directory, checkpoint));
      const files: Array<{ path: string; text: string }> = [];
      const ranges: MutationLines[] = [];
      const owners = new Map<string, { index: number; path: string }>();
      result.skippedLanguageFiles = 0;
      for (let index = 0; index < options.repositories.length; index += 1) {
        const repository = options.repositories[index]!; checkpoint();
        const changes = await candidateChanges({ directory: repository.directory, baseCommitSha: repository.startCommit, treeSha: repository.candidateTreeSha }, { exactLines: true });
        for (const change of changes) {
          if (mutationPathRefused(change.path)) { result.refusals.push({ reason: "path_refused", fingerprint: mutationPathFingerprint(change.path) }); reason = "path_refused"; continue; }
          if (mutationLanguage(change.path) === undefined) { result.skippedLanguageFiles += 1; continue; }
          if (change.status !== "ADDED" && change.status !== "MODIFIED" || change.hunks.length === 0 || files.length >= limits.maxFiles) continue;
          const text = await readMutationSource(repository.directory, change.path, limits.maxFileBytes, checkpoint);
          // The worker diff describes these exact bytes, not an agent's later working-tree edit.
          const pinned = await withIsolatedGit(repository.directory, "read", (git) => git.bytes(["cat-file", "blob", `${repository.candidateTreeSha}:${change.path}`], { index: "none", maxBuffer: limits.maxFileBytes, timeout: 10_000 }));
          if (!pinned.equals(Buffer.from(text))) throw new Error("candidate source changed");
          const path = `${index}/${files.length}${extname(change.path)}`;
          files.push({ path, text }); ranges.push({ path, hunks: change.hunks }); owners.set(path, { index, path: change.path });
        }
      }
      if (reason === undefined) {
        const plan = planMutants(files, ranges, options.seed, limits);
        reason = files.length === 0 && result.skippedLanguageFiles > 0 ? "unsupported_language" : plan.reason;
        if (plan.mutants.length > 0) {
          const scratchRoot = await realpath(options.scratchRoot);
          for (const repository of options.repositories) {
            const rel = relative(await realpath(repository.directory), scratchRoot);
            if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))) throw new Error("scratch parent refused");
          }
          runDir = await realpath(await mkdtemp(join(scratchRoot, "b11-mutation-")));
          const planned = plan.mutants.flatMap((mutant) => {
            const owner = owners.get(mutant.path)!;
            const selected = selectedCommand(options.selection[owner.index]!, owner.path);
            if (selected === undefined || reportSpecOf(selected.command) === undefined) { reason ??= "no_tests"; return []; }
            return [{ mutant, owner, selected, key: JSON.stringify([owner.index, selected.command]) }];
          });
          type Planned = (typeof planned)[number];
          const identity = (test: ReportedTest) => JSON.stringify([test.file ?? "", test.name]);
          const remaining = (command: ProjectCommand) => {
            checkpoint();
            return Math.min(limits.perMutantTimeMs, checkTimeLimitMs(command.timeoutSeconds, workBudget - (clock() - start)));
          };
          const runCopy = async (entry: Planned, mutate: boolean): Promise<{ outcome?: MutationOutcome; exitCode?: number | null; tests: ReportedTest[] }> => {
            checkpoint();
            const { owner, selected, mutant } = entry;
            const copy = await createMutationCopy(options.repositories[owner.index]!.directory, runDir!, checkpoint);
            let timedOut = false;
            try {
              const runners = options.runners(copy.directory, owner.index);
              const executeInCopy = async (command: ProjectCommand, ms: number) => {
                try { return await execute(runners, command, ms, abort.signal, clock); }
                catch (error) { timedOut = true; unconfirmedStop = true; throw error; }
              };
              if (mutate) {
                const original = files.find((file) => file.path === mutant.path)!.text;
                await writeScratchMutant(copy, { ...mutant, path: owner.path }, original);
                if (mutationLanguage(owner.path) === "python") {
                  // Isolated Python ignores PYTHONPYCACHEPREFIX/site hooks; py_compile writes only in the copy.
                  const parseCommand: ProjectCommand = { cwd: ".", executable: "python3", args: ["-I", "-S", "-m", "py_compile", owner.path], timeoutSeconds: 30 };
                  const parsed = await executeInCopy(parseCommand, remaining(parseCommand));
                  timedOut = parsed.outcome === "timed_out";
                  unconfirmedStop ||= parsed.unconfirmedStop === true;
                  if (parsed.outcome !== undefined || parsed.exitCode !== 0) return { outcome: parsed.outcome ?? "invalid", tests: [] };
                } else {
                  const extension = extname(owner.path).slice(1);
                  const loader: Loader = extension === "tsx" ? "tsx" : extension === "jsx" ? "jsx" : extension.endsWith("ts") ? "ts" : "js";
                  try { await transform(original.slice(0, mutant.start) + mutant.replacement + original.slice(mutant.end), { loader, logLevel: "silent" }); }
                  catch { return { outcome: "invalid", tests: [] }; }
                }
              }
              const spec = reportSpecOf(selected.command)!;
              await clearScratchReport(copy, selected.command.cwd, spec.argument);
              const ms = remaining(selected.command);
              const notBeforeMs = Date.now();
              const ran = await executeInCopy(selected.command, ms);
              timedOut = ran.outcome === "timed_out";
              unconfirmedStop ||= ran.unconfirmedStop === true;
              if (ran.outcome !== undefined) return { ...ran, tests: [] };
              checkpoint();
              const read = await readReportPartsFile({ root: copy.directory, cwd: selected.command.cwd, argument: spec.argument, notBeforeMs });
              const report = read.ok ? read.parts.tests : undefined;
              const tests = report === undefined ? [] : (await withTestIds(report, { root: copy.directory, cwd: selected.command.cwd })).tests;
              return { ...ran, tests };
            } finally {
              // A timeout can settle before a descendant exits. Only its owner may reclaim that copy.
              if (!timedOut) await discardMutationCopy(copy);
            }
          };
          const cleanControl = (ran: Awaited<ReturnType<typeof runCopy>>, expected: Set<string>): boolean =>
            ran.outcome === undefined && ran.exitCode === 0 && ran.tests.length === expected.size &&
            new Set(ran.tests.map(identity)).size === expected.size &&
            ran.tests.every((test) => test.status === "passed" && expected.has(identity(test)));
          const controls = new Map<string, Set<string>>();
          // All selected commands must pass on fresh, unmutated copies BEFORE the first mutation.
          for (const entry of planned) {
            if (controls.has(entry.key)) continue;
            const baseline = await runCopy(entry, false);
            const ids = new Set(baseline.tests.map(identity));
            const complete = entry.selected.tests.every((id) => baseline.tests.some((test) => test.file === id || `${test.file ?? ""}::${test.name}` === id));
            if (baseline.outcome !== undefined || baseline.exitCode !== 0 || baseline.tests.length === 0 || baseline.tests.some((test) => test.status !== "passed") || !complete || ids.size !== baseline.tests.length) { reason = "baseline_failed"; break; }
            controls.set(entry.key, ids);
          }
          if (reason !== "baseline_failed") for (const entry of planned) {
            const ran = await runCopy(entry, true);
            const baseline = controls.get(entry.key)!;
            let outcome: MutationOutcome = ran.outcome ?? "invalid";
            if (ran.outcome === undefined && new Set(ran.tests.map(identity)).size === ran.tests.length) {
              if (ran.tests.some((test) => test.status === "failed" && baseline.has(identity(test)))) {
                // Re-run the same selected command on another pristine copy. Source-independent
                // failures must not become catches merely because one earlier control passed.
                const recheck = await runCopy(entry, false);
                outcome = recheck.outcome ?? (cleanControl(recheck, baseline) ? "caught" : "invalid");
              }
              else if (ran.exitCode === 0 && ran.tests.length === baseline.size && ran.tests.every((test) => test.status === "passed" && baseline.has(identity(test))) && new Set(ran.tests.map(identity)).size === baseline.size) outcome = "survived";
            }
            result.mutants.push({ line: entry.mutant.line, operator: entry.mutant.operator, outcome, method: entry.selected.method });
            if (outcome === "caught") result.caught += 1;
            if (outcome === "caught" || outcome === "survived") result.counted += 1;
            if (outcome === "timed_out") { reason = "timed_out"; break; }
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && (error.name === "RunnerKillUnconfirmedError" || error.constructor.name === "RunnerKillUnconfirmedError")) throw error;
      reason = error instanceof BudgetExpired ? "timed_out" : error instanceof MutationCopyTooLarge ? "repo_too_large" : "unreadable"; }
    finally { if (runDir !== undefined) await rmdir(runDir).catch(() => undefined); }
    // No command or mutation is possible before every initial snapshot succeeds.
    if (before.length !== options.repositories.length || before.length === 0) return { ...result, reason: reason ?? "unreadable", trustedAfter: true };
    try {
      integrityCheckpoint();
      for (let index = 0; index < before.length; index += 1) {
        const after = await snapshotCandidate(options.repositories[index]!.directory, integrityCheckpoint);
        if (after.digest !== before[index]!.digest || after.status !== before[index]!.status) throw new Error("candidate changed");
      }
      result.trustedAfter = !unconfirmedStop;
      if (unconfirmedStop) reason = "timed_out";
    } catch (error) { result.trustedAfter = false; reason = error instanceof BudgetExpired ? "timed_out" : "candidate_changed"; }
    if (!result.trustedAfter) { result.caught = 0; result.counted = 0; }
    result.status = result.trustedAfter && result.counted > 0 && reason !== "unreadable" ? "completed" : "not_run";
    if (result.status === "completed" && reason === "timed_out") reason = "partial";
    if (reason !== undefined) result.reason = reason;
    else if (result.status === "not_run") result.reason = result.mutants.length > 0 ? "no_results" : "no_tests";
    return result;
  };
  try {
    if (options.signal?.aborted === true) stop();
    return await Promise.race([work(), expired]);
  } finally { clearTimeout(timeout); options.signal?.removeEventListener("abort", stop); }
}
