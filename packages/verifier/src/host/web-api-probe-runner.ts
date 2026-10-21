import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { E2E_CHROMIUM_SANDBOX_FILE, WEB_API_REQUIRED_PROBES, canonicalJson, webApiProbeRunId, type RuntimeInstallChallenge, type WebApiProbeEvidence, type WebApiProbeRun } from "@agentx/contracts";
import { collectE2EApplicationRun } from "../application-collection.js";
import { loadWebApiQualificationProbeAssets } from "../application-runtime-probes.js";
import { runIsolatedE2EApplication } from "../application-runtime.js";
import { resolveE2EExecutorSuite } from "../executor/suite.js";
import { deriveWebApiProbeObservation } from "../web-api-probe-evidence.js";
import { WEB_API_BUILD_IMAGE, createDockerApplicationHost, e2eRunNetworks, type DockerCli } from "./docker-application-host.js";
import { createWebApiProbePlan, webApiProbeDriver, webApiProbeRunInput } from "./web-api-probe-plan.js";
import { installedWebApiQualificationAppRoot, stageWebApiQualificationApp, verifyWebApiQualificationApp } from "./web-api-qualification-app.js";

/** The pinned Node base image that builds and runs the candidate; the same one the executor image is built from (defined beside the host that uses it). */
export { WEB_API_BUILD_IMAGE };
/** The most raw bytes of a blocked-requests file kept: 196,608 bytes is exactly the 262,144 base64 characters the evidence schema allows. */
export const MAX_BLOCKED_REQUESTS_BYTES = 196_608;
/** The most raw bytes of a Chromium sandbox attestation kept: 49,152 bytes is exactly the 65,536 base64 characters the evidence schema allows. */
const MAX_CHROMIUM_SANDBOX_BYTES = 49_152;
const CLEANUP_TIMEOUT_MS = 30_000;
const DEFECT_FILE_IN_OWNED_MOUNT = "/app/.owned/defect.json";

export type WebApiProbeRunnerDeps = Readonly<{
  docker: DockerCli;
  /** The executor image the worker pulled at boot (`EXECUTOR_IMAGE`). */
  executorImage: string;
  /** The pinned build image; normally `WEB_API_BUILD_IMAGE`. */
  buildImage: string;
  /** A directory on the Docker host at the same path inside this process; each probe stages its candidate and its run files there. */
  runRoot: string;
  /** The pre-created private directory the retained probe evidence is written under. */
  evidenceRoot: string;
  challenge: RuntimeInstallChallenge;
  /** Test seams: another copy of the app and of the probe assets (both still checked against their pins), the clock, the collector and the run's time limit. */
  qualificationAppRoot?: string;
  probeAssetsRoot?: string;
  now?: () => number;
  collect?: typeof collectE2EApplicationRun;
  probeTimeoutMs?: number;
}>;

const reasonOf = (text: string | null | undefined) => (text && text.length > 0 ? text : "unavailable").slice(0, 200);

/**
 * The production probe runner. Each probe is staged from the verified installed qualification app, run through the Docker host and
 * the real collector under the run id derived from the challenge, and reported as the observation `deriveWebApiProbeObservation` reads out of the
 * retained evidence. The build exit code is the host's structured result. Nothing here judges the outcome; the qualifier and the registrar do.
 */
export function createWebApiProbeRunner(deps: WebApiProbeRunnerDeps): (probeId: string) => Promise<WebApiProbeRun> {
  const collect = deps.collect ?? collectE2EApplicationRun;
  const now = deps.now ?? (() => Date.now());
  // One private directory per qualification attempt, so retrying a challenge never collides with the files of an earlier attempt.
  let evidenceDirectory: Promise<string> | undefined;
  const retainEvidence = async (probeId: string, evidence: WebApiProbeEvidence): Promise<void> => {
    evidenceDirectory ??= mkdtemp(join(deps.evidenceRoot, `web-api-probe-evidence-${deps.challenge.challengeId}-`)).then(async (directory) => { await chmod(directory, 0o700); return directory; });
    await writeFile(join(await evidenceDirectory, `${probeId}.json`), `${canonicalJson(evidence)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  };
  return async (probeId) => {
    const driver = webApiProbeDriver(probeId);
    if (!WEB_API_REQUIRED_PROBES.some((probe) => probe.probeId === probeId)) throw new Error(`no probe plan for ${probeId}`);
    // The probe assets the plan is built from are the pinned ones, or nothing starts.
    loadWebApiQualificationProbeAssets(deps.probeAssetsRoot);
    const runId = webApiProbeRunId(deps.challenge, probeId);
    const staged = join(deps.runRoot, `candidate-${runId}`);
    // The installed app is verified before anything, Docker included, is touched; staging checks the copy again.
    const appRoot = deps.qualificationAppRoot ?? installedWebApiQualificationAppRoot();
    await verifyWebApiQualificationApp(appRoot);
    await clearEarlierAttempt(deps, runId, staged);
    // The app is verified against the pinned tree before anything is built; a changed installed app never reaches Docker.
    await stageWebApiQualificationApp(appRoot, staged);
    try {
      const plan = createWebApiProbePlan({ probe: driver.probe, appRoot: staged, runId, ...(driver.mock === true ? { mock: true } : {}),
        recipeStart: { env: { ...(driver.defect ? { ORDERS_TEST_DEFECT_FILE: DEFECT_FILE_IN_OWNED_MOUNT } : {}), ...driver.appEnv }, ...(driver.startArgs ? { args: [...driver.startArgs] } : {}) },
        ...(driver.recipeBuild ? { recipeBuild: driver.recipeBuild.map((command) => ({ ...command, args: [...command.args], env: { ...command.env } })) } : {}) });
      let blockedRequests: Uint8Array | null = null;
      let chromiumSandbox: Uint8Array | null = null;
      const retainsSandbox = WEB_API_REQUIRED_PROBES.find((probe) => probe.probeId === probeId)?.chromiumSandbox === true;
      const host = createDockerApplicationHost({ docker: deps.docker, executorImage: deps.executorImage, buildImage: deps.buildImage, runRoot: deps.runRoot, now,
        admission: plan.plan.admission, groupId: plan.plan.groupId, candidateSourceDir: staged,
        ...(driver.defect ? { ownedFiles: { "defect.json": await readFile(join(staged, "defects", driver.defect)) } } : {}),
        // The executor's blocked-requests file leaves the run only here, before the run's directory is removed.
        async onRunOutput(run) {
          blockedRequests = await readBlockedRequests(run.outDir);
          if (retainsSandbox) chromiumSandbox = await readChromiumSandboxAttestation(run.outDir);
        } });
      const signal = AbortSignal.timeout(deps.probeTimeoutMs ?? 280_000);
      const run = await runIsolatedE2EApplication({ input: webApiProbeRunInput(plan) as never, compiled: plan.compiled, ports: host, signal });

      let evidence: WebApiProbeEvidence;
      const unavailable = (reason: string): WebApiProbeEvidence => {
        const build = host.readBuildResult(runId);
        return { kind: "unavailable", runId, reason: reasonOf(reason), build: build === null ? null : { commandIndex: build.commandIndex, exitCode: build.exitCode,
          command: build.command === null ? null : { ...build.command, args: [...build.command.args], env: { ...build.command.env } } } };
      };
      if (run.unavailableReason !== null || run.actualRun === null) evidence = unavailable(run.unavailableReason ?? "unavailable");
      else {
        const inputs = await host.readCollectionInputs(signal);
        const resolved = resolveE2EExecutorSuite(plan.plan);
        const collected = collect({ actual: run.actualRun, compiled: resolved.suite, binding: resolved.binding, round: resolved.round, ...inputs });
        evidence = collected.collection === null || collected.oracle === null ? unavailable(collected.unavailableReason ?? "collector-unavailable")
          : { kind: "collected", runId, scenarioBundle: JSON.parse(JSON.stringify(plan.compiled.bundle)) as Record<string, unknown>,
            collection: JSON.parse(JSON.stringify(collected.collection)) as Record<string, unknown>, oracle: JSON.parse(JSON.stringify(collected.oracle)) as Record<string, unknown>,
            blockedRequestsBase64: driver.probe.startsWith("web-") && blockedRequests !== null ? Buffer.from(blockedRequests).toString("base64") : null,
            ...(retainsSandbox ? { chromiumSandboxBase64: chromiumSandbox === null ? null : Buffer.from(chromiumSandbox).toString("base64") } : {}) };
      }
      const derived = deriveWebApiProbeObservation({ challenge: deps.challenge, probeId, evidence });
      if (!derived.ok) throw new Error(derived.reason);
      await retainEvidence(probeId, evidence);
      return { observation: derived.observation, evidence };
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  };
}

/** The executor's Chromium sandbox attestation, or null when it is missing or too large for the evidence schema's base64 bound. */
export async function readChromiumSandboxAttestation(outDir: string): Promise<Uint8Array | null> {
  return readFile(join(outDir, E2E_CHROMIUM_SANDBOX_FILE)).then((bytes) => (bytes.byteLength <= MAX_CHROMIUM_SANDBOX_BYTES ? bytes : null), () => null);
}

/** The executor's blocked-requests file, or null when it is missing or too large for the evidence schema's base64 bound. */
export async function readBlockedRequests(outDir: string): Promise<Uint8Array | null> {
  return readFile(join(outDir, "blocked-requests.json")).then((bytes) => (bytes.byteLength <= MAX_BLOCKED_REQUESTS_BYTES ? bytes : null), () => null);
}

/**
 * Removes what an earlier attempt of this same run (the run id is derived from the challenge, so a retry reuses it) may have left: the staged candidate
 * copy, the run's workspace, and any container or network labeled for it. The host refuses to allocate over an existing workspace, so without this a
 * qualification killed part-way could not be retried within its challenge.
 */
async function clearEarlierAttempt(deps: WebApiProbeRunnerDeps, runId: string, staged: string): Promise<void> {
  const signal = new AbortController().signal;
  const admin = (args: string[]) => deps.docker.run(args, { signal, timeoutMs: CLEANUP_TIMEOUT_MS });
  const listed = await admin(["ps", "-a", "--filter", `label=rovara.run=${runId}`, "--format", "{{.Names}}"]);
  const containers = listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (containers.length > 0) await admin(["rm", "-f", ...containers]);
  const networks = e2eRunNetworks(runId);
  await admin(["network", "rm", networks.build]);
  await admin(["network", "rm", networks.internal]);
  await rm(staged, { recursive: true, force: true });
  const workspace = join(deps.runRoot, runId);
  if (await stat(workspace).then(() => false, () => true)) return;
  try { await rm(workspace, { recursive: true, force: true }); return; } catch { /* files written by a container's user may not be removable by this one */ }
  // A throwaway root container with no network and only this directory mounted removes what this user cannot.
  await admin(["run", "--rm", "--pull=never", "--label", `rovara.run=${runId}`, "--network", "none", "--user", "0:0", "--entrypoint", "rm", "-v", `${workspace}:/d`, deps.executorImage, "-rf", "/d/app", "/d/out", "/d/owned"]);
  await rm(workspace, { recursive: true, force: true });
}
