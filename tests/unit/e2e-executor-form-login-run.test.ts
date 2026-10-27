import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { E2E_EXECUTOR_HOST_MODULE_PATH } from "../../packages/verifier/src/executor/host-registry.js";
import { runE2EExecutorSerially as runE2EExecutor } from "../support/executor-run-lock.js";
import { createAccountsExecutorPlan } from "../support/e2e-accounts-fixture.js";
import { startAccountsApp, type AccountsAppProcess } from "../support/accounts-app-process.js";
import { allOutputText, caseStatusesAll as caseStatuses, observations, resultOf } from "../support/e2e-executor-output.js";

// Task 3.2, end to end on this machine: the real executor, the pinned CLI, a real Chromium and the accounts fixture app (seeded for real, signing in through its own form). The container
// walls are not here, and the sandbox attestation is stood in for; what is here is every byte of the login, the cases and the files the executor leaves.
const verifierRoot = join(import.meta.dirname, "../../packages/verifier");
const runnable = existsSync(join(verifierRoot, E2E_EXECUTOR_HOST_MODULE_PATH)) && existsSync(chromium.executablePath());
const sandboxed = async (request: { runId: string; groupId: string }) => ({ schemaVersion: "e2e-executor-chromium-sandbox/v1" as const, runId: request.runId, groupId: request.groupId,
  browser: { pid: 40, nsPidDepth: 1, seccompFilters: 1, uidMap: "0 0 4294967295" }, renderers: [{ pid: 41, nsPidDepth: 2, seccompFilters: 2, uidMap: "0 1000 1" }] });

const dirs: string[] = []; const apps: AccountsAppProcess[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.stop())); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

type AccountsOptions = NonNullable<Parameters<typeof createAccountsExecutorPlan>[0]>;
async function runAccounts(options: { defect?: "viewer-access.json" | "echo-session.json" | "echo-email.json" | "rotate-echo.json" | "storage-echo.json"; api?: boolean; web?: AccountsOptions["web"] } = {}) {
  const fixture = createAccountsExecutorPlan({ healthTimeoutMs: 20_000, ...(options.api ? { api: true } : {}), ...(options.web ? { web: options.web } : {}) });
  const app = await startAccountsApp(fixture, options.defect ? { defect: options.defect } : {}); apps.push(app);
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "accounts-run-"))); dirs.push(dir);
  const out = join(dir, "out");
  await writeFile(join(dir, "plan.json"), JSON.stringify(fixture.plan));
  const result = await runE2EExecutor({ planPath: join(dir, "plan.json"), outDir: out, signal: AbortSignal.timeout(240_000), localAppUpstream: app.upstream,
    inspectChromiumSandbox: sandboxed, chromiumSandboxSettleMs: 0 });
  return { fixture, out, result };
}
const executorLog = (out: string) => readFileSync(join(out, "executor.log"), "utf8");

describe.runIf(runnable)("the executor against an app that signs in through its own form", () => {
  it("runs three accounts in two tenants in one run: the viewer sees no export, the owner exports, the other tenant's owner sees none of tenant-a's rows", async () => {
    const { fixture, out, result } = await runAccounts();
    expect(result, executorLog(out)).toEqual({ exitCode: 0, reason: null });
    expect(caseStatuses(out, fixture)).toEqual({ "viewer-cannot-export": "passed", "owner-exports-orders": "passed", "other-tenant-sees-no-orders-of-a": "passed" });
    // Each case was observed under its own account: the account observation names the profile's tenant and role.
    const accountObservations = observations(out).filter((item) => item.kind === "identity-observation").map((item) => JSON.parse(item.content!) as { schemaVersion: string; caseId: string; accountRef?: { profileId: string }; identity?: { tenantId: string; role: string } })
      .filter((item) => item.schemaVersion === "e2e-executor-account-observation/v1");
    expect(accountObservations.map((item) => [item.accountRef!.profileId, item.identity!.tenantId, item.identity!.role]).sort()).toEqual(
      [["orders-owner", "tenant-a", "owner"], ["orders-owner-b", "tenant-b", "owner"], ["orders-viewer", "tenant-a", "viewer"]]);
    expect(new Set(accountObservations.map((item) => item.caseId)).size).toBe(3);
  }, 300_000);

  it("leaves no seeded password, email, email local part or session cookie in any file under out/", async () => {
    const { fixture, out, result } = await runAccounts();
    expect(result.exitCode, executorLog(out)).toBe(0);
    const everything = allOutputText(out);
    expect(everything.length).toBeGreaterThan(1_000);
    for (const account of fixture.plan.accounts) {
      expect(everything, account.profileId).not.toContain(account.password);
      expect(everything, account.profileId).not.toContain(account.email);
      expect(everything, account.profileId).not.toContain(account.email.slice(0, account.email.indexOf("@")));
      expect(everything, account.profileId).not.toContain(Buffer.from(account.password).toString("base64"));
      expect(everything, account.profileId).not.toContain(encodeURIComponent(account.email));
    }
    // The cookie the application issued is not in the out directory either (the raw report and every observation were written by code that knew it).
    expect(everything).not.toMatch(/\bsid=[A-Za-z0-9_-]{20,}/);
    // No trace was captured: tracing does not exist in this executor, so the keystrokes of the login cannot be in one.
    expect(readdirSync(out, { recursive: true }).map(String).filter((name) => /trace|\.zip$|\.har$/i.test(name))).toEqual([]);
  }, 300_000);

  it("fails the viewer's case on the visible assertion when the viewer-access defect lets a viewer export, and still passes the others", async () => {
    const { fixture, out, result } = await runAccounts({ defect: "viewer-access.json" });
    expect(result, executorLog(out)).toEqual({ exitCode: 1, reason: null });
    expect(caseStatuses(out, fixture)).toEqual({ "viewer-cannot-export": "failed", "owner-exports-orders": "passed", "other-tenant-sees-no-orders-of-a": "passed" });
    const failed = observations(out).filter((item) => item.kind === "case-capture").map((item) => JSON.parse(item.content!) as { caseId: string; assertions: { index: number; outcome: string }[] })
      .flatMap((capture) => capture.assertions.filter((item) => item.outcome === "failed").map((item) => ({ caseId: capture.caseId, index: item.index })));
    expect(failed).toHaveLength(1);
    const expected = fixture.compiled.expectedCases.find((item) => item.caseId === failed[0]!.caseId)!;
    expect(expected.scenarioId).toBe("viewer-cannot-export");
    expect(fixture.compiled.bundle.scenarios.find((scenario) => scenario.scenarioId === "viewer-cannot-export")!.assertions[failed[0]!.index]!.kind).toBe("visible");
    // The failed case earned one screenshot of the case's own page, named by its index and nothing else; it is not of the login (that happened in another context) and it is clean.
    const artifacts = JSON.parse(readFileSync(join(out, "artifacts.json"), "utf8")) as { artifacts: { caseId: string; kind: string; omitted?: string }[] };
    expect(artifacts.artifacts).toEqual([{ caseId: failed[0]!.caseId, kind: "screenshot", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown, bytes: expect.any(Number) as unknown }]);
    expect(readdirSync(join(out, "captures"))).toEqual([`case-${fixture.compiled.expectedCases.findIndex((item) => item.caseId === failed[0]!.caseId)}-screenshot.jpg`]);
  }, 300_000);

  it("refuses a run whose page prints the session token into the text an assertion reads: the files that carry it are removed and the run ends credential-leak (exit 2)", async () => {
    const { fixture, out, result } = await runAccounts({ defect: "echo-session.json", web: ["ownerIdentity"] });
    expect(result, executorLog(out)).toEqual({ exitCode: 2, reason: "credential-leak" });
    expect(executorLog(out)).toMatch(/removed an output file that carried an account credential or a session value: observations\/ev-/);
    const everything = allOutputText(out);
    for (const account of fixture.plan.accounts) { expect(everything).not.toContain(account.password); expect(everything).not.toContain(account.email); }
    expect(everything).not.toMatch(/\bsid=[A-Za-z0-9_-]{20,}/);
    // The page's text with the token in it was the assertion's observation; no observation that remains holds a long token after the name and role.
    expect(JSON.stringify(observations(out))).not.toMatch(/\(owner\) [A-Za-z0-9_-]{30,}/);
  }, 300_000);

  it("never stores the text of a page that prints the account's email: the evidence is refused when it is written, the case is not a pass, and the email is nowhere in out/", async () => {
    const { fixture, out, result } = await runAccounts({ defect: "echo-email.json", web: ["ownerIdentity"] });
    expect(result.exitCode, executorLog(out)).not.toBe(0);
    expect(caseStatuses(out, fixture)["owner-identity-text"]).not.toBe("passed");
    const everything = allOutputText(out);
    for (const account of fixture.plan.accounts) { expect(everything).not.toContain(account.password); expect(everything).not.toContain(account.email); expect(everything).not.toContain(account.email.slice(0, account.email.indexOf("@"))); }
  }, 300_000);

  it("keeps a report whole when the application leaves short, word-like cookies after the login (consent=1, ok=true, cookie_consent=accepted, theme=dark), across two shards", async () => {
    const { fixture, out, result } = await runAccounts({ web: ["viewer", "owner"] });
    expect(result, executorLog(out)).toEqual({ exitCode: 0, reason: null });
    // Two accounts are two shards; the merged report is read back whole, with the numbers and booleans a short cookie value would otherwise have replaced.
    expect(caseStatuses(out, fixture)).toEqual({ "viewer-cannot-export": "passed", "owner-exports-orders": "passed" });
    const reportText = readFileSync(join(out, "report.json"), "utf8");
    expect(reportText).not.toContain("<session>");
    expect(JSON.parse(reportText)).toMatchObject({ schemaVersion: "e2e-executor-multi-report/v1" });
    for (const shard of readdirSync(join(out, "shards"))) expect(readFileSync(join(out, "shards", shard, "report.json"), "utf8")).not.toContain("<session>");
    expect(executorLog(out)).not.toContain("<session>");
  }, 300_000);

  it("registers the session cookie an application swaps in after the login: a page that prints the rotated cookie ends the run credential-leak", async () => {
    const { out, result } = await runAccounts({ defect: "rotate-echo.json", web: ["ownerIdentity"] });
    expect(result, executorLog(out)).toEqual({ exitCode: 2, reason: "credential-leak" });
    expect(executorLog(out)).toMatch(/removed an output file that carried an account credential or a session value: observations\/ev-/);
    expect(allOutputText(out)).not.toMatch(/\(owner\) [A-Za-z0-9_-]{30,}/);
  }, 300_000);

  it("registers a token the page keeps in local storage while the case runs (N3): a page that prints it ends the run credential-leak, though no cookie carries it", async () => {
    const { out, result } = await runAccounts({ defect: "storage-echo.json", web: ["ownerIdentity"] });
    expect(result, executorLog(out)).toEqual({ exitCode: 2, reason: "credential-leak" });
    expect(executorLog(out)).toMatch(/removed an output file that carried an account credential or a session value: observations\/ev-/);
    expect(allOutputText(out)).not.toMatch(/\(owner\) [A-Za-z0-9_-]{30,}/);
  }, 300_000);

  it("a value the page keeps and prints that is app data, not a credential (an opaque document id under a neutral key), is scrubbed or dropped but never ends the run credential-leak (MIDSTEP-2 N-8)", async () => {
    const { out, result } = await runAccounts({ defect: "weak-echo.json", web: ["ownerIdentity"] });
    // The case itself fails (the page prints text the assertion does not expect), which is exit 1; the point is that the run is not `credential-leak` (exit 2).
    expect(result, executorLog(out)).toEqual({ exitCode: 1, reason: null });
    // The files that carried it were removed and the log says why, in words that are not the credential sentence.
    expect(executorLog(out)).toMatch(/removed an output file that carried a value only scrubbed from evidence \(not a credential\): /);
    expect(executorLog(out)).not.toMatch(/carried an account credential or a session value/);
    expect(allOutputText(out)).not.toMatch(/\bDoc[0-9a-f]{17}\b/);
  }, 300_000);

  it("answers API cases of the same accounts through the cookies the form login kept: the viewer is refused (403), the owner is allowed (200)", async () => {
    const { fixture, out, result } = await runAccounts({ api: true });
    expect(result, executorLog(out)).toEqual({ exitCode: 0, reason: null });
    expect(caseStatuses(out, fixture)).toEqual({ "api-viewer-refused": "passed", "api-owner-allowed": "passed" });
    const everything = allOutputText(out);
    for (const account of fixture.plan.accounts) { expect(everything).not.toContain(account.password); expect(everything).not.toContain(account.email); }
    expect(everything).not.toMatch(/\bsid=[A-Za-z0-9_-]{20,}/);
  }, 300_000);

  it("ends the run as login-failed (exit 2) when the application does not sign an account in, and says which profile", async () => {
    const fixture = createAccountsExecutorPlan({ healthTimeoutMs: 20_000, web: ["owner"] });
    // An app whose users were seeded for other credentials: the form never reaches the signed-in marker.
    const app = await startAccountsApp(createAccountsExecutorPlan({ web: ["owner"] })); apps.push(app);
    const dir = realpathSync(await mkdtemp(join(tmpdir(), "accounts-run-"))); dirs.push(dir);
    const out = join(dir, "out");
    await writeFile(join(dir, "plan.json"), JSON.stringify(fixture.plan));
    const result = await runE2EExecutor({ planPath: join(dir, "plan.json"), outDir: out, signal: AbortSignal.timeout(240_000), localAppUpstream: app.upstream,
      inspectChromiumSandbox: sandboxed, chromiumSandboxSettleMs: 0 });
    expect(result).toEqual({ exitCode: 2, reason: "login-failed" });
    expect(resultOf(out)).toMatchObject({ exitCode: 2, reason: "login-failed" });
    const log = executorLog(out);
    expect(log).toContain("orders-owner");
    const everything = allOutputText(out);
    for (const account of fixture.plan.accounts) { expect(everything).not.toContain(account.password); expect(everything).not.toContain(account.email); }
  }, 300_000);
});
