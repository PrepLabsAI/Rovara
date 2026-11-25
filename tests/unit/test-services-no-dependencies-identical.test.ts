// Test services are install-wide, so a project with NO dependencies must see exactly what it saw before: with the services switch on the task plans below are byte-for-byte the plans with it off. If this
// fails, the switch needs a per-project allow-list first. Covered: the proposal digest and the task plans (checks and coding). The evidence half (environment line, pack, pull request lines) went with its
// deleted subject, test-env/evidence-line.ts.
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema, type OrgId, type TestEnvironmentBody } from "@agentx/contracts";
import { testEnvImplementPlanFor, testEnvPlanFor } from "../../packages/broker/src/core/test-env/task-plan.js";
import { testEnvironmentForStart } from "../../packages/broker/src/core/test-env/usable.js";
import { BENCH_ORG, bench } from "../support/test-env-bench.js";
import { pinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";

const ORG: OrgId = BENCH_ORG;
const PROJECT = "service";
const TASK = "t1";
const ON = { ROVARA_TEST_ENVIRONMENT: "1", ROVARA_TEST_SERVICES: "1" };
const OFF = { ROVARA_TEST_ENVIRONMENT: "1" };
const NOW = Date.UTC(2026, 10, 3, 10, 0, 0);
const cmd = (executable: string, args: string[] = []) => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const body = (): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "service", setupCommands: [cmd("pip", ["install", "-e", "."])], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }] }], roundBudgetMin: 30,
  selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
});
const same = (left: unknown, right: unknown): void => { expect(JSON.stringify(left)).toBe(JSON.stringify(right)); };

/** A project with an approved environment WITHOUT dependencies, proposed, proved and approved under `env`, with a task pinned to it. */
async function project(env: NodeJS.ProcessEnv) {
  const h = await bench({ project: PROJECT, env, startMs: NOW, serviceCatalog: async () => verifiedCatalog(pinnedCatalog()) });
  const proposal = await h.proposeAndProve(body());
  expect(await h.approve(proposal.digest)).toMatchObject({ status: "decided" });
  const start = await testEnvironmentForStart(h.deps, { orgId: ORG, project: PROJECT, taskId: TASK }, env);
  await h.store.transact([start.pin!]);
  return { deps: h.deps, digest: proposal.digest };
}

describe("a project with no dependencies sees the same with tx on and off", () => {

  it("the proposal digest and the task plans (checks and coding) are the same", async () => {
    const on = await project(ON);
    const off = await project(OFF);
    // The same proposal digest (the environment body is hashed without a dependencies key).
    expect(on.digest).toBe(off.digest);
    // The checks plan, whichever switch the plan is asked under; the coding plan does not exist for an environment without dependencies.
    const readiness = [cmd("pytest", ["-q"])];
    const plans = [
      await testEnvPlanFor(on.deps, { orgId: ORG, project: PROJECT, taskId: TASK, readiness }, ON),
      await testEnvPlanFor(on.deps, { orgId: ORG, project: PROJECT, taskId: TASK, readiness }, OFF),
      await testEnvPlanFor(off.deps, { orgId: ORG, project: PROJECT, taskId: TASK, readiness }, OFF),
    ];
    expect(plans[0]).toBeDefined();
    same(plans[0], plans[1]);
    same(plans[0], plans[2]);
    expect(JSON.stringify(plans[0])).not.toContain("dependencies");
    for (const env of [ON, OFF]) expect(await testEnvImplementPlanFor(on.deps, { orgId: ORG, project: PROJECT, taskId: TASK }, env)).toBeUndefined();
  });

});
