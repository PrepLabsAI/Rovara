// The Team record on the core host: capture rides the company's lessons milestones (a merged task of the company writes its members' words; another company's task writes nothing), the search answers
// for the company's own task, and the person erase removes the person's rows whatever the switch says.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, teamRecordPk, type JsonValue, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { buildCoreRegistry, createCoreRuntime, readCoreEngineFlags } from "../../packages/broker/src/core-host/index.js";
import { createCoreLessons, type CoreLessons } from "../../packages/broker/src/core-host/lessons.js";
import { attachCoreTeamRecord, erasePersonTeamRecord, hostedEraseLearning } from "../../packages/broker/src/core-host/team-record.js";
import type { HostedLessonPeople } from "../../packages/broker/src/lessons/hosted-people.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";

const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};

const everyoneIsMember: HostedLessonPeople = {
  async approvers() { return { complete: true, membershipVersion: 1, ownerIds: [], eligibleIds: [], lastEligibleLossAtMs: null }; },
  async onProjectRoster() { return true; },
  async linkedAccounts() { return []; },
  async displayName() { return "Member"; },
  async isErased() { return false; },
};

async function setup(world: FakeWorld) {
  const registry = await buildCoreRegistry({ modules: world.modules, context: world.context(), areas: ["flow", "build", "merge"] });
  const out: Record<string, { lessons: CoreLessons; taskId: string; personId: string }> = {};
  for (const companyId of [A, B]) {
    await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
    await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
    const runtime = createCoreRuntime({
      registry, companyId, flags: readCoreEngineFlags({ ROVARA_CORE_ENGINE: "on" }), callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5),
      repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined,
    });
    const lessons = createCoreLessons({ flow: runtime.flow, registry, companyId, lessonsSwitch: { mode: "on" }, people: everyoneIsMember, hostFor: async () => undefined, now: () => world.clock.now })!;
    const principal = localOwnerPrincipal({ companyId });
    const { task } = await runtime.flow.start({ principal, client: "test", origin: "app" as const }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint that returns the build version", workflow: true, workflowPath: "QUICK" });
    out[companyId] = { lessons, taskId: task.taskId, personId: principal.personId };
  }
  return out;
}

describe("the Team record on the core host", () => {
  it("a task of the company is recorded on its milestone and found by the company's own task; another company's task is not recorded", async () => {
    const world = createFakeWorld();
    const companies = await setup(world);
    const a = companies[A]!;
    const b = companies[B]!;
    // The milestones keep their handlers private: capture the record's handler as it registers.
    const captured: Array<{ name: string; on(m: { kind: "merged"; orgId: string; taskId: string; at: string; text: string }): Promise<void> }> = [];
    const register = a.lessons.milestones.register.bind(a.lessons.milestones);
    (a.lessons.milestones as { register: typeof register }).register = (handler) => { captured.push(handler); return register(handler); };
    const record = attachCoreTeamRecord(a.lessons, { store: world.store, now: () => world.clock.now });
    expect(captured.map((handler) => handler.name)).toEqual(["team_record"]);
    const at = new Date(world.clock.now).toISOString();
    const deliver = async (taskId: string) => { for (const handler of captured) await handler.on({ kind: "merged", orgId: A, taskId, at, text: "merged" }); };
    await deliver(b.taskId);
    expect((await world.store.query({ pk: teamRecordPk(A, "payments") })).items.filter((item) => item["entityType"] === "TEAM_RECORD_ROW")).toEqual([]);
    await deliver(a.taskId);
    const hits = await record.search.search({ orgId: A, projectId: "payments", query: "health endpoint build version", asAgentForTask: a.taskId, limit: 5 });
    expect(hits.map((hit) => hit.title)).toEqual(["An earlier task"]);
    expect(await record.search.search({ orgId: A, projectId: "payments", query: "health endpoint", asAgentForTask: b.taskId, limit: 5 })).toEqual([]);

    const erased = await erasePersonTeamRecord({ store: world.store, companyId: A, personId: a.personId, now: () => world.clock.now });
    expect(erased).toEqual({ rows: 1 });
    expect(await record.search.search({ orgId: A, projectId: "payments", query: "health endpoint build version", asAgentForTask: a.taskId, limit: 5 })).toEqual([]);
  });
});

describe("the deployed person erase's learning step (lessons and Team record)", () => {
  it("removes the person's Team record rows and runs the lessons erase, whatever the switch says; another company's rows stay", async () => {
    const world = createFakeWorld();
    const companies = await setup(world);
    const a = companies[A]!;
    const b = companies[B]!;
    const handlers: Array<{ on(m: { kind: "merged"; orgId: string; taskId: string; at: string; text: string }): Promise<void> }> = [];
    for (const company of [a, b]) {
      const register = company.lessons.milestones.register.bind(company.lessons.milestones);
      (company.lessons.milestones as { register: typeof register }).register = (handler) => { handlers.push(handler); return register(handler); };
      attachCoreTeamRecord(company.lessons, { store: world.store, now: () => world.clock.now });
    }
    const at = new Date(world.clock.now).toISOString();
    for (const [orgId, taskId] of [[A, a.taskId], [B, b.taskId]] as const) for (const handler of handlers) await handler.on({ kind: "merged", orgId, taskId, at, text: "merged" }).catch(() => undefined);
    const rowsOf = async (companyId: string) => (await world.store.query({ pk: teamRecordPk(companyId, "payments") })).items.filter((item) => item["entityType"] === "TEAM_RECORD_ROW").length;
    expect(await rowsOf(A)).toBe(1);
    expect(await rowsOf(B)).toBe(1);
    const erase = hostedEraseLearning({ store: world.store, audit: { stage: () => [], record: async () => undefined }, now: () => world.clock.now });
    const report = await erase(A, a.personId);
    expect(report.teamRecordRows).toBe(1);
    expect(report.lessons).toMatchObject({ projects: 1 });
    expect(await rowsOf(A)).toBe(0);
    expect(await rowsOf(B)).toBe(1);
    // Repeating it is harmless (the erase is resumed or repeated).
    expect((await erase(A, a.personId)).teamRecordRows).toBe(0);
    await expect(erase("not-a-company", a.personId)).rejects.toThrow();
  });
});

