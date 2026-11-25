// A real hosted core task in a Slack thread, for tests that press Slack buttons through the REAL interactivity dispatcher (S1): the core host app on in-memory adapters, the broker's table
// holding the task's rows as the hosted deployment does, the broker's own task authorization, and the Slack people the deployment maps to Rovara persons. Only the network is fake.
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { WorkflowSnapshotSchema, orgChannelLinkKey, orgProjectCatalogKey, projectRevisionKey, sharedTaskKey, type JsonValue, type ProjectDefinition, type StoredDocument, type WorkflowSnapshot } from "@agentx/contracts";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { blockedReview } from "./task-actions-world.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { workspacePartition } from "../../packages/broker/src/core/task-flow/keys.js";
import { stopWorkspaceAsAdministrator } from "../../packages/broker/src/core/task-flow/stop-request.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp, engineStampKey, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CompanyMembership, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { coreTaskEntryFrom, type CoreTaskEntry } from "../../packages/broker/src/aws/engine-boundary.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { createDeveloperTaskBroker } from "./developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, issuer } from "./slack-broker.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "./core-host-fakes.js";
import { workflowSlackHandlers, createSlackPressDispatcher, type SlackBlockAction } from "../../packages/broker/src/aws/slack-interactivity.js";
import { taskActionDepsFrom, taskActionPressHandler, taskActionSubmission } from "../../packages/broker/src/aws/slack-task-actions.js";
import { isCoreTask } from "../../packages/broker/src/aws/engine-boundary.js";

export const OTHER_COMPANY = "org_corehost00000000000b";
export const CORE_PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
/** Slack people: the task's owner, a colleague (a plain member), an admin of the task's company, and an admin of another company. */
export const SLACK_PEOPLE = { owner: "U0OWNER0001", colleague: "U0COLLEAG01", admin: "U0ADMIN0001", foreign: "U0FOREIGN01" } as const;
export const CORE_THREAD = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000777" };
const ADMIN_SUBJECT = "admin-subject";

const ownerRule = (): TaskFlowDeps["access"] => ({
  ...createOwnerTaskAccess(),
  async canAct(principal, task) { return principal.personId === task.developerId || developerIdOf(principal) === task.developerId; },
  ownerActing: async (principal, task) => (principal.personId === task.developerId || developerIdOf(principal) === task.developerId ? { actorId: task.ownerKey } : undefined),
});

async function registerProject(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, CORE_PROJECT.name, CORE_PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(CORE_PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, CORE_PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: CORE_PROJECT.revision } });
}

async function partition(world: FakeWorld, pk: string): Promise<StoredDocument[]> {
  const items: StoredDocument[] = [];
  let cursor: string | undefined;
  do {
    const page = await world.store.query({ pk, ...(cursor === undefined ? {} : { cursor }) });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return items;
}

/** A running core task of FAKE_COMPANY whose rows are in the broker's table, the core entry as the AWS root composes it, and the Slack people's live memberships. */
export async function coreSlackWorld(options: { roundCap?: () => Promise<{ limitUsd: number; spentUsd: number | undefined } | undefined> } = {}) {
  const world = createFakeWorld();
  await registerProject(world, FAKE_COMPANY);
  await registerProject(world, OTHER_COMPANY);
  const app: CoreHostApp = createCoreHostApp({
    modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: ownerRule(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
  });
  const owner = localOwnerPrincipal({ companyId: FAKE_COMPANY });
  const runtime = await app.runtimeFor(FAKE_COMPANY);
  const { task } = await runtime.flow.start({ principal: owner, client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
  const people = new Map<string, { principal: DeployedCaller["principal"]; membership: CompanyMembership }>([
    [developerIdForSlackUser(SLACK_PEOPLE.owner), { principal: owner, membership: { companyId: FAKE_COMPANY, role: "member" } }],
    [developerIdForSlackUser(SLACK_PEOPLE.colleague), { principal: localOwnerPrincipal({ companyId: FAKE_COMPANY, personId: "person-colleague-01" }), membership: { companyId: FAKE_COMPANY, role: "member" } }],
    [developerIdForSlackUser(SLACK_PEOPLE.admin), { principal: localOwnerPrincipal({ companyId: FAKE_COMPANY, personId: "person-admin-000001" }), membership: { companyId: FAKE_COMPANY, role: "admin" } }],
    [developerIdForSlackUser(SLACK_PEOPLE.foreign), { principal: localOwnerPrincipal({ companyId: OTHER_COMPANY, personId: "person-foreign-0001" }), membership: { companyId: OTHER_COMPANY, role: "owner" } }],
  ]);
  const byPerson = new Map([...people.values()].map((entry) => [`${entry.principal.personId}|${entry.principal.companyId}`, entry.membership]));
  // The chat seam as the hosted install has it: which company a Slack workspace is, which person a Slack account is (a link row, fenced), and the company's approval gate (a test that decides plans gives its own).
  const linkOf = (userId: string) => ({ channel: "slack", tenant: SLACK_TEAM, userId });
  const chatThreads = {
    companyOf: async ({ channel, tenant }: { channel: string; tenant: string }) => (channel === "slack" && tenant === SLACK_TEAM ? FAKE_COMPANY : undefined),
    adapterFor: (companyId: string, channel: string) => (channel === "slack" && companyId === FAKE_COMPANY ? ({ capabilities: { threads: true, buttons: 10, edits: false, maxTextLength: 3_000, proactive: true, taskActions: true }, projects: [], stepUp: [], deliver: async () => undefined } as never) : undefined),
    // As the real resolver does: the link row decides (so an unlinked account is nobody), and the person is a member of the company.
    personOf: async (companyId: string, actor: { userId: string }) => {
      const row = await world.store.get(orgChannelLinkKey(FAKE_COMPANY, linkOf(actor.userId)));
      const found = people.get(developerIdForSlackUser(actor.userId));
      return row === undefined || found === undefined || found.principal.companyId !== companyId || row["developerId"] !== found.principal.personId ? undefined : { personId: found.principal.personId, via: "link" as const };
    },
  };
  for (const [slackUser] of Object.entries(SLACK_PEOPLE)) {
    const userId = SLACK_PEOPLE[slackUser as keyof typeof SLACK_PEOPLE];
    const found = people.get(developerIdForSlackUser(userId));
    if (found?.principal.companyId === FAKE_COMPANY) await world.store.put({ item: { ...orgChannelLinkKey(FAKE_COMPANY, linkOf(userId)), entityType: "CHANNEL_LINK", actor: linkOf(userId), developerId: found.principal.personId, linkedAt: "2026-11-15T00:00:00.000Z" } });
  }
  const routes = createCoreDevRoutes({
    app, companyOf: async (caller) => byPerson.get(`${caller.principal.personId}|${caller.principal.companyId}`),
    wiring: () => ({ origin: () => "https://api.example", taskActions: { roundCap: options.roundCap ?? (async () => undefined) } }),
    chat: { threads: chatThreads, proofKey: Buffer.alloc(32, 3), gateFor: () => { throw new Error("this world decides no plan"); } },
  });
  const entry = coreTaskEntryFrom(routes, async (caller) => { const found = people.get(caller.developerId); return found === undefined ? undefined : { principal: found.principal }; });
  const adminKey = ownerKeyForSubject(issuer, ADMIN_SUBJECT);
  const coreTasks: CoreTaskEntry = {
    route: (request, caller) => entry.route(request, caller),
    taskActions: (caller, taskId) => entry.taskActions!(caller, taskId),
    taskAction: (caller, input) => entry.taskAction!(caller, input),
    stopWorkspaceForAdmin: async (workspaceId, administrator, authorize) => stopWorkspaceAsAdministrator((await app.runtimeFor(FAKE_COMPANY)).flow.deps, workspaceId,
      { id: administrator.id, companyOf: async () => (administrator.id === adminKey ? FAKE_COMPANY : undefined) }, authorize),
  };
  const harness = await createDeveloperTaskBroker({ developerExtra: { coreTasks } });
  const rows = [
    ...await partition(world, `DEVTASK#${task.taskId}`), ...await partition(world, engineStampKey(task.taskId).pk),
    ...await partition(world, workspacePartition(FAKE_COMPANY, task.workspaceId)), ...await partition(world, `WORKSPACE#${task.workspaceId}`),
  ];
  for (const row of rows) harness.db.set(JSON.parse(JSON.stringify(row)) as Record<string, unknown> & { pk: string; sk: string });
  const operationId = (await world.store.get({ pk: workspacePartition(FAKE_COMPANY, task.workspaceId), sk: "META" }))!["activeOperationId"] as string;
  const status = async () => (await world.store.get({ pk: workspacePartition(FAKE_COMPANY, task.workspaceId), sk: `OPERATION#${operationId}` }))?.["status"];
  /** The thread's shared record, naming the core task (as a share would). */
  const shareThread = (overrides: Record<string, unknown> = {}) => {
    const developerId = "e".repeat(64);
    harness.db.set({ ...sharedTaskKey(CORE_THREAD), taskId: task.taskId, workspaceId: task.workspaceId, ownerKey: taskOwnerKey(developerId, task.taskId), developerId, developerName: "Owner", project: "payments", mode: "continue", sharedAt: "2026-11-15T00:00:00.000Z", ...overrides });
  };
  const route = vi.spyOn(coreTasks, "route");
  /** Unlinks a Slack person (their link row is removed), as a sign-out of the chat account does. */
  const unlink = async (userId: string) => { await world.store.delete({ key: orgChannelLinkKey(FAKE_COMPANY, linkOf(userId)) }); };
  return { world, app, harness, task, status, shareThread, coreTasks, route, unlink };
}

export type CoreSlackWorld = Awaited<ReturnType<typeof coreSlackWorld>>;

/** One Slack press, as Slack's interactivity hands it on. */
export function slackPress(overrides: Partial<SlackBlockAction> & Pick<SlackBlockAction, "actionId" | "value" | "userId">): SlackBlockAction {
  return {
    userTeamId: SLACK_TEAM, workspaceTeamId: SLACK_TEAM, enterpriseId: "", userEnterpriseId: "", requestStartedAt: 0, thread: CORE_THREAD,
    messageTs: "1695500001.000002", messageText: "", responseUrl: "https://hooks.slack.test/response", triggerId: "trigger-1", actionTs: "1695500002.000003",
    ...overrides,
  };
}

/**
 * The hosted press dispatcher over this world: the workflow handlers wired as `awsWorkflowSlackHandlers` wires them (the task row from the broker's table, the broker's REAL task authorization,
 * the broker's own workflow events), answering privately into `said`. Nothing here is stubbed that decides a press.
 */
export function hostedPressDispatcher(world: CoreSlackWorld) {
  const said: string[] = [];
  const views: Array<{ method: string; body: unknown }> = [];
  const updates: Array<{ text: string; blocks: unknown[] }> = [];
  const blocksSaid: unknown[][] = [];
  const invoke = async (event: Record<string, unknown>) => {
    const response = await world.harness.handler({ source: "agentx.slack-ingress", ...event });
    return { statusCode: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  };
  const respondEphemeral = async (_url: string, text: string, blocks?: unknown[]) => { said.push(text); if (blocks !== undefined) blocksSaid.push(blocks); };
  const workflow = workflowSlackHandlers({
    loadTask: async (taskId) => { const item = world.harness.db.get(`DEVTASK#${taskId}`, "META"); return item === undefined ? undefined : structuredClone(item); },
    authorize: async (taskId, userId, thread, taskAction) => {
      const answer = await invoke({ action: "task-people-authorize", taskId, userId, thread, taskAction });
      if (answer.statusCode !== 200) throw Object.assign(new Error("task authorization refused"), { code: (answer.body as { error?: { code?: unknown } }).error?.code });
    },
    openView: async () => undefined,
    submit: async () => undefined,
    close: async (input) => { const answer = await invoke({ action: "workflow-close", ...input }); if (answer.statusCode !== 200) throw new Error("the broker refused the close"); },
    respondEphemeral,
  });
  // The registry's press handler, wired as the interactivity Lambda wires it: the broker's own event, Slack's Web API answered by a fake that keeps what it was asked.
  const handlerDeps = taskActionDepsFrom({
    invokeBroker: async (event) => { const response = await world.harness.handler(event); return { statusCode: response.statusCode, body: response.body }; },
    api: async (method, body) => {
      views.push({ method, body });
      if (method === "chat.update") updates.push(body as { text: string; blocks: unknown[] });
      return method === "views.open" ? { view: { id: `V${String(views.length)}` } } : {};
    },
    respondEphemeral,
    isCoreTask: async (taskId) => await isCoreTask({ documentClient: world.harness.db, tableName: "state" }, taskId),
    log: () => undefined,
  });
  const taskActions = taskActionPressHandler(handlerDeps);
  const submit = taskActionSubmission(handlerDeps);
  const press = createSlackPressDispatcher({ handlers: [], workflow, respondEphemeral, taskActions });
  return { press, said, views, updates, blocksSaid, submit };
}

// ---- seeding a task into the state a move starts from, in the core's own store


/** Puts a workflow on the world's task (its owner key kept) and frees the workspace, so a move that starts a step is not told the workspace is busy. */
export async function seedWorkflow(world: CoreSlackWorld, make: (base: WorkflowSnapshot, ownerKey: string) => WorkflowSnapshot | Record<string, unknown>): Promise<void> {
  const stored = (await world.world.store.get(taskKey(world.task.taskId)))!;
  const ownerKey = stored["ownerKey"] as string;
  const base = WorkflowSnapshotSchema.parse({ ...blockedReview(), ownerId: ownerKey });
  const next = WorkflowSnapshotSchema.parse(make(base, ownerKey));
  await world.world.store.put({ item: { ...stored, workflow: JSON.parse(JSON.stringify(next)) as JsonValue } });
  const workspace = await world.world.store.get(workspacePartitionKey(world));
  if (workspace !== undefined) await world.world.store.put({ item: { ...workspace, activeOperationId: null, status: "READY" } });
}
const workspacePartitionKey = (world: CoreSlackWorld) => ({ pk: workspacePartition(FAKE_COMPANY, world.task.workspaceId), sk: "META" });

/** What the core offers this Slack person for the task now, and a card button value as the thread card would carry it. */
export async function offersFor(world: CoreSlackWorld, slackUser: string) {
  const caller = { developerId: developerIdForSlackUser(slackUser), sessionId: "s", name: slackUser };
  return (await world.coreTasks.taskActions!(caller, world.task.taskId)) ?? [];
}
export const buttonValueOf = (taskId: string, offer: { binding: { revision: number; digest?: string | undefined }; needsDialog: boolean }): string =>
  JSON.stringify({ t: taskId, r: offer.binding.revision, ...(offer.binding.digest === undefined ? {} : { d: offer.binding.digest }), ...(offer.needsDialog ? { n: 1 } : {}) });

/** The workspace's operations of one workflow mode (what a move that starts a step left behind). */
export async function operationsOfMode(world: CoreSlackWorld, mode: string) {
  const deps = (await world.app.runtimeFor(FAKE_COMPANY)).flow.deps;
  return (await workspaceOperations(deps, world.task.workspaceId)).filter((operation) => operation.workflowMode === mode);
}
