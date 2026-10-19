import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WEB_API_REQUIRED_PROBES, canonicalJson, webApiProbeRunId, type RuntimeInstallChallenge, type WebApiProbeEvidence, type WebApiProbeRun } from "@agentx/contracts";
import { collectE2EApplicationRun } from "../application-collection.js";
import { runIsolatedE2EApplication } from "../application-runtime.js";
import { resolveE2EExecutorSuite } from "../executor/suite.js";
import { deriveWebApiProbeObservation } from "../web-api-probe-evidence.js";
import { createDockerApplicationHost, type DockerCli } from "./docker-application-host.js";
import { createWebApiProbePlan, webApiProbeDriver, webApiProbeRunInput } from "./web-api-probe-plan.js";
import { installedWebApiQualificationAppRoot, stageWebApiQualificationApp } from "./web-api-qualification-app.js";

/** The pinned Node base image that builds and runs the candidate; the same one the executor image is built from. */
export const WEB_API_BUILD_IMAGE = "public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5";
const MAX_BLOCKED_REQUESTS_BYTES = 262_144;
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
  /** Test seams: another copy of the app (still checked against the pinned tree), the clock, the collector and the run's time limit. */
  qualificationAppRoot?: string;
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
    const runId = webApiProbeRunId(deps.challenge, probeId);
    const staged = join(deps.runRoot, `candidate-${runId}`);
    // The app is verified against the pinned tree before anything is built; a changed installed app never reaches Docker.
    await stageWebApiQualificationApp(deps.qualificationAppRoot ?? installedWebApiQualificationAppRoot(), staged);
    try {
      const plan = createWebApiProbePlan({ probe: driver.probe, appRoot: staged, runId,
        recipeStart: { env: { ...(driver.defect ? { ORDERS_TEST_DEFECT_FILE: DEFECT_FILE_IN_OWNED_MOUNT } : {}), ...driver.appEnv } },
        ...(driver.recipeBuild ? { recipeBuild: driver.recipeBuild.map((command) => ({ ...command, args: [...command.args], env: { ...command.env } })) } : {}) });
      let blockedRequests: Uint8Array | null = null;
      const host = createDockerApplicationHost({ docker: deps.docker, executorImage: deps.executorImage, buildImage: deps.buildImage, runRoot: deps.runRoot, now,
        admission: plan.plan.admission, groupId: plan.plan.groupId, candidateSourceDir: staged,
        ...(driver.defect ? { ownedFiles: { "defect.json": await readFile(join(staged, "defects", driver.defect)) } } : {}),
        // The executor's blocked-requests file leaves the run only here, before the run's directory is removed.
        async onRunOutput(run) { blockedRequests = await readFile(join(run.outDir, "blocked-requests.json")).then((bytes) => (bytes.byteLength <= MAX_BLOCKED_REQUESTS_BYTES ? bytes : null), () => null); } });
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
            blockedRequestsBase64: driver.probe.startsWith("web-") && blockedRequests !== null ? Buffer.from(blockedRequests).toString("base64") : null };
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
