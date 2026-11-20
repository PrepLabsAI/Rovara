// DEC 254z-amend3: test services are ON by default (only exactly "0" turns them off), and where the HOST cannot run them (the marker ROVARA_TEST_SERVICES_UNAVAILABLE) the install behaves as with the switch off,
// except that a task whose approved environment lists dependencies, and the environment's state answer, say why in fixed words: "Test services not available here: <reason>". The task still starts and runs the
// project's own checks; nothing is planned with dependencies and no catalog is read.
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema, type OrgId, type ProjectCommand, type TestEnvironmentBody } from "@agentx/contracts";
import { evidenceEnvironmentOf } from "../../packages/broker/src/core/test-env/evidence-line.js";
import { testEnvironmentView } from "../../packages/broker/src/core/test-env/local-view.js";
import { testEnvImplementPlanFor, testEnvPlanFor } from "../../packages/broker/src/core/test-env/task-plan.js";
import { TEST_SERVICES_UNAVAILABLE_REASONS, TEST_SERVICES_UNAVAILABLE_VARIABLE, TEST_SERVICES_UNAVAILABLE_WORDS } from "../../packages/broker/src/core/test-env/test-services-switch.js";
import { UNUSED_REASONS, UNUSED_WORDS, environmentUnusedReason, readTestEnvPin, testEnvironmentForStart } from "../../packages/broker/src/core/test-env/usable.js";
import { pinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";
import { BENCH_ORG, bench } from "../support/test-env-bench.js";

const ORG: OrgId = BENCH_ORG;
const PROJECT = "service";
const cmd = (executable: string, args: string[] = []): ProjectCommand => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const postgres = {
  id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"],
  backing: { kind: "local", catalogId: "postgres@16", config: { database: "app", user: "app" } },
  connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] },
  seeds: [], reset: "fresh_per_round",
};
const body = (dependencies: unknown[] | null = [postgres]): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "service", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] },
  nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
  ...(dependencies === null ? {} : { dependencies }),
});
const readiness = [cmd("pytest", ["-q"])];
const unavailable = (reason: string): NodeJS.ProcessEnv => ({ ROVARA_TEST_ENVIRONMENT: "1", [TEST_SERVICES_UNAVAILABLE_VARIABLE]: reason });

/** An approved environment with a Postgres dependency, approved while test services could run (nothing set: the default). */
async function approved() {
  const h = await bench({ project: PROJECT, env: { ROVARA_TEST_ENVIRONMENT: "1" }, serviceCatalog: async () => verifiedCatalog(pinnedCatalog()) });
  const proposal = await h.proposeAndProve(body());
  expect(await h.approve(proposal.digest)).toMatchObject({ status: "decided" });
  return h;
}

describe("switched on, but the host cannot run them", () => {
  it("is not used: the task starts, the pin and the evidence say why in fixed words, nothing is planned and the catalog is not read", async () => {
    for (const reason of TEST_SERVICES_UNAVAILABLE_REASONS) {
      const h = await approved();
      let reads = 0;
      h.deps.serviceCatalog = async () => { reads += 1; return verifiedCatalog(pinnedCatalog()); };
      const env = unavailable(reason);
      const taskId = `t-${reason}`;
      const started = await testEnvironmentForStart(h.deps, { orgId: ORG, project: PROJECT, taskId }, env);
      expect(started.used, reason).toBeUndefined();
      await h.store.transact([started.pin!]);
      const pin = await readTestEnvPin(h.deps, ORG, PROJECT, taskId);
      expect(pin?.unused, reason).toBe(`dependencies_unavailable_${reason}`);
      const evidence = await evidenceEnvironmentOf(h.deps, { orgId: ORG, project: PROJECT, taskId }, env);
      expect(evidence.note?.text, reason).toBe(`${TEST_SERVICES_UNAVAILABLE_WORDS[reason]}: the project's own test setup was used`);
      expect(evidence.note?.text).toMatch(/^Test services not available here: /u);
      expect(evidence.dependencies).toBeUndefined();
      expect((await testEnvPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId, readiness }, env))?.dependencies).toBeUndefined();
      expect(await testEnvImplementPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId }, env)).toBeUndefined();
      expect(reads, reason).toBe(0);
    }
  });

  it("names an unknown marker 'other', in the same fixed words and never with the marker's value", async () => {
    const h = await approved();
    const env = unavailable("evil <b>value</b>");
    expect(environmentUnusedReason({ revision: 1, approvedAt: "2026-11-03T10:00:00.000Z", environment: body() }, env)).toBe("dependencies_unavailable_other");
    const view = await testEnvironmentView({ ...h.deps, env }, ORG, PROJECT);
    expect(view.testServices).toBe(false);
    expect(view.testServicesUnavailable).toBe(TEST_SERVICES_UNAVAILABLE_WORDS.other);
    expect(JSON.stringify(view)).not.toContain("evil");
  });

  it("the owner's opt-out (exactly 0) keeps today's reason and words, whatever the marker says, and the state answer says nothing more", async () => {
    const h = await approved();
    const off = { ROVARA_TEST_ENVIRONMENT: "1", ROVARA_TEST_SERVICES: "0", [TEST_SERVICES_UNAVAILABLE_VARIABLE]: "workers" };
    const started = await testEnvironmentForStart(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, off);
    await h.store.transact([started.pin!]);
    expect((await readTestEnvPin(h.deps, ORG, PROJECT, "t1"))?.unused).toBe("dependencies_not_connected");
    const view = await testEnvironmentView({ ...h.deps, env: off }, ORG, PROJECT);
    expect(view.testServices).toBe(false);
    expect("testServicesUnavailable" in view).toBe(false);
  });

  it("every new reason is a stored pin reason with its own fixed words", () => {
    for (const reason of TEST_SERVICES_UNAVAILABLE_REASONS) {
      expect(UNUSED_REASONS).toContain(`dependencies_unavailable_${reason}`);
      expect(UNUSED_WORDS[`dependencies_unavailable_${reason}` as (typeof UNUSED_REASONS)[number]]).toBe(TEST_SERVICES_UNAVAILABLE_WORDS[reason]);
    }
  });
});
