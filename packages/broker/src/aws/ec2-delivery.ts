import {
  E2E_AGENT_MODEL_CHOICE_FEATURE,
  E2E_AGENT_STEPS_FEATURE,
  E2E_AGENT_UNAVAILABLE_REASONS,
  E2E_REPLAY_CHECKS_FEATURE,
  E2E_APPLICATION_ADMISSION_SCHEMA_V2,
  WORKER_INVOKE_AUTHORIZATION_SCHEME,
  WORKFLOW_PULL_REQUEST_UPDATE_WORKER_OUTDATED,
  agentXError,
  isE2EApplicationAdmissionSchemaVersion,
  modelSelectionFor,
  workerInvokeToken,
  workerInvokeTokenPayload,
  workflowPublicationContext,
  workflowPublicationContextDigest,
  type E2EWorkflowAdmissionRef,
  type Ec2RuntimeBinding,
  type WorkerInvocation,
} from "@agentx/contracts";
import { asksForApplicationPlan, asksForCodeAnchors, withoutApplicationPlanText, withoutCodeAnchorText } from "./broker-shared.js";
import type { Ec2OutboxRecord } from "./lambda.js";
import type { SessionManager } from "./sessions.js";

/** The worker's port; its /invocations accepts only KMS-signed tokens (#80). */
const WORKER_PORT = 8080;
/** A token outlives one delivery attempt and nothing more (design in #76). */
const TOKEN_LIFETIME_SECONDS = 60;
export const STARTING_COMPUTE_MESSAGE = "Starting workspace compute";

export type Ec2Delivery = "DELIVERED" | "WAITING_FOR_SESSION" | "WAITING_FOR_TASK_ACCESS" | { readinessGeneration: number };

export interface ProjectSetupSessionPort {
  ensureSession(input: { setupExecutionId: string; subjectId: string; approvalRevision: number; transportCorrelationId: string; binding: Ec2RuntimeBinding; waitingOutboxId: string }):
    Promise<{ ready: true; generation: number; privateIp: string } | { ready: false; generation: number; state: string }>;
}

export interface Ec2DeliveryDependencies {
  sessions: Pick<SessionManager, "ensureSession">;
  binding: (workspaceId: string) => Promise<Ec2RuntimeBinding | undefined>;
  /** Project setup has a separate lease namespace and never calls SessionManager.ensureSession. */
  projectSetupSessions?: ProjectSetupSessionPort;
  /** Reads the registered default binding only after stored setup authority is rechecked. */
  projectSetupBinding?: (input: { setupExecutionId: string; subjectId: string }) => Promise<Ec2RuntimeBinding | undefined>;
  /** KMS Sign, ECDSA_SHA_256 over the message bytes; returns the DER signature. */
  sign: (message: Uint8Array) => Promise<Uint8Array>;
  post: (url: string, init: { authorization: string; body: string }) => Promise<{ status: number; body: string }>;
  /** Records a progress event on the operation, once per outbox record. */
  progress: (record: Ec2OutboxRecord, message: string) => Promise<void>;
  /**
   * GET on the worker's /ping; resolves to the invocation features it reports (spec 053), none for a
   * worker built before them. Without it, no optional field is sent.
   */
  workerFeatures?: (url: string) => Promise<readonly string[]>;
  /**
   * Called, before the invocation is posted, when a planning run's schema-v2 application plan was dropped for a worker that does not list
   * "task.workflowE2EApplicationPlan": the operation record must stop saying the version was offered, so the broker refuses a v2 plan it uploads.
   * A failure fails the attempt (the run must not go out with the record still saying 2).
   */
  applicationPlanNotNegotiated: (record: Ec2OutboxRecord) => Promise<void>;
  /**
   * The schemaVersion of the admission a CHECKS invocation's reference names, read from the stored object and held to the reference's content address; undefined when it
   * cannot be read. With it, the dispatcher does not trust the reference's `kind` alone: a reference whose kind disagrees with its admission is refused before delivery.
   * Without it (a deployment that cannot read admissions) only the kind decides, and the worker still cross-checks.
   */
  workflowE2EAdmissionSchemaVersion?: (reference: E2EWorkflowAdmissionRef) => Promise<string | undefined>;
  /**
   * Whether an application admission has an `agent` step in its scenarios, read the same way. With it, the dispatcher also holds the reference's `agentSteps` flag to the admission: the
   * flag decides whether the worker must list the agent-steps feature, so a reference that understated it would skip that gate. Undefined when it cannot be read.
   */
  workflowE2EAdmissionUsesAgentSteps?: (reference: E2EWorkflowAdmissionRef) => Promise<boolean | undefined>;
  /**
   * Whether the route an application admission pins is one a worker built before the model choice (Task 4.10) cannot serve: a model other than the recommended one, or the minimal
   * request shape. Undefined when it cannot be read. With it, a round with AI navigation steps is never sent to a worker that does not list `task.workflowE2EAgentModelChoice.v1`
   * when the route needs it, and a route that cannot be read is refused rather than assumed to be the default.
   */
  workflowE2EAdmissionNeedsModelChoice?: (reference: E2EWorkflowAdmissionRef) => Promise<boolean | undefined>;
  /** Rechecks fresh PEOPLE authority after compute is ready, immediately before signing and POST. */
  guardTaskDispatch?: (record: Ec2OutboxRecord, context?: { remainingTimeMs: () => number }) => Promise<"ALLOWED" | "PARKED">;
  /** Loads and validates the durable internal readiness marker before any session provisioning. */
  validateWorkflowE2EReadiness?: (record: Ec2OutboxRecord, invocation: WorkerInvocation) => Promise<"ORDINARY" | "READINESS" | "PARKED">;
  /** Rechecks stored project setup authority independently from feature-task access. */
  guardProjectSetupDispatch?: (record: Ec2OutboxRecord, context?: { remainingTimeMs: () => number }) => Promise<"ALLOWED" | "PARKED">;
  remainingTimeMs?: () => number;
  now?: () => number;
}

/**
 * Delivers one ec2-ebs invocation (flows 1 to 3 in #76). When the workspace's session is not ready,
 * ensureSession starts it and parks the outbox record, and this returns WAITING_FOR_SESSION: the
 * caller acknowledges the message without using a retry attempt, and markReady re-queues it.
 */
export function createEc2Delivery(dependencies: Ec2DeliveryDependencies) {
  return async (record: Ec2OutboxRecord, invocation: WorkerInvocation, context?: { remainingTimeMs: () => number }): Promise<Ec2Delivery> => {
    const remainingTimeMs = context?.remainingTimeMs ?? dependencies.remainingTimeMs;
    const hasReadinessMarker = record.workflowE2EReadiness !== undefined;
    if (invocation.kind === "resume" && hasReadinessMarker && dependencies.validateWorkflowE2EReadiness === undefined) {
      throw agentXError("CALLBACK_FORBIDDEN", "the internal E2E readiness operation cannot be verified by this dispatcher");
    }
    const storedReadiness = invocation.kind === "resume"
      ? dependencies.validateWorkflowE2EReadiness === undefined
        ? "ORDINARY"
        : await dependencies.validateWorkflowE2EReadiness(record, invocation)
      : "ORDINARY";
    if (storedReadiness === "PARKED") return "WAITING_FOR_TASK_ACCESS";
    const guardCurrentAuthority = async () => {
      if (invocation.kind === "project-setup-smoke") {
        if (dependencies.guardProjectSetupDispatch === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "project setup smoke authority is not configured");
        return dependencies.guardProjectSetupDispatch(record, remainingTimeMs === undefined ? undefined : { remainingTimeMs });
      }
      return dependencies.guardTaskDispatch?.(record, remainingTimeMs === undefined ? undefined : { remainingTimeMs });
    };
    const workflowE2EReadiness = storedReadiness === "READINESS";
    if (workflowE2EReadiness && await guardCurrentAuthority() === "PARKED") return "WAITING_FOR_TASK_ACCESS";
    if (invocation.kind === "project-setup-smoke" && await guardCurrentAuthority() === "PARKED") return "WAITING_FOR_TASK_ACCESS";
    const admissionSchemaVersion = await checkAdmissionKind(invocation, dependencies.workflowE2EAdmissionSchemaVersion);
    await checkAdmissionAgentSteps(invocation, dependencies.workflowE2EAdmissionUsesAgentSteps);
    let binding: Ec2RuntimeBinding | undefined;
    let session: { ready: true; generation: number; privateIp: string } | { ready: false; generation: number; state: string };
    if (invocation.kind === "project-setup-smoke") {
      if (dependencies.projectSetupSessions === undefined || dependencies.projectSetupBinding === undefined) {
        throw agentXError("RUNTIME_UNAVAILABLE", "project setup session transport is not configured");
      }
      binding = await dependencies.projectSetupBinding({ setupExecutionId: invocation.payload.setupExecutionId, subjectId: invocation.payload.subjectId });
      if (binding === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "approved project setup default runtime binding is unavailable");
      session = await dependencies.projectSetupSessions.ensureSession({
        setupExecutionId: invocation.payload.setupExecutionId, subjectId: invocation.payload.subjectId,
        approvalRevision: invocation.payload.approvalRevision,
        transportCorrelationId: invocation.payload.transportCorrelationId, binding, waitingOutboxId: record.id,
      });
    } else {
      binding = await dependencies.binding(record.workspaceId);
      if (binding === undefined) throw agentXError("CONFIG_INVALID", `workspace ${record.workspaceId} has no ec2-ebs runtime binding`);
      session = await dependencies.sessions.ensureSession({ workspaceId: record.workspaceId, binding, waitingOutboxId: record.id });
    }
    if (!session.ready) {
      if (invocation.kind !== "project-setup-smoke") await dependencies.progress(record, STARTING_COMPUTE_MESSAGE);
      return "WAITING_FOR_SESSION";
    }
    // The broker uses this existing dispatcher/session path to warm compute before it admits an
    // immutable feature-E2E deadline. A resume invocation is an internal readiness signal only;
    // it must never reach the worker.
    if (workflowE2EReadiness) {
      if (await guardCurrentAuthority() === "PARKED") return "WAITING_FOR_TASK_ACCESS";
      if (await dependencies.validateWorkflowE2EReadiness?.(record, invocation) !== "READINESS") {
        throw agentXError("CALLBACK_FORBIDDEN", "the stored E2E readiness operation changed while compute was starting");
      }
      return { readinessGeneration: session.generation };
    }
    if (await guardCurrentAuthority() === "PARKED") return "WAITING_FOR_TASK_ACCESS";
    const applicationAdmission = invocation.kind === "task" && invocation.payload.workflowE2EAdmission?.kind === "application" ? invocation.payload.workflowE2EAdmission : undefined;
    const modelChoice = applicationAdmission === undefined || dependencies.workflowE2EAdmissionNeedsModelChoice === undefined ? undefined
      : () => dependencies.workflowE2EAdmissionNeedsModelChoice!(applicationAdmission);
    const sent = await forWorker(invocation, `http://${session.privateIp}:${WORKER_PORT}/ping`, dependencies.workerFeatures, admissionSchemaVersion, modelChoice);
    if (invocation.kind === "task" && invocation.payload.workflowE2EPlanVersion !== undefined
      && !(sent.kind === "task" && sent.payload.workflowE2EPlanVersion !== undefined)) {
      // Without the recorder the operation record would keep saying version 2 was offered while the worker was sent a portable-only run, so the broker would
      // accept a v2 plan it never asked for: a missing recorder is a wiring error, and the run does not go out.
      if (dependencies.applicationPlanNotNegotiated === undefined) {
        throw agentXError("CONFIG_INVALID", "the application plan version was dropped for this worker but no applicationPlanNotNegotiated recorder is configured");
      }
      await dependencies.applicationPlanNotNegotiated(record);
    }
    if (await guardCurrentAuthority() === "PARKED") return "WAITING_FOR_TASK_ACCESS";
    const payload = workerInvokeTokenPayload({
      workspaceId: record.workspaceId,
      generation: session.generation,
      operationId: invocation.operationId,
      fence: invocation.fence,
      expiresAt: Math.floor((dependencies.now?.() ?? Date.now()) / 1_000) + TOKEN_LIFETIME_SECONDS,
      ...(invocation.kind === "project-setup-smoke" ? { purpose: "PROJECT_SETUP" as const,
        setupExecutionId: invocation.payload.setupExecutionId, setupSubjectId: invocation.payload.subjectId,
        setupApprovalRevision: invocation.payload.approvalRevision } : { purpose: "WORKSPACE" as const,
        ...(invocation.kind === "publish" && invocation.payload.publicationMode !== undefined
          ? { publicationMode: invocation.payload.publicationMode,
            publicationContextDigest: invocation.payload.publicationContextDigest } : {}) }),
    });
    const signature = await dependencies.sign(Buffer.from(payload, "ascii"));
    // Signing may cross an authority revocation boundary. Recheck setup approval immediately before
    // the transport side effect; the opaque worker correlation is not durable setup authority.
    if (invocation.kind === "project-setup-smoke" && await guardCurrentAuthority() === "PARKED") return "WAITING_FOR_TASK_ACCESS";
    const response = await dependencies.post(`http://${session.privateIp}:${WORKER_PORT}/invocations`, {
      authorization: `${WORKER_INVOKE_AUTHORIZATION_SCHEME} ${workerInvokeToken(payload, signature)}`,
      body: JSON.stringify(sent),
    });
    if (response.status >= 300) {
      throw agentXError("RUNTIME_UNAVAILABLE", `EC2 worker returned HTTP ${response.status}: ${response.body.slice(0, 512)}`);
    }
    return "DELIVERED";
  };
}

/** What a worker that cannot run a version 2 application admission (web and API runtime bindings keyed by kind) is told; the feature it must list is `task.workflowE2EApplicationChecks.v2`. */
export const COMBINED_CHECKS_WORKER_REFUSAL = "This worker can't run combined browser and API checks yet; retry once it restarts.";
const PORTABLE_ADMISSION_SCHEMA = "workflow-e2e-admission/v1";

/**
 * The reference's `kind` decides which worker may receive an application round, so it is checked against the admission it names before any compute is started: a reference
 * without `kind` that names an application admission would bypass the gate, and one marked application that names a portable admission is a broker defect. Both are refused.
 */
async function checkAdmissionKind(invocation: WorkerInvocation, read: Ec2DeliveryDependencies["workflowE2EAdmissionSchemaVersion"]): Promise<string | undefined> {
  if (invocation.kind !== "task" || invocation.payload.workflowE2EAdmission === undefined) return undefined;
  const reference = invocation.payload.workflowE2EAdmission;
  // Fail closed: with no reader wired the version of an application admission is unknown, so it is treated as needing the newest worker feature.
  if (read === undefined) return reference.kind === "application" ? E2E_APPLICATION_ADMISSION_SCHEMA_V2 : undefined;
  let schemaVersion: string | undefined;
  try { schemaVersion = await read(reference); } catch { schemaVersion = undefined; }
  if (schemaVersion === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "could not read the E2E admission to check its kind against the reference; no round was sent");
  if (!isE2EApplicationAdmissionSchemaVersion(schemaVersion) && schemaVersion !== PORTABLE_ADMISSION_SCHEMA) {
    throw agentXError("CONFIG_INVALID", "the E2E admission is of a kind this dispatcher does not know; no round was sent");
  }
  if (isE2EApplicationAdmissionSchemaVersion(schemaVersion) !== (reference.kind === "application")) {
    throw agentXError("CONFIG_INVALID", "the E2E admission reference's kind does not match the admission it names; no round was sent");
  }
  return schemaVersion;
}

async function checkAdmissionAgentSteps(invocation: WorkerInvocation, read: Ec2DeliveryDependencies["workflowE2EAdmissionUsesAgentSteps"]): Promise<void> {
  if (read === undefined || invocation.kind !== "task" || invocation.payload.workflowE2EAdmission?.kind !== "application") return;
  const reference = invocation.payload.workflowE2EAdmission;
  let uses: boolean | undefined;
  try { uses = await read(reference); } catch { uses = undefined; }
  if (uses === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "could not read the E2E admission to check its agent steps against the reference; no round was sent");
  if (uses !== (reference.agentSteps === true)) {
    throw agentXError("CONFIG_INVALID", "the E2E admission reference's agentSteps flag does not match the admission it names; no round was sent");
  }
}

/**
 * Spec 053: the invocation as the worker can parse it. Worker payloads are strict and a running
 * worker keeps its image after a release (or after a worker-image rollback), so a thinking level goes
 * only to a worker whose /ping lists it. A task's level is dropped and the worker runs at its own
 * default level. Prepare, publish and maintain carry the whole stored project definition, whose
 * models carry levels the worker does not use there, so those are stripped. Spec 051: a task's
 * readiness goes only to a worker whose /ping lists "task.readiness"; one built before spec 051 has no
 * verification at all, so it neither checks nor reports (it is a new worker under an old broker, which sends no
 * readiness, that checks the agent's own test commands), and a publication's reportChecks goes only to one whose /ping lists
 * "publish.reportChecks". A review's workflowReviewChecks goes only to one whose /ping lists "task.workflowReviewChecks";
 * an older one reviews without being told which checks ran, and its workflowReviewPlan goes only to one whose /ping lists
 * "task.workflowReviewPlan"; an older one reviews without seeing the approved plan, and its workflowReviewFeedback goes only to one whose
 * /ping lists "task.workflowReviewFeedback"; an older one judges a feedback fix against the plan alone. The retry note goes only to one whose /ping lists "task.workflowReviewNote"; older workers review without it. A planning run's workflowPhase and planFormat go only to one whose /ping lists
 * "task.structuredPlans"; an older one plans without checking the answer's format. A planning run's workflowE2EPlanVersion (the schema-v2 application plan)
 * goes only to one whose /ping lists "task.workflowE2EApplicationPlan"; an older one is sent the portable-only prompt, and its review plan without a v2 intent. A planning prompt asks for anchor lines on
 * code citations only on one whose /ping lists "task.codeAnchors"; for an older one that text is left out of the prompt. The invoke token signs the operation, not the payload, so
 * dropping a field leaves it valid. A ping that fails fails the attempt: the worker journals a hash of
 * the whole invocation, so a retry must send what the first attempt would have, and a blip must not
 * run a capable worker at the default level.
 */
async function forWorker(
  invocation: WorkerInvocation,
  pingUrl: string,
  workerFeatures: Ec2DeliveryDependencies["workerFeatures"],
  admissionSchemaVersion?: string,
  modelChoice?: () => Promise<boolean | undefined>,
): Promise<WorkerInvocation> {
  const requestedThinkingLevel = carriedThinkingLevel(invocation);
  const carriesReadiness = invocation.kind === "task" && invocation.payload.readiness !== undefined;
  const carriesReviewChecks = invocation.kind === "task" && (invocation.payload.workflowReviewChecks !== undefined || invocation.payload.workflowReviewPlan !== undefined
    || invocation.payload.workflowReviewFeedback !== undefined || invocation.payload.workflowReviewNote !== undefined);
  const carriesWorkflowMode = invocation.kind === "task" && invocation.payload.workflowMode !== undefined;
  const carriesFeedbackReview = invocation.kind === "task" && invocation.payload.workflowMode === "FEEDBACK_REVIEW";
  const carriesFeedbackApproval = invocation.kind === "task" && invocation.payload.workflowFeedbackApproval !== undefined;
  const carriesWorkflowDependencies = invocation.kind === "task" && invocation.payload.workflowDependencies !== undefined;
  const carriesWorkflowBase = invocation.kind === "task" && invocation.payload.workflowBase !== undefined;
  const carriesStructuredPlans = invocation.kind === "task" && (invocation.payload.workflowPhase !== undefined || invocation.payload.planFormat !== undefined);
  const carriesCodeAnchors = invocation.kind === "task" && asksForCodeAnchors(invocation.payload.prompt);
  const carriesApplicationPlans = invocation.kind === "task" && (invocation.payload.workflowE2EPlanVersion !== undefined || asksForApplicationPlan(invocation.payload.prompt)
    || invocation.payload.workflowReviewPlan?.e2eIntent?.schemaVersion === 2);
  const carriesApplicationAdmission = invocation.kind === "task" && invocation.payload.workflowE2EAdmission?.kind === "application";
  const carriesAgentSteps = invocation.kind === "task" && invocation.payload.workflowE2EAdmission?.agentSteps === true;
  const carriesReportChecks = invocation.kind === "publish" && invocation.payload.reportChecks !== undefined;
  const carriesCandidateTree = invocation.kind === "publish" && invocation.payload.candidateTreeSha !== undefined;
  const carriesPublicationMode = invocation.kind === "publish" && invocation.payload.publicationMode !== undefined;
  const carriesPublicationContextDigest = invocation.kind === "publish" && invocation.payload.publicationContextDigest !== undefined;
  const carriesPublishBase = invocation.kind === "publish" && invocation.payload.workflowBaseCommit !== undefined;
  const carriesPullRequestUpdate = invocation.kind === "maintain" && invocation.payload.workflowCandidateTreeSha !== undefined;
  const carriesChatGpt = invocation.kind === "task" && invocation.payload.chatgpt !== undefined;
  const carriesProjectSetupSmoke = invocation.kind === "project-setup-smoke";
  if (requestedThinkingLevel === undefined && !carriesChatGpt && !carriesReadiness && !carriesReviewChecks && !carriesWorkflowMode && !carriesWorkflowBase && !carriesStructuredPlans && !carriesCodeAnchors && !carriesApplicationPlans && !carriesApplicationAdmission && !carriesAgentSteps && !carriesReportChecks && !carriesCandidateTree && !carriesPublicationMode && !carriesPublishBase && !carriesPullRequestUpdate && !carriesWorkflowDependencies && !carriesProjectSetupSmoke) return invocation;
  let features: readonly string[] = [];
  if (workerFeatures !== undefined) {
    try {
      features = await workerFeatures(pingUrl);
    } catch (error) {
      throw agentXError("RUNTIME_UNAVAILABLE", `could not ask the EC2 worker which invocation fields it parses: ${error instanceof Error ? error.message : String(error)}`.slice(0, 512));
    }
  }
  if (carriesWorkflowMode && !features.includes("task.workflowMode")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "AgentX workflow mode requires a compatible worker that advertises the read-only tool boundary");
  }
  if (invocation.kind === "task" && invocation.payload.workflowMode === "REVIEW" && !features.includes("task.workflowReview")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "independent workflow review requires a compatible worker");
  }
  if (invocation.kind === "task" && invocation.payload.workflowMode === "CHECKS" && !features.includes("task.workflowChecks")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "verification retry requires a compatible worker that runs checks without code-editing tools");
  }
  if (carriesFeedbackReview && !features.includes("task.workflowFeedbackReview")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "PR feedback critic requires a compatible worker");
  }
  if (carriesFeedbackApproval && !features.includes("task.workflowFeedbackApproval")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "feedback approval requires a compatible worker");
  }
  if (carriesWorkflowDependencies && !features.includes("task.workflowDependencies")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "ordered work requires a compatible worker that advertises task.workflowDependencies");
  }
  // A worker built before application CHECKS, or one without the executor image on its host (it then does not list the feature), cannot run an application admission, and the admission's content decides what the round proves, so it is never
  // sent one (and never a trimmed one): the attempt fails with this reason instead (Ruling BQ, mixed fleet).
  if (carriesApplicationAdmission && !features.includes("task.workflowE2EApplicationChecks")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "browser and API verification needs a worker that runs application admissions (it must list task.workflowE2EApplicationChecks); this worker predates it or has no executor image on its host, so no application round was sent to it");
  }
  // A round with AI navigation steps needs the model channel only a worker that lists the feature has, and the steps are never trimmed away: the attempt fails with this reason instead.
  if (carriesAgentSteps && !features.includes(E2E_AGENT_STEPS_FEATURE)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "This worker can't run AI navigation steps yet; retry once it restarts");
  }
  // Task 4.10: a route whose model the installation chose, or whose request shape is minimal, is derived only by a worker that lists the model-choice feature. An older worker would refuse it
  // after compute was spent, so it is refused here, with a fixed sentence. A route that cannot be read is refused too: it is never assumed to be the default.
  if (carriesAgentSteps && modelChoice !== undefined && !features.includes(E2E_AGENT_MODEL_CHOICE_FEATURE)) {
    let needs: boolean | undefined;
    try { needs = await modelChoice(); } catch { needs = undefined; }
    if (needs !== false) throw agentXError("RUNTIME_UNAVAILABLE", `${E2E_AGENT_UNAVAILABLE_REASONS.routeNotApproved}: this worker is too old for the chosen AI navigation model`);
  }
  // M1.3 Task 3.4: a version 2 admission keys its runtime rows by profile and kind, which a worker built before it cannot read. It is refused here, before compute is spent, with a sentence the
  // owner can act on (the worker lists the feature again once it restarts on the new image).
  if (carriesApplicationAdmission && admissionSchemaVersion === E2E_APPLICATION_ADMISSION_SCHEMA_V2 && !features.includes("task.workflowE2EApplicationChecks.v2")) {
    throw agentXError("RUNTIME_UNAVAILABLE", COMBINED_CHECKS_WORKER_REFUSAL);
  }
  // M1.3 Task 3.7b: a baseline round is an application round of a kind of its own. A worker that runs application admissions but predates baseline rounds would run it as a
  // candidate's, and its refusal of the signed purpose would come only after compute was spent, so it is refused here with the reason.
  if (carriesApplicationAdmission && invocation.kind === "task" && invocation.payload.workflowE2EAdmission?.purpose === "baseline" && !features.includes("task.workflowE2EBaselineChecks")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "the baseline round on the unchanged code needs a worker that runs baseline rounds (it must list task.workflowE2EBaselineChecks); this worker predates it or has no executor image on its host, so no baseline round was sent to it");
  }
  // M1.4 Task 4.6b: an audit replay is an application round of a kind of its own, run with no model by a worker that lists its feature. An older worker could not parse the purpose, and one
  // that runs application rounds only would run it as a candidate's; it is never handed one, and nothing is spent on a worker that cannot run it.
  if (carriesApplicationAdmission && invocation.kind === "task" && invocation.payload.workflowE2EAdmission?.purpose === "replay" && !features.includes(E2E_REPLAY_CHECKS_FEATURE)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "the audit replay needs a worker that runs replay rounds (it must list task.workflowE2EReplayChecks.v1); this worker predates it or has no executor image on its host, so no replay was sent to it");
  }
  if (carriesProjectSetupSmoke && !features.includes("project.setupSmoke")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "project setup smoke requires a worker that implements project.setupSmoke");
  }
  // The pinned base decides what reviewers judge and whether a finding blocks, so it is never dropped.
  if (carriesWorkflowBase && !features.includes("task.workflowBase")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "workflow reviews need a worker that receives the task's pinned base commit");
  }
  // The checked tree binds the publication to what passed checks and reviews, so it is never dropped either.
  if (carriesCandidateTree && !features.includes("publish.candidateTree")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "publishing the checked code needs a worker that publishes exactly the checked tree");
  }
  if (carriesPublicationMode && !features.includes("publish.mode")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "publishing a workflow candidate needs a worker that authenticates the broker-selected publication mode");
  }
  if (carriesPublicationMode && !features.includes("publish.contextDigest")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "publishing a workflow candidate needs a worker that authenticates its complete publication context");
  }
  if (carriesPublicationContextDigest !== carriesPublicationMode) {
    throw agentXError("CONFIG_INVALID", "workflow publication context digest is missing or unexpected");
  }
  if (invocation.kind === "publish" && carriesPublicationMode) {
    const context = workflowPublicationContext(invocation);
    if (context === undefined || workflowPublicationContextDigest(context) !== invocation.payload.publicationContextDigest) {
      throw agentXError("CONFIG_INVALID", "stored workflow publication context does not match its invocation");
    }
  }
  // The pinned base is the published commit's parent, which the broker checks on GitHub, so it is never dropped either.
  if (carriesPublishBase && !features.includes("publish.workflowBase")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "publishing the checked code needs a worker that builds it on the task's pinned base commit");
  }
  // A reviewed fix is pushed only as exactly its reviewed tree; an older worker would push the workspace as it is, so it gets nothing.
  if (carriesPullRequestUpdate && !features.includes("task.workflowPullRequestUpdate")) {
    throw agentXError("RUNTIME_UNAVAILABLE", WORKFLOW_PULL_REQUEST_UPDATE_WORKER_OUTDATED);
  }
  const reason = workerFeatures === undefined ? "no-probe" : "worker-lacks-feature";
  const leveled = withoutUnparsedFields(invocation, features);
  if (leveled !== invocation) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.thinking_level_omitted",
      reason,
      requestedThinkingLevel,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  // #341: an older worker cannot fetch a ChatGPT token, so its task runs on the default model it also carries.
  const unsupportedChatGpt = carriesChatGpt && !features.includes("model.chatgpt");
  if (unsupportedChatGpt) {
    console.log(JSON.stringify({ component: "dispatcher", event: "dispatch.chatgpt_omitted", reason, operationId: invocation.operationId, workspaceId: invocation.workspaceId }));
  }
  const checked = withoutReadiness(unsupportedChatGpt ? withoutChatGpt(leveled) : leveled, features);
  if (checked !== leveled) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.readiness_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  const reported = withoutReportChecks(checked, features);
  if (reported !== checked) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.report_checks_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  const phased = withoutStructuredPlans(reported, features);
  if (phased !== reported) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.structured_plans_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  const withChecks = withoutReviewChecks(phased, features);
  if (withChecks !== phased) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.review_checks_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  const withPlan = withoutReviewPlan(withChecks, features);
  if (withPlan !== withChecks) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.review_plan_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  const withFeedback = withoutReviewFeedback(withPlan, features);
  if (withFeedback !== withPlan) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.review_feedback_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  const withNote = withoutReviewNote(withFeedback, features);
  if (withNote !== withFeedback) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.review_note_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  const anchored = withoutCodeAnchors(withNote, features);
  if (anchored !== withNote) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.code_anchors_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  const planned = withoutApplicationPlans(anchored, features);
  if (planned !== anchored) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.application_plan_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  // M1.3 Task 3.7b: the request to export the unchanged code is only for a worker that can; an older one runs the coding without it (a baseline never stops the coding), and the
  // baseline then says it could not be checked.
  const sent = withoutBaselineSource(planned, features);
  if (sent !== planned) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.baseline_source_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  return sent;
}

/** A coding run without the request to export the unchanged code, for a worker that does not list "task.workflowE2EBaselineSource": it would reject the field. The export reads the repository alone, so this feature is not withheld with the executor image. */
function withoutBaselineSource(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "task" || invocation.payload.workflowE2EBaselineSource === undefined || features.includes("task.workflowE2EBaselineSource")) return invocation;
  const { workflowE2EBaselineSource: _request, ...payload } = invocation.payload;
  void _request;
  return { ...invocation, payload };
}

/** A planning prompt that does not ask for anchor lines, for a worker that does not parse them: it would reject a plan that carried one. */
function withoutCodeAnchors(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "task" || !asksForCodeAnchors(invocation.payload.prompt) || features.includes("task.codeAnchors")) return invocation;
  return { ...invocation, payload: { ...invocation.payload, prompt: withoutCodeAnchorText(invocation.payload.prompt) } };
}

/**
 * A worker that does not list "task.workflowE2EApplicationPlan" parses only the portable schemaVersion 1 intent, so it is never handed a version 2
 * one: a planning run is sent the portable-only prompt without the plan version, and a review's approved plan without its (version 2) E2E intent.
 * The edit is deterministic, so a retry sends what the first attempt did.
 */
function withoutApplicationPlans(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "task" || features.includes("task.workflowE2EApplicationPlan")) return invocation;
  const payload = { ...invocation.payload };
  let changed = false;
  if (payload.workflowE2EPlanVersion !== undefined) {
    delete payload.workflowE2EPlanVersion;
    changed = true;
  }
  const prompt = withoutApplicationPlanText(payload.prompt);
  if (prompt !== payload.prompt) {
    payload.prompt = prompt;
    changed = true;
  }
  if (payload.workflowReviewPlan?.e2eIntent?.schemaVersion === 2) {
    const { e2eIntent: _applicationIntent, ...plan } = payload.workflowReviewPlan;
    void _applicationIntent;
    payload.workflowReviewPlan = plan;
    changed = true;
  }
  return changed ? { ...invocation, payload } : invocation;
}

/** A planning run without the kind and format of plan it writes, for a worker that does not parse them; it plans without checking the answer's format. */
function withoutStructuredPlans(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "task" || (invocation.payload.workflowPhase === undefined && invocation.payload.planFormat === undefined) || features.includes("task.structuredPlans")) return invocation;
  const payload = { ...invocation.payload };
  delete payload.workflowPhase;
  delete payload.planFormat;
  return { ...invocation, payload };
}

/**
 * A review without the note of which checks ran, for a worker that does not parse it. The note only informs the
 * reviewers' prompt; such a worker reviews the same change as before, without being told which checks ran.
 */
function withoutReviewChecks(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "task" || invocation.payload.workflowReviewChecks === undefined || features.includes("task.workflowReviewChecks")) return invocation;
  const payload = { ...invocation.payload };
  delete payload.workflowReviewChecks;
  return { ...invocation, payload };
}

/**
 * A review without the approved plan, for a worker that does not parse it. The plan only informs the reviewers'
 * prompt; such a worker reviews the same change as before, without seeing the plan.
 */
function withoutReviewPlan(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "task" || invocation.payload.workflowReviewPlan === undefined || features.includes("task.workflowReviewPlan")) return invocation;
  const payload = { ...invocation.payload };
  delete payload.workflowReviewPlan;
  return { ...invocation, payload };
}

/**
 * A review without the owner's approved PR feedback, for a worker that does not parse it. It only informs the reviewers'
 * prompt; such a worker reviews the same change as before, judging it against the plan alone.
 */
function withoutReviewFeedback(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "task" || invocation.payload.workflowReviewFeedback === undefined || features.includes("task.workflowReviewFeedback")) return invocation;
  const payload = { ...invocation.payload };
  delete payload.workflowReviewFeedback;
  return { ...invocation, payload };
}

/** A review without the owner's retry note for a worker that does not parse it; its review remains unchanged. */
function withoutReviewNote(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "task" || invocation.payload.workflowReviewNote === undefined || features.includes("task.workflowReviewNote")) return invocation;
  const payload = { ...invocation.payload };
  delete payload.workflowReviewNote;
  return { ...invocation, payload };
}

/**
 * A publication without reportChecks, for a worker that does not parse it (spec 051, D-7). Such a worker refuses a
 * failing readiness check, as before, and reports no checks, so the broker opens the pull request as it did.
 */
function withoutReportChecks(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "publish" || invocation.payload.reportChecks === undefined || features.includes("publish.reportChecks")) return invocation;
  const payload = { ...invocation.payload };
  delete payload.reportChecks;
  return { ...invocation, payload };
}

/** A task without its ChatGPT plan, for a worker that cannot use one (#341). */
function withoutChatGpt(invocation: WorkerInvocation): WorkerInvocation {
  if (invocation.kind !== "task" || invocation.payload.chatgpt === undefined) return invocation;
  const payload = { ...invocation.payload };
  delete payload.chatgpt;
  return { ...invocation, payload };
}

/** A task without its readiness, for a worker that does not parse it (spec 051). */
function withoutReadiness(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "task" || invocation.payload.readiness === undefined || features.includes("task.readiness")) return invocation;
  const payload = { ...invocation.payload };
  delete payload.readiness;
  return { ...invocation, payload };
}

/** The first thinking level the invocation carries: a task's model, or a project definition's models. */
function carriedThinkingLevel(invocation: WorkerInvocation): string | undefined {
  if (invocation.kind === "task") return invocation.payload.model?.thinkingLevel;
  if (!carriesProject(invocation)) return undefined;
  const models = invocation.payload.project.models;
  if (models === undefined) return undefined;
  return [models.default, ...models.approved].find((model) => model.thinkingLevel !== undefined)?.thinkingLevel;
}

function withoutUnparsedFields(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind === "task") {
    if (invocation.payload.model === undefined) return invocation;
    const model = modelSelectionFor(invocation.payload.model, features);
    return model === invocation.payload.model ? invocation : { ...invocation, payload: { ...invocation.payload, model } };
  }
  if (!carriesProject(invocation) || features.includes("model.thinkingLevel")) return invocation;
  const models = invocation.payload.project.models;
  if (models === undefined) return invocation;
  const project = { ...invocation.payload.project, models: { default: withoutLevel(models.default), approved: models.approved.map(withoutLevel) } };
  // Identical branches so each keeps its own payload type within the discriminated union.
  if (invocation.kind === "prepare") return { ...invocation, payload: { ...invocation.payload, project } };
  if (invocation.kind === "publish") return { ...invocation, payload: { ...invocation.payload, project } };
  return { ...invocation, payload: { ...invocation.payload, project } };
}

/** Prepare, publish and maintain carry the whole stored project definition; cancel, resume and close carry none. */
function carriesProject(invocation: WorkerInvocation): invocation is Extract<WorkerInvocation, { kind: "prepare" | "publish" | "maintain" }> {
  return invocation.kind === "prepare" || invocation.kind === "publish" || invocation.kind === "maintain";
}

function withoutLevel<Model extends { thinkingLevel?: unknown }>(model: Model): Omit<Model, "thinkingLevel"> {
  const rest: Model = { ...model };
  delete rest.thinkingLevel;
  return rest;
}
