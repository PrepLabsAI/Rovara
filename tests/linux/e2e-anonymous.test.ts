import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { E2E_ANONYMOUS_ACCOUNT_PROFILE_ID, e2eAnonymousAccountIdDigest, e2eAnonymousRuntimeAccountRef } from "@agentx/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { allOutputText, caseStatusesAll, observations } from "../support/e2e-executor-output.js";
import { collectAccountsRun } from "../support/linux-accounts.js";
import { removeInferredDirs, runInferredProbe } from "../support/linux-inferred.js";
import { removeProbeDirs, type ProbeRun } from "../support/linux-runtime.js";

const execFileAsync = promisify(execFile);
const docker = async (...args: string[]) => (await execFileAsync("docker", args)).stdout.trim();

/** Everything a failing run left to explain it, labelled, so a CI failure names its own cause. */
const why = (r: ProbeRun) => {
  const logs = r.host.readDiagnostics(r.fixture.plan.runId);
  return `the run was ${r.run.unavailableReason === null ? "available" : `unavailable (${r.run.unavailableReason})`}; executor exit code ${String(r.exitCode)}\n`
    + `build log: ${logs.buildLogTail || "(empty)"}\napp log: ${logs.appLogTail || "(empty)"}\nexecutor log: ${logs.executorLogTail || "(empty)"}`;
};
const outOf = (r: ProbeRun) => { if (r.outDir === null) throw new Error(`the run was unavailable: ${why(r)}`); return r.outDir; };
/** No container, network or volume of the run is left, whatever its outcome. */
const leftovers = async (r: ProbeRun) => {
  const label = `label=rovara.run=${r.fixture.plan.runId}`;
  return { containers: await docker("ps", "-a", "--filter", label, "--format", "{{.Names}}"), networks: await docker("network", "ls", "--filter", label, "--format", "{{.Name}}"),
    volumes: await docker("volume", "ls", "--filter", label, "--format", "{{.Name}}") };
};
const NOTHING = { containers: "", networks: "", volumes: "" };

// Task 3.3 (Ruling AZ) on real Docker, the real executor image and a real Chromium: an application with no `agentx.e2e` project contract, whose launch recipe discovery infers (`npm ci`
// in the build container, then `npm start` with the host's PORT=4317), run for signed-out scenarios only. There is no account, no seed and no data volume; the executor opens no session
// (a fresh browser context with no cookie), and the cases carry no account binding. It runs only in the CI `linux-runtime` job (ubuntu-24.04-arm, ROVARA_DOCKER=1,
// ROVARA_EXECUTOR_IMAGE); everywhere else it skips.
describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")("anonymous scenarios against an app with an inferred launch recipe", () => {
  afterAll(async () => { await removeInferredDirs(); await removeProbeDirs(); }, 120_000);

  it("builds with npm ci, starts on PORT=4317, and shows every visitor the welcome page: both signed-out scenarios pass", async () => {
    const r = await runInferredProbe();
    expect(r.run.unavailableReason, why(r)).toBeNull();
    expect(r.exitCode, why(r)).toBe(0);
    expect(caseStatusesAll(outOf(r), r.fixture)).toEqual({ "visitor-sees-welcome": "passed", "visitor-has-no-admin-link": "passed" });
    // The inferred recipe ran as discovery wrote it: the source copy, then `npm ci` (which exited 0), and the app answered GET / on 4317 (the executor's health check reads that path).
    const build = r.host.readBuildResult(r.fixture.plan.runId);
    expect(build).toMatchObject({ commandIndex: 1, exitCode: 0, command: { program: "npm", args: ["ci"] } });
    expect(allOutputText(outOf(r))).toContain("You are browsing as a visitor.");
    expect(r.credentialsLeaked).toBe(false);
    expect(await leftovers(r)).toEqual(NOTHING);
  }, 600_000);

  it("opens no session for the visitor: the account observation of each case has the sentinel session and the fixed identity digest, and no login and no identity", async () => {
    const r = await runInferredProbe();
    expect(r.run.unavailableReason, why(r)).toBeNull();
    const sources = observations(outOf(r)).filter((item) => item.kind === "identity-observation").map((item) => JSON.parse(item.content!) as { schemaVersion: string; caseId: string;
      accountRef?: { profileId: string; applicationId: string; revision: number }; sessionRef?: string; accountIdDigest?: string; login?: unknown; identity?: unknown })
      .filter((item) => item.schemaVersion === "e2e-executor-account-observation/v1");
    expect(sources).toHaveLength(2);
    const applicationId = r.fixture.compiled.originByApplicationId[0]!.applicationId;
    for (const source of sources) {
      expect(source.accountRef).toEqual(e2eAnonymousRuntimeAccountRef(applicationId));
      expect(source.sessionRef).toMatch(/^rovara-anonymous-[0-9a-f-]{36}$/);
      expect(source.accountIdDigest).toBe(e2eAnonymousAccountIdDigest(applicationId));
      expect(source.login).toBeNull();
      expect(source.identity).toBeNull();
    }
    expect(new Set(sources.map((item) => item.sessionRef)).size, "each case has a session of its own").toBe(2);
    // No account was made, so the executor plan carries none and the run's owned mount held neither a seed nor an accounts file.
    expect(r.fixture.plan.accounts).toEqual([]);
    expect(await leftovers(r)).toEqual(NOTHING);
  }, 600_000);

  it("collects the two cases through the real collector as PASS, both bound to the one anonymous account context and no account", async () => {
    const r = await runInferredProbe();
    expect(r.run.unavailableReason, why(r)).toBeNull();
    const collected = await collectAccountsRun(r);
    expect(collected.unavailableReason, collected.unavailableReason ?? "").toBeNull();
    expect(collected.qualification?.status, JSON.stringify(collected.qualification)).toBe("PASS");
    const cases = collected.qualification!.result!.cases;
    expect(cases).toHaveLength(2);
    expect(cases.every((item) => item.status === "passed")).toBe(true);
    const expectedCases = r.fixture.compiled.expectedCases;
    expect(expectedCases.every((item) => item.accountProfileId === E2E_ANONYMOUS_ACCOUNT_PROFILE_ID)).toBe(true);
    expect(new Set(cases.map((item) => item.accountContextId)).size, "the anonymous profile is one context").toBe(1);
    for (const item of cases) {
      const expected = expectedCases.find((candidate) => candidate.caseId === item.caseId)!;
      expect(item.accountContextId).toBe(expected.accountContextId);
      expect(item.accountContextDigest).toBe(expected.accountContextDigest);
    }
    expect(await leftovers(r)).toEqual(NOTHING);
  }, 600_000);

  it("does not take the visitor id the storefront prints, sets in a cookie and keeps in local storage for a credential: that case fails on its text, and the run is not a credential leak", async () => {
    const r = await runInferredProbe({ scenarios: ["welcome", "echoesVisitorId"] });
    expect(r.run.unavailableReason, why(r)).toBeNull();
    expect(r.exitCode, why(r)).toBe(1);
    expect(caseStatusesAll(outOf(r), r.fixture)).toEqual({ "visitor-sees-welcome": "passed", "visitor-id-is-shown": "failed" });
    expect(allOutputText(outOf(r))).toMatch(/visitor-[0-9a-f-]{36}/);
    expect(await leftovers(r)).toEqual(NOTHING);
  }, 600_000);

  it("a claim the page cannot meet is FAILED on its visible assertion, with a screenshot of the visitor's page, and the passing scenarios still pass", async () => {
    const r = await runInferredProbe({ scenarios: ["welcome", "expectsAdmin"] });
    expect(r.run.unavailableReason, why(r)).toBeNull();
    expect(r.exitCode, why(r)).toBe(1);
    expect(caseStatusesAll(outOf(r), r.fixture)).toEqual({ "visitor-sees-welcome": "passed", "visitor-expects-admin-link": "failed" });
    const collected = await collectAccountsRun(r);
    expect(collected.unavailableReason, collected.unavailableReason ?? "").toBeNull();
    expect(collected.qualification?.status).toBe("FAILED");
    const index = r.fixture.compiled.expectedCases.findIndex((expected) => expected.scenarioId === "visitor-expects-admin-link");
    expect(readdirSync(join(outOf(r), "captures"))).toEqual([`case-${index}-screenshot.jpg`]);
    expect(r.credentialsLeaked).toBe(false);
    expect(await leftovers(r)).toEqual(NOTHING);
  }, 600_000);
});
