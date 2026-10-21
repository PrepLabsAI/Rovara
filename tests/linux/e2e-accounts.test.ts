import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { allOutputText, caseStatusesAll, csvRows, observations } from "../support/e2e-executor-output.js";
import { collectAccountsRun, removeAccountsDirs, runAccountsProbe } from "../support/linux-accounts.js";
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

// Task 3.2 on real Docker, the real executor image and a real Chromium: an app whose accounts are seeded by its own recipe's seed command from the accounts file the host writes
// (`rovara-accounts-file/v1`, with a per-run data volume) and who sign in through the app's own login form (`rovara-form-login/v1`). Three accounts in two tenants, one run.
// It runs only in the CI `linux-runtime` job (ubuntu-24.04-arm, ROVARA_DOCKER=1, ROVARA_EXECUTOR_IMAGE); everywhere else it skips.
describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")("recipe-declared account seed and form login", () => {
  afterAll(async () => { await removeAccountsDirs(); await removeProbeDirs(); }, 120_000);

  it("runs three accounts in two tenants in one run: the viewer sees no export-csv, the owner exports, the other tenant's owner sees no row a1", async () => {
    const r = await runAccountsProbe();
    expect(r.run.unavailableReason, why(r)).toBeNull();
    expect(r.exitCode, why(r)).toBe(0);
    expect(caseStatusesAll(outOf(r), r.fixture)).toEqual({ "viewer-cannot-export": "passed", "owner-exports-orders": "passed", "other-tenant-sees-no-orders-of-a": "passed" });
    // The owner's export is tenant-a's own two orders: the rows the seed's tenant-a records give, and nothing of tenant-b's.
    expect(csvRows(outOf(r))).toEqual([["id", "customer", "total", "state"], ["a1", "Ada", "12.5", "ready"], ["a2", "Grace", "23", "ready"]]);
    // Each case was observed under its own account and session: the account observation of each case names the profile's own tenant and role.
    const accounts = observations(outOf(r)).filter((item) => item.kind === "identity-observation").map((item) => JSON.parse(item.content!) as { schemaVersion: string; caseId: string;
      accountRef?: { profileId: string; applicationId: string }; sessionRef?: string; identity?: { tenantId: string; role: string } }).filter((item) => item.schemaVersion === "e2e-executor-account-observation/v1");
    expect(accounts.map((item) => [item.accountRef!.profileId, item.identity!.tenantId, item.identity!.role]).sort()).toEqual(
      [["orders-owner", "tenant-a", "owner"], ["orders-owner-b", "tenant-b", "owner"], ["orders-viewer", "tenant-a", "viewer"]]);
    expect(new Set(accounts.map((item) => item.sessionRef)).size).toBe(3);
    // Judged by the host's own credential predicate over every byte of the run's out directory, and by name for the local parts of the emails.
    expect(r.credentialsLeaked).toBe(false);
    const everything = allOutputText(outOf(r));
    for (const account of r.fixture.plan.accounts) expect(everything).not.toContain(account.email.slice(0, account.email.indexOf("@")));
    expect(readdirSync(outOf(r), { recursive: true }).map(String).filter((name) => /trace|\.zip$|\.har$/i.test(name))).toEqual([]);
    expect(await leftovers(r)).toEqual(NOTHING);
  }, 600_000);

  it("collects the three cases through the real collector as PASS, each bound to its own (application, account profile)", async () => {
    const r = await runAccountsProbe();
    expect(r.run.unavailableReason, why(r)).toBeNull();
    const collected = await collectAccountsRun(r);
    expect(collected.unavailableReason, collected.unavailableReason ?? "").toBeNull();
    expect(collected.qualification?.status, JSON.stringify(collected.qualification)).toBe("PASS");
    const cases = collected.qualification!.result!.cases;
    expect(cases).toHaveLength(3);
    expect(cases.every((item) => item.status === "passed")).toBe(true);
    expect(new Set(cases.map((item) => item.accountContextId)).size).toBe(3);
    expect(await leftovers(r)).toEqual(NOTHING);
  }, 600_000);

  it("the viewer-access defect fails the viewer's case on its visible assertion, and the other two still pass", async () => {
    const r = await runAccountsProbe({ defect: "viewer-access.json" });
    expect(r.run.unavailableReason, why(r)).toBeNull();
    expect(r.exitCode, why(r)).toBe(1);
    expect(caseStatusesAll(outOf(r), r.fixture)).toEqual({ "viewer-cannot-export": "failed", "owner-exports-orders": "passed", "other-tenant-sees-no-orders-of-a": "passed" });
    const collected = await collectAccountsRun(r);
    expect(collected.unavailableReason, collected.unavailableReason ?? "").toBeNull();
    expect(collected.qualification?.status).toBe("FAILED");
    const byScenario = new Map(collected.qualification!.result!.cases.map((item) => [r.fixture.compiled.expectedCases.find((expected) => expected.caseId === item.caseId)!.scenarioId, item]));
    expect(byScenario.get("viewer-cannot-export")!.status).toBe("failed");
    expect(byScenario.get("viewer-cannot-export")!.assertionReceipts.map((receipt) => [receipt.assertionIndex, receipt.status])).toEqual([[0, "failed"]]);
    const viewerExpected = r.fixture.compiled.expectedCases.find((expected) => expected.scenarioId === "viewer-cannot-export")!;
    expect(byScenario.get("viewer-cannot-export")!.assertionReceipts[0]!.assertionDigest).toBe(viewerExpected.assertionDigests[0]);
    expect(viewerExpected.accountProfileId).toBe("orders-viewer");
    expect(byScenario.get("owner-exports-orders")!.status).toBe("passed");
    expect(byScenario.get("other-tenant-sees-no-orders-of-a")!.status).toBe("passed");
    // The failed case earned its one screenshot, named by the case's index only; it holds no credential.
    const captures = readdirSync(join(outOf(r), "captures"));
    expect(captures).toEqual([`case-${r.fixture.compiled.expectedCases.findIndex((expected) => expected.scenarioId === "viewer-cannot-export")}-screenshot.jpg`]);
    expect(r.credentialsLeaked).toBe(false);
    expect(await leftovers(r)).toEqual(NOTHING);
  }, 600_000);

  it("reuses the form login's cookies for API cases: the viewer is refused with 403, the owner is allowed with 200", async () => {
    const r = await runAccountsProbe({ api: true });
    expect(r.run.unavailableReason, why(r)).toBeNull();
    expect(r.exitCode, why(r)).toBe(0);
    expect(caseStatusesAll(outOf(r), r.fixture)).toEqual({ "api-viewer-refused": "passed", "api-owner-allowed": "passed" });
    const collected = await collectAccountsRun(r);
    expect(collected.qualification?.status, JSON.stringify(collected.qualification)).toBe("PASS");
    expect(r.credentialsLeaked).toBe(false);
    expect(await leftovers(r)).toEqual(NOTHING);
  }, 600_000);

  it("a seed that exits 3 makes the run UNKNOWN with seed-failed, never starts the app, and removes every labeled resource, the data volume included", async () => {
    const r = await runAccountsProbe({ recipeSeed: { args: ["-e", "process.exit(3)"] } });
    expect(r.run.unavailableReason).toBe("seed-failed");
    expect(r.run.actualRun).toBeNull();
    expect(r.outDir).toBeNull();
    expect(await leftovers(r)).toEqual(NOTHING);
    // The seed ran with the app's flags, so it was read-only and unprivileged like the app; what it printed is kept, redacted.
    expect(r.host.readDiagnostics(r.fixture.plan.runId).appLogTail).toContain("seed command");
  }, 600_000);

  it("an application that does not sign the account in makes the run UNKNOWN with login-failed after the form's 10 s, and leaves nothing behind", async () => {
    // The seed exits 0 but leaves the app no users, so the form is submitted and the signed-in marker never shows.
    const r = await runAccountsProbe({ web: ["owner"], recipeSeed: { args: ["-e", "require('node:fs').writeFileSync(process.env.ROVARA_DATA_DIR + '/users.json', JSON.stringify({ users: [] }))"] } });
    expect(r.run.unavailableReason, why(r)).toBe("login-failed");
    expect(r.run.actualRun).toBeNull();
    expect(r.outDir).toBeNull();
    expect(await leftovers(r)).toEqual(NOTHING);
    const logs = r.host.readDiagnostics(r.fixture.plan.runId).executorLogTail;
    expect(logs).toContain("orders-owner");
    for (const account of r.fixture.plan.accounts) { expect(logs).not.toContain(account.password); expect(logs).not.toContain(account.email); }
  }, 600_000);

  it("a page that prints the session token ends the run credential-leak: the files that carry it are removed and the run is never a result", async () => {
    const r = await runAccountsProbe({ defect: "echo-session.json", web: ["ownerIdentity"] });
    // The executor ends the run (exit 2) and the host reads nothing from its out directory.
    expect(r.run.unavailableReason, why(r)).toBe("executor-failed");
    expect(r.run.actualRun).toBeNull();
    expect(r.outDir).toBeNull();
    expect(r.host.readDiagnostics(r.fixture.plan.runId).executorLogTail).toContain("removed an output file that carried an account credential or a session value");
    expect(await leftovers(r)).toEqual(NOTHING);
  }, 600_000);
});
