// Lane L6a, task flow core: starting a task (Cloud's `aws/developer-tasks/start.ts`, rewritten onto the W0 ports).
//
// One start is one document-store transaction: the workspace, its preparation (an operation and its staged dispatch message), the task, its
// index row, its callback pointer, the conversation, the idempotency record, the workspace-slot charge, whatever `Admission` and `AuditSink`
// stage, and (for a workflow that understands first) the dispatch row of its first step. Either all of it exists or none of it does.
import { ROVARA_CODE_PROGRAM } from "../plan/program.js";
import {
  AgentXError,
  UNRUNNABLE_EXTERNAL_CHECK_MESSAGE,
  unrunnableExternalCheck,
  ROVARA_CODE_V2_FOR_NEW_ORGS,
  StartDeveloperTaskRequestSchema,
  WORKFLOW_PATH_REQUIRED,
  agentXError,
  SCRIPT_TOKEN_CLIENT_NAME,
  cleanClientName,
  createWorkflowSnapshot,
  workspaceProjectIndexAttributes,
  when,
  DocumentStoreError,
  type JsonValue,
  type StartDeveloperTaskRequest,
  type TransactItem,
} from "@agentx/contracts";
import { taskOwnerKey } from "../../developer/task-records.js";
import { buildOperation } from "./accept.js";
import { recordAudit, releaseAdmission, stageAdmission, stageAudit } from "./admission.js";
import { taskWorkflowCheckPolicy } from "./check-policy.js";
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import { dispatchRowItem } from "./dispatch-rows.js";
import { chargeConflict, chargeItems, limitReached } from "./limits.js";
import { developerCharge, startIdempotencyKey, taskIndexKey, taskKey, taskPointerKey, workspaceKey, conversationKey } from "./keys.js";
import { loadOwnedTask, taskViewOf, type TaskView } from "./reads.js";
import { toDocument, type TaskPointerRecord, type TaskRecord, type WorkspaceRecord } from "./records.js";
import { hashJson, iso, limitsOf, log, newId, redactedTitle, storedRequestText } from "./support.js";
import { assertRepositoryHostsKnown } from "../../plugins/routing.js";
import { codeHostMetaHeadReader } from "../meta-repo/head-reader.js";
import { META_PREPARE_FEATURE, metaPrepareFor } from "../meta-repo/prepare-meta.js";
import { setupAgentPointerItem } from "../setup-agent/agent.js";
import { developerIdOf } from "../sessions/create.js";
import { setupFailedMessage, setupStateOf } from "../setup-agent/check.js";
import type { SetupAgentLimits } from "@agentx/contracts";

export interface StartResult {
  task: TaskView;
  /** True when this call returned the task an earlier call with the same request id made. */
  duplicate: boolean;
}

/** The start's transaction is built again, with a new admission key, when a charge step lost a race; this many tries in all. */
const START_ATTEMPTS = 2;

function parseRequest(value: unknown): StartDeveloperTaskRequest {
  const parsed = StartDeveloperTaskRequestSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  // Field names only: the values are the developer's text (R12).
  throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
}

/**
 * What a setup run adds to a start (`core/setup-agent`): the task is made for setting the project up by running its commands, with these limits, and the project's pointer to its current run is written in the start's own
 * transaction. It holds only while the pointer is the one the caller read (`seenTaskId`), so two runs of one project cannot both start.
 */
export interface SetupAgentStart { limits: SetupAgentLimits; seenTaskId: string | undefined }

export async function startTask(deps: TaskFlowDeps, caller: TaskCaller, value: unknown, run?: { setupAgent?: SetupAgentStart }): Promise<StartResult> {
  const parsedRequest = parseRequest(value);
  const { principal } = caller;
  if (principal.companyId !== deps.companyId) throw agentXError("FORBIDDEN", "this person belongs to another company");
  // `design first:` at the start of a request asks for the design to be reviewed before any code. Read only while the stage exists for the company (and after the company check, so another company's request is refused before anything is read); the instructions are then the request without the prefix.
  const designFirst = parsedRequest.workflow === true ? await deps.designReview?.designFirst(parsedRequest.instructions) : undefined;
  const request = designFirst?.designFirst === true ? { ...parsedRequest, instructions: designFirst.rest } : parsedRequest;
  const developerId = principal.personId;
  // A script token's task always has the fixed client "Script token": the body cannot choose that text, and the token's own name never reaches a pull request footer or a turn record (the audit names the token).
  const client = caller.scriptToken !== undefined ? SCRIPT_TOKEN_CLIENT_NAME : cleanClientName(request.client ?? caller.client);
  const asWorkflow = request.workflow === true;
  const payloadHash = hashJson({
    project: request.project, instructions: request.instructions, title: request.title ?? null,
    ...(asWorkflow ? { workflow: true, ...(request.workflowPath === undefined ? {} : { workflowPath: request.workflowPath }) } : {}),
  });
  const idempotencyKey = startIdempotencyKey(developerId, request.requestId);

  // R8: a retried call returns the first task, whatever changed since.
  const returning = async (previous: { taskId: string; payloadHash: string }): Promise<StartResult> => {
    if (previous.payloadHash !== payloadHash) throw agentXError("IDEMPOTENCY_CONFLICT", "this request_id was already used for another task; use a new request_id");
    return { task: await taskViewOf(deps, await loadOwnedTask(deps, caller, previous.taskId)), duplicate: true };
  };
  const earlier = async (): Promise<{ taskId: string; payloadHash: string } | undefined> => {
    const found = await deps.store.get(idempotencyKey);
    return typeof found?.taskId === "string" && typeof found.payloadHash === "string" ? { taskId: found.taskId, payloadHash: found.payloadHash } : undefined;
  };
  const previous = await earlier();
  if (previous !== undefined) return returning(previous);

  const taskId = newId(deps);
  const refused = async (error: AgentXError): Promise<never> => {
    // A refusal is recorded and writes nothing else: no task, no charge, no machine time.
    await recordAudit(deps, { eventId: `task.start_refused:${taskId}`, actor: { type: "person", id: developerId }, action: "task.start_refused", subject: { type: "task", id: taskId }, details: { project: request.project, code: error.code } });
    throw error;
  };

  // Access first, from the identity adapter's own answer; it is asked again at every step that spends.
  const verdict = await deps.access.checkStart(principal, request.project);
  if (!verdict.allowed) return refused(agentXError(verdict.code, verdict.message));
  if (request.agent !== undefined || request.input !== undefined) return refused(agentXError("CONFIG_INVALID", "agents are not set up in this deployment"));
  if (request.shareToChannel === true || request.shareMode !== undefined || request.channel !== undefined) return refused(agentXError("CONFIG_INVALID", "sharing a task to a channel is not set up in this deployment"));

  const project = await deps.projects.latest(request.project);
  if (project === undefined) return refused(agentXError("PROJECT_NOT_FOUND", `project \`${request.project}\` doesn't exist`));
  // An archived project accepts no new work (Cloud's requireNewWorkAllowed).
  if (project.archived === true) return refused(agentXError("PROJECT_ARCHIVED", `project \`${request.project}\` is archived; unarchive it to start new work`));
  // Every repository of the project must live on a code host this install registered, before the budget, the limits and any write.
  if (deps.codeHosts !== undefined) {
    try {
      assertRepositoryHostsKnown(deps.codeHosts, project.definition.repositories);
    } catch (error) {
      if (error instanceof AgentXError) return refused(error);
      throw error;
    }
  }

  // A project whose own setup check failed starts no work until it is fixed and checked again (a setup run is how it gets fixed, so it is let through). A project nobody checked starts as it always did.
  if (run?.setupAgent === undefined) {
    const setup = await setupStateOf(deps, request.project, project.definition);
    if (setup.status === "failed") return refused(agentXError("CONFIG_INVALID", setupFailedMessage(setup.failedStep ?? "setup")));
  }

  // An external check nothing in this release runs is refused here, with the clear sentence, before the budget, the limits and any machine (lane P2, review M2).
  if (unrunnableExternalCheck(project.definition.repositories) !== undefined) return refused(agentXError("CONFIG_INVALID", UNRUNNABLE_EXTERNAL_CHECK_MESSAGE));

  const understandFirst = asWorkflow && (deps.understandFirst ?? ROVARA_CODE_V2_FOR_NEW_ORGS);
  // A workflow with no Quick or Full path is Understand's to choose on version 1.1.0; anywhere else the explicit path is required.
  if (asWorkflow && request.workflowPath === undefined && !understandFirst) return refused(agentXError("CONFIG_INVALID", WORKFLOW_PATH_REQUIRED));
  const workflowPath = request.workflowPath ?? "QUICK";

  const charge = developerCharge({ companyId: deps.companyId, developerId });
  const limits = limitsOf(deps);
  const full = await limitReached(deps.store, charge, limits);
  if (full !== undefined) return refused(limitError(full, limits));

  const receivedAt = iso(deps);
  const workspaceId = newId(deps);
  const conversationId = newId(deps);
  const prepareOperationId = newId(deps);
  const revision = project.definition.revision;
  const title = redactedTitle(request);
  const ownerKey = taskOwnerKey(developerId, taskId);
  const requestText = storedRequestText(request.instructions);
  const extras = deps.startExtras?.({ taskId, project: request.project, title, principal, client, receivedAt, ...(caller.ticket === undefined ? {} : { ticket: caller.ticket }) });
  // The approved test environment the task starts with, pinned in the start's own transaction: a later approval changes the NEXT task, never this one.
  const testEnvironment = asWorkflow ? await deps.testEnvironment?.forStart({ project: request.project, taskId }) : undefined;

  // The project's playbook is read now, at the head of the default branch, and the task keeps the commit: every step of this task reads the file at it, so one task runs under one playbook. A file that cannot be
  // used, or a host that does not answer, refuses the start with the reason: a task is never started under rules it cannot be given.
  let playbookCommit: string | undefined;
  try {
    playbookCommit = await deps.standingInstructions?.pin(request.project);
  } catch (error) {
    if (error instanceof AgentXError) return refused(error);
    throw error;
  }
  const workspace: WorkspaceRecord = {
    ...workspaceKey(workspaceId), sk: "META", entityType: "WORKSPACE", id: workspaceId, companyId: deps.companyId, orgId: deps.companyId, ownerKey,
    projectName: project.definition.name, projectRevision: revision, ...(playbookCommit === undefined ? {} : { playbookCommit }), status: "PREPARING", activeOperationId: prepareOperationId, fence: 1,
    ...workspaceProjectIndexAttributes({ orgId: deps.companyId, projectName: project.definition.name, createdAt: receivedAt }),
    createdAt: receivedAt, updatedAt: receivedAt,
  };
  // A project whose meta repository is separate from its code: the repository's head is pinned now, through the code host, and the worker materializes exactly that commit. A head that cannot be
  // read refuses the start (a project's team rules are never skipped); the commit the worker reports is kept on the task only when it is this one.
  let meta: Awaited<ReturnType<typeof metaPrepareFor>>;
  try {
    meta = await metaPrepareFor(project.definition, codeHostMetaHeadReader(deps.codeHosts, project.definition), deps.companyId);
  } catch (error) {
    if (error instanceof AgentXError) return refused(error);
    throw error;
  }
  const prepare = buildOperation(deps, {
    workspace, kind: "prepare", requestId: newId(deps), operationId: prepareOperationId, now: receivedAt, recordRequest: false,
    dispatch: { kind: "prepare", projectRevision: revision, payload: meta.meta === undefined ? {} : { meta: JSON.parse(JSON.stringify(meta.meta)) as JsonValue }, ...(meta.meta === undefined ? {} : { requires: [META_PREPARE_FEATURE] }) },
    requester: { personId: developerId, provider: principal.provider },
  });
  const task: TaskRecord = {
    ...taskKey(taskId), entityType: "DEVELOPER_TASK", companyId: deps.companyId, taskId, developerId, provider: principal.provider, developerName: principal.displayName,
    client, project: request.project, title, workspaceId, ownerKey, conversationId, startingRevision: revision, charge, shared: false,
    // A workflow task quotes the request in each plan's "why".
    ...(asWorkflow ? { requestText } : {}),
    // A task intake started from a ticket says so, so its request is shown as the ticket's words and not as the owner's.
    ...(caller.ticket === undefined ? {} : { ticket: { system: caller.ticket.system, id: caller.ticket.id } }),
    ...(designFirst?.designFirst === true ? { designFirst: { by: developerId, at: receivedAt } } : {}),
    createdAt: receivedAt, updatedAt: receivedAt,
    ...(extras?.sessionId === undefined ? {} : { sessionId: extras.sessionId }),
    ...(run?.setupAgent === undefined ? {} : { purpose: "setup_agent" as const, setupAgentLimits: run.setupAgent.limits }),
    ...(asWorkflow ? { workflow: createWorkflowSnapshot({
      taskId, ownerId: ownerKey, now: receivedAt, path: workflowPath, checkPolicy: taskWorkflowCheckPolicy(project.definition, testEnvironment?.environment),
      // A 1.1.0 workflow alone may hold the Understand stage: it starts at UNDERSTAND/READY, and says whether the request or Understand chose the path.
      ...(understandFirst ? { definitionVersion: "1.1.0" as const, understand: true, pathFrom: request.workflowPath === undefined ? "understand" as const : "request" as const } : {}),
      // Rovara Code's own sequence (plan, plan check, coding, checks, reviews, pull request): the plan check reads each coding plan before a person sees it.
      ...(understandFirst && deps.planCheck !== false ? { program: ROVARA_CODE_PROGRAM } : {}),
    }) } : {}),
  };
  const pointer: TaskPointerRecord = {
    ...taskPointerKey(workspaceId), entityType: "DEVELOPER_TASK_POINTER", taskId, developerId,
    requester: { kind: "developer", developerId, provider: principal.provider },
    conversationId, firstRequestId: newId(deps),
    // FR-019: the instructions exactly as sent. A task that understands first queues no planning run: its first step is the flow's.
    ...(understandFirst ? {} : { pendingPrompt: request.instructions }),
    ...(asWorkflow && !understandFirst ? { pendingWorkflowMode: "PLAN" as const } : {}),
    // A setup run's first step is its own, after the preparation: it runs the project's commands in a setup sandbox.
    ...(run?.setupAgent === undefined ? {} : { pendingWorkflowMode: "SETUP_AGENT" as const }),
  };
  const steps = (staged: readonly TransactItem[], taskItem: TaskRecord): TransactItem[] => [
    ...chargeItems(charge, limits, taskId, receivedAt),
    ...staged,
    ...stageAudit(deps, { eventId: `task.started:${taskId}`, actor: { type: "person", id: developerId }, action: "task.started", subject: { type: "task", id: taskId }, details: { project: request.project, workflow: asWorkflow, ...(asWorkflow ? { path: workflowPath } : {}) } }),
    { kind: "put", item: toDocument(workspace), condition: when.absent() },
    ...prepare.items,
    { kind: "put", item: toDocument(taskItem), condition: when.absent() },
    { kind: "put", item: { ...taskIndexKey(developerId, receivedAt, taskId), entityType: "DEVELOPER_TASK_INDEX", taskId, orgId: deps.companyId, project: request.project, title, client, status: "STARTING", shared: false, startingRevision: revision, workspaceId, createdAt: receivedAt, updatedAt: receivedAt }, condition: when.absent() },
    { kind: "put", item: toDocument(pointer), condition: when.absent() },
    { kind: "put", item: { ...conversationKey(workspaceId, conversationId), entityType: "CONVERSATION", id: conversationId, workspaceId, createdAt: receivedAt, updatedAt: receivedAt }, condition: when.absent() },
    { kind: "put", item: { ...idempotencyKey, entityType: "IDEMPOTENCY", taskId, payloadHash }, condition: when.absent() },
    // A task that understands first starts by understanding the request, as a dispatch row like every automatic step; it runs once the preparation has ended.
    ...(understandFirst ? [dispatchRowItem(deps, taskId, 1, "UNDERSTAND", receivedAt)] : []),
    ...(extras?.items ?? []),
    ...(testEnvironment?.pin === undefined ? [] : [testEnvironment.pin]),
    ...(run?.setupAgent === undefined ? [] : [setupAgentPointerItem({ orgId: deps.companyId, project: request.project, taskId, requestId: request.requestId, requestedBy: developerIdOf(principal), basedOnRevision: revision, startedAt: receivedAt, limits: run.setupAgent.limits, seenTaskId: run.setupAgent.seenTaskId })]),
  ];
  const idempotencyIndex = (items: readonly TransactItem[]): number => items.findIndex((item) => item.kind === "put" && item.item.pk === idempotencyKey.pk && item.item.sk === idempotencyKey.sk);

  for (let attempt = 1; attempt <= START_ATTEMPTS; attempt += 1) {
    // The admission key is made from this call's own task id and the try: a second call for the same request holds its own allowance (the first
    // call that commits wins; the other gives back only its own), and a try after a lost race is not answered with the old decision.
    const admitted = await stageAdmission(deps, { idempotencyKey: `task.start:${taskId}:${attempt}`, action: "task.start", actor: principal, projectName: request.project, subject: { type: "task", id: taskId } });
    if ("refusal" in admitted) return refused(admitted.refusal);
    const taskItem: TaskRecord = admitted.reservationId === undefined ? task : { ...task, admissionReservationId: admitted.reservationId };
    const items = steps(admitted.items, taskItem);
    let result;
    try {
      result = await deps.store.transact(items);
    } catch (error) {
      // A lost race did not commit: the allowance goes back. Any other fault may have committed, so the reservation is left (it expires) rather
      // than given back under a task that exists.
      if (error instanceof DocumentStoreError && error.code === "conflict") {
        await releaseAdmission(deps, admitted.reservationId);
        throw agentXError("WORKSPACE_BUSY", "Rovara could not start the task just now; try again with the same request_id");
      }
      throw error;
    }
    if (result.applied) {
      // The message is handed to its queue now; a relay from a timer does it too if this one is lost, so a failure here never fails the start.
      await deps.outbox.relay({ companyId: deps.companyId, ids: [prepare.operation.id] }).catch((error: unknown) => log(deps, { event: "task_flow.relay_failed", error: error instanceof Error ? error.message : "unknown" }));
      return { task: await taskViewOf(deps, taskItem), duplicate: false };
    }
    // Not committed: this call's own allowance goes back (another call's has a key of its own), unless our own charge is found in place, which means the
    // transaction committed after all and the task holds the allowance.
    const failed = result.failed;
    const conflict = chargeConflict(failed, 0);
    if (conflict !== "already_charged") await releaseAdmission(deps, admitted.reservationId);
    // This task's own charge is there: the transaction committed and only its answer was lost. Or the same request, sent again, committed first.
    const concurrent = conflict === "already_charged" || failed.includes(idempotencyIndex(items)) ? await earlier() : undefined;
    if (concurrent !== undefined) return returning(concurrent);
    if (conflict === "member" || conflict === "organization") return refused(limitError(conflict, limits));
    log(deps, { event: "task_flow.start_retry", attempt, failed: failed.length });
  }
  throw agentXError("WORKSPACE_BUSY", "Rovara could not start the task just now; try again with the same request_id");
}

function limitError(full: "member" | "organization", limits: { member: number; organization: number }): AgentXError {
  return full === "member"
    ? agentXError("WORKSPACE_LIMIT", `you have reached the limit of ${limits.member} open workspaces per person; close a task to start another`)
    : agentXError("WORKSPACE_LIMIT", `this install has reached its limit of ${limits.organization} open workspaces; close a task, or ask an admin`);
}
