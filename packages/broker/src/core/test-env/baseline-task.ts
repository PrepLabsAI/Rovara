// TE-C1: what the evidence keeper is given for a task whose plan offered baseline candidates, and the words it keeps. Kept apart from `baseline-cache.ts` (which the nightly's record imports) so the nightly never imports
// the usability rules and the rules never import the nightly.
import type { EvidenceBaseline, OrgId, TestEnvTaskPlan } from "@agentx/contracts";
import type { KeepEvidenceBaseline } from "../proof/evidence-keep.js";
import { baselineFor, knownFailingOf, type FoundBaseline } from "./baseline-cache.js";
import type { TestEnvDeps } from "./deps.js";
import { projectBaseBranch } from "./nightly-usable.js";
import { baselineCacheEnabled } from "./switch.js";

/** The words a task keeps for the run it was compared with: numbers and fixed words, frozen when the checks were compared. `knownFailing` is the row's failing set, which a found row always holds whole. */
export const evidenceBaselineOf = (found: FoundBaseline): EvidenceBaseline => ({
  schemaVersion: 1, sha: found.row.headSha, branch: found.row.branch, writer: found.row.writer, commitsBack: found.commitsBack, ageHours: found.ageHours, knownFailing: found.row.tests.failed, flaky: found.row.flaky.length,
});

/**
 * What `keepEvidence` is given: the shas THIS task's plan offered, and how to turn the worker's claim (untrusted) into words by looking the row up itself, for the task's company, project, environment revision and base
 * branch. Undefined when the switch is off or the plan offered nothing: then no claim is looked at.
 */
export function taskBaselineOf(
  deps: Pick<TestEnvDeps, "store" | "now" | "env">, input: { orgId: OrgId; project: string; plan: Pick<TestEnvTaskPlan, "revision" | "baselineCandidates"> },
): KeepEvidenceBaseline | undefined {
  const offered = input.plan.baselineCandidates?.map((candidate) => candidate.sha) ?? [];
  if (!baselineCacheEnabled(deps.env ?? process.env) || offered.length === 0) return undefined;
  return {
    offered,
    async resolve(claim) {
      const branch = await projectBaseBranch(deps, input.orgId, input.project);
      if (branch === undefined) return undefined;
      const found = await baselineFor(deps, { orgId: input.orgId, project: input.project, envRevision: input.plan.revision, branch, ancestry: [claim] });
      return found === undefined ? undefined : evidenceBaselineOf(found);
    },
  };
}

/**
 * The tests that already failed at the baseline a task was compared with, read again from the engine's own row by the sha and the commit count the task kept (`EvidenceBaseline`), for the company, project, revision and base
 * branch given. Undefined when there is no usable row any more (expired, damaged): the caller then keeps today's rule (`usableNightlyFailing`), never an empty "nothing already fails". Cloud's `known-failing.ts` calls this when the switch is on.
 */
export async function alreadyFailingFromBaseline(
  deps: Pick<TestEnvDeps, "store" | "now">, input: { orgId: OrgId; project: string; envRevision: number; branch: string; words: Pick<EvidenceBaseline, "sha" | "commitsBack"> },
): Promise<string[] | undefined> {
  const found = await baselineFor(deps, { orgId: input.orgId, project: input.project, envRevision: input.envRevision, branch: input.branch, ancestry: [{ sha: input.words.sha, commitsBack: input.words.commitsBack }] });
  return found === undefined ? undefined : knownFailingOf(found.row);
}
