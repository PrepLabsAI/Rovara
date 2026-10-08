import {
  WORKER_INVOKE_AUTHORIZATION_SCHEME,
  agentXError,
  modelSelectionFor,
  workerInvokeToken,
  workerInvokeTokenPayload,
  type Ec2RuntimeBinding,
  type WorkerInvocation,
} from "@agentx/contracts";
import type { Ec2OutboxRecord } from "./lambda.js";
import type { SessionManager } from "./sessions.js";

/** The worker's port; its /invocations accepts only KMS-signed tokens (#80). */
const WORKER_PORT = 8080;
/** A token outlives one delivery attempt and nothing more (design in #76). */
const TOKEN_LIFETIME_SECONDS = 60;
export const STARTING_COMPUTE_MESSAGE = "Starting workspace compute";

export type Ec2Delivery = "DELIVERED" | "WAITING_FOR_SESSION";

export interface Ec2DeliveryDependencies {
  sessions: Pick<SessionManager, "ensureSession">;
  binding: (workspaceId: string) => Promise<Ec2RuntimeBinding | undefined>;
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
  now?: () => number;
}

/**
 * Delivers one ec2-ebs invocation (flows 1 to 3 in #76). When the workspace's session is not ready,
 * ensureSession starts it and parks the outbox record, and this returns WAITING_FOR_SESSION: the
 * caller acknowledges the message without using a retry attempt, and markReady re-queues it.
 */
export function createEc2Delivery(dependencies: Ec2DeliveryDependencies) {
  return async (record: Ec2OutboxRecord, invocation: WorkerInvocation): Promise<Ec2Delivery> => {
    const binding = await dependencies.binding(record.workspaceId);
    if (binding === undefined) throw agentXError("CONFIG_INVALID", `workspace ${record.workspaceId} has no ec2-ebs runtime binding`);
    const session = await dependencies.sessions.ensureSession({ workspaceId: record.workspaceId, binding, waitingOutboxId: record.id });
    if (!session.ready) {
      await dependencies.progress(record, STARTING_COMPUTE_MESSAGE);
      return "WAITING_FOR_SESSION";
    }
    const sent = await forWorker(invocation, `http://${session.privateIp}:${WORKER_PORT}/ping`, dependencies.workerFeatures);
    const payload = workerInvokeTokenPayload({
      workspaceId: record.workspaceId,
      generation: session.generation,
      operationId: invocation.operationId,
      fence: invocation.fence,
      expiresAt: Math.floor((dependencies.now?.() ?? Date.now()) / 1_000) + TOKEN_LIFETIME_SECONDS,
    });
    const signature = await dependencies.sign(Buffer.from(payload, "ascii"));
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

/**
 * Spec 053: the invocation as the worker can parse it. Worker payloads are strict and a running
 * worker keeps its image after a release (or after a worker-image rollback), so a thinking level goes
 * only to a worker whose /ping lists it. A task's level is dropped and the worker runs at its own
 * default level. Prepare, publish and maintain carry the whole stored project definition, whose
 * models carry levels the worker does not use there, so those are stripped. Spec 051: a task's
 * readiness goes only to a worker whose /ping lists "task.readiness"; one built before spec 051 has no
 * verification at all, so it neither checks nor reports (it is a new worker under an old broker, which sends no
 * readiness, that checks the agent's own test commands), and a publication's reportChecks goes only to one whose /ping lists
 * "publish.reportChecks". The invoke token signs the operation, not the payload, so
 * dropping a field leaves it valid. A ping that fails fails the attempt: the worker journals a hash of
 * the whole invocation, so a retry must send what the first attempt would have, and a blip must not
 * run a capable worker at the default level.
 */
async function forWorker(
  invocation: WorkerInvocation,
  pingUrl: string,
  workerFeatures: Ec2DeliveryDependencies["workerFeatures"],
): Promise<WorkerInvocation> {
  const requestedThinkingLevel = carriedThinkingLevel(invocation);
  const carriesReadiness = invocation.kind === "task" && invocation.payload.readiness !== undefined;
  const carriesWorkflowMode = invocation.kind === "task" && invocation.payload.workflowMode !== undefined;
  const carriesWorkflowBase = invocation.kind === "task" && invocation.payload.workflowBase !== undefined;
  const carriesReportChecks = invocation.kind === "publish" && invocation.payload.reportChecks !== undefined;
  const carriesCandidateTree = invocation.kind === "publish" && invocation.payload.candidateTreeSha !== undefined;
  const carriesPublishBase = invocation.kind === "publish" && invocation.payload.workflowBaseCommit !== undefined;
  if (requestedThinkingLevel === undefined && !carriesReadiness && !carriesWorkflowMode && !carriesWorkflowBase && !carriesReportChecks && !carriesCandidateTree && !carriesPublishBase) return invocation;
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
  // The pinned base decides what reviewers judge and whether a finding blocks, so it is never dropped.
  if (carriesWorkflowBase && !features.includes("task.workflowBase")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "workflow reviews need a worker that receives the task's pinned base commit");
  }
  // The checked tree binds the publication to what passed checks and reviews, so it is never dropped either.
  if (carriesCandidateTree && !features.includes("publish.candidateTree")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "publishing the checked code needs a worker that publishes exactly the checked tree");
  }
  // The pinned base is the published commit's parent, which the broker checks on GitHub, so it is never dropped either.
  if (carriesPublishBase && !features.includes("publish.workflowBase")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "publishing the checked code needs a worker that builds it on the task's pinned base commit");
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
  const checked = withoutReadiness(leveled, features);
  if (checked !== leveled) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.readiness_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  const sent = withoutReportChecks(checked, features);
  if (sent !== checked) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.report_checks_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  return sent;
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
