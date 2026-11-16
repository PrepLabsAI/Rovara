// Multi-tenancy: the DynamoDB keys whose names two orgs can share (a project called "web", a member
// grant on it, the workspace limits) or that list across tenants (the usage and failure indexes).
// Each one is prefixed with `orgScoped(orgId, ...)`, and nothing else builds these keys.
import { createHash } from "node:crypto";
import { canonicalInstant, indexDay } from "./admin.js";
import { principalKey, type AgentId } from "./agent.js";
export { principalKey } from "./agent.js";
import type { AgentPrincipal, ApprovalId, SkillId } from "./agent-node.js";
import type { SessionId } from "./agent-sessions.js";
import type { SessionBinding } from "./agent-sessions-node.js";
import { OrgIdSchema, type OrgId } from "./company-scope.js";
import { orgPk, orgScoped, type OrgKey } from "./company-scope.js";
import type { ChainId, ChainRunId } from "./chains.js";
import type { EventSource } from "./trigger-specs.js";
import type { TriggerTarget } from "./triggers.js";

const REVISION_WIDTH = 12;

/** The partition holding every revision of one project (and its selection row) in one org. */
export function projectPk(orgId: OrgId, name: string): string {
  return orgScoped(orgId, `PROJECT#${name}`);
}

const PROJECT_PK = /^ORG#(org_[0-9a-z]{20})#PROJECT#/;

/** The org a `projectPk` is scoped to, or undefined for a partition key that is not one. */
export function orgOfProjectPk(pk: string): OrgId | undefined {
  const parsed = OrgIdSchema.safeParse(PROJECT_PK.exec(pk)?.[1]);
  return parsed.success ? parsed.data : undefined;
}

export function projectRevisionKey(orgId: OrgId, name: string, revision: number): OrgKey {
  return { pk: projectPk(orgId, name), sk: `REV#${String(revision).padStart(REVISION_WIDTH, "0")}` };
}

/** The sort-key prefix of a project's revisions, for a query on `projectPk`. */
export const PROJECT_REVISION_SK_PREFIX = "REV#";

/**
 * A project's record beside its revisions: status (active or archived), description, who created it and the setup check. Absent on a
 * project registered before Plan 2, which reads as active, created by "unknown".
 */
export function projectMetaKey(orgId: OrgId, name: string): OrgKey {
  return { pk: projectPk(orgId, name), sk: "META" };
}

export function projectSelectionKey(orgId: OrgId, name: string): OrgKey {
  return { pk: projectPk(orgId, name), sk: "SELECTION" };
}

/** A project's setup approval: the proposal an administrator approved, held once per project name in one org. */
export function projectSetupApprovalKey(orgId: OrgId, projectName: string, proposalSha256: string): OrgKey {
  return { pk: orgScoped(orgId, `PROJECT_SETUP#${projectName}`), sk: `PROPOSAL#${proposalSha256}` };
}

/**
 * The value a workspace META item carries in the byWorkspaceProject index's partition attribute: the
 * project name prefixed with its org, so two orgs' same-named projects list separately.
 */
export function workspaceProjectIndexValue(orgId: OrgId, projectName: string): string {
  return orgScoped(orgId, projectName);
}

/** The index attributes a workspace META item is written with (see WORKSPACE_PROJECT_INDEX); the project is prefixed with its org. */
export function workspaceProjectIndexAttributes(workspace: { orgId: OrgId; projectName: string; createdAt: string }): {
  workspaceProject: string;
  workspaceCreatedAt: string;
} {
  return { workspaceProject: workspaceProjectIndexValue(workspace.orgId, workspace.projectName), workspaceCreatedAt: workspace.createdAt };
}

/** The partition holding one person's project grants in one org. */
export function memberGrantsPk(orgId: OrgId, ownerKey: string): string {
  return orgScoped(orgId, `MEMBER#${ownerKey}`);
}

/** The sort-key prefix of a member's grants, for a query on `memberGrantsPk`. */
export const MEMBER_GRANT_SK_PREFIX = "PROJECT#";

export function projectMemberKey(orgId: OrgId, ownerKey: string, project: string): OrgKey {
  return { pk: memberGrantsPk(orgId, ownerKey), sk: `PROJECT#${project}` };
}

/**
 * A person's default workspace for a project in one org: the map from (person, project) to the workspace an administrator prepared or the Slack channel started. A person has one
 * owner key across orgs, so the org is part of the key: leaving one org and joining another with a project of the same name never reads the old org's workspace.
 */
export function defaultWorkspaceKey(orgId: OrgId, ownerKey: string, project: string): OrgKey {
  return { pk: orgScoped(orgId, `OWNER#${ownerKey}`), sk: `PROJECT#${project}` };
}

/** The company's own learning settings (the master "suggestions" switch): `ORG#<org>` / `LEARNING_SETTINGS`. Absent until the company first chooses. */
export function orgLearningSettingsKey(orgId: OrgId): OrgKey {
  return { pk: orgPk(orgId), sk: "LEARNING_SETTINGS" };
}

export type OrgSettingName = "WORKSPACE_LIMITS" | "MODEL_SELECTION_POLICY" | "REVIEW_DEFAULT_NOTICE";

export function orgSettingsKey(orgId: OrgId, name: OrgSettingName): OrgKey {
  return { pk: orgScoped(orgId, "SETTINGS"), sk: name };
}

/** The org-wide open-workspace counter; it replaces `DEVELOPER_LIMIT#ORGANIZATION`. */
export function orgLimitKey(orgId: OrgId): OrgKey {
  return { pk: orgScoped(orgId, "DEVELOPER_LIMIT#ORGANIZATION"), sk: "ORGANIZATION" };
}

/** One org's usage items for a UTC day (`day` is `YYYY-MM-DD`). */
export function orgUsageDayPk(orgId: OrgId, day: string): string {
  return orgScoped(orgId, `USAGE#${day}`);
}

export function orgUsageIndexKey(orgId: OrgId, at: string, opId: string): OrgKey {
  const time = canonicalInstant(at);
  return { pk: orgUsageDayPk(orgId, indexDay(time)), sk: `${time}#${opId}` };
}

/** One org's failure items for a UTC day (`day` is `YYYY-MM-DD`). */
export function orgFailureDayPk(orgId: OrgId, day: string): string {
  return orgScoped(orgId, `FAILURE#${day}`);
}

export function orgFailureIndexKey(orgId: OrgId, endedAt: string, opId: string): OrgKey {
  const time = canonicalInstant(endedAt);
  return { pk: orgFailureDayPk(orgId, indexDay(time)), sk: `${time}#${opId}` };
}

/** A3: the partition of an org's project catalog, one row per registered project. */
export function orgProjectCatalogPk(orgId: OrgId): string {
  return orgScoped(orgId, "PROJECT_CATALOG");
}

export function orgProjectCatalogKey(orgId: OrgId, name: string): OrgKey {
  return { pk: orgProjectCatalogPk(orgId), sk: `PROJECT#${name}` };
}

/** The partition holding every channel binding of one Slack team in one org. */
export function slackBindingPk(orgId: OrgId, teamId: string): string {
  return orgScoped(orgId, `SLACK_BINDING#${teamId}`);
}

/** The sort-key prefix of a team's channel bindings, for a query on `slackBindingPk`. */
export const SLACK_BINDING_SK_PREFIX = "CHANNEL#";

export function slackBindingKey(orgId: OrgId, teamId: string, channelId: string): OrgKey {
  return { pk: slackBindingPk(orgId, teamId), sk: `${SLACK_BINDING_SK_PREFIX}${channelId}` };
}

/** The partition holding the workspace counters of one Slack team in one org. */
export function slackLimitPk(orgId: OrgId, teamId: string): string {
  return orgScoped(orgId, `SLACK_LIMIT#${teamId}`);
}

/** The sort-key prefix of a team's member counters, for a query on `slackLimitPk`. */
export const SLACK_LIMIT_MEMBER_SK_PREFIX = "MEMBER#";

export function slackMemberLimitKey(orgId: OrgId, teamId: string, userId: string): OrgKey {
  return { pk: slackLimitPk(orgId, teamId), sk: `${SLACK_LIMIT_MEMBER_SK_PREFIX}${userId}` };
}

export function slackOrganizationLimitKey(orgId: OrgId, teamId: string): OrgKey {
  return { pk: slackLimitPk(orgId, teamId), sk: "ORGANIZATION" };
}

const SLACK_LIMIT_PK = /^ORG#org_[0-9a-z]{20}#SLACK_LIMIT#/;

/** Whether a partition key is a `slackLimitPk`, which decides a counter's entity type. */
export function isSlackLimitPk(pk: string): boolean {
  return SLACK_LIMIT_PK.test(pk);
}

const AGENT_VERSION_WIDTH = 6;
const MAX_AGENT_VERSION = 10 ** AGENT_VERSION_WIDTH - 1;

export type AgentItemSk = "META" | "DRAFT" | `VERSION#${string}` | `SHARE#${string}` | `EVENT#${string}`;

/** One agent's partition: its META, its DRAFT, immutable versions, shares and events. */
export function agentKey(orgId: OrgId, agentId: AgentId, sk: AgentItemSk): OrgKey {
  return { pk: orgScoped(orgId, `AGENT#${agentId}`), sk };
}

/** The sort key of a published version; six digits keep a query on `VERSION#` in version order. */
export function agentVersionSk(version: number): `VERSION#${string}` {
  if (!Number.isInteger(version) || version < 1 || version > MAX_AGENT_VERSION) throw new Error(`an agent version is a whole number from 1 to ${MAX_AGENT_VERSION}`);
  return `VERSION#${String(version).padStart(AGENT_VERSION_WIDTH, "0")}`;
}

/** The org's agent directory: one item per custom agent, for listing without reading every partition. */
export function agentDirectoryKey(orgId: OrgId, agentId: AgentId): OrgKey {
  return { pk: orgScoped(orgId, "AGENT_DIRECTORY"), sk: agentId };
}

/** The item that makes an agent's name unique in its org, ignoring case and surrounding spaces. */
export function agentNameKey(orgId: OrgId, name: string): OrgKey {
  return { pk: orgScoped(orgId, "AGENT_NAME"), sk: name.trim().toLowerCase() };
}

/** The index item that lists, per principal, the agents shared with it. */
export function principalSharesKey(orgId: OrgId, principal: AgentPrincipal, agentId: AgentId): OrgKey {
  return { pk: orgScoped(orgId, `AGENT_SHARES#${principalKey(principal)}`), sk: agentId };
}

/** The index item that lists, per principal, the chains shared with it (chains have their own partition, so an agent listing never sees them). */
export function principalChainSharesKey(orgId: OrgId, principal: AgentPrincipal, chainId: ChainId): OrgKey {
  return { pk: orgScoped(orgId, `CHAIN_SHARES#${principalKey(principal)}`), sk: chainId };
}

/** The roster item that puts an agent on a project. */
export function projectAgentKey(orgId: OrgId, project: string, agentId: AgentId): OrgKey {
  return { pk: orgScoped(orgId, `PROJECT_AGENTS#${project}`), sk: agentId };
}

export type SkillItemSk = "META" | `VERSION#${string}`;

export function skillKey(orgId: OrgId, skillId: SkillId, sk: SkillItemSk): OrgKey {
  return { pk: orgScoped(orgId, `SKILL#${skillId}`), sk };
}

/** The org's skill directory: one item per skill, for listing without reading every partition. */
export function skillDirectoryKey(orgId: OrgId, skillId: SkillId): OrgKey {
  return { pk: orgScoped(orgId, "SKILL_DIRECTORY"), sk: skillId };
}

/** The item that makes a skill's name unique in its org. A skill name is already lower case (`^[a-z0-9][a-z0-9-]{0,63}$`). */
export function skillNameKey(orgId: OrgId, name: string): OrgKey {
  return { pk: orgScoped(orgId, "SKILL_NAME"), sk: name };
}

/** The index item that lists an agent's recent tasks, newest last; `createdAt` is an instant. */
export function agentTasksKey(orgId: OrgId, agentId: AgentId, createdAt: string, taskId: string): OrgKey {
  return { pk: orgScoped(orgId, `AGENT_TASKS#${agentId}`), sk: `${canonicalInstant(createdAt)}#${taskId}` };
}

/**
 * The item that remembers one run's start (H2): one per (org, request id), written in the same transaction as the run, so a repeat of the
 * request is answered from it. The org is in the key, so another org's request with the same id is a different request.
 */
export function runRequestKey(orgId: OrgId, requestId: string): OrgKey {
  return { pk: orgScoped(orgId, `RUN_REQUEST#${requestId}`), sk: "META" };
}

/** An org's settings for one built-in agent: the version it pinned, its budget and its accountable person. */
export function builtinSettingsKey(orgId: OrgId, agentId: AgentId): OrgKey {
  return { pk: orgScoped(orgId, "BUILTIN_AGENTS"), sk: agentId };
}

/** An approval record: a pending change, a write waiting for a person, or a step waiting for one. */
export function approvalKey(orgId: OrgId, approvalId: ApprovalId): OrgKey {
  return { pk: orgScoped(orgId, `APPROVAL#${approvalId}`), sk: "META" };
}

/**
 * The global index of approvals still open, in the order they expire (ids only: the item names the org and the approval, and a
 * reader re-checks `orgId` on the record it points at). `expiresAt` is an instant.
 */
export function openApprovalKey(expiresAt: string, orgId: OrgId, approvalId: ApprovalId): OrgKey {
  return { pk: "OPEN_APPROVALS", sk: `${canonicalInstant(expiresAt)}#${orgId}#${approvalId}` };
}

/** The item that lists one approval for one person who may be asked to decide it (an id it names, or a candidate of its rule). */
export function approverIndexKey(orgId: OrgId, developerId: string, approvalId: ApprovalId): OrgKey {
  return { pk: orgScoped(orgId, `APPROVER#${developerId}`), sk: approvalId };
}

/**
 * The item that remembers what one request to change an agent did (R18): one per (org, developer, request id), written in the same
 * transaction as the change, so a repeat of the request is answered from it and writes nothing.
 */
export function agentRequestKey(orgId: OrgId, developerId: string, requestId: string): OrgKey {
  return { pk: orgScoped(orgId, `AGENT_REQUEST#${developerId}`), sk: requestId };
}

/** A company's agent guardrails: one row holding the document and its revision. */
export function agentGuardrailsKey(orgId: OrgId): OrgKey {
  return { pk: orgScoped(orgId, "AGENT_GUARDRAILS"), sk: "META" };
}

/** An org's company AI sources (Plan 3 Task 24b): one item holding the sources, their order and its revision. */
export function modelSourcesKey(orgId: OrgId): OrgKey {
  return { pk: orgScoped(orgId, "MODEL_SOURCES"), sk: "META" };
}

/** What one finished run cost, listed by project, agent and path for the estimates (`endedAt` is an instant). */
export function runCostKey(orgId: OrgId, project: string, agentId: AgentId, path: string, endedAt: string, taskId: string): OrgKey {
  return { pk: orgScoped(orgId, `RUN_COST#${project}#${agentId}#${path}`), sk: `${canonicalInstant(endedAt)}#${taskId}` };
}

/** One track-record sample (a claim in one round of one task), listed by project and stage; `createdAt` is an instant, `round` a workflow revision or a candidate digest prefix. */
export function outcomeSampleKey(orgId: OrgId, project: string, stage: string, createdAt: string, taskId: string, claim: string, round: string): OrgKey {
  return { pk: orgScoped(orgId, `OUTCOME#${keyPart(project, "a project")}#${keyPart(stage, "a stage")}`), sk: `${canonicalInstant(createdAt)}#${keyPart(taskId, "a task id")}#${keyPart(claim, "a claim")}#${keyPart(round, "a round")}` };
}

/** The copy of a scored sample, listed by when it was scored, so the rate reads exactly the last 30 days by score time. */
export function outcomeScoredKey(orgId: OrgId, project: string, stage: string, scoredAt: string, taskId: string, claim: string, round: string): OrgKey {
  return { pk: orgScoped(orgId, `OUTCOME_SCORED#${keyPart(project, "a project")}#${keyPart(stage, "a stage")}`), sk: `${canonicalInstant(scoredAt)}#${keyPart(taskId, "a task id")}#${keyPart(claim, "a claim")}#${keyPart(round, "a round")}` };
}

/** What one run (a task, or the operation of Slack work) cost an agent in a month, for the agent's recent runs. */
export function agentRunsKey(orgId: OrgId, month: string, agentId: AgentId, runId: string): OrgKey {
  return { pk: orgScoped(orgId, `AGENT_RUNS#${month}#${agentId}`), sk: runId };
}

// ---- comment-triggered workflows (Plan 3 Task 14b)

/** The partition of an org's comment-trigger opt-outs: one item per (repository, project), listed with one query. */
export function commentTriggerOptOutsPk(orgId: OrgId): string {
  return orgScoped(orgId, "COMMENT_TRIGGER_OPT_OUTS");
}

/** The sort-key prefix of every project's opt-out for one repository (`owner/name`, lower case), for a query on `commentTriggerOptOutsPk`. */
export function commentTriggerOptOutRepositoryPrefix(repository: string): string {
  return `${repository.toLowerCase()}#`;
}

/** An opt-out of the repository-level comment rule for one repository on one project. The repository is `owner/name` (letters, digits, `_`, `.`, `-`: no `#`). */
export function commentTriggerOptOutKey(orgId: OrgId, repository: string, project: string): OrgKey {
  return { pk: commentTriggerOptOutsPk(orgId), sk: `${commentTriggerOptOutRepositoryPrefix(repository)}${project}` };
}

/** The partition of an org's comment-trigger events (an opt-out applied or lapsed); a lapse is also the notice maintainers and admins are shown. */
export function commentTriggerEventsPk(orgId: OrgId): string {
  return orgScoped(orgId, "COMMENT_TRIGGER_EVENTS");
}

/** One event of `kind` ("applied" or "lapsed", so each kind lists on its own); `at` is an instant and `eventId` makes the key unique. */
export function commentTriggerEventKey(orgId: OrgId, kind: "applied" | "lapsed", at: string, eventId: string): OrgKey {
  return { pk: commentTriggerEventsPk(orgId), sk: `EVENT#${kind}#${canonicalInstant(at)}#${eventId}` };
}

/** What one run looked up and keeps for its own length (a repository scan, a connector's label names): one item per (org, task, kind, name). */
export function runCacheKey(orgId: OrgId, taskId: string, kind: string, name: string): OrgKey {
  return { pk: orgScoped(orgId, `RUN_CACHE#${taskId}`), sk: `${kind}#${name}` };
}

/** The partition holding the items a task's agent created during its run (Task 20b): a later change to one of them is the run's own. */
export function agentItemsPk(orgId: OrgId, taskId: string): string {
  return orgScoped(orgId, `AGENT_ITEMS#${taskId}`);
}

/** One item the run created: `<connector>#<value>`, the value as the connector's item path names it. */
export function agentItemKey(orgId: OrgId, taskId: string, connector: string, value: string): OrgKey {
  return { pk: agentItemsPk(orgId, taskId), sk: `${connector}#${value}` };
}

// ---- chains (Plan 4 Task 1)

const CHAIN_VERSION_WIDTH = 6;
const MAX_CHAIN_VERSION = 10 ** CHAIN_VERSION_WIDTH - 1;
const STEP_SEQ_WIDTH = 4;
const RUN_EVENT_SEQ_WIDTH = 6;

export type ChainItemSk = "META" | "DRAFT" | `VERSION#${string}` | `SHARE#${string}` | `EVENT#${string}`;

/** One chain's partition: its META, its DRAFT, immutable versions, shares and events. */
export function chainKey(orgId: OrgId, chainId: ChainId, sk: ChainItemSk): OrgKey {
  return { pk: orgScoped(orgId, `CHAIN#${chainId}`), sk };
}

/** The sort key of a published chain version; six digits keep a query on `VERSION#` in version order. */
export function chainVersionSk(version: number): `VERSION#${string}` {
  if (!Number.isInteger(version) || version < 1 || version > MAX_CHAIN_VERSION) throw new Error(`a chain version is a whole number from 1 to ${MAX_CHAIN_VERSION}`);
  return `VERSION#${String(version).padStart(CHAIN_VERSION_WIDTH, "0")}`;
}

/** The org's chain directory: one item per chain, for listing without reading every partition. */
export function chainDirectoryKey(orgId: OrgId, chainId: ChainId): OrgKey {
  return { pk: orgScoped(orgId, "CHAINS"), sk: chainId };
}

/** The item that makes a chain's name unique in its org, ignoring case and surrounding spaces. */
export function chainNameKey(orgId: OrgId, name: string): OrgKey {
  return { pk: orgScoped(orgId, `CHAIN_NAME#${name.trim().toLowerCase()}`), sk: "META" };
}

export type ChainRunItemSk = "META" | `STEP#${string}` | `EVENT#${string}`;

/** One chain run's partition: its META, one item per step attempt and its event log. */
export function chainRunKey(orgId: OrgId, runId: ChainRunId, sk: ChainRunItemSk): OrgKey {
  return { pk: orgScoped(orgId, `CHAIN_RUN#${runId}`), sk };
}

function paddedSeq(seq: number, width: number, what: string): string {
  const max = 10 ** width - 1;
  if (!Number.isInteger(seq) || seq < 0 || seq > max) throw new Error(`${what} is a whole number from 0 to ${max}`);
  return String(seq).padStart(width, "0");
}

/** The sort key of a step attempt in a run; four digits keep a query on `STEP#` in order. */
export function stepSk(seq: number): `STEP#${string}` {
  return `STEP#${paddedSeq(seq, STEP_SEQ_WIDTH, "a step sequence number")}`;
}

/** The sort key of a run event; six digits keep a query on `EVENT#` in order. */
export function runEventSk(seq: number): `EVENT#${string}` {
  return `EVENT#${paddedSeq(seq, RUN_EVENT_SEQ_WIDTH, "an event sequence number")}`;
}

/** The index item that lists a chain's runs, newest last; `createdAt` is an instant. */
export function chainRunsByChainKey(orgId: OrgId, chainId: ChainId, createdAt: string, runId: ChainRunId): OrgKey {
  return { pk: chainRunsByChainPk(orgId, chainId), sk: `${canonicalInstant(createdAt)}#${runId}` };
}

/** The partition of a chain's run index: a list of the chain's runs queries it. */
export function chainRunsByChainPk(orgId: OrgId, chainId: ChainId): string {
  return orgScoped(orgId, `CHAIN_RUNS#${chainId}`);
}

/** The index item that lists a project's chain runs, newest last; `createdAt` is an instant. */
export function chainRunsByProjectKey(orgId: OrgId, project: string, createdAt: string, runId: ChainRunId): OrgKey {
  return { pk: chainRunsByProjectPk(orgId, project), sk: `${canonicalInstant(createdAt)}#${runId}` };
}

/** The partition of a project's chain-run index: a list of the project's runs queries it. */
export function chainRunsByProjectPk(orgId: OrgId, project: string): string {
  return orgScoped(orgId, `CHAIN_RUNS_P#${project}`);
}

/**
 * The global index of chain runs still open, in the order they are next due (ids only: the item names the org and the run, and a reader
 * re-checks `orgId` on the record it points at). `dueAt` is an instant.
 */
export function openChainRunKey(dueAt: string, orgId: OrgId, runId: ChainRunId): OrgKey {
  return { pk: "OPEN_CHAIN_RUNS", sk: `${canonicalInstant(dueAt)}#${orgId}#${runId}` };
}

// ---- triggers (Plan 4 Task 18)

/** The name a trigger's target goes by in keys: `CHAIN#<id>` or `AGENT#<id>`. */
export function triggerTargetKey(target: TriggerTarget): string {
  return target.kind === "chain" ? `CHAIN#${target.chainId}` : `AGENT#${target.agentId}`;
}

/** A trigger's record. */
export function triggerKey(orgId: OrgId, triggerId: string): OrgKey {
  return { pk: orgScoped(orgId, `TRIGGER#${triggerId}`), sk: "META" };
}

/** The index item that lists a target's triggers (`targetKey` is `triggerTargetKey(target)`), and its counter at `COUNT`. */
export function targetTriggersKey(orgId: OrgId, targetKey: string, triggerId: string): OrgKey {
  return { pk: orgScoped(orgId, `TARGET_TRIGGERS#${targetKey}`), sk: triggerId };
}

/** The counter of a target's triggers, beside the index items: a transaction that adds a trigger is held to `MAX_TRIGGERS_PER_TARGET` by it. */
export function targetTriggerCountKey(orgId: OrgId, targetKey: string): OrgKey {
  return { pk: orgScoped(orgId, `TARGET_TRIGGERS#${targetKey}`), sk: "COUNT" };
}

/** The index item that lists the triggers a member created, so a removed or merged member's can be found. */
export function triggersByCreatorKey(orgId: OrgId, developerId: string, triggerId: string): OrgKey {
  return { pk: orgScoped(orgId, `TRIGGERS_BY_CREATOR#${developerId}`), sk: triggerId };
}

/** The index item dispatch reads: the triggers of the receiving hook only (`hookId` is `"github"` for GitHub's, which have none). */
export function triggerMatchKey(orgId: OrgId, source: EventSource, project: string, hookId: string, triggerId: string): OrgKey {
  return { pk: orgScoped(orgId, `TRIGGERS#${source}#${project}#${hookId}`), sk: triggerId };
}

/**
 * The global list of schedule triggers whose schedule the scheduler does not hold as the trigger says (`scheduleStatus: "pending"`), for the sweep that repairs them. Like the
 * open-run list it names the org and the trigger and nothing else: a reader reads the record under that org's own key.
 */
export function pendingTriggerScheduleKey(orgId: OrgId, triggerId: string): OrgKey {
  return { pk: "PENDING_TRIGGER_SCHEDULES", sk: `${orgId}#${triggerId}` };
}

/** One thing a trigger did or was told, newest last; it expires with `TRIGGER_ACTIVITY_TTL_DAYS`. */
export function triggerActivityKey(orgId: OrgId, triggerId: string, at: string, eventKey: string): OrgKey {
  return { pk: orgScoped(orgId, `TRIGGER_ACTIVITY#${triggerId}`), sk: `${canonicalInstant(at)}#${eventKey}` };
}

/** A notice stored for a member to be shown (Plan 7) and posted (Plan 9), as Plan 3 stores budget alerts. */
export function triggerNoticeKey(orgId: OrgId, developerId: string, at: string, triggerId: string): OrgKey {
  return { pk: orgScoped(orgId, `TRIGGER_NOTICES#${developerId}`), sk: `${canonicalInstant(at)}#${triggerId}` };
}

// ---- the limits dispatch counts against (Plan 4 Task 20)

/** The count of runs one trigger started in one UTC hour (`hour` is `YYYY-MM-DDTHH`); it expires after two hours. */
export function triggerRateKey(orgId: OrgId, triggerId: string, hour: string): OrgKey {
  return { pk: orgScoped(orgId, `TRIGGER_RATE#${triggerId}`), sk: hour };
}

/** The count of runs events and schedules started for the whole org in one UTC day (`day` is `YYYY-MM-DD`); it expires after two days. */
export function orgAutonomousKey(orgId: OrgId, day: string): OrgKey {
  return { pk: orgScoped(orgId, "ORG_AUTONOMOUS"), sk: day };
}

/**
 * The note that one trigger started a run for one subject (a pull request, an issue, an incident...) and when: the sort key is the SHA-256 of what names the subject. Dispatch
 * reads it so that an event on the subject the trigger's own run may have caused is not started again within `TRIGGER_SUBJECT_GUARD_MINUTES`; it expires after two hours.
 */
export function triggerSubjectKey(orgId: OrgId, triggerId: string, subject: { kind: string; id: string; url?: string | undefined }): OrgKey {
  return { pk: orgScoped(orgId, `TRIGGER_SUBJECT#${triggerId}`), sk: createHash("sha256").update(`${subject.kind}\0${subject.id}\0${subject.url ?? ""}`, "utf8").digest("hex") };
}

// ---- agent sessions (Plan 5 Task 1)

/** A key segment: never empty and never holds the `#` that separates segments, so one segment can't be read as two. */
function keyPart(value: string, what: string): string {
  if (value.length === 0 || value.includes("#") || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error(`${what} can't be empty or hold a "#" or a control character`);
  return value;
}

const SESSION_COUNTER_WIDTH = 6;

function paddedCounter(value: number, what: string): string {
  if (!Number.isInteger(value) || value < 0 || value >= 10 ** SESSION_COUNTER_WIDTH) throw new Error(`${what} is a whole number from 0 to ${String(10 ** SESSION_COUNTER_WIDTH - 1)}`);
  return String(value).padStart(SESSION_COUNTER_WIDTH, "0");
}

/** The sort keys inside one session's partition. Events sort by time, then id (`sessionEventSk`); legs by number (`sessionLegSk`). */
export type AgentSessionItemSk =
  | "META"
  | `SHARE#${string}`
  | `FOLLOWER#${string}`
  | `PRESENCE#${string}`
  | `MESSAGE#${string}`
  | `TURN#${string}`
  | "LOCAL"
  | `EVENT#${string}`
  | `LEG#${string}`
  | `TAKE_OVER_FOLLOW_UP#${string}`
  | `REQUEST#${string}`
  | `HANDOFF_PENDING#${string}`
  | `ASK#${string}`
  | `ASKREQ#${string}`
  | `ASKLOCK#${string}`
  | "RETRIED";

/** One session's partition: its META header, shares, followers, who is looking now, messages, local turns, events, legs and the marks a take-over owes (`TAKE_OVER_FOLLOW_UP#<approvalId>`), the requests a stop or retry answered (`REQUEST#<requestId>`) and the one retry a session had (`RETRIED`). */
export function agentSessionKey(orgId: OrgId, sessionId: SessionId, sk: AgentSessionItemSk): OrgKey {
  return { pk: orgScoped(orgId, `AGENT_SESSION#${keyPart(sessionId, "a session id")}`), sk };
}

/** Live interaction A5: one "Ask about this task" record, `ASK#<askId>`, in the session's own partition. */
export function sessionAskKey(orgId: OrgId, sessionId: SessionId, askId: string): OrgKey {
  return agentSessionKey(orgId, sessionId, `ASK#${keyPart(askId, "an ask id")}`);
}

/**
 * Live interaction A3: an Ask that is waiting for the chat service to answer it (`ASKREQ#<askId>`, in the session's partition). It holds ids and the state only, never the question (the
 * question travels in the queue message), and expires on its own.
 */
export function askRequestKey(orgId: OrgId, sessionId: SessionId, askId: string): OrgKey {
  return agentSessionKey(orgId, sessionId, `ASKREQ#${keyPart(askId, "an ask id")}`);
}

/** The one-at-a-time lock of a person's Asks on a session (`ASKLOCK#<developerId>`): held while one of their Asks is being answered, and it expires on its own. */
export function askLockKey(orgId: OrgId, sessionId: SessionId, developerId: string): OrgKey {
  return agentSessionKey(orgId, sessionId, `ASKLOCK#${keyPart(developerId, "a developer id")}`);
}

/** The index of the Asks a person asked, so erasing the person finds them: partition `ASKBY#<developerId>`, one item per Ask. It holds ids only and goes with the Ask. */
export function askByPersonKey(orgId: OrgId, developerId: string, sessionId: SessionId, askId: string): OrgKey {
  return { pk: askByPersonPk(orgId, developerId), sk: `${keyPart(sessionId, "a session id")}#${keyPart(askId, "an ask id")}` };
}

/** The partition of one person's Ask index (what erasing the person queries). */
export function askByPersonPk(orgId: OrgId, developerId: string): string {
  return orgScoped(orgId, `ASKBY#${keyPart(developerId, "a developer id")}`);
}

/**
 * The index of the Asks whose stored text names a person by their fixed label (`p_` and six hex digits), so erasing that person finds the other people's answers that mention them. Partition
 * `ASKMENTION#<tag>`; ids only.
 */
export function askMentionKey(orgId: OrgId, personTag: string, sessionId: SessionId, askId: string): OrgKey {
  return { pk: askMentionPk(orgId, personTag), sk: `${keyPart(sessionId, "a session id")}#${keyPart(askId, "an ask id")}` };
}

/** The partition of the Asks that mention one person label (what erasing that person queries). */
export function askMentionPk(orgId: OrgId, personTag: string): string {
  return orgScoped(orgId, `ASKMENTION#${keyPart(personTag, "a person tag")}`);
}

/**
 * The expiry bucket of the Asks that expire on one day (`YYYY-MM-DD`): partition `ASKEXP#<day>`. The State table deletes by TTL only in named environments, so the 30 days are enforced by a sweep
 * that reads these buckets; ids only.
 */
export function askExpiryKey(orgId: OrgId, day: string, sessionId: SessionId, askId: string): OrgKey {
  return { pk: askExpiryPk(orgId, day), sk: `${keyPart(sessionId, "a session id")}#${keyPart(askId, "an ask id")}` };
}

/**
 * Public edition: the number of Asks a project had on one UTC day (`YYYY-MM-DD`), one item per project in the day's partition `ASKCOUNT#<day>`. The daily audit event is made from it once the day is over. A count and a
 * project name only; it expires on its own.
 */
export function askCountKey(orgId: OrgId, day: string, project: string): OrgKey {
  return { pk: askCountPk(orgId, day), sk: keyPart(project, "a project name") };
}

/** The partition of one day's Ask counts. */
export function askCountPk(orgId: OrgId, day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) throw new Error("a count day is YYYY-MM-DD");
  return orgScoped(orgId, `ASKCOUNT#${day}`);
}

/**
 * The aliases of an erased person that an Ask still being answered must not write (`ASKERASED#`, one item per erased person, keyed by their person label tag `p_xxxxxx`, never their developer id; kept at most
 * `ASK_RETENTION_DAYS` days; see register LI-2 in the lane report). The partition is the org's.
 */
export function askErasedAliasKey(orgId: OrgId, personTag: string): OrgKey {
  return { pk: askErasedAliasPk(orgId), sk: keyPart(personTag, "a person tag") };
}

/** The partition of an org's erased-person aliases. */
export function askErasedAliasPk(orgId: OrgId): string {
  return orgScoped(orgId, "ASKERASED");
}

/**
 * Live interaction L1: the note that a Linear comment was handled (answered, or told the link), so the same delivery again does nothing twice. One item per comment id, ids only, expires on its own. The
 * partition is the org's.
 */
export function askLinearCommentKey(orgId: OrgId, commentId: string): OrgKey {
  return { pk: orgScoped(orgId, "ASKLINEAR"), sk: keyPart(commentId, "a Linear comment id") };
}

/**
 * Lane ask-linear: a comment Rovara posted on a Linear issue that has to be rewritten because the person it names was erased. One item per Ask (`<sessionId>#<askId>`), in the org's `ASKLINEARFIX`
 * partition: ids only (the comment's id and issue), never words. The ask maintenance run reads the partition, rewrites the comment from the Ask's already-scrubbed record, and removes the item.
 */
export function askLinearScrubKey(orgId: OrgId, sessionId: SessionId, askId: string): OrgKey {
  return { pk: askLinearScrubPk(orgId), sk: `${keyPart(sessionId, "a session id")}#${keyPart(askId, "an ask id")}` };
}

/**
 * Lane ask-linear: the lasting record of a Linear comment that could not be rewritten after an erase (given up after the bounded tries). One item per Ask in the org's `ASKLINEARKEPT` partition, for an
 * admin to read: ids, a fixed reason word and counts only, never words. It is kept for a year.
 */
export function askLinearKeptKey(orgId: OrgId, sessionId: SessionId, askId: string): OrgKey {
  return { pk: askLinearKeptPk(orgId), sk: `${keyPart(sessionId, "a session id")}#${keyPart(askId, "an ask id")}` };
}

/** The partition of the comments Rovara could not rewrite. */
export function askLinearKeptPk(orgId: OrgId): string {
  return orgScoped(orgId, "ASKLINEARKEPT");
}

/** The partition of the Linear comments that wait to be rewritten (what the ask maintenance run queries). */
export function askLinearScrubPk(orgId: OrgId): string {
  return orgScoped(orgId, "ASKLINEARFIX");
}

/**
 * Live interaction F2: the partition of one diagnosis (`DIAGNOSIS#<id>`): its request (`REQUEST`, ids, the state and, while it waits, the context text), its result (`RECORD`) and the link to the
 * person who asked (`PERSON`, kept apart so erasure removes the person and keeps the diagnosis).
 */
export function diagnosisKey(orgId: OrgId, diagnosisId: string, part: "REQUEST" | "RECORD" | "PERSON"): OrgKey {
  return { pk: orgScoped(orgId, `DIAGNOSIS#${keyPart(diagnosisId, "a diagnosis id")}`), sk: part };
}

/** The index of the diagnoses a person asked for (`DIAGNOSISBY#<developerId>`, one item per diagnosis), so erasing the person finds their person-link rows. Ids only. */
export function diagnosisByPersonKey(orgId: OrgId, developerId: string, diagnosisId: string): OrgKey {
  return { pk: diagnosisByPersonPk(orgId, developerId), sk: keyPart(diagnosisId, "a diagnosis id") };
}

/** The partition of one person's diagnosis index. */
export function diagnosisByPersonPk(orgId: OrgId, developerId: string): string {
  return orgScoped(orgId, `DIAGNOSISBY#${keyPart(developerId, "a developer id")}`);
}

/** "One open diagnosis per ErrorRef": the item that says a tier's diagnosis for this error (`errorRefKey`) is open until an hour has passed. The partition is the org's. */
export function diagnosisOpenKey(orgId: OrgId, tier: "light" | "deep", errorKey: string): OrgKey {
  return { pk: orgScoped(orgId, "DIAGNOSISOPEN"), sk: `${tier}#${keyPart(errorKey, "an error key")}` };
}

/** The fixed-window counters of diagnoses: `light_person#<id>` (an hour), `light_project#<name>` (a day) and `deep_person#<id>` (a day). The partition is the org's. (2026-11-03: `light_org#all`, the Rovara-paid org day counter, is gone; customers pay for diagnoses.) */
export function diagnosisRateKey(orgId: OrgId, kind: "light_person" | "light_project" | "deep_person", subject: string): OrgKey {
  return { pk: orgScoped(orgId, "DIAGNOSISRATE"), sk: `${kind}#${keyPart(subject, "a rate subject")}` };
}

/** The partition of one day's expiring Asks. */
export function askExpiryPk(orgId: OrgId, day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) throw new Error("an expiry day is YYYY-MM-DD");
  return orgScoped(orgId, `ASKEXP#${day}`);
}

/** A local session's transcript line, `TURN#<number>`; six digits keep a query on `TURN#` in order. */
export function sessionTurnSk(seq: number): `TURN#${string}` {
  return `TURN#${paddedCounter(seq, "a turn number")}`;
}

/** An event's sort key: `EVENT#<instant>#<eventId>`, so a query on `EVENT#` reads them in order. */
export function sessionEventSk(at: string, eventId: string): `EVENT#${string}` {
  return `EVENT#${canonicalInstant(at)}#${keyPart(eventId, "an event id")}`;
}

/** A leg's sort key; six digits keep a query on `LEG#` in leg order. */
export function sessionLegSk(seq: number): `LEG#${string}` {
  return `LEG#${paddedCounter(seq, "a leg number")}`;
}

/** The org's live index: one item per open session (and recently ended ones), keyed by session id. */
export function liveSessionKey(orgId: OrgId, sessionId: SessionId): OrgKey {
  return { pk: orgScoped(orgId, "LIVE_SESSIONS"), sk: keyPart(sessionId, "a session id") };
}

/**
 * Who is looking at which session, for the whole org, so the Live wall reads every tile's viewers in one query instead of one per session: one item per (session, person), written
 * by the same heartbeat as the session's own presence item and expiring with it. Display only; the session's own `PRESENCE#` items stay what a session's view reads.
 */
export function livePresenceKey(orgId: OrgId, sessionId: SessionId, developerId: string): OrgKey {
  return { pk: orgScoped(orgId, "LIVE_PRESENCE"), sk: `${keyPart(sessionId, "a session id")}#${keyPart(developerId, "a developer id")}` };
}

/** The sessions one person owns, newest last; `createdAt` is an instant. */
export function mySessionsKey(orgId: OrgId, developerId: string, createdAt: string, sessionId: SessionId): OrgKey {
  return { pk: orgScoped(orgId, `MY_SESSIONS#${keyPart(developerId, "a developer id")}`), sk: `${canonicalInstant(createdAt)}#${keyPart(sessionId, "a session id")}` };
}

/**
 * The cards one person dismissed from Home (Plan 5 Task 15), one item per card, in a partition of their own: a person's dismissals are read in one query and are never another person's.
 * `cardId` is `<kind>:<id>`.
 */
export function homeDismissedKey(orgId: OrgId, developerId: string, cardId: string): OrgKey {
  return { pk: orgScoped(orgId, `HOME_DISMISSED#${keyPart(developerId, "a developer id")}`), sk: keyPart(cardId, "a card id") };
}

/** The sessions on one project, newest last; `createdAt` is an instant. */
export function projectSessionsKey(orgId: OrgId, project: string, createdAt: string, sessionId: SessionId): OrgKey {
  return { pk: orgScoped(orgId, `PROJECT_SESSIONS#${keyPart(project, "a project name")}`), sk: `${canonicalInstant(createdAt)}#${keyPart(sessionId, "a session id")}` };
}

/** The sessions shared with one principal (a member, a project or the org), for "Shared with me". */
export function sharedSessionsKey(orgId: OrgId, principal: AgentPrincipal, sessionId: SessionId): OrgKey {
  return { pk: orgScoped(orgId, `SHARED_SESSIONS#${principalKey(principal)}`), sk: keyPart(sessionId, "a session id") };
}

/** The item that remembers what one request on a session did (R18): one per (org, developer, request id), written in the change's own transaction. */
export function sessionRequestKey(orgId: OrgId, developerId: string, requestId: string): OrgKey {
  return { pk: orgScoped(orgId, `SESSION_REQUEST#${keyPart(developerId, "a developer id")}`), sk: keyPart(requestId, "a request id") };
}

/**
 * The item that counts one person's comments (`kind` "comment") or changes to them ("change") on one session in the current ten-minute window, or their messages to the agent
 * ("steer") in the current hour: `<kind>#<developerId>` in the session's rate partition. `steer_all` counts every person's messages to the agent on the session (its `developerId` is the word `session`).
 */
export function sessionRateKey(orgId: OrgId, sessionId: SessionId, developerId: string, kind: "comment" | "change" | "steer" | "steer_all" | "local_update" | "local_status" | "local_stop" | "ask" | "ask_day" | "ask_spent"): OrgKey {
  return { pk: orgScoped(orgId, `SESSION_RATE#${keyPart(sessionId, "a session id")}`), sk: `${kind}#${keyPart(developerId, "a developer id")}` };
}

/**
 * The count of a session's messages to the agent that are still queued (not yet taken by a step or answered), in the session's own partition. It goes up in the transaction that writes
 * a queued message and down in the one that answers it, so "nothing is queued" is one read, and it sits among the messages so retention reaches it (its sort key is not a message's).
 */
export function sessionQueuedSteersKey(orgId: OrgId, sessionId: SessionId): OrgKey {
  return agentSessionKey(orgId, sessionId, "MESSAGE#QUEUED");
}

/** What one task has cost so far, added to when a model key settles, so a session shows cost without summing keys. */
export function taskSpendKey(orgId: OrgId, taskId: string): OrgKey {
  return { pk: orgScoped(orgId, `TASK_SPENT#${keyPart(taskId, "a task id")}`), sk: "META" };
}

/** The global list of open sessions, swept every few minutes. A named exception to org scoping: ids and the org only; a reader re-checks `orgId` on the record. */
export function openAgentSessionKey(orgId: OrgId, sessionId: SessionId): OrgKey {
  return { pk: "OPEN_AGENT_SESSIONS", sk: `${orgId}#${keyPart(sessionId, "a session id")}` };
}

/** The global list of sessions that ended on one UTC day (`day` is `YYYY-MM-DD`), for the retention job. Ids and the org only. */
export function endedSessionWorkKey(day: string, orgId: OrgId, sessionId: SessionId): OrgKey {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00.000Z`))) throw new Error("a day is YYYY-MM-DD");
  return { pk: `ENDED_AGENT_SESSIONS#${day}`, sk: `${orgId}#${keyPart(sessionId, "a session id")}` };
}

/** Where the sweep remembers how far it got. A global item holding no org. */
export const SESSION_SWEEP_CURSOR_KEY: OrgKey = { pk: "SESSION_SWEEP_CURSOR", sk: "META" };

/**
 * A session's own record of an outside place it follows (`BINDING#<kind>`: `slack_thread`, `linear_issue` or `tracker_item`), in a partition of its own, not the session's. The Slack notifier writes it, and
 * an IAM grant can limit a writer by partition key only, so keeping it out of the session partition keeps that role away from the session's META, shares and everything else in it.
 */
export function sessionBindingKey(orgId: OrgId, sessionId: SessionId, kind: SessionBinding["kind"]): OrgKey {
  return { pk: orgScoped(orgId, `SESSION_BINDING#${keyPart(sessionId, "a session id")}`), sk: `BINDING#${kind}` };
}

/** The item that binds one outside surface (a Slack thread, a Linear issue or a tracker ticket) to one session: one binding per surface per org. */
export function sessionSurfaceKey(orgId: OrgId, binding: SessionBinding): OrgKey {
  const sk = binding.kind === "slack_thread"
    ? `SLACK#${keyPart(binding.teamId, "a Slack team")}#${keyPart(binding.channelId, "a Slack channel")}#${keyPart(binding.threadTs, "a thread")}`
    : binding.kind === "linear_issue"
      ? `LINEAR#${keyPart(binding.issueId, "an issue id")}`
      // A Linear issue is one surface whichever door it came in by: the `linear_issue` binding and the `tracker_item` binding that names the `linear` system share this item, so one issue follows
      // one session (P9). The key is the issue's key in capitals, as the Linear binder writes it.
      : binding.system === "linear"
        ? `LINEAR#${keyPart(binding.id.toUpperCase(), "an issue id")}`
        : `TRACKER#${keyPart(binding.system, "a tracker system")}#${keyPart(binding.id, "a ticket id")}`;
  return { pk: orgScoped(orgId, "SESSION_SURFACE"), sk };
}

/** One person's change notice (ids only), kept for the catch-up feed; `at` is an instant and `n` orders notices written in one instant. */
export function changesKey(orgId: OrgId, developerId: string, at: string, n: number): OrgKey {
  return { pk: orgScoped(orgId, `CHANGES#${keyPart(developerId, "a developer id")}`), sk: `${canonicalInstant(at)}#${paddedCounter(n, "a notice number")}` };
}

/** A project's session counts for one UTC month (`month` is `YYYY-MM`). */
export function projectMonthStatsKey(orgId: OrgId, project: string, month: string): OrgKey {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(month)) throw new Error("a month is YYYY-MM");
  return { pk: orgScoped(orgId, `PROJECT_SESSION_STATS#${keyPart(project, "a project name")}`), sk: month };
}

/** A script token's record (UX5b): its hash, scope and life. Read on every request the token makes. */
export function scriptTokenKey(orgId: OrgId, tokenId: string): OrgKey {
  return { pk: orgScoped(orgId, `SCRIPT_TOKEN#${keyPart(tokenId, "a script token id")}`), sk: "META" };
}

/** The company's list of script tokens, one row per token (who made it), for the settings screen and the per-person limit. */
export function orgScriptTokensKey(orgId: OrgId, tokenId: string): OrgKey {
  return { pk: orgScoped(orgId, "SCRIPT_TOKENS"), sk: keyPart(tokenId, "a script token id") };
}

// ---- Rovara Code (Plan 6 Task 1)

/** A project's code settings (self-approval, merge method, reviewers). */
export function codeSettingsKey(orgId: OrgId, project: string): OrgKey {
  return { pk: orgScoped(orgId, `CODE_SETTINGS#${keyPart(project, "a project name")}`), sk: "META" };
}

/** A project's playbook ("How we work"): the process the project runs by default. */
export function projectPlaybookKey(orgId: OrgId, project: string): OrgKey {
  return { pk: orgScoped(orgId, `PROJECT_PLAYBOOK#${keyPart(project, "a project name")}`), sk: "META" };
}

/** The partition holding everything the learning loop keeps for one project: its corrections, suggestions, rules and counters. */
export function projectLearningPk(orgId: OrgId, project: string): string {
  return orgScoped(orgId, `PROJECT_LEARNING#${keyPart(project, "a project name")}`);
}

/** One item of a project's learning partition (`STATE`, `CORRECTION#<createdAt>#<id>`, `SUGGESTION#<id>`, ...). The sort key is the caller's, so it is checked to stay one segment list. */
export function projectLearningKey(orgId: OrgId, project: string, sk: string): OrgKey {
  if (sk.length === 0 || /[\p{Cc}\p{Cf}]/u.test(sk)) throw new Error("a learning sort key can't be empty or hold a control character");
  return { pk: projectLearningPk(orgId, project), sk };
}

/** The resume point of a company-wide learning walk (`close`, `sweep`, `erase#<developerId>`); outside the project partitions, and it holds no text. */
export function learningWalkKey(orgId: OrgId, kind: string): OrgKey {
  if (kind.length === 0 || /[\p{Cc}\p{Cf}]/u.test(kind)) throw new Error("a learning walk kind can't be empty or hold a control character");
  return { pk: orgScoped(orgId, "LEARNING_WALK"), sk: kind };
}

/** How long recent tasks of one project took, per path (`QUICK` or `FULL`), for the plan's time estimate. */
export function durationHistoryKey(orgId: OrgId, project: string, path: "QUICK" | "FULL"): OrgKey {
  return { pk: orgScoped(orgId, `DURATION_HISTORY#${keyPart(project, "a project name")}`), sk: path };
}

/** Which member of the org a GitHub account (by its numeric id) is linked to, for telling an approval from a requester's. */
export function githubMemberKey(orgId: OrgId, githubUserId: string): OrgKey {
  return { pk: orgScoped(orgId, `GITHUB_MEMBER#${keyPart(githubUserId, "a GitHub user id")}`), sk: "META" };
}

/** The GitHub account a member of the org linked, the other way round from `githubMemberKey`. */
export function memberGithubKey(orgId: OrgId, developerId: string): OrgKey {
  return { pk: orgScoped(orgId, `MEMBER_GITHUB#${keyPart(developerId, "a developer id")}`), sk: "META" };
}

/** The setup draft Rovara wrote for a project, waiting for a maintainer. */
export function setupDraftKey(orgId: OrgId, project: string): OrgKey {
  return { pk: orgScoped(orgId, `SETUP_DRAFT#${keyPart(project, "a project name")}`), sk: "META" };
}

/** The company's locks on setup (SH29: the setup run's limits and the other locks), one row per company. */
export function setupLocksKey(orgId: OrgId): OrgKey {
  return { pk: orgScoped(orgId, "SETUP_LOCKS"), sk: "META" };
}

/** A project's own limits for a setup run, in the project's setup partition beside the run's pointer (so a walk that removes the project's setup items finds it). */
export function setupLimitsKey(orgId: OrgId, project: string): OrgKey {
  return { pk: setupDraftKey(orgId, project).pk, sk: "LIMITS" };
}

/** One person's discarded work, kept 7 days. */
export function trashKey(orgId: OrgId, developerId: string, taskId: string): OrgKey {
  return { pk: orgScoped(orgId, `TRASH#${keyPart(developerId, "a developer id")}`), sk: keyPart(taskId, "a task id") };
}

/**
 * Which Rovara task a GitHub pull request was merged as (SRL-3): one partition for the company, one item for each repository and merge commit (both lower-cased), so a revert that names a
 * commit finds the pull request, a commit id is never looked up across companies, and the company's close erases the whole partition without first finding its repositories.
 */
export function mergeCommitIndexKey(orgId: OrgId, repositoryFullName: string, mergeCommit: string): OrgKey {
  return { pk: orgScoped(orgId, "GITHUB_MERGE"), sk: `${keyPart(repositoryFullName, "a repository name").toLowerCase()}#${keyPart(mergeCommit, "a commit").toLowerCase()}` };
}

/** Which task a pull request head belongs to, so a check or status event that carries only a commit finds its task. */
export function prHeadKey(orgId: OrgId, repositoryId: string, headSha: string): OrgKey {
  return { pk: orgScoped(orgId, `PR_HEAD#${keyPart(repositoryId, "a repository id")}`), sk: keyPart(headSha, "a commit") };
}

/**
 * Items in the task's own partition (`DEVTASK#<taskId>`, a named exception to org scoping like the task itself): the items carry `orgId` and a reader
 * re-checks it. One tracking item per pull request of the task.
 */
export function mergeTrackingKey(taskId: string, repositoryId: string, number: number): { pk: string; sk: string } {
  if (!Number.isInteger(number) || number <= 0) throw new Error("a pull request number is a positive whole number");
  return { pk: `DEVTASK#${keyPart(taskId, "a task id")}`, sk: `MERGE_TRACKING#${keyPart(repositoryId, "a repository id")}#${String(number)}` };
}

/**
 * A reminder one reviewer was sent about one pull request (Plan 6 Task 18), in the reviewer's own partition of the org: Home reads it to show the reviewer the pull request
 * that waits for them. One item per reviewer and pull request.
 */
export function reviewWaitKey(orgId: OrgId, developerId: string, taskId: string, repositoryId: string, number: number): OrgKey {
  if (!Number.isInteger(number) || number <= 0) throw new Error("a pull request number is a positive whole number");
  return { pk: orgScoped(orgId, `REVIEW_WAIT#${keyPart(developerId, "a developer id")}`), sk: `${keyPart(taskId, "a task id")}#${keyPart(repositoryId, "a repository id")}#${String(number)}` };
}

/** Who one pull request's reminders went to, in the task's own partition (it carries `orgId`, and a reader re-checks it): so a reminder can be taken away when it no longer applies. */
export function reviewNudgeLedgerKey(taskId: string, repositoryId: string, number: number): { pk: string; sk: string } {
  if (!Number.isInteger(number) || number <= 0) throw new Error("a pull request number is a positive whole number");
  return { pk: `DEVTASK#${keyPart(taskId, "a task id")}`, sk: `REVIEW_NUDGE#${keyPart(repositoryId, "a repository id")}#${String(number)}` };
}

/** One milestone of a task: the `n`th of its kind (`n` from 0; six digits keep them in order). */
export function codeMilestoneKey(taskId: string, kind: string, n: number): { pk: string; sk: string } {
  return { pk: `DEVTASK#${keyPart(taskId, "a task id")}`, sk: `CODE_MILESTONE#${keyPart(kind, "a milestone kind")}#${paddedCounter(n, "a milestone number")}` };
}

// ---- meta repo lane F: task intake

/**
 * The id of one ticket in its project's intake partition: the first 32 hex characters of the SHA-256 of `<system> NUL <id>`. The same ticket is always the same id, which is the
 * dedupe by `externalRef`; the id is what a route names, so a ticket's own text never goes into a path.
 */
export function intakeItemIdOf(system: string, id: string): string {
  return createHash("sha256").update(`${keyPart(system, "a tracker system")}\0${keyPart(id, "a ticket id")}`).digest("hex").slice(0, 32);
}

/**
 * One ticket an intake channel handed over, in its project's partition of the org. It says whether the ticket waits for a member, is starting or has started a session. Listing a
 * project's waiting items is one query on the partition.
 */
export function intakeItemKey(orgId: OrgId, project: string, itemId: string): OrgKey {
  if (!/^[a-f0-9]{32}$/u.test(itemId)) throw new Error("an intake item id is 32 hex characters");
  return { pk: orgScoped(orgId, `INTAKE_ITEM#${keyPart(project, "a project name")}`), sk: itemId };
}

/**
 * One intake source (a place work is asked for, turned on by a maintainer's approval), in a global partition with the org and project in the sort key, so the poll finds every due
 * source with one query (the same shape as the open-session list). A project's own sources are the ones whose sort key begins with `<org>#<project>#`.
 */
export function intakeSourceKey(orgId: OrgId, project: string, sourceId: string): OrgKey {
  return { pk: "INTAKE_SOURCES", sk: `${orgId}#${keyPart(project, "a project name")}#${keyPart(sourceId, "a source id")}` };
}

/** How many sources a project holds, kept beside them so that the most a project may have is enforced in one conditional update (two applies at once cannot both take the last place). */
export function intakeSourceCountKey(orgId: OrgId, project: string): OrgKey {
  return { pk: orgScoped(orgId, "INTAKE_SOURCE_COUNT"), sk: keyPart(project, "a project name") };
}

/** What the poll counts a source's reads in, per hour (`hour` is `YYYY-MM-DDTHH`): the cap on reads an hour is a conditional count on this item. */
export function intakeCallsKey(orgId: OrgId, sourceId: string, hour: string): OrgKey {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/u.test(hour)) throw new Error("an hour is YYYY-MM-DDTHH");
  return { pk: orgScoped(orgId, `INTAKE_CALLS#${keyPart(sourceId, "a source id")}`), sk: hour };
}

/**
 * A notice to one maintainer that an intake source keeps failing (the poll could not read it for an hour), in the maintainer's own partition of the org like a trigger's notice
 * (`triggerNoticeKey`): fixed words and ids only. One per source and maintainer per notice window.
 */
export function intakeNoticeKey(orgId: OrgId, developerId: string, at: string, sourceId: string): OrgKey {
  return { pk: orgScoped(orgId, `INTAKE_NOTICES#${keyPart(developerId, "a developer id")}`), sk: `${canonicalInstant(at)}#${keyPart(sourceId, "a source id")}` };
}

/** Slice 5: the project's ticket updates settings (comments on the ticket that started a task, and the opt-in status changes). One item per project. */
export function ticketUpdatesSettingsKey(orgId: OrgId, project: string): OrgKey {
  return { pk: orgScoped(orgId, "TICKET_UPDATES"), sk: keyPart(project, "a project name") };
}

/** Slice 5: how many ticket updates the org sent to one tracker (`system`: linear, jira or github) in one hour (`YYYY-MM-DDTHH`): the rate limit is a conditional count on this item. */
export function ticketUpdateCallsKey(orgId: OrgId, system: string, hour: string): OrgKey {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/u.test(hour)) throw new Error("an hour is YYYY-MM-DDTHH");
  return { pk: orgScoped(orgId, "TICKET_UPDATE_CALLS"), sk: `${keyPart(system, "a tracker")}#${hour}` };
}

/** Slice 5: the last time a ticket update was skipped because the org's connection to a tracker may not write (or the tracker refused it). Ids and a code only. */
export function ticketWriteAccessKey(orgId: OrgId, system: string): OrgKey {
  return { pk: orgScoped(orgId, "TICKET_WRITE_ACCESS"), sk: keyPart(system, "a tracker") };
}

/**
 * A ticket's label event that intake has taken in (one item per event), so a webhook that is delivered again, or replayed, is the same event and starts nothing more. `eventId` is the
 * event's own key (the label added, the change, the time); it is hashed here, so nothing a person typed is a key.
 */
export function intakeEventKey(orgId: OrgId, project: string, itemId: string, eventId: string): OrgKey {
  if (!/^[a-f0-9]{32}$/u.test(itemId)) throw new Error("an intake item id is 32 hex characters");
  if (eventId.length === 0) throw new Error("an event id can't be empty");
  return { pk: orgScoped(orgId, `INTAKE_EVENT#${keyPart(project, "a project name")}`), sk: `${itemId}#${createHash("sha256").update(eventId, "utf8").digest("hex").slice(0, 32)}` };
}

/**
 * A tracker act (a label added, or an assignee set, by one Jira changelog change) that intake has acted on for a company, one item per company, site, change and act, whichever project's hook
 * or poll it came through. It is how a real act that a person made is started from once: the same act handed to a second project (a replay by someone who holds that hook's secret) finds it
 * taken. The act (its kind and value) is part of the key because one change may add several labels, each a separate request. `site` is the tracker's host and `changeId` the tracker's own id
 * for the change; all are hashed together here, so nothing a sender typed is a key.
 */
export function intakeChangeKey(orgId: OrgId, system: string, site: string, changeId: string, act: { kind: string; value: string }): OrgKey {
  if (site.length === 0 || changeId.length === 0 || act.kind.length === 0 || act.value.length === 0) throw new Error("a tracker site, a change id and an act can't be empty");
  return { pk: orgScoped(orgId, `INTAKE_CHANGE#${keyPart(system, "a tracker system")}`), sk: createHash("sha256").update(`${site.toLowerCase()}\0${changeId}\0${act.kind}\0${act.value}`, "utf8").digest("hex").slice(0, 40) };
}

/**
 * A note that Rovara itself wrote to a ticket (a label, an assignment, or any other change), so that the event the tracker sends back for it is told apart from a member's act whatever
 * account the write went through (a member's own key, an app acting as them). `kind` is what was written: `label` or `assignee` (with the value, hashed here) or `touch` (some other
 * change to the ticket; no value). `ticketId` is the ticket's intake item id, or for a write that made a new ticket, the id of its scope (the repository).
 */
export const INTAKE_OWN_WRITE_KINDS = ["label", "assignee", "touch"] as const;
export type IntakeOwnWriteKind = (typeof INTAKE_OWN_WRITE_KINDS)[number];
export function intakeOwnWriteKey(orgId: OrgId, ticketItemId: string, kind: IntakeOwnWriteKind, value: string): OrgKey {
  if (!/^[a-f0-9]{32}$/u.test(ticketItemId)) throw new Error("an intake item id is 32 hex characters");
  if (!(INTAKE_OWN_WRITE_KINDS as readonly string[]).includes(kind)) throw new Error("an own write is a label, an assignee or a touch");
  const part = kind === "touch" ? "-" : createHash("sha256").update(value.normalize("NFC").trim().toLowerCase(), "utf8").digest("hex").slice(0, 32);
  return { pk: orgScoped(orgId, "INTAKE_OWN"), sk: `${ticketItemId}#${kind}#${part}` };
}
