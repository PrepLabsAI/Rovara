// Test services are install-wide, so a project with NO dependencies must see exactly what it saw before: with the services switch on every user-visible output below is byte-for-byte the output with it off. If this
// fails, the switch needs a per-project allow-list first. Covered: the setup proposal (sanitized draft), the task plans (checks and coding), the Prove report, the evidence pack, and the pull request lines the evidence
// builds (the pull request body takes its testing lines from the pack and has no other test-services input).
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema, type OrgId, type TestEnvDraft, type TestEnvironmentBody } from "@rovara-code/contracts";
import { buildEvidencePack } from "../../packages/core/src/core/proof/evidence-pack.js";
import { evidenceLines } from "../../packages/core/src/core/proof/evidence-lines.js";
import { sanitizeTestEnvDraft } from "../../packages/core/src/core/test-env/draft.js";
import { evidenceEnvironmentOf } from "../../packages/core/src/core/test-env/evidence-line.js";
import { proveReportFromSetupCheck } from "../../packages/core/src/core/test-env/prove-from-setup-check.js";
import { testEnvImplementPlanFor, testEnvPlanFor } from "../../packages/core/src/core/test-env/task-plan.js";
import { testEnvironmentForStart } from "../../packages/core/src/core/test-env/usable.js";
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
  it("setup proposal: the sanitized draft is the same, and a draft without candidates gains no key", () => {
    const draft: TestEnvDraft = { environment: body(), valueSources: [{ field: "repos[0].checks[0]", source: "detector:python" }], pendingServices: [], notes: ["Found pytest."], questions: [] };
    const options = (env: NodeJS.ProcessEnv) => ({ env, propose: { catalog: verifiedCatalog(pinnedCatalog()), edition: "public" as const, projectId: PROJECT } });
    const on = sanitizeTestEnvDraft(draft, options(ON));
    same(on, sanitizeTestEnvDraft(draft, options(OFF)));
    same(on, sanitizeTestEnvDraft(draft));
    expect(JSON.stringify(on)).not.toContain("dependencies");
  });

  it("task plans (checks and coding), evidence environment, pack and PR lines are the same", async () => {
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
    // Evidence: the environment the pack records and everything built from it.
    const chosenOn = await evidenceEnvironmentOf(on.deps, { orgId: ORG, project: PROJECT, taskId: TASK }, ON);
    const chosenOff = await evidenceEnvironmentOf(off.deps, { orgId: ORG, project: PROJECT, taskId: TASK }, OFF);
    same(chosenOn, chosenOff);
    expect(chosenOn.dependencies).toBeUndefined();
    const checks = [{ id: "readiness:0", label: "pytest -q", source: "project" as const, before: "passed" as const, after: "passed" as const, class: "passing" as const, output: "", durationMs: 7, exitCode: 0 }];
    const pack = (chosen: typeof chosenOn) => buildEvidencePack({ candidateDigest: "c".repeat(64), rawText: undefined, checks, environment: chosen.environment!, storedArtifacts: new Map(), ...(chosen.dependencies === undefined ? {} : { dependencies: chosen.dependencies }) });
    same(pack(chosenOn), pack(chosenOff));
    expect("dependencies" in pack(chosenOn).pack!.environment).toBe(false);
    same(evidenceLines({ pack: pack(chosenOn).pack, mode: "summary" }, "c".repeat(64), 0), evidenceLines({ pack: pack(chosenOff).pack, mode: "summary" }, "c".repeat(64), 0));
    expect(JSON.stringify(evidenceLines({ pack: pack(chosenOn).pack, mode: "summary" }, "c".repeat(64), 0))).not.toMatch(/ran against|Blocked by environment|not available/u);
  });

  it("the Prove report derived from the setup check is the same, with no dependency step", () => {
    const definition = { revision: 4, setup: [], readiness: [cmd("pytest", ["-q"])] };
    const ready = { status: "ready" as const, checkedRevision: 4, checkedAt: new Date(NOW - 3_600_000).toISOString() };
    const derive = () => proveReportFromSetupCheck({ environment: body(), definition, setup: ready, nowMs: NOW });
    const on = derive();
    expect(JSON.stringify(on)).not.toMatch(/"dependencies"|dependency_usage/u);
    // The derivation reads no switch: the same report whatever the process says.
    const before = process.env["ROVARA_TEST_SERVICES"];
    try {
      process.env["ROVARA_TEST_SERVICES"] = "1";
      same(derive(), on);
    } finally {
      if (before === undefined) delete process.env["ROVARA_TEST_SERVICES"]; else process.env["ROVARA_TEST_SERVICES"] = before;
    }
  });
});
