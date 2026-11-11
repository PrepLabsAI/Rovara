// The test environment as the task flow sees it: three questions, answered from what the project approved.
//   - `forStart`: which approved revision a starting task pins (the pin item joins the start's transaction). A later approval changes the NEXT task, never one that is running.
//   - `stepPlan`: what a coding or verification run is told about the environment the task pinned (the plan: its checks, selection, budget, and the dependencies to start), plus the worker features the run needs.
//   - `prepareTestServices`: the dependencies a preparation (a candidate check) starts.
// Nothing here is a second rule: the pin, the usable check and the plan are `usable.ts` and `task-plan.ts`. The seam only exists so `core/task-flow` and `core/build-step` do not import the environment's modules.
import {
  TEST_ENV_COVERAGE_PATH_FEATURE, TEST_ENV_PLAN_FEATURE, TEST_SERVICES_AWS_PLAN_FEATURE, TEST_SERVICES_FAKE_PLAN_FEATURE, TEST_SERVICES_FILE_SEED_FEATURE, TEST_SERVICES_PLAN_FEATURE, TEST_SERVICES_SEED_LOCK_FEATURE,
  type OrgId, type ProjectCommand, type TaskDependencyPlan, type TestEnvTaskPlan, type TestEnvironmentBody, type TransactItem,
} from "@agentx/contracts";
import type { TestEnvDeps } from "./deps.js";
import { fixtureDigestsOfPlan } from "./fixture-lookup.js";
import { testEnvImplementPlanFor, testEnvPlanFor } from "./task-plan.js";
import { testEnvironmentForStart } from "./usable.js";

/** The worker features a plan needs: the run is never sent to a worker that does not list them (it would run the checks with no database and say nothing), and the field is never dropped. */
export function featuresForTestPlan(dependencies: readonly TaskDependencyPlan[] | undefined, plan?: TestEnvTaskPlan): string[] {
  const features = new Set<string>();
  if (plan !== undefined) features.add(TEST_ENV_PLAN_FEATURE);
  if (plan?.checks.some((check) => check.coveragePath !== undefined) === true) features.add(TEST_ENV_COVERAGE_PATH_FEATURE);
  const planned = dependencies ?? plan?.dependencies ?? [];
  if (planned.length > 0) features.add(TEST_SERVICES_PLAN_FEATURE);
  if (planned.some((dependency) => dependency.backing === "emulated")) features.add(TEST_SERVICES_AWS_PLAN_FEATURE);
  if (planned.some((dependency) => dependency.backing === "fake")) features.add(TEST_SERVICES_FAKE_PLAN_FEATURE);
  if (planned.some((dependency) => dependency.seeds.some((seed) => "fixturePath" in seed))) features.add(TEST_SERVICES_FILE_SEED_FEATURE);
  if (planned.some((dependency) => dependency.seeds.some((seed) => "command" in seed && seed.lock !== undefined))) features.add(TEST_SERVICES_SEED_LOCK_FEATURE);
  return [...features];
}

export interface StepTestPlan {
  plan: TestEnvTaskPlan;
  /** The digests of the fixture sets the plan names (kept on the operation so only those sets are delivered). */
  fixtureDigests: string[];
  /** The worker features the step needs (add them to the step's `requires`). */
  requires: string[];
}

export interface TaskTestEnvironment {
  /** `pin` joins the start's transaction; `environment` is the approved body the task uses, which the task's check policy is built from (its checks come first). */
  forStart(input: { project: string; taskId: string }): Promise<{ pin?: TransactItem; environment?: TestEnvironmentBody }>;
  /** `CHECKS` runs get the full plan (their first commands must be the environment's checks); `IMPLEMENT` gets only the dependency plan, and only when the environment has dependencies. A plan that cannot be built throws a fixed sentence (the caller blocks the step with it). */
  stepPlan(input: { project: string; taskId: string; mode: "IMPLEMENT" | "CHECKS"; readiness?: readonly ProjectCommand[] }): Promise<StepTestPlan | undefined>;
}

export function createTaskTestEnvironment(deps: TestEnvDeps, options: { orgId: OrgId }): TaskTestEnvironment {
  const env = deps.env ?? process.env;
  return {
    async forStart(input) {
      const { pin, used } = await testEnvironmentForStart(deps, { orgId: options.orgId, project: input.project, taskId: input.taskId }, env);
      return { ...(pin === undefined ? {} : { pin }), ...(used === undefined ? {} : { environment: used.environment }) };
    },
    async stepPlan(input) {
      const scope = { orgId: options.orgId, project: input.project, taskId: input.taskId };
      const plan = input.mode === "CHECKS"
        ? input.readiness === undefined ? undefined : await testEnvPlanFor(deps, { ...scope, readiness: input.readiness }, env)
        : await testEnvImplementPlanFor(deps, scope, env);
      return plan === undefined ? undefined : { plan, fixtureDigests: fixtureDigestsOfPlan(plan), requires: featuresForTestPlan(undefined, plan) };
    },
  };
}
