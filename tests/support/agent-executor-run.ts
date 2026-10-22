import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { e2eApplicationGroupAgentSteps } from "../../packages/verifier/src/application-scenarios.js";
import { E2EAgentActionLedgerSchema, type E2EModelReceipt } from "@agentx/contracts";
import { createInMemoryE2EDayBudget } from "../../packages/model-runtime/src/e2e-route.js";
import { createE2EModelEvidenceCollector, openE2EModelChannelSession } from "../../packages/worker/src/e2e-model-channel-session.js";
import { createScriptedE2EInvoke, type ScriptedTurn } from "../../packages/worker/src/e2e-model-scripted.js";
import { E2E_EXECUTOR_HOST_MODULE_PATH } from "../../packages/verifier/src/executor/host-registry.js";
import { E2E_AGENT_EVIDENCE_DIR, E2E_AGENT_LEDGER_FILE, agentCaseDirectoryName } from "../../packages/verifier/src/executor/agent-ledger.js";
import { runE2EExecutorSerially as runE2EExecutor } from "./executor-run-lock.js";
import { AGENT_GOAL, SCRIPTED_ROUTE, createOrdersM14AgentPlan, sha256Hex, startOrdersM14App, withModelChannel, type AgentPlanOptions, type OrdersM14AppProcess } from "./orders-m14-agent.js";
import type { WebApiProbePlan } from "../../packages/verifier/src/host/web-api-probe-plan.js";

/**
 * The agent step end to end on this machine (Task 4.3b): the real executor, the pinned CLI, a real Chromium and the m14 orders app, with the worker's real model proxy on a unix socket
 * answering from the scripted double. What the containers add (the walls, the mounted socket path) is the Linux tests'.
 */
export const verifierRoot = join(import.meta.dirname, "../../packages/verifier");
export const agentRunnable = existsSync(join(verifierRoot, E2E_EXECUTOR_HOST_MODULE_PATH)) && existsSync(chromium.executablePath());
const sandboxed = async (request: { runId: string; groupId: string }) => ({ schemaVersion: "e2e-executor-chromium-sandbox/v1" as const, runId: request.runId, groupId: request.groupId,
  browser: { pid: 40, nsPidDepth: 1, seccompFilters: 1, uidMap: "0 0 4294967295" }, renderers: [{ pid: 41, nsPidDepth: 2, seccompFilters: 2, uidMap: "0 1000 1" }] });

export type AgentRun = {
  fixture: WebApiProbePlan; out: string; result: { exitCode: 0 | 1 | 2; reason: string | null }; receipts: E2EModelReceipt[]; valueKey: string; caseId: string;
  /** The size in bytes of each model request's call, as the worker saw it. */
  requestBytes: number[];
  /** The size in bytes of the newest screen text in each request: the observation the model acted on. */
  screenBytes: number[];
  app: OrdersM14AppProcess; cleanup(): Promise<void>;
  readLedger(): ReturnType<typeof E2EAgentActionLedgerSchema.parse> | null;
};

export async function runAgentCase(options: { script: readonly ScriptedTurn[]; plan?: AgentPlanOptions; goal?: string; timeoutMs?: number }): Promise<AgentRun> {
  const goal = options.goal ?? options.plan?.goal ?? AGENT_GOAL;
  const fixture = createOrdersM14AgentPlan({ ...options.plan, goal });
  const app = await startOrdersM14App(fixture);
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "agent-run-")));
  // A unix socket path must stay under about 100 bytes: a short directory.
  const socketDir = realpathSync(mkdtempSync("/tmp/rva-"));
  const evidence = createE2EModelEvidenceCollector();
  const requestBytes: number[] = [];
  const screenBytes: number[] = [];
  const scripted = createScriptedE2EInvoke({ scripts: { [sha256Hex(goal)]: options.script } });
  const allowedSteps = e2eApplicationGroupAgentSteps(fixture.compiled);
  const session = await openE2EModelChannelSession({ runId: fixture.plan.runId, modelRoute: SCRIPTED_ROUTE, policyScope: "standard", socketPath: join(socketDir, "m.sock"), allowedSteps,
    credentialSet: { passwords: fixture.plan.accounts.map((item) => item.password), emails: fixture.plan.accounts.map((item) => item.email), cookieValues: [] }, deadlineAt: fixture.plan.deadlineAt,
    dayBudget: createInMemoryE2EDayBudget(), evidence, signal: new AbortController().signal, environment: { ROVARA_E2E_SCRIPTED_MODEL: "1" },
    invoke: async (input) => { requestBytes.push(Buffer.byteLength(JSON.stringify(input.call), "utf8")); screenBytes.push(newestScreenBytes(input.call)); return scripted(input); } });
  const valueKey = "5a".repeat(32);
  const plan = withModelChannel(fixture.plan, valueKey);
  const out = join(dir, "out");
  await writeFile(join(dir, "plan.json"), JSON.stringify(plan));
  const result = await runE2EExecutor({ planPath: join(dir, "plan.json"), outDir: out, signal: AbortSignal.timeout(options.timeoutMs ?? 240_000), localAppUpstream: app.upstream,
    inspectChromiumSandbox: sandboxed, chromiumSandboxSettleMs: 0, modelSocketPath: session.socketPath });
  const summary = await session.close();
  const caseId = fixture.compiled.expectedCases[0]!.caseId;
  void evidence;
  return { fixture, out, result, receipts: summary.receipts, valueKey, caseId, requestBytes, screenBytes, app,
    readLedger() {
      const path = join(out, E2E_AGENT_EVIDENCE_DIR, agentCaseDirectoryName(caseId), E2E_AGENT_LEDGER_FILE);
      return existsSync(path) ? E2EAgentActionLedgerSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : null;
    },
    async cleanup() { await app.stop(); await rm(dir, { recursive: true, force: true }); await rm(socketDir, { recursive: true, force: true }); } };
}

/** The byte size of the newest text in a request that holds node lines (`#id role "name"`): a tool result of the latest action, else the first user message. */
export function newestScreenBytes(call: { prompt: ReadonlyArray<{ role: string; content: unknown }> }): number {
  const texts: string[] = [];
  for (const message of call.prompt) {
    if (message.role === "user") texts.push(...(message.content as Array<{ text: string }>).map((part) => part.text));
    if (message.role === "tool") texts.push(...(message.content as Array<{ output: { type: string; value: unknown } }>).map((part) => (typeof part.output.value === "string" ? part.output.value : JSON.stringify(part.output.value))));
  }
  const newest = [...texts].reverse().find((text) => /^\s*#\S+ /m.test(text));
  return newest === undefined ? 0 : Buffer.byteLength(newest, "utf8");
}

export const executorLog = (out: string) => (existsSync(join(out, "executor.log")) ? readFileSync(join(out, "executor.log"), "utf8") : "(no executor log)");
export const downloadsOf = (out: string): string[] => (existsSync(join(out, "downloads")) ? readdirSync(join(out, "downloads")).sort() : []);
