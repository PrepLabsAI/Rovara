import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { SwebenchStopReason } from "@agentx/contracts";
import type { DevcontainerPaths } from "../devcontainer.js";
import { createWorkspacePiSession, type PiSessionAdapter, type PiSessionHandle, type WorkspaceModelConfiguration } from "../pi-session.js";
import { ToolLoopGuard } from "../tool-loop-guard.js";

export interface AgentRun {
  stopReason: SwebenchStopReason;
  /** Why the run stopped early, in words, for the thread; absent when the agent finished. */
  detail?: string;
  session: PiSessionHandle;
  agentSeconds: number;
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
  const session = await createWorkspacePiSession({
    rootPath: input.rootPath,
    model: input.model,
    bashOperations: input.bashOperations,
    devcontainerPaths: input.paths,
  }, input.piAdapter);
  const started = now();
  let stop: { reason: SwebenchStopReason; detail: string } | undefined;
  // Only the last model response decides a model error: pi retries a failed call (a rate limit, say)
  // and the session goes on, so an earlier failed response does not mean the agent stopped there.
  let lastAssistant: { stopReason: string; errorMessage?: string } | undefined;
  let thrown: string | undefined;
  const halt = (reason: SwebenchStopReason, detail: string) => {
    if (stop !== undefined) return;
    stop = { reason, detail };
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
  const finalStop = stop as { reason: SwebenchStopReason; detail: string } | undefined;
  if (finalStop !== undefined) return { stopReason: finalStop.reason, detail: finalStop.detail, session, agentSeconds };
  const modelError = thrown ?? (lastAssistant?.stopReason === "error" ? lastAssistant.errorMessage ?? "the model call failed" : undefined);
  if (modelError !== undefined) return { stopReason: "model_error", detail: modelError.slice(0, 500), session, agentSeconds };
  return { stopReason: "finished", session, agentSeconds };
}

function assistantEnd(event: unknown): { stopReason: string; errorMessage?: string } | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = event as { type?: unknown; message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown } };
  if (value.type !== "message_end" || value.message?.role !== "assistant" || typeof value.message.stopReason !== "string") return undefined;
  return { stopReason: value.message.stopReason, ...(typeof value.message.errorMessage === "string" ? { errorMessage: value.message.errorMessage } : {}) };
}
