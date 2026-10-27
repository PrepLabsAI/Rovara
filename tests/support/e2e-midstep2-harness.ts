import { join } from "node:path";
import { createGovernedE2EModelRoute, createInMemoryE2EDayBudget, type E2EInvoke } from "../../packages/model-runtime/src/e2e-route.js";
import type { BrowserSecretState } from "../../packages/verifier/src/executor/browser-state-secrets.js";
import { createE2EModelChannelClient } from "../../packages/verifier/src/executor/model-channel.js";
import { createCredentialRedactor, type CredentialRedactor } from "../../packages/verifier/src/executor/redact.js";
import { createSessionSecretRegistry, type SessionSecretRegistry } from "../../packages/verifier/src/executor/session-secret-registry.js";
import { createE2ESessionSyncSource, type E2ESessionSyncSource } from "../../packages/verifier/src/executor/session-sync.js";
import { startE2EModelProxy, type E2EModelEvidenceSink, type E2EModelProxy } from "../../packages/worker/src/e2e-model-proxy.js";
import { CASE_ID, RUN_ID, bedrockRoute, call, tapAnswer } from "./e2e-model-fixtures.js";

/** The MIDSTEP-2 tests' shared stack: the real worker proxy, the real executor redactor, registry and session source, and two real channel clients (with the executor's scan and mask, and without either). */
export const MIDSTEP2_POSITION = { caseId: CASE_ID, stepIndex: 0 };

class Sink implements E2EModelEvidenceSink { writeReceipt() { /* not needed */ } writeTranscript() { /* not needed */ } }

type Client = ReturnType<typeof createE2EModelChannelClient>;
type CallResult = Awaited<ReturnType<Client["generate"]>>["result"];
export interface Midstep2Executor {
  run: { proxy: E2EModelProxy; seen: unknown[]; socketPath: string };
  redactor: CredentialRedactor;
  registry: SessionSecretRegistry;
  source: E2ESessionSyncSource;
  state: { current: BrowserSecretState };
  workerSays: (text: string) => Promise<CallResult>;
  executorSays: (text: string) => Promise<string | undefined>;
  workerOnly: Client;
  scanning: Client;
}

export function createMidstep2Harness(input: { dir: () => string; closers: Array<() => Promise<unknown>> }): { startRun: () => Promise<Midstep2Executor["run"]>; executor: () => Promise<Midstep2Executor> } {
  let socketCount = 0;
  async function startRun() {
    const seen: unknown[] = [];
    const invoke: E2EInvoke = async (request) => { seen.push(request.call); return tapAnswer(); };
    const route = createGovernedE2EModelRoute(bedrockRoute(), { invoke, now: Date.now, dayBudget: createInMemoryE2EDayBudget() });
    const socketPath = join(input.dir(), `m${++socketCount}.sock`);
    const proxy: E2EModelProxy = await startE2EModelProxy({ socketPath, runId: RUN_ID, route, credentialSet: { passwords: [], emails: [], cookieValues: [] }, evidence: new Sink(),
      deadlineAt: Date.now() + 60_000, environment: {}, allowedSteps: [MIDSTEP2_POSITION] });
    input.closers.push(() => proxy.close());
    return { proxy, seen, socketPath };
  }
  async function executor(): Promise<Midstep2Executor> {
    const run = await startRun();
    const redactor = createCredentialRedactor([]);
    const registry = createSessionSecretRegistry({ redactor });
    const source = createE2ESessionSyncSource({ register: registry.register, known: () => registry.sessionSecrets });
    const state: { current: BrowserSecretState } = { current: { cookies: [], origins: [] } };
    source.attach("s1", { storageState: async () => state.current }, { anonymous: false });
    const scanning = createE2EModelChannelClient({ socketPath: run.socketPath, runId: RUN_ID, sessionSync: source, scan: registry.modelScan, mask: registry.maskForModel });
    const workerOnly = createE2EModelChannelClient({ socketPath: run.socketPath, runId: RUN_ID, sessionSync: source });
    await workerOnly.beginStep(MIDSTEP2_POSITION);
    let index = 0;
    /** What the worker answers to a prompt that shows `text` (the executor's scan is not in this path). */
    const workerSays = async (text: string) => (await workerOnly.generate({ ...MIDSTEP2_POSITION, callIndex: index++, call: call(`#n1 text "${text}"`) })).result;
    /** What the executor's own scan says, before anything is posted. */
    const executorSays = async (text: string) => scanning.generate({ ...MIDSTEP2_POSITION, callIndex: index++, call: call(`#n1 text "${text}"`) }).then((answer) => answer.result.status, (error: { code?: string }) => error.code);
    return { run, redactor, registry, source, state, workerSays, executorSays, workerOnly, scanning };
  }
  return { startRun, executor };
}
