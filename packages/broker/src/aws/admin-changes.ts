// packages/broker/src/aws/admin-changes.ts
// Spec 025 FR-039 to FR-041, FR-051, FR-052: admin changes. A change is planned and stored with
// its audit record; it applies at most once, only after a confirmation by an offered method, and
// only while the state it was planned against still holds. Every step writes its audit step in the
// same transaction as the change's own state, and one log line with the change and trace IDs.
// Log lines carry event names, change IDs, trace IDs, kinds, outcomes and error codes only: never
// the input, the effect, a token or an error's own text.
import { randomUUID } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  ADMIN_CHANGE_APPLYING_STALE_MS, ADMIN_CHANGE_EFFECT_MAX, ADMIN_LIST_MAX, ADMIN_CHANGE_TTL_MS, AdminChangeOutcomeSchema, AdminChangePendingRecordSchema, AgentXError, AgentXErrorCodeSchema,
  ApplyAdminChangeRequestSchema, DeclineAdminChangeRequestSchema, INDEX_EXPIRY_ATTRIBUTE, ProposeAdminChangeRequestSchema, SlackUserIdSchema,
  adminChangeItemExpiresAt, adminChangeKey, adminChangeRequestKey, agentXError, outcomeOfStatus, redactSecrets, redactText,
  type AdminChangeAuditRecord, type AdminChangePressEvent, type AdminChangeStatus, type AdminChangeView, type AdminMeResponse, type ConfirmationMethod,
  type PendingChange, type RefusedAttemptReason,
} from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../auth.js";
import { auditStepItem, listAudit, logChangeStep, proposalItem, readAudit, recordRefusedAttempt, writeProposal, type AuditStep, type AuditStore, type TransactItem } from "./admin-change-audit.js";
import { planChange, stateHash, type ChangePlan, type PlanDependencies } from "./admin-change-plans.js";
import { listLimitParam, validTime } from "./turns.js";

export interface AdminChangeDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  audit: AuditStore;
  plans: PlanDependencies;
  /** 25d's A12 reader: the admin's display name and linked Slack user (B4). */
  identity?: {
    profile(identity: AuthenticatedIdentity, authorization: string | undefined): Promise<{ name?: string; email?: string }>;
    me(identity: AuthenticatedIdentity, authorization: string | undefined): Promise<AdminMeResponse>;
  };
  slackTeamId?: string;
  /** E16, FR-041: the methods this environment allows. */
  confirm: { elicitation: boolean; slack: boolean };
  now: () => number;
  newId: () => string;
  log: (entry: Record<string, unknown>) => void;
}
export type { PendingChange } from "@agentx/contracts";
/** `unavailable`: nothing applied and the change is still pending, so the admin may press again. */
export type PressOutcome = "applied" | "declined" | "refused" | "expired" | "not_pending" | "stale" | "failed" | "unavailable" | "not_found";
type Answer = { status: number; body: unknown };
/** How a confirmation arrived: the method, the Slack presser, and the client's own times. */
type Confirmation = { method: ConfirmationMethod; pressedBy?: string; requestedAt?: string; answeredAt?: string };

const iso = (ms: number) => new Date(ms).toISOString();
const TRACE = /^[A-Za-z0-9._-]{1,128}$/;
const CHANGE_PATH = /^\/v1\/admin\/changes\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(slack|apply|decline))?$/;
const LIST_DEFAULT_DAYS = 7;
const LIST_DEFAULT_LIMIT = 25;
const SETTLE_PAGES_MAX = 10;
const ERROR_MESSAGE_MAX = 1_000;
const NOT_APPLIED = "the change could not be applied; check the state, then ask again";
const APPLY_UNFINISHED = "the apply did not finish; check the state, then ask again";
const NOT_PLANNED = "the change could not be planned; try again";
/** A planner's refusal that says nothing about the state: Slack or AWS could not be reached. */
const TRANSIENT = new Set<string>(["SLACK_UNAVAILABLE", "RUNTIME_UNAVAILABLE"]);
/** How each method is named in a refusal's "what to do next". */
const METHOD_NAMES: Record<ConfirmationMethod, { confirm: string; decline: string }> = {
  elicitation: { confirm: "the pop-up", decline: "the pop-up" },
  cli: { confirm: "the CLI prompt", decline: "the CLI prompt" },
  slack: { confirm: "the Slack Confirm button", decline: "the Slack Cancel button" },
};
const methodsNamed = (methods: readonly ConfirmationMethod[], as: "confirm" | "decline") => methods.map((method) => METHOD_NAMES[method][as]).join(" or ");
/** Nothing applied and the change is still pending: the admin may confirm again (never CHANGE_STALE). */
const tryAgain = (changeId: string, what: string) => agentXError("RUNTIME_UNAVAILABLE", `change ${changeId} could not be ${what} just now; try again`);
/** The pending item's own fields a step may set: the stored record is strict (E2), so only these. */
type PendingFields = Partial<Pick<PendingChange, "claimedAt" | "methodUsed" | "pressedBy" | "result" | "error">>;

const stripCode = (message: string, code: string) => (message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message);
const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);
/** A handler's refusal keeps its own code and (redacted) words; anything else is named by nothing but a code. */
const errorOf = (error: unknown, fallback = NOT_APPLIED): { code: string; message: string } => (error instanceof AgentXError
  ? { code: error.code, message: cap(redactText(stripCode(error.message, error.code)), ERROR_MESSAGE_MAX) }
  : { code: "RUNTIME_UNAVAILABLE", message: fallback });
const errorName = (error: unknown) => (error instanceof AgentXError ? error.code : error instanceof Error ? error.name.slice(0, 128) : "unknown");
const conditional = (error: unknown) => error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");
const expiredAt = (deps: AdminChangeDependencies, change: PendingChange) => deps.now() >= Date.parse(change.expiresAt);
const isPlanner = (change: PendingChange, identity: AuthenticatedIdentity) => change.admin.issuer === identity.issuer && change.admin.subject === identity.subject;
const traced = (change: PendingChange) => ({ changeId: change.changeId, traceId: change.traceId, kind: change.kind });

/**
 * E4, R4: what a change looks like to a reader. The member planning admin reads the effect that
 * names a private channel; everyone else reads the ID-only effect the audit keeps. A pending
 * change past its 10 minutes reads as expired even before it is recorded so (E3).
 */
function viewOf(deps: AdminChangeDependencies, change: PendingChange, forPlanner: boolean): AdminChangeView {
  const status: AdminChangeStatus = change.status === "pending" && expiredAt(deps, change) ? "expired" : change.status;
  return {
    changeId: change.changeId, kind: change.kind, status,
    effect: forPlanner && change.confirmationEffect !== undefined ? change.confirmationEffect : change.effect,
    methodsOffered: change.methodsOffered, createdAt: change.createdAt, expiresAt: change.expiresAt,
    ...(change.methodUsed === undefined ? {} : { methodUsed: change.methodUsed }),
    ...(change.result === undefined ? {} : { result: change.result }),
    ...(change.error === undefined ? {} : { error: change.error }),
  };
}

/** One TransactWriteItems call; the items are typed, so the compiler checks each one's shape. */
async function transact(deps: AdminChangeDependencies, items: TransactItem[]): Promise<void> {
  await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
}

async function getPending(deps: AdminChangeDependencies, changeId: string): Promise<PendingChange | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: adminChangeKey(changeId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  if (response.Item === undefined) return undefined;
  const parsed = AdminChangePendingRecordSchema.safeParse(response.Item);
  if (!parsed.success) {
    deps.log({ event: "admin_change.unreadable", changeId });
    throw agentXError("RUNTIME_UNAVAILABLE", `change ${changeId} could not be read; ask for the change again`);
  }
  return parsed.data;
}

async function refuseAttempt(deps: AdminChangeDependencies, changeId: string, reason: RefusedAttemptReason, slackUserId?: string): Promise<void> {
  await recordRefusedAttempt(deps.audit, changeId, { at: iso(deps.now()), reason, ...(slackUserId === undefined ? {} : { slackUserId }) });
}

/**
 * Moves the change from `from` to `to` and steps its audit record, in one transaction; false when
 * either had moved on (the change's status, or an audit record that already has its outcome).
 * The outcome metric is counted here, after the commit, because a transaction's step emits none.
 */
async function transition(deps: AdminChangeDependencies, change: PendingChange, from: AdminChangeStatus, to: AdminChangeStatus, step: AuditStep, fields: PendingFields = {}): Promise<boolean> {
  const names: Record<string, string> = { "#status": "status" };
  const values: Record<string, unknown> = { ":to": to, ":from": from };
  const assignments = ["#status = :to", ...Object.entries(fields).filter(([, value]) => value !== undefined).map(([name, value], index) => {
    names[`#g${index}`] = name;
    values[`:g${index}`] = value;
    return `#g${index} = :g${index}`;
  })];
  try {
    await transact(deps, [
      { Update: { TableName: deps.tableName, Key: adminChangeKey(change.changeId), UpdateExpression: `SET ${assignments.join(", ")}`, ConditionExpression: "#status = :from", ExpressionAttributeNames: names, ExpressionAttributeValues: values } },
      auditStepItem(deps.audit.tableName, change.changeId, { ...step, status: to }),
    ]);
  } catch (error) {
    if (conditional(error)) return false;
    throw error;
  }
  const outcome = outcomeOfStatus(to);
  if (outcome !== undefined) deps.audit.metric(outcome);
  return true;
}

/** E3, E5: a pending change past its 10 minutes is expired, and one stuck applying is failed, when touched. */
async function settle(deps: AdminChangeDependencies, change: PendingChange): Promise<PendingChange> {
  const now = deps.now();
  if (change.status === "pending" && now >= Date.parse(change.expiresAt)) {
    if (await transition(deps, change, "pending", "expired", { expiredAt: iso(now) })) {
      logChangeStep(deps.log, "expired", { ...traced(change), outcome: "expired" });
      return { ...change, status: "expired" };
    }
    return (await getPending(deps, change.changeId)) ?? change;
  }
  // E5: the broker Lambda's timeout (30 seconds, packagedFunction's default) is well below these 2
  // minutes, so an apply still running when a read marks it failed cannot happen in practice; if
  // it ever did, applyOnce logs admin_change.applied_unrecorded.
  if (change.status === "applying" && (change.claimedAt === undefined || now - Date.parse(change.claimedAt) > ADMIN_CHANGE_APPLYING_STALE_MS)) {
    const error = { code: "RUNTIME_UNAVAILABLE", message: APPLY_UNFINISHED };
    if (await transition(deps, change, "applying", "failed", { failedAt: iso(now), error }, { error })) {
      logChangeStep(deps.log, "apply_unfinished", { ...traced(change), outcome: "failed", error: error.code });
      return { ...change, status: "failed", error };
    }
    return (await getPending(deps, change.changeId)) ?? change;
  }
  return change;
}

/** Q9: why a change that is not pending can no longer be confirmed, and what to do next. */
function refusalFor(change: PendingChange): AgentXError {
  switch (change.status) {
    case "declined": return agentXError("CONFIRMATION_DECLINED", `change ${change.changeId} was declined; ask for the change again`);
    case "expired": return agentXError("CONFIRMATION_EXPIRED", `change ${change.changeId} expired at ${change.expiresAt}; ask for the change again`);
    case "applied": return agentXError("CONFIRMATION_EXPIRED", `change ${change.changeId} was already applied; a change applies at most once`);
    case "applying": return agentXError("CONFIRMATION_EXPIRED", `change ${change.changeId} is being applied now; read it again in a moment`);
    case "failed": {
      const code = AgentXErrorCodeSchema.safeParse(change.error?.code);
      return agentXError(code.success ? code.data : "RUNTIME_UNAVAILABLE", `change ${change.changeId} failed: ${change.error?.message ?? NOT_APPLIED}`);
    }
    default: return agentXError("CONFIRMATION_EXPIRED", `change ${change.changeId} is no longer pending; ask for the change again`);
  }
}
const refusedReason = (change: PendingChange): RefusedAttemptReason => (change.status === "expired" ? "expired" : "not_pending");

/**
 * R6, honest limit (accepted): a Slack press carries no token, so it applies under the planning
 * admin's stored identity with the admin claim as it was at planning. An admin claim removed at the
 * identity provider within the 10 minutes is not re-checked; project administrator membership is,
 * inside the handler at apply.
 */
const storedIdentity = (change: PendingChange): AuthenticatedIdentity => ({ issuer: change.admin.issuer, subject: change.admin.subject, ownerKey: change.admin.ownerKey, isAdministrator: true, claims: {} });

async function requireOwn(deps: AdminChangeDependencies, identity: AuthenticatedIdentity, changeId: string): Promise<PendingChange> {
  const change = await getPending(deps, changeId);
  if (change === undefined) throw agentXError("NOT_FOUND", `no change ${changeId}; list the changes with agentx admin changes`);
  if (!isPlanner(change, identity)) {
    await refuseAttempt(deps, changeId, "another_admin");
    logChangeStep(deps.log, "refused", { ...traced(change), error: "another_admin" });
    throw agentXError("FORBIDDEN", "only the admin who asked for this change can confirm or decline it");
  }
  return settle(deps, change);
}

/** A change that is not pending any more refuses the attempt, and records it. */
async function requirePending(deps: AdminChangeDependencies, change: PendingChange): Promise<void> {
  if (change.status === "pending") return;
  await refuseAttempt(deps, change.changeId, refusedReason(change));
  throw refusalFor(change);
}

/** B4: the admin's linked Slack user and display name; a failed lookup links nothing. */
async function whoIsPlanning(deps: AdminChangeDependencies, identity: AuthenticatedIdentity, authorization: string | undefined, traceId: string): Promise<{ displayName?: string; slackUserId?: string }> {
  if (deps.identity === undefined) return {};
  let me: AdminMeResponse;
  try {
    me = await deps.identity.me(identity, authorization);
  } catch (error) {
    deps.log({ event: "admin_change.identity_unavailable", traceId, error: errorName(error) });
    return {};
  }
  const name = typeof me.name === "string" && me.name.trim() !== "" ? cap(me.name.trim(), 200) : undefined;
  const slackUserId = me.slack.linked && SlackUserIdSchema.safeParse(me.slack.userId).success ? me.slack.userId : undefined;
  return { ...(name === undefined ? {} : { displayName: name }), ...(slackUserId === undefined ? {} : { slackUserId }) };
}

/** FR-041: why no method is left, in the order the caller asked for them. */
function unavailableMessage(deps: AdminChangeDependencies, methods: readonly ConfirmationMethod[]): string {
  const reasons: string[] = [];
  if (methods.includes("elicitation") && !deps.confirm.elicitation) reasons.push("the environment does not allow the pop-up");
  if (methods.includes("slack")) reasons.push(deps.confirm.slack && deps.identity !== undefined ? "your admin sign-in matches no Slack user" : "Slack confirmation is not set up in this environment");
  return `no confirmation method is available: ${reasons.join(", and ")}; use agentx admin commands instead`;
}

async function answerExisting(deps: AdminChangeDependencies, identity: AuthenticatedIdentity, requestId: string): Promise<Answer | undefined> {
  const pointer = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: adminChangeRequestKey(identity.ownerKey, requestId), ConsistentRead: true })) as { Item?: { changeId?: unknown } };
  if (typeof pointer.Item?.changeId !== "string") return undefined;
  const existing = await getPending(deps, pointer.Item.changeId);
  if (existing === undefined) return undefined;
  return { status: 200, body: { change: viewOf(deps, await settle(deps, existing), isPlanner(existing, identity)) } };
}

async function propose(deps: AdminChangeDependencies, identity: AuthenticatedIdentity, authorization: string | undefined, value: unknown, traceId: string): Promise<Answer> {
  const parsed = ProposeAdminChangeRequestSchema.safeParse(value);
  if (!parsed.success) {
    // No change exists yet, so there is no record to audit: the log says a request was refused.
    const issue = parsed.error.issues[0];
    deps.log({ event: "admin_change.request_invalid", traceId, error: "CONFIG_INVALID" });
    throw agentXError("CONFIG_INVALID", `invalid change request: ${issue?.path.join(".") || "request"}: ${issue?.message ?? "invalid"}; fix it and send it again`);
  }
  const request = parsed.data;
  const repeated = await answerExisting(deps, identity, request.requestId);
  if (repeated !== undefined) return repeated;

  const now = deps.now();
  const changeId = deps.newId();
  const proposedAt = iso(now);
  const kind = request.change.kind;
  // B4: who is planning, before the plan, so a private channel is named only to a member admin.
  const who = await whoIsPlanning(deps, identity, authorization, traceId);
  const admin = { issuer: identity.issuer, subject: identity.subject, ...(who.displayName === undefined ? {} : { displayName: who.displayName }) };
  const client = { cliVersion: request.client.cliVersion, ...(request.client.mcpClient === undefined ? {} : { mcpClientName: request.client.mcpClient.name, ...(request.client.mcpClient.version === undefined ? {} : { mcpClientVersion: request.client.mcpClient.version }) }) };
  const base = { changeId, kind, traceId, admin, client, proposedAt };
  let plan: ChangePlan;
  try {
    plan = await planChange(deps.plans, identity, request.change, who.slackUserId === undefined ? {} : { slackUserId: who.slackUserId });
  } catch (error) {
    // FR-051: every request has its audit record, whatever its outcome.
    const failure = errorOf(error, NOT_PLANNED);
    await writeProposal(deps.audit, { ...base, change: request.change, effect: "", methodsOffered: [], status: "failed", failedAt: proposedAt, error: failure });
    logChangeStep(deps.log, "plan_refused", { changeId, traceId, kind, outcome: "failed", error: failure.code });
    throw error instanceof AgentXError ? error : agentXError("RUNTIME_UNAVAILABLE", `change ${changeId}: ${NOT_PLANNED}`);
  }
  const effect = cap(redactText(plan.effect), ADMIN_CHANGE_EFFECT_MAX);
  const confirmationEffect = plan.confirmationEffect === undefined ? undefined : cap(redactText(plan.confirmationEffect), ADMIN_CHANGE_EFFECT_MAX);
  // R4: the audit keeps the ID-only effect and the details, never the member admin's confirmation text.
  const change = redactSecrets({ ...request.change, details: plan.details }) as Record<string, unknown>;
  const offered: ConfirmationMethod[] = [];
  for (const method of request.methods) {
    if (offered.includes(method)) continue;
    // E17: the CLI's own prompt is always accepted from the planning admin (D12).
    if (method === "cli") offered.push("cli");
    if (method === "elicitation" && deps.confirm.elicitation) offered.push("elicitation");
    if (method === "slack" && deps.confirm.slack && who.slackUserId !== undefined) offered.push("slack");
  }
  if (offered.length === 0) {
    const error = { code: "CONFIRMATION_UNAVAILABLE", message: unavailableMessage(deps, request.methods) };
    await writeProposal(deps.audit, { ...base, change, effect, methodsOffered: [], status: "failed", failedAt: proposedAt, error });
    logChangeStep(deps.log, "unconfirmable", { changeId, traceId, kind, outcome: "failed", error: error.code });
    throw agentXError("CONFIRMATION_UNAVAILABLE", error.message);
  }
  // R2: both State items carry the table's TTL; R3: the raw input stays here, as apply needs it.
  const stored = AdminChangePendingRecordSchema.safeParse({
    ...adminChangeKey(changeId), entityType: "ADMIN_CHANGE", changeId, kind, input: request.change, effect,
    ...(confirmationEffect === undefined || confirmationEffect === effect ? {} : { confirmationEffect }),
    details: plan.details, stateHash: stateHash(plan.snapshot), admin: { ...admin, ownerKey: identity.ownerKey },
    ...(who.slackUserId === undefined ? {} : { slackUserId: who.slackUserId }),
    methodsOffered: offered, status: "pending", createdAt: proposedAt, proposedAt, expiresAt: iso(now + ADMIN_CHANGE_TTL_MS), traceId,
    [INDEX_EXPIRY_ATTRIBUTE]: adminChangeItemExpiresAt(proposedAt),
  });
  if (!stored.success) {
    // A plan this control plane cannot store is still audited, and nothing is left pending.
    const error = { code: "RUNTIME_UNAVAILABLE", message: NOT_PLANNED };
    await writeProposal(deps.audit, { ...base, change, effect, methodsOffered: [], status: "failed", failedAt: proposedAt, error });
    logChangeStep(deps.log, "unstorable", { changeId, traceId, kind, outcome: "failed", error: error.code });
    throw agentXError("RUNTIME_UNAVAILABLE", `change ${changeId}: ${NOT_PLANNED}`);
  }
  const pending = stored.data;
  try {
    await transact(deps, [
      { Put: { TableName: deps.tableName, Item: pending, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: deps.tableName, Item: { ...adminChangeRequestKey(identity.ownerKey, request.requestId), entityType: "ADMIN_CHANGE_REQUEST", changeId, [INDEX_EXPIRY_ATTRIBUTE]: adminChangeItemExpiresAt(proposedAt) }, ConditionExpression: "attribute_not_exists(pk)" } },
      proposalItem(deps.audit.tableName, { ...base, change, effect, methodsOffered: offered, status: "pending" }),
    ]);
  } catch (error) {
    if (!conditional(error)) throw error;
    // The same request ID raced this one; answer the change it made.
    const raced = await answerExisting(deps, identity, request.requestId);
    if (raced === undefined) throw error;
    return raced;
  }
  logChangeStep(deps.log, "proposed", { changeId, traceId, kind });
  return { status: 201, body: { change: viewOf(deps, pending, true) } };
}

/** After a refused conditional write: the change as it is now, its refusal recorded. */
async function refuseAsItIs(deps: AdminChangeDependencies, change: PendingChange, slackUserId?: string): Promise<AgentXError> {
  const current = await settle(deps, (await getPending(deps, change.changeId)) ?? change);
  await refuseAttempt(deps, change.changeId, refusedReason(current), slackUserId);
  // Still pending: its audit record had already settled, which no route can fix; a new request can.
  return current.status === "pending"
    ? agentXError("CONFIRMATION_EXPIRED", `change ${change.changeId} can no longer be confirmed; ask for the change again`)
    : refusalFor(current);
}

/**
 * E5, FR-040: re-plan and compare the hash; claim with one conditional write (pending, unexpired,
 * an offered method); only then run the existing handler; record applied or failed. The claim is
 * the only way into `applying`, so a change applies at most once however many confirmations race.
 */
async function applyOnce(deps: AdminChangeDependencies, change: PendingChange, applier: AuthenticatedIdentity, how: Confirmation): Promise<PendingChange> {
  const now = deps.now();
  const answered: AuditStep = {
    answeredAt: how.answeredAt ?? iso(now), methodUsed: how.method,
    ...(how.pressedBy === undefined ? {} : { pressedBy: how.pressedBy }),
    ...(how.requestedAt === undefined || change.slackRequestedAt !== undefined ? {} : { confirmationRequestedAt: how.requestedAt }),
  };
  const who = { methodUsed: how.method, ...(how.pressedBy === undefined ? {} : { pressedBy: how.pressedBy }) };
  // B4: the stored Slack user, so the re-plan reads what the planning read (a press has no token).
  let fresh: ChangePlan | AgentXError;
  try {
    fresh = await planChange(deps.plans, applier, change.input, change.slackUserId === undefined ? {} : { slackUserId: change.slackUserId });
  } catch (error) {
    if (!(error instanceof AgentXError) || TRANSIENT.has(error.code)) {
      // A throttle, a failed lookup or an unreachable Slack says nothing about the state: never
      // apply, and leave the change pending so the admin can confirm again within its 10 minutes.
      logChangeStep(deps.log, "replan_unavailable", { ...traced(change), error: errorName(error) });
      throw tryAgain(change.changeId, "checked against the current state");
    }
    fresh = error;
  }
  if (fresh instanceof AgentXError || stateHash(fresh.snapshot) !== change.stateHash) {
    // Task 6 carry (b): a re-plan the planner refuses is a stale state too, and never applies.
    const why = fresh instanceof AgentXError ? ` (${stripCode(fresh.message, fresh.code)})` : "";
    const error = { code: "CHANGE_STALE", message: cap(redactText(`what change ${change.changeId} was planned against has changed${why}; ask for the change again`), ERROR_MESSAGE_MAX) };
    if (!(await transition(deps, change, "pending", "failed", { ...answered, failedAt: iso(now), error }, { ...who, error }))) throw await refuseAsItIs(deps, change, how.pressedBy);
    await refuseAttempt(deps, change.changeId, "stale_state", how.pressedBy);
    logChangeStep(deps.log, "stale", { ...traced(change), outcome: "failed", error: error.code });
    throw agentXError("CHANGE_STALE", error.message);
  }
  try {
    await transact(deps, [
      { Update: {
        TableName: deps.tableName, Key: adminChangeKey(change.changeId),
        UpdateExpression: `SET #status = :applying, claimedAt = :now, methodUsed = :method${how.pressedBy === undefined ? "" : ", pressedBy = :pressedBy"}`,
        // FR-040: pending, unexpired, and confirmed by an offered method; the planner was checked by the caller.
        ConditionExpression: "#status = :pending AND expiresAt > :now AND contains(methodsOffered, :method)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":applying": "applying", ":pending": "pending", ":now": iso(now), ":method": how.method, ...(how.pressedBy === undefined ? {} : { ":pressedBy": how.pressedBy }) },
      } },
      auditStepItem(deps.audit.tableName, change.changeId, { ...answered, status: "applying" }),
    ]);
  } catch (error) {
    if (conditional(error)) throw await refuseAsItIs(deps, change, how.pressedBy);
    // A throttled or ambiguous claim: the change as it is now. Still pending means nothing
    // applied; applying means the claim was written and its answer lost, so the handler never
    // runs here and the change reads failed after 2 minutes (at most once either way).
    logChangeStep(deps.log, "claim_unavailable", { ...traced(change), error: errorName(error) });
    let current: PendingChange | undefined;
    try {
      current = await getPending(deps, change.changeId);
    } catch {
      throw tryAgain(change.changeId, "confirmed");
    }
    if (current === undefined || current.status === "pending") throw tryAgain(change.changeId, "confirmed");
    throw await refuseAsItIs(deps, current, how.pressedBy);
  }
  logChangeStep(deps.log, "claimed", traced(change));
  const applying: PendingChange = { ...change, status: "applying", claimedAt: iso(now), ...who };
  let result: Record<string, unknown>;
  try {
    result = redactSecrets(await fresh.apply(applier)) as Record<string, unknown>;
  } catch (error) {
    const failure = errorOf(error);
    await transition(deps, applying, "applying", "failed", { failedAt: iso(deps.now()), error: failure }, { error: failure });
    logChangeStep(deps.log, "failed", { ...traced(change), outcome: "failed", error: failure.code });
    const code = AgentXErrorCodeSchema.safeParse(failure.code);
    throw agentXError(code.success ? code.data : "RUNTIME_UNAVAILABLE", `change ${change.changeId} failed: ${failure.message}`);
  }
  if (!(await transition(deps, applying, "applying", "applied", { appliedAt: iso(deps.now()), result }, { result }))) {
    // Only a read that found it applying for over 2 minutes moves it on meanwhile; it did apply.
    logChangeStep(deps.log, "applied_unrecorded", { ...traced(change), outcome: "confirmed" });
  }
  logChangeStep(deps.log, "applied", { ...traced(change), outcome: "confirmed" });
  return { ...applying, status: "applied", result };
}

async function apply(deps: AdminChangeDependencies, identity: AuthenticatedIdentity, changeId: string, value: unknown): Promise<Answer> {
  const change = await requireOwn(deps, identity, changeId);
  await requirePending(deps, change);
  const body = ApplyAdminChangeRequestSchema.safeParse(value);
  if (!body.success) {
    await refuseAttempt(deps, changeId, "method_not_offered");
    throw agentXError("CONFIG_INVALID", "method must be elicitation or cli; a Slack confirmation is its button");
  }
  // E16: a pop-up the environment has since turned off is refused, even where the change offered it.
  if (!change.methodsOffered.includes(body.data.method) || (body.data.method === "elicitation" && !deps.confirm.elicitation)) {
    await refuseAttempt(deps, changeId, "method_not_offered");
    logChangeStep(deps.log, "refused", { ...traced(change), error: "method_not_offered" });
    throw agentXError("CONFIRMATION_UNAVAILABLE", `${METHOD_NAMES[body.data.method].confirm} was not offered for change ${changeId}; confirm it with ${methodsNamed(change.methodsOffered, "confirm")}, or ask for the change again`);
  }
  const applied = await applyOnce(deps, change, identity, {
    method: body.data.method,
    ...(body.data.requestedAt === undefined ? {} : { requestedAt: body.data.requestedAt }),
    ...(body.data.answeredAt === undefined ? {} : { answeredAt: body.data.answeredAt }),
  });
  return { status: 200, body: { change: viewOf(deps, applied, true) } };
}

async function decline(deps: AdminChangeDependencies, identity: AuthenticatedIdentity, changeId: string, value: unknown): Promise<Answer> {
  const change = await requireOwn(deps, identity, changeId);
  await requirePending(deps, change);
  const body = DeclineAdminChangeRequestSchema.safeParse(value);
  if (!body.success) {
    await refuseAttempt(deps, changeId, "method_not_offered");
    throw agentXError("CONFIG_INVALID", "method must be elicitation or cli, and reason declined, cancelled or failed");
  }
  if (!change.methodsOffered.includes(body.data.method)) {
    await refuseAttempt(deps, changeId, "method_not_offered");
    logChangeStep(deps.log, "refused", { ...traced(change), error: "method_not_offered" });
    throw agentXError("CONFIRMATION_UNAVAILABLE", `${METHOD_NAMES[body.data.method].decline} was not offered for change ${changeId}; decline it with ${methodsNamed(change.methodsOffered, "decline")}, or let it expire`);
  }
  const answeredAt = body.data.answeredAt ?? iso(deps.now());
  if (!(await transition(deps, change, "pending", "declined", { answeredAt, methodUsed: body.data.method }, { methodUsed: body.data.method }))) throw await refuseAsItIs(deps, change);
  logChangeStep(deps.log, "declined", { ...traced(change), outcome: "declined" });
  return { status: 200, body: { change: viewOf(deps, { ...change, status: "declined", methodUsed: body.data.method }, true) } };
}

async function startSlack(deps: AdminChangeDependencies, identity: AuthenticatedIdentity, changeId: string): Promise<Answer> {
  const change = await requireOwn(deps, identity, changeId);
  await requirePending(deps, change);
  if (!change.methodsOffered.includes("slack") || !deps.confirm.slack) {
    await refuseAttempt(deps, changeId, "method_not_offered");
    throw agentXError("CONFIRMATION_UNAVAILABLE", `the Slack Confirm button was not offered for change ${changeId}; confirm it with ${methodsNamed(change.methodsOffered, "confirm")}, or ask for the change again`);
  }
  if (change.slackRequestedAt !== undefined) return { status: 200, body: { change: viewOf(deps, change, true) } };
  const requestedAt = iso(deps.now());
  try {
    await transact(deps, [
      { Update: { TableName: deps.tableName, Key: adminChangeKey(changeId), UpdateExpression: "SET slackRequestedAt = :at", ConditionExpression: "#status = :pending AND attribute_not_exists(slackRequestedAt)", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":at": requestedAt, ":pending": "pending" } } },
      auditStepItem(deps.audit.tableName, changeId, { confirmationRequestedAt: requestedAt }),
    ]);
  } catch (error) {
    if (!conditional(error)) throw error;
    // Another start won the race, or the change moved on meanwhile.
    const current = await settle(deps, (await getPending(deps, changeId)) ?? change);
    if (current.status === "pending" && current.slackRequestedAt !== undefined) return { status: 200, body: { change: viewOf(deps, current, true) } };
    throw await refuseAsItIs(deps, current);
  }
  // E13: the notifier sees slackRequestedAt on the stream and posts the direct message.
  logChangeStep(deps.log, "slack_requested", traced(change));
  return { status: 200, body: { change: viewOf(deps, { ...change, slackRequestedAt: requestedAt }, true) } };
}

/** The press's outcome for a confirmation that did not apply. */
async function pressFailure(deps: AdminChangeDependencies, change: PendingChange, error: unknown): Promise<PressOutcome> {
  if (error instanceof AgentXError && error.code === "CHANGE_STALE") return "stale";
  const current = await getPending(deps, change.changeId);
  // The re-plan could not read the state: nothing applied, and the change stays pending.
  if (current?.status === "pending" && error instanceof AgentXError && error.code === "RUNTIME_UNAVAILABLE") return "unavailable";
  if (current?.status === "expired") return "expired";
  if (current?.status === "failed") return "failed";
  return "not_pending";
}

/**
 * E14, FR-041: a Confirm or Cancel press, from the ingress. Only the change's own Slack user, in
 * this environment's team, after the Slack step started; anything else is refused and recorded,
 * and the change stays pending. A press applies at once, even after the tool stopped waiting (D7).
 */
export async function pressAdminChange(deps: AdminChangeDependencies, event: AdminChangePressEvent): Promise<{ outcome: PressOutcome; changeId: string; traceId?: string }> {
  const found = await getPending(deps, event.changeId);
  if (found === undefined) {
    deps.log({ event: "admin_change.press_not_found", changeId: event.changeId });
    return { outcome: "not_found", changeId: event.changeId };
  }
  const answer = (outcome: PressOutcome) => ({ outcome, changeId: found.changeId, traceId: found.traceId });
  const refuse = async (reason: RefusedAttemptReason, outcome: PressOutcome) => {
    await refuseAttempt(deps, found.changeId, reason, event.slackUserId);
    logChangeStep(deps.log, "press_refused", { ...traced(found), error: reason });
    return answer(outcome);
  };
  // Any press is a touch: an expired change is recorded expired first (E3).
  const change = await settle(deps, found);
  // C12: where the environment records its team, a press must name it.
  if (deps.slackTeamId !== undefined && event.teamId !== deps.slackTeamId) return refuse("wrong_team", "refused");
  if (change.slackUserId === undefined || event.slackUserId !== change.slackUserId) return refuse("another_person", "refused");
  if (change.status !== "pending") return refuse(refusedReason(change), refusedReason(change) === "expired" ? "expired" : "not_pending");
  if (!change.methodsOffered.includes("slack") || !deps.confirm.slack) return refuse("method_not_offered", "refused");
  if (change.slackRequestedAt === undefined) return refuse("not_pending", "not_pending");
  const at = iso(deps.now());
  if (event.click === "cancel") {
    if (!(await transition(deps, change, "pending", "declined", { answeredAt: at, methodUsed: "slack", pressedBy: event.slackUserId }, { methodUsed: "slack", pressedBy: event.slackUserId }))) {
      await refuseAsItIs(deps, change, event.slackUserId);
      return answer(await pressFailure(deps, change, undefined));
    }
    logChangeStep(deps.log, "declined", { ...traced(change), outcome: "declined" });
    return answer("declined");
  }
  try {
    await applyOnce(deps, change, storedIdentity(change), { method: "slack", pressedBy: event.slackUserId, answeredAt: at });
    return answer("applied");
  } catch (error) {
    return answer(await pressFailure(deps, change, error));
  }
}

/** E3: every read after its expiry shows a change expired (and one stuck applying failed), recording it on the way. */
async function settleRecord(deps: AdminChangeDependencies, record: AdminChangeAuditRecord, now: number): Promise<AdminChangeAuditRecord> {
  const unsettled = (record.status === "pending" && now >= Date.parse(record.proposedAt) + ADMIN_CHANGE_TTL_MS) || record.status === "applying";
  const pending = unsettled ? await getPending(deps, record.changeId) : undefined;
  if (pending === undefined) return record;
  const settled = await settle(deps, pending);
  return settled.status === pending.status ? record : (await readAudit(deps.audit, record.changeId)) ?? record;
}

/** Settles every change still `statuses` in the window, a bounded number of pages at a time. */
async function settleWindow(deps: AdminChangeDependencies, window: { since: string; until?: string; admin?: string }, statuses: AdminChangeStatus[]): Promise<void> {
  const now = deps.now();
  let cursor: string | undefined;
  for (let pages = 0; pages < SETTLE_PAGES_MAX; pages += 1) {
    const page = await listAudit(deps.audit, { ...window, status: statuses, limit: ADMIN_LIST_MAX, ...(cursor === undefined ? {} : { cursor }) });
    for (const record of page.changes) await settleRecord(deps, record, now);
    if (page.cursor === undefined) return;
    cursor = page.cursor;
  }
  // Ten pages of unsettled changes in one window; the rest settle on a later read.
  deps.log({ event: "admin_change.settle_capped", statuses: statuses.join(",") });
}

async function list(deps: AdminChangeDependencies, url: URL): Promise<Answer> {
  const now = deps.now();
  const text = (name: string) => url.searchParams.get(name) ?? undefined;
  const time = (name: string) => {
    const value = text(name);
    // turns.ts's check: a date that does not exist (February 31, hour 24) is refused, not rolled over.
    if (value !== undefined && !validTime(value)) throw agentXError("CONFIG_INVALID", `${name} must be an ISO 8601 time such as 2026-09-30T00:00:00.000Z`);
    return value === undefined ? undefined : new Date(value).toISOString();
  };
  const since = time("since") ?? iso(now - LIST_DEFAULT_DAYS * 86_400_000);
  const until = time("until");
  const outcomeText = text("outcome");
  const outcome = outcomeText === undefined ? undefined : AdminChangeOutcomeSchema.safeParse(outcomeText);
  if (outcome !== undefined && !outcome.success) throw agentXError("CONFIG_INVALID", "outcome must be confirmed, declined, expired or failed");
  const limit = listLimitParam(url.searchParams.get("limit"), LIST_DEFAULT_LIMIT);
  const admin = text("admin");
  const cursor = text("cursor");
  const window = { since, ...(until === undefined ? {} : { until }), ...(admin === undefined ? {} : { admin: admin.slice(0, 256) }) };
  // The outcome filter runs on the stored outcome, so an expired or stuck change nobody touched
  // since would be left out: settle those in the window first, and the filtered read finds them.
  if (outcome?.data === "expired" || outcome?.data === "failed") await settleWindow(deps, window, outcome.data === "expired" ? ["pending"] : ["applying"]);
  const page = await listAudit(deps.audit, {
    ...window, limit,
    ...(outcome === undefined ? {} : { outcome: outcome.data }),
    ...(cursor === undefined ? {} : { cursor }),
  });
  const changes: AdminChangeAuditRecord[] = [];
  for (const record of page.changes) changes.push(await settleRecord(deps, record, now));
  return { status: 200, body: { changes, ...(page.cursor === undefined ? {} : { cursor: page.cursor }) } };
}

/** E4: the change routes, or undefined when the request is not one. */
export async function routeAdminChange(deps: AdminChangeDependencies | undefined, identity: AuthenticatedIdentity, request: { method: string; headers: Record<string, string | undefined>; body: unknown }, url: URL): Promise<Answer | undefined> {
  if (url.pathname !== "/v1/admin/changes" && !url.pathname.startsWith("/v1/admin/changes/")) return undefined;
  if (deps === undefined) throw agentXError("NOT_FOUND", "admin changes are not set up in this deployment");
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  // FR-052: the MCP server sends one trace ID per change tool call; a change's steps log with its own.
  const given = request.headers["x-agentx-trace-id"];
  const traceId = given !== undefined && TRACE.test(given) ? given : randomUUID();
  if (url.pathname === "/v1/admin/changes") {
    if (request.method === "POST") return propose(deps, identity, request.headers.authorization, request.body, traceId);
    if (request.method === "GET") return list(deps, url);
  }
  const match = CHANGE_PATH.exec(url.pathname);
  const changeId = match?.[1];
  if (changeId !== undefined) {
    if (request.method === "GET" && match?.[2] === undefined) {
      const change = await getPending(deps, changeId);
      if (change === undefined) throw agentXError("NOT_FOUND", `no change ${changeId}; list the changes with agentx admin changes`);
      return { status: 200, body: { change: viewOf(deps, await settle(deps, change), isPlanner(change, identity)) } };
    }
    if (request.method === "POST" && match?.[2] === "slack") return startSlack(deps, identity, changeId);
    if (request.method === "POST" && match?.[2] === "apply") return apply(deps, identity, changeId, request.body);
    if (request.method === "POST" && match?.[2] === "decline") return decline(deps, identity, changeId, request.body);
  }
  throw agentXError("NOT_FOUND", "route not found");
}
