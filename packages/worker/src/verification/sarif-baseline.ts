// Proof and evidence P4: the baseline of a scanner's findings. "New" findings need the same tool's findings on the code the task started from, so the SARIF-writing checks are run once more with every
// repository showing its original code (the same mechanism TESTPROOF uses for the tests, original-code.ts), their own commands unchanged, and the SARIF file each wrote is read. The candidate's own file is
// put back as the candidate's run left it, whatever happens.
//
// Informational: a skipped or failed baseline is only "no baseline" (the findings are then not reported at all, never reported as clean), and it never changes a check result. The one fault that is not
// survivable is failing to put the agent's files back (AgentFilesRestoreError), which is rethrown exactly as TESTPROOF rethrows it. The run is bounded by what is left of the check round's budget.
import { lstat, unlink, writeFile } from "node:fs/promises";
import type { ProjectCommand } from "@agentx/contracts";
import { runChecks, type CheckPlan, type CheckRunners } from "./checks.js";
import { isUnconfirmedStop, isWorkspaceUnsafe, gitOriginalCode, type OriginalCode, type OriginalCodeRepository } from "./original-code.js";
import { containedReportPath, readContainedReport } from "./report-file.js";
import { SARIF_REPORT_MAX_BYTES } from "./sarif.js";

/** Less budget than this left and the baseline is not started: it could not finish a real scan. */
export const MIN_BASELINE_BUDGET_MS = 60_000;
/** The whole baseline run gets at most this long. */
export const BASELINE_CAP_MS = 10 * 60_000;

export interface BaselineScan {
  /** The index of the command in the round's project checks. */
  index: number;
  command: ProjectCommand;
  /** The SARIF path as the command names it (relative to the command's cwd), and the real path the candidate's run wrote it at. */
  argument: string;
  path: string;
  /** The file as the candidate's run left it, put back after the baseline run. */
  candidateBytes: Buffer;
}
export interface BaselineRun {
  rootPath: string;
  runners: CheckRunners;
  signal: AbortSignal;
  /** What is left of the check round's budget. */
  budgetMs: number;
  capMs?: number;
  repositories: readonly OriginalCodeRepository[];
  /** Tests supply a fake. Default: the real swap (gitOriginalCode). */
  originalCode?: (repositories: OriginalCodeRepository[]) => OriginalCode;
  now?: () => number;
}

/** Puts the candidate's file back as the candidate's run left it: only through the same real path inside the workspace, and a link left in its place is replaced, never followed. */
async function putBack(rootPath: string, scan: BaselineScan): Promise<void> {
  try {
    const contained = await containedReportPath(rootPath, scan.command.cwd, scan.argument, { allowLink: true });
    if (contained === undefined || (contained !== "missing" && contained.path !== scan.path)) return;
    const now = await lstat(scan.path).catch(() => undefined);
    if (now?.isSymbolicLink() === true) await unlink(scan.path);
    await writeFile(scan.path, scan.candidateBytes);
  } catch { /* a file that cannot be put back is only a stale report */ }
}

/**
 * The SARIF text each scan wrote on the original code, by command index. A scan whose run did not end, whose file is missing, unsafe or too large, or that ran out of time is absent from the map. Never throws,
 * except `AgentFilesRestoreError`.
 */
export async function runBaselineScans(scans: readonly BaselineScan[], run: BaselineRun): Promise<Map<number, string>> {
  const found = new Map<number, string>();
  const now = run.now ?? Date.now;
  if (scans.length === 0 || run.signal.aborted || run.budgetMs < MIN_BASELINE_BUDGET_MS || run.repositories.length === 0) return found;
  const subPlan: CheckPlan = { source: "project", readiness: scans.map((scan) => scan.command), projectBefore: scans.map(() => "unknown" as const) };
  const originalCode = (run.originalCode ?? gitOriginalCode)(run.repositories.map((repository) => ({ directory: repository.directory, commit: repository.commit })));
  // A stop that could not be confirmed: the scan files are not put back either, because a command that may still be running would write over them.
  let unconfirmedStop = false;
  try {
    await originalCode.run(async () => {
      // A file the candidate's run left is removed first, so one the baseline run did not write is never read as its result.
      for (const scan of scans) await unlink(scan.path).catch(() => undefined);
      const startedAt = now();
      const round = await runChecks(subPlan, run.runners, { budgetMs: Math.max(0, Math.min(run.capMs ?? BASELINE_CAP_MS, run.budgetMs)), signal: run.signal });
      for (const [position, scan] of scans.entries()) {
        const entry = round.entries[position];
        // A scanner that found something usually exits non-zero: a finished run is a run, whatever its code. One that timed out, was stopped or never ran has no baseline.
        if (entry === undefined || (entry.after !== "passed" && entry.after !== "failed")) continue;
        const read = await readContainedReport({ root: run.rootPath, cwd: scan.command.cwd, argument: scan.argument, maxBytes: SARIF_REPORT_MAX_BYTES, notBeforeMs: startedAt });
        if (read.ok) found.set(scan.index, read.bytes.toString("utf8"));
      }
    });
  } catch (error) {
    // The one fault that must stop the task: the agent's files are not back.
    if (isWorkspaceUnsafe(error)) {
      unconfirmedStop = isUnconfirmedStop(error);
      throw error;
    }
    found.clear();
  } finally {
    if (!unconfirmedStop) for (const scan of scans) await putBack(run.rootPath, scan);
  }
  return found;
}
