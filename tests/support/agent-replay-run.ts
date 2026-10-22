import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { E2EReplaySourceCase, E2EReplayTrace } from "@agentx/contracts";
import { runE2EExecutorSerially as runE2EExecutor } from "./executor-run-lock.js";
import { createOrdersM14AgentPlan, startOrdersM14App, type AgentPlanOptions, type OrdersM14AppProcess, type OrdersM14Variant } from "./orders-m14-agent.js";
import type { WebApiProbePlan } from "../../packages/verifier/src/host/web-api-probe-plan.js";
import { assembleAgentRun } from "./agent-collection.js";
import type { AgentRun } from "./agent-executor-run.js";
void mkdtempSync; void realpathSync;

/**
 * An audit replay on this machine (Task 4.6b): the real executor, the pinned CLI, a real Chromium and the m14 orders app, with the plan of a replay (the recordings of a verified round,
 * no model channel, no socket). The recordings come from a candidate run of the same case (`recordingsOf`), exactly as the Docker host uploads them.
 */
export type ReplayRun = {
  fixture: WebApiProbePlan; out: string; result: { exitCode: 0 | 1 | 2; reason: string | null }; caseId: string; app: OrdersM14AppProcess; cleanup(): Promise<void>;
};

/** The recordings a candidate run left, reviewed and bound the way the Docker host does it before it uploads them (`agentModel.traces`). */
export async function recordingsOf(run: AgentRun): Promise<E2EReplayTrace[]> {
  const assembled = await assembleAgentRun(run);
  return (assembled.agentModel.traces ?? []).map((trace) => ({ caseId: run.caseId, stepIndex: trace.stepIndex, keyHash: trace.keyHash, traceBase64: trace.traceBase64, binding: trace.binding }));
}

export async function runReplayCase(options: { traces: readonly E2EReplayTrace[]; plan?: AgentPlanOptions; timeoutMs?: number; /** The candidate renamed its download button, so the recording is stale. */ renamed?: boolean; variant?: OrdersM14Variant;
  /** What the verified round showed, signed into the replay admission (default: every assertion passed, no CSV). */ sourceCases?: readonly E2EReplaySourceCase[];
  /** Edits the executor plan after the admission was signed (the plan is not signed; the store is what holds a recording to its binding). */ editPlan?: (plan: WebApiProbePlan["plan"]) => unknown }): Promise<ReplayRun> {
  const fixture = createOrdersM14AgentPlan({ ...options.plan, replay: { traces: options.traces, ...(options.sourceCases === undefined ? {} : { sourceCases: options.sourceCases }) } });
  const app = await startOrdersM14App(fixture, { renamed: options.renamed === true, ...(options.variant === undefined ? {} : { variant: options.variant }) });
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "agent-replay-")));
  const out = join(dir, "out");
  await writeFile(join(dir, "plan.json"), JSON.stringify(options.editPlan === undefined ? fixture.plan : options.editPlan(fixture.plan)));
  const sandboxed = async (request: { runId: string; groupId: string }) => ({ schemaVersion: "e2e-executor-chromium-sandbox/v1" as const, runId: request.runId, groupId: request.groupId,
    browser: { pid: 40, nsPidDepth: 1, seccompFilters: 1, uidMap: "0 0 4294967295" }, renderers: [{ pid: 41, nsPidDepth: 2, seccompFilters: 2, uidMap: "0 1000 1" }] });
  const result = await runE2EExecutor({ planPath: join(dir, "plan.json"), outDir: out, signal: AbortSignal.timeout(options.timeoutMs ?? 240_000), localAppUpstream: app.upstream,
    inspectChromiumSandbox: sandboxed, chromiumSandboxSettleMs: 0 });
  const caseId = fixture.compiled.expectedCases[0]!.caseId;
  return { fixture, out, result, caseId, app, async cleanup() { await app.stop(); await rm(dir, { recursive: true, force: true }); } };
}
void existsSync; void readFileSync;
