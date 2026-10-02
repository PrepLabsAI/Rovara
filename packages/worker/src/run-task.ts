import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { WorkerInvocationSchema, agentXError, parseAgentClaim, redactText, type CheckReport, type WorkerInvocation } from "@agentx/contracts";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { publishWorkspaceDiff, recorderFingerprint, workspaceFingerprint, type ArtifactSink } from "./artifacts.js";
import { WorkspaceConversationStore, type ConversationRecord } from "./conversations.js";
import {
  createDevcontainerCli,
  devcontainerBashOperations,
  devcontainerPaths,
  ensureDevcontainer,
  preparedDevcontainerTarget,
  type DevcontainerCli,
  type DevcontainerPaths,
} from "./devcontainer.js";
import { EventBatcher, redactCredentials, type EventBatchSink } from "./events.js";
import { ToolLoopGuard } from "./tool-loop-guard.js";
import {
  createWorkspacePiSession,
  openRegisteredWorkspacePiSession,
  type PiSessionAdapter,
  type PiSessionHandle,
  type WorkspaceModelConfiguration,
} from "./pi-session.js";
import type { PreparationManifest } from "./prepare.js";
import { WorkerOperationCancelledError, type WorkerCancellationController } from "./cancel.js";
import { readCheckHistory, recordProjectOutcomes } from "./verification/check-history.js";
import { CHECK_ROUND_BUDGET_MS, createCheckRunners, planChecks, type CheckPlan, type CheckRunners } from "./verification/checks.js";
import { assistantText, compactCheckReport, notVerifiedReport, verificationExtension } from "./verification/extension.js";
import { CommandRecorder } from "./verification/recorder.js";
import {
  createTaskUsageTelemetry,
  usageForControlPlane,
  type TaskUsageOutcome,
} from "./usage.js";

export interface TaskInvocationResult {
  /** The broker-issued conversation ID, which stays the same for every turn of one conversation. */
  conversationId: string;
  /** False on the turn that created the saved session, true on every turn that reopened it. */
  reopened: boolean;
  /** Spec 051 FR-007: AgentX's check of the agent's work, with outputs cut to fit (compactCheckReport). */
  checks: CheckReport;
}

export async function runTaskInvocation(
  untrustedInvocation: WorkerInvocation,
  dependencies: {
    rootPath: string;
    model: WorkspaceModelConfiguration;
    eventSink: EventBatchSink;
    artifactSink: ArtifactSink;
    piAdapter?: PiSessionAdapter;
    cancellationController?: WorkerCancellationController;
    devcontainerCli?: DevcontainerCli;
    /** The runners AgentX's checks use; tests supply fakes. Default: as preparation and the agent's shell run. */
    checkRunners?: CheckRunners;
  },
): Promise<TaskInvocationResult> {
  const invocation = WorkerInvocationSchema.parse(untrustedInvocation);
  if (invocation.kind !== "task") throw agentXError("CONFIG_INVALID", "runTaskInvocation requires a task");
  const manifest = JSON.parse(
    await readFile(resolve(dependencies.rootPath, ".agentx/preparation-manifest.json"), "utf8"),
  ) as PreparationManifest;
  if (!manifest.complete || manifest.projectRevision !== invocation.projectRevision) {
    throw agentXError("WORKSPACE_NOT_READY", "workspace manifest is incomplete or revision-mismatched");
  }

  // The agent's shell runs in the project's devcontainer (#121), started first: on a resumed
  // instance its containers are stopped.
  const canonicalRoot = await realpath(resolve(dependencies.rootPath));
  const devcontainer = preparedDevcontainerTarget(canonicalRoot, manifest);
  let bashOperations: BashOperations | undefined;
  let containerPaths: DevcontainerPaths | undefined;
  let devcontainerCli: DevcontainerCli | undefined;
  if (devcontainer !== undefined) {
    devcontainerCli = dependencies.devcontainerCli ?? createDevcontainerCli();
    const started = await ensureDevcontainer(devcontainerCli, devcontainer);
    bashOperations = devcontainerBashOperations(devcontainerCli, devcontainer);
    containerPaths = devcontainerPaths(devcontainer, started);
  }
  // Spec 051 Ruling L: the check history as it was before the agent ran. The agent can write to .agentx, so every
  // round plans from this snapshot, and the final round's outcomes are merged over it.
  const checkHistory = await readCheckHistory(canonicalRoot, manifest);

  const conversationId = invocation.payload.conversationId;
  const conversations = new WorkspaceConversationStore(dependencies.rootPath);
  const registered = await conversations.tryResolve(conversationId);
  if (!registered && invocation.payload.conversationStarted === true) {
    throw agentXError(
      "CONVERSATION_STATE_LOST",
      "this conversation already started, but its saved session is not in this workspace",
    );
  }

  const events = new EventBatcher(dependencies.eventSink);
  const toolEvidence: unknown[] = [];
  const contextDiagnostics: string[] = [];
  const onDiagnostic = (message: string): void => {
    contextDiagnostics.push(redactText(message));
  };
  // Diagnostics arrive before the session runs and, from extensions, during the turn (Ruling F): each is reported once.
  let reportedDiagnostics = 0;
  const flushDiagnostics = async (): Promise<void> => {
    while (reportedDiagnostics < contextDiagnostics.length) {
      const message = contextDiagnostics[reportedDiagnostics]!;
      reportedDiagnostics += 1;
      await events.append("progress", { message });
    }
  };
  if (invocation.payload.modelSelectionDiagnostic !== undefined) {
    onDiagnostic(invocation.payload.modelSelectionDiagnostic);
  }
  for (const message of modelChangeDiagnostics(registered, dependencies.model)) onDiagnostic(message);

  // Spec 051: AgentX checks the agent's work when it finishes (FR-002 to FR-007). The stop fires on a cancel or the
  // loop guard's stop, so a running check ends with the task rather than at its own timeout (Review Focus 1).
  const verificationStop = new AbortController();
  const readiness = invocation.payload.readiness;
  const recorder = new CommandRecorder({
    fingerprint: (signal) => recorderFingerprint(
      manifest.repositories.map((repository) => ({ name: repository.name, directory: resolve(canonicalRoot, repository.path) })),
      signal,
    ),
    onDiagnostic,
  });
  let checkPlan: CheckPlan | undefined;
  let reportedChecks: CheckReport | undefined;
  // The first round's report when the extra try was given (Ruling N).
  let firstRoundChecks: CheckReport | undefined;
  const verification = verificationExtension({
    // Review Focus 5: a broker that sends no readiness leaves the agent's own commands.
    plan: () => (checkPlan = planChecks(readiness, recorder, checkHistory)),
    runners: dependencies.checkRunners ?? createCheckRunners({
      rootPath: canonicalRoot,
      ...(devcontainer === undefined || devcontainerCli === undefined ? {} : { devcontainer: { cli: devcontainerCli, target: devcontainer } }),
    }),
    budgetMs: () => CHECK_ROUND_BUDGET_MS,
    signal: verificationStop.signal,
    recorder,
    onReport: (report) => { reportedChecks = report; },
    onExtraTry: (firstRound) => { firstRoundChecks = firstRound; },
    onDiagnostic,
  });

  let session: PiSessionHandle;
  if (registered) {
    session = await openRegisteredWorkspacePiSession(
      {
        rootPath: dependencies.rootPath,
        model: dependencies.model,
        conversationId,
        sessionFile: registered.sessionFile,
        onDiagnostic,
        extensionFactories: [verification],
        ...(bashOperations === undefined ? {} : { bashOperations }),
        ...(containerPaths === undefined ? {} : { devcontainerPaths: containerPaths }),
      },
      dependencies.piAdapter,
    );
  } else {
    session = await createWorkspacePiSession(
      {
        rootPath: dependencies.rootPath, model: dependencies.model, conversationId, onDiagnostic,
        extensionFactories: [verification],
        ...(bashOperations === undefined ? {} : { bashOperations }),
        ...(containerPaths === undefined ? {} : { devcontainerPaths: containerPaths }),
      },
      dependencies.piAdapter,
    );
  }
  try {
    // Written before the prompt, so a crash mid-turn orphans an empty session rather than the transcript.
    if (registered) await conversations.recordTurn(conversationId, dependencies.model);
    else await conversations.register(session.sessionFile, conversationId, dependencies.model);
  } catch (error) {
    session.dispose();
    throw error;
  }

  const unregisterCancellation = dependencies.cancellationController?.register(invocation.operationId, {
    abort: async () => {
      verificationStop.abort();
      await session.abort();
    },
  });
  // A model repeating the same failing call is told once, then stopped (#127).
  const loopGuard = new ToolLoopGuard();
  // A task whose every edit or write failed, and that changed nothing, did not do its job (#158).
  const fileChanges = new FileChangeAttempts([canonicalRoot, resolve(dependencies.rootPath)]);
  let loopStop: Error | undefined;
  // pi ends a turn normally even when its model call failed or was aborted; only the last assistant
  // message says so (#136).
  let lastAssistant: AssistantOutcome | undefined;
  // The last assistant message's text, for the agent's claim when Pi never reached the check (P-4).
  let finalText: string | undefined;
  const unsubscribe = session.subscribe((event) => {
    if (eventType(event) === "tool_end") toolEvidence.push(redactCredentials(event));
    fileChanges.observe(event);
    void events.append(eventType(event), event).catch(() => undefined);
    const outcome = assistantOutcome(event);
    if (outcome !== undefined) {
      lastAssistant = outcome;
      finalText = assistantText((event as { message?: unknown }).message);
    }
    if (loopStop !== undefined) return;
    const action = loopGuard.observe(event);
    if (action.kind === "warn") {
      void events.append("progress", { message: "The agent repeated a failing call; AgentX told it to change approach." }).catch(() => undefined);
      void session.steer?.(action.message).catch(() => undefined);
    } else if (action.kind === "stop") {
      loopStop = action.error;
      verificationStop.abort();
      void session.abort().catch(() => undefined);
    }
  });
  try {
    let outcome: TaskUsageOutcome = "FAILED";
    let taskResult: TaskInvocationResult | undefined;
    let taskFailure: Error | undefined;
    let evidenceFailure: unknown;
    let evidenceAttempted = false;
    let diffAttempted = false;
    const reportUnsaved = async (name: string): Promise<void> => {
      await events.append("progress", { message: `AgentX could not save ${name} for this task.` }).catch(() => undefined);
    };
    // P-4: Pi skips agent_before_settle after an abort, so a stopped run has no report from the extension.
    // Ruling N: an extra try with no second settle and no stop keeps the first round's regression.
    // A cancelled model call also ends with stopReason "error", so the stop is read first.
    const finalChecks = (): CheckReport => reportedChecks
      ?? (firstRoundChecks !== undefined && !verificationStop.signal.aborted && lastAssistant?.stopReason !== "error" ? firstRoundChecks : undefined)
      ?? notVerifiedReport(
        !verificationStop.signal.aborted && lastAssistant?.stopReason === "error" ? "error" : "stopped",
        { extraTry: firstRoundChecks === undefined ? "not_needed" : "given", agentClaim: parseAgentClaim(finalText) },
      );
    let checksAttempted = false;
    const publishChecks = async (): Promise<void> => {
      checksAttempted = true;
      await dependencies.artifactSink({
        name: "checks.json",
        mediaType: "application/json",
        content: JSON.stringify(finalChecks(), null, 2),
      });
    };
    // Ruling M: the final round's project outcomes become the next task's before. A failed write never fails the task.
    const recordOutcomes = async (): Promise<void> => {
      const report = reportedChecks;
      if (report === undefined || report.source !== "project" || report.status === "not_verified" || checkPlan === undefined) return;
      try {
        await recordProjectOutcomes(canonicalRoot, checkPlan, report.checks, checkHistory);
      } catch (error) {
        onDiagnostic(`AgentX could not save this task's check results for the next task: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const publishEvidence = async (): Promise<void> => {
      evidenceAttempted = true;
      await dependencies.artifactSink({
        name: "test-and-tool-evidence.json",
        mediaType: "application/json",
        content: JSON.stringify(toolEvidence, null, 2),
      });
    };
    try {
      await events.append("lifecycle", {
        status: "RUNNING",
        conversationId,
        conversation: { started: true, reopened: registered !== undefined },
      });
      await flushDiagnostics();
      // The state before the prompt, so a turn is judged by what it changed, not by what earlier
      // turns left in the tree (#158).
      let before: string | undefined;
      try {
        before = await workspaceFingerprint(dependencies.rootPath);
      } catch {
        await events.append("progress", {
          message: "AgentX could not record the workspace state before this task; it will judge the task by the final diff only.",
        });
      }
      try {
        await session.prompt(invocation.payload.prompt);
        await recordOutcomes();
      } finally {
        await flushDiagnostics().catch(() => undefined);
      }
      // An abort can end the prompt without an error; the guard's reason is the task's outcome.
      if (loopStop !== undefined) throw loopStop;
      // A cancel during AgentX's checks ends the prompt normally, after the agent's last turn completed.
      if (reportedChecks?.notVerifiedReason === "stopped" && dependencies.cancellationController?.isCancelled(invocation.operationId)) {
        throw new WorkerOperationCancelledError(invocation.operationId);
      }
      const modelFailure = failedTurn(lastAssistant);
      if (modelFailure !== undefined) throw modelFailure;
      diffAttempted = true;
      const { changed: dirty } = await publishWorkspaceDiff(dependencies.rootPath, dependencies.artifactSink);
      await publishEvidence();
      await publishChecks();
      // With a before state, "changed" means this turn changed the tree (a revert counts); without
      // one, or when the after state cannot be read, a non-empty diff counts as a change.
      let changed = dirty;
      if (before !== undefined) {
        try {
          changed = await workspaceFingerprint(dependencies.rootPath) !== before;
        } catch {
          await events.append("progress", {
            message: "AgentX could not record the workspace state after this task; it judged the task by the final diff only.",
          });
        }
      }
      const noChange = fileChanges.noChangeFailure(changed);
      if (noChange !== undefined) throw noChange;
      const warning = fileChanges.emptyDiffWarning(changed);
      if (warning !== undefined) await events.append("progress", { message: warning });
      outcome = "SUCCEEDED";
      const checks = compactCheckReport(finalChecks());
      await events.append("result", {
        status: "SUCCEEDED",
        conversationId,
        sessionFile: "agent-sessions/[server-generated]",
        checks,
      });
      taskResult = { conversationId, reopened: registered !== undefined, checks };
    } catch (error) {
      if (loopStop === undefined && dependencies.cancellationController?.isCancelled(invocation.operationId)) {
        outcome = "CANCELLED";
        taskFailure = new WorkerOperationCancelledError(invocation.operationId);
        try {
          await events.append("lifecycle", { status: "CANCELLED", conversationId });
        } catch (reportingError) {
          evidenceFailure = reportingError;
        }
      } else {
        outcome = "FAILED";
        taskFailure = loopStop ?? asError(error);
        try {
          await events.append("error", { message: taskFailure.message });
        } catch (reportingError) {
          evidenceFailure = reportingError;
        }
      }
      // Best effort, like usage: a failed task keeps what it did, for the member and for debugging.
      // A cancelled task does not wait for git to diff the workspace; its evidence is cheap.
      if (!evidenceAttempted) {
        try {
          await publishEvidence();
        } catch (artifactError) {
          evidenceFailure ??= artifactError;
          await reportUnsaved("test-and-tool-evidence.json");
        }
      }
      if (!checksAttempted) {
        try {
          await publishChecks();
        } catch (artifactError) {
          evidenceFailure ??= artifactError;
          await reportUnsaved("checks.json");
        }
      }
      if (!diffAttempted && outcome !== "CANCELLED") {
        try {
          await publishWorkspaceDiff(dependencies.rootPath, dependencies.artifactSink);
        } catch (artifactError) {
          evidenceFailure ??= artifactError;
          await reportUnsaved("workspace.diff");
        }
      }
    }

    let telemetryFailure = evidenceFailure;
    try {
      const usage = createTaskUsageTelemetry(session.getSessionStats(), {
        ...session.getModel(),
        ...(dependencies.model.cacheRetention === undefined
          ? {}
          : { cacheRetention: dependencies.model.cacheRetention }),
      }, outcome);
      const redactedUsage = redactCredentials(usage);
      await events.append("usage", usageForControlPlane(redactedUsage, dependencies.model));
      await dependencies.artifactSink({
        name: "usage.json",
        mediaType: "application/json",
        content: JSON.stringify(redactedUsage, null, 2),
      });
    } catch (error) {
      telemetryFailure = error;
    }
    try {
      await events.flush();
    } catch (error) {
      telemetryFailure ??= error;
    }
    if (taskFailure !== undefined) throw taskFailure;
    if (telemetryFailure !== undefined) throw asError(telemetryFailure);
    if (!taskResult) throw new Error("task completed without a result");
    return taskResult;
  } finally {
    unsubscribe();
    unregisterCancellation?.();
    session.dispose();
  }
}

const FILE_CHANGE_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);
const MAX_REPORTED_PATH = 200;

/**
 * Counts the agent's edit and write calls, and keeps the file and a fixed-wording reason for the
 * last failure. The tool's own error text is never kept, so the task's error names files, never
 * file contents.
 */
class FileChangeAttempts {
  constructor(private readonly roots: readonly string[]) {}

  private readonly paths = new Map<string, string>();
  private readonly tools = new Set<string>();
  private tried = 0;
  private failed = 0;
  private last: { path: string; reason: string } | undefined;

  observe(event: unknown): void {
    if (!event || typeof event !== "object") return;
    const value = event as { type?: unknown; toolCallId?: unknown; toolName?: unknown; args?: unknown; isError?: unknown; result?: unknown };
    if (typeof value.toolName !== "string" || !FILE_CHANGE_TOOLS.has(value.toolName)) return;
    const callId = typeof value.toolCallId === "string" ? value.toolCallId : undefined;
    if (value.type === "tool_execution_start") {
      const path = value.args && typeof value.args === "object" ? (value.args as { path?: unknown }).path : undefined;
      if (callId !== undefined && typeof path === "string") this.paths.set(callId, path);
      return;
    }
    if (value.type !== "tool_execution_end") return;
    const path = callId === undefined ? undefined : this.paths.get(callId);
    if (callId !== undefined) this.paths.delete(callId);
    const text = toolResultText(value.result);
    // pi refuses an edit whose result equals the file: the change is already there. That is
    // neither a try nor a failure.
    if (value.isError === true && /No changes made to/.test(text)) return;
    this.tried += 1;
    this.tools.add(value.toolName);
    if (value.isError !== true) return;
    this.failed += 1;
    this.last = {
      path: path === undefined ? "unknown file" : this.reportedPath(path),
      reason: failureReason(value.toolName, text),
    };
  }

  /** The path relative to the workspace when it is inside it, without control characters, redacted and bounded. */
  private reportedPath(path: string): string {
    // Control and format characters (bidi overrides, line separators) would garble a message people read.
    const clean = path.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "");
    const root = isAbsolute(clean) ? this.roots.find((candidate) => isInside(candidate, clean)) : undefined;
    const shown = root === undefined ? clean : relative(root, clean) || ".";
    return String(redactCredentials(shown)).slice(0, MAX_REPORTED_PATH);
  }

  /** The task's error when the agent tried to change files, every try failed, and no repository changed. */
  noChangeFailure(changed: boolean): Error | undefined {
    if (changed || this.tried === 0 || this.failed !== this.tried || this.last === undefined) return undefined;
    const kinds = ["edit", "write"].filter((tool) => this.tools.has(tool)).join(" and ");
    const count = this.tried === 1 ? `the only ${kinds} call failed` : `all ${this.tried} ${kinds} calls failed`;
    return agentXError("OPERATION_INTERRUPTED", `no file changed: ${count} (last: ${this.last.path}, ${this.last.reason})`);
  }

  /** A warning when edits or writes succeeded but no repository changed; the task still succeeds. */
  emptyDiffWarning(changed: boolean): string | undefined {
    const succeeded = this.tried - this.failed;
    if (changed || succeeded === 0) return undefined;
    return `The agent reported ${succeeded} successful edit or write ${succeeded === 1 ? "call" : "calls"}, but no repository changed. ` +
      "The edits may have landed outside the project's repositories or in files git ignores.";
  }
}

function isInside(root: string, path: string): boolean {
  const inner = relative(root, path);
  return !(inner === ".." || inner.startsWith(`..${sep}`) || isAbsolute(inner));
}

function failureReason(toolName: string, text: string): string {
  if (/Could not find (the exact text|edits\[\d+\])/.test(text)) return "the text to replace was not found";
  if (/Found \d+ occurrences of/.test(text)) return "the text to replace matched more than once";
  return `the ${toolName} returned an error`;
}

function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  const content = result && typeof result === "object" ? (result as { content?: unknown }).content : undefined;
  if (!Array.isArray(content)) return "";
  return content.map((part: unknown) => {
    const text = part && typeof part === "object" ? (part as { text?: unknown }).text : undefined;
    return typeof text === "string" ? text : "";
  }).join("");
}

interface AssistantOutcome {
  stopReason: string;
  errorMessage?: string;
}

/** The outcome an assistant message_end event reports, or undefined for any other event. */
function assistantOutcome(event: unknown): AssistantOutcome | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = event as { type?: unknown; message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown } };
  if (value.type !== "message_end" || value.message?.role !== "assistant" || typeof value.message.stopReason !== "string") return undefined;
  return {
    stopReason: value.message.stopReason,
    ...(typeof value.message.errorMessage === "string" ? { errorMessage: value.message.errorMessage } : {}),
  };
}

/**
 * A turn whose last model call failed or was aborted is not a success. The error message comes
 * from pi or AgentX's OpenRouter transport, which already omit prompts and keys; it is still
 * redacted and bounded before it becomes the task's error.
 */
function failedTurn(outcome: AssistantOutcome | undefined): Error | undefined {
  if (outcome?.stopReason === "error") {
    const detail = String(redactCredentials(outcome.errorMessage ?? "no error message")).slice(0, 1_000);
    return agentXError("RUNTIME_UNAVAILABLE", `the model call failed: ${detail}`);
  }
  // The caller reports it as CANCELLED when a cancellation was requested, and as FAILED otherwise.
  if (outcome?.stopReason === "aborted") return agentXError("OPERATION_INTERRUPTED", "the model call was aborted");
  return undefined;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * The deployed model wins, because a stack update may move live conversations. The stored value
 * exists to report the change: a transcript continued on another model re-reads no prompt cache.
 */
function modelChangeDiagnostics(
  registered: ConversationRecord | undefined,
  model: WorkspaceModelConfiguration,
): string[] {
  const previous = registered?.model;
  if (!previous || (previous.provider === model.provider && previous.modelId === model.modelId)) return [];
  return [
    `this conversation was built on ${previous.provider}/${previous.modelId} and continues on ` +
      `${model.provider}/${model.modelId}`,
  ];
}

function eventType(event: unknown): "progress" | "tool_start" | "tool_end" {
  if (event && typeof event === "object" && "type" in event) {
    const type = event.type;
    if (type === "tool_execution_start") return "tool_start";
    if (type === "tool_execution_end" || type === "tool_result") return "tool_end";
  }
  return "progress";
}
