import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIsolatedE2EApplication } from "../../packages/verifier/src/application-runtime.js";
import { webApiProbeRunInput } from "../../packages/verifier/src/host/web-api-probe-plan.js";
import { ACCOUNTS_APP_FILES, ACCOUNTS_FIXTURE_ROOT, createAccountsExecutorPlan, type AccountsPlanOptions } from "./e2e-accounts-fixture.js";
import { collectHostRun } from "./e2e-actual-run-proof.js";
import { createLinuxHost, type ProbeRun } from "./linux-runtime.js";

export type AccountsProbeOptions = AccountsPlanOptions & Readonly<{
  /** A defect file name under tests/fixtures/e2e-accounts-app/defects, placed in the owned mount and named by ORDERS_TEST_DEFECT_FILE. */
  defect?: "viewer-access.json" | "echo-session.json" | "echo-email.json";
  /** Extra environment for the app, through the recipe's start command. */
  appEnv?: Record<string, string>;
}>;

const kept: string[] = [];
/** Removes the kept copies of out directories and the candidate copies this module made. */
export async function removeAccountsDirs(): Promise<void> {
  for (const dir of kept.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Runs the accounts fixture app (seeded by its own recipe's seed command from the accounts file, signing in through its own form) through the production Docker host and lifecycle,
 * as the worker does, and keeps a copy of the completed run's out directory. The candidate is a copy of the fixture, as a `git archive` extraction would be.
 */
export async function runAccountsProbe(options: AccountsProbeOptions = {}): Promise<ProbeRun> {
  const { defect, appEnv, ...planOptions } = options;
  const fixture = createAccountsExecutorPlan({ ...planOptions, recipeStart: { env: { ...(defect ? { ORDERS_TEST_DEFECT_FILE: "/app/.owned/defect.json" } : {}), ...(appEnv ?? {}) },
    ...(planOptions.recipeStart ?? {}) } });
  const keep = realpathSync(await mkdtemp(join(tmpdir(), "rovara-accounts-kept-")));
  kept.push(keep);
  const candidate = join(keep, "candidate");
  for (const file of ACCOUNTS_APP_FILES) await cp(join(ACCOUNTS_FIXTURE_ROOT, file), join(candidate, file), { recursive: true });
  let credentialsLeaked: boolean | null = null; let outDir: string | null = null;
  const { host } = await createLinuxHost(fixture, {
    candidateSourceDir: candidate,
    ...(defect ? { ownedFiles: { "defect.json": await readFile(join(ACCOUNTS_FIXTURE_ROOT, "defects", defect)) } } : {}),
    async onRunOutput(run) {
      await cp(run.outDir, join(keep, "out"), { recursive: true });
      outDir = join(keep, "out");
      const files = (await readdir(outDir, { withFileTypes: true, recursive: true })).filter((entry) => entry.isFile());
      credentialsLeaked = (await Promise.all(files.map(async (entry) => run.containsCredential(await readFile(join(entry.parentPath, entry.name)))))).some(Boolean);
    },
  });
  const run = await runIsolatedE2EApplication({ input: webApiProbeRunInput(fixture) as never, compiled: fixture.compiled, ports: host, signal: AbortSignal.timeout(280_000) });
  return { fixture, run, exitCode: run.lifecycle.process.exitCode, outDir, credentialsLeaked, host };
}

/** The worker's own join after close, as `tests/linux/e2e-docker-host.test.ts` does it: the executor reports its image's node path, which the worker image shares; here the test process borrows it. */
export async function collectAccountsRun(r: ProbeRun): Promise<ReturnType<typeof collectHostRun>> {
  const actual = r.run.actualRun!;
  const inputs = await r.host.readCollectionInputs(new AbortController().signal);
  const original = process.execPath;
  process.execPath = actual.runnerToolchain.execPath;
  try { return collectHostRun(actual, inputs, r.fixture.plan); } finally { process.execPath = original; }
}
