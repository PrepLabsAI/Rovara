import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { E2E_ANONYMOUS_ACCOUNT_PROFILE_ID, e2eAnonymousAccountIdDigest, e2eAnonymousRuntimeAccountRef } from "@agentx/contracts";
import { E2E_EXECUTOR_HOST_MODULE_PATH } from "../../packages/verifier/src/executor/host-registry.js";
import { runE2EExecutorSerially as runE2EExecutor } from "../support/executor-run-lock.js";
import { resolveE2EExecutorSuite } from "../../packages/verifier/src/executor/suite.js";
import { assembleDockerCollectionInputs, assembleExecutorActualRun, readExecutorResultFile, snapshotExecutorOutput } from "../../packages/verifier/src/host/executor-readback.js";
import { collectHostRun, proveActualRun } from "../support/e2e-actual-run-proof.js";
import { createInferredExecutorPlan, type InferredPlanOptions } from "../support/e2e-inferred-fixture.js";
import { startInferredApp, type InferredAppProcess } from "../support/inferred-app-process.js";
import { allOutputText, caseStatusesAll, observations } from "../support/e2e-executor-output.js";

// Task 3.3, end to end on this machine: the real executor, the pinned CLI, a real Chromium and the inferred-recipe fixture app, for signed-out scenarios. The container walls are not here,
// and the sandbox attestation is stood in for; what is here is the whole path of an anonymous case: no login, a fresh context with no cookie, the sentinel session in the case ledger.
const verifierRoot = join(import.meta.dirname, "../../packages/verifier");
const runnable = existsSync(join(verifierRoot, E2E_EXECUTOR_HOST_MODULE_PATH)) && existsSync(chromium.executablePath());
const sandboxed = async (request: { runId: string; groupId: string }) => ({ schemaVersion: "e2e-executor-chromium-sandbox/v1" as const, runId: request.runId, groupId: request.groupId,
  browser: { pid: 40, nsPidDepth: 1, seccompFilters: 1, uidMap: "0 0 4294967295" }, renderers: [{ pid: 41, nsPidDepth: 2, seccompFilters: 2, uidMap: "0 1000 1" }] });

const dirs: string[] = []; const apps: InferredAppProcess[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.stop())); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function runInferred(options: InferredPlanOptions = {}) {
  const fixture = createInferredExecutorPlan({ healthTimeoutMs: 20_000, ...options });
  const app = await startInferredApp(); apps.push(app);
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "inferred-run-"))); dirs.push(dir);
  const out = join(dir, "out");
  await writeFile(join(dir, "plan.json"), JSON.stringify(fixture.plan));
  const result = await runE2EExecutor({ planPath: join(dir, "plan.json"), outDir: out, signal: AbortSignal.timeout(240_000), localAppUpstream: app.upstream,
    inspectChromiumSandbox: sandboxed, chromiumSandboxSettleMs: 0 });
  return { fixture, out, result };
}
const executorLog = (out: string) => readFileSync(join(out, "executor.log"), "utf8");

/** What the Docker host does after a real run: read the out directory, then assemble the readback and the collector's protected inputs. */
async function assembleFrom(run: Awaited<ReturnType<typeof runInferred>>) {
  const snapshot = await snapshotExecutorOutput(run.out, await readExecutorResultFile(run.out));
  const resolved = resolveE2EExecutorSuite(run.fixture.plan);
  const cleanup = { removedAt: new Date().toISOString(), containers: ["rovara-app"], network: "rovara-e2e", mockOrigins: [] as string[] };
  return { actual: assembleExecutorActualRun({ snapshot, compiled: resolved.suite, binding: resolved.binding, cleanup, evidenceDirectory: "/out" }),
    inputs: assembleDockerCollectionInputs({ snapshot, binding: resolved.binding, cleanup }) };
}

describe.runIf(runnable)("the executor against an app with only an inferred launch recipe, for signed-out scenarios", () => {
  it("runs two signed-out scenarios with no account: no login, no cookie, and both cases pass", async () => {
    const { fixture, out, result } = await runInferred();
    expect(fixture.plan.accounts).toEqual([]);
    expect(result, executorLog(out)).toEqual({ exitCode: 0, reason: null });
    expect(caseStatusesAll(out, fixture)).toEqual({ "visitor-sees-welcome": "passed", "visitor-has-no-admin-link": "passed" });
    expect(allOutputText(out)).toContain("You are browsing as a visitor.");
  }, 300_000);

  it("is qualified PASS by the real collector from what the host reads back, with both cases bound to the fixed anonymous reference and no account", async () => {
    const run = await runInferred();
    expect(run.result.exitCode, executorLog(run.out)).toBe(0);
    const { actual, inputs } = await assembleFrom(run);
    proveActualRun(actual, run.fixture.plan);
    const collected = collectHostRun(actual, inputs, run.fixture.plan);
    expect(collected.unavailableReason, collected.unavailableReason ?? "").toBeNull();
    expect(collected.qualification?.status, JSON.stringify(collected.qualification)).toBe("PASS");
    const cases = collected.qualification!.result!.cases;
    expect(cases).toHaveLength(2);
    expect(cases.every((item) => item.status === "passed")).toBe(true);
    expect(new Set(cases.map((item) => item.accountContextId)).size).toBe(1);
  }, 300_000);

  it("records each case under the sentinel session and the fixed anonymous reference, with no login and no identity", async () => {
    const { fixture, out, result } = await runInferred();
    expect(result.exitCode, executorLog(out)).toBe(0);
    const applicationId = fixture.compiled.originByApplicationId[0]!.applicationId;
    const sources = observations(out).filter((item) => item.kind === "identity-observation").map((item) => JSON.parse(item.content!) as { schemaVersion: string; caseId: string; accountRef: unknown;
      sessionRef: string; accountIdDigest: string; login: unknown; identity: unknown }).filter((item) => item.schemaVersion === "e2e-executor-account-observation/v1");
    expect(sources).toHaveLength(2);
    for (const source of sources) {
      expect(source).toMatchObject({ accountRef: e2eAnonymousRuntimeAccountRef(applicationId), accountIdDigest: e2eAnonymousAccountIdDigest(applicationId), login: null, identity: null });
      expect(source.sessionRef).toMatch(/^rovara-anonymous-[0-9a-f-]{36}$/);
    }
    expect(new Set(sources.map((item) => item.caseId)).size).toBe(2);
    expect(new Set(sources.map((item) => item.sessionRef)).size).toBe(2);
    expect(fixture.compiled.expectedCases.every((item) => item.accountProfileId === E2E_ANONYMOUS_ACCOUNT_PROFILE_ID)).toBe(true);
  }, 300_000);

  it("does not take the visitor id the page prints, keeps in a cookie and in local storage for a secret: the case fails on its text assertion, it is not a credential leak (F6)", async () => {
    const { fixture, out, result } = await runInferred({ scenarios: ["welcome", "echoesVisitorId"] });
    expect(result, executorLog(out)).toEqual({ exitCode: 1, reason: null });
    expect(caseStatusesAll(out, fixture)).toEqual({ "visitor-sees-welcome": "passed", "visitor-id-is-shown": "failed" });
    // The page's text, id included, is in the observation of the failed assertion: nothing of it was registered as a session value.
    expect(allOutputText(out)).toMatch(/visitor-[0-9a-f-]{36}/);
    expect(executorLog(out)).not.toContain("removed an output file that carried an account credential or a session value");
  }, 300_000);

  it("fails a claim the page cannot meet on its visible assertion, with one screenshot of the visitor's page, and still passes the other scenario", async () => {
    const { fixture, out, result } = await runInferred({ scenarios: ["welcome", "expectsAdmin"] });
    expect(result, executorLog(out)).toEqual({ exitCode: 1, reason: null });
    expect(caseStatusesAll(out, fixture)).toEqual({ "visitor-sees-welcome": "passed", "visitor-expects-admin-link": "failed" });
    const index = fixture.compiled.expectedCases.findIndex((item) => item.scenarioId === "visitor-expects-admin-link");
    expect(readdirSync(join(out, "captures"))).toEqual([`case-${index}-screenshot.jpg`]);
    const { actual, inputs } = await assembleFrom({ fixture, out, result });
    const collected = collectHostRun(actual, inputs, fixture.plan);
    expect(collected.unavailableReason, collected.unavailableReason ?? "").toBeNull();
    expect(collected.qualification?.status).toBe("FAILED");
  }, 300_000);
});
