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
import { deriveRepositoryFacts, type RepositoryFacts } from "../multi-repo-edges.js";
import { candidateChanges } from "./diff.js";
import { MULTI_REPO_SELECTION_LIVE, planRepositorySelections, type SelectionFacts } from "./multi-repo-selection.js";
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

/** The changes of the candidate against where the task started, by repository (only a repository with a change appears), or undefined when they cannot be known (a repository's diff failed). */
async function changesOf(input: { repositories: ReadonlyArray<{ repositoryId: string; directory: string; baseCommitSha?: string | undefined }>; candidateBefore: ReadonlyArray<CandidateRepository> }): Promise<Map<string, ChangedPath[]> | undefined> {
  const changed = new Map<string, ChangedPath[]>();
  for (const repository of input.repositories) {
    const treeSha = input.candidateBefore.find((entry) => entry.repositoryId === repository.repositoryId)?.treeSha;
    if (repository.baseCommitSha === undefined || !HEX_OBJECT.test(repository.baseCommitSha) || treeSha === undefined || !HEX_OBJECT.test(treeSha)) return undefined;
    let changes;
    try { changes = await candidateChanges({ directory: repository.directory, baseCommitSha: repository.baseCommitSha, treeSha }); } catch { return undefined; }
    if (changes.length > 0) changed.set(repository.repositoryId, changes.map((change) => ({ path: change.path, status: change.status === "ADDED" ? "added" as const : change.status === "DELETED" ? "deleted" as const : "modified" as const })));
  }
  return changed;
}

/**
 * The dependency facts of the repositories (their own manifests, base and candidate), within a short budget: they only decide what may be skipped, so a derivation that cannot finish is "no facts" and the whole check runs.
 * Never throws.
 */
async function derivedFacts(repositories: ReadonlyArray<{ repositoryId: string; directory: string; baseCommitSha?: string | undefined }>): Promise<RepositoryFacts | undefined> {
  const deadline = Date.now() + FACTS_MAX_MS;
  try {
    return await deriveRepositoryFacts(repositories.map((repository) => ({ name: repository.repositoryId, directory: repository.directory, baseCommit: repository.baseCommitSha ?? "" })), { signal: AbortSignal.timeout(FACTS_MAX_MS), remainingMs: () => deadline - Date.now() });
  } catch { return undefined; }
}
/** The most the derivation of the dependency facts may take. */
const FACTS_MAX_MS = 15_000;

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
  /** TE-MR2b, tests only: the switch and the facts' source. Production takes `MULTI_REPO_SELECTION_LIVE` and the repositories' own manifests. */
  multiRepo?: { live?: boolean | undefined; derive?: ((repositories: ReadonlyArray<{ repositoryId: string; directory: string; baseCommitSha?: string | undefined }>) => Promise<SelectionFacts | undefined>) | undefined } | undefined;
}): Promise<AppliedTestEnvPlan | undefined> {
  const { plan } = input;
  if (input.readiness.length < plan.checks.length) return undefined;
  const budgetMs = checkRoundBudgetMs({ roundBudgetMin: plan.roundBudgetMin });
  const checks = plan.checks.map((check, index) => ({ id: check.id, label: check.id, kind: check.kind, command: input.readiness[index]!, ...(check.selectArgs === undefined ? {} : { selectArgs: check.selectArgs }) }));
  const environment = { selection: plan.selection, repos: [{ repositoryId: "plan", setupCommands: [], checks }] } as unknown as Pick<TestEnvironmentBody, "selection" | "repos">;
  const byRepository = await changesOf(input);
  // With changes in two repositories the repository-less paths and globs cannot be told apart, so nothing is selected (the whole check, `unknown_file`), unless the plan carries the repository-qualified map and the selection is on.
  const changes = byRepository === undefined || byRepository.size > 1 ? undefined : [...byRepository.values()][0] ?? [];
  const map: CoverageMap | undefined = plan.coverageMap === undefined ? undefined : { builtAt: plan.coverageMap.builtAt, files: plan.coverageMap.files };
  const inventory = map === undefined ? undefined : [...new Set(Object.values(map.files).flat())];
  let plans: Map<string, CheckSelectionPlan>;
  // A selection that is the same command as the whole check, or that picked no test, is the whole check.
  const wholeWhenNothingNarrowed = (): void => {
    for (const check of checks) {
      const planned = plans.get(check.id);
      if (planned?.selection === undefined || planned.selection.fallbackReason !== undefined) continue;
      const unchanged = JSON.stringify(planned.command) === JSON.stringify(check.command);
      if (unchanged || planned.selection.selected === 0) plans.set(check.id, { command: check.command, selection: { method: "full", selected: 0, total: 0, fallbackReason: "unknown_file" } });
    }
  };
  // TE-MR2b: the plan carries the map across repositories, the task holds two or more, the switch is on, the diff of every repository is known and the dependency facts could be derived. Otherwise: today's path, below.
  const live = input.multiRepo?.live ?? MULTI_REPO_SELECTION_LIVE;
  const facts = live && plan.repositoryCoverageMap !== undefined && input.repositories.length >= 2 && byRepository !== undefined ? await (input.multiRepo?.derive ?? derivedFacts)(input.repositories).catch(() => undefined) : undefined;
  if (plan.repositoryCoverageMap !== undefined && byRepository !== undefined && facts !== undefined) {
    plans = planRepositorySelections({
      config: plan.selection, checks: checks.map((check, index) => ({ ...check, repositoryId: plan.checks[index]!.repositoryId ?? "" })), changes: byRepository, map: plan.repositoryCoverageMap, facts,
      repositories: input.repositories.map((repository) => repository.repositoryId), now: input.now, lastNightlyFailures: plan.lastNightlyFailures,
    });
    wholeWhenNothingNarrowed();
  } else if (changes === undefined) {
    // Not known what changed: every check as it was sent, and the test checks say so.
    plans = new Map(checks.map((check) => [check.id, check.kind === "test" && !plan.selection.alwaysRun.includes(check.id) ? { command: check.command, selection: { method: "full" as const, selected: 0, total: 0, fallbackReason: "unknown_file" as const } } : { command: check.command }]));
  } else {
    plans = planSelections(environment, { changes, now: input.now, inventoryOf: () => inventory, coverageMap: map, lastNightlyFailures: plan.lastNightlyFailures });
    wholeWhenNothingNarrowed();
  }
  const readiness = input.readiness.map((command, index) => (index < plan.checks.length ? plans.get(plan.checks[index]!.id)?.command ?? command : command));
  // The approved placeholder is never left in a command, whatever happened above.
  if (readiness.some((command) => command.args.includes(TEST_ENV_SELECT_PLACEHOLDER))) return undefined;
  return { readiness, budgetMs, selection: aggregate([...plans.values()].flatMap((entry) => (entry.selection === undefined ? [] : [entry.selection]))), revision: plan.revision, digest: plan.digest };
}
