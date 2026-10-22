import { chmodSync, realpathSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2EAgentActionLedgerSchema, type E2EModelReceipt } from "@agentx/contracts";
import { createInMemoryE2EDayBudget } from "../../packages/model-runtime/src/e2e-route.js";
import { runIsolatedE2EApplication, type E2EIsolatedApplicationRun } from "../../packages/verifier/src/application-runtime.js";
import { e2eApplicationGroupAgentSteps } from "../../packages/verifier/src/application-scenarios.js";
import { createDockerApplicationHost, createProcessDockerCli, type DockerApplicationHost } from "../../packages/verifier/src/host/docker-application-host.js";
import { webApiProbeRunInput, type WebApiProbePlan } from "../../packages/verifier/src/host/web-api-probe-plan.js";
import { E2E_AGENT_EVIDENCE_DIR, E2E_AGENT_LEDGER_FILE, agentCaseDirectoryName } from "../../packages/verifier/src/executor/evidence-paths.js";
import { createE2EModelEvidenceCollector, openE2EModelChannelSession } from "../../packages/worker/src/e2e-model-channel-session.js";
import { createScriptedE2EInvoke, type ScriptedTurn } from "../../packages/worker/src/e2e-model-scripted.js";
import { APP_NODE_IMAGE, EXECUTOR_IMAGE } from "./linux-runtime.js";
import { AGENT_GOAL, ORDERS_M14_APP_FILES, ORDERS_M14_ROOT, SCRIPTED_ROUTE, createOrdersM14AgentPlan, sha256Hex, type AgentPlanOptions } from "./orders-m14-agent.js";

/**
 * The agent step on a real Docker host (Task 4.3b): the production host runs the m14 orders app and the real executor image, with the worker's model session opened by the host just
 * before the executor starts and answering from the scripted double. The linux-runtime job of CI is the only place this runs.
 */
export type AgentProbeRun = Readonly<{
  fixture: WebApiProbePlan; run: E2EIsolatedApplicationRun; exitCode: number | null; outDir: string | null; host: DockerApplicationHost; caseId: string;
  receipts: E2EModelReceipt[]; valueKey: string | null; requestBytes: number[]; closes: number; credentialsLeaked: boolean | null;
  readLedger(): ReturnType<typeof E2EAgentActionLedgerSchema.parse> | null;
}>;

const dirs: string[] = [];
export async function removeAgentProbeDirs(): Promise<void> { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined); }

/** Everything a failing run left to explain it. */
export function whyAgent(r: AgentProbeRun): string {
  const logs = r.host.readDiagnostics(r.fixture.plan.runId);
  return `the run was ${r.run.unavailableReason === null ? "available" : `unavailable (${r.run.unavailableReason})`}; executor exit code ${String(r.exitCode)}\nbuild log: ${logs.buildLogTail || "(empty)"}\n`
    + `app log: ${logs.appLogTail || "(empty)"}\nexecutor log: ${logs.executorLogTail || "(empty)"}`;
}

export async function runAgentProbe(options: { script: readonly ScriptedTurn[]; plan?: AgentPlanOptions; goal?: string }): Promise<AgentProbeRun> {
  const goal = options.goal ?? options.plan?.goal ?? AGENT_GOAL;
  const fixture = createOrdersM14AgentPlan({ mock: true, ...options.plan, goal });
  const keep = realpathSync(await mkdtemp(join(tmpdir(), "rovara-agent-kept-")));
  dirs.push(keep);
  const candidate = join(keep, "candidate");
  for (const file of ORDERS_M14_APP_FILES) await cp(join(ORDERS_M14_ROOT, file), join(candidate, file), { recursive: true });
  // A short run root: the model socket path (<runRoot>/<runId>/model/model.sock) must fit a unix socket's 103 bytes, and a CI runner's tmpdir is far deeper than the worker's.
  const runRoot = realpathSync(await mkdtemp("/tmp/rvag-"));
  dirs.push(runRoot);
  const evidence = createE2EModelEvidenceCollector();
  const requestBytes: number[] = [];
  const scripted = createScriptedE2EInvoke({ scripts: { [sha256Hex(goal)]: options.script } });
  const allowedSteps = e2eApplicationGroupAgentSteps(fixture.compiled);
  let valueKey: string | null = null; let closes = 0; let credentialsLeaked: boolean | null = null; let outDir: string | null = null;
  const host = createDockerApplicationHost({ docker: createProcessDockerCli(), executorImage: EXECUTOR_IMAGE, buildImage: APP_NODE_IMAGE, runRoot, now: () => Date.now(),
    admission: fixture.plan.admission, groupId: fixture.plan.groupId, candidateSourceDir: candidate,
    async onRunOutput(run) {
      await cp(run.outDir, join(keep, "out"), { recursive: true });
      outDir = join(keep, "out");
      const files = (await readdir(outDir, { withFileTypes: true, recursive: true })).filter((entry) => entry.isFile());
      credentialsLeaked = (await Promise.all(files.map(async (entry) => run.containsCredential(await readFile(join(entry.parentPath, entry.name)))))).some(Boolean);
    },
    modelChannel: { async open(input) {
      valueKey = input.valueKey;
      const session = await openE2EModelChannelSession({ runId: fixture.plan.runId, modelRoute: SCRIPTED_ROUTE, policyScope: "standard", socketPath: input.socketPath, allowedSteps,
        credentialSet: { ...input.credentialSet, cookieValues: [] }, deadlineAt: input.deadlineAt, dayBudget: createInMemoryE2EDayBudget(), evidence, signal: input.signal,
        environment: { ROVARA_E2E_SCRIPTED_MODEL: "1" }, invoke: async (call) => { requestBytes.push(Buffer.byteLength(JSON.stringify(call.call), "utf8")); return scripted(call); } });
      // The proxy hands the socket to uid 1000 only when the worker is root (as the EC2 worker is). A CI runner's own user owns it, and the executor image runs as `node` (1000), so the
      // test opens the socket file to every local user for this run; the socket sits in a 0700 directory of the run that nothing else can enter.
      chmodSync(session.socketPath, 0o666);
      return { close: async () => { closes += 1; return session.close(); } };
    } } });
  const run = await runIsolatedE2EApplication({ input: webApiProbeRunInput(fixture) as never, compiled: fixture.compiled, ports: host, signal: AbortSignal.timeout(280_000) });
  const caseId = fixture.compiled.expectedCases[0]!.caseId;
  return { fixture, run, exitCode: run.lifecycle.process.exitCode, outDir, host, caseId, receipts: evidence.receipts(), valueKey, requestBytes, get closes() { return closes; }, credentialsLeaked,
    readLedger() {
      if (outDir === null) return null;
      return readLedgerFrom(outDir, caseId);
    } } as AgentProbeRun;
}

import { existsSync, readFileSync } from "node:fs";
function readLedgerFrom(outDir: string, caseId: string) {
  const path = join(outDir, E2E_AGENT_EVIDENCE_DIR, agentCaseDirectoryName(caseId), E2E_AGENT_LEDGER_FILE);
  return existsSync(path) ? E2EAgentActionLedgerSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : null;
}
