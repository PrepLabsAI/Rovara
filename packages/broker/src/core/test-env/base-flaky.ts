// TE-C6: which tests are already known flaky on the BASE. ONE function, so the day TE-C1's per-commit baseline lands this is the single place that changes (call C1's `baselineFor` here instead): today it reads the last usable nightly
// baseline (`usableNightlyBaseline`: recent or on the unchanged head, the task's base branch, whole). `undefined` means the base's flaky set is not known; `flakyOnChangeOf` (contracts) then counts every rerun-flaky test as "passed on the
// base", which holds the draft (fail closed toward holding).
import type { OrgId } from "@agentx/contracts";
import type { TestEnvDeps } from "./deps.js";
import { usableNightlyBaseline, type UsableNightlyOptions } from "./nightly-usable.js";

export async function baseFlakyTests(deps: TestEnvDeps, task: { orgId: OrgId; project: string }, options: UsableNightlyOptions = {}): Promise<string[] | undefined> {
  const baseline = await usableNightlyBaseline(deps, task.orgId, task.project, options).catch(() => undefined);
  return baseline === undefined ? undefined : [...baseline.flaky];
}
