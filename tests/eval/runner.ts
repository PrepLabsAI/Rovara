import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { agentXError, type ConnectorCatalog } from "../../packages/contracts/src/index.js";
import type { OrchestrationApi } from "../../packages/orchestrator/src/orchestration-tools.js";
import { createOrchestratorRuntime, createPiSessionRuntime, runOrchestratorTurn } from "../../packages/orchestrator/src/orchestrator.js";
import { TurnRecorder } from "../../packages/orchestrator/src/turn-recorder.js";
import { FAUX_MODEL } from "../support/faux-model.js";
import { EVAL_ROOT, loadCatalog, loadProject, type EvalCase, type UpstreamTool } from "./case.js";
import { legacyPresentation } from "./legacy-presentation.js";
import { newPresentation } from "./presentation.js";

export const PresentationSchema = z.enum(["new", "legacy"]);
export type Presentation = z.infer<typeof PresentationSchema>;

export interface EvalOptions {
  model: { provider: string; modelId: string; thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" };
  presentation: Presentation;
  repeat: number;
  /** The offline run passes a faux provider here. Without it, `live` must be true. */
  modelRuntime?: ModelRuntime;
  /** Creates Pi's default model runtime, which calls a paid model with ambient credentials. Only `npm run eval -- --live` sets it. */
  live?: boolean;
  /**
   * Called before each run, once the presentation is built; the offline oracle scripts the faux
   * model's answer here. `present` turns a new-presentation call into the one this presentation offers.
   */
  beforeRun?: (evalCase: EvalCase, run: number, present: (tool: string, args: Record<string, unknown>) => { tool: string; args: Record<string, unknown> }) => void | Promise<void>;
  timeoutMs?: number;
}

/**
 * One scored run. `offered: false` marks a first call to a tool the presentation did not offer; it is
 * never the right tool. `refusalOk` and `containsOk` score each phrase group (null when the case has
 * none); `phraseOk` is false when either fails.
 */
export const RunScoreSchema = z.object({
  tool: z.string().nullable(),
  offered: z.literal(false).optional(),
  toolOk: z.boolean(),
  argsOk: z.boolean(),
  phraseOk: z.boolean().nullable(),
  refusalOk: z.boolean().nullable(),
  containsOk: z.boolean().nullable(),
  error: z.string().optional(),
}).strict();
export const CaseResultSchema = z.object({ id: z.string(), passed: z.boolean(), runs: z.array(RunScoreSchema) }).strict();
/** A results or baseline file; a baseline that does not parse is an error, never an empty baseline. */
export const EvalReportSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  presentation: PresentationSchema,
  repeat: z.number().int().positive(),
  generatedAt: z.string(),
  cases: z.array(CaseResultSchema),
  summary: z.object({
    cases: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    toolAccuracy: z.number(),
    refusalCases: z.number().int().nonnegative(),
    refusalAccuracy: z.number(),
  }).strict(),
}).strict();
export type RunScore = z.infer<typeof RunScoreSchema>;
export type CaseResult = z.infer<typeof CaseResultSchema>;
export type EvalReport = z.infer<typeof EvalReportSchema>;

interface RunOutcome { tool: string | null; offered?: false; args: Record<string, unknown>; response: string; error?: string }

const DONE = "Done. (evaluation run: nothing was executed)";
const DEFAULT_TIMEOUT_MS = 180_000;

/** Canned control-plane answers: every accepted operation succeeds at once and nothing executes. */
export function cannedApi(catalogs: readonly ConnectorCatalog[]): OrchestrationApi {
  const accepted = () => ({ operation: { id: randomUUID() } });
  return {
    discoverConnectorTools: async ({ connector }) => {
      const catalog = catalogs.find((entry) => entry.connector === connector);
      if (!catalog) throw agentXError("NOT_FOUND", "connector not found");
      return catalog;
    },
    callConnectorTool: async (input) => ({ requestId: input.requestId, status: "SUCCEEDED", text: "[]", truncated: false, replayed: false }),
    submitTask: async () => accepted(),
    followUp: async () => accepted(),
    createPullRequest: async () => accepted(),
    managePullRequest: async () => accepted(),
    taskResult: async ({ operationId }) => ({ operationId, status: "SUCCEEDED", response: DONE }),
    pullRequestResult: async ({ operationId }) => ({ operationId, status: "SUCCEEDED" }),
    taskStatus: async ({ operationId }) => ({ id: operationId, status: "SUCCEEDED" }),
  };
}

function message(caught: unknown): string {
  return (caught instanceof Error ? caught.message : String(caught)).slice(0, 300);
}

/**
 * One turn. Every failure, from loading the fixture to the turn itself, comes back as `error`; nothing
 * throws. The whole run, runtime creation and discovery included, races the timeout.
 */
async function runOnce(evalCase: EvalCase, run: number, catalogCache: Map<string, UpstreamTool[]>, options: EvalOptions & { modelRuntime: ModelRuntime }): Promise<RunOutcome> {
  const recorder = new TurnRecorder();
  const same = (tool: string, args: Record<string, unknown>): { tool: string; args: Record<string, unknown> } => ({ tool, args });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let canonical = same;
  let runtime: AgentSessionRuntime | undefined;
  let timedOut = false;
  let cleanupError: string | undefined;
  const work = (async (): Promise<string> => {
    let stateDirectory: string | undefined;
    try {
      const project = await loadProject(evalCase.project);
      for (const connector of project.connectors) {
        if (!catalogCache.has(connector.catalog)) catalogCache.set(connector.catalog, await loadCatalog(connector.catalog));
      }
      stateDirectory = await mkdtemp(join(tmpdir(), "agentx-eval-"));
      if (options.presentation === "new") {
        const presentation = newPresentation(project, catalogCache);
        await options.beforeRun?.(evalCase, run, same);
        if (timedOut) throw new Error("timed out");
        runtime = await createOrchestratorRuntime({
          stateDirectory, projectInstructions: project.instructions, api: cannedApi(presentation.catalogs),
          context: { workspaceId: randomUUID(), conversationId: randomUUID() },
          model: options.model, modelRuntime: options.modelRuntime, turnRecorder: recorder,
          repositories: presentation.repositories, connectors: presentation.connectors,
          ...(presentation.recoverableOperations.length > 0 ? { recoverableOperations: presentation.recoverableOperations } : {}),
        });
      } else {
        const legacy = legacyPresentation(project, catalogCache);
        canonical = legacy.canonical;
        await options.beforeRun?.(evalCase, run, legacy.legacyCall);
        if (timedOut) throw new Error("timed out");
        recorder.offer({ manifest: "", tools: legacy.tools.map(({ name, description }) => ({ name, description })), connectorOf: new Map(), model: options.model });
        runtime = await createPiSessionRuntime({
          stateDirectory, modelRuntime: options.modelRuntime, model: options.model,
          systemPrompt: legacy.systemPrompt, customTools: legacy.tools, extensions: [...legacy.extensions, recorder.extension()],
        });
      }
      // A runtime created after the deadline never starts a turn.
      if (timedOut) throw new Error("timed out");
      return await runOrchestratorTurn(runtime, evalCase.prompt, recorder);
    } finally {
      try {
        await runtime?.dispose();
      } catch (caught) {
        cleanupError = `dispose failed: ${message(caught)}`;
      }
      if (stateDirectory !== undefined) await rm(stateDirectory, { recursive: true, force: true });
    }
  })();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      void runtime?.session.abort();
      reject(new Error(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  let response = "";
  let error: string | undefined;
  try {
    response = await Promise.race([work, deadline]);
  } catch (caught) {
    error = timedOut ? `timed out after ${timeoutMs} ms` : message(caught);
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) {
    // The abandoned work still cleans up after itself; its late failure is already reported as the timeout.
    work.catch(() => undefined);
  } else {
    error ??= cleanupError;
  }
  const observation = recorder.observation();
  // A recorder failure could hide the first tool call, so the score would be a guess.
  const recordingErrors = observation.recordingErrors ?? [];
  if (error === undefined && recordingErrors.length > 0) error = `turn recording failed: ${recordingErrors.join(", ")}`;
  // The tools the runtime actually offered, as the recorder saw them.
  const offered = new Set(observation.offeredTools.map((tool) => tool.name));
  const first = recorder.firstToolCall();
  const call = first === undefined ? undefined : canonical(first.name, asRecord(first.arguments));
  const unoffered = first !== undefined && !offered.has(first.name);
  return { tool: call?.tool ?? null, ...(unoffered ? { offered: false as const } : {}), args: call?.args ?? {}, response, ...(error === undefined ? {} : { error }) };
}

/** An errored run, or a call to a tool that was not offered, never counts as the correct tool. */
export function scoreRun(evalCase: EvalCase, run: RunOutcome): RunScore {
  const expected = evalCase.expect.tool;
  const matches = Array.isArray(expected) ? run.tool !== null && expected.includes(run.tool) : run.tool === expected;
  const toolOk = run.error === undefined && run.offered !== false && matches;
  const argsOk = evalCase.expect.argsSubset === undefined || isSubset(evalCase.expect.argsSubset, run.args);
  const text = run.response.toLowerCase();
  const group = (phrase: string | string[] | undefined): boolean | null =>
    phrase === undefined ? null : [phrase].flat().some((entry) => text.includes(entry.toLowerCase()));
  const refusalOk = group(evalCase.expect.refusal);
  const containsOk = group(evalCase.expect.contains);
  const phraseOk = refusalOk === null && containsOk === null ? null : refusalOk !== false && containsOk !== false;
  return { tool: run.tool, ...(run.offered === false ? { offered: false as const } : {}), toolOk, argsOk, phraseOk, refusalOk, containsOk, ...(run.error === undefined ? {} : { error: run.error }) };
}

export async function runEvaluation(cases: readonly EvalCase[], options: EvalOptions): Promise<EvalReport> {
  if (!Number.isInteger(options.repeat) || options.repeat < 1) throw new Error("repeat must be a positive integer");
  // Any Pi runtime, the faux one included, has real providers built in and reaches them with whatever
  // credentials the environment holds. Without live, only the faux provider may be named, and this is
  // checked before any model is resolved.
  if (options.live !== true) {
    if (options.modelRuntime === undefined) throw new Error("runEvaluation needs a modelRuntime (offline) or live: true (calls a paid model)");
    if (options.model.provider !== FAUX_MODEL.provider) {
      throw new Error(`offline runs use the faux provider ${FAUX_MODEL.provider}; ${options.model.provider} needs live: true (calls a paid model)`);
    }
  }
  const modelRuntime = options.modelRuntime ?? await ModelRuntime.create({ refreshOnCreate: false });
  if (!modelRuntime.getModel(options.model.provider, options.model.modelId)) {
    throw new Error(`model ${options.model.provider}/${options.model.modelId} is not available in this model runtime`);
  }
  const catalogCache = new Map<string, UpstreamTool[]>();
  const results: CaseResult[] = [];
  for (const evalCase of cases) {
    const runs: RunScore[] = [];
    for (let run = 0; run < options.repeat; run += 1) {
      let outcome: RunOutcome;
      try {
        outcome = await runOnce(evalCase, run, catalogCache, { ...options, modelRuntime });
      } catch (caught) {
        outcome = { tool: null, args: {}, response: "", error: message(caught) };
      }
      runs.push(scoreRun(evalCase, outcome));
    }
    results.push({ id: evalCase.id, passed: runs.every((run) => run.toolOk && run.argsOk && run.phraseOk !== false && run.error === undefined), runs });
  }
  const refusalCases = cases.filter((evalCase) => evalCase.expect.refusal !== undefined).map((evalCase) => evalCase.id);
  const refusalPassed = results.filter((result) => refusalCases.includes(result.id) && result.runs.every((run) => run.toolOk && run.refusalOk === true)).length;
  return {
    provider: options.model.provider,
    model: options.model.modelId,
    presentation: options.presentation,
    repeat: options.repeat,
    generatedAt: new Date().toISOString(),
    cases: results,
    summary: {
      cases: results.length,
      passed: results.filter((result) => result.passed).length,
      errors: results.filter((result) => result.runs.some((run) => run.error !== undefined)).length,
      toolAccuracy: results.length === 0 ? 0 : results.filter((result) => result.runs.every((run) => run.toolOk)).length / results.length,
      refusalCases: refusalCases.length,
      refusalAccuracy: refusalCases.length === 0 ? 1 : refusalPassed / refusalCases.length,
    },
  };
}

/** Cases the baseline passed that now fail; more than one fails the command (evaluation.md). */
export function compareWithBaseline(report: EvalReport, baseline: EvalReport | undefined): { regressions: string[]; failed: boolean } {
  if (baseline === undefined) return { regressions: [], failed: false };
  const passedBefore = new Set(baseline.cases.filter((result) => result.passed).map((result) => result.id));
  const regressions = report.cases.filter((result) => !result.passed && passedBefore.has(result.id)).map((result) => result.id);
  return { regressions, failed: regressions.length > 1 };
}

export function reportPath(kind: "results" | "baseline", modelId: string, presentation: Presentation, root = EVAL_ROOT): string {
  return join(root, kind, `${modelId.replace(/[^A-Za-z0-9._-]/g, "_")}${presentation === "legacy" ? ".legacy" : ""}.json`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isSubset(expected: unknown, actual: unknown): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([key, value]) => isSubset(value, (actual as Record<string, unknown>)[key]));
  }
  return JSON.stringify(expected) === JSON.stringify(actual);
}
