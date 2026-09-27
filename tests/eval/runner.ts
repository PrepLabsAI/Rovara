import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { agentXError, type ConnectorCatalog } from "../../packages/contracts/src/index.js";
import type { OrchestrationApi } from "../../packages/orchestrator/src/orchestration-tools.js";
import { createOrchestratorRuntime, createPiSessionRuntime, runOrchestratorTurn } from "../../packages/orchestrator/src/orchestrator.js";
import { createGateSession, type ActionClassifier, type GateSession } from "../../packages/orchestrator/src/action-gate.js";
import { TurnRecorder } from "../../packages/orchestrator/src/turn-recorder.js";
import { slackReplyText } from "../../packages/slack-service/src/slack-format.js";
import { FAUX_MODEL } from "../support/faux-model.js";
import { EVAL_ROOT, jiraSiteHosts, loadCatalog, loadProject, type EvalCase, type UpstreamTool } from "./case.js";
import { legacyNotApplicable, legacyPresentation } from "./legacy-presentation.js";
import { expectedVerdict } from "./offline.js";
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
  /**
   * The action gate's classifier in a case with expect.gate. Without it, an offline run answers as
   * the case expects and a live run has none, so every change no rule settles asks.
   */
  gateClassifier?: ActionClassifier;
  /** How long a timed-out run may take to stop before the whole evaluation stops; default 10 s. */
  graceMs?: number;
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
  /** The run hit its timeout and then stopped: model behaviour, a failed run, not an error that blocks the baseline. */
  timedOut: z.literal(true).optional(),
  error: z.string().optional(),
  /** For a case with expect.maxLines: the reply's non-empty lines as Slack shows them, and whether they fit (spec 014 SC-006). */
  replyLines: z.number().int().nonnegative().optional(),
  linesOk: z.boolean().optional(),
  /** For a case with expect.gate: the gate's decision on the first call (null when no call reached it), and whether it matches. */
  gate: z.enum(["allow", "ask", "deny"]).nullable().optional(),
  gateOk: z.boolean().optional(),
  /**
   * False when the reply names an atlassian.net host the case's project did not configure, or any
   * such host at all when the project's Jira site is unknown; true otherwise, including a reply with
   * no such host (issue 061, so the model never invents a Jira link). Optional only so a report
   * recorded before this check keeps parsing.
   */
  siteOk: z.boolean().optional(),
}).strict();
/** `caseHash` identifies the case definition that was scored (see caseHash); SC-004 refuses baselines whose shared cases differ. */
export const CaseResultSchema = z.object({ id: z.string(), caseHash: z.string().optional(), passed: z.boolean(), runs: z.array(RunScoreSchema) }).strict();
/** A results or baseline file; a baseline that does not parse is an error, never an empty baseline. */
export const EvalReportSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  presentation: PresentationSchema,
  repeat: z.number().int().positive(),
  generatedAt: z.string(),
  /** A hash of the scored cases' definitions (for legacy, the cases it can express). */
  caseSetHash: z.string().optional(),
  cases: z.array(CaseResultSchema),
  /** Why the evaluation stopped early, and the cases it therefore never ran. */
  stopped: z.string().optional(),
  notRun: z.array(z.string()).optional(),
  /** Cases this presentation cannot express (legacy only); listed and counted, never scored. */
  notApplicable: z.array(z.object({ id: z.string(), reason: z.string() }).strict()).optional(),
  summary: z.object({
    cases: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    /** Cases with a run that errored for any reason other than a timeout; these block a baseline. */
    errors: z.number().int().nonnegative(),
    /** Cases with a timed-out run (present only when there are any); they fail but never block a baseline. */
    timeouts: z.number().int().nonnegative().optional(),
    notApplicable: z.number().int().nonnegative().optional(),
    toolAccuracy: z.number(),
    refusalCases: z.number().int().nonnegative(),
    refusalAccuracy: z.number(),
  }).strict(),
}).strict();
export type RunScore = z.infer<typeof RunScoreSchema>;
export type CaseResult = z.infer<typeof CaseResultSchema>;
export type EvalReport = z.infer<typeof EvalReportSchema>;

/** `stuck` marks a timed-out run whose work did not stop within the grace period. */
/** `gate` is the gate's decision on the first call; absent when the run had no gate (legacy, or no expect.gate). */
/** `jiraSites` is the case's project's configured Jira site(s) (see jiraSiteHosts), absent only when the project never loaded. */
interface RunOutcome {
  tool: string | null; offered?: false; args: Record<string, unknown>; response: string; error?: string; timedOut?: true; stuck?: true;
  gate?: "allow" | "ask" | "deny" | null; jiraSites?: "unknown" | string[];
}

/** The member a gate case runs for; a Slack member ID, never a real one. */
const EVAL_REQUESTER = "U0EVAL00001";

const DONE = "Done. (evaluation run: nothing was executed)";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_GRACE_MS = 10_000;

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
  let gate: GateSession | undefined;
  let timedOut = false;
  let cleanupError: string | undefined;
  let jiraSites: "unknown" | string[] | undefined;
  const work = (async (): Promise<string> => {
    let stateDirectory: string | undefined;
    try {
      const project = await loadProject(evalCase.project);
      jiraSites = jiraSiteHosts(project);
      for (const connector of project.connectors) {
        if (!catalogCache.has(connector.catalog)) catalogCache.set(connector.catalog, await loadCatalog(connector.catalog));
      }
      stateDirectory = await mkdtemp(join(tmpdir(), "agentx-eval-"));
      if (options.presentation === "new") {
        const presentation = newPresentation(project, catalogCache, { gateFields: evalCase.expect.gate !== undefined });
        if (evalCase.expect.gate !== undefined) gate = createGateSession(EVAL_REQUESTER);
        const classifier = options.gateClassifier ?? (options.live === true ? undefined : expectedVerdict(evalCase));
        await options.beforeRun?.(evalCase, run, same);
        if (timedOut) throw new Error("timed out");
        runtime = await createOrchestratorRuntime({
          stateDirectory, projectInstructions: project.instructions, api: cannedApi(presentation.catalogs),
          context: { workspaceId: randomUUID(), conversationId: randomUUID() },
          model: options.model, modelRuntime: options.modelRuntime, turnRecorder: recorder,
          // A reply-length case measures the reply style Slack threads get (spec 014 FR-023); no other case's prompt changes.
          ...(evalCase.expect.maxLines === undefined ? {} : { replySurface: "slack" as const }),
          repositories: presentation.repositories, connectors: presentation.connectors,
          ...(presentation.recoverableOperations.length > 0 ? { recoverableOperations: presentation.recoverableOperations } : {}),
          // Only a gate case runs the action gate (spec 014), so every other case runs as its baseline did.
          ...(gate === undefined ? {} : { actionGate: {
            session: gate,
            ...(classifier === undefined ? {} : { classifier }),
            ...(project.actionPolicy === undefined ? {} : { policy: project.actionPolicy }),
          } }),
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
  let stuck = false;
  if (timedOut) {
    // The next case shares the model runtime, so it waits until this run's work has stopped.
    let graceTimer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      work.then(() => true, () => true),
      new Promise<false>((resolve) => { graceTimer = setTimeout(() => resolve(false), options.graceMs ?? DEFAULT_GRACE_MS); }),
    ]);
    clearTimeout(graceTimer);
    // Its late failure is already reported as the timeout.
    if (!settled) {
      work.catch(() => undefined);
      stuck = true;
    }
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
  return {
    tool: call?.tool ?? null, ...(unoffered ? { offered: false as const } : {}), args: call?.args ?? {}, response,
    // The gate decides calls in order, so its first decision is the first call's.
    ...(gate === undefined ? {} : { gate: gate.decisions[0]?.outcome ?? null }),
    ...(jiraSites === undefined ? {} : { jiraSites }),
    ...(error === undefined ? {} : { error }), ...(stuck ? { stuck: true as const } : timedOut ? { timedOut: true as const } : {}),
  };
}

/** Curly apostrophes and quotes count as straight ones, and case is ignored, so "isn’t connected" with a curly apostrophe matches "n't connected". */
function normalisePhrase(text: string): string {
  return text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').toLowerCase();
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]));
  return value;
}

/** A stable hash of what a case asks and expects: id, project, prompt and expect. Its source and note do not affect scoring, so they are left out. */
export function caseHash(evalCase: EvalCase): string {
  const { id, project, prompt, expect } = evalCase;
  return createHash("sha256").update(JSON.stringify(stable({ id, project, prompt, expect }))).digest("hex");
}

// The same units `slackReplyText` leaves untouched (a fenced block, to its closing fence or to the
// end if never closed; an inline code span). Kept in step with slack-format.ts's own CODE pattern.
const CODE_SPAN_OR_BLOCK = /```[\s\S]*?(?:```|$)|`[^`\n]+`/gu;

/**
 * SC-006's "no literal \n" half: the formatter converts a literal "\n" to a real line break only
 * when the whole reply has no real newline (Task 1 ruling), so a reply mixing the two keeps a literal
 * "\n" outside code, which Slack shows verbatim rather than as a line break.
 */
function hasLiteralNewlineOutsideCode(formattedReply: string): boolean {
  return /\\n/u.test(formattedReply.replace(CODE_SPAN_OR_BLOCK, ""));
}

/**
 * Every *.atlassian.net host a reply names, lowercased (issue 061: the model must never invent
 * one). A host label may repeat with dots, so a subdomain such as a.b.atlassian.net is caught too.
 * The scheme is required in general, but optional right before "/browse/", since that is a link
 * either way; a bare host mention with neither a scheme nor "/browse/" after it is not a link and is
 * not flagged.
 */
const ATLASSIAN_HOST = "(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+atlassian\\.net";
const ATLASSIAN_LINK = new RegExp(`\\bhttps?:\\/\\/(${ATLASSIAN_HOST})\\b|\\b(${ATLASSIAN_HOST})(?=\\/browse\\/)`, "giu");

function atlassianHosts(text: string): string[] {
  return [...text.matchAll(ATLASSIAN_LINK)].map((match) => (match[1] ?? match[2])!.toLowerCase());
}

/**
 * False when the reply names an atlassian.net host outside the case's configured Jira site(s), or
 * any such host at all when that site is unknown; true when the reply names none (issue 061).
 */
function jiraLinkOk(hosts: readonly string[], sites: "unknown" | readonly string[] | undefined): boolean {
  if (hosts.length === 0) return true;
  if (sites === undefined || sites === "unknown") return false;
  return hosts.every((host) => sites.includes(host));
}

/** An errored run, or a call to a tool that was not offered, never counts as the correct tool. */
export function scoreRun(evalCase: EvalCase, run: RunOutcome): RunScore {
  const expected = evalCase.expect.tool;
  const matches = Array.isArray(expected) ? run.tool !== null && expected.includes(run.tool) : run.tool === expected;
  const toolOk = run.error === undefined && run.offered !== false && matches;
  const argsOk = evalCase.expect.argsSubset === undefined || isSubset(evalCase.expect.argsSubset, run.args);
  const text = normalisePhrase(run.response);
  const group = (phrase: string | string[] | undefined): boolean | null =>
    phrase === undefined ? null : [phrase].flat().some((entry) => text.includes(normalisePhrase(entry)));
  const refusalOk = group(evalCase.expect.refusal);
  const containsOk = group(evalCase.expect.contains);
  const phraseOk = refusalOk === null && containsOk === null ? null : refusalOk !== false && containsOk !== false;
  const formattedReply = evalCase.expect.maxLines === undefined ? undefined : slackReplyText(run.response);
  const replyLines = formattedReply === undefined ? undefined : formattedReply.split("\n").filter((line) => line.trim().length > 0).length;
  const siteOk = jiraLinkOk(atlassianHosts(run.response), run.jiraSites);
  return {
    tool: run.tool, ...(run.offered === false ? { offered: false as const } : {}), toolOk, argsOk, phraseOk, refusalOk, containsOk, siteOk,
    ...(replyLines === undefined || formattedReply === undefined ? {} : {
      replyLines, linesOk: replyLines <= evalCase.expect.maxLines! && !hasLiteralNewlineOutsideCode(formattedReply),
    }),
    ...(evalCase.expect.gate === undefined || run.gate === undefined ? {} : { gate: run.gate, gateOk: run.error === undefined && run.gate === evalCase.expect.gate }),
    ...(run.timedOut === true ? { timedOut: true as const } : {}), ...(run.error === undefined ? {} : { error: run.error }),
  };
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
  let stopped: string | undefined;
  let notRun: string[] = [];
  const notApplicable: Array<{ id: string; reason: string }> = [];
  for (const [index, evalCase] of cases.entries()) {
    if (options.presentation === "legacy") {
      const reason = await legacyReason(evalCase);
      if (reason !== undefined) {
        notApplicable.push({ id: evalCase.id, reason });
        continue;
      }
    }
    const runs: RunScore[] = [];
    for (let run = 0; run < options.repeat; run += 1) {
      let outcome: RunOutcome;
      try {
        outcome = await runOnce(evalCase, run, catalogCache, { ...options, modelRuntime });
      } catch (caught) {
        outcome = { tool: null, args: {}, response: "", error: message(caught) };
      }
      if (outcome.stuck === true) {
        stopped = `case ${evalCase.id} did not stop after its timeout; the evaluation was stopped so later cases do not share its state`;
        outcome = { ...outcome, error: `${outcome.error ?? "timed out"}; ${stopped}` };
      }
      runs.push(scoreRun(evalCase, outcome));
      if (stopped !== undefined) break;
    }
    results.push({ id: evalCase.id, caseHash: caseHash(evalCase), passed: runs.every((run) => run.toolOk && run.argsOk && run.phraseOk !== false && run.linesOk !== false && run.gateOk !== false && run.siteOk !== false && run.error === undefined), runs });
    if (stopped !== undefined) {
      notRun = cases.slice(index + 1).map((entry) => entry.id);
      break;
    }
  }
  const skipped = new Set(notApplicable.map((entry) => entry.id));
  const timeouts = results.filter((result) => result.runs.some((run) => run.timedOut === true)).length;
  const refusalCases = cases.filter((evalCase) => evalCase.expect.refusal !== undefined && !skipped.has(evalCase.id)).map((evalCase) => evalCase.id);
  const refusalPassed = results.filter((result) => refusalCases.includes(result.id) && result.runs.every((run) => run.toolOk && run.refusalOk === true)).length;
  return {
    provider: options.model.provider,
    model: options.model.modelId,
    presentation: options.presentation,
    repeat: options.repeat,
    generatedAt: new Date().toISOString(),
    caseSetHash: createHash("sha256").update(JSON.stringify(results.map((result) => [result.id, result.caseHash]).sort())).digest("hex"),
    cases: results,
    ...(stopped === undefined ? {} : { stopped, notRun }),
    ...(notApplicable.length === 0 ? {} : { notApplicable }),
    summary: {
      cases: results.length,
      passed: results.filter((result) => result.passed).length,
      errors: results.filter((result) => result.runs.some((run) => run.error !== undefined && run.timedOut !== true)).length,
      ...(timeouts === 0 ? {} : { timeouts }),
      ...(notApplicable.length === 0 ? {} : { notApplicable: notApplicable.length }),
      toolAccuracy: results.length === 0 ? 0 : results.filter((result) => result.runs.every((run) => run.toolOk)).length / results.length,
      refusalCases: refusalCases.length,
      refusalAccuracy: refusalCases.length === 0 ? 1 : refusalPassed / refusalCases.length,
    },
  };
}

/** Why the legacy presentation cannot express a case. A fixture that does not load is not a reason: runOnce reports it as the case's error. */
async function legacyReason(evalCase: EvalCase): Promise<string | undefined> {
  let project: Awaited<ReturnType<typeof loadProject>>;
  try {
    project = await loadProject(evalCase.project);
  } catch {
    return undefined;
  }
  return legacyNotApplicable(project, evalCase);
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
