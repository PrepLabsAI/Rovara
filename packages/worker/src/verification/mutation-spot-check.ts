// Additive: no run-task hook, evidence producer or Cloud mirror. Q1: each mutant gets a NEW copy,
// and a NEW CheckRunners binding to that copy. A late writer never receives the candidate as cwd.
// The runner factory is trusted worker plumbing: it must isolate/mount this root, not close over the
// candidate or give test programs access to it. This module is not itself a process/network sandbox.
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { reportSpecOf } from "./test-proof.js";
import { clearScratchReport, createMutationCopy, readMutationSource, snapshotCandidate, writeScratchMutant, type CandidateSnapshot } from "./mutation-restore.js";

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
  /** Worker-owned scratch parent outside all candidate trees; defaults to the OS temporary directory. */
  scratchRoot?: string;
  signal?: AbortSignal;
}
class BudgetExpired extends Error {}
const empty = (): MutationSpotResult => ({ status: "not_run", trustedAfter: false, caught: 0, counted: 0, mutants: [], refusals: [] });

function selectedCommand(selection: MutationSelection, path: string): { command: ProjectCommand; method: MutationMethod } | undefined {
  const template = selection.check.selectArgs;
  if (template === undefined || template.filter((arg) => arg === "{tests}").length !== 1) return undefined;
  const common = { check: selection.check, changes: [{ path, status: "modified" as const }], inventory: selection.inventory, now: new Date() };
  for (const method of ["coverage_map", "import_graph"] as const) {
    const result = selectTests({ ...common, config: { method, alwaysRun: [], fullSuiteOn: [] },
      ...(selection.coverageMap === undefined ? {} : { coverageMap: selection.coverageMap }),
      ...(selection.importGraph === undefined ? {} : { importGraph: selection.importGraph }) });
    if (result.mode === "selected" && result.tests.length > 0) return { command: commandWithSelection(selection.command, template, result.tests), method };
  }
  const tests = [...new Set(selection.affectedTests)];
  const inventory = new Set(selection.inventory);
  if (tests.length === 0 || tests.length > 2_000 || tests.some((id) => !inventory.has(id) || !isRerunnableTestId(id) || id.includes(" ")) || tests.reduce((n, id) => n + Buffer.byteLength(id) + 1, 0) > 64 * 1024) return undefined;
  return { command: commandWithSelection(selection.command, template, tests), method: "affected" };
}

async function execute(runners: CheckRunners, command: ProjectCommand, ms: number, parent: AbortSignal, clock: () => number): Promise<{ outcome?: MutationOutcome; exitCode?: number | null }> {
  const started = clock(); const abort = new AbortController(); let expired = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let stop: () => void = () => undefined;
  const timed = new Promise<undefined>((resolve) => {
    stop = () => { expired = true; abort.abort(); resolve(undefined); };
    timeout = setTimeout(stop, ms);
    parent.addEventListener("abort", stop, { once: true });
  });
  try {
    if (parent.aborted) stop();
    const returned = await Promise.race([
      Promise.resolve().then(() => abort.signal.aborted ? undefined : runners.runProjectCommand({ ...command, timeoutSeconds: Math.max(1, Math.ceil(ms / 1_000)) }, abort.signal)).catch(() => undefined), timed,
    ]);
    if (expired || parent.aborted || clock() - started >= ms || returned?.timedOut === true) { abort.abort(); return { outcome: "timed_out" }; }
    if (returned === undefined) return { outcome: "not_run" };
    return { exitCode: returned.exitCode };
  } finally { clearTimeout(timeout); parent.removeEventListener("abort", stop); }
}

/** Fixed words/counts only; stdout, stderr, report names and source paths never cross this boundary. */
export async function runMutationSpotCheck(options: MutationSpotOptions): Promise<MutationSpotResult> {
  const limits = mutationLimits(options.limits); const clock = options.clock ?? (() => performance.now());
  const start = clock(); const abort = new AbortController(); const result = empty();
  const checkpoint = () => { if (abort.signal.aborted || !Number.isFinite(clock()) || clock() - start >= limits.totalTimeMs) throw new BudgetExpired(); };
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
    try {
      checkpoint();
      if (options.repositories.length === 0 || options.repositories.length > limits.maxFiles || options.selection.length !== options.repositories.length) throw new Error("mutation input refused");
      for (const repository of options.repositories) before.push(await snapshotCandidate(repository.directory, checkpoint));
      const files: Array<{ path: string; text: string }> = [];
      const ranges: MutationLines[] = [];
      const owners = new Map<string, { index: number; path: string }>();
      for (let index = 0; index < options.repositories.length; index += 1) {
        const repository = options.repositories[index]!; checkpoint();
        const changes = await candidateChanges({ directory: repository.directory, baseCommitSha: repository.startCommit, treeSha: repository.candidateTreeSha }, { exactLines: true });
        for (const change of changes) {
          if (mutationPathRefused(change.path)) { result.refusals.push({ reason: "path_refused", fingerprint: mutationPathFingerprint(change.path) }); reason = "path_refused"; continue; }
          if (mutationLanguage(change.path) === undefined) { reason ??= "unsupported_language"; continue; }
          if (change.status !== "ADDED" && change.status !== "MODIFIED" || change.hunks.length === 0 || files.length >= limits.maxFiles) continue;
          const text = await readMutationSource(repository.directory, change.path, limits.maxFileBytes, checkpoint);
          // The worker diff describes these exact bytes, not an agent's later working-tree edit.
          const pinned = await withIsolatedGit(repository.directory, "read", (git) => git.bytes(["cat-file", "blob", `${repository.candidateTreeSha}:${change.path}`], { index: "none", maxBuffer: limits.maxFileBytes, timeout: 10_000 }));
          if (!pinned.equals(Buffer.from(text))) throw new Error("candidate source changed");
          // Numeric planning aliases keep the repo prefix out of the untrusted path-length limit.
          const path = `${index}/${files.length}${extname(change.path)}`;
          files.push({ path, text }); ranges.push({ path, hunks: change.hunks }); owners.set(path, { index, path: change.path });
        }
      }
      if (reason === undefined) {
        const plan = planMutants(files, ranges, options.seed, limits);
        reason = plan.reason;
        if (plan.mutants.length > 0) {
          const scratchRoot = await realpath(options.scratchRoot ?? tmpdir());
          // Validate against ALL candidates before even creating a temporary directory.
          for (const repository of options.repositories) {
            const rel = relative(await realpath(repository.directory), scratchRoot);
            if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))) throw new Error("scratch parent refused");
          }
          const runDir = await realpath(await mkdtemp(join(scratchRoot, "b11-mutation-")));
          for (const mutant of plan.mutants) {
            checkpoint();
            const owner = owners.get(mutant.path)!;
            const selected = selectedCommand(options.selection[owner.index]!, owner.path);
            if (selected === undefined) { reason ??= "no_tests"; continue; }
            const spec = reportSpecOf(selected.command);
            if (spec === undefined) { reason ??= "no_tests"; continue; }
            const repository = options.repositories[owner.index]!;
            const copy = await createMutationCopy(repository.directory, runDir, checkpoint);
            const original = files.find((file) => file.path === mutant.path)!.text;
            await writeScratchMutant(copy, { ...mutant, path: owner.path }, original);
            await clearScratchReport(copy, selected.command.cwd, spec.argument);
            checkpoint();
            const ms = Math.min(limits.perMutantTimeMs, checkTimeLimitMs(selected.command.timeoutSeconds, limits.totalTimeMs - (clock() - start)));
            if (!Number.isFinite(ms) || ms <= 0) throw new BudgetExpired();
            const notBeforeMs = Date.now();
            const ran = await execute(options.runners(copy.directory, owner.index), selected.command, ms, abort.signal, clock);
            let outcome: MutationOutcome = ran.outcome ?? "invalid";
            if (ran.outcome === undefined) {
              checkpoint();
              const read = await readReportPartsFile({ root: copy.directory, cwd: selected.command.cwd, argument: spec.argument, notBeforeMs });
              const tests = read.ok ? read.parts.tests?.tests ?? [] : [];
              if (tests.some((test) => test.status === "failed")) outcome = "caught";
              else if (ran.exitCode === 0 && tests.length > 0 && tests.every((test) => test.status === "passed")) outcome = "survived";
            }
            result.mutants.push({ line: mutant.line, operator: mutant.operator, outcome, method: selected.method });
            if (outcome === "caught") result.caught += 1;
            if (outcome === "caught" || outcome === "survived") result.counted += 1;
            // No reuse, restore or awaited deletion: even a returned runner can have left descendants.
            // Task scratch reclamation owns these copies after the execution owner has stopped its writers.
            if (outcome === "timed_out") { reason = "timed_out"; break; }
          }
        }
      }
    } catch (error) { reason = error instanceof BudgetExpired ? "timed_out" : "unreadable"; }
    // Checking after a failure is still mandatory. If the budget cannot cover it, do not trust the candidate.
    try {
      checkpoint();
      if (before.length !== options.repositories.length || before.length === 0) throw new Error("no initial fingerprint");
      for (let index = 0; index < before.length; index += 1) {
        const after = await snapshotCandidate(options.repositories[index]!.directory, checkpoint);
        if (after.digest !== before[index]!.digest || after.status !== before[index]!.status) throw new Error("candidate changed");
      }
      result.trustedAfter = true;
    } catch (error) { result.trustedAfter = false; reason = error instanceof BudgetExpired ? "timed_out" : "candidate_changed"; }
    if (!result.trustedAfter) { result.caught = 0; result.counted = 0; }
    result.status = result.trustedAfter && result.counted > 0 && reason !== "unreadable" ? "completed" : "not_run";
    if (reason !== undefined) result.reason = reason;
    else if (result.status === "not_run") result.reason = result.mutants.length > 0 ? "no_results" : "no_tests";
    return result;
  };
  try {
    if (options.signal?.aborted === true) stop();
    return await Promise.race([work(), expired]);
  } finally { clearTimeout(timeout); options.signal?.removeEventListener("abort", stop); }
}
