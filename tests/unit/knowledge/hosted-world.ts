// One company's hosted lessons (core-host/lessons.ts over the fake hosted world) for the knowledge tests: projects `payments` (repository demo) and `billing` (repository ledger), a task of `payments` started by
// OWNER, and the tool door the hosted knowledge API answers through (`lessons/knowledge-serve.ts`). The install's lessons switch can be turned off after the lessons are built.
import { randomUUID } from "node:crypto";
import { AgentXError, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal } from "../../../packages/broker/src/ports/policy-defaults.js";
import { buildCoreRegistry, createCoreRuntime } from "../../../packages/broker/src/core-host/index.js";
import { createCoreLessons, setCoreLessonsGate, CORE_LESSONS_VARIABLE, type CoreLessons } from "../../../packages/broker/src/core-host/lessons.js";
import { createKnowledgeServer, type KnowledgeCall } from "../../../packages/broker/src/lessons/knowledge-serve.js";
import { knowledgeReadStores } from "../../../packages/broker/src/lessons/knowledge-read-stores.js";
import type { HostedLessonPeople } from "../../../packages/broker/src/lessons/hosted-people.js";
import { createFakeWorld, FAKE_COMPANY } from "../../support/core-host-fakes.js";

export const COMPANY = FAKE_COMPANY as OrgId;
export const OWNER = "ann";
export const REPO_PAY = "https://github.com/example/demo.git";
export const REPO_BILL = "https://github.com/example/billing.git";
const PROJECTS: ProjectDefinition[] = [
  { name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: REPO_PAY, path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] },
  { name: "billing", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "ledger", url: REPO_BILL, path: "repo/ledger", defaultBranch: "main", credentialRef: "host-app" }] },
];

/** A tool's call at the door: the person (the token's creator for a script token) and the token, when there is one. */
export interface ToolCaller { personId: string; token?: KnowledgeCall["token"] }

export async function hostedKnowledgeWorld() {
  const fake = createFakeWorld();
  setCoreLessonsGate({ [CORE_LESSONS_VARIABLE]: "on" });
  const registry = await buildCoreRegistry({ modules: fake.modules, context: fake.context(), areas: ["flow", "build", "merge"] });
  for (const project of PROJECTS) {
    await fake.store.put({ item: { ...projectRevisionKey(COMPANY, project.name, project.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(project)) as JsonValue } });
    await fake.store.put({ item: { ...orgProjectCatalogKey(COMPANY, project.name), entityType: "PROJECT_CATALOG", latestRevision: project.revision } });
  }
  const runtime = createCoreRuntime({
    registry, companyId: COMPANY, callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5),
    repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(fake.clock.now), log: () => undefined,
  });
  const people: HostedLessonPeople = {
    async approvers() { return { complete: true, membershipVersion: 1, ownerIds: [OWNER], eligibleIds: [OWNER, "bob", "cy"], lastEligibleLossAtMs: null }; },
    async onProjectRoster() { return true; }, async linkedAccounts() { return []; }, async displayName(_companyId, personId) { return `Name ${personId}`; }, async isErased() { return false; },
  };
  const lessonsSwitch: { mode: "on" | "off" } = { mode: "on" };
  const core: CoreLessons = createCoreLessons({ flow: runtime.flow, registry, companyId: COMPANY, lessonsSwitch, people, hostFor: async () => undefined, now: () => fake.clock.now })!;
  core.attach();
  const caller = { principal: localOwnerPrincipal({ companyId: COMPANY, personId: OWNER }), client: "test", origin: "app" as const };
  const start = async (instructions: string) => (await runtime.flow.start(caller, { requestId: randomUUID(), project: "payments", instructions, workflow: true, workflowPath: "QUICK" })).task;
  const task = await start("Add a /health endpoint\nreturn 200");
  const { limits, counter } = knowledgeReadStores(fake.store, () => fake.clock.now);
  const server = createKnowledgeServer({ companyId: COMPANY, store: fake.store, now: () => fake.clock.now, runtime: core.runtime, limits, counter, names: async () => [], projectExists: (project) => core.projectExists(project) });
  /** A tool's suggestion through the door, as the HTTP route answers it: 200 with the body, or the error's status and its code and words. */
  async function propose(body: unknown, project = "payments", who: ToolCaller = { personId: OWNER }): Promise<{ status: number; body: Record<string, unknown> }> {
    try {
      const answer = await server.propose({ project, developerId: who.personId, body: typeof body === "string" ? body : JSON.stringify(body), ...(who.token === undefined ? {} : { token: who.token }) });
      return { status: 200, body: answer as Record<string, unknown> };
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { status: error.statusCode, body: { error: { code: error.code, message: error.message.slice(error.code.length + 2) } } };
    }
  }
  return {
    fake, core, propose, start,
    /** What the tests read and change of the install: its store, clock, audit records and audit sink. */
    h: { store: fake.store, clock: fake.clock, audit: fake.audit, deps: { audit: registry.require("audit-sink") } },
    lessons: { runtime: core.runtime, owner: { id: OWNER }, learnedFor: core.host.learnedFor.bind(core.host), onEvents: core.host.onEvents.bind(core.host) },
    taskId: task.taskId, workspaceId: task.workspaceId,
    setEnabled(value: boolean) { lessonsSwitch.mode = value ? "on" : "off"; },
  };
}
export type HostedKnowledgeWorld = Awaited<ReturnType<typeof hostedKnowledgeWorld>>;
