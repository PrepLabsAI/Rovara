// TE-C6: the ONE rerun of a failing test in a task round. A test check that passed before and fails now has its failing TESTS rerun once, through the round's own runners and inside the round's budget and signal. A test that passes on
// the rerun is FLAKY: it is not sent to the agent as a regression (extension.ts) and is named in the evidence (evidence-raw.ts). A test that fails again stays a failure, exactly as without this module.
//
// What this module never does:
//   - change a check's entry: `class` stays `regression` and `after` stays `failed`, so the broker never reads a flaky failure as a pass (the CheckReport schema is not touched);
//   - call anything flaky that was not rerun and seen passing: a rerun that timed out, ran out of budget, was stopped, wrote no fresh report, wrote an unreadable one, or left a test out of its report leaves that test FAILING;
//   - rerun a check that has no approved `{tests}` template (`selectArgs`), a runner whose syntax is not known (`rerunCommandsOf`), a check the agent ran itself (`source: "agent_commands"`), or more than `FLAKY_RERUN_IDS_MAX`
//     failing tests (that many failures are a regression, not bad luck). Their failures stand and are never called flaky: the same rule as the nightly run (nightly-run.ts), whose command builders this reuses;
//   - pass a test id that is not `isRerunnableTestId` (ids that start with `-` or `@` would read as options): such a check is not rerun at all, as separate arguments with no shell otherwise.
// The rerun writes the check's own report file again (a narrower one), so the first report's bytes are put back afterwards; a file that cannot be put back drops the whole result (nothing is called flaky).
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { FLAKY_RERUN_ARTIFACT, FLAKY_ON_RERUN_MAX, FlakyRerunFileSchema, isRerunnableTestId, type CheckEntry, type FlakyRerunFile, type ProjectCommand } from "@agentx/contracts";
import { runChecks, type CheckRunners } from "./checks.js";
import { readCheckTests } from "./check-tests.js";
import { containedReportPath } from "./report-file.js";
import { commandWithSelection } from "./selection.js";
import { RERUN_COMMANDS_MAX, rerunCommandsOf } from "./test-ids.js";
import { reportSpecOf } from "./test-proof.js";
import { isFailingState, splitFailures, testStatesOf, type TestState } from "./test-states.js";

/** The most failing tests of one check that are rerun; more than this is a regression, not flakiness. */
export const FLAKY_RERUN_IDS_MAX = RERUN_COMMANDS_MAX;
/** Less budget than this left, and a rerun command is not started: it could not finish (as `runChecks`' own start rule). */
const MIN_RERUN_START_MS = 1_000;

/** What the plan says about check `i` (its `checks[i]`): the kind, and the `{tests}` template the maintainer approved. */
export interface FlakyCheckSpec { kind: string; selectArgs?: readonly string[] | undefined }

export interface FlakyRerunInput {
  rootPath: string;
  /** The round's readiness commands, as the project sent them (not narrowed to a selection): `readiness:<i>` is `commands[i]`. */
  commands: readonly ProjectCommand[];
  /** The plan's checks: `checks[i]` describes `commands[i]` for the environment's own checks. */
  checks: readonly FlakyCheckSpec[];
  /** The round's entries, as `runChecks` made them. */
  entries: readonly CheckEntry[];
  runners: CheckRunners;
  /** When the round began (ms since the epoch): the first report must have been written at or after it. */
  roundStartedAtMs: number;
  /** The round's budget that is left. The rerun never takes more. */
  budgetMs: number;
  signal: AbortSignal;
  now?: () => number;
}

/** One rerun check: the failing tests that passed on the rerun, and those still failing (a test missing from the rerun report is still failing). */
export interface FlakyCheckResult { checkId: string; flaky: string[]; failing: string[] }
/** The result, by check id. A check that was not rerun, or whose rerun could not be trusted, has no entry. */
export type FlakyRerunResult = ReadonlyMap<string, FlakyCheckResult>;

/** A check is fully flaky only when it had failing tests and EVERY one passed on the rerun. */
export const isFullyFlaky = (result: FlakyCheckResult | undefined): boolean => result !== undefined && result.flaky.length > 0 && result.failing.length === 0;

/**
 * What the worker saves for the broker (`flaky-rerun.json`): only the checks that are FULLY flaky, each with the tests that passed on the rerun. Undefined when there is none (no file is saved, so the broker has nothing
 * to excuse). A check whose flaky list is longer than the file's bound is left out: the broker then keeps its failure.
 */
export function flakyRerunFileOf(result: FlakyRerunResult | undefined): { name: typeof FLAKY_RERUN_ARTIFACT; content: string } | undefined {
  if (result === undefined) return undefined;
  const checks = [...result.values()].filter(isFullyFlaky).filter((check) => check.flaky.length <= FLAKY_ON_RERUN_MAX).map((check) => ({ checkId: check.checkId, flaky: check.flaky }));
  if (checks.length === 0) return undefined;
  const file: FlakyRerunFile = { schemaVersion: 1, checks };
  return FlakyRerunFileSchema.safeParse(file).success ? { name: FLAKY_RERUN_ARTIFACT, content: JSON.stringify(file) } : undefined;
}

const READINESS_ID = /^readiness:(\d{1,3})$/u;

export async function rerunFlaky(input: FlakyRerunInput): Promise<FlakyRerunResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const out = new Map<string, FlakyCheckResult>();
  for (const entry of input.entries) {
    if (input.signal.aborted) return new Map();
    if (entry.class !== "regression" || entry.after !== "failed" || entry.source !== "project") continue;
    const matched = READINESS_ID.exec(entry.id);
    if (matched === null) continue;
    const index = Number(matched[1]);
    const check = input.checks[index];
    const command = input.commands[index];
    if (check === undefined || command === undefined || check.kind !== "test" || check.selectArgs === undefined) continue;
    const left = input.budgetMs - (now() - startedAt);
    if (left < MIN_RERUN_START_MS) break;
    try {
      const result = await rerunCheck(input, entry.id, command, check.selectArgs, left, now);
      if (result !== undefined) out.set(entry.id, result);
    } catch {
      // A fault in the rerun leaves the check failing: no entry.
    }
  }
  return input.signal.aborted ? new Map() : out;
}

async function rerunCheck(input: FlakyRerunInput, checkId: string, command: ProjectCommand, selectArgs: readonly string[], budgetMs: number, now: () => number): Promise<FlakyCheckResult | undefined> {
  const first = await readCheckTests(input.rootPath, command, { notBeforeMs: input.roundStartedAtMs });
  if (first?.file === undefined) return undefined;
  const failingIds = [...testStatesOf(first.report)].filter(([, state]) => isFailingState(state)).map(([id]) => id).sort();
  // No failing test in the report (a build or collection error, a hook): nothing to rerun, nothing flaky. Any failing id that is not rerunnable, or too many: the failures stand.
  if (failingIds.length === 0 || failingIds.length > FLAKY_RERUN_IDS_MAX || !failingIds.every(isRerunnableTestId)) return undefined;
  const commands = rerunCommandsOf({ command, selectArgs }, failingIds, (base, args, ids) => commandWithSelection(base, args, ids, isRerunnableTestId));
  if (commands === undefined) return undefined;
  const startedAt = now();
  const again = new Map<string, TestState>();
  let result: FlakyCheckResult | undefined;
  try {
    for (const rerun of commands) {
      const left = budgetMs - (now() - startedAt);
      if (input.signal.aborted || left < MIN_RERUN_START_MS) break;
      const wrote = Date.now();
      const round = await runChecks({ source: "project", readiness: [rerun], projectBefore: ["passed"] }, input.runners, { budgetMs: left, signal: input.signal, now });
      if (round.stopped || input.signal.aborted) return undefined;
      // A rerun that timed out, ran out of budget or never ran shows nothing as fixed; one that wrote nothing fresh and readable does not either.
      const ran = round.entries[0];
      if (ran === undefined || (ran.after !== "passed" && ran.after !== "failed")) continue;
      const second = await readCheckTests(input.rootPath, rerun, { notBeforeMs: wrote });
      if (second === undefined) continue;
      for (const [id, state] of testStatesOf(second.report)) again.set(id, state);
    }
    // Only a test the rerun report lists AND passed is flaky: a missing, failed, errored or skipped one stays failing.
    const stillFailing = failingIds.filter((id) => again.get(id) !== "passed");
    const split = splitFailures(failingIds, stillFailing);
    result = { checkId, flaky: split.flaky, failing: split.failed };
  } finally {
    // The rerun overwrote the check's report with a narrower one: put the first report back, or trust nothing.
    if (!(await restoreReport(input.rootPath, command, first.file))) result = undefined;
  }
  return input.signal.aborted ? undefined : result;
}

/** Writes the first report's bytes back to the same contained path (never through a link). False when it cannot be done. */
async function restoreReport(rootPath: string, command: ProjectCommand, file: { path: string; bytes: Buffer }): Promise<boolean> {
  try {
    const spec = reportSpecOf(command);
    if (spec === undefined) return false;
    const contained = await containedReportPath(rootPath, command.cwd, spec.argument);
    if (contained === undefined || (contained !== "missing" && contained.path !== file.path)) return false;
    const handle = await open(file.path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
    try { await handle.writeFile(file.bytes); } finally { await handle.close(); }
    return true;
  } catch {
    return false;
  }
}
