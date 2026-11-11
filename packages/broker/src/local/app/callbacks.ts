// Lane L9-wire: the callback endpoints a local worker posts to (`/v1/internal/workspaces/<w>/operations/<o>/<action>`), for the three every job has: its events, its artifacts and
// its terminal result. The capability the flow issued at delivery (HMAC, one workspace, one operation, one fence, a list of actions) is checked first; the ids in the address must be the
// capability's own. Every other callback the worker can make (a model fallback, the model budget of the browser checks, ...) answers "not available" until its lane is wired; the worker
// then fails that job with a plain reason instead of waiting for ever.
//
// A plan the worker saves as `plan.md` is read by `core/plan` (a structured plan, the default) or kept as a Markdown plan (an install that asks for Markdown).
import type { ObjectStorage } from "@agentx/contracts";
import { createHash, randomUUID } from "node:crypto";
import {
  AgentXError, DESIGN_REVIEW_ARTIFACT, INDEX_EXPIRY_ATTRIBUTE, ObjectConflictError, UNDERSTAND_ARTIFACT_NAME, WorkflowArtifactSchema, WorkflowReviewBaseSchema, agentXError, change, readIntentArtifact, when,
} from "@agentx/contracts";
import { CallbackCapabilities, type CallbackAction } from "../../callbacks.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { currentDocumentType } from "../../core/decisions/workflow-subject.js";
import { operationKey, taskPointerKey } from "../../core/task-flow/keys.js";
import { handleCodingRunUpload, isCodingRunUpload } from "./candidate-export.js";
import { handleE2EEvidenceUpload, readE2EAdmissionChunk, type RoundRecordReaders } from "../../core/e2e/callbacks.js";
import type { UploadStores } from "../../core/e2e/uploads-chunks.js";
import { openPullRequest } from "../../core/build-step/publish.js";
import { updatePullRequest } from "../../core/build-step/maintain.js";
import { readTask } from "../../core/task-flow/reads.js";
import { recordWorkItemProgress } from "../../core/work-breakdown/progress.js";
import type { StepOutcome } from "../../core/task-flow/outcome.js";
import { fromDocument, type OperationRecord, type TaskPointerRecord } from "../../core/task-flow/records.js";
import { isTerminalStatus, recordOperationResult } from "../../core/task-flow/results.js";
import { iso } from "../../core/task-flow/support.js";
import { parseKnowledgeCommit } from "../../core/meta-repo/prepare-meta.js";
import { PLAN_RETENTION } from "../../core/plan/store.js";
import { processPlanAnswer } from "../../core/plan/process.js";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import { readVerifiedText } from "./documents.js";
import { DESIGN_REVIEW_PACKET_PATH, handleDesignReviewPacket } from "../../core/design-review/packet-route.js";
import { CONTEXT_TOOLS_CALL_PATH, CONTEXT_TOOLS_PATH, handleContextTools } from "./context-tools.js";
import type { ContextSourcesRuntime } from "../../context-sources/runtime.js";
import { readDesignTemplate } from "../../core/design-review/template.js";
import { DESIGN_REVIEW_RESULT_MAX_BYTES } from "../../core/design-review/outcome.js";
import { handleSetupAgentCallback, type SetupAgentCallbackDeps } from "../../core/setup-agent/callback.js";
import type { RepositoryCredential, RepositoryGrantService } from "../../repository-access.js";

const ROUTE = /^\/v1\/internal\/workspaces\/([0-9a-f-]{36})\/operations\/([0-9a-f-]{36})\/([a-z-]+)$/u;
export const CAPABILITY_HEADER = "x-agentx-callback-capability";
export { PLAN_RETENTION };
export const PLAN_ARTIFACT_NAME = "plan.md";
/**
 * Names a step of the build step may post more than once in one operation, each time with other bytes (the worker saves `checks.json` again after the one extra turn it gives a coding run whose first
 * rerun found a regression). The last post stands, kept under its own digest so no earlier post is overwritten; nothing in the workflow's digests names such a file, and the build step reads the
 * check report from the run's result, not from this file. Every other name is kept once (see `recordArtifact`).
 */
export const REPLACEABLE_ARTIFACT_NAMES: ReadonlySet<string> = new Set(["checks.json"]);
/** The most posts of a replaceable name one operation may make (each is kept under its own digest). */
export const REPLACEABLE_POSTS_MAX = 8;
export const PLAN_MAX_BYTES = 200_000;
const ARTIFACT_NAME = /^[A-Za-z0-9._-]{1,120}$/u;
const EVENTS_MAX = 500;
const EVENT_KEEP_SECONDS = 14 * 86_400;

export const artifactObjectKey = (workspaceId: string, operationId: string, name: string): string => `workspaces/${workspaceId}/operations/${operationId}/${name}`;
export const artifactKey = (workspaceId: string, operationId: string, name: string) => ({ pk: `WORKSPACE#${workspaceId}`, sk: `ARTIFACT#${operationId}#${name}` });

export interface CallbackDeps {
  flow: TaskFlowDeps;
  blobs: ObjectStorage;
  /** The repository grants this process issued; a worker exchanges one for a clone or push credential. */
  grants: Pick<RepositoryGrantService, "exchange">;
  /**
   * The records of the browser and API round kinds, which the admission read is held to. Absent on an install that does not run those checks: `e2e-admission` and `e2e-evidence` are then
   * answered "not available" (no checks operation is ever started there, so no worker asks).
   */
  e2e?: { records: RoundRecordReaders };
  /** Told after a batch of a worker's events was stored (the lessons' load report). Best effort: it never fails the batch and is not waited on past its own work. */
  onEvents?: ((operation: { workspaceId: string; id: string }, events: ReadonlyArray<{ type: string; payload: unknown }>) => Promise<void>) | undefined;
  /** A setup run's callback (`core/setup-agent`): what it needs beyond the flow's store. Absent: the action is not served. */
  setupAgent?: Omit<SetupAgentCallbackDeps, "store" | "companyId" | "now"> | undefined;
  /** The project's context sources (the monitoring connections and MCP servers the owner ticked). Absent: a stage is told there are none. */
  contextSources?: ContextSourcesRuntime;
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

/** The actions this install answers; any other the worker can make is "not available". */
const SERVED_ACTIONS: ReadonlySet<string> = new Set(["events", "artifacts", "result", "candidate-export", "candidate-build-source", "baseline-source", "e2e-admission", "e2e-evidence", "pull-request", "pull-request-update", "setup-agent"]);
export const TERMINAL_OUTPUT_REFUSAL = "terminal operations cannot publish more output";

/**
 * A worker's artifact, kept once. The first save of a name by an operation fixes its bytes: the same bytes again are the same artifact (a retried post), other bytes are refused. So what
 * the workflow's digest names cannot be rewritten by a later post, even though the worker's capability is still good.
 */
async function recordArtifact(deps: CallbackDeps, operation: OperationRecord, body: Record<string, unknown>): Promise<{ artifactId: string }> {
  const { name, mediaType, content } = body;
  if (typeof name !== "string" || !ARTIFACT_NAME.test(name) || typeof mediaType !== "string" || mediaType.length > 120 || typeof content !== "string") {
    throw agentXError("CONFIG_INVALID", "an artifact needs a plain file name, a media type and its content");
  }
  const bytes = new TextEncoder().encode(content);
  // A design review's result holds every reviewer's answer; it is bigger than a plan (the broker reads it back with the same bound, `DESIGN_REVIEW_RESULT_MAX_BYTES`).
  if (bytes.byteLength > (name === DESIGN_REVIEW_ARTIFACT && operation.designReview !== undefined ? DESIGN_REVIEW_RESULT_MAX_BYTES : PLAN_MAX_BYTES)) throw agentXError("CONFIG_INVALID", "the artifact is too large");
  const id = randomUUID();
  const objectKey = artifactObjectKey(operation.workspaceId, operation.id, name);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const key = artifactKey(operation.workspaceId, operation.id, name);
  if (REPLACEABLE_ARTIFACT_NAMES.has(name)) {
    // The newest post of a replaceable name stands; its bytes live under their own digest, so an earlier post is never rewritten.
    const replaceableKey = `${objectKey}/${sha256}`;
    const earlier = await deps.flow.store.get(key);
    const posts = (typeof earlier?.["posts"] === "number" ? earlier["posts"] : 0) + 1;
    if (posts > REPLACEABLE_POSTS_MAX && earlier?.["sha256"] !== sha256) throw agentXError("CALLBACK_FORBIDDEN", "this file was saved too many times in one operation");
    await deps.flow.store.put({ item: { ...key, entityType: "ARTIFACT", id, workspaceId: operation.workspaceId, operationId: operation.id, name, mediaType, objectKey: replaceableKey, sha256, bytes: bytes.byteLength, posts: Math.min(posts, REPLACEABLE_POSTS_MAX + 1), createdAt: iso(deps.flow) } });
    try {
      await deps.blobs.put(replaceableKey, bytes, { contentType: mediaType, metadata: { sha256, name }, retention: PLAN_RETENTION });
    } catch (error) {
      if (!(error instanceof ObjectConflictError)) throw error;
    }
    return { artifactId: id };
  }
  // The row is the claim on the name (written only if absent); the bytes follow it.
  const claimed = await deps.flow.store.put({
    item: { ...key, entityType: "ARTIFACT", id, workspaceId: operation.workspaceId, operationId: operation.id, name, mediaType, objectKey, sha256, bytes: bytes.byteLength, createdAt: iso(deps.flow) },
    condition: when.absent(),
  });
  let artifactId: string = id;
  if (!claimed.applied) {
    const earlier = await deps.flow.store.get(key);
    if (earlier === undefined || earlier["sha256"] !== sha256 || typeof earlier["id"] !== "string") throw agentXError("CALLBACK_FORBIDDEN", "this artifact was already saved and cannot be replaced");
    artifactId = earlier["id"];
  }
  // A repeat of the same bytes (or a crash between the row and the bytes) puts the same bytes where they belong; an object already there is kept (objects are immutable, and readers
  // check the bytes against the digest, so only these bytes are ever shown).
  try {
    await deps.blobs.put(objectKey, bytes, { contentType: mediaType, metadata: { sha256, name }, retention: PLAN_RETENTION });
  } catch (error) {
    if (!(error instanceof ObjectConflictError)) throw error;
  }
  return { artifactId };
}

async function recordEvents(deps: CallbackDeps, operation: OperationRecord, body: Record<string, unknown>): Promise<{ accepted: number }> {
  const events = body["events"];
  if (!Array.isArray(events) || events.length < 1 || events.length > EVENTS_MAX) throw agentXError("CONFIG_INVALID", `a batch holds 1 through ${EVENTS_MAX} events`);
  const parsed = events.map((event) => {
    const record = event as Record<string, unknown>;
    if (record === null || typeof record !== "object" || typeof record["type"] !== "string" || typeof record["timestamp"] !== "string") throw agentXError("CONFIG_INVALID", "an event needs a type and a timestamp");
    return { type: record["type"], timestamp: record["timestamp"], payload: record["payload"] ?? null };
  });
  // The work item checkpoints of an ordered run (spec 059) are judged against the approved run and written into the task's workflow BEFORE the batch is acknowledged: the worker goes on to the next item only
  // when this returns, so what a retry resumes from is what was durably recorded. A checkpoint that does not continue the approved run is refused (the worker then fails the operation).
  await recordWorkItemProgress(deps.flow, operation, parsed);
  // The operation's counter hands out the sequence numbers, so events keep their order whichever batch they arrived in.
  const counted = await deps.flow.store.update({ key: operationKey(operation.workspaceId, operation.id), ops: [change.add("eventSequence", parsed.length)], condition: when.present(), return: "new" });
  const item = counted.applied ? counted.item : undefined;
  const last = typeof item?.["eventSequence"] === "number" ? item["eventSequence"] : parsed.length;
  const expiresAt = Math.floor((deps.flow.now?.() ?? new Date()).getTime() / 1000) + EVENT_KEEP_SECONDS;
  await Promise.all(parsed.map((event, index) => deps.flow.store.put({
    item: { pk: `WORKSPACE#${operation.workspaceId}`, sk: `EVENT#${operation.id}#${String(last - parsed.length + index + 1).padStart(10, "0")}`, entityType: "OPERATION_EVENT", operationId: operation.id, sequence: last - parsed.length + index + 1, [INDEX_EXPIRY_ATTRIBUTE]: expiresAt, ...JSON.parse(JSON.stringify(event)) as Record<string, never> },
  })));
  return { accepted: parsed.length };
}

async function readArtifactText(deps: CallbackDeps, operation: OperationRecord, name: string, maxBytes: number): Promise<{ text: string; artifact: { id: string; objectKey: string; createdAt: string; sha256: string } } | undefined> {
  const found = await deps.flow.store.get(artifactKey(operation.workspaceId, operation.id, name));
  if (found === undefined || typeof found["objectKey"] !== "string" || typeof found["id"] !== "string" || typeof found["createdAt"] !== "string" || typeof found["sha256"] !== "string") return undefined;
  const read = await readVerifiedText(deps.blobs, { objectKey: found["objectKey"], sha256: found["sha256"] }, maxBytes);
  if (!("text" in read)) return undefined;
  return { text: read.text, artifact: { id: found["id"], objectKey: found["objectKey"], createdAt: found["createdAt"], sha256: found["sha256"] } };
}

/**
 * What a finished job meant, read from what the worker saved and checked here, never taken from the worker's word. An unreadable answer is no outcome: the flow then blocks the step with
 * a plain reason and the owner can retry it.
 */
export async function readOutcome(deps: CallbackDeps, operation: OperationRecord, result: unknown): Promise<StepOutcome | undefined> {
  if (operation.kind === "prepare") {
    const base = WorkflowReviewBaseSchema.safeParse((result as { preparedBase?: unknown } | undefined)?.preparedBase);
    const knowledgeCommit = parseKnowledgeCommit(result);
    return { kind: "prepared", ...(base.success ? { base: base.data } : {}), ...(knowledgeCommit === undefined ? {} : { knowledgeCommit }) };
  }
  if (operation.workflowMode === "SETUP_AGENT") return { kind: "setup-run", result: result ?? {} };
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
    const task = pointer === undefined ? undefined : await readTask(deps.flow, pointer.taskId);
    const workflow = task?.workflow;
    if (task === undefined || workflow === undefined) return undefined;
    // A structured plan (the planning run was asked for one, and says so in its payload): read, judged and stored by `core/plan`, which may also ask the planner again or block planning.
    if (operation.dispatch.payload["planFormat"] === "structured") {
      return processPlanAnswer(deps.flow, deps.blobs, { task, workflow, operation, answer: { content: saved.text, artifact: { id: saved.artifact.id, createdAt: saved.artifact.createdAt } } });
    }
    // The document type is the workflow's own (a Quick or a coding plan is `plan`); `submitWorkflowArtifact` refuses a type the phase does not expect.
    const type = currentDocumentType(workflow);
    // A design of a task with a design review is written in the fixed template (eight sections and one meta block); one that does not read is no result, and the step blocks with a plain reason the owner can retry.
    // The planner's answer to the reviewers' findings carries its own block and is read by the review itself.
    if (type === "design" && workflow.designReview !== undefined && deps.flow.designReview?.isResolveRun(workflow, operation) !== true && !readDesignTemplate(saved.text.trim()).ok) return undefined;
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

const uploadStores = (deps: CallbackDeps): UploadStores => ({ store: deps.flow.store, objects: deps.blobs, ...(deps.flow.now === undefined ? {} : { now: deps.flow.now }), ...(deps.flow.newId === undefined ? {} : { newId: deps.flow.newId }) });

export function createCallbackHandler(deps: CallbackDeps): (request: BrokerRequest) => Promise<BrokerResponse> {
  const capabilities = new CallbackCapabilities(Buffer.from(deps.flow.callbackSigningKey));
  return async (request) => {
    try {
      // The design review's reviewers read their packets here (a GET; the capability names the action and the stored binding names the slots).
      if (request.method === "GET" && (request.path.split("?")[0] ?? "") === DESIGN_REVIEW_PACKET_PATH) return await handleDesignReviewPacket(deps.flow, capabilities, request);
      // A stage reads the project's sources here (the capability names `context-tools`; the gateway stamps the workspace).
      const bare = request.path.split("?")[0] ?? "";
      if (request.method === "GET" && bare === CONTEXT_TOOLS_PATH) return await handleContextTools(deps.flow, capabilities, deps.contextSources, request, "list");
      if (request.method === "POST" && bare === CONTEXT_TOOLS_CALL_PATH) return await handleContextTools(deps.flow, capabilities, deps.contextSources, request, "call");
      const match = ROUTE.exec((request.path.split("?")[0]) ?? "");
      if (request.method !== "POST" || match === null) throw agentXError("NOT_FOUND", "route not found");
      const [, workspaceId, operationId, action] = match as unknown as [string, string, string, string];
      if (action === "repository-credentials") return json(200, { credential: await exchangeCredential(deps, request, workspaceId, operationId) });
      const token = request.headers[CAPABILITY_HEADER];
      if (token === undefined || token === "") throw agentXError("CALLBACK_FORBIDDEN", "callback capability is required");
      if (!SERVED_ACTIONS.has(action) || (action === "setup-agent" && deps.setupAgent === undefined)) {
        // A callback this install does not serve yet. The capability is still checked, so the answer tells an unauthorised caller nothing.
        capabilities.verify(token, action as CallbackAction);
        throw agentXError("NOT_FOUND", "this callback is not available on this install");
      }
      // One path for every action the worker can make: the capability (HMAC, action, expiry), the ids it names, the fence, and, for everything but a repeat of the result, that the operation has not
      // ended. Cloud's rule: once an operation has ended, only its result is taken; late output (a pull request opened from an interrupted publication, a rewritten record) could undo what the workflow read.
      const capability = capabilities.verify(token, action as CallbackAction);
      if (capability.workspaceId !== workspaceId || capability.operationId !== operationId) throw agentXError("CALLBACK_FORBIDDEN", "callback route is outside the capability scope");
      const operation = await operationOf(deps, workspaceId, operationId);
      if (operation.fence !== capability.fence) throw agentXError("STALE_FENCE", "callback no longer owns the workspace");
      if (action !== "result" && isTerminalStatus(operation.status)) throw agentXError("CALLBACK_FORBIDDEN", TERMINAL_OUTPUT_REFUSAL);
      if (isCodingRunUpload(action)) return json(200, await handleCodingRunUpload(action, uploadStores(deps), operation, bodyOf(request)));
      if (action === "e2e-admission" || action === "e2e-evidence") {
        if (deps.e2e === undefined) throw agentXError("NOT_FOUND", "this callback is not available on this install");
        return json(200, action === "e2e-admission" ? await readE2EAdmissionChunk(uploadStores(deps), deps.e2e.records, operation, bodyOf(request))
          : await handleE2EEvidenceUpload(uploadStores(deps), operation, bodyOf(request)));
      }
      if (action === "pull-request") return json(200, await openPullRequest(deps.flow, operation, bodyOf(request)));
      if (action === "pull-request-update") return json(200, await updatePullRequest(deps.flow, operation, bodyOf(request)));
      if (action === "setup-agent") {
        const run = deps.setupAgent!;
        return json(200, await handleSetupAgentCallback({ ...run, store: deps.flow.store, companyId: deps.flow.companyId, now: () => (deps.flow.now?.() ?? new Date()).getTime() }, operation, bodyOf(request)));
      }
      const body = bodyOf(request);
      if (action === "events") {
        const recorded = await recordEvents(deps, operation, body);
        await deps.onEvents?.(operation, ((body["events"] as Array<{ type?: unknown; payload?: unknown }>) ?? []).map((event) => ({ type: String(event.type), payload: event.payload }))).catch(() => undefined);
        return json(200, recorded);
      }
      if (action === "artifacts") return json(200, await recordArtifact(deps, operation, body));
      const status = body["status"];
      if (status !== "SUCCEEDED" && status !== "FAILED" && status !== "CANCELLED") throw agentXError("CONFIG_INVALID", "a result needs a status");
      const error = typeof body["error"] === "string" ? body["error"] : undefined;
      // A coding run that left the code as it was reports what it found with its failure, so a failed coding run's result is handed over too (the build step reads only what it needs of it).
      const outcome = status === "SUCCEEDED" ? await readOutcome(deps, operation, body["result"])
        : operation.workflowMode === "IMPLEMENT" && typeof body["result"] === "object" && body["result"] !== null ? { kind: "built" as const, result: body["result"] }
        // A setup run that failed or was stopped may still carry what it learned (its partial proposal and summary): the broker reads that again at the end.
        : operation.workflowMode === "SETUP_AGENT" && typeof body["result"] === "object" && body["result"] !== null ? { kind: "setup-run" as const, result: body["result"] } : undefined;
      const recorded = await recordOperationResult(deps.flow, { workspaceId, operationId, fence: capability.fence, status, ...(error === undefined ? {} : { error }), ...(outcome === undefined ? {} : { outcome }) });
      return json(200, { ok: true, duplicate: recorded.duplicate });
    } catch (error) {
      if (error instanceof AgentXError) return json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
      deps.flow.log?.({ component: "callbacks", event: "callback_failed", error: error instanceof Error ? error.name : "unknown" });
      return json(500, { error: { code: "INTERNAL", message: "the callback could not be recorded" } });
    }
  };
}
