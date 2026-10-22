import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readE2EApplicationProjectContract, type E2EExecutorPlan } from "@agentx/contracts";
import { ACCOUNTS_APP_FILES, ACCOUNTS_FIXTURE_ROOT } from "./e2e-accounts-fixture.js";
import type { OrdersExecutorFixture } from "./e2e-orders-executor-fixture.js";

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
});

export type AccountsAppProcess = Readonly<{ upstream: string; directory: string; stop(): Promise<void> }>;

/**
 * The accounts fixture app as the Rovara host would run it, but on this machine: the accounts file the host writes for the plan's accounts, the recipe's seed command run for real
 * against it, then the app on a loopback port reading the records the seed built. For executor tests that run the real CLI and a real local Chromium without Docker.
 */
export async function startAccountsApp(fixture: OrdersExecutorFixture, options: { defect?: "viewer-access.json" | "echo-session.json" | "echo-email.json" | "rotate-echo.json" | "storage-echo.json" } = {}): Promise<AccountsAppProcess> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "accounts-app-")));
  const app = join(directory, "app");
  await mkdir(join(app, ".owned"), { recursive: true });
  for (const file of ACCOUNTS_APP_FILES) await cp(join(ACCOUNTS_FIXTURE_ROOT, file), join(app, file), { recursive: true });
  const plan: E2EExecutorPlan = fixture.plan;
  const applicationId = fixture.compiled.originByApplicationId[0]!.applicationId;
  const contract = readE2EApplicationProjectContract(fixture.compiled.runtimeAdmissionContext.selectionInput.sourceSnapshot, applicationId)!;
  const accountsFile = join(directory, "rovara-accounts.json");
  await writeFile(accountsFile, JSON.stringify({ schemaVersion: "rovara-accounts/v1", accounts: plan.accounts.map((account) => {
    const profile = contract.accountProfiles.find((item) => item.profileId === account.profileId)!;
    return { profileId: account.profileId, email: account.email, password: account.password, tenantRef: profile.tenantRef, roleRef: profile.roleRef };
  }) }));
  const data = join(directory, "data");
  await mkdir(data);
  const env = { PATH: process.env.PATH ?? "", ROVARA_ACCOUNTS_FILE: accountsFile, ROVARA_DATA_DIR: data };
  execFileSync(process.execPath, ["seed.mjs"], { cwd: app, env, stdio: "pipe" });
  const defectEnv: Record<string, string> = {};
  if (options.defect) {
    await cp(join(ACCOUNTS_FIXTURE_ROOT, "defects", options.defect), join(app, ".owned", "defect.json"));
    defectEnv.ORDERS_TEST_DEFECT_FILE = join(app, ".owned", "defect.json");
  }
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ["server.mjs"], { cwd: app, env: { ...env, ...defectEnv, APP_PORT: String(port) }, stdio: "ignore" });
  const upstream = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${upstream}/health`)).status === 200) break; } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { upstream, directory, async stop() {
    child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  } };
}
