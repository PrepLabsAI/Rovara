import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { AGENTX_PREAMBLE_VERSION, WorkerInvocationSchema, WORKFLOW_PLAN_MAX_BYTES, agentXError, agentxPreambleSha256, createCandidateManifest, parseAgentClaim, redactText, reportStatus, type CheckReport, type CandidateRepository, type WorkflowFeedbackReviewReport, type WorkflowReviewReport, type WorkerInvocation } from "@agentx/contracts";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { publishWorkspaceDiff, recorderFingerprint, workspaceFingerprint, type ArtifactSink } from "./artifacts.js";
import { WorkspaceConversationStore, type ConversationRecord } from "./conversations.js";
import {
  createDevcontainerCli,
  devcontainerBashOperations,
  devcontainerPaths,
  ensureDevcontainer,
  preparedDevcontainerTarget,
  workspaceRelativeCdTarget,
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
import type { FeedbackApprovalAuthorizer, FeedbackBundleReader } from "./callback-client.js";
import { readCheckHistory, restoreCheckHistory } from "./verification/check-history.js";
import { readCandidateRepositories } from "./verification/candidate.js";
import { runWorkflowFeedbackReview, runWorkflowReviews } from "./verification/review.js";
import { CHECK_ROUND_BUDGET_MS, createCheckRunners, planChecks, runChecks, type CheckPlan, type CheckRunners } from "./verification/checks.js";
import { assistantText, checksArtifactContent, compactCheckReport, finalCheckReport, verificationExtension } from "./verification/extension.js";
import { gitOriginalCode, recoverAgentFiles, type OriginalCode } from "./verification/original-code.js";
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
  checks?: CheckReport;
  workflowMode?: "PLAN" | "IMPLEMENT" | "REVIEW" | "CHECKS" | "FEEDBACK_REVIEW";
  /** Worker-reported Git object identities; the broker recomputes and stores the canonical digest. */
  workflowCandidateRepositories?: Array<{ repositoryId: string; commitSha: string; treeSha: string }>;
  /** Repository identities captured when the final successful check round ended. */
  workflowCheckCandidateRepositories?: Array<{ repositoryId: string; commitSha: string; treeSha: string }>;
  workflowReviews?: WorkflowReviewReport[];
  workflowFeedbackReviewResult?: { taskId: string; workflowRevision: number; candidateDigest: string; outputDigest: string; artifactName: string; status: WorkflowFeedbackReviewReport["status"] };
}

export async function runTaskInvocation(
  untrustedInvocation: WorkerInvocation,
  dependencies: {
    rootPath: string;
    model: WorkspaceModelConfiguration;
    eventSink: EventBatchSink;
    artifactSink: ArtifactSink;
    feedbackBundleReader?: FeedbackBundleReader;
    authorizeFeedbackApproval?: FeedbackApprovalAuthorizer;
    piAdapter?: PiSessionAdapter;
    cancellationController?: WorkerCancellationController;
    devcontainerCli?: DevcontainerCli;
    /** The runners AgentX's checks use; tests supply fakes. Default: as preparation and the agent's shell run. */
    checkRunners?: CheckRunners;
    /** Each check round's budget; tests supply short ones. Default: CHECK_ROUND_BUDGET_MS (P-3). */
    checkBudgetMs?: () => number;
    /** D-16: the original code for before results; tests supply a fake. Default: each repository's preparation commit. */
    originalCode?: OriginalCode;
  },
): Promise<TaskInvocationResult> {
  const invocation = WorkerInvocationSchema.parse(untrustedInvocation);
  if (invocation.kind !== "task") throw agentXError("CONFIG_INVALID", "runTaskInvocation requires a task");
  const approval = invocation.payload.workflowFeedbackApproval;
  if (approval !== undefined) {
    if (dependencies.authorizeFeedbackApproval === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the worker cannot verify its PR feedback approval");
    await dependencies.authorizeFeedbackApproval(approval);
  }
  const manifest = JSON.parse(
    await readFile(resolve(dependencies.rootPath, ".agentx/preparation-manifest.json"), "utf8"),
  ) as PreparationManifest;
  if (!manifest.complete || manifest.projectRevision !== invocation.projectRevision) {
    throw agentXError("WORKSPACE_NOT_READY", "workspace manifest is incomplete or revision-mismatched");
  }
  if (invocation.payload.workflowMode === "FEEDBACK_REVIEW") {
    const binding = invocation.payload.workflowFeedbackReview!;
    if (dependencies.feedbackBundleReader === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the worker cannot read the task's approved feedback bundles");
    const root = await realpath(resolve(dependencies.rootPath));
    const repositoryInputs = manifest.repositories.map(repository => ({ repositoryId: repository.name, directory: resolve(root, repository.path) }));
    const candidateRepositories = await readCandidateRepositories(repositoryInputs);
    const candidate = createCandidateManifest(candidateRepositories);
    if (candidate.digest !== binding.candidateDigest) throw agentXError("OPERATION_INTERRUPTED", "the candidate changed before PR feedback review");
    const stop = new AbortController();
    const unregister = dependencies.cancellationController?.register(invocation.operationId, { abort: async () => stop.abort() });
    const events = new EventBatcher(dependencies.eventSink);
    try {
      await events.append("progress", { message: "AgentX is reviewing the latest feedback on the linked pull requests." });
      const collected = await dependencies.feedbackBundleReader(binding);
      const execution = await runWorkflowFeedbackReview({
        operationId: invocation.operationId, taskId: binding.taskId, workflowRevision: binding.workflowRevision,
        taskRequirements: collected.taskRequirements,
        rootPath: dependencies.rootPath, model: dependencies.model, candidate: candidateRepositories,
        repositories: repositoryInputs, bundles: collected.bundles, artifactSink: dependencies.artifactSink,
        ...(dependencies.piAdapter === undefined ? {} : { piAdapter: dependencies.piAdapter }), signal: stop.signal,
        onProgress: message => { void events.append("progress", { message }).catch(() => undefined); },
      });
      const workflowFeedbackReviewResult = {
        taskId: binding.taskId, workflowRevision: binding.workflowRevision, candidateDigest: binding.candidateDigest,
        outputDigest: execution.outputDigest, artifactName: execution.artifactName, status: execution.report.status,
      };
      await events.append("result", { status: "SUCCEEDED", workflowMode: "FEEDBACK_REVIEW", workflowFeedbackReviewResult });
      await events.flush();
      return { conversationId: invocation.payload.conversationId, reopened: false, workflowMode: "FEEDBACK_REVIEW", workflowFeedbackReviewResult };
    } catch (error) {
      await events.append("error", { message: redactText(error instanceof Error ? error.message : "feedback review failed") }).catch(() => undefined);
      await events.flush().catch(() => undefined);
      throw error;
    } finally {
      unregister?.();
    }
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

  // A verification retry has no model and no coding tools. It snapshots the candidate, runs only
  // the owner-selected project checks, then snapshots again so the broker can reject a changed tree.
  if (invocation.payload.workflowMode === "CHECKS") {
    const readiness = invocation.payload.readiness ?? [];
    if (readiness.length === 0) throw agentXError("CONFIG_INVALID", "verification retry requires at least one selected project check");
    const events = new EventBatcher(dependencies.eventSink);
    const repositories = manifest.repositories.map((repository) => ({ repositoryId: repository.name, directory: resolve(canonicalRoot, repository.path) }));
    const candidateBefore = await readCandidateRepositories(repositories);
    const recorder = new CommandRecorder({ fingerprint: (signal) => recorderFingerprint(repositories.map((repository) => ({ name: repository.repositoryId, directory: repository.directory })), signal) });
    const plan = planChecks(readiness, recorder, checkHistory);
    const stop = new AbortController();
    const unregister = dependencies.cancellationController?.register(invocation.operationId, { abort: async () => stop.abort() });
    try {
      await events.append("lifecycle", { status: "RUNNING", conversationId: invocation.payload.conversationId, conversation: { started: true, reopened: true } });
      await events.append("progress", { message: "AgentX is running the selected project checks against the current code. This retry has no code-editing tools." });
      const runners = dependencies.checkRunners ?? createCheckRunners({
        rootPath: canonicalRoot,
        ...(devcontainer === undefined || devcontainerCli === undefined ? {} : { devcontainer: { cli: devcontainerCli, target: devcontainer } }),
        ...(bashOperations === undefined ? {} : { bashOperations }),
      });
      const round = await runChecks(plan, runners, { budgetMs: dependencies.checkBudgetMs?.() ?? CHECK_ROUND_BUDGET_MS, signal: stop.signal });
      const status = round.stopped ? "not_verified" : reportStatus(round.entries);
      const checks: CheckReport = {
        status,
        ...(status === "not_verified" ? { notVerifiedReason: round.stopped || round.entries.length > 0 ? "stopped" : "no_checks" } : {}),
        source: plan.source,
        preambleVersion: AGENTX_PREAMBLE_VERSION,
        preambleSha256: agentxPreambleSha256(),
        checks: round.entries,
        extraTry: "not_needed",
        agentClaim: "none",
      };
      try {
        const restored = await restoreCheckHistory(canonicalRoot, checkHistory, plan.source === "project" && plan.readiness !== undefined
          ? { plan: { source: plan.source, readiness: plan.readiness }, entries: round.entries } : undefined);
        if (restored.outcome === "removed") await events.append("progress", { message: "AgentX could not save these check results for the next task and removed the untrusted check-history file." });
      } catch {
        await events.append("progress", { message: "AgentX could not safely update the workspace check history." });
      }
      const candidateAfter = await readCandidateRepositories(repositories);
      await dependencies.artifactSink({ name: "checks.json", mediaType: "application/json", content: checksArtifactContent(checks) });
      const compact = compactCheckReport(checks);
      await events.append("result", {
        status: "SUCCEEDED", conversationId: invocation.payload.conversationId, workflowMode: "CHECKS", checks: compact,
        workflowCandidateRepositories: candidateBefore,
        workflowCheckCandidateRepositories: candidateAfter,
      });
      await events.flush();
      return {
        conversationId: invocation.payload.conversationId, reopened: true, workflowMode: "CHECKS", checks: compact,
        workflowCandidateRepositories: candidateBefore,
        workflowCheckCandidateRepositories: candidateAfter,
      };
    } catch (error) {
      await events.append("error", { message: redactText(error instanceof Error ? error.message : "verification retry failed") }).catch(() => undefined);
      await events.flush().catch(() => undefined);
      throw error;
    } finally {
      unregister?.();
    }
  }

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

  // D-16 (#290): files an earlier task left while AgentX ran the original code (its worker stopped mid-check) go back
  // before this task starts. If they cannot, the task does not start on the wrong files.
  const repositoryDirectories = manifest.repositories.map((repository) => resolve(canonicalRoot, repository.path));
  try {
    for (const directory of await recoverAgentFiles(repositoryDirectories)) {
      onDiagnostic(`AgentX restored the files in ${relative(canonicalRoot, directory) || "."} that an earlier task left while AgentX was checking them against the original code.`);
    }
  } catch (error) {
    throw agentXError("RUNTIME_UNAVAILABLE", `AgentX could not restore the files an earlier task left while it was checking them against the original code: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Spec 051: AgentX checks the agent's work when it finishes (FR-002 to FR-007). The stop fires on a cancel or the
  // loop guard's stop, so a running check ends with the task rather than at its own timeout (Review Focus 1).
  const verificationStop = new AbortController();
  const readiness = invocation.payload.readiness;
  const planning = invocation.payload.workflowMode === "PLAN";
  const reviewing = invocation.payload.workflowMode === "REVIEW";
  const recorder = new CommandRecorder({
    fingerprint: (signal) => recorderFingerprint(
      manifest.repositories.map((repository) => ({ name: repository.name, directory: resolve(canonicalRoot, repository.path) })),
      signal,
    ),
    onDiagnostic,
    // The agent's shell is the devcontainer's, where the repository is at its container path (Minor 11).
    ...(containerPaths === undefined ? {} : { cdTarget: (target: string) => workspaceRelativeCdTarget(target, containerPaths, canonicalRoot) }),
  });
  let checkPlan: CheckPlan | undefined;
  let reportedChecks: CheckReport | undefined;
  let reportedChecksCandidate: CandidateRepository[] | undefined;
  // The first round's report when the extra try was given (Ruling N).
  let firstRoundChecks: CheckReport | undefined;
  const verification = verificationExtension({
    // Review Focus 5: a broker that sends no readiness leaves the agent's own commands.
    plan: () => (checkPlan = planChecks(readiness, recorder, checkHistory)),
    runners: dependencies.checkRunners ?? createCheckRunners({
      rootPath: canonicalRoot,
      ...(devcontainer === undefined || devcontainerCli === undefined ? {} : { devcontainer: { cli: devcontainerCli, target: devcontainer } }),
    }),
    budgetMs: dependencies.checkBudgetMs ?? (() => CHECK_ROUND_BUDGET_MS),
    signal: verificationStop.signal,
    recorder,
    onReport: async (report) => {
      reportedChecks = report;
      reportedChecksCandidate = undefined;
      if (invocation.payload.workflowMode === "IMPLEMENT" && report.status === "verified") {
        try {
          reportedChecksCandidate = await readCandidateRepositories(manifest.repositories.map((repository) => ({
            repositoryId: repository.name,
            directory: resolve(canonicalRoot, repository.path),
          })));
        } catch { /* missing identity leaves the check result unbound and the workflow blocked */ }
      }
    },
    // I-3: an earlier settle's report is stale once the agent has a regression to fix.
    onExtraTry: (firstRound) => { firstRoundChecks = firstRound; reportedChecks = undefined; },
    onDiagnostic,
    ...(dependencies.originalCode === undefined ? defaultOriginalCode(manifest, canonicalRoot) : { originalCode: dependencies.originalCode }),
  });

  let session: PiSessionHandle;
  if (registered) {
    session = await openRegisteredWorkspacePiSession(
      {
        rootPath: dependencies.rootPath,
        model: dependencies.model,
        workflowMode: invocation.payload.workflowMode ?? "IMPLEMENT",
        conversationId,
        sessionFile: registered.sessionFile,
        onDiagnostic,
        extensionFactories: planning || reviewing ? [] : [verification],
        ...(bashOperations === undefined ? {} : { bashOperations }),
        ...(containerPaths === undefined ? {} : { devcontainerPaths: containerPaths }),
      },
      dependencies.piAdapter,
    );
  } else {
    session = await createWorkspacePiSession(
      {
        rootPath: dependencies.rootPath, model: dependencies.model, workflowMode: invocation.payload.workflowMode ?? "IMPLEMENT", conversationId, onDiagnostic,
        extensionFactories: planning || reviewing ? [] : [verification],
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
    // Ruling Y: a regression AgentX found stands through a stop, a cancel or a model error on the extra turn.
    const finalChecks = (): CheckReport => finalCheckReport({
      reported: reportedChecks,
      firstRound: firstRoundChecks,
      stopped: verificationStop.signal.aborted,
      errored: lastAssistant?.stopReason === "error",
      agentClaim: parseAgentClaim(finalText),
    });
    let checksAttempted = false;
    const publishChecks = async (): Promise<void> => {
      checksAttempted = true;
      await dependencies.artifactSink({
        name: "checks.json",
        mediaType: "application/json",
        content: checksArtifactContent(finalChecks()),
      });
    };
    // Ruling O (I-1): on every ending, the history is the snapshot plus the final round's project outcomes (Ruling M),
    // whatever the agent left at the path. A failed write removes the path; neither ever fails the task.
    const restoreHistory = async (): Promise<void> => {
      const report = reportedChecks;
      const final = report !== undefined && report.source === "project" && report.status !== "not_verified" && checkPlan !== undefined
        ? { plan: checkPlan, entries: report.checks }
        : undefined;
      try {
        const restored = await restoreCheckHistory(canonicalRoot, checkHistory, final);
        if (restored.outcome === "removed") {
          onDiagnostic(`AgentX could not save this task's check results for the next task, so it removed them: ${errorText(restored.error)}`);
        }
      } catch (error) {
        onDiagnostic(errorText(error));
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
      } finally {
        await flushDiagnostics().catch(() => undefined);
      }
      // An abort can end the prompt without an error; the guard's reason is the task's outcome.
      if (loopStop !== undefined) throw loopStop;
      // A cancel during AgentX's checks ends the prompt normally, after the agent's last turn completed.
      if (verificationStop.signal.aborted && dependencies.cancellationController?.isCancelled(invocation.operationId)) {
        throw new WorkerOperationCancelledError(invocation.operationId);
      }
      const modelFailure = failedTurn(lastAssistant);
      if (modelFailure !== undefined) throw modelFailure;
      if (planning) {
        const plan = finalText?.trim();
        if (!plan) throw agentXError("OPERATION_INTERRUPTED", "the planning run produced no plan artifact");
        if (Buffer.byteLength(plan, "utf8") > WORKFLOW_PLAN_MAX_BYTES) throw agentXError("OPERATION_INTERRUPTED", "the planning run exceeded the maximum plan size");
        await dependencies.artifactSink({ name: "plan.md", mediaType: "text/markdown; charset=utf-8", content: plan });
        await publishEvidence();
        outcome = "SUCCEEDED";
        await events.append("result", { status: "SUCCEEDED", conversationId, workflowMode: "PLAN" });
        taskResult = { conversationId, reopened: registered !== undefined, workflowMode: "PLAN" };
      } else if (reviewing) {
        const repositories = manifest.repositories.map((repository) => ({
          repositoryId: repository.name,
          directory: resolve(canonicalRoot, repository.path),
        }));
        const beforeReview = createCandidateManifest(await readCandidateRepositories(repositories));
        let reports = await runWorkflowReviews({
          operationId: invocation.operationId,
          rootPath: canonicalRoot,
          model: session.getModel(),
          candidate: beforeReview.repositories,
          repositories,
          signal: verificationStop.signal,
          ...(dependencies.piAdapter === undefined ? {} : { piAdapter: dependencies.piAdapter }),
          onProgress: (message) => { void events.append("progress", { message }).catch(() => undefined); },
          onUsage: async ({ role, stats, model, outcome }) => {
            const usage = createTaskUsageTelemetry(stats, { ...model, ...(dependencies.model.cacheRetention === undefined ? {} : { cacheRetention: dependencies.model.cacheRetention }) }, outcome);
            const redactedUsage = redactCredentials(usage);
            await events.append("usage", usageForControlPlane(redactedUsage, dependencies.model));
            await dependencies.artifactSink({ name: `workflow-review-${role.toLowerCase()}-usage.json`, mediaType: "application/json", content: JSON.stringify(redactedUsage, null, 2) });
          },
        });
        try {
          const afterReview = createCandidateManifest(await readCandidateRepositories(repositories));
          if (afterReview.digest !== beforeReview.digest) reports = reports.map((report) => ({ ...report, status: "UNKNOWN", findings: [] }));
        } catch {
          reports = reports.map((report) => ({ ...report, status: "UNKNOWN", findings: [] }));
        }
        await publishEvidence();
        outcome = "SUCCEEDED";
        await events.append("result", {
          status: "SUCCEEDED", conversationId, workflowMode: "REVIEW",
          workflowCandidateRepositories: beforeReview.repositories,
          workflowReviews: reports,
        });
        taskResult = { conversationId, reopened: registered !== undefined, workflowMode: "REVIEW", workflowCandidateRepositories: beforeReview.repositories, workflowReviews: reports };
      } else {
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
      const workflowRepositories = manifest.repositories.map((repository) => ({ repositoryId: repository.name, directory: resolve(canonicalRoot, repository.path) }));
      const workflowCandidateRepositories = invocation.payload.workflowMode === "IMPLEMENT"
        ? await readCandidateRepositories(workflowRepositories)
        : undefined;
      await events.append("result", {
        status: "SUCCEEDED",
        conversationId,
        sessionFile: "agent-sessions/[server-generated]",
        checks,
        ...(workflowCandidateRepositories === undefined ? {} : { workflowCandidateRepositories }),
        ...(workflowCandidateRepositories === undefined || reportedChecksCandidate === undefined ? {} : { workflowCheckCandidateRepositories: reportedChecksCandidate }),
      });
      taskResult = {
        conversationId, reopened: registered !== undefined, checks,
        ...(workflowCandidateRepositories === undefined ? {} : { workflowCandidateRepositories }),
        ...(workflowCandidateRepositories === undefined || reportedChecksCandidate === undefined ? {} : { workflowCheckCandidateRepositories: reportedChecksCandidate }),
      };
      }
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
      if (!planning && !checksAttempted) {
        try {
          await publishChecks();
        } catch (artifactError) {
          evidenceFailure ??= artifactError;
          await reportUnsaved("checks.json");
        }
      }
      if (!planning && !diffAttempted && outcome !== "CANCELLED") {
        try {
          await publishWorkspaceDiff(dependencies.rootPath, dependencies.artifactSink);
        } catch (artifactError) {
          evidenceFailure ??= artifactError;
          await reportUnsaved("workspace.diff");
        }
      }
    }

    if (!planning) await restoreHistory();
    await flushDiagnostics().catch(() => undefined);

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
    // Ruling Y: a task that ends failed or cancelled still tells the broker about a regression, so it stays standing.
    const withChecks = (error: Error): Error => {
      const final = finalChecks();
      return final.status === "regression" ? Object.assign(error, { checks: compactCheckReport(final) }) : error;
    };
    if (taskFailure !== undefined) throw withChecks(taskFailure);
    if (telemetryFailure !== undefined) throw withChecks(asError(telemetryFailure));
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/**
 * D-16 (#290): every repository at the commit preparation recorded. When any repository has no usable commit (an old
 * manifest), there is no original code to show, so AgentX measures no before results rather than mixing states.
 */
function defaultOriginalCode(manifest: PreparationManifest, root: string): { originalCode?: OriginalCode } {
  const repositories = manifest.repositories.map((repository) => ({ directory: resolve(root, repository.path), commit: repository.resolvedCommit }));
  if (repositories.length === 0 || repositories.some(({ commit }) => !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit ?? ""))) return {};
  return { originalCode: gitOriginalCode(repositories) };
}
