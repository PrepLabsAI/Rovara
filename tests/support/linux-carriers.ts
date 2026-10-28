import { chmodSync, realpathSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryE2EDayBudget } from "../../packages/model-runtime/src/e2e-route.js";
import { runIsolatedE2EApplication } from "../../packages/verifier/src/application-runtime.js";
import { e2eApplicationGroupAgentSteps } from "../../packages/verifier/src/application-scenarios.js";
import { createDockerApplicationHost, createProcessDockerCli, type DockerApplicationHost } from "../../packages/verifier/src/host/docker-application-host.js";
import { webApiProbeRunInput } from "../../packages/verifier/src/host/web-api-probe-plan.js";
import { createE2EModelEvidenceCollector, openE2EModelChannelSession } from "../../packages/worker/src/e2e-model-channel-session.js";
import { CARRIERS_APP_FILES, CARRIERS_ROOT, createCarrierModel, createCarrierPlan, plantCarrierSets, type CarrierName, type CarrierRun } from "./e2e-midstep-carriers.js";
import { resultOf } from "./e2e-executor-output.js";
import { APP_NODE_IMAGE, EXECUTOR_IMAGE } from "./linux-runtime.js";
import { SCRIPTED_ROUTE } from "./orders-m14-agent.js";

/**
 * One group of the MIDSTEP-2 carrier test on a real Docker host: the production host runs the carrier fixture app and the real executor image, and the worker's real model session (opened by
 * the host just before the executor starts) answers from the scripted double. The values the app issues are generated here for this run and reach the app only through a file in the host's
 * owned mount (a temp directory of this run); the kept copy of the out directory and the candidate copy are temp directories too. The linux-runtime job of CI is the only place this runs.
 */
export type CarrierDockerRun = CarrierRun & Readonly<{ host: DockerApplicationHost; credentialsLeaked: boolean | null }>;

const dirs: string[] = [];
export async function removeCarrierDirs(): Promise<void> { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined); }

/** Where the app reads the planted sets from inside its container: the owned mount, as the accounts fixture's defect file is. */
const CARRIERS_FILE_IN_CONTAINER = "/app/.owned/carriers.json";

export async function runCarrierGroupInDocker(names: readonly CarrierName[]): Promise<CarrierDockerRun> {
  const sets = plantCarrierSets(names);
  const fixture = createCarrierPlan(names, CARRIERS_FILE_IN_CONTAINER);
  const keep = realpathSync(await mkdtemp(join(tmpdir(), "rovara-carriers-kept-")));
  dirs.push(keep);
  const candidate = join(keep, "candidate");
  for (const file of CARRIERS_APP_FILES) await cp(join(CARRIERS_ROOT, file), join(candidate, file), { recursive: true });
  // A short run root: the model socket path (<runRoot>/<runId>/model/model.sock) must fit a unix socket's 103 bytes, and a CI runner's tmpdir is far deeper than the worker's.
  const runRoot = realpathSync(await mkdtemp("/tmp/rvcr-"));
  dirs.push(runRoot);
  const evidence = createE2EModelEvidenceCollector();
  const { invoke, providerCalls } = createCarrierModel(names);
  const allowedSteps = e2eApplicationGroupAgentSteps(fixture.compiled);
  let outDir: string | null = null; let credentialsLeaked: boolean | null = null;
  const host = createDockerApplicationHost({ docker: createProcessDockerCli(), executorImage: EXECUTOR_IMAGE, buildImage: APP_NODE_IMAGE, runRoot, now: () => Date.now(),
    admission: fixture.plan.admission, groupId: fixture.plan.groupId, candidateSourceDir: candidate,
    ownedFiles: { "carriers.json": Buffer.from(JSON.stringify(sets), "utf8") },
    async onRunOutput(run) {
      await cp(run.outDir, join(keep, "out"), { recursive: true });
      outDir = join(keep, "out");
      const files = (await readdir(outDir, { withFileTypes: true, recursive: true })).filter((entry) => entry.isFile());
      credentialsLeaked = (await Promise.all(files.map(async (entry) => run.containsCredential(await readFile(join(entry.parentPath, entry.name)))))).some(Boolean);
    },
    modelChannel: { async open(input) {
      const session = await openE2EModelChannelSession({ runId: fixture.plan.runId, modelRoute: SCRIPTED_ROUTE, policyScope: "standard", socketPath: input.socketPath, allowedSteps,
        credentialSet: { ...input.credentialSet, cookieValues: [] }, deadlineAt: input.deadlineAt, dayBudget: createInMemoryE2EDayBudget(), evidence, signal: input.signal,
        environment: { ROVARA_E2E_SCRIPTED_MODEL: "1" }, invoke });
      // The proxy hands the socket to uid 1000 only when the worker is root (as the EC2 worker is). A CI runner's own user owns it, and the executor image runs as `node` (1000), so the
      // test opens the socket file to every local user for this run; the socket sits in a 0700 directory of the run that nothing else can enter.
      chmodSync(session.socketPath, 0o666);
      return { close: async () => { const summary = await session.close(); return { ...summary, transcripts: evidence.transcripts(), valueKey: input.valueKey, definition: session.definition }; } };
    } } });
  const run = await runIsolatedE2EApplication({ input: webApiProbeRunInput(fixture) as never, compiled: fixture.compiled, ports: host, signal: AbortSignal.timeout(280_000) });
  const why = () => {
    const logs = host.readDiagnostics(fixture.plan.runId);
    return `the run was ${run.unavailableReason === null ? "available" : `unavailable (${run.unavailableReason})`}; executor exit code ${String(run.lifecycle.process.exitCode)}\nbuild log: ${logs.buildLogTail || "(empty)"}\n`
      + `app log: ${logs.appLogTail || "(empty)"}\nexecutor log: ${logs.executorLogTail || "(empty)"}`;
  };
  if (outDir === null) throw new Error(`the run was unavailable: ${why()}`);
  const result = resultOf(outDir);
  return { names, sets, fixture, outDir, exitCode: result.exitCode, reason: result.reason, receipts: evidence.receipts(), transcripts: evidence.transcripts(), providerCalls, why, host, credentialsLeaked };
}
