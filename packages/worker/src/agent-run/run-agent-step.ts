// One step of a non-coding agent run (Plan 3, Task 23): the worker's session for it. The model gets the agent step preamble, the
// step's instruction block and its skills list as the system prompt, and the broker's rendering of the request (and earlier
// reports) as the one user turn. Its tools: the broker's connector tools through the bridge, read_skill, choose_branch when the
// run has a result contract, and with workspace "read" the read-only file tools through the task's container (R56). Never
// bash, edit or write, for either workspace setting: agent steps change nothing in the workspace, and what the model writes
// elsewhere goes through Rovara's broker, where it runs at once or waits for a person.
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  AGENT_STEP_PREAMBLE, READ_ONLY_TOOLS, SHORTENED_MARKER, agentXError, redactText, createTaskUsageTelemetry,
  type AgentStepGrounding, type AgentStepPayload, type ConnectorCatalog, type ResultContract,
} from "@agentx/contracts";
import type { ArtifactSink } from "../artifacts.js";
import { WorkerOperationCancelledError, type WorkerCancellationController } from "../cancel.js";
import { EventBatcher, redactCredentials, type EventBatchSink } from "../events.js";
import type { FileOpsTarget } from "../file-ops-exec.js";
import { createWorkspacePiSession, type PiSessionAdapter, type PiSessionHandle, type WorkspaceModelConfiguration } from "../pi-session.js";
import { assistantOutcome, eventType, failedTurn, type AssistantOutcome } from "../session-events.js";
import { ToolLoopGuard } from "../tool-loop-guard.js";
import { usageForControlPlane } from "../usage.js";
import { assistantText } from "../verification/extension.js";
import { withStepTimeout, type AgentSkillFile } from "../agent-step.js";
import { ToolCallRecorder, checkGrounding, cleanGrounding } from "./grounding.js";
import { agentToolCatalogsSource, brokerToolCall, createConnectorBridgeTools, type ConnectorBridgeCall } from "./connector-bridge.js";

export type AgentRunStepPayload = Extract<AgentStepPayload, { kind: "agent" }>;

/** A step's report is at most this many bytes; the broker keeps the same limit (Task 22). */
export const AGENT_STEP_REPORT_MAX_BYTES = 32_768;

export interface AgentStepResult {
  /** The model's final reply, with credentials redacted, cut to AGENT_STEP_REPORT_MAX_BYTES. */
  report: string;
  outcome: "SUCCEEDED";
  /** The last valid `choose_branch` call, when the step had a result contract and the model chose. */
  branch?: string;
  reason?: string;
  /**
   * The step's report compared with the tool calls it made (`checkGrounding`), always present from a worker that lists `task.agentGrounding.v1` (a worker without the check sends none, and the broker then has no signal and behaves as it did). The step still ends
   * SUCCEEDED here (it ran); the broker decides: an `unverified` report never counts as a success.
   */
  grounding?: AgentStepGrounding;
}

export interface RunAgentStepInput {
  payload: AgentRunStepPayload;
  /** The operation the step is, for the connector requests and the session's conversation. */
  operationId: string;
  workspaceId: string;
  conversationId: string;
  /** The step's callback capability: the only credential the worker uses toward the broker. */
  capability: string;
  brokerUrl: string;
  workspace: {
    rootPath: string;
    /** Where the read-only file tools run: the task sandbox or the devcontainer. */
    fileTools?: FileOpsTarget;
    /** The local file tools, for tests and a developer's machine only (an EC2 worker refuses them, R56). */
    localFileTools?: boolean;
  };
  /** The model and the adapter that calls it with the task's key from the broker's /v1/internal/model-access. */
  modelAccess: { model: WorkspaceModelConfiguration; piAdapter?: PiSessionAdapter };
  /** The step's pinned skills, from the broker's snapshot. */
  skills?: readonly AgentSkillFile[];
  eventSink: EventBatchSink;
  artifactSink: ArtifactSink;
  cancellationController?: WorkerCancellationController;
  /** Tests supply fakes; the defaults read the connector catalogs from the broker and post calls to it. */
  fetch?: typeof fetch;
  catalogs?: () => Promise<readonly ConnectorCatalog[]>;
  call?: ConnectorBridgeCall;
}

/** The system prompt: the preamble, then the step's instruction block when it has one (the skills list follows, from the session). */
export function agentStepSystemPrompt(instructions: string): string {
  return instructions.trim() === "" ? AGENT_STEP_PREAMBLE : `${AGENT_STEP_PREAMBLE}\n\n${instructions}`;
}

/**
 * `choose_branch`: in the worker's process, so the only thing it can do is note a choice. It accepts only the contract's ids; the
 * last valid call is the choice. Returns the tool and the way to read the choice back.
 */
export function chooseBranchTool(contract: ResultContract): { tool: ToolDefinition; chosen: () => { branch: string; reason: string } | undefined } {
  const ids = contract.branches.map(({ id }) => id);
  let chosen: { branch: string; reason: string } | undefined;
  const tool = defineTool({
    name: "choose_branch",
    label: "Choose branch",
    description: [
      "Say which way this run should go on, once you know. Call it with one of these branch ids and a short reason; the last call counts.",
      ...contract.branches.map((branch) => `- ${branch.id}: ${branch.description}`),
    ].join("\n"),
    parameters: Type.Object({
      branch: Type.String({ minLength: 1, maxLength: 256, description: "One of the branch ids listed." }),
      reason: Type.String({ maxLength: 2_000, description: "Why this branch." }),
    }),
    execute: async (_toolCallId, parameters) => {
      if (!ids.includes(parameters.branch)) {
        // A failure to the model, never a choice: Pi reports a thrown error as the tool's error result.
        throw new Error(`${parameters.branch.slice(0, 100)} is not one of this run's branches. Choose one of: ${ids.join(", ")}.`);
      }
      chosen = { branch: parameters.branch, reason: parameters.reason };
      return { content: [{ type: "text" as const, text: `Noted: ${parameters.branch}.` }], details: undefined };
    },
  });
  return { tool, chosen: () => chosen };
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8");
/** The text cut to `limit` UTF-8 bytes with the shortened marker, never inside a character. */
function shortened(text: string, limit: number): string {
  const encoded = utf8.encode(text);
  if (encoded.length <= limit) return text;
  let end = limit - utf8.encode(SHORTENED_MARKER).length;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return `${utf8Decoder.decode(encoded.subarray(0, end))}${SHORTENED_MARKER}`;
}

export async function runAgentStep(input: RunAgentStepInput): Promise<AgentStepResult> {
  const { payload } = input;
  const events = new EventBatcher(input.eventSink);
  let session: PiSessionHandle | undefined;
  let unregister: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let outcome: "SUCCEEDED" | "FAILED" | "CANCELLED";
  let failure: Error | undefined;
  let result: AgentStepResult | undefined;
  let reportingFailure: unknown;
  // Ends every broker request when the step does: its time limit, which covers the whole step, or a cancellation. Registered
  // before anything else, so a cancel that arrives while the tools are being read is honoured and no session starts.
  const stepEnds = new AbortController();
  let stepTimedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelled = (): boolean => input.cancellationController?.isCancelled(input.operationId) === true;
  try {
    unregister = input.cancellationController?.register(input.operationId, { abort: async () => { stepEnds.abort(); await session?.abort(); } });
    if (payload.timeoutMs !== undefined) {
      timer = setTimeout(() => { stepTimedOut = true; stepEnds.abort(); void Promise.resolve(session?.abort()).catch(() => undefined); }, payload.timeoutMs);
    }
    const broker = { brokerUrl: input.brokerUrl, capability: input.capability, signal: stepEnds.signal, ...(input.fetch === undefined ? {} : { fetch: input.fetch }) };
    // The connector tools the broker grants this step: none for a step with no grants, and a step whose tools cannot be read fails.
    const catalogs = await (input.catalogs ?? agentToolCatalogsSource(broker))();
    if (cancelled()) throw new WorkerOperationCancelledError(input.operationId);
    const call = input.call ?? brokerToolCall(broker);
    const tools: ToolDefinition[] = createConnectorBridgeTools(catalogs, call, { workspaceId: input.workspaceId, conversationId: input.conversationId, operationId: input.operationId });
    const branch = payload.resultContract === undefined ? undefined : chooseBranchTool(payload.resultContract);
    if (branch !== undefined) tools.push(branch.tool);
    // Every tool call of the step is recorded here, so the report can be compared with what happened when the step ends.
    const connectorTools = catalogs.flatMap((catalog) => catalog.tools.map((tool) => ({ name: tool.name, upstream: tool.upstreamName })));
    const recorder = new ToolCallRecorder(new Set(connectorTools.map(({ name }) => name)));

    const { workspace } = input;
    session = await createWorkspacePiSession({
      rootPath: workspace.rootPath,
      model: input.modelAccess.model,
      // An agent step is a planning session whatever else is said (pi-session.ts): at most the read-only file tools.
      workflowMode: "PLAN",
      conversationId: input.conversationId,
      onDiagnostic: (message) => { void events.append("progress", { message }).catch(() => undefined); },
      ...(workspace.fileTools === undefined ? {} : { fileTools: workspace.fileTools }),
      ...(workspace.localFileTools === undefined ? {} : { localFileTools: workspace.localFileTools }),
      agentTools: payload.workspace === "read" ? [...READ_ONLY_TOOLS] : [],
      ...(input.skills === undefined || input.skills.length === 0 ? {} : { skills: input.skills }),
      agentRun: { systemPrompt: agentStepSystemPrompt(payload.instructions), tools },
    }, input.modelAccess.piAdapter);

    const handle = session;
    const loopGuard = new ToolLoopGuard();
    let loopStop: Error | undefined;
    let lastAssistant: AssistantOutcome | undefined;
    let finalText: string | undefined;
    unsubscribe = handle.subscribe((event) => {
      // A streaming update repeats the whole message so far; the finished message and the finished call are what the log keeps.
      const streamed = (event as { type?: unknown } | undefined)?.type;
      if (streamed !== "message_update" && streamed !== "tool_execution_update") void events.append(eventType(event), event).catch(() => undefined);
      recorder.observe(event);
      const ended = assistantOutcome(event);
      if (ended !== undefined) {
        lastAssistant = ended;
        finalText = assistantText((event as { message?: unknown }).message);
      }
      if (loopStop !== undefined) return;
      const action = loopGuard.observe(event);
      if (action.kind === "warn") {
        void events.append("progress", { message: "The agent repeated a failing call; Rovara told it to change approach." }).catch(() => undefined);
        void handle.steer?.(action.message).catch(() => undefined);
      } else if (action.kind === "stop") {
        loopStop = action.error;
        void handle.abort().catch(() => undefined);
      }
    });

    if (cancelled()) throw new WorkerOperationCancelledError(input.operationId);
    await events.append("lifecycle", { status: "RUNNING", conversationId: input.conversationId, conversation: { started: true, reopened: false } });
    await events.flush();
    // withStepTimeout aborts the session when the time is up, and an abort can end the prompt before the timeout's own error
    // wins the race: the step still ends timed out.
    let timedOut = false;
    const limited = { abort: async () => { timedOut = true; await handle.abort(); } };
    try {
      await withStepTimeout(limited, payload.timeoutMs, () => handle.prompt(payload.inputs));
    } catch (error) {
      if (loopStop !== undefined) throw loopStop;
      throw error;
    }
    if (timedOut || stepTimedOut) throw new Error(`timeout:${payload.timeoutMs}`);
    if (loopStop !== undefined) throw loopStop;
    // An abort can end the prompt normally: a cancellation is the operation's outcome.
    if (cancelled()) throw new WorkerOperationCancelledError(input.operationId);
    const modelFailure = failedTurn(lastAssistant);
    if (modelFailure !== undefined) throw modelFailure;
    const report = typeof finalText === "string" ? finalText.trim() : "";
    if (report === "") throw agentXError("OPERATION_INTERRUPTED", "the agent ended without writing a report");
    const chosen = branch?.chosen();
    const kept = shortened(redactText(report), AGENT_STEP_REPORT_MAX_BYTES);
    // What the step was given is evidence: the request with its trigger event and earlier reports, the step's own instructions, and the skills it could read.
    const provided = [payload.inputs, payload.instructions, ...(input.skills ?? []).map((skill) => skill.content)].join("\n\n");
    const grounding = checkGrounding({ report: kept, provided, calls: recorder.calls(), connectorTools }) ?? cleanGrounding(recorder.calls());
    result = {
      report: kept,
      outcome: "SUCCEEDED",
      ...(chosen === undefined ? {} : { branch: chosen.branch, reason: redactText(chosen.reason) }),
      grounding,
    };
    outcome = "SUCCEEDED";
    await events.append("result", { status: "SUCCEEDED", conversationId: input.conversationId, agentStepResult: result });
  } catch (error) {
    if (cancelled()) {
      outcome = "CANCELLED";
      failure = new WorkerOperationCancelledError(input.operationId);
      try { await events.append("lifecycle", { status: "CANCELLED", conversationId: input.conversationId }); } catch (reporting) { reportingFailure = reporting; }
    } else {
      outcome = "FAILED";
      // A request the step's own time limit cut short is a timeout, whatever the transport called it.
      failure = stepTimedOut ? new Error(`timeout:${payload.timeoutMs}`) : error instanceof Error ? error : new Error(String(error));
      try { await events.append("error", { message: redactText(failure.message) }); } catch (reporting) { reportingFailure = reporting; }
    }
  }
  try {
    if (session !== undefined) {
      const usage = redactCredentials(createTaskUsageTelemetry(session.getSessionStats(), {
        ...session.getModel(),
        ...(input.modelAccess.model.cacheRetention === undefined ? {} : { cacheRetention: input.modelAccess.model.cacheRetention }),
      }, outcome));
      await events.append("usage", usageForControlPlane(usage, input.modelAccess.model));
      await input.artifactSink({ name: "usage.json", mediaType: "application/json", content: JSON.stringify(usage, null, 2) });
    }
  } catch (error) {
    reportingFailure ??= error;
  }
  try {
    await events.flush();
  } catch (error) {
    reportingFailure ??= error;
  }
  clearTimeout(timer);
  unsubscribe?.();
  unregister?.();
  session?.dispose();
  if (failure !== undefined) throw failure;
  if (reportingFailure !== undefined) throw reportingFailure instanceof Error ? reportingFailure : new Error("the step's events could not be reported");
  return result!;
}
