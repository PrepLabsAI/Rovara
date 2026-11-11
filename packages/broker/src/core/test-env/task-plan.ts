// Test environment: what a verification (CHECKS) run is told about the environment the task pinned: which of its commands are the environment's checks, how to select tests, the round budget, and
// the tests that failed in the last nightly. The worker applies it (worker/src/verification/test-env-plan.ts); this only builds it, and builds it only when it can stand behind it.
//
// The plan is built when ALL of these hold, and not at all otherwise (the run then goes out exactly as it did without an environment):
//   - the switch is on, and the task pinned a revision that a task may use (`usableTestEnvironment` is run again for THAT revision: it is read from the store, not from the pin, so a pin cannot name an environment
//     the rules above would refuse);
//   - the pinned digest is the environment's own digest (a pin written for other contents is not used);
//   - the run's first commands are the environment's checks, in order (`taskWorkflowCheckPolicy` puts them first; a task whose policy was edited since reads as "not the environment's" and runs as it is).
// A coverage map is not sent: no run produces one yet, and a map of any size would not fit a dispatch. Without it a selection by coverage map runs the whole check and says why.
import { agentXError, testEnvDigest, type OrgId, type ProjectCommand, type TestEnvTaskPlan } from "@agentx/contracts";
import { DEPENDENCY_PLAN_REFUSAL_WORDS, taskDependencyPlansOf, type ServiceCatalogSource } from "./dependency-plan.js";
import { lastNightlyFailures } from "./nightly.js";
import type { TestEnvDeps } from "./deps.js";
import { readApprovedSeedFiles } from "./environment.js";
import { selectionFieldsAreSafe } from "./prove-from-setup-check.js";
import { readTestEnvPin, usableTestEnvironment } from "./usable.js";
import { testEnvironmentEnabled } from "./switch.js";
import { DEPENDENCIES_WITH_DEVCONTAINER_WORDS, projectUsesDevcontainer } from "./devcontainer-check.js";
import { approvedFixturesOf, recordsOf, type FixtureStoreFactory } from "./fixture-lookup.js";
import { testServicesEnabled } from "./test-services-switch.js";

const sameCommand = (left: ProjectCommand, right: ProjectCommand): boolean => left.cwd === right.cwd && left.executable === right.executable && JSON.stringify(left.args) === JSON.stringify(right.args);

/** `serviceCatalog` is the release's signed catalog (`serviceCatalogSourceOf`). Without one, a run with dependencies is refused, never planned without them. */
export type TestEnvPlanDeps = TestEnvDeps & {
  serviceCatalog?: ServiceCatalogSource | undefined;
  /** the install's fixture store (a factory over the production list). Without it no fake is approved, so a plan with a fake is refused. */
  fixtureStore?: FixtureStoreFactory | undefined;
};

export async function testEnvPlanFor(
  deps: TestEnvPlanDeps, input: { orgId: OrgId; project: string; taskId: string; readiness: readonly ProjectCommand[] }, env: NodeJS.ProcessEnv = process.env,
): Promise<TestEnvTaskPlan | undefined> {
  if (!testEnvironmentEnabled(env) || input.readiness.length === 0) return undefined;
  return planOf(deps, input, env);
}

/**
 * Test services the plan a CODING (IMPLEMENT) run is sent so the working sandbox gets the dependencies while the agent codes (done-criterion 3). Only with the switch `tx` on, only when the task's pinned
 * approved environment has dependencies, and only that plan (a coding run is never sent a plan without dependencies, so with `tx` off, or for an environment without any, its payload is what it always was and
 * nothing is read). The pinning, the catalog trust and the dev container refusal are the same as for the checks (`planOf`); there are no readiness commands to match on a coding run.
 */
export async function testEnvImplementPlanFor(
  deps: TestEnvPlanDeps, input: { orgId: OrgId; project: string; taskId: string }, env: NodeJS.ProcessEnv = process.env,
): Promise<TestEnvTaskPlan | undefined> {
  if (!testServicesEnabled(env) || !testEnvironmentEnabled(env)) return undefined;
  const plan = await planOf(deps, input, env);
  return plan?.dependencies === undefined ? undefined : plan;
}

/** The plan of the task's pinned environment. `readiness` is given for a verification run (its first commands must be the environment's checks, and the last nightly's failures ride along); a coding run gives none. */
async function planOf(
  deps: TestEnvPlanDeps, input: { orgId: OrgId; project: string; taskId: string; readiness?: readonly ProjectCommand[] }, env: NodeJS.ProcessEnv,
): Promise<TestEnvTaskPlan | undefined> {
  const pin = await readTestEnvPin(deps, input.orgId, input.project, input.taskId);
  if (pin === undefined || pin.unused !== undefined) return undefined;
  const found = await usableTestEnvironment(deps, input.orgId, input.project, pin.revision, env);
  if (!found.ok || testEnvDigest(found.environment.environment) !== pin.digest) return undefined;
  const body = found.environment.environment;
  // The narrowing rule again, at dispatch: an environment approved before the rule, or by any path that skipped it, never sends `{tests}` to a command that is not a test runner (the run then goes out as without an environment).
  if (!selectionFieldsAreSafe(body)) return undefined;
  const checks = body.repos.flatMap((repo) => repo.checks);
  const readiness = input.readiness;
  if (checks.length === 0 || (readiness !== undefined && (readiness.length < checks.length || !checks.every((check, index) => sameCommand(check.command, readiness[index]!))))) return undefined;
  // Test services : the dependencies this run starts, pinned from the signed catalog. Only with the switch `tx` on (the usable check above already refuses the environment otherwise). A dependency that cannot be
  // pinned REFUSES the run, in fixed words: running the checks without a dependency the environment lists would only fail its tests in a confusing way.
  let dependencies: TestEnvTaskPlan["dependencies"];
  if (body.dependencies !== undefined && body.dependencies.length > 0) {
    if (!testServicesEnabled(env)) return undefined;
    // Sealed check runners cannot be combined with a dev container (the worker throws): refused here, in fixed words, even if the project got one after the task started.
    if (await projectUsesDevcontainer(deps, input.orgId, input.project)) throw agentXError("RUNTIME_UNAVAILABLE", DEPENDENCIES_WITH_DEVCONTAINER_WORDS);
    const catalog = await Promise.resolve(deps.serviceCatalog?.()).catch(() => undefined);
    const fixtures = await approvedFixturesOf(recordsOf(deps.fixtureStore), input.orgId, input.project, body);
    // Review I3: the seed files as the approval bound them (a file seed with no bound content is refused: approve again).
    const approvedSeedFiles = await readApprovedSeedFiles(deps, input.orgId, input.project, found.environment.revision);
    const planned = taskDependencyPlansOf({ body, catalog, edition: "public", projectId: input.project, fixtures, approvedSeedFiles });
    if (!planned.ok) throw agentXError("RUNTIME_UNAVAILABLE", DEPENDENCY_PLAN_REFUSAL_WORDS[planned.reason]);
    dependencies = planned.dependencies;
  }
  const failures = readiness === undefined ? [] : await lastNightlyFailures(deps, input.orgId, input.project).catch(() => []);
  return {
    revision: found.environment.revision, digest: pin.digest, roundBudgetMin: body.roundBudgetMin,
    selection: { method: body.selection.method, ...(body.selection.declared === undefined ? {} : { declared: body.selection.declared }), alwaysRun: body.selection.alwaysRun, fullSuiteOn: body.selection.fullSuiteOn },
    checks: checks.map((check) => ({ id: check.id, kind: check.kind, ...(check.coveragePath === undefined ? {} : { coveragePath: check.coveragePath }), ...(check.selectArgs === undefined ? {} : { selectArgs: check.selectArgs }) })),
    ...(failures.length === 0 ? {} : { lastNightlyFailures: failures.slice(0, 500) }),
    ...(dependencies === undefined ? {} : { dependencies }),
  };
}
