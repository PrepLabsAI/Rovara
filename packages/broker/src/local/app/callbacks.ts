// Lane L9-wire: the callback endpoints a local worker posts to (`/v1/internal/workspaces/<w>/operations/<o>/<action>`), for the three every job has: its events, its artifacts and
// its terminal result. The capability the flow issued at delivery (HMAC, one workspace, one operation, one fence, a list of actions) is checked first; the ids in the address must be the
// capability's own. Every other callback the worker can make (a pull request, a candidate export, a model fallback, ...) answers "not available" until its lane is wired; the worker
// then fails that job with a plain reason instead of waiting for ever.
//
// What the result reader does NOT do yet (the Cloud reader, `terminal-result.ts` and `workflow-items.ts`, is about 2,000 lines of AWS-shaped code): a structured plan document, plan
// evidence, the plan self-check and critique, and everything after the plan is approved. A plan the worker saves as `plan.md` is kept as a Markdown plan.
import { createHash, randomUUID } from "node:crypto";
import {
  AgentXError, UNDERSTAND_ARTIFACT_NAME, WorkflowArtifactSchema, WorkflowReviewBaseSchema, agentXError, change, readIntentArtifact, when,
} from "@agentx/contracts";
import { CallbackCapabilities, type CallbackAction } from "../../callbacks.js";
import type { EvidenceBlobStore } from "../../core/proof/evidence-blob-store.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { currentDocumentType } from "../../core/decisions/workflow-subject.js";
import { operationKey, taskPointerKey } from "../../core/task-flow/keys.js";
import { acknowledgeUpload } from "./candidate-export.js";
import { openPullRequest } from "../../core/build-step/publish.js";
import { updatePullRequest } from "../../core/build-step/maintain.js";
import { readTask } from "../../core/task-flow/reads.js";
import type { StepOutcome } from "../../core/task-flow/outcome.js";
import { fromDocument, type OperationRecord, type TaskPointerRecord } from "../../core/task-flow/records.js";
import { recordOperationResult } from "../../core/task-flow/results.js";
import { iso } from "../../core/task-flow/support.js";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import type { RepositoryCredential, RepositoryGrantService } from "../../repository-access.js";

const ROUTE = /^\/v1\/internal\/workspaces\/([0-9a-f-]{36})\/operations\/([0-9a-f-]{36})\/([a-z-]+)$/u;
export const CAPABILITY_HEADER = "x-agentx-callback-capability";
export const PLAN_ARTIFACT_NAME = "plan.md";
export const PLAN_MAX_BYTES = 200_000;
const ARTIFACT_NAME = /^[A-Za-z0-9._-]{1,120}$/u;
const EVENTS_MAX = 500;
const EVENT_KEEP_SECONDS = 14 * 86_400;

export const artifactObjectKey = (workspaceId: string, operationId: string, name: string): string => `workspaces/${workspaceId}/operations/${operationId}/${name}`;
export const artifactKey = (workspaceId: string, operationId: string, name: string) => ({ pk: `WORKSPACE#${workspaceId}`, sk: `ARTIFACT#${operationId}#${name}` });

export interface CallbackDeps {
  flow: TaskFlowDeps;
  blobs: EvidenceBlobStore;
  /** The repository grants this process issued; a worker exchanges one for a clone or push credential. */
  grants: Pick<RepositoryGrantService, "exchange">;
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });

function bodyOf(request: BrokerRequest): Record<string, unknown> {
  let value: unknown;
  try { value = request.body === undefined || request.body === "" ? {} : JSON.parse(request.body); } catch { throw agentXError("CONFIG_INVALID", "the callback body is not JSON"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw agentXError("CONFIG_INVALID", "the callback body must be an object");
  return value as Record<string, unknown>;
}

async function operationOf(deps: CallbackDeps, workspaceId: string, operationId: string): Promise<OperationRecord> {
  const operation = fromDocument<OperationRecord>(await deps.flow.store.get(operationKey(workspaceId, operationId)));
  if (operation === undefined || operation.companyId !== deps.flow.companyId) throw agentXError("NOT_FOUND", "operation not found");
  return operation;
}

async function recordArtifact(deps: CallbackDeps, operation: OperationRecord, body: Record<string, unknown>): Promise<{ artifactId: string }> {
  const { name, mediaType, content } = body;
  if (typeof name !== "string" || !ARTIFACT_NAME.test(name) || typeof mediaType !== "string" || mediaType.length > 120 || typeof content !== "string") {
    throw agentXError("CONFIG_INVALID", "an artifact needs a plain file name, a media type and its content");
  }
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > PLAN_MAX_BYTES) throw agentXError("CONFIG_INVALID", "the artifact is too large");
  const id = randomUUID();
  const objectKey = artifactObjectKey(operation.workspaceId, operation.id, name);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await deps.blobs.put(objectKey, bytes, { contentType: mediaType, metadata: { sha256, name }, retention: "evidence-std" });
  // The latest artifact of a name wins: a worker that saves the same file twice (a plan written again) leaves the second.
  await deps.flow.store.put({ item: { ...artifactKey(operation.workspaceId, operation.id, name), entityType: "ARTIFACT", id, workspaceId: operation.workspaceId, operationId: operation.id, name, mediaType, objectKey, sha256, bytes: bytes.byteLength, createdAt: iso(deps.flow) } });
  return { artifactId: id };
}

async function recordEvents(deps: CallbackDeps, operation: OperationRecord, body: Record<string, unknown>): Promise<{ accepted: number }> {
  const events = body["events"];
  if (!Array.isArray(events) || events.length < 1 || events.length > EVENTS_MAX) throw agentXError("CONFIG_INVALID", `a batch holds 1 through ${EVENTS_MAX} events`);
  const parsed = events.map((event) => {
    const record = event as Record<string, unknown>;
    if (record === null || typeof record !== "object" || typeof record["type"] !== "string" || typeof record["timestamp"] !== "string") throw agentXError("CONFIG_INVALID", "an event needs a type and a timestamp");
    return { type: record["type"], timestamp: record["timestamp"], payload: record["payload"] ?? null };
  });
  // The operation's counter hands out the sequence numbers, so events keep their order whichever batch they arrived in.
  const counted = await deps.flow.store.update({ key: operationKey(operation.workspaceId, operation.id), ops: [change.add("eventSequence", parsed.length)], condition: when.present(), return: "new" });
  const item = counted.applied ? counted.item : undefined;
  const last = typeof item?.["eventSequence"] === "number" ? item["eventSequence"] : parsed.length;
  const expiresAt = Math.floor((deps.flow.now?.() ?? new Date()).getTime() / 1000) + EVENT_KEEP_SECONDS;
  await Promise.all(parsed.map((event, index) => deps.flow.store.put({
    item: { pk: `WORKSPACE#${operation.workspaceId}`, sk: `EVENT#${operation.id}#${String(last - parsed.length + index + 1).padStart(10, "0")}`, entityType: "OPERATION_EVENT", operationId: operation.id, sequence: last - parsed.length + index + 1, expiresAt, ...JSON.parse(JSON.stringify(event)) as Record<string, never> },
  })));
  return { accepted: parsed.length };
}

async function readArtifactText(deps: CallbackDeps, operation: OperationRecord, name: string, maxBytes: number): Promise<{ text: string; artifact: { id: string; objectKey: string; createdAt: string; sha256: string } } | undefined> {
  const found = await deps.flow.store.get(artifactKey(operation.workspaceId, operation.id, name));
  if (found === undefined || typeof found["objectKey"] !== "string" || typeof found["id"] !== "string" || typeof found["createdAt"] !== "string" || typeof found["sha256"] !== "string") return undefined;
  const bytes = await deps.blobs.get(found["objectKey"], maxBytes);
  if (bytes === undefined) return undefined;
  return { text: new TextDecoder().decode(bytes), artifact: { id: found["id"], objectKey: found["objectKey"], createdAt: found["createdAt"], sha256: found["sha256"] } };
}

/**
 * What a finished job meant, read from what the worker saved and checked here, never taken from the worker's word. An unreadable answer is no outcome: the flow then blocks the step with
 * a plain reason and the owner can retry it.
 */
export async function readOutcome(deps: CallbackDeps, operation: OperationRecord, result: unknown): Promise<StepOutcome | undefined> {
  if (operation.kind === "prepare") {
    const base = WorkflowReviewBaseSchema.safeParse((result as { preparedBase?: unknown } | undefined)?.preparedBase);
    return { kind: "prepared", ...(base.success ? { base: base.data } : {}) };
  }
  if (operation.workflowMode === "UNDERSTAND") {
    const saved = await readArtifactText(deps, operation, UNDERSTAND_ARTIFACT_NAME, 32_768 + 1);
    if (saved === undefined) return undefined;
    const read = readIntentArtifact(saved.text);
    if (!read.ok) return undefined;
    return { kind: "understood", assessment: read.assessment, answerArtifact: { id: saved.artifact.id, objectKey: saved.artifact.objectKey, createdAt: saved.artifact.createdAt } };
  }
  if (operation.workflowMode === "PLAN") {
    const saved = await readArtifactText(deps, operation, PLAN_ARTIFACT_NAME, PLAN_MAX_BYTES + 1);
    if (saved === undefined || saved.text.trim() === "") return undefined;
    const pointer = fromDocument<TaskPointerRecord>(await deps.flow.store.get(taskPointerKey(operation.workspaceId)));
    const workflow = pointer === undefined ? undefined : (await readTask(deps.flow, pointer.taskId))?.workflow;
    if (workflow === undefined) return undefined;
    // The document type is the workflow's own (a Quick or a coding plan is `plan`); `submitWorkflowArtifact` refuses a type the phase does not expect.
    const type = currentDocumentType(workflow);
    const parsed = WorkflowArtifactSchema.safeParse({
      id: saved.artifact.id, type, version: workflow.artifacts.filter((artifact) => artifact.type === type).length + 1,
      sha256: saved.artifact.sha256, producer: "agentx-worker-untrusted", objectKey: saved.artifact.objectKey, createdAt: saved.artifact.createdAt, format: "markdown",
    });
    return parsed.success ? { kind: "planned", artifact: parsed.data } : undefined;
  }
  // The steps after the plan: what the worker reported is handed to the build step as it was reported; the build step reads it against its schemas and the task's own record.
  if (operation.workflowMode === "IMPLEMENT" || operation.workflowMode === "CHECKS") return { kind: "built", result: result ?? {} };
  if (operation.workflowMode === "REVIEW") return { kind: "reviewed", result: result ?? {} };
  if (operation.kind === "publish" || operation.kind === "maintain") return { kind: "published", result: result ?? {} };
  return { kind: "ended" };
}

/**
 * A clone or push credential for the repositories this operation's grant names. The grant is the proof (signed, short-lived, one workspace and operation); the operation must still be live,
 * so a grant kept after the job ended gets nothing.
 */
async function exchangeCredential(deps: CallbackDeps, request: BrokerRequest, workspaceId: string, operationId: string): Promise<RepositoryCredential> {
  const grant = request.headers["x-agentx-repository-grant"];
  if (grant === undefined || grant === "") throw agentXError("FORBIDDEN", "a repository grant is required");
  const operation = await operationOf(deps, workspaceId, operationId);
  if (operation.status === "SUCCEEDED" || operation.status === "FAILED" || operation.status === "CANCELLED" || operation.status === "INTERRUPTED") throw agentXError("FORBIDDEN", "this operation has ended");
  const body = bodyOf(request);
  const { credentialRef, repositoryUrl, access } = body;
  if (typeof credentialRef !== "string" || typeof repositoryUrl !== "string" || (access !== "clone" && access !== "push")) throw agentXError("CONFIG_INVALID", "name the credential, the repository and the access");
  return deps.grants.exchange(grant, { workspaceId, operationId, credentialRef, repositoryUrl, access });
}

export function createCallbackHandler(deps: CallbackDeps): (request: BrokerRequest) => Promise<BrokerResponse> {
  const capabilities = new CallbackCapabilities(Buffer.from(deps.flow.callbackSigningKey));
  return async (request) => {
    try {
      const match = ROUTE.exec((request.path.split("?")[0]) ?? "");
      if (request.method !== "POST" || match === null) throw agentXError("NOT_FOUND", "route not found");
      const [, workspaceId, operationId, action] = match as unknown as [string, string, string, string];
      if (action === "repository-credentials") return json(200, { credential: await exchangeCredential(deps, request, workspaceId, operationId) });
      const token = request.headers[CAPABILITY_HEADER];
      if (token === undefined || token === "") throw agentXError("CALLBACK_FORBIDDEN", "callback capability is required");
      if (action === "candidate-export" || action === "candidate-build-source" || action === "baseline-source") {
        const capability = capabilities.verify(token, action);
        if (capability.workspaceId !== workspaceId || capability.operationId !== operationId) throw agentXError("CALLBACK_FORBIDDEN", "callback route is outside the capability scope");
        const operation = await operationOf(deps, workspaceId, operationId);
        if (operation.fence !== capability.fence) throw agentXError("STALE_FENCE", "callback no longer owns the workspace");
        return json(200, acknowledgeUpload(bodyOf(request), { allowUnavailable: action !== "candidate-export" }));
      }
      if (action === "pull-request") {
        const capability = capabilities.verify(token, action);
        if (capability.workspaceId !== workspaceId || capability.operationId !== operationId) throw agentXError("CALLBACK_FORBIDDEN", "callback route is outside the capability scope");
        const operation = await operationOf(deps, workspaceId, operationId);
        if (operation.fence !== capability.fence) throw agentXError("STALE_FENCE", "callback no longer owns the workspace");
        return json(200, await openPullRequest(deps.flow, operation, bodyOf(request)));
      }
      if (action === "pull-request-update") {
        const capability = capabilities.verify(token, action);
        if (capability.workspaceId !== workspaceId || capability.operationId !== operationId) throw agentXError("CALLBACK_FORBIDDEN", "callback route is outside the capability scope");
        const operation = await operationOf(deps, workspaceId, operationId);
        if (operation.fence !== capability.fence) throw agentXError("STALE_FENCE", "callback no longer owns the workspace");
        return json(200, await updatePullRequest(deps.flow, operation, bodyOf(request)));
      }
      if (action !== "events" && action !== "artifacts" && action !== "result") {
        // A callback this install does not serve yet. The capability is still checked, so the answer tells an unauthorised caller nothing.
        capabilities.verify(token, action as CallbackAction);
        throw agentXError("NOT_FOUND", "this callback is not available on this install");
      }
      const capability = capabilities.verify(token, action);
      if (capability.workspaceId !== workspaceId || capability.operationId !== operationId) throw agentXError("CALLBACK_FORBIDDEN", "callback route is outside the capability scope");
      const operation = await operationOf(deps, workspaceId, operationId);
      if (operation.fence !== capability.fence) throw agentXError("STALE_FENCE", "callback no longer owns the workspace");
      const body = bodyOf(request);
      if (action === "events") return json(200, await recordEvents(deps, operation, body));
      if (action === "artifacts") return json(200, await recordArtifact(deps, operation, body));
      const status = body["status"];
      if (status !== "SUCCEEDED" && status !== "FAILED" && status !== "CANCELLED") throw agentXError("CONFIG_INVALID", "a result needs a status");
      const error = typeof body["error"] === "string" ? body["error"] : undefined;
      // A coding run that left the code as it was reports what it found with its failure, so a failed coding run's result is handed over too (the build step reads only what it needs of it).
      const outcome = status === "SUCCEEDED" ? await readOutcome(deps, operation, body["result"])
        : operation.workflowMode === "IMPLEMENT" && typeof body["result"] === "object" && body["result"] !== null ? { kind: "built" as const, result: body["result"] } : undefined;
      const recorded = await recordOperationResult(deps.flow, { workspaceId, operationId, fence: capability.fence, status, ...(error === undefined ? {} : { error }), ...(outcome === undefined ? {} : { outcome }) });
      return json(200, { ok: true, duplicate: recorded.duplicate });
    } catch (error) {
      if (error instanceof AgentXError) return json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
      deps.flow.log?.({ component: "callbacks", event: "callback_failed", error: error instanceof Error ? error.name : "unknown" });
      return json(500, { error: { code: "INTERNAL", message: "the callback could not be recorded" } });
    }
  };
}
