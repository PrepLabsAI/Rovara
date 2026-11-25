// RD-2.0-READ-RULE: one world for "may this person read this task", used by the golden test (the answers of every read for every kind of person) and the
// table test (the one decision function against the real routes). It is built only from what the repository already has (the core host app, the dev routes, the real
// aws task rule routes over a fake document table), so the same file runs before and after the read rule was folded into one function.
//
// The persons (one row each; "acts" and "reads" are what the company's own rule says, as `hostedTaskAccess.canAct` and `.canRead` do):
//   owner               the task's own person (a People owner)
//   co-owner            a People owner who is not the task's own person
//   project member      holds a project grant, nothing on the task
//   commenter, viewer   People roles on the task
//   shared reader       the stored share (spec 067), a live project member
//   unknown role        a stored share row whose role the code does not know
//   left the project    a stored share, no longer a project member
//   company admin       the company role "admin", nothing on the task
//   admin and shared    the company role "admin" and a stored share
//   removed member      no live membership
//   stranger            a member with no project grant and nothing on the task
//   other company       a member of ANOTHER company, with a stored share row naming them
//   script token        the owner's script token
// and two more kinds, each the STARTER of a task of their own, whom the company's rule still admits (it re-reads no project grant for the task's own person with no People list) while they are gone:
//   starter, removed from the project   a task with no People list, the person no longer holds a grant on the project
//   starter, removed from the company   a task with a People list, the company's live membership gone (the host's read of it is a moment older than the rule's)
import { createHash, randomUUID } from "node:crypto";
import { vi } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, type JsonValue, type OrgId, type OrgRole, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import type { TaskAccess } from "../../packages/broker/src/core/task-flow/deps.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CoreDevRoutes, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { createCoreTaskRuleRoutes } from "../../packages/broker/src/aws/core-task-rule-routes.js";
import type { DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "./core-host-fakes.js";
import { answer, scriptedModel } from "./answer-world.js";

export const OTHER_COMPANY = "org_corehost00000000000b" as OrgId;
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const idOf = (name: string): string => createHash("sha256").update(`read-rule-world\u0000${name}`).digest("hex");

export type PersonaName = "starter via the bound channel" | "channel share member" | "starter removed from the project" | "starter removed from the company" | "owner" | "co-owner" | "project member" | "commenter" | "viewer" | "shared reader" | "unknown role" | "left the project" | "company admin" | "admin and shared"
  | "removed member" | "stranger" | "other company" | "script token";

export interface Persona {
  name: PersonaName;
  personId: string;
  companyId: OrgId;
  /** The live company role; undefined: no live membership. */
  role: OrgRole | undefined;
  /** The company's own rule (`canAct`, `ownerActing`): the task's own person, or a People owner. */
  acts: boolean;
  /** The company's own read rule (`canRead`): People owner, commenter, viewer. */
  reads: boolean;
  /** The People role stored on the task (the old page rule reads it). */
  people?: "owner" | "commenter" | "viewer";
  /** The stored share row's role text, when there is a row. */
  share?: string;
  /** The stored reader is still a member of the task's project. */
  projectMember: boolean;
  scriptToken?: boolean;
  /** The person starts a task of their own (asked instead of the main task). */
  starter?: boolean;
  /** The person is a fresh member of the bound channel the project lets use it: the access that let them START their task, with no grant (the hotfix's `mayStart`, held for an OLD-engine task only: this world's tasks are all the core's). */
  channel?: boolean;
  /** The person is not on the People list, has no grant, and is in the Slack channel the task is shared into (a Slack identity): the old page rule's implicit commenter. */
  viaShare?: boolean;
}

const p = (name: PersonaName, over: Partial<Persona>): Persona => ({ name, personId: idOf(name), companyId: FAKE_COMPANY, role: "member", acts: false, reads: false, projectMember: false, ...over });
export const PERSONAS: readonly Persona[] = [
  p("owner", { acts: true, reads: true, people: "owner", projectMember: true }),
  p("co-owner", { acts: true, reads: true, people: "owner", projectMember: true }),
  p("project member", { projectMember: true }),
  p("commenter", { reads: true, people: "commenter", projectMember: true }),
  p("viewer", { reads: true, people: "viewer", projectMember: true }),
  p("shared reader", { share: "viewer", projectMember: true }),
  p("unknown role", { share: "editor", projectMember: true }),
  p("left the project", { share: "viewer", projectMember: false }),
  p("company admin", { role: "admin", projectMember: true }),
  p("admin and shared", { role: "admin", share: "viewer", projectMember: true }),
  p("removed member", { role: undefined }),
  p("stranger", { projectMember: false }),
  p("other company", { companyId: OTHER_COMPANY, share: "viewer", projectMember: true }),
  { ...p("script token", { acts: true, reads: true, people: "owner", projectMember: true }), personId: idOf("owner"), scriptToken: true },
];
/** The two starters: not part of the base's golden (the base admitted them), part of the table. */
/** What a Slack share grants (the owner's open question): a person with no grant, not on the list, in the channel the task is shared into. */
export const SHARE_MEMBER: Persona = p("channel share member", { viaShare: true });
export const STARTERS: readonly Persona[] = [
  p("starter removed from the project", { acts: true, reads: true, starter: true, projectMember: false }),
  p("starter removed from the company", { acts: true, reads: true, people: "owner", starter: true, projectMember: false }),
];
export const ALL_PERSONAS: readonly Persona[] = [...PERSONAS, ...STARTERS, SHARE_MEMBER];
/** A person who started a task through the bound channel with no grant. The hotfix's ruling (a): channel access holds an OLD-engine task only, so on the core they hold nothing (this world's tasks are all the core's). A test of its own. */
export const CHANNEL_STARTER: Persona = p("starter via the bound channel", { acts: true, reads: true, starter: true, projectMember: false, channel: true });
const WORLD_PERSONAS: readonly Persona[] = [...ALL_PERSONAS, CHANNEL_STARTER];
export const personaOf = (name: PersonaName): Persona => ALL_PERSONAS.find((persona) => persona.name === name)!;

/** What a persona's task reads are asked as. */
export const READS = ["task", "answers", "readable", "merge", "events", "diff", "plan", "evidence", "comments", "spec", "checks", "changes", "timeline"] as const;
export type ReadName = (typeof READS)[number];

/**
 * The company's own task rule for the personas above (the shape `hostedTaskAccess` has: acts and reads are separate; admins and project members get nothing from it). With `hosted`, the PRODUCTION shape: it says it
 * proves the grant (`provesProjectGrant`) and so refuses a person who no longer holds one (the hotfix's re-check: the starters who left are refused by the rule itself). Without it, the rule trusts the stored person
 * (the shape before the hotfix, and a laptop's): the read rule's live-grant seam is then the only grant check.
 */
export function personaAccess(options: { hosted?: boolean } = {}): TaskAccess {
  const by = new Map(WORLD_PERSONAS.map((persona) => [persona.personId + persona.companyId, persona]));
  const of = (principal: { personId: string; companyId: string }) => by.get(principal.personId + principal.companyId);
  return {
    ...createOwnerTaskAccess(),
    async checkStart() { return { allowed: true }; },
    async checkStep() { return { allowed: true }; },
    ...(options.hosted === true ? { provesProjectGrant: true as const } : {}),
    async canAct(principal) { const persona = of(principal); return persona?.acts === true && (options.hosted !== true || persona.projectMember); },
    async canRead(principal) { const persona = of(principal); return persona?.reads === true && (options.hosted !== true || persona.projectMember); },
    async ownerActing(principal, task) { const persona = of(principal); return persona?.acts === true && (options.hosted !== true || persona.projectMember) ? { actorId: task.ownerKey } : undefined; },
  };
}

export interface Answer { status: number; code?: string; message?: string; shape?: string }

async function register(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

export interface ReadRuleWorld {
  world: FakeWorld;
  app: CoreHostApp;
  routes: CoreDevRoutes;
  taskId: string;
  db: FakeDynamoDb;
  caller(persona: Persona): DeployedCaller;
  /** The answer of one read for one person, as the real routes give it, normalised so two worlds compare. */
  ask(persona: Persona, read: ReadName): Promise<Answer>;
  /** The raw answer (the body), for the checks that look inside. */
  raw(persona: Persona, read: ReadName): Promise<{ status: number; body: unknown } | boolean | undefined>;
  logs: Array<Record<string, unknown>>;
  setWiring(over: Partial<CoreDevWiring> | undefined): void;
  /** The task a person's reads are asked about: their own for a starter, the main task for everyone else. */
  taskIdOf(persona: Persona): string;
  /** Moves a person to another company between two reads: their project grant is now in that company only (their membership read for the mount is a moment older). */
  moveTo(persona: Persona, companyId: OrgId): void;
  /** Each time the pull request's diff was read (`diffPullRequest`): the proof that a refused person never reaches it. */
  diffReads: string[];
  /** Each time the task's own person's hold on their task was read (the hotfix's one test): the proof that it is read once per way in. */
  ownTaskReads: string[];
}

export async function readRuleWorld(options: { access?: TaskAccess; diffPullRequest?: boolean; hosted?: boolean } = {}): Promise<ReadRuleWorld> {
  const world = createFakeWorld();
  await register(world, FAKE_COMPANY);
  await register(world, OTHER_COMPANY);
  const app = createCoreHostApp({
    modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: options.access ?? personaAccess({ hosted: options.hosted === true }), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
  });
  const owner = personaOf("owner");
  const ownerPrincipal = { ...localOwnerPrincipal({ companyId: FAKE_COMPANY, personId: owner.personId }), roles: ["member"] };
  const { task } = await (await app.runtimeFor(FAKE_COMPANY)).flow.start({ principal: ownerPrincipal, client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
  const taskId = task.taskId;
  // The starters' own tasks.
  const ownTasks = new Map<string, string>();
  for (const starter of [...STARTERS, CHANNEL_STARTER]) {
    const principal = { ...localOwnerPrincipal({ companyId: FAKE_COMPANY, personId: starter.personId }), roles: ["member"] };
    const started = await (await app.runtimeFor(FAKE_COMPANY)).flow.start({ principal, client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
    ownTasks.set(starter.personId, started.task.taskId);
  }
  const taskIdOf = (persona: Persona): string => ownTasks.get(persona.personId) ?? taskId;
  if (options.diffPullRequest === true) {
    for (const id of [taskId, ...ownTasks.values()]) {
      const row = (await world.store.get(taskKey(id)))! as unknown as { workflow: Record<string, unknown> };
      await world.store.put({ item: { ...row, workflow: { ...row.workflow, pullRequests: [{ repositoryId: "demo", number: 1, url: "https://github.com/example/demo/pull/1", state: "OPEN", candidateDigest: "a".repeat(64), required: true }] } } as never });
    }
  }
  // The task is shared into a Slack channel (the channel the share member is in): the People list's implicit commenter reads it.
  {
    const row = (await world.store.get(taskKey(taskId)))! as unknown as Record<string, unknown>;
    await world.store.put({ item: { ...row, share: { teamId: "T0SHARED", channelId: "C0SHARED", threadTs: "1700000000.000100" } } as never });
  }
  const diffReads: string[] = [];
  const ownTaskReads: string[] = [];

  // The old rules' own rows, over a fake table: the stored shares and the People list the page rule reads.
  const db = new FakeDynamoDb();
  for (const persona of PERSONAS) {
    if (persona.share !== undefined) db.set({ pk: `DEVTASK#${taskId}`, sk: `READER#${persona.personId}`, schemaVersion: 1, developerId: persona.personId, role: persona.share, grantedBy: owner.personId, grantedAt: "2026-11-15T00:00:00.000Z" });
  }
  const people = PERSONAS.filter((persona) => persona.people !== undefined && persona.name !== "script token").map((persona) => ({ developerId: persona.personId, name: persona.name.replace(" ", "-"), method: "oidc", role: persona.people! }));
  db.set({ pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people });
  // A starter's own task: a People list only where the person has one (the removed-from-the-project starter has none: the hole the company's rule leaves).
  for (const starter of STARTERS) {
    if (starter.people !== undefined) db.set({ pk: `DEVTASK#${ownTasks.get(starter.personId)!}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [{ developerId: starter.personId, name: starter.name.replaceAll(" ", "-"), method: "oidc", role: starter.people }] });
  }
  // Where a person holds a project grant now: their company, until they are moved (`moveTo`).
  const movedTo = new Map<string, OrgId>();
  const grantCompany = (persona: Persona): OrgId => movedTo.get(persona.personId) ?? persona.companyId;
  const byId = new Map(WORLD_PERSONAS.map((persona) => [persona.personId, persona]));
  const logs: Array<Record<string, unknown>> = [];
  const depsFor = (person: { developerId: string; name: string }, companyId: OrgId): DeveloperTaskRouteDependencies => ({
    documentClient: { send: (command: unknown) => db.send(command as never) }, tableName: "state", now: () => world.clock.now, companyId,
    log: (entry: Record<string, unknown>) => { logs.push(entry); },
    checkAccess: async () => undefined,
    taskPeopleConfiguration: { peopleChangesEnabled: true },
    // Every person is eligible and present: the stored People role alone decides, as it does for a person with a live proof.
    checkTaskPerson: async (_task: unknown, developerId: string) => {
      const persona = byId.get(developerId);
      const name = persona?.name.replaceAll(" ", "-") ?? "person";
      // A Slack identity (the person is in the share's channel, read live) for the share member; the others are web identities.
      const slack = persona?.viaShare === true ? { slackUserId: `U0${developerId.slice(0, 8).toUpperCase()}` } : {};
      return { subject: { developerId, ...slack }, identity: { developerId, ...slack, name, method: "oidc", issuer: "https://idp.example.test", subject: developerId }, eligible: true, channelMember: true };
    },
    // As the broker's reader: with `ownTask` (the task's own person asking whether they still hold their task) it also says whether they may use the project as a task START does (the grant, or a bound-channel member).
    taskReaderPerson: async (developerId: string, _project: string, _company?: string, ownTask?: { ownTask?: true }) => {
      const persona = byId.get(developerId);
      if (persona === undefined || persona.role === undefined) return undefined;
      // As the broker's reader: a person whose live company is not the task's has no grant there.
      if (_company !== undefined && _company !== grantCompany(persona)) return { name: persona.name, projectMember: false };
      if (ownTask?.ownTask === true) { ownTaskReads.push(developerId); return { name: persona.name, projectMember: persona.projectMember, mayStart: persona.projectMember }; }
      return { name: persona.name, projectMember: persona.projectMember };
    },
    readPullRequestDiff: options.diffPullRequest === true ? async (url: string) => { diffReads.push(url); return { files: [], more: false }; } : undefined,
  } as unknown as DeveloperTaskRouteDependencies);
  void depsFor;
  const rules = createCoreTaskRuleRoutes(depsFor);

  let wiringOver: Partial<CoreDevWiring> | undefined;
  const wiring = (): CoreDevWiring => ({
    origin: () => "https://api.example",
    taskActions: { roundCap: async () => undefined },
    taskRules: rules,
    // The person's live company membership and current project grant (the host's `projectGrant`).
    // The grant is read in the company asked (or, with none, the person's live one); a person moved to another company holds a grant there only.
    canReadProject: async (personId: string, _project: string, companyId?: string) => { const persona = byId.get(personId); return persona !== undefined && persona.role !== undefined && persona.projectMember && (companyId ?? grantCompany(persona)) === grantCompany(persona); },
    merge: { projectGrantRole: async (personId: string) => { const persona = byId.get(personId); return persona !== undefined && persona.role !== undefined && persona.projectMember ? "developer" : undefined; }, merge: () => { throw new Error("merging is not wired in this world"); }, afterMerge: async () => undefined },
    answers: {
      standing: async () => ({ access: "view" }), repositories: async () => ({ handles: [], names: [] }),
      model: () => scriptedModel([answer([{ text: "The task is starting.", cites: [{ kind: "task_state", quote: "No document has been written yet." }] }])]),
    },
    ...wiringOver,
  });
  const routes = createCoreDevRoutes({
    app, wiring,
    companyOf: async (caller) => {
      const persona = byId.get(caller.principal.personId);
      return persona === undefined || persona.role === undefined ? undefined : { companyId: persona.companyId, role: persona.role };
    },
  });
  const principalOf = (persona: Persona) => ({ ...localOwnerPrincipal({ companyId: persona.companyId, personId: persona.personId }), roles: [persona.role ?? "member"] });
  const caller = (persona: Persona): DeployedCaller => ({ principal: principalOf(persona), client: persona.scriptToken === true ? "cli" : "cloud-web", ...(persona.scriptToken === true ? { scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } } : {}) });

  const get = (path: string) => ({ method: "GET", path, headers: {}, body: "" });
  const pathsOf = (id: string): Record<Exclude<ReadName, "answers" | "readable">, string> => ({
    task: `/v1/dev/tasks/${id}`, merge: `/v1/app/tasks/${id}/merge`, events: `/v1/dev/tasks/${id}/events`,
    diff: `/v1/dev/tasks/${id}/diff?repository=demo&number=1&page=1`, plan: `/v1/dev/tasks/${id}/plan`, evidence: `/v1/dev/tasks/${id}/evidence`,
    comments: `/v1/dev/tasks/${id}/comments`, spec: `/v1/dev/tasks/${id}/spec`, checks: `/v1/dev/tasks/${id}/checks`, changes: `/v1/dev/tasks/${id}/changes`, timeline: `/v1/dev/tasks/${id}/timeline`,
  });
  const answersRequest = (id: string) => ({ method: "POST", path: "/v1/app/projects/payments/answers", headers: {}, body: JSON.stringify({ requestId: `req-${randomUUID().slice(0, 12)}`, question: "Where does this task stand?", taskId: id }) });
  const raw = async (persona: Persona, read: ReadName) => {
    const id = taskIdOf(persona);
    if (read === "readable") return await routes.taskReadable(caller(persona), id);
    const response = await routes.route(read === "answers" ? answersRequest(id) : get(pathsOf(id)[read]), caller(persona));
    if (response === undefined) return undefined;
    let body: unknown;
    try { body = JSON.parse(response.body) as unknown; } catch { body = response.body; }
    return { status: response.statusCode, body };
  };
  const shapeOf = (body: unknown): string => {
    if (typeof body !== "object" || body === null) return typeof body;
    const record = body as Record<string, unknown>;
    // An answer is known by its member names; for the task view also whether it carries the task's money (the figures belong to the owner rule).
    const top = Object.keys(record).sort().join(",");
    const task = record["task"];
    if (typeof task === "object" && task !== null) return `${top} | task:${Object.keys(task).includes("money") ? "money" : "no-money"}`;
    return top;
  };
  const ask = async (persona: Persona, read: ReadName): Promise<Answer> => {
    const found = await raw(persona, read);
    if (typeof found === "boolean") return { status: found ? 200 : 404, shape: found ? "readable" : "not readable" };
    if (found === undefined) return { status: 0, shape: "no answer" };
    const normal = (text: string) => text.replaceAll(taskIdOf(persona), "<task>");
    const body = found.body as { error?: { code?: string; message?: string }; outcome?: string };
    if (typeof body === "object" && body !== null && body.error !== undefined) return { status: found.status, code: body.error.code ?? "", message: normal(body.error.message ?? "") };
    if (read === "answers") return { status: found.status, shape: `outcome:${String(body.outcome)}` };
    return { status: found.status, shape: normal(shapeOf(found.body)) };
  };
  void vi;
  return { world, app, routes, taskId, db, caller, ask, raw, logs, taskIdOf, diffReads, ownTaskReads, moveTo: (persona, companyId) => { movedTo.set(persona.personId, companyId); }, setWiring: (over) => { wiringOver = over; } };
}
