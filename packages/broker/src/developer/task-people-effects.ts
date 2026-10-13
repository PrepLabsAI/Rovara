import { createHash, randomUUID } from "node:crypto";
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { TaskPeopleProposalSchema, TaskPersonInviteClaimRequestSchema, TaskPersonInviteOutcomeSchema, agentXError, type TaskPeopleChangeResult, type TaskPeopleProposal, type TaskPeopleRoleRequest, type TaskPeopleTakeOwnershipRequest, type TaskPersonInviteClaimRequest, type TaskPersonInviteOutcome } from "@agentx/contracts";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { changeTaskPeople, getTaskPeopleCapabilities, getTaskPeopleEffectAdmission, getTaskPeopleRequestOutcome, resolveTaskPeopleTarget, taskAccessFence, takeTaskOwnership, type TaskPeopleDependencies } from "./task-people.js";

const TTL_MS = 10 * 60 * 1000;
const taskPk = (taskId: string) => `DEVTASK#${taskId}`;
const proposalKey = (taskId: string, requestId: string) => ({ pk: taskPk(taskId), sk: `PEOPLE_PROPOSAL#${requestId}` });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const denied = (): never => { throw agentXError("TASK_ACCESS_DENIED", "People confirmation could not be verified"); };
const conflict = (): never => { throw agentXError("IDEMPOTENCY_CONFLICT", "this People request ID was already used"); };

type StoredProposal = TaskPeopleProposal & {
  pk: string; sk: string; entityType: "TASK_PEOPLE_PROPOSAL"; schemaVersion: 1;
  callerDeveloperId: string; payloadDigest: string; createdAt: string;
  targetDeveloperId?: string;
  invitationStatus?: "CLAIMED" | "ACCEPTED" | "FAILED" | "UNKNOWN";
  invitationTeamId?: string; invitationChannelId?: string; invitationSlackUserId?: string;
  invitationUpdatedAt?: string;
  invitationExecutionReceiptId?: string;
};

export interface TaskPeopleEffectsDependencies extends TaskPeopleDependencies {
  issuer: string;
  resolveTaskPickerPerson?(taskId: string, slackUserId: string): Promise<{ personId: string; developerId: string; slackUserId: string; channelMember: boolean }>;
  taskPeopleChannel?(taskId: string): Promise<{ teamId: string; channelId: string; threadTs: string }>;
  inviteTaskPerson?(input: TaskPersonInviteClaimRequest): Promise<TaskPersonInviteOutcome>;
}

export interface TaskPersonInviteClaimFields {
  taskId: string;
  requestId: string;
  callerDeveloperId: string;
  targetDeveloperId: string;
  personId: string;
  role: "owner";
  expectedPeopleRevision: number;
  payloadDigest: string;
  expiresAt: string;
  invitationTeamId: string;
  invitationChannelId: string;
  invitationSlackUserId: string;
  invitationUpdatedAt: string;
}

/** Hashes only the persisted, ordered claim tuple; it binds a claim but grants no authority. */
export function taskPersonInviteClaimDigest(fields: TaskPersonInviteClaimFields): string {
  return digest({ taskId: fields.taskId, requestId: fields.requestId, callerDeveloperId: fields.callerDeveloperId,
    targetDeveloperId: fields.targetDeveloperId, personId: fields.personId, role: fields.role,
    expectedPeopleRevision: fields.expectedPeopleRevision, payloadDigest: fields.payloadDigest, expiresAt: fields.expiresAt,
    invitationTeamId: fields.invitationTeamId, invitationChannelId: fields.invitationChannelId,
    invitationSlackUserId: fields.invitationSlackUserId, invitationUpdatedAt: fields.invitationUpdatedAt });
}

async function read(deps: TaskPeopleEffectsDependencies, taskId: string, requestId: string): Promise<StoredProposal | undefined> {
  const result = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: proposalKey(taskId, requestId), ConsistentRead: true })) as { Item?: unknown };
  const item = result.Item as Partial<StoredProposal> | undefined;
  if (item === undefined) return undefined;
  const parsed = TaskPeopleProposalSchema.safeParse({ requestId: item.requestId, taskId: item.taskId, expectedPeopleRevision: item.expectedPeopleRevision, kind: item.kind, expiresAt: item.expiresAt, ...(item.personId === undefined ? {} : { personId: item.personId }), ...(item.role === undefined ? {} : { role: item.role }) });
  if (!parsed.success || item.pk !== taskPk(taskId) || item.sk !== proposalKey(taskId, requestId).sk || item.entityType !== "TASK_PEOPLE_PROPOSAL" || item.schemaVersion !== 1
    || typeof item.callerDeveloperId !== "string" || typeof item.payloadDigest !== "string" || typeof item.createdAt !== "string"
    || (parsed.data.kind === "role" ? typeof item.targetDeveloperId !== "string" : item.targetDeveloperId !== undefined)
    || (item.invitationStatus !== undefined && (item.invitationStatus !== "CLAIMED" && item.invitationStatus !== "ACCEPTED" && item.invitationStatus !== "FAILED" && item.invitationStatus !== "UNKNOWN"))
    || (item.invitationStatus !== undefined && (typeof item.invitationTeamId !== "string" || typeof item.invitationChannelId !== "string"
      || typeof item.invitationSlackUserId !== "string" || typeof item.invitationUpdatedAt !== "string"))) return denied();
  return item as StoredProposal;
}

const conditional = (error: unknown) => error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");

async function claimInvitation(
  deps: TaskPeopleEffectsDependencies,
  proposal: StoredProposal,
  binding: { teamId: string; channelId: string; slackUserId: string },
  admission: { peopleRevision: number; taskRevision: number; taskStage: string; taskShare: { teamId: string; channelId: string; threadTs: string } },
): Promise<void> {
  await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
    { Update: {
      TableName: deps.tableName, Key: proposalKey(proposal.taskId, proposal.requestId),
      UpdateExpression: "SET invitationStatus = :status, invitationTeamId = :teamId, invitationChannelId = :channelId, invitationSlackUserId = :slackUserId, invitationUpdatedAt = :updatedAt",
      ConditionExpression: "callerDeveloperId = :callerDeveloperId AND payloadDigest = :payloadDigest AND expiresAt = :expiresAt AND attribute_not_exists(invitationStatus)",
      ExpressionAttributeValues: { ":status": "CLAIMED", ":teamId": binding.teamId, ":channelId": binding.channelId,
        ":slackUserId": binding.slackUserId, ":updatedAt": new Date(deps.now()).toISOString(), ":callerDeveloperId": proposal.callerDeveloperId,
        ":payloadDigest": proposal.payloadDigest, ":expiresAt": proposal.expiresAt },
    } },
    taskAccessFence(deps.tableName, proposal.taskId, admission.peopleRevision),
    { ConditionCheck: {
      TableName: deps.tableName, Key: { pk: taskPk(proposal.taskId), sk: "META" },
      ConditionExpression: "workflow.#revision = :taskRevision AND workflow.#stage = :taskStage AND #share.#teamId = :teamId AND #share.#channelId = :channelId AND #share.#threadTs = :threadTs AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#revision": "revision", "#stage": "stage", "#share": "share", "#teamId": "teamId", "#channelId": "channelId", "#threadTs": "threadTs" },
      ExpressionAttributeValues: { ":taskRevision": admission.taskRevision, ":taskStage": admission.taskStage,
        ":teamId": admission.taskShare.teamId, ":channelId": admission.taskShare.channelId, ":threadTs": admission.taskShare.threadTs },
    } },
  ] }));
}

async function invitationState(
  deps: TaskPeopleEffectsDependencies,
  proposal: StoredProposal,
  status: "CLAIMED" | "ACCEPTED" | "FAILED" | "UNKNOWN",
  expected?: "CLAIMED",
  binding?: { teamId: string; channelId: string; slackUserId: string },
  executionReceiptId?: string,
): Promise<void> {
  const currentBinding = binding ?? { teamId: proposal.invitationTeamId!, channelId: proposal.invitationChannelId!, slackUserId: proposal.invitationSlackUserId! };
  const receiptUpdate = executionReceiptId === undefined ? "" : ", invitationExecutionReceiptId = :executionReceiptId";
  await deps.documentClient.send(new UpdateCommand({
    TableName: deps.tableName, Key: proposalKey(proposal.taskId, proposal.requestId),
    UpdateExpression: `SET invitationStatus = :status, invitationTeamId = :teamId, invitationChannelId = :channelId, invitationSlackUserId = :slackUserId, invitationUpdatedAt = :updatedAt${receiptUpdate}`,
    ConditionExpression: `callerDeveloperId = :callerDeveloperId AND payloadDigest = :payloadDigest AND expiresAt = :expiresAt AND ${expected === undefined ? "attribute_not_exists(invitationStatus)" : "invitationStatus = :expected"}`,
    ExpressionAttributeValues: { ":status": status, ":teamId": currentBinding.teamId, ":channelId": currentBinding.channelId,
      ":slackUserId": currentBinding.slackUserId, ":updatedAt": new Date(deps.now()).toISOString(), ":callerDeveloperId": proposal.callerDeveloperId,
      ":payloadDigest": proposal.payloadDigest, ":expiresAt": proposal.expiresAt, ...(expected === undefined ? {} : { ":expected": expected }),
      ...(executionReceiptId === undefined ? {} : { ":executionReceiptId": executionReceiptId }) },
  }));
}

async function propose(
  deps: TaskPeopleEffectsDependencies,
  caller: DeveloperCaller,
  taskId: string,
  proposal: Omit<TaskPeopleProposal, "expiresAt">,
): Promise<TaskPeopleChangeResult> {
  const payloadDigest = digest(proposal);
  const existing = await read(deps, taskId, proposal.requestId);
  if (existing !== undefined) {
    if (existing.callerDeveloperId !== caller.developerId || existing.payloadDigest !== payloadDigest) return conflict();
    const payload = existing.kind === "role"
      ? { expectedPeopleRevision: existing.expectedPeopleRevision, targetDeveloperId: existing.targetDeveloperId!, role: existing.role! }
      : { expectedPeopleRevision: existing.expectedPeopleRevision };
    const outcome = await getTaskPeopleRequestOutcome(deps, caller, taskId, existing.requestId,
      existing.kind === "role" ? "change" : "takeOwnership", payload);
    if (outcome !== undefined) return { status: "COMMITTED", view: outcome };
    await pendingMetadata(deps, caller, taskId, existing);
    return { status: "PENDING", requestId: existing.requestId, confirmationUrl: `${deps.issuer}/review/${taskId}/task/people/confirm/${existing.requestId}`, expiresAt: existing.expiresAt };
  }
  const capabilities = await getTaskPeopleCapabilities(deps, caller, taskId);
  if (proposal.kind === "role" ? !capabilities.canManagePeople : !capabilities.canTakeOwnership) return denied();
  if (capabilities.peopleRevision !== proposal.expectedPeopleRevision) return conflict();
  const targetDeveloperId = proposal.kind === "role" ? (await resolveTaskPeopleTarget(deps, taskId, proposal.personId!)).developerId : undefined;
  const createdAt = new Date(deps.now()).toISOString();
  const expiresAt = new Date(deps.now() + TTL_MS).toISOString();
  const item: StoredProposal = { ...proposalKey(taskId, proposal.requestId), ...proposal, expiresAt, entityType: "TASK_PEOPLE_PROPOSAL", schemaVersion: 1,
    callerDeveloperId: caller.developerId, payloadDigest, createdAt, ...(targetDeveloperId === undefined ? {} : { targetDeveloperId }) };
  try {
    await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: item, ConditionExpression: "attribute_not_exists(pk)" }));
  } catch (error) {
    const raced = await read(deps, taskId, proposal.requestId);
    if (raced === undefined || raced.callerDeveloperId !== caller.developerId || raced.payloadDigest !== payloadDigest) throw error;
    await pendingMetadata(deps, caller, taskId, raced);
    return { status: "PENDING", requestId: raced.requestId, confirmationUrl: `${deps.issuer}/review/${taskId}/task/people/confirm/${raced.requestId}`, expiresAt: raced.expiresAt };
  }
  return { status: "PENDING", requestId: proposal.requestId, confirmationUrl: `${deps.issuer}/review/${taskId}/task/people/confirm/${proposal.requestId}`, expiresAt };
}

export async function proposeTaskPeopleRole(deps: TaskPeopleEffectsDependencies, caller: DeveloperCaller, taskId: string, input: TaskPeopleRoleRequest): Promise<TaskPeopleChangeResult> {
  return propose(deps, caller, taskId, { kind: "role", taskId, requestId: input.requestId, expectedPeopleRevision: input.expectedPeopleRevision, personId: input.personId, role: input.role });
}

export async function proposeTaskOwnership(deps: TaskPeopleEffectsDependencies, caller: DeveloperCaller, taskId: string, input: TaskPeopleTakeOwnershipRequest): Promise<TaskPeopleChangeResult> {
  return propose(deps, caller, taskId, { kind: "takeOwnership", taskId, requestId: input.requestId, expectedPeopleRevision: input.expectedPeopleRevision });
}

function publicMetadata(proposal: StoredProposal): TaskPeopleProposal {
  return TaskPeopleProposalSchema.parse({ requestId: proposal.requestId, taskId: proposal.taskId, expectedPeopleRevision: proposal.expectedPeopleRevision,
    kind: proposal.kind, expiresAt: proposal.expiresAt, ...(proposal.personId === undefined ? {} : { personId: proposal.personId }),
    ...(proposal.role === undefined ? {} : { role: proposal.role }) });
}

async function pendingMetadata(
  deps: TaskPeopleEffectsDependencies,
  caller: DeveloperCaller,
  taskId: string,
  proposal: StoredProposal,
): Promise<TaskPeopleProposal> {
  if (proposal.callerDeveloperId !== caller.developerId || deps.now() >= Date.parse(proposal.expiresAt)) return denied();
  const capabilities = await getTaskPeopleCapabilities(deps, caller, taskId);
  if (capabilities.peopleRevision !== proposal.expectedPeopleRevision
    || (proposal.kind === "role" ? !capabilities.canManagePeople : !capabilities.canTakeOwnership)) return denied();
  return publicMetadata(proposal);
}

export async function getTaskPeopleProposal(deps: TaskPeopleEffectsDependencies, caller: DeveloperCaller, taskId: string, requestId: string): Promise<TaskPeopleChangeResult> {
  const proposal = await read(deps, taskId, requestId);
  if (proposal === undefined || proposal.callerDeveloperId !== caller.developerId) return denied();
  const payload = proposal.kind === "role"
    ? { expectedPeopleRevision: proposal.expectedPeopleRevision, targetDeveloperId: proposal.targetDeveloperId!, role: proposal.role! }
    : { expectedPeopleRevision: proposal.expectedPeopleRevision };
  const outcome = await getTaskPeopleRequestOutcome(deps, caller, taskId, proposal.requestId,
    proposal.kind === "role" ? "change" : "takeOwnership", payload);
  if (outcome !== undefined) return { status: "COMMITTED", view: outcome };
  await pendingMetadata(deps, caller, taskId, proposal);
  return { status: "PENDING", requestId: proposal.requestId, confirmationUrl: `${deps.issuer}/review/${taskId}/task/people/confirm/${proposal.requestId}`, expiresAt: proposal.expiresAt };
}

/** Server-stored confirmation metadata for an exact still-pending request. */
export async function getTaskPeopleProposalMetadata(
  deps: TaskPeopleEffectsDependencies,
  caller: DeveloperCaller,
  taskId: string,
  requestId: string,
): Promise<TaskPeopleProposal> {
  const proposal = await read(deps, taskId, requestId);
  if (proposal === undefined) return denied();
  const payload = proposal.kind === "role"
    ? { expectedPeopleRevision: proposal.expectedPeopleRevision, targetDeveloperId: proposal.targetDeveloperId!, role: proposal.role! }
    : { expectedPeopleRevision: proposal.expectedPeopleRevision };
  if (await getTaskPeopleRequestOutcome(deps, caller, taskId, proposal.requestId,
    proposal.kind === "role" ? "change" : "takeOwnership", payload) !== undefined) return denied();
  return pendingMetadata(deps, caller, taskId, proposal);
}

export async function confirmTaskPeopleProposal(deps: TaskPeopleEffectsDependencies, caller: DeveloperCaller, taskId: string, requestId: string): Promise<TaskPeopleChangeResult> {
  const proposal = await read(deps, taskId, requestId);
  if (proposal === undefined || proposal.callerDeveloperId !== caller.developerId || deps.now() >= Date.parse(proposal.expiresAt)) return denied();
  const capabilities = await getTaskPeopleCapabilities(deps, caller, taskId);
  if (proposal.kind === "takeOwnership") {
    if (!capabilities.canTakeOwnership && !capabilities.canManagePeople) return denied();
    return { status: "COMMITTED", view: await takeTaskOwnership(deps, caller, taskId, { requestId, expectedPeopleRevision: proposal.expectedPeopleRevision }) };
  }
  if (!capabilities.canManagePeople || proposal.personId === undefined || proposal.role === undefined) return denied();
  const target = await resolveTaskPeopleTarget(deps, taskId, proposal.personId);
  return { status: "COMMITTED", view: await changeTaskPeople(deps, caller, taskId, { requestId, expectedPeopleRevision: proposal.expectedPeopleRevision, targetDeveloperId: target.developerId, role: proposal.role }) };
}

/** A signed Slack form is the explicit human confirmation; picker identity and any invite are resolved server-side. */
export async function submitSlackTaskPeopleRole(
  deps: TaskPeopleEffectsDependencies,
  caller: DeveloperCaller,
  taskId: string,
  input: { requestId: string; expectedPeopleRevision: number; slackUserId: string; role: "owner" | "commenter" | "viewer" | "denied"; teamId: string; channelId: string },
): Promise<TaskPeopleChangeResult> {
  if (deps.resolveTaskPickerPerson === undefined) return denied();
  const before = await getTaskPeopleCapabilities(deps, caller, taskId);
  if (!before.canManagePeople || before.peopleRevision !== input.expectedPeopleRevision) return denied();
  let target = await deps.resolveTaskPickerPerson(taskId, input.slackUserId);
  if (target.slackUserId !== input.slackUserId) return denied();
  const proposed = await proposeTaskPeopleRole(deps, caller, taskId, {
    requestId: input.requestId, expectedPeopleRevision: input.expectedPeopleRevision, personId: target.personId, role: input.role,
  });
  if (proposed.status !== "PENDING") return proposed;
  if (input.role === "owner" && !target.channelMember) {
    if (deps.inviteTaskPerson === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Slack channel invitation is not configured");
    let stored = await read(deps, taskId, input.requestId);
    if (stored === undefined || stored.callerDeveloperId !== caller.developerId || deps.now() >= Date.parse(stored.expiresAt)) return denied();
    const sameBinding = stored.invitationTeamId === input.teamId && stored.invitationChannelId === input.channelId && stored.invitationSlackUserId === input.slackUserId;
    if (stored.invitationStatus !== undefined && !sameBinding) return conflict();
    if (stored.invitationStatus === "CLAIMED" || stored.invitationStatus === "FAILED" || stored.invitationStatus === "UNKNOWN") {
      throw agentXError("RUNTIME_UNAVAILABLE", "Slack channel invitation has no safe retry");
    }
    if (stored.invitationStatus === undefined) {
      if (deps.taskPeopleChannel === undefined) return denied();
      const channel = await deps.taskPeopleChannel(taskId);
      if (channel.teamId !== input.teamId || channel.channelId !== input.channelId) return denied();
      const atInvite = await getTaskPeopleEffectAdmission(deps, caller, taskId);
      if (atInvite.peopleRevision !== input.expectedPeopleRevision || atInvite.taskShare.teamId !== channel.teamId
        || atInvite.taskShare.channelId !== channel.channelId || atInvite.taskShare.threadTs !== channel.threadTs) return denied();
      try { await claimInvitation(deps, stored, { teamId: input.teamId, channelId: input.channelId, slackUserId: input.slackUserId }, atInvite); }
      catch (error) {
        if (!conditional(error)) throw error;
        stored = (await read(deps, taskId, input.requestId)) ?? stored;
        if (stored.invitationStatus !== "ACCEPTED" || stored.invitationTeamId !== input.teamId || stored.invitationChannelId !== input.channelId
          || stored.invitationSlackUserId !== input.slackUserId) throw agentXError("RUNTIME_UNAVAILABLE", "Slack channel invitation has no safe retry");
      }
      if (stored.invitationStatus !== "ACCEPTED") {
        stored = (await read(deps, taskId, input.requestId)) ?? stored;
        if (stored.invitationStatus !== "CLAIMED" || stored.invitationTeamId !== input.teamId
          || stored.invitationChannelId !== input.channelId || stored.invitationSlackUserId !== input.slackUserId
          || stored.invitationUpdatedAt === undefined || stored.targetDeveloperId === undefined || stored.personId === undefined || stored.role !== "owner") {
          throw agentXError("RUNTIME_UNAVAILABLE", "Slack channel invitation claim could not be verified");
        }
        const claimFields: TaskPersonInviteClaimFields = {
          taskId: stored.taskId, requestId: stored.requestId, callerDeveloperId: stored.callerDeveloperId,
          targetDeveloperId: stored.targetDeveloperId, personId: stored.personId, role: "owner",
          expectedPeopleRevision: stored.expectedPeopleRevision, payloadDigest: stored.payloadDigest, expiresAt: stored.expiresAt,
          invitationTeamId: stored.invitationTeamId, invitationChannelId: stored.invitationChannelId,
          invitationSlackUserId: stored.invitationSlackUserId, invitationUpdatedAt: stored.invitationUpdatedAt,
        };
        const claimDigest = taskPersonInviteClaimDigest(claimFields);
        const startedAt = deps.now();
        const inviteRequest = TaskPersonInviteClaimRequestSchema.parse({
          kind: "task-person-invite-claimed", taskId, requestId: input.requestId, claimDigest,
          admission: { version: 1, id: randomUUID(), deadlineAt: startedAt + 12_000, remainingMs: 12_000,
            authorityRemainingMs: 6_000, slackCallsLimit: 100, stateReadsLimit: 128 },
        });
        let rawOutcome: TaskPersonInviteOutcome;
        try { rawOutcome = await deps.inviteTaskPerson(inviteRequest); }
        catch {
          rawOutcome = { taskId, requestId: input.requestId, claimDigest, admissionId: inviteRequest.admission.id,
            status: "unknown", reason: "transport_unknown" };
        }
        const parsedOutcome = TaskPersonInviteOutcomeSchema.safeParse(rawOutcome);
        const outcome = parsedOutcome.success && parsedOutcome.data.taskId === taskId && parsedOutcome.data.requestId === input.requestId
          && parsedOutcome.data.claimDigest === claimDigest && parsedOutcome.data.admissionId === inviteRequest.admission.id
          ? parsedOutcome.data
          : { taskId, requestId: input.requestId, claimDigest, admissionId: inviteRequest.admission.id,
            status: "unknown" as const, reason: "effect_unknown" as const };
        const status = outcome.status === "accepted" ? "ACCEPTED" : outcome.status === "failed" ? "FAILED" : "UNKNOWN";
        try { await invitationState(deps, stored, status, "CLAIMED", undefined, outcome.executionReceiptId); }
        catch { throw agentXError("RUNTIME_UNAVAILABLE", "Slack channel invitation outcome could not be recorded safely"); }
        if (outcome.status === "unknown") throw agentXError("RUNTIME_UNAVAILABLE", "Slack could not confirm whether the channel invitation succeeded");
        if (outcome.status === "failed") throw agentXError("RUNTIME_UNAVAILABLE", "Slack channel invitation was refused before it began");
      }
    }
    target = await deps.resolveTaskPickerPerson(taskId, input.slackUserId);
    if (!target.channelMember) throw agentXError("CHANGE_STALE", "Slack accepted the invitation, but task access changed before the role could be saved");
  }
  const current = await getTaskPeopleCapabilities(deps, caller, taskId);
  if (!current.canManagePeople || current.peopleRevision !== input.expectedPeopleRevision) {
    throw agentXError("CHANGE_STALE", "Task access changed before the role could be saved");
  }
  return confirmTaskPeopleProposal(deps, caller, taskId, input.requestId);
}

/** A signed Slack takeover submit creates and confirms the same bound proposal used by page/MCP. */
export async function submitSlackTaskOwnership(
  deps: TaskPeopleEffectsDependencies,
  caller: DeveloperCaller,
  taskId: string,
  input: TaskPeopleTakeOwnershipRequest,
): Promise<TaskPeopleChangeResult> {
  const proposed = await proposeTaskOwnership(deps, caller, taskId, input);
  if (proposed.status !== "PENDING") return proposed;
  return confirmTaskPeopleProposal(deps, caller, taskId, input.requestId);
}
