import { randomUUID } from "node:crypto";
import {
  TaskPersonInviteClaimRequestSchema,
  TaskPersonInviteExecutionReceiptSchema,
  TaskPersonInviteOutcomeSchema,
  SlackTeamIdSchema,
  SlackChannelIdSchema,
  SlackUserIdSchema,
  WorkflowStageSchema,
  WorkflowStateSchema,
  agentXError,
  type TaskPersonInviteClaimRequest,
  type TaskPersonInviteExecutionReceipt,
  type TaskPersonInviteOutcome,
} from "@agentx/contracts";
import type { TaskAuthorityAdmission } from "./task-authority-admission.js";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import type { TaskPersonCheck } from "../developer/task-people.js";
import { taskPersonInviteClaimDigest, type TaskPersonInviteClaimFields } from "../developer/task-people-effects.js";

const unavailable = () => agentXError("SLACK_UNAVAILABLE", "task channel invitation is unavailable");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX64 = /^[a-f0-9]{64}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export interface TaskPersonInviteHandlerPorts {
  now(): number;
  remainingTimeMs(): number;
  expectedTeamId: string;
  stateTableName: string;
  /** Exact strongly consistent task-partition read; sort keys are chosen and bounded by the handler. */
  readState(input: { taskId: string; sortKey: string; consistentRead: true; abortSignal: AbortSignal }): Promise<Record<string, unknown> | undefined>;
  /** Builds the normal fresh Task Person identity/project checker on this admission; no legacy fallback. */
  createPersonChecker(admission: TaskAuthorityAdmission): (task: DeveloperTaskRecord, developerId: string) => Promise<TaskPersonCheck>;
  /** Fresh Slack channel type/member read. Usage counts against the same admission as identity proof. */
  readChannelInfo(input: { teamId: string; channelId: string; slackCallsLimit: number; deadlineAt: number; abortSignal: AbortSignal }): Promise<{ isPrivate: boolean; botIsMember: boolean; slackCallsUsed: number }>;
  /** Storage-neutral conditional create in a separately retained attempts store. It must condition on the supplied State snapshot; it cannot write State. */
  beginReceipt(input: {
    receipt: TaskPersonInviteExecutionReceipt;
    stateFence: { task: DeveloperTaskRecord; people: People; proposal: Proposal };
    abortSignal: AbortSignal;
  }): Promise<{ kind: "created" } | { kind: "existing"; receipt: unknown } | { kind: "conflict" }>;
  /** Conditional update of the same attempts-store receipt from STARTED only. */
  finishReceipt(input: {
    executionReceiptId: string;
    claimDigest: string;
    status: "ACCEPTED" | "FAILED" | "UNKNOWN";
    reason?: TaskPersonInviteExecutionReceipt["reason"];
    abortSignal: AbortSignal;
  }): Promise<boolean>;
  /** One target only. The adapter must issue at most one conversations.invite with no force flag. */
  invite(input: { teamId: string; channelId: string; slackUserId: string; abortSignal: AbortSignal }): Promise<
    { kind: "accepted" } | { kind: "already_in_channel" } | { kind: "definite_rejection"; reason: "scope_unavailable" | "effect_rejected" }
  >;
  /** Fresh membership read for Slack's already_in_channel response. */
  targetIsMember(input: { teamId: string; channelId: string; slackUserId: string; slackCallsLimit: number; deadlineAt: number; abortSignal: AbortSignal }): Promise<{ isMember: boolean; slackCallsUsed: number }>;
  configuration: {
    peopleChangesEnabled: boolean;
    publicInvitationsEnabled: boolean;
    privateInvitationsEnabled: boolean;
    publicInviteCapability?: boolean;
    privateInviteCapability?: boolean;
  };
}

type Proposal = Record<string, unknown> & TaskPersonInviteClaimFields & {
  pk: string; sk: string; entityType: "TASK_PEOPLE_PROPOSAL"; schemaVersion: 1; invitationStatus: "CLAIMED";
};
type People = { pk: string; sk: "PEOPLE"; schemaVersion: 1; revision: number; orphaned: boolean; people: Array<{ developerId: string; slackUserId: string; role: string }> };

function resultFor(request: TaskPersonInviteClaimRequest, status: TaskPersonInviteOutcome["status"], values: {
  receiptId?: string; reason?: TaskPersonInviteOutcome["reason"];
} = {}): TaskPersonInviteOutcome {
  return TaskPersonInviteOutcomeSchema.parse({ taskId: request.taskId, requestId: request.requestId, claimDigest: request.claimDigest,
    admissionId: request.admission.id, status, ...(values.receiptId === undefined ? {} : { executionReceiptId: values.receiptId }),
    ...(values.reason === undefined ? {} : { reason: values.reason }) });
}

function exactIdentityRow(row: Record<string, unknown> | undefined, taskId: string, developerId: string): boolean {
  return row !== undefined && row.pk === `DEVTASK#${taskId}` && row.sk === `PERSON_SUBJECT#${developerId}`
    && Object.keys(row).sort().join(",") === "createdAt,developerId,personId,pk,schemaVersion,sk"
    && row.schemaVersion === 1 && row.developerId === developerId && typeof row.personId === "string" && UUID.test(row.personId)
    && typeof row.createdAt === "string" && Number.isFinite(Date.parse(row.createdAt));
}

function validRegistry(row: Record<string, unknown> | undefined, taskId: string, personId: string, developerId: string): boolean {
  return row !== undefined && row.pk === `DEVTASK#${taskId}` && row.sk === `PERSON#${personId}`
    && Object.keys(row).sort().join(",") === "createdAt,developerId,issuer,method,name,personId,pk,schemaVersion,sk,slackUserId,subject"
    && row.schemaVersion === 1 && row.personId === personId && row.developerId === developerId
    && SlackUserIdSchema.safeParse(row.slackUserId).success
    && (row.method === "slack" || row.method === "oidc") && typeof row.issuer === "string" && row.issuer.length > 0
    && typeof row.subject === "string" && row.subject.length > 0 && typeof row.name === "string"
    && typeof row.createdAt === "string" && Number.isFinite(Date.parse(row.createdAt));
}

function validTask(row: Record<string, unknown> | undefined, taskId: string): row is Record<string, unknown> & DeveloperTaskRecord {
  return row !== undefined && row.pk === `DEVTASK#${taskId}` && row.sk === "META" && row.entityType === "DEVELOPER_TASK"
    && row.taskId === taskId && HEX64.test(String(row.developerId)) && typeof row.project === "string" && row.project.length > 0
    && row.closedAt === undefined && isRecord(row.workflow) && Number.isSafeInteger(row.workflow.revision)
    && WorkflowStageSchema.safeParse(row.workflow.stage).success && row.workflow.stage !== "CLOSED" && row.workflow.stage !== "MERGED"
    && WorkflowStateSchema.safeParse(row.workflow.state).success && row.workflow.state !== "COMPLETE"
    && isRecord(row.share) && SlackTeamIdSchema.safeParse(row.share.teamId).success
    && SlackChannelIdSchema.safeParse(row.share.channelId).success && typeof row.share.threadTs === "string";
}

function validPeople(row: Record<string, unknown> | undefined, taskId: string): row is Record<string, unknown> & People {
  if (row === undefined || row.pk !== `DEVTASK#${taskId}` || row.sk !== "PEOPLE" || row.schemaVersion !== 1
    || Object.keys(row).sort().join(",") !== "orphaned,people,pk,revision,schemaVersion,sk"
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || typeof row.orphaned !== "boolean" || !Array.isArray(row.people)) return false;
  const seen = new Set<string>();
  return row.people.every((item) => isRecord(item) && Object.keys(item).sort().join(",") === "developerId,name,role,slackUserId"
    && HEX64.test(String(item.developerId)) && SlackUserIdSchema.safeParse(item.slackUserId).success
    && typeof item.name === "string" && ["owner", "commenter", "viewer", "denied"].includes(String(item.role))
    && !seen.has(String(item.developerId)) && Boolean(seen.add(String(item.developerId))));
}

function validProposal(row: Record<string, unknown> | undefined, taskId: string, requestId: string): row is Proposal {
  return row !== undefined && row.pk === `DEVTASK#${taskId}` && row.sk === `PEOPLE_PROPOSAL#${requestId}`
    && row.entityType === "TASK_PEOPLE_PROPOSAL" && row.schemaVersion === 1 && row.kind === "role"
    && row.requestId === requestId && row.taskId === taskId && row.role === "owner" && row.invitationStatus === "CLAIMED"
    && HEX64.test(String(row.callerDeveloperId)) && HEX64.test(String(row.targetDeveloperId)) && UUID.test(String(row.personId))
    && Number.isSafeInteger(row.expectedPeopleRevision) && HEX64.test(String(row.payloadDigest))
    && typeof row.expiresAt === "string" && Number.isFinite(Date.parse(row.expiresAt))
    && typeof row.invitationTeamId === "string" && typeof row.invitationChannelId === "string"
    && typeof row.invitationSlackUserId === "string" && typeof row.invitationUpdatedAt === "string"
    && Number.isFinite(Date.parse(row.invitationUpdatedAt));
}

function samePrincipal(check: TaskPersonCheck, registry: Record<string, unknown>, developerId: string): boolean {
  return check.identity.developerId === developerId && check.subject.developerId === developerId
    && check.subject.slackUserId === registry.slackUserId && check.identity.slackUserId === registry.slackUserId && check.identity.method === registry.method
    && check.identity.issuer === registry.issuer && check.identity.subject === registry.subject;
}

/** Dedicated claim validator/effect endpoint. It has no State mutation port and never retries Slack. */
export function createTaskPersonInviteHandler(ports: TaskPersonInviteHandlerPorts) {
  return async (event: unknown): Promise<TaskPersonInviteOutcome> => {
    const parsed = TaskPersonInviteClaimRequestSchema.safeParse(event);
    if (!parsed.success || !SlackTeamIdSchema.safeParse(ports.expectedTeamId).success) throw unavailable();
    const request = parsed.data;
    const started = ports.now();
    const totalDeadline = Math.min(request.admission.deadlineAt, started + request.admission.remainingMs,
      started + Math.max(0, ports.remainingTimeMs() - 1_000));
    const authorityDeadline = Math.min(totalDeadline - 6_000, started + request.admission.authorityRemainingMs);
    if (totalDeadline <= started || authorityDeadline <= started) return resultFor(request, "failed", { reason: "authorization_refused" });

    let stateReads = Math.min(request.admission.stateReadsLimit, 128);
    let slackCalls = Math.min(request.admission.slackCallsLimit, 100);
    const identities = new Set<string>();
    let closed = false;
    const assertAuthorityOpen = () => {
      if (closed || ports.now() >= authorityDeadline) { closed = true; throw unavailable(); }
    };
    const authority: TaskAuthorityAdmission = {
      id: request.admission.id,
      deadlineAt: authorityDeadline,
      assertOpen: assertAuthorityOpen,
      remainingMs: () => Math.max(0, authorityDeadline - ports.now()),
      admitStateRead() {
        assertAuthorityOpen();
        if (stateReads <= 0) { closed = true; throw unavailable(); }
        stateReads -= 1;
        return AbortSignal.timeout(Math.max(1, authorityDeadline - ports.now()));
      },
      remainingStateReads: () => stateReads,
      admitIdentity(developerId) {
        assertAuthorityOpen();
        if (!HEX64.test(developerId)) { closed = true; throw unavailable(); }
        identities.add(developerId);
        if (identities.size > 100) { closed = true; throw unavailable(); }
      },
      checkedIdentityCount: () => identities.size,
      remainingSlackCalls: () => slackCalls,
      recordSlackUsage(calls) {
        assertAuthorityOpen();
        if (!Number.isSafeInteger(calls) || calls < 0 || calls > slackCalls) { closed = true; throw unavailable(); }
        slackCalls -= calls;
      },
      close() { closed = true; },
    };
    const read = async (sortKey: string): Promise<Record<string, unknown> | undefined> => {
      const abortSignal = authority.admitStateRead();
      const row = await ports.readState({ taskId: request.taskId, sortKey, consistentRead: true, abortSignal });
      authority.assertOpen();
      return row;
    };

    let task: DeveloperTaskRecord;
    let people: People;
    let proposal: Proposal;
    let actorRegistry: Record<string, unknown>;
    let targetRegistry: Record<string, unknown>;
    let actorSubject: Record<string, unknown>;
    let targetSubject: Record<string, unknown>;
    let targetCheck: TaskPersonCheck;
    let channelIsPrivate: boolean;
    try {
      const rawTask = await read("META");
      const rawProposal = await read(`PEOPLE_PROPOSAL#${request.requestId}`);
      const rawPeople = await read("PEOPLE");
      if (!validTask(rawTask, request.taskId) || !validProposal(rawProposal, request.taskId, request.requestId)
        || !validPeople(rawPeople, request.taskId)) return resultFor(request, "failed", { reason: "claim_refused" });
      task = rawTask;
      proposal = rawProposal;
      people = rawPeople;
      if (ports.now() >= Date.parse(proposal.expiresAt) || proposal.callerDeveloperId.length === 0
        || proposal.expectedPeopleRevision !== people.revision || task.share?.teamId !== proposal.invitationTeamId
        || task.share?.channelId !== proposal.invitationChannelId || proposal.invitationTeamId !== ports.expectedTeamId
        || !SlackChannelIdSchema.safeParse(proposal.invitationChannelId).success
        || !SlackUserIdSchema.safeParse(proposal.invitationSlackUserId).success) return resultFor(request, "failed", { reason: "claim_refused" });
      const digest = taskPersonInviteClaimDigest({
        taskId: proposal.taskId, requestId: proposal.requestId, callerDeveloperId: proposal.callerDeveloperId,
        targetDeveloperId: proposal.targetDeveloperId, personId: proposal.personId, role: "owner",
        expectedPeopleRevision: proposal.expectedPeopleRevision, payloadDigest: proposal.payloadDigest, expiresAt: proposal.expiresAt,
        invitationTeamId: proposal.invitationTeamId, invitationChannelId: proposal.invitationChannelId,
        invitationSlackUserId: proposal.invitationSlackUserId, invitationUpdatedAt: proposal.invitationUpdatedAt,
      });
      if (digest !== request.claimDigest) return resultFor(request, "failed", { reason: "claim_refused" });

      const actorPeople = people.people.find((entry) => entry.developerId === proposal.callerDeveloperId);
      if (people.orphaned || actorPeople?.role !== "owner") return resultFor(request, "failed", { reason: "authorization_refused" });
      actorSubject = (await read(`PERSON_SUBJECT#${proposal.callerDeveloperId}`)) ?? {};
      targetSubject = (await read(`PERSON_SUBJECT#${proposal.targetDeveloperId}`)) ?? {};
      if (!exactIdentityRow(actorSubject, request.taskId, proposal.callerDeveloperId)
        || !exactIdentityRow(targetSubject, request.taskId, proposal.targetDeveloperId)
        || targetSubject.personId !== proposal.personId) return resultFor(request, "failed", { reason: "authorization_refused" });
      actorRegistry = (await read(`PERSON#${String(actorSubject.personId)}`)) ?? {};
      targetRegistry = (await read(`PERSON#${String(targetSubject.personId)}`)) ?? {};
      if (!validRegistry(actorRegistry, request.taskId, String(actorSubject.personId), proposal.callerDeveloperId)
        || !validRegistry(targetRegistry, request.taskId, String(targetSubject.personId), proposal.targetDeveloperId)
        || actorPeople.slackUserId !== actorRegistry.slackUserId || proposal.invitationSlackUserId !== targetRegistry.slackUserId) {
        return resultFor(request, "failed", { reason: "authorization_refused" });
      }
      const checker = ports.createPersonChecker(authority);
      const actorCheck = await checker(task, proposal.callerDeveloperId);
      authority.assertOpen();
      if (!actorCheck.eligible || !actorCheck.channelMember || !samePrincipal(actorCheck, actorRegistry, proposal.callerDeveloperId)) {
        return resultFor(request, "failed", { reason: "authorization_refused" });
      }
      targetCheck = await checker(task, proposal.targetDeveloperId);
      authority.assertOpen();
      if (!targetCheck.eligible || !samePrincipal(targetCheck, targetRegistry, proposal.targetDeveloperId)) {
        return resultFor(request, "failed", { reason: "authorization_refused" });
      }
      const channelCallsLimit = slackCalls;
      if (channelCallsLimit <= 0) {
        authority.close();
        return resultFor(request, "failed", { reason: "capability_refused" });
      }
      const channel = await ports.readChannelInfo({ teamId: proposal.invitationTeamId, channelId: proposal.invitationChannelId,
        slackCallsLimit: channelCallsLimit, deadlineAt: authorityDeadline,
        abortSignal: AbortSignal.timeout(Math.max(1, authority.remainingMs())) });
      if (typeof channel.isPrivate !== "boolean" || typeof channel.botIsMember !== "boolean"
        || !Number.isSafeInteger(channel.slackCallsUsed) || channel.slackCallsUsed !== 1 || channel.slackCallsUsed > channelCallsLimit) throw unavailable();
      authority.recordSlackUsage(channel.slackCallsUsed);
      authority.assertOpen();
      channelIsPrivate = channel.isPrivate;
      if (!channel.botIsMember) return resultFor(request, "failed", { reason: "capability_refused" });
      const publicAllowed = !channel.isPrivate && ports.configuration.publicInvitationsEnabled === true && ports.configuration.publicInviteCapability === true;
      const privateAllowed = channel.isPrivate && ports.configuration.privateInvitationsEnabled === true && ports.configuration.privateInviteCapability === true;
      if (ports.configuration.peopleChangesEnabled !== true || (!publicAllowed && !privateAllowed)) {
        return resultFor(request, "failed", { reason: "capability_refused" });
      }
    } catch {
      authority.close();
      return resultFor(request, "failed", { reason: "authorization_refused" });
    }

    authority.close();
    const effectDeadline = Math.min(totalDeadline - 1_000, ports.now() + 5_000);
    if (effectDeadline - ports.now() < 1_000 || ports.configuration.peopleChangesEnabled !== true || slackCalls <= 0) {
      return resultFor(request, "failed", { reason: "capability_refused" });
    }
    const receiptId = randomUUID();
    const timestamp = new Date(ports.now()).toISOString();
    const proposedReceipt = TaskPersonInviteExecutionReceiptSchema.parse({
      pk: `TASK_INVITE#${request.taskId}#${request.requestId}`, sk: "META", entityType: "TASK_PERSON_INVITE_EXECUTION",
      executionReceiptId: receiptId, taskId: request.taskId, requestId: request.requestId, claimDigest: request.claimDigest,
      actorDeveloperId: proposal.callerDeveloperId, targetDeveloperId: proposal.targetDeveloperId,
      teamId: proposal.invitationTeamId, channelId: proposal.invitationChannelId, slackUserId: proposal.invitationSlackUserId,
      admissionId: request.admission.id, attempt: 1, status: "STARTED", startedAt: timestamp, updatedAt: timestamp,
    });
    const effectSignal = () => AbortSignal.timeout(Math.max(1, effectDeadline - ports.now()));
    let begin: Awaited<ReturnType<TaskPersonInviteHandlerPorts["beginReceipt"]>>;
    try {
      begin = await ports.beginReceipt({ receipt: proposedReceipt, stateFence: { task, people, proposal }, abortSignal: effectSignal() });
    } catch {
      return resultFor(request, "unknown", { reason: "receipt_conflict" });
    }
    if (!isRecord(begin) || !(begin.kind === "created" || begin.kind === "existing" || begin.kind === "conflict")) {
      return resultFor(request, "unknown", { reason: "receipt_conflict" });
    }
    const persistenceSignal = () => AbortSignal.timeout(Math.max(1, totalDeadline - ports.now()));
    const finish = async (status: "ACCEPTED" | "FAILED" | "UNKNOWN", reason?: TaskPersonInviteOutcome["reason"]): Promise<boolean> => {
      if (ports.now() >= totalDeadline) return false;
      try {
        const saved = await ports.finishReceipt({ executionReceiptId: receiptId, claimDigest: request.claimDigest, status,
          ...(reason === undefined ? {} : { reason }), abortSignal: persistenceSignal() });
        return saved && ports.now() < totalDeadline;
      } catch { return false; }
    };
    if (begin.kind === "conflict") return resultFor(request, "failed", { reason: "receipt_conflict" });
    if (begin.kind === "existing") {
      const existing = TaskPersonInviteExecutionReceiptSchema.safeParse(begin.receipt);
      if (!existing.success || existing.data.claimDigest !== request.claimDigest || existing.data.taskId !== request.taskId
        || existing.data.pk !== `TASK_INVITE#${request.taskId}#${request.requestId}` || existing.data.sk !== "META"
        || existing.data.requestId !== request.requestId || existing.data.actorDeveloperId !== proposal.callerDeveloperId
        || existing.data.targetDeveloperId !== proposal.targetDeveloperId || existing.data.teamId !== proposal.invitationTeamId
        || existing.data.channelId !== proposal.invitationChannelId || existing.data.slackUserId !== proposal.invitationSlackUserId) {
        return resultFor(request, "failed", { reason: "receipt_conflict" });
      }
      if (existing.data.status === "ACCEPTED") {
        if (ports.now() >= authorityDeadline || ports.now() >= totalDeadline) {
          return resultFor(request, "unknown", { receiptId: existing.data.executionReceiptId, reason: "authorization_refused" });
        }
        return resultFor(request, "accepted", { receiptId: existing.data.executionReceiptId });
      }
      if (existing.data.status === "FAILED") return resultFor(request, "failed", { receiptId: existing.data.executionReceiptId, reason: existing.data.reason ?? "effect_rejected" });
      return resultFor(request, "unknown", { receiptId: existing.data.executionReceiptId, reason: "effect_unknown" });
    }
    if (ports.now() >= authorityDeadline) {
      const saved = await finish("FAILED", "authorization_refused");
      return saved ? resultFor(request, "failed", { receiptId, reason: "authorization_refused" })
        : resultFor(request, "unknown", { receiptId, reason: "effect_unknown" });
    }
    const inviteClassStillEnabled = channelIsPrivate
      ? ports.configuration.privateInvitationsEnabled === true && ports.configuration.privateInviteCapability === true
      : ports.configuration.publicInvitationsEnabled === true && ports.configuration.publicInviteCapability === true;
    if (ports.configuration.peopleChangesEnabled !== true || !inviteClassStillEnabled
      || ports.now() >= effectDeadline || ports.remainingTimeMs() <= 1_000) {
      const saved = await finish("FAILED", "capability_refused");
      return saved ? resultFor(request, "failed", { receiptId, reason: "capability_refused" })
        : resultFor(request, "unknown", { receiptId, reason: "effect_unknown" });
    }
    slackCalls -= 1;
    let effect: Awaited<ReturnType<TaskPersonInviteHandlerPorts["invite"]>>;
    try {
      effect = await ports.invite({ teamId: proposal.invitationTeamId, channelId: proposal.invitationChannelId,
        slackUserId: proposal.invitationSlackUserId, abortSignal: effectSignal() });
    } catch {
      await finish("UNKNOWN", "effect_unknown");
      return resultFor(request, "unknown", { receiptId, reason: "effect_unknown" });
    }
    if (ports.now() >= effectDeadline || ports.now() >= totalDeadline) {
      await finish("UNKNOWN", "effect_unknown");
      return resultFor(request, "unknown", { receiptId, reason: "effect_unknown" });
    }
    if (!isRecord(effect) || !(effect.kind === "accepted" || effect.kind === "already_in_channel"
      || (effect.kind === "definite_rejection" && (effect.reason === "scope_unavailable" || effect.reason === "effect_rejected")))) {
      await finish("UNKNOWN", "effect_unknown");
      return resultFor(request, "unknown", { receiptId, reason: "effect_unknown" });
    }
    if (effect.kind === "definite_rejection") {
      const saved = await finish("FAILED", effect.reason);
      return saved ? resultFor(request, "failed", { receiptId, reason: effect.reason })
        : resultFor(request, "unknown", { receiptId, reason: "effect_unknown" });
    }
    if (effect.kind === "already_in_channel") {
      if (slackCalls <= 0) {
        await finish("UNKNOWN", "effect_unknown");
        return resultFor(request, "unknown", { receiptId, reason: "effect_unknown" });
      }
      try {
        const member = await ports.targetIsMember({ teamId: proposal.invitationTeamId, channelId: proposal.invitationChannelId,
          slackUserId: proposal.invitationSlackUserId, slackCallsLimit: slackCalls, deadlineAt: effectDeadline, abortSignal: effectSignal() });
        if (ports.now() < effectDeadline && ports.now() < totalDeadline && typeof member.isMember === "boolean"
          && Number.isSafeInteger(member.slackCallsUsed) && member.slackCallsUsed > 0 && member.slackCallsUsed <= slackCalls && member.isMember) {
          slackCalls -= member.slackCallsUsed;
          const saved = await finish("ACCEPTED");
          return saved ? resultFor(request, "accepted", { receiptId }) : resultFor(request, "unknown", { receiptId, reason: "effect_unknown" });
        }
      } catch { /* the invite effect may already have happened; preserve uncertainty */ }
      await finish("UNKNOWN", "effect_unknown");
      return resultFor(request, "unknown", { receiptId, reason: "effect_unknown" });
    }
    const saved = await finish("ACCEPTED");
    return saved ? resultFor(request, "accepted", { receiptId }) : resultFor(request, "unknown", { receiptId, reason: "effect_unknown" });
  };
}
