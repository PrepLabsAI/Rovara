// Pure request parsing, DynamoDB key/record helpers, project model resolution, and workspace/membership readers (extracted from aws/broker.ts).
import { agentXError, type ChannelBinding, channelBindingKey, type ChannelSpaceRef, E2E_DEFAULT_MODEL_ROUTE_ID, E2E_MODEL_FREE_LIMITS, E2EPolicySchema, type E2ESetupProposal, IMPLICIT_COMPANY_ID, legacyWorkspaceProjectIndexAttributes, modelKey, type ModelRef, type ModelSelection, OrgIdSchema, type ProjectModelOptions, ProjectModelOptionsSchema, ProjectModelSelectionRequestSchema, readChannelBindingItem, sharedTaskKey, type SharedTaskRecord, SharedTaskRecordSchema, SLACK_CHANNEL, slackBindingOf, type SlackChannelBinding, type SlackThread, unhandledDeploymentMode, type WorkspaceInstance, WorkspaceInstanceSchema, workspaceRecordFields } from "@agentx/contracts";
import { type AwsBrokerDependencies, type AwsBrokerInput, type MembershipRecord, PROJECT_SETUP_CAPTURE_POLICY, type ProjectModelSelectionRecord, type PullRequestRecord, type RegisteredProjectRecord } from "./broker-types.js";
import { e2eAgentRoutePolicyLimits, planE2EAgentRoute, type PlannedE2EAgentRoute } from "../e2e/model-route-registry.js";
import { untestedRouteSentence } from "../e2e/model-checks.js";
import { CredentialRegistry } from "./credentials.js";
import { dynamoTurnRecordSource, TurnRecordExport, workspaceProjectReader } from "./turns.js";
import { CatalogCache } from "@agentx/gateway";
import { type CallbackClaims, getItem, type OperationRecord, requireOperation } from "./cancellation.js";
import { type DeveloperTaskPointerRecord, type DeveloperTaskRecord, taskKey, taskOwnerKey, taskPointerKey } from "../developer/task-records.js";
import { type CompanyMembershipReader, ownPartitionRow, readTaskLegacyProject, recordInCompany } from "./company-check.js";
import { createSlackLinkCodes, slackBindingCompany, slackCompanyProject } from "./slack-person.js";
import { namedCompanySlackBinding } from "./slack-company-layout.js";
import { grantKeyFor, latestRevisionRowFor, namedCompany } from "./company-layout.js";
import { ownerOfWorkspace } from "./engine-boundary.js";
import { slackThreadKey } from "./failed-preparation.js";
import { companyThenInstallLinkCodes, installAdapterLinkCodes } from "./slack-company-split.js";
import { type ChannelAdapterDependencies, getChannelAdapter } from "./channel-adapters.js";
import { linkedDeveloper } from "./channel-links.js";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { type DeveloperRecord, developerRecordKeyedBy } from "../developer/store.js";
import { SLACK_WEB_SIGNIN_NOTICE } from "./slack-action-classes.js";
import { type ChannelConversationDependencies, channelRequester } from "./channel-conversation.js";
import { refuseNamedCompanyName } from "./admin-name-collision.js";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { githubBindingRefusal, githubDisconnectedRefusal, isGithubDisconnected } from "./github-credentials.js";
import { type GitHubAppCredentialProvider, parseGitHubRepository } from "../github-app.js";
import type { ScopeDiscovery } from "./connector-routes.js";
import type { AuthenticatedIdentity } from "../auth.js";
import type { DeveloperRouteDependencies } from "./developer-routes.js";
import type { ReplayRecord } from "./workflow-e2e-replay.js";
import type { RuntimeBinding } from "./lambda.js";

export function projectSetupPolicy(proposal: E2ESetupProposal, agentRoute?: { revision: string; definition: { budgets: Parameters<typeof e2eAgentRoutePolicyLimits>[0] } }): ReturnType<typeof E2EPolicySchema.parse> {
  return E2EPolicySchema.parse({
    schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [], targets: proposal.targets,
    defaultSandboxProfileId: "default-sandbox", fallback: "mock-unconnected", modelRouteRevision: agentRoute?.revision ?? null,
    capture: PROJECT_SETUP_CAPTURE_POLICY,
    // A setup that pins a route runs under limits derived from the route's budgets (D2); one that pins none gets the normal limits (a build and an app start need minutes), with model budgets of one (RUN-1).
    limits: agentRoute === undefined
      ? { ...E2E_MODEL_FREE_LIMITS }
      : e2eAgentRoutePolicyLimits(agentRoute.definition.budgets),
  });
}

/**
 * The AI navigation route this installation would approve now (Task 4.2), read by key. Undefined when the installation's worker settings cannot be read or give no usable
 * route (no provider, a keyed provider without its secret, an unproven OpenRouter default): the setup is then proposed and approved without AI navigation, and agent steps stay
 * unavailable with `agent-route-not-approved`.
 */
export async function plannedAgentRoute(dependencies: Pick<AwsBrokerDependencies, "documentClient" | "tableName" | "e2eAgentInstallation">): Promise<Extract<PlannedE2EAgentRoute, { status: "available" }> | undefined> {
  if (dependencies.e2eAgentInstallation === undefined) return undefined;
  try {
    const planned = await planE2EAgentRoute({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, await dependencies.e2eAgentInstallation());
    return planned.status === "available" ? planned : undefined;
  } catch { return undefined; }
}

/**
 * What a setup proposal says when the installation's route is well-formed but has no passed driving test (Task 4.10C): the provider, the model and the sentence "AI navigation steps
 * will not run: the driving test with <provider> `<model>` has not passed (<why>)". Null when the route is available, or cannot be made at all (the CLI's own sentence says that).
 */
export async function untestedAgentRouteNote(dependencies: Pick<AwsBrokerDependencies, "documentClient" | "tableName" | "e2eAgentInstallation">): Promise<{ provider: string; modelId: string; sentence: string } | null> {
  if (dependencies.e2eAgentInstallation === undefined) return null;
  try {
    const store = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
    const planned = await planE2EAgentRoute(store, await dependencies.e2eAgentInstallation());
    if (planned.status !== "unavailable" || planned.untested === undefined) return null;
    return { provider: planned.untested.provider, modelId: planned.untested.modelId, sentence: await untestedRouteSentence(store, { ...planned.untested, routeId: E2E_DEFAULT_MODEL_ROUTE_ID }) };
  } catch { return null; }
}

/** The handler's dependencies from what callers supply (see AwsBrokerInput). */
export function brokerDependencies(input: AwsBrokerInput): AwsBrokerDependencies {
  // One cache per container: discovery per revision, connector and repository costs one vendor round trip.
  const { connectorCredentials, turnRecordsTableName, ...rest } = input;
  const credentialRegistry = input.credentialRegistry ?? (connectorCredentials
    ? new CredentialRegistry({ ...connectorCredentials, documentClient: input.documentClient, tableName: input.tableName })
    : undefined);
  const turnRecords = input.turnRecords ?? (turnRecordsTableName
    ? new TurnRecordExport({
        source: dynamoTurnRecordSource(input.documentClient, turnRecordsTableName),
        projectOf: workspaceProjectReader(input.documentClient, input.tableName),
      })
    : undefined);
  return {
    ...rest,
    catalogs: input.catalogs ?? new CatalogCache<ScopeDiscovery>({ ttlMs: 600_000, maxEntries: 256 }),
    ...(credentialRegistry ? { credentialRegistry } : {}),
    ...(turnRecords ? { turnRecords } : {}),
    ...(turnRecordsTableName ? { turnRecordsTableName } : {}),
  };
}

/** DEC 254zzz6 D2: the live company membership reader for admin routes: the top-level one (tests, the Slack company handler), else the developer configuration's (production). */
export function adminCompanyReader(dependencies: AwsBrokerDependencies): CompanyMembershipReader | undefined {
  return dependencies.companies ?? dependencies.developer?.companies;
}

/** Spec 025 FR-035, FR-054: the thread's shared task record, or undefined for an ordinary thread. */
export async function sharedThread(dependencies: AwsBrokerDependencies, thread: SlackThread): Promise<SharedTaskRecord | undefined> {
  // Developer tasks exist only where developer sign-in is set up (D14); nothing else reads this key.
  if (dependencies.developer === undefined) return undefined;
  const item = await getItem<Record<string, unknown>>(dependencies, sharedTaskKey(thread));
  if (item === undefined) return undefined;
  const record = SharedTaskRecordSchema.safeParse(item);
  // Fail closed: an unreadable record must never let the thread act as an ordinary one.
  if (!record.success || record.data.ownerKey !== taskOwnerKey(record.data.developerId, record.data.taskId)) {
    throw agentXError("FORBIDDEN", "this thread's shared task record cannot be read; ask an admin");
  }
  return record.data;
}

/**
 * C11, F16: a shared thread acts on the task only in continue, before the close, while its channel serves the task's
 * project, and never when it is a Slack-started task's own thread (only its owner's buttons move that task).
 */
export function sharedThreadOpen(shared: SharedTaskRecord, binding: SlackChannelBinding): boolean {
  return shared.mode === "continue" && shared.closedAt === undefined && shared.workflowThread !== true && binding.projectName === shared.project;
}

/** Slack binding authority is separate from the persisted task's project authority. */
export function slackCompanyOwnRow<T>(companyId: string | undefined, row: T): T {
  if (companyId !== undefined && !OrgIdSchema.safeParse(companyId).success) throw agentXError("FORBIDDEN", "Slack channel is not bound to a project");
  if (!recordInCompany(row, companyId)) throw agentXError("FORBIDDEN", "Slack channel is not bound to a project");
  return row;
}

/** The same check for a route that holds the channel binding itself (the SWE-bench routes): a NAMED company's binding needs the legacy row it read to be that company's. */
export function bindingOwnRow<T>(binding: SlackChannelBinding | undefined, row: T): T {
  return slackCompanyOwnRow((binding as { companyId?: string } | undefined)?.companyId, row);
}

/**
 * DEC 254zzz98 (delta review H1, re-review M, round-3 M1): the row a Slack thread's route actually read. When the thread's binding is a NAMED company's (it carries `companyId`),
 * the legacy revision the route loaded by name must be that company's own (recordInCompany): names are not unique between a named company's own partition and the legacy
 * namespace, so a built-in (or another company's) namesake, a pinned older revision of another company, or one registered mid-request never serves the thread; it is refused
 * as unbound. Checked on each legacy read (not on the identity), so a namesake never blocks the company's routes that read no legacy revision (the core's quick start, answers,
 * thread notes). Any other identity (no Slack binding, or the built-in company's): the row, unchanged.
 */
export function slackThreadOwnRow<T>(identity: AuthenticatedIdentity | undefined, row: T): T {
  return bindingOwnRow(identity?.slack?.binding, row);
}

/** Unstamped persisted tasks belong to the built-in company, including on hosted installs. The project read still refuses named-company rows. */
export async function taskLegacyScope<T extends { companyId?: unknown; share?: { teamId?: string } }>(_dependencies: AwsBrokerDependencies, task: T): Promise<T> {
  return task.companyId === undefined ? { ...task, companyId: IMPLICIT_COMPANY_ID } : task;
}

/** Validate the task/workspace link; recover only the old single-install scope. Project ownership is checked by readTaskLegacyProject. */
export async function workspaceTaskScope(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord | undefined, workspace: WorkspaceInstance): Promise<DeveloperTaskRecord> {
  const refuse = () => agentXError("FORBIDDEN", "Slack channel is not bound to a project");
  if (task === undefined || task.entityType !== "DEVELOPER_TASK" || typeof task.taskId !== "string" || typeof task.project !== "string"
    || task.pk !== taskKey(task.taskId).pk || task.sk !== "META"
    || task.workspaceId !== workspace.id || task.project !== workspace.projectName || task.ownerKey !== workspace.ownerKey) throw refuse();
  return taskLegacyScope(dependencies, task);
}

/** Ordinary workspaces have no task pointer. A task workspace always uses its persisted company's scope, for every caller including callbacks. */
export async function readWorkspaceTaskLegacyProject<T>(dependencies: AwsBrokerDependencies, workspaceId: string, read: () => Promise<T>): Promise<T> {
  const pointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(workspaceId));
  if (pointer === undefined) return read();
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
  const workspace = await requireWorkspace(dependencies, workspaceId);
  return readTaskLegacyProject(await workspaceTaskScope(dependencies, task, workspace), read);
}

/**
 * DEC 254zzz80 (R2-F1): a Slack channel's binding for the team's company. A NAMED company's bindings live only in its own partition (`ORG#<company>#SLACK_BINDING#<team>`), read
 * by key under the team's company as resolved now; the built-in company and no company layer keep the legacy read above, unchanged.
 */
export async function getSlackBinding(
  dependencies: AwsBrokerDependencies,
  teamId: string,
  channelId: string,
): Promise<SlackChannelBinding | undefined> {
  const named = await slackBindingCompany(dependencies, teamId);
  if (named === undefined) return getLegacySlackBinding(dependencies, teamId, channelId);
  const binding = await namedCompanySlackBinding(dependencies.documentClient, dependencies.tableName, named, teamId, channelId);
  // The bound project must be a project of the company's own partition (the core's order; a row naming another company is absent).
  return binding !== undefined && await latestRevisionRowFor(dependencies.documentClient, dependencies.tableName, named, binding.projectName) !== undefined ? binding : undefined;
}

export async function getLegacySlackBinding(
  dependencies: AwsBrokerDependencies,
  teamId: string,
  channelId: string,
): Promise<SlackChannelBinding | undefined> {
  const binding = await getChannelBinding(dependencies, { channel: SLACK_CHANNEL, tenant: teamId, space: channelId });
  return binding === undefined || !await slackCompanyProject(dependencies, teamId, binding.projectName) ? undefined : slackBindingOf(binding);
}

/** Spec 062 FR-010: one space's binding on any channel. Rows written before channels followed the latest revision also carry projectRevision; it is ignored. */
export async function getChannelBinding(dependencies: AwsBrokerDependencies, ref: ChannelSpaceRef): Promise<ChannelBinding | undefined> {
  return readChannelBindingItem(ref, await getItem<Record<string, unknown>>(dependencies, channelBindingKey(ref)));
}

export function slackBindingKey(teamId: string, channelId: string) {
  return channelBindingKey({ channel: SLACK_CHANNEL, tenant: teamId, space: channelId });
}

/** An operation a developer started from an AI tool (FR-022), rather than from Slack. */
export function developerRequested(operation: Pick<OperationRecord, "requestedBy">): boolean {
  const requester = operation.requestedBy;
  return requester !== undefined && "kind" in requester && requester.kind === "developer";
}

export async function requireOwnedWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
): Promise<WorkspaceInstance> {
  const workspace = await requireWorkspace(dependencies, workspaceId);
  if (workspace.ownerKey !== identity.ownerKey) throw agentXError("NOT_FOUND", "workspace not found");
  return workspace;
}

export async function requireWorkspace(dependencies: AwsBrokerDependencies, workspaceId: string): Promise<WorkspaceInstance> {
  // Lane E2: a core task's workspace is not the workflow's to read or act on (engine-boundary.ts); it answers like a missing one.
  if (await ownerOfWorkspace(dependencies, workspaceId) === "core") throw agentXError("NOT_FOUND", "workspace not found");
  const item = await getItem<Record<string, unknown>>(dependencies, workspaceKey(workspaceId));
  if (!item) throw agentXError("NOT_FOUND", "workspace not found");
  return WorkspaceInstanceSchema.parse(workspaceRecordFields(item));
}

export async function getDefaultWorkspace(
  dependencies: AwsBrokerDependencies,
  ownerKey: string,
  projectName: string,
): Promise<WorkspaceInstance | undefined> {
  const mapping = await getItem<{ workspaceId: string }>(dependencies, {
    pk: `OWNER#${ownerKey}`,
    sk: `PROJECT#${projectName}`,
  });
  return mapping ? requireWorkspace(dependencies, mapping.workspaceId) : undefined;
}

export async function getThreadWorkspace(
  dependencies: AwsBrokerDependencies,
  ownerKey: string,
): Promise<WorkspaceInstance | undefined> {
  const thread = await getItem<{ workspaceId?: string }>(dependencies, slackThreadKey(ownerKey));
  return typeof thread?.workspaceId === "string" ? requireWorkspace(dependencies, thread.workspaceId) : undefined;
}

export function slackCallerRouteDependencies(dependencies: AwsBrokerDependencies): Pick<DeveloperRouteDependencies, "workspaces" | "companies"> {
  return { ...(dependencies.workspaces === undefined ? {} : { workspaces: dependencies.workspaces }), ...(dependencies.companies === undefined ? {} : { companies: dependencies.companies }) };
}

export function channelLinkRouteDependencies(dependencies: AwsBrokerDependencies): Pick<DeveloperRouteDependencies, "channelLinks" | "channelLinkCodes" | "workspaces" | "companies"> {
  const channelAdapters = dependencies.channelAdapters;
  if (dependencies.workspaces !== undefined) {
    // L2-2 PR 18b: the company's Slack codes, then the install's adapter codes as before (the link page is served only by the company handler when company mode is on).
    const install = channelAdapters === undefined ? undefined : { documentClient: dependencies.documentClient, stateTableName: dependencies.tableName, now: Date.now };
    return { ...slackCallerRouteDependencies(dependencies), channelLinkCodes: companyThenInstallLinkCodes(
      createSlackLinkCodes({ workspaces: dependencies.workspaces, store: dependencies.workspaces.store, companies: dependencies.companies }),
      install === undefined ? undefined : installAdapterLinkCodes(install)) };
  }
  return channelAdapters === undefined ? {} : { channelLinks: { documentClient: dependencies.documentClient, stateTableName: dependencies.tableName, now: Date.now } };
}

/** Spec 062 Phase 4: what an adapter conversation's service identity is checked against. */
export function channelConversationDependencies(dependencies: AwsBrokerDependencies): ChannelConversationDependencies {
  return {
    getAdapter: (channel) => getChannelAdapter(dependencies, channel),
    getBinding: (ref) => getChannelBinding(dependencies, ref),
    linkedDeveloper: (actor) => linkedDeveloper({ documentClient: dependencies.documentClient, stateTableName: dependencies.tableName, now: Date.now }, actor),
    getDeveloper: async (developerId) => {
      const signInTableName = (dependencies.developer ?? dependencies.linking)?.signInTableName;
      if (signInTableName === undefined) return undefined;
      const response = await dependencies.documentClient.send(new GetCommand({ TableName: signInTableName, Key: { pk: `DEVELOPER#${developerId}`, sk: "META" }, ConsistentRead: true }));
      const item = developerRecordKeyedBy(response.Item as Partial<DeveloperRecord> | undefined, developerId);
      if (item === undefined || typeof item.developerId !== "string" || (item.provider !== "slack" && item.provider !== "oidc") || typeof item.displayName !== "string") return undefined;
      return {
        developerId: item.developerId, provider: item.provider, displayName: item.displayName, revoked: item.revoked === true,
        ...(typeof item.slackUserId === "string" ? { slackUserId: item.slackUserId } : {}),
      };
    },
  };
}

/** The ID a thread record's starter is compared with: the Slack member's, or the adapter actor's linked developer's. */
export function conversationStarterId(identity: AuthenticatedIdentity): string | undefined {
  return identity.slack?.requester.userId ?? identity.channel?.developer.developerId;
}

/** The project a conversation's space is bound to: a Slack channel's or an adapter space's. */
export function conversationProjectName(identity: AuthenticatedIdentity): string | undefined {
  return identity.slack?.binding.projectName ?? identity.channel?.projectName;
}

/** Spec 062: the channel adapter routes' dependencies; NOT_FOUND when the deployment has no channel adapters. */
export function channelAdapterDependencies(dependencies: AwsBrokerDependencies): ChannelAdapterDependencies {
  const channelAdapters = dependencies.channelAdapters;
  if (channelAdapters === undefined) throw agentXError("NOT_FOUND", "channel adapters are not enabled in this deployment");
  return {
    documentClient: dependencies.documentClient,
    tableName: dependencies.tableName,
    channelAdapters,
    requireAdministrator: (identity, projectName) => requireAdministrator(dependencies, identity, projectName),
    requireProject: async (projectName) => { await requireLatestProject(dependencies, projectName); },
  };
}

export async function requireLatestProject(
  dependencies: AwsBrokerDependencies,
  projectName: string,
): Promise<RegisteredProjectRecord> {
  // Revision sort keys are zero-padded, so the last key in descending order is the highest revision.
  const response = await dependencies.documentClient.send(new QueryCommand({
    TableName: dependencies.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :revision)",
    ExpressionAttributeValues: { ":pk": `PROJECT#${projectName}`, ":revision": "REV#" },
    ScanIndexForward: false,
    Limit: 1,
    ConsistentRead: true,
  }));
  const project = response.Items?.[0] as RegisteredProjectRecord | undefined;
  if (!project) throw agentXError("NOT_FOUND", "registered project not found");
  return project;
}

export function projectModelSelectionKey(projectName: string) {
  return { pk: `PROJECT#${projectName}`, sk: "SELECTION" as const };
}

export async function getProjectModels(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
): Promise<ProjectModelOptions> {
  const projectName = conversationProjectName(identity);
  if (!projectName) throw agentXError("FORBIDDEN", "a conversation's project binding is required");
  const project = slackThreadOwnRow(identity, await requireLatestProject(dependencies, projectName));
  const policy = project.definition.models;
  if (!policy) throw agentXError("CONFIG_INVALID", "this project has no approved coding models; ask an administrator to configure models");
  const selection = await getItem<ProjectModelSelectionRecord>(dependencies, projectModelSelectionKey(projectName));
  const selected = selection === undefined
    ? undefined
    : policy.approved.find((candidate) => modelKey(candidate) === modelKey(selection.model));
  const current = selected ?? approvedDefault(policy.default, policy.approved);
  return ProjectModelOptionsSchema.parse({
    projectName,
    approved: policy.approved,
    current,
    source: selected === undefined ? "default" : "selection",
  });
}

export async function putProjectModel(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
): Promise<ProjectModelOptions> {
  if (dependencies.workspaces !== undefined && (identity.slack !== undefined || identity.channel?.ref.channel === SLACK_CHANNEL)) throw agentXError("FORBIDDEN", SLACK_WEB_SIGNIN_NOTICE);
  const projectName = conversationProjectName(identity);
  const requester = identity.slack?.requester ?? (identity.channel === undefined ? undefined : channelRequester(identity.channel));
  if (!projectName || !requester) throw agentXError("FORBIDDEN", "a conversation's project binding and requester are required");
  const requested = ProjectModelSelectionRequestSchema.parse(value);
  const project = slackThreadOwnRow(identity, await requireLatestProject(dependencies, projectName));
  const policy = project.definition.models;
  if (!policy) throw agentXError("CONFIG_INVALID", "this project has no approved coding models; ask an administrator to configure models");
  const selected = policy.approved.find((candidate) => modelKey(candidate) === modelKey(requested));
  if (!selected) throw agentXError("CONFIG_INVALID", `model ${requested.provider}/${requested.modelId} is not approved for this project`);
  const record: ProjectModelSelectionRecord = {
    ...projectModelSelectionKey(projectName),
    entityType: "PROJECT_MODEL_SELECTION",
    model: { provider: selected.provider, modelId: selected.modelId },
    updatedAt: new Date().toISOString(),
    updatedBy: requester,
  };
  await dependencies.documentClient.send(new PutCommand({ TableName: dependencies.tableName, Item: record }));
  return ProjectModelOptionsSchema.parse({
    projectName,
    approved: policy.approved,
    current: selected,
    source: "selection",
  });
}

export async function resolveProjectModel(
  dependencies: AwsBrokerDependencies,
  project: RegisteredProjectRecord,
): Promise<{ model?: ModelSelection; diagnostic?: string }> {
  const policy = project.definition.models;
  if (!policy) return {};
  const selection = await getItem<ProjectModelSelectionRecord>(dependencies, projectModelSelectionKey(project.definition.name));
  const selected = selection === undefined
    ? undefined
    : policy.approved.find((candidate) => modelKey(candidate) === modelKey(selection.model));
  const effective = selected ?? approvedDefault(policy.default, policy.approved);
  return {
    model: approvedSelection(effective),
    ...(selection !== undefined && selected === undefined
      ? { diagnostic: `The project's selected coding model ${selection.model.provider}/${selection.model.modelId} is no longer approved. This task uses the project default ${effective.provider}/${effective.modelId}.` }
      : {}),
  };
}

/** Spec 053: what a task or eval run runs: the approved entry's model and, only when it has one, its level. */
export function approvedSelection(model: ModelRef): ModelSelection {
  return {
    provider: model.provider,
    modelId: model.modelId,
    ...(model.thinkingLevel === undefined ? {} : { thinkingLevel: model.thinkingLevel }),
  };
}

export function approvedDefault(defaultModel: ModelRef, approved: readonly ModelRef[]): ModelRef {
  const model = approved.find((candidate) => modelKey(candidate) === modelKey(defaultModel));
  if (!model) throw agentXError("CONFIG_INVALID", "project default model is not approved");
  return model;
}

export async function requirePullRequest(
  dependencies: AwsBrokerDependencies,
  workspaceId: string,
  repository: string,
  number: number,
): Promise<PullRequestRecord> {
  const record = await getItem<PullRequestRecord>(dependencies, pullRequestKey(workspaceId, repository, number));
  if (!record) throw agentXError("NOT_FOUND", "AgentX pull request record not found");
  return record;
}

export async function adoptLegacyPullRequest(
  dependencies: AwsBrokerDependencies,
  workspaceId: string,
  repository: string,
  repositoryUrl: string,
  remote: Awaited<ReturnType<GitHubAppCredentialProvider["getPullRequest"]>>,
): Promise<PullRequestRecord> {
  const match = /^agentx\/([0-9a-f-]{36})$/iu.exec(remote.headBranch);
  if (!match?.[1]) throw agentXError("NOT_FOUND", "pull request is not owned by this AgentX workspace");
  const operation = await requireOperation(dependencies, workspaceId, match[1]);
  if (
    operation.kind !== "publish" || operation.status !== "SUCCEEDED" || !operation.publication ||
    operation.publication.repository !== repository || operation.publication.repositoryUrl !== repositoryUrl ||
    operation.publication.headBranch !== remote.headBranch || operation.publication.baseBranch !== remote.baseBranch
  ) {
    throw agentXError("NOT_FOUND", "pull request is not backed by a successful AgentX publication");
  }
  const record: PullRequestRecord = {
    ...pullRequestKey(workspaceId, repository, remote.number),
    entityType: "PULL_REQUEST",
    workspaceId,
    repository,
    repositoryUrl,
    number: remote.number,
    url: remote.url,
    state: remote.state,
    headBranch: remote.headBranch,
    baseBranch: remote.baseBranch,
    expectedHeadCommit: remote.headCommit,
    title: remote.title,
    body: remote.body,
    createdByOperationId: operation.id,
    updatedAt: new Date().toISOString(),
  };
  await dependencies.documentClient.send(new PutCommand({ TableName: dependencies.tableName, Item: record }));
  return record;
}

export async function requireMembership(
  dependencies: AwsBrokerDependencies,
  ownerKey: string,
  projectName: string,
): Promise<MembershipRecord> {
  // DEC 254zzz98 (one rule; review M1, the feature 007 and connector MCP routes): a grant is read beside the revision the route reads. Every caller here (the workflow
  // workspace routes: resolveWorkspace's requireProject, the MCP routes' requireLatestProject, the workspace actions) reads the project's LEGACY revision `PROJECT#<name>`,
  // so the grant is the legacy `MEMBER#<person>` row, whatever company a stamped legacy row names (as requireAdministratorGrant reads it). A named company's own-partition
  // grant never opens a legacy revision here; a named company's revoke also removes its legacy row (admin-actions.ts revokeProjectAccess).
  const membership = await getMembership(dependencies, ownerKey, projectName, undefined);
  if (!membership) throw agentXError("NOT_FOUND", "project not found");
  return membership;
}

/** DEC 254zzz80: a person's grant row, where `companyId` keeps grants (company-layout.ts: a named company's own partition, else the legacy row). A row naming another company is none. */
export async function getMembership(dependencies: AwsBrokerDependencies, ownerKey: string, projectName: string, companyId: string | undefined) {
  const key = grantKeyFor(companyId, ownerKey, projectName);
  const row = await getItem<MembershipRecord>(dependencies, key);
  const company = namedCompany(companyId);
  return row === undefined || company === undefined || (row.pk === key.pk && row.sk === key.sk && ownPartitionRow(row as unknown as Record<string, unknown>, company)) ? row : undefined;
}

export function grantCompany(_dependencies: AwsBrokerDependencies, companyId: string | undefined): string | undefined {
  return companyId;
}

/** The company a stored record names (`companyId`), or undefined (unstamped: the built-in company's). */
export function storedCompanyOf(record: unknown): string | undefined {
  const company = (record as { companyId?: unknown } | undefined)?.companyId;
  return typeof company === "string" ? company : undefined;
}

/**
 * A name-only admin project route's check: the claim, the name-keyed administrator grant, then (DEC 254zzz6 D2) a refusal when a named company also has a project of
 * that name (admin-name-collision.ts). The collision check runs last, so a caller without the grant gets exactly today's answers.
 */
export async function requireAdministrator(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  projectName: string,
): Promise<void> {
  await requireAdministratorGrant(dependencies, identity, projectName);
  await refuseNamedCompanyName({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, companies: adminCompanyReader(dependencies) }, identity.developer?.developerId ?? identity.ownerKey, projectName);
}

/** The claim and the name-keyed administrator grant only. Only for a caller that binds the grant to a company itself (the core's administrator stop, core-stop-entry.ts). */
export async function requireAdministratorGrant(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  projectName: string,
): Promise<void> {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  // The name-keyed (legacy) grant, as DEC 254zzz6 D2 describes these name-only admin routes: a named company's own-partition grant is never read here, and a name a named
  // company uses is refused by the collision check (requireAdministrator), never served.
  const membership = await getMembership(dependencies, identity.ownerKey, projectName, undefined);
  if (!membership) throw agentXError("NOT_FOUND", "project not found");
  if (membership.role !== "administrator") throw agentXError("FORBIDDEN", "administrator project membership is required");
}

/** What the operator reads of a replay record: its state, when, and the broker's own result; never an id of an operation or an object. */
export function replayRecordView(record: ReplayRecord) {
  return { attempt: record.attempt, state: record.state, requestedAt: record.requestedAt, ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.recordedAt === undefined ? {} : { recordedAt: record.recordedAt }), ...(record.reason === undefined ? {} : { reason: record.reason }), ...(record.replay === undefined ? {} : { replay: record.replay }) };
}

/** Whether closing a workspace of this mode deletes its storage. */
export function closeReleasesStorage(workspace: WorkspaceInstance): boolean {
  switch (workspace.deploymentMode) {
    case "instances-ebs":
    case "ec2-ebs":
      return true;
    case "demo-microvm":
      return false;
    default:
      return unhandledDeploymentMode(workspace);
  }
}

/** The workspace fields a project's runtime binding fixes. An ec2-ebs workspace keeps only its mode. */
export function workspaceRuntime(runtimeBinding: RuntimeBinding) {
  switch (runtimeBinding.deploymentMode) {
    case "instances-ebs":
    case "demo-microvm":
      throw agentXError("CONFIG_INVALID", "retired project revision cannot create workspaces; register an ec2-ebs revision");
    case "ec2-ebs":
      return { deploymentMode: runtimeBinding.deploymentMode };
    default:
      return unhandledDeploymentMode(runtimeBinding);
  }
}

export function workspaceItem(workspace: WorkspaceInstance) {
  // Spec 041: the sparse byWorkspaceProject index attributes make this record findable by project,
  // which is how a developer's workspaces are listed. They are storage keys, not record fields, so
  // workspaceRecordFields strips them again on the way back.
  return {
    ...workspaceKey(workspace.id),
    entityType: "WORKSPACE",
    ...legacyWorkspaceProjectIndexAttributes(workspace),
    ...workspace,
  };
}

/** DEC 254zzz80: a named company's grant row is in its own partition (company-layout.ts); otherwise the legacy key. */
export function membershipRecord(ownerKey: string, projectName: string, role: MembershipRecord["role"], companyId?: string): MembershipRecord {
  return { ...grantKeyFor(companyId, ownerKey, projectName), entityType: "MEMBERSHIP", ownerKey, projectName, role, grantId: randomUUID() };
}

export function githubRepositoryFullName(repositoryUrl: string): string {
  let url: URL;
  try { url = new URL(repositoryUrl); } catch { throw agentXError("CONFIG_INVALID", "registered repository URL is invalid for GitHub PR tracking"); }
  const segments = url.pathname.split("/").filter(Boolean);
  const name = segments[1]?.endsWith(".git") ? segments[1].slice(0, -4) : segments[1];
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port !== ""
    || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== ""
    || segments.length !== 2 || segments.some((segment) => segment.includes("%"))
    || !segments[0] || !name || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(segments[0])
    || !/^[A-Za-z0-9_.-]{1,100}$/.test(name)) {
    throw agentXError("CONFIG_INVALID", "registered repository URL is not a canonical GitHub repository");
  }
  return `${segments[0]}/${name}`;
}

export function pullRequestMatchesRepository(pullRequestUrl: string, repositoryFullName: string, number: number): boolean {
  try {
    const url = new URL(pullRequestUrl);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com" && url.port === ""
      && url.username === "" && url.password === "" && url.search === "" && url.hash === ""
      && url.pathname.toLowerCase() === `/${repositoryFullName.toLowerCase()}/pull/${number}`;
  } catch {
    return false;
  }
}

export function workspaceKey(id: string) {
  return { pk: `WORKSPACE#${id}`, sk: "META" };
}

export function pullRequestKey(workspaceId: string, repository: string, number: number) {
  return {
    pk: `WORKSPACE#${workspaceId}`,
    sk: `PULL_REQUEST#${repository}#${String(number).padStart(12, "0")}`,
  };
}

export function codeBuildKey(workspaceId: string, operationId: string, gate: string) {
  return {
    pk: `WORKSPACE#${workspaceId}`,
    sk: `CODEBUILD#${operationId}#${gate}`,
  };
}

export function issueRepositoryGrant(
  dependencies: AwsBrokerDependencies,
  project: RegisteredProjectRecord,
  ownerKey: string,
  workspaceId: string,
  operationId: string,
  access: "clone" | "push" = "clone",
  repositoryName?: string,
): string {
  return dependencies.repositoryGrants.issue({
    ownerKey,
    projectName: project.definition.name,
    workspaceId,
    operationId,
    repositories: project.definition.repositories
      .filter((repository) => repositoryName === undefined || repository.name === repositoryName)
      .map((repository) => ({
      credentialRef: repository.credentialRef,
      repositoryUrl: repository.url,
      access,
    })),
  });
}

export async function requireGithubProjectBinding(dependencies: AwsBrokerDependencies, project: RegisteredProjectRecord, repositoryUrl: string): Promise<void> {
  if (dependencies.githubBindings === undefined) return;
  try {
    const raw = (project as RegisteredProjectRecord & { companyId?: unknown }).companyId;
    const companyId = OrgIdSchema.parse(raw === undefined ? IMPLICIT_COMPANY_ID : raw);
    if (dependencies.githubPullRequests.installationIdFor === undefined) throw githubBindingRefusal();
    await dependencies.githubBindings.requireBound(companyId, await dependencies.githubPullRequests.installationIdFor(repositoryUrl));
  } catch (error) {
    // Guided onboarding PR 3: the company's own uninstalled or suspended GitHub says so, in one fixed sentence.
    if (isGithubDisconnected(error) || await githubDisconnectedFor(dependencies, project, repositoryUrl)) throw githubDisconnectedRefusal();
    throw githubBindingRefusal();
  }
}

export async function githubDisconnectedFor(dependencies: AwsBrokerDependencies, project: RegisteredProjectRecord, repositoryUrl: string): Promise<boolean> {
  try {
    const raw = (project as RegisteredProjectRecord & { companyId?: unknown }).companyId;
    return await dependencies.githubBindings!.disconnectedFor(OrgIdSchema.parse(raw === undefined ? IMPLICIT_COMPANY_ID : raw), parseGitHubRepository(repositoryUrl).owner);
  } catch { return false; }
}

export function verifyCapability(
  dependencies: AwsBrokerDependencies,
  token: string,
  action: CallbackClaims["actions"][number],
): CallbackClaims {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra) throw agentXError("CALLBACK_FORBIDDEN", "invalid callback capability");
  const expected = createHmac("sha256", dependencies.callbackSigningKey).update(body).digest();
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw agentXError("CALLBACK_FORBIDDEN", "invalid callback signature");
  }
  const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CallbackClaims;
  if (claims.expiresAt <= Math.floor(Date.now() / 1_000) || !claims.actions.includes(action)) {
    throw agentXError("CALLBACK_FORBIDDEN", `callback capability does not allow ${action}`);
  }
  return claims;
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentXError("CONFIG_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parseBody(body: string | undefined): unknown {
  if (!body) return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    // Issue #48: the parser's own words quote the body, so fixed words instead.
    throw agentXError("CONFIG_INVALID", "the request body is not valid JSON");
  }
}

export function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw agentXError("CONFIG_INVALID", `${label} must be a UUID`);
  }
  return value;
}

export function name(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(value)) {
    throw agentXError("CONFIG_INVALID", `${label} is invalid`);
  }
  return value;
}

export function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw agentXError("CONFIG_INVALID", `${label} must be a positive integer`);
  }
  return value;
}

export function encodeCursor(sequence: number): string {
  return Buffer.from(String(sequence)).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
  if (!Number.isInteger(value) || value < 0) throw agentXError("CONFIG_INVALID", "event cursor is invalid");
  return value;
}

/** The worker reports, once per conversation, that a saved session now exists for it. */
export function startsConversation(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("conversation" in value)) return false;
  const conversation = value.conversation;
  return Boolean(
    conversation && typeof conversation === "object" && "started" in conversation && conversation.started === true,
  );
}

export function isStatus(value: unknown, status: string): boolean {
  return Boolean(value && typeof value === "object" && "status" in value && value.status === status);
}

export function parseStoredEvent(item: Record<string, unknown>): {
  sequence: number;
  type: string;
  timestamp: string;
  payload: unknown;
} {
  if (
    typeof item.sequence !== "number" ||
    typeof item.type !== "string" ||
    typeof item.timestamp !== "string"
  ) {
    throw agentXError("RUNTIME_UNAVAILABLE", "stored event is invalid");
  }
  return {
    sequence: item.sequence,
    type: item.type,
    timestamp: item.timestamp,
    payload: item.payload,
  };
}

export function json(
  value: unknown,
  requestId: string,
  statusCode = 200,
): { statusCode: number; headers: Record<string, string>; body: string } {
  const body = value && typeof value === "object" ? { ...value, requestId } : { data: value, requestId };
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}
