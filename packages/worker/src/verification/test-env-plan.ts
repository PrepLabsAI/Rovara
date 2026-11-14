// Test environment (wire-testenv): the worker's half of "a task's checks use the project's approved test setup". A verification run that carries the environment's plan (`testEnvironment`) has its first commands be
// the environment's checks. This applies the plan to them: for each TEST check it decides, from the diff the worker computes ITSELF (never the agent's claim), whether to run the selected tests or the whole check, and
// it sets the round's budget. The customer's own command is never rewritten: selected tests are added only in the place the maintainer approved (`selectArgs`, `{tests}` exactly once), and a check with no template
// runs in full.
//
// Fail closed, every time something is not known:
//   - the diff cannot be read, or it touches more than one repository: every test check runs in full (`unknown_file`);
//   - no coverage map was sent (none is produced yet), a map older than 7 days, a changed file the method does not know, a path that changes what every test means: the whole check, with the reason (selection.ts);
//   - a selection that picked no test at all is NOT "run nothing": it is the whole check (`unknown_file`), because an argument-less command runs every test and must not be reported as zero;
//   - a plan that does not fit the commands the run was sent (fewer commands than the plan has checks) is ignored whole, and the run goes as it was sent.
// The result says what ran, in the evidence's own words ("37 of 1,240, coverage map, 14 hours old", or "the whole check, map missing"); the broker checks it against the reports it reads.
import { TEST_ENV_SELECT_PLACEHOLDER, type CandidateRepository, type EvidenceSelectionSchema, type ProjectCommand, type TestEnvTaskPlan, type TestEnvironmentBody } from "@agentx/contracts";
import type { z } from "zod";
import { candidateChanges } from "./diff.js";
import { checkRoundBudgetMs, planSelections, type ChangedPath, type CheckSelectionPlan, type CoverageMap } from "./selection.js";

type EvidenceSelection = z.infer<typeof EvidenceSelectionSchema>;
const HEX_OBJECT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

export interface AppliedTestEnvPlan {
  /** The commands to run: the run's own, with the environment's test checks narrowed where the plan allows. Same length, same order. */
  readiness: ProjectCommand[];
  /** The round's time budget. */
  budgetMs: number;
  /** What ran, for the evidence; undefined when nothing was selected and nothing fell back. */
  selection: EvidenceSelection | undefined;
  revision: number;
  digest: string;
}

/** The changes of the candidate against where the task started, in the shape selection reads, or undefined when they cannot be known (a repository's diff failed) or span more than one repository. */
async function changesOf(input: { repositories: ReadonlyArray<{ repositoryId: string; directory: string; baseCommitSha?: string | undefined }>; candidateBefore: ReadonlyArray<CandidateRepository> }): Promise<ChangedPath[] | undefined> {
  const changed: ChangedPath[][] = [];
  for (const repository of input.repositories) {
    const treeSha = input.candidateBefore.find((entry) => entry.repositoryId === repository.repositoryId)?.treeSha;
    if (repository.baseCommitSha === undefined || !HEX_OBJECT.test(repository.baseCommitSha) || treeSha === undefined || !HEX_OBJECT.test(treeSha)) return undefined;
    let changes;
    try { changes = await candidateChanges({ directory: repository.directory, baseCommitSha: repository.baseCommitSha, treeSha }); } catch { return undefined; }
    if (changes.length > 0) changed.push(changes.map((change) => ({ path: change.path, status: change.status === "ADDED" ? "added" as const : change.status === "DELETED" ? "deleted" as const : "modified" as const })));
  }
  // Paths in the map and in the globs are a repository's own: with changes in two repositories they cannot be told apart, so nothing is selected.
  return changed.length > 1 ? undefined : changed[0] ?? [];
}

function aggregate(entries: ReadonlyArray<EvidenceSelection>): EvidenceSelection | undefined {
  if (entries.length === 0) return undefined;
  const down = entries.filter((entry) => entry.selected < entry.total);
  if (down.length > 0) {
    const ages = down.map((entry) => entry.mapAgeHours).filter((age): age is number => age !== undefined);
    return { method: down[0]!.method, selected: down.reduce((sum, entry) => sum + entry.selected, 0), total: down.reduce((sum, entry) => sum + entry.total, 0), ...(ages.length === 0 ? {} : { mapAgeHours: Math.max(...ages) }) };
  }
  const reason = entries.find((entry) => entry.fallbackReason !== undefined)?.fallbackReason;
  return reason === undefined ? undefined : { method: "full", selected: 0, total: 0, fallbackReason: reason };
}

export async function applyTestEnvironmentPlan(input: {
  readiness: readonly ProjectCommand[];
  plan: TestEnvTaskPlan;
  repositories: ReadonlyArray<{ repositoryId: string; directory: string; baseCommitSha?: string | undefined }>;
  candidateBefore: ReadonlyArray<CandidateRepository>;
  now: Date;
}): Promise<AppliedTestEnvPlan | undefined> {
  const { plan } = input;
  if (input.readiness.length < plan.checks.length) return undefined;
  const budgetMs = checkRoundBudgetMs({ roundBudgetMin: plan.roundBudgetMin });
  const checks = plan.checks.map((check, index) => ({ id: check.id, label: check.id, kind: check.kind, command: input.readiness[index]!, ...(check.selectArgs === undefined ? {} : { selectArgs: check.selectArgs }) }));
  const environment = { selection: plan.selection, repos: [{ repositoryId: "plan", setupCommands: [], checks }] } as unknown as Pick<TestEnvironmentBody, "selection" | "repos">;
  const changes = await changesOf(input);
  const map: CoverageMap | undefined = plan.coverageMap === undefined ? undefined : { builtAt: plan.coverageMap.builtAt, files: plan.coverageMap.files };
  const inventory = map === undefined ? undefined : [...new Set(Object.values(map.files).flat())];
  let plans: Map<string, CheckSelectionPlan>;
  if (changes === undefined) {
    // Not known what changed: every check as it was sent, and the test checks say so.
    plans = new Map(checks.map((check) => [check.id, check.kind === "test" && !plan.selection.alwaysRun.includes(check.id) ? { command: check.command, selection: { method: "full" as const, selected: 0, total: 0, fallbackReason: "unknown_file" as const } } : { command: check.command }]));
  } else {
    plans = planSelections(environment, { changes, now: input.now, inventoryOf: () => inventory, coverageMap: map, lastNightlyFailures: plan.lastNightlyFailures });
    // A selection that is the same command as the whole check, or that picked no test, is the whole check.
    for (const check of checks) {
      const planned = plans.get(check.id);
      if (planned?.selection === undefined || planned.selection.fallbackReason !== undefined) continue;
      const unchanged = JSON.stringify(planned.command) === JSON.stringify(check.command);
      if (unchanged || planned.selection.selected === 0) plans.set(check.id, { command: check.command, selection: { method: "full", selected: 0, total: 0, fallbackReason: "unknown_file" } });
    }
  }
  const readiness = input.readiness.map((command, index) => (index < plan.checks.length ? plans.get(plan.checks[index]!.id)?.command ?? command : command));
  // The approved placeholder is never left in a command, whatever happened above.
  if (readiness.some((command) => command.args.includes(TEST_ENV_SELECT_PLACEHOLDER))) return undefined;
  return { readiness, budgetMs, selection: aggregate([...plans.values()].flatMap((entry) => (entry.selection === undefined ? [] : [entry.selection]))), revision: plan.revision, digest: plan.digest };
}
