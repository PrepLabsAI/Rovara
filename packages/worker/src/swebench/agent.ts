import { basename } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { parseAgentClaim, redactText, type CheckReport, type SwebenchStopReason } from "@agentx/contracts";
import { recorderFingerprint } from "../artifacts.js";
import type { DevcontainerPaths } from "../devcontainer.js";
import { createWorkspacePiSession, type PiSessionAdapter, type PiSessionHandle, type WorkspaceModelConfiguration } from "../pi-session.js";
import { ToolLoopGuard } from "../tool-loop-guard.js";
import { createCheckRunners, planChecks, type CheckRunners } from "../verification/checks.js";
import { assistantText, finalCheckReport, verificationExtension } from "../verification/extension.js";
import { CommandRecorder } from "../verification/recorder.js";

export interface AgentRun {
  stopReason: SwebenchStopReason;
  /** Why the run stopped early, in words, for the thread; absent when the agent finished. */
  detail?: string;
  session: PiSessionHandle;
  agentSeconds: number;
  /** The tool calls the agent started (spec 052 Ruling 28). */
  toolCalls: number;
  /** What the session reported without failing, such as an extension's error (spec 051 Ruling F); redacted. */
  diagnostics: string[];
  /** AgentX's own result for the agent's work (spec 051 FR-010): rerun at the finish, else not_verified. */
  checks: CheckReport;
  /** What the agent's final message claimed (parseAgentClaim of the last assistant text). */
  agentClaim: "success" | "failure" | "none";
}

export interface AgentRunInput {
  rootPath: string;
  model: WorkspaceModelConfiguration;
  bashOperations: BashOperations;
  paths: DevcontainerPaths;
  problemStatement: string;
  /** The whole prompt, when the family builds its own (spec 045 FR-005); otherwise swebenchPrompt's. */
  prompt?: string;
  maxCostUsd: number;
  timeLimitMs: number;
  /** The tool-loop guard's call backstop; its default when absent. */
  toolCallLimit?: number;
  piAdapter?: PiSessionAdapter;
  /** The runners AgentX's checks use; tests supply fakes. Default: the container's own bash operations. */
  checkRunners?: CheckRunners;
  now?: () => number;
}

/** The fixed preamble before the issue text (FR-012); a Pro task's issue is its instruction.md (spec 044 FR-003). */
export function swebenchPrompt(problemStatement: string, repositoryFolder: string, containerFolder = "/testbed"): string {
  return [
    `You are working in the repository at ${repositoryFolder} (also ${containerFolder} in the shell).`,
    "Resolve the issue below by changing the repository's non-test source files.",
    "Do not modify, add or delete tests: hidden tests will check your change.",
    "Shell commands run in the repository's own Python environment, with no network access.",
    "When the issue is resolved, stop and summarize the change in one paragraph.",
    "",
    "<issue>",
    problemStatement.trim(),
    "</issue>",
  ].join("\n");
}

/**
 * Runs the coding agent on the issue until it finishes or a limit stops it (FR-013): the time limit,
 * the cost ceiling after a model turn, a model turn whose cost cannot be known, or the tool-loop
 * guard. The session is returned for its transcript and usage; the caller disposes it.
 */
export async function runSwebenchAgent(input: AgentRunInput): Promise<AgentRun> {
  const now = input.now ?? Date.now;
  const diagnostics: string[] = [];
  const onDiagnostic = (message: string): void => { diagnostics.push(redactText(message)); };
  // Spec 051 FR-010: the checks are the agent's own test commands, replayed through the shell it used, in the
  // testbed. Evals have no readiness, so there are no project checks. The limit's abort stops a running check (P-4).
  const limitStop = new AbortController();
  const recorder = new CommandRecorder({
    fingerprint: (signal) => recorderFingerprint([{ name: "testbed", directory: input.paths.hostFolder }], signal),
    onDiagnostic,
    canonicalCommand: (command) => testbedRelativeCommand(command, input.paths),
  });
  const runners = input.checkRunners ?? createCheckRunners({ rootPath: input.rootPath, bashOperations: input.bashOperations });
  let reportedChecks: CheckReport | undefined;
  let firstRoundChecks: CheckReport | undefined;
  let started = 0;
  const verification = verificationExtension({
    plan: () => planChecks(undefined, recorder),
    runners,
    // P-3: the agent's time remaining, so verification never outlives the run's own limit.
    budgetMs: () => Math.max(0, input.timeLimitMs - (now() - started)),
    signal: limitStop.signal,
    recorder,
    onReport: (report) => { reportedChecks = report; },
    onExtraTry: (firstRound) => { firstRoundChecks = firstRound; reportedChecks = undefined; },
    onDiagnostic,
  });
  const session = await createWorkspacePiSession({
    onDiagnostic,
    extensionFactories: [verification],
    rootPath: input.rootPath,
    model: input.model,
    bashOperations: input.bashOperations,
    devcontainerPaths: input.paths,
  }, input.piAdapter);
  started = now();
  let stop: { reason: SwebenchStopReason; detail: string } | undefined;
  // Only the last model response decides a model error: pi retries a failed call (a rate limit, say)
  // and the session goes on, so an earlier failed response does not mean the agent stopped there.
  let lastAssistant: { stopReason: string; errorMessage?: string } | undefined;
  let thrown: string | undefined;
  // The last assistant message's text: the agent's claim, when Pi never reached the check (P-4).
  let finalText: string | undefined;
  const halt = (reason: SwebenchStopReason, detail: string) => {
    if (stop !== undefined) return;
    stop = { reason, detail };
    limitStop.abort();
    void session.abort().catch(() => undefined);
  };
  const guard = new ToolLoopGuard(input.toolCallLimit);
  const unsubscribe = session.subscribe((event) => {
    const action = guard.observe(event);
    if (action.kind === "warn") void session.steer?.(action.message).catch(() => undefined);
    else if (action.kind === "stop") halt("loop_guard", action.error.message);
    const assistant = assistantEnd(event);
    if (assistant === undefined) return;
    lastAssistant = assistant;
    finalText = assistantText((event as { message?: unknown }).message);
    const stats = session.getSessionStats();
    if (stats.tokens.total > 0 && stats.cost === 0) {
      halt("cost_unknown", `the cost of ${session.getModel().provider}/${session.getModel().modelId} cannot be estimated, so the cost ceiling cannot be enforced`);
    } else if (stats.cost >= input.maxCostUsd) {
      halt("cost_ceiling", `the run reached its cost ceiling of ${input.maxCostUsd.toFixed(2)} USD`);
    }
  });
  const timer = setTimeout(() => halt("time_limit", `the agent reached its ${Math.round(input.timeLimitMs / 60_000)}-minute limit`), input.timeLimitMs);
  try {
    await session.prompt(input.prompt ?? swebenchPrompt(input.problemStatement, input.paths.hostFolder, input.paths.containerFolder));
  } catch (error) {
    // An abort for one of the limits may end the prompt with an error; the limit is the outcome.
    if (stop === undefined) thrown = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
  const agentSeconds = Math.round((now() - started) / 1_000);
  const toolCalls = guard.toolCalls;
  const finalStop = stop as { reason: SwebenchStopReason; detail: string } | undefined;
  const modelError = thrown ?? (lastAssistant?.stopReason === "error" ? lastAssistant.errorMessage ?? "the model call failed" : undefined);
  const agentClaim = parseAgentClaim(finalText);
  // P-4: Pi skips agent_before_settle after an abort, so a stopped run has no report from the extension; a model
  // error is no finish to check. Ruling N: an extra try with no second settle and no stop keeps the first round.
  const checks: CheckReport = finalCheckReport({
    reported: reportedChecks,
    firstRound: firstRoundChecks,
    stopped: finalStop !== undefined,
    errored: modelError !== undefined,
    agentClaim: finalStop === undefined ? agentClaim : "none",
  });
  // A claim made before a limit stopped the run says nothing about how it ended.
  const claim = finalStop === undefined ? agentClaim : "none";
  const common = { session, agentSeconds, toolCalls, diagnostics, checks, agentClaim: claim };
  if (finalStop !== undefined) return { stopReason: finalStop.reason, detail: finalStop.detail, ...common };
  if (modelError !== undefined) return { stopReason: "model_error", detail: modelError.slice(0, 500), ...common };
  return { stopReason: "finished", ...common };
}

/**
 * The agent writes `cd /testbed && pytest`, a path only the container has. The run's root, where the agent's shell
 * starts, holds the testbed as `testbed`, so a leading `cd <containerFolder>[/sub] &&` reads as `cd testbed[/sub] &&`
 * (Ruling X). Only that exact folder, then a `/`, a space or the end, so `/testbedX` stays out; the matcher then applies
 * its own safe-path rule to `sub`, and the replay's realpath containment refuses a link out of the testbed.
 */
export function testbedRelativeCommand(command: string, paths: Pick<DevcontainerPaths, "hostFolder" | "containerFolder">): string {
  const folder = basename(paths.hostFolder);
  const escaped = paths.containerFolder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return command.replace(new RegExp(`^( *cd +)${escaped}(?=/| )(/?\\S*)`, "s"), (_match, head: string, sub: string) => `${head}${folder}${sub}`);
}

function assistantEnd(event: unknown): { stopReason: string; errorMessage?: string } | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = event as { type?: unknown; message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown } };
  if (value.type !== "message_end" || value.message?.role !== "assistant" || typeof value.message.stopReason !== "string") return undefined;
  return { stopReason: value.message.stopReason, ...(typeof value.message.errorMessage === "string" ? { errorMessage: value.message.errorMessage } : {}) };
}
