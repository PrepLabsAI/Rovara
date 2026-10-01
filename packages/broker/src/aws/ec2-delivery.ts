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
 * worker keeps its image after a release, so a task's thinking level goes only to a worker whose
 * /ping lists it; otherwise the worker runs at its own default level. The invoke token signs the
 * operation, not the payload, so dropping the field leaves it valid.
 */
async function forWorker(
  invocation: WorkerInvocation,
  pingUrl: string,
  workerFeatures: Ec2DeliveryDependencies["workerFeatures"],
): Promise<WorkerInvocation> {
  if (invocation.kind !== "task" || invocation.payload.model?.thinkingLevel === undefined) return invocation;
  let features: readonly string[];
  try {
    features = await workerFeatures?.(pingUrl) ?? [];
  } catch {
    features = [];
  }
  const model = modelSelectionFor(invocation.payload.model, features);
  if (model === invocation.payload.model) return invocation;
  console.log(JSON.stringify({ component: "dispatcher", event: "dispatch.thinking_level_omitted", operationId: invocation.operationId, workspaceId: invocation.workspaceId }));
  return { ...invocation, payload: { ...invocation.payload, model } };
}
