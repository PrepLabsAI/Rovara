import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIsolatedE2EApplication, type E2EIsolatedApplicationRun } from "../../packages/verifier/src/application-runtime.js";
import { createDockerApplicationHost, createProcessDockerCli, type DockerApplicationHost } from "../../packages/verifier/src/host/docker-application-host.js";
import { webApiProbeRunInput } from "../../packages/verifier/src/host/web-api-probe-plan.js";
import { WEB_API_BUILD_IMAGE } from "../../packages/verifier/src/host/web-api-probe-runner.js";
import { ORDERS_FIXTURE_ROOT, createOrdersExecutorPlan, type OrdersExecutorFixture, type OrdersProbeName } from "./e2e-orders-executor-fixture.js";

/** The same pinned base the executor image is built from; the fixture app needs nothing but Node. */
export const APP_NODE_IMAGE = WEB_API_BUILD_IMAGE;
export const EXECUTOR_IMAGE = process.env.ROVARA_EXECUTOR_IMAGE ?? "rovara-e2e-executor:ci";

/** What every Linux test hands the production host: a real Docker, the two images, and a throwaway run root. */
export async function createLinuxHost(fixture: OrdersExecutorFixture, options: Omit<Parameters<typeof createDockerApplicationHost>[0],
  "docker" | "executorImage" | "buildImage" | "runRoot" | "now" | "admission" | "groupId" | "candidateSourceDir"> & { candidateSourceDir?: string } = {}): Promise<{ host: DockerApplicationHost; runRoot: string }> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "rovara-linux-host-")));
  linuxDirs.push(dir);
  const candidateSourceDir = options.candidateSourceDir ?? join(dir, "candidate");
  // The candidate is a copy of the fixture, as a `git archive` extraction would be; the host never writes to it.
  if (!options.candidateSourceDir) await cp(ORDERS_FIXTURE_ROOT, candidateSourceDir, { recursive: true });
  const runRoot = join(dir, "runs");
  const host = createDockerApplicationHost({ docker: createProcessDockerCli(), executorImage: EXECUTOR_IMAGE, buildImage: APP_NODE_IMAGE, runRoot, now: () => Date.now(),
    admission: fixture.plan.admission, groupId: fixture.plan.groupId, candidateSourceDir, ...options });
  return { host, runRoot };
}

/** The fixture's lifecycle input for one group, shaped like the broker's, for `runIsolatedE2EApplication`. */
export const linuxRunInput = webApiProbeRunInput;

export type ProbeOptions = Readonly<{
  /** A defect file name under tests/fixtures/e2e-web-api-app/defects, placed in the owned mount and named by ORDERS_TEST_DEFECT_FILE. */
  defect: string | null;
  /** Extra environment for the app, through the recipe's start command. */
  appEnv?: Record<string, string>;
  /** Replaces the app's start arguments, e.g. to make it exit at once. */
  appArgs?: string[];
  healthTimeoutMs?: number;
  /** Approves the app's inventory mock (its OpenAPI document and fixture) for the probe's target. */
  mock?: boolean;
  /** Replaces the recipe's build commands (the fixture itself builds nothing). */
  recipeBuild?: { program: string; args: string[]; cwd: string; timeoutMs: number; env: Record<string, string> }[];
}>;
export type ProbeRun = Readonly<{
  fixture: OrdersExecutorFixture; run: E2EIsolatedApplicationRun;
  /** The executor's exit code when it completed a run, else null (the run was unavailable). */
  exitCode: number | null;
  /** A kept copy of the out directory of a completed run; null when the run was unavailable. */
  outDir: string | null;
  /** Whether any byte of the kept out directory carries the run's account credentials (the host's own predicate); null when the run was unavailable. */
  credentialsLeaked: boolean | null;
  host: DockerApplicationHost;
}>;

const linuxDirs: string[] = [];
/** The executor writes as its own unprivileged user, so the host removes run directories itself; only the kept copies and candidate copies remain. */
export async function removeProbeDirs(): Promise<void> {
  for (const dir of linuxDirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Runs one compiled probe through the production Docker host and lifecycle, as the worker does. The host owns the network,
 * the app, the executor and all cleanup; this keeps a copy of the completed run's out directory for the test to inspect.
 */
export async function runProbe(probe: OrdersProbeName, options: ProbeOptions): Promise<ProbeRun> {
  const defectEnv = options.defect ? { ORDERS_TEST_DEFECT_FILE: "/app/.owned/defect.json" } : {};
  const fixture = createOrdersExecutorPlan({ probe, ...(options.mock ? { mock: true } : {}), recipeStart: { env: { ...defectEnv, ...(options.appEnv ?? {}) },
    ...(options.appArgs ? { args: options.appArgs } : {}), ...(options.healthTimeoutMs ? { timeoutMs: options.healthTimeoutMs } : {}) },
    ...(options.recipeBuild ? { recipeBuild: options.recipeBuild } : {}) });
  const keep = realpathSync(await mkdtemp(join(tmpdir(), "rovara-linux-kept-")));
  linuxDirs.push(keep);
  let credentialsLeaked: boolean | null = null; let outDir: string | null = null;
  const { host } = await createLinuxHost(fixture, {
    ...(options.defect ? { ownedFiles: { "defect.json": await readFile(join(ORDERS_FIXTURE_ROOT, "defects", options.defect)) } } : {}),
    async onRunOutput(run) {
      await cp(run.outDir, join(keep, "out"), { recursive: true });
      outDir = join(keep, "out");
      const files = (await readdir(outDir, { withFileTypes: true, recursive: true })).filter((entry) => entry.isFile());
      credentialsLeaked = (await Promise.all(files.map(async (entry) => run.containsCredential(await readFile(join(entry.parentPath, entry.name)))))).some(Boolean);
    },
  });
  const run = await runIsolatedE2EApplication({ input: linuxRunInput(fixture) as never, compiled: fixture.compiled, ports: host, signal: AbortSignal.timeout(280_000) });
  return { fixture, run, exitCode: run.lifecycle.process.exitCode, outDir, credentialsLeaked, host };
}
