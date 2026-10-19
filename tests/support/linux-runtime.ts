import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2EExecutorPlanSchema, type E2EExecutorAccount } from "@agentx/contracts";
import { runIsolatedE2EApplication, type E2EIsolatedApplicationRun } from "../../packages/verifier/src/application-runtime.js";
import { createDockerApplicationHost, createProcessDockerCli, type DockerApplicationHost } from "../../packages/verifier/src/host/docker-application-host.js";
import { ORDERS_FIXTURE_ROOT, createOrdersExecutorPlan, type OrdersExecutorFixture, type OrdersProbeName } from "./e2e-orders-executor-fixture.js";

/** The same pinned base the executor image is built from; the fixture app needs nothing but Node. */
export const APP_NODE_IMAGE = "public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5";
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
export function linuxRunInput(fixture: OrdersExecutorFixture) {
  const { compiled, plan } = fixture;
  const ref = compiled.runtimeAdmissionContext.selectionInput.intent.applicationRuntimeRefs[0]!;
  const app = compiled.applicationBindings.get(ref.applicationId)!; const runtime = compiled.runtimeBindings.get(ref.runtimeProfileId)!;
  return { binding: plan.admission.round.groupBindings[0]!, suite: { bundle: compiled.bundle, files: compiled.shards[0]!.files, expectedCases: compiled.expectedCases },
    profile: { profileId: runtime.profileId, kind: "web", runtimeManifestDigest: runtime.manifestDigest,
      applications: [{ applicationId: ref.applicationId, appBuildManifestDigest: app.build.manifestDigest,
        appRecipe: app.approval.applications.find((item) => item.applicationId === ref.applicationId)!.recipe }],
      networkPolicyDigest: runtime.capabilities.networkPolicyDigest, seedDigest: "a".repeat(64), limits: runtime.binding,
      capture: compiled.runtimeAdmissionContext.selectionInput.policy.capture }, modelPermit: null };
}

export type ProbeOptions = Readonly<{
  /** A defect file name under tests/fixtures/e2e-web-api-app/defects, placed in the owned mount and named by ORDERS_TEST_DEFECT_FILE. */
  defect: string | null;
  /** Extra environment for the app, through the recipe's start command. */
  appEnv?: Record<string, string>;
  /** Replaces the app's start arguments, e.g. to make it exit at once. */
  appArgs?: string[];
  healthTimeoutMs?: number;
}>;
export type ProbeRun = Readonly<{
  fixture: OrdersExecutorFixture; run: E2EIsolatedApplicationRun;
  /** The executor's exit code when it completed a run, else null (the run was unavailable). */
  exitCode: number | null;
  /** A kept copy of the out directory of a completed run; null when the run was unavailable. */
  outDir: string | null;
  /** The synthetic account the host generated for the run; null when the run was unavailable. */
  account: E2EExecutorAccount | null;
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
  const fixture = createOrdersExecutorPlan({ probe, recipeStart: { env: { ...defectEnv, ...(options.appEnv ?? {}) },
    ...(options.appArgs ? { args: options.appArgs } : {}), ...(options.healthTimeoutMs ? { timeoutMs: options.healthTimeoutMs } : {}) } });
  const keep = realpathSync(await mkdtemp(join(tmpdir(), "rovara-linux-kept-")));
  linuxDirs.push(keep);
  let account: E2EExecutorAccount | null = null; let outDir: string | null = null;
  const { host } = await createLinuxHost(fixture, {
    ...(options.defect ? { ownedFiles: { "defect.json": await readFile(join(ORDERS_FIXTURE_ROOT, "defects", options.defect)) } } : {}),
    async onRunOutput(paths) {
      await cp(paths.outDir, join(keep, "out"), { recursive: true });
      outDir = join(keep, "out");
      account = E2EExecutorPlanSchema.parse(JSON.parse(await readFile(paths.planPath, "utf8"))).accounts[0] ?? null;
    },
  });
  const run = await runIsolatedE2EApplication({ input: linuxRunInput(fixture) as never, compiled: fixture.compiled, ports: host, signal: AbortSignal.timeout(280_000) });
  return { fixture, run, exitCode: run.lifecycle.process.exitCode, outDir, account, host };
}
