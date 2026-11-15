// Switch-on lane L11: the decision cards, the session levels and how we work on the deployed core, from the company's own records. The session levels read live membership and the broker's
// project grant and fail closed; a card lists only the task's own person's waiting documents, in their own company, while they are a member with the grant; an act re-checks that live authority,
// carries the approvers point's own proof (lane L2a's issuer) through the real approval gate, and records the approver only as the task's owner.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DecisionCardsViewSchema, createWorkflowSnapshot, orgProjectCatalogKey, projectRevisionKey, submitWorkflowArtifact,
  type AdapterRegistry, type ApprovalProof, type ApprovalRequest, type Approvers, type JsonValue, type OrgId, type OrgRole, type Principal, type ProjectDefinition, type WorkflowSnapshot,
} from "@agentx/contracts";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { coreAdapter } from "../../packages/broker/src/core-host/registry.js";
import { NOT_ON_THE_CORE_YET, createCoreDevRoutes, type DeployedDecisionCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import {
  DECISION_SOURCE_TASKS_MAX, deployedDecisionCards, deployedDevWiringParts, deployedSessionMembers, stepUpDecisionProofs,
  type DecisionAct, type DecisionProofIssuer, type DeployedPeople,
} from "../../packages/broker/src/core-host/deployed-decisions.js";
import type { CoreRuntime } from "../../packages/broker/src/core-host/core-runtime.js";
import { HOSTED_IDENTITY_PROVIDER, createHostedIdentity } from "../../packages/broker/src/core-host/hosted-modules.js";
import { createHostedApprovers, stepUpApprovalKeyOf } from "../../packages/broker/src/core-host/hosted-approvers.js";
import { hostedTaskAccess } from "../../packages/broker/src/aws/core-engine-root.js";
import { routeDecisionCards } from "../../packages/broker/src/core/decisions/routes.js";
import { decisionCardPath, projectDecisionCards } from "../../packages/broker/src/core/decisions/project.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { fixedCodeSettings } from "../../packages/broker/src/core/merge/defaults.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { taskIndexKey } from "../../packages/broker/src/developer/task-records.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";

const ORG = FAKE_COMPANY as OrgId;
const OTHER = "org_corehost00000000000b" as OrgId;
const METHOD = "test-deployed-step-up";
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });

const principalOf = (personId: string, companyId: string = ORG): Principal => ({ companyId, personId, displayName: personId, roles: ["member"], provider: HOSTED_IDENTITY_PROVIDER });

/** The company's records: memberships and project grants, changeable mid-test. */
function records() {
  const memberships = new Map<string, { companyId: OrgId; role: OrgRole }>();
  const grants = new Map<string, "developer" | "administrator" | "viewer">();
  const people: DeployedPeople = {
    membershipOf: vi.fn(async (personId: string) => memberships.get(personId)),
    projectGrantRole: vi.fn(async (personId: string, project: string) => {
      const role = grants.get(`${personId}|${project}`);
      return role === "developer" || role === "administrator" ? role : undefined;
    }),
  };
  return { memberships, grants, people };
}

/** A permissive stand-in for the approvers point: vouches for whoever the act names (to test the gate's own owner-only rule behind a point that says yes). */
function permissivePoint() {
  const issued = new Map<string, DecisionAct>();
  const acts: DecisionAct[] = [];
  const proofs: DecisionProofIssuer = {
    method: METHOD,
    issue: vi.fn((act: DecisionAct) => { acts.push(act); const token = randomUUID(); issued.set(token, act); return { method: METHOD, token }; }),
  };
  const approvers: Approvers = {
    async requirement() { return { methods: [METHOD], minApprovers: 1, selfApprovalAllowed: true, strongMethods: [METHOD], rejectMethods: [METHOD], changesMethods: [METHOD] }; },
    async verify(_request: ApprovalRequest, proof: ApprovalProof) {
      const act = issued.get(proof.token);
      return act === undefined ? { approved: false, reason: "invalid_proof" } : { approved: true, approver: { ...principalOf(act.personId, act.companyId), authTime: act.stepUp.at }, method: proof.method, proofId: proof.proofId };
    },
  };
  return { proofs, approvers, acts };
}

async function registerProject(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

/** The world, with lane L2a's real approvers point (the deployed identity over the company's memberships, the proof key) unless `permissive`. */
async function setup(options: { permissive?: boolean } = {}) {
  const world = createFakeWorld({ without: ["approvers", "identity"] });
  const { memberships, grants, people } = records();
  const identity = createHostedIdentity({ membershipOf: people.membershipOf, displayNameOf: async (personId) => personId });
  const key = stepUpApprovalKeyOf("k".repeat(32));
  const acts: DecisionAct[] = [];
  const hosted = stepUpDecisionProofs(key, () => world.clock.now);
  const fake = permissivePoint();
  const proofs: DecisionProofIssuer = options.permissive === true ? fake.proofs : { method: hosted.method, issue: vi.fn((act: DecisionAct) => { acts.push(act); return hosted.issue(act); }) };
  const point = { proofs, acts: options.permissive === true ? fake.acts : acts };
  world.modules.push(coreAdapter({ point: "identity", name: HOSTED_IDENTITY_PROVIDER, owner: "fake", create: () => identity }));
  world.modules.push(coreAdapter({
    point: "approvers", name: "deployed", owner: "fake",
    create: () => (options.permissive === true ? fake.approvers : createHostedApprovers({ store: world.store, identity, key, now: () => new Date(world.clock.now) })),
  }));
  await registerProject(world, ORG);
  await registerProject(world, OTHER);
  const app: CoreHostApp = createCoreHostApp({
    env: { ROVARA_CORE_ENGINE: "on" }, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: (_registry, companyId) => ({
      callbackSigningKey: Buffer.alloc(32, 7), access: hostedTaskAccess({ companyId, membershipOf: people.membershipOf, projectGrant: async (p, project) => (await people.projectGrantRole(p, project)) !== undefined }),
      repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI,
    }),
  });
  for (const [personId, companyId, role] of [["dev-a", ORG, "member"], ["dev-b", ORG, "admin"], ["dev-x", OTHER, "owner"]] as const) {
    memberships.set(personId, { companyId, role });
    grants.set(`${personId}|payments`, "developer");
  }
  const registry: AdapterRegistry = await app.registry();
  const runtime = await app.runtimeFor(ORG);
  const otherRuntime = await app.runtimeFor(OTHER);
  const log = vi.fn();
  const deps = deployedDecisionCards({ runtime, registry, people, proofs: point.proofs, log });
  const otherDeps = deployedDecisionCards({ runtime: otherRuntime, registry, people, proofs: point.proofs, log });

  /** A task of this person, waiting on a coding plan (Markdown unless `structured`), as the flow stores it. */
  const waitingTask = async (personId: string, companyId: OrgId = ORG, plan: { structured?: "bad"; closed?: boolean; notWaiting?: boolean; foreignKey?: boolean } = {}) => {
    const flow = companyId === ORG ? runtime.flow : otherRuntime.flow;
    const { task } = await flow.start({ principal: principalOf(personId, companyId), client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
    const stored = (await world.store.get(taskKey(task.taskId)))!;
    const ownerKey = stored["ownerKey"] as string;
    const objectKey = plan.foreignKey === true ? `private/${"f".repeat(64)}/elsewhere/plan-v1.md` : `private/${ownerKey}/${stored["workspaceId"] as string}/plan-v1.${plan.structured === undefined ? "md" : "json"}`;
    const text = "# Plan\n\nChange src/health.ts to answer 200.\n";
    const bytes = new TextEncoder().encode(text);
    await registry.require("object-storage").put(objectKey, bytes, { contentType: "text/markdown", metadata: {}, retention: "evidence-std" });
    const initial = createWorkflowSnapshot({ taskId: task.taskId, ownerId: ownerKey, now: "2026-11-15T09:59:00.000Z" });
    const workflow = plan.notWaiting === true ? initial : submitWorkflowArtifact(initial, {
      expectedRevision: initial.revision, now: "2026-11-15T10:00:00.000Z",
      artifact: { id: "plan-v1", type: "plan", version: 1, sha256: createHash("sha256").update(text).digest("hex"), producer: "agentx-planner", objectKey, createdAt: "2026-11-15T10:00:00.000Z", format: plan.structured === undefined ? "markdown" : "structured" },
    });
    await world.store.put({ item: { ...stored, workflow: JSON.parse(JSON.stringify(workflow)) as JsonValue, ...(plan.closed === true ? { closedAt: "2026-11-15T10:01:00.000Z" } : {}) } });
    return task.taskId;
  };
  const stored = async (taskId: string) => (await world.store.get(taskKey(taskId)))!["workflow"] as unknown as WorkflowSnapshot;
  return { world, app, registry, runtime, otherRuntime, deps, otherDeps, point, memberships, grants, people, log, waitingTask, stored };
}

const STEP_UP = { at: "2026-11-15T09:58:00.000Z", method: "email_code" };
/** The caller the card routes pass: for an act, with the step-up the route checked (as `Principal.authTime`). */
function cardCaller(personId: string, companyId: string = ORG, options: { stepUp?: boolean } = {}): DeployedDecisionCaller {
  const principal = principalOf(personId, companyId);
  const acting = options.stepUp !== false;
  return { orgId: companyId, developerId: developerIdOf(principal), principal: acting ? { ...principal, authTime: STEP_UP.at, methods: [STEP_UP.method] } : principal, ...(acting ? { stepUp: STEP_UP } : {}) };
}

type Deps = ReturnType<typeof deployedDecisionCards>;
const call = (deps: Deps, who: DeployedDecisionCaller, method: string, pathname: string, body?: unknown) => routeDecisionCards(deps, who, { method, pathname, searchParams: new URLSearchParams(), body: body ?? {} });
const view = async (deps: Deps, personId: string, companyId: string = ORG) => DecisionCardsViewSchema.parse((await call(deps, cardCaller(personId, companyId, { stepUp: false }), "GET", "/v1/app/decisions"))?.body);
const cardOf = (taskId: string) => `approve_plan:${taskId}`;

/** Opens the evidence and approves, as a page would; answers the approve's reply (or its refusal). */
async function approve(deps: Deps, taskId: string, who: DeployedDecisionCaller, viewer = who.principal.personId) {
  const shownDigest = (await view(deps, viewer, who.orgId)).digests[cardOf(taskId)]!;
  await call(deps, who, "POST", `${decisionCardPath(cardOf(taskId))}/evidence-opened`, { requestId: randomUUID(), shownDigest });
  return call(deps, who, "POST", `${decisionCardPath(cardOf(taskId))}/approve`, { requestId: randomUUID(), shownDigest });
}

describe("the deployed session levels (the company's own records)", () => {
  const people = (overrides: Partial<DeployedPeople> = {}): DeployedPeople => ({
    membershipOf: async (personId) => ({ "dev-o": { companyId: ORG, role: "owner" as const }, "dev-a": { companyId: ORG, role: "admin" as const }, "dev-m": { companyId: ORG, role: "member" as const }, "dev-x": { companyId: OTHER, role: "owner" as const } } as Record<string, { companyId: OrgId; role: OrgRole }>)[personId],
    projectGrantRole: async (personId, project) => (project !== "payments" ? undefined : personId === "dev-o" ? "administrator" : personId === "dev-m" || personId === "dev-x" ? "developer" : undefined),
    ...overrides,
  });
  const person = (personId: string, companyId: string = ORG) => ({ companyId, developerId: developerIdOf(principalOf(personId, companyId)), principal: principalOf(personId, companyId) });

  it("reads the live membership role and the project grant (administrator: maintainer, developer: contributor)", async () => {
    const members = deployedSessionMembers(ORG, people());
    expect(await members.companyRole(person("dev-o"))).toBe("owner");
    expect(await members.companyRole(person("dev-a"))).toBe("admin");
    expect(await members.companyRole(person("dev-m"))).toBe("member");
    expect(await members.projectGrant(person("dev-o"), "payments")).toBe("maintainer");
    expect(await members.projectGrant(person("dev-m"), "payments")).toBe("contributor");
    expect(await members.projectGrant(person("dev-a"), "payments")).toBeUndefined();
    expect(await members.projectGrant(person("dev-m"), "web")).toBeUndefined();
  });

  it("finds no one for another company's member, a non-member, a mismatched person, a re-check with no principal, or a read that fails", async () => {
    const members = deployedSessionMembers(ORG, people());
    const asked = [
      person("dev-x"), person("dev-x", OTHER), person("nobody"),
      // The session layer names one person, the principal another.
      { ...person("dev-o"), developerId: developerIdOf(principalOf("dev-m")) },
      // This company's principal asked about a session the layer says is another company's.
      { companyId: OTHER, developerId: developerIdOf(principalOf("dev-o")), principal: principalOf("dev-o") },
      // A principal of another company, under this company's session.
      { companyId: ORG, developerId: developerIdOf(principalOf("dev-o", OTHER)), principal: principalOf("dev-o", OTHER) },
      // A follower's re-check: the id only.
      { companyId: ORG, developerId: developerIdOf(principalOf("dev-o")) },
      { companyId: ORG, developerId: developerIdOf(principalOf("dev-o")), principal: null as never },
    ];
    for (const who of asked) {
      expect(await members.companyRole(who)).toBeUndefined();
      expect(await members.projectGrant(who, "payments")).toBeUndefined();
    }
    const failing = deployedSessionMembers(ORG, people({ membershipOf: async () => { throw new Error("dynamo down"); } }));
    expect(await failing.companyRole(person("dev-o"))).toBeUndefined();
    expect(await failing.projectGrant(person("dev-o"), "payments")).toBeUndefined();
    const grantFails = deployedSessionMembers(ORG, people({ projectGrantRole: async () => { throw new Error("dynamo down"); } }));
    expect(await grantFails.projectGrant(person("dev-o"), "payments")).toBeUndefined();
    // A revoked or unknown role is no membership.
    const odd = deployedSessionMembers(ORG, people({ membershipOf: async () => ({ companyId: ORG, role: "superuser" as never }) }));
    expect(await odd.companyRole(person("dev-o"))).toBeUndefined();
  });

  it("gives no project role to a person who holds a grant but is no longer a member", async () => {
    const members = deployedSessionMembers(ORG, people({ membershipOf: async () => undefined }));
    expect(await members.projectGrant(person("dev-o"), "payments")).toBeUndefined();
  });
});

describe("the deployed decision cards: what is listed", () => {
  it("lists only the caller's own waiting documents, in their own company (two companies, two people)", async () => {
    const t = await setup();
    const own = await t.waitingTask("dev-a");
    const theirs = await t.waitingTask("dev-b");
    const otherCompany = await t.waitingTask("dev-x", OTHER);
    expect((await view(t.deps, "dev-a")).cards.map((card) => card.id)).toEqual([cardOf(own)]);
    expect((await view(t.deps, "dev-b")).cards.map((card) => card.id)).toEqual([cardOf(theirs)]);
    expect((await view(t.otherDeps, "dev-x", OTHER)).cards.map((card) => card.id)).toEqual([cardOf(otherCompany)]);
    // A caller of the other company asking this company's cards, and this company's caller asking the other's, see nothing.
    expect((await view(t.deps, "dev-x", OTHER)).cards).toEqual([]);
    expect((await view(t.otherDeps, "dev-a")).cards).toEqual([]);
  });

  it("lists nothing for a person who is no longer a member, and leaves out a project they lost the grant on", async () => {
    const t = await setup();
    await t.waitingTask("dev-a");
    t.grants.delete("dev-a|payments");
    expect((await view(t.deps, "dev-a")).cards).toEqual([]);
    t.grants.set("dev-a|payments", "developer");
    t.memberships.delete("dev-a");
    expect((await view(t.deps, "dev-a")).cards).toEqual([]);
    t.memberships.set("dev-a", { companyId: OTHER, role: "owner" });
    expect((await view(t.deps, "dev-a")).cards).toEqual([]);
  });

  it("leaves out a task of another company even when the person's index row names this company (the task record decides)", async () => {
    const t = await setup();
    // dev-a once belonged to the other company and started a task there; their index (keyed by person, not company) keeps the row.
    t.memberships.set("dev-a", { companyId: OTHER, role: "member" });
    const elsewhere = await t.waitingTask("dev-a", OTHER);
    t.memberships.set("dev-a", { companyId: ORG, role: "member" });
    const row = (await t.world.store.query({ pk: taskIndexKey("dev-a", "", "").pk, sk: { op: "beginsWith", prefix: "TASK#" } })).items.find((item) => item["taskId"] === elsewhere)!;
    await t.world.store.put({ item: { ...row, orgId: ORG } });
    expect((await view(t.deps, "dev-a")).cards).toEqual([]);
  });

  it("leaves out another person's task even when a row in the caller's own index names it (the task record decides)", async () => {
    const t = await setup();
    const theirs = await t.waitingTask("dev-b");
    const row = (await t.world.store.query({ pk: taskIndexKey("dev-b", "", "").pk, sk: { op: "beginsWith", prefix: "TASK#" } })).items.find((item) => item["taskId"] === theirs)!;
    await t.world.store.put({ item: { ...row, pk: taskIndexKey("dev-a", "", "").pk } });
    expect((await view(t.deps, "dev-a")).cards).toEqual([]);
  });

  it("reads a document's facts only from the task's own storage: a pointer elsewhere reads as unread", async () => {
    const t = await setup();
    await t.waitingTask("dev-a");
    await t.waitingTask("dev-a", ORG, { foreignKey: true });
    const items = await t.deps.sources.list(cardCaller("dev-a", ORG, { stepUp: false }));
    expect(items.map((item) => (item as { files?: readonly string[] }).files).sort()).toEqual([[], ["src/health.ts"]]);
  });

  it("leaves out a closed task, a task that waits on nothing, and a structured document that does not read back", async () => {
    const t = await setup();
    await t.waitingTask("dev-a", ORG, { closed: true });
    await t.waitingTask("dev-a", ORG, { notWaiting: true });
    await t.waitingTask("dev-a", ORG, { structured: "bad" });
    expect((await view(t.deps, "dev-a")).cards).toEqual([]);
  });

  it("refuses a caller whose session id is not the principal's, or whose principal names another company", async () => {
    const t = await setup();
    await t.waitingTask("dev-a");
    const forged = { ...cardCaller("dev-a", ORG, { stepUp: false }), developerId: developerIdOf(principalOf("dev-b")) };
    expect(await t.deps.sources.list(forged)).toEqual([]);
    const crossed = { ...cardCaller("dev-a", ORG, { stepUp: false }), principal: principalOf("dev-a", OTHER) };
    expect(await t.deps.sources.list(crossed)).toEqual([]);
  });

  it("reads at most DECISION_SOURCE_TASKS_MAX index rows per listing, and says so when it cut", async () => {
    const t = await setup();
    const query = vi.fn(async () => ({ items: Array.from({ length: 100 }, () => ({ taskId: randomUUID(), orgId: ORG })), cursor: "more" }));
    const get = vi.fn(async () => undefined);
    const runtime = { companyId: ORG, flow: { deps: { ...t.runtime.flow.deps, companyId: ORG, store: { ...t.runtime.flow.deps.store, query, get } } } } as unknown as CoreRuntime;
    const deps = deployedDecisionCards({ runtime, registry: t.registry, people: t.people, proofs: t.point.proofs, log: t.log });
    expect(await deps.sources.list(cardCaller("dev-a", ORG, { stepUp: false }))).toEqual([]);
    expect(get).toHaveBeenCalledTimes(DECISION_SOURCE_TASKS_MAX);
    expect(t.log).toHaveBeenCalledWith(expect.objectContaining({ event: "core_engine.decision_cards_cut", read: DECISION_SOURCE_TASKS_MAX }));
  });

  it("stops after a bounded number of index reads even when every page holds only another company's rows", async () => {
    const t = await setup();
    const query = vi.fn(async () => ({ items: Array.from({ length: 100 }, () => ({ taskId: randomUUID(), orgId: OTHER })), cursor: "more" }));
    const runtime = { companyId: ORG, flow: { deps: { ...t.runtime.flow.deps, companyId: ORG, store: { ...t.runtime.flow.deps.store, query } } } } as unknown as CoreRuntime;
    const deps = deployedDecisionCards({ runtime, registry: t.registry, people: t.people, proofs: t.point.proofs, log: t.log });
    expect(await deps.sources.list(cardCaller("dev-a", ORG, { stepUp: false }))).toEqual([]);
    // Five listings of at most ten index reads each (listTasks' own bound).
    expect(query.mock.calls.length).toBeLessThanOrEqual(50);
    expect(t.log).toHaveBeenCalledWith(expect.objectContaining({ event: "core_engine.decision_cards_cut", read: 0 }));
  });
});

describe("the deployed decision cards: acting", () => {
  it("approves the task's own document with the point's proof, bound to the request; the task moves on", async () => {
    const t = await setup();
    const taskId = await t.waitingTask("dev-a");
    const before = await t.stored(taskId);
    const reply = await approve(t.deps, taskId, cardCaller("dev-a"));
    expect(reply?.statusCode).toBe(200);
    expect(reply?.body).toMatchObject({ cardId: cardOf(taskId), outcome: "approved" });
    expect((await t.stored(taskId)).stage).toBe("IMPLEMENT");
    expect(t.point.acts).toEqual([expect.objectContaining({
      companyId: ORG, personId: "dev-a", stepUp: STEP_UP, outcome: "approve", taskId, kind: "plan", card: { cardId: cardOf(taskId), contentVersion: before.artifacts.at(-1)!.sha256 },
      revision: before.revision, artifactDigest: before.artifacts.at(-1)!.sha256,
    })]);
    // The decision is recorded under the task's owner.
    const decided = (await t.stored(taskId)).decisions.at(-1)!;
    expect(decided).toMatchObject({ decision: "APPROVE", actorId: before.ownerId });
  });

  it("refuses an act without the route's step-up, before any proof is issued", async () => {
    const t = await setup();
    const taskId = await t.waitingTask("dev-a");
    await expect(approve(t.deps, taskId, cardCaller("dev-a", ORG, { stepUp: false }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(t.point.proofs.issue).not.toHaveBeenCalled();
    expect((await t.stored(taskId)).stage).toBe("PLAN_REVIEW");
  });

  it("re-checks live authority at the act: a membership or grant lost after the card was drawn refuses, and nothing is decided", async () => {
    for (const lose of ["membership", "grant", "moved"] as const) {
      const t = await setup();
      const taskId = await t.waitingTask("dev-a");
      const who = cardCaller("dev-a");
      // The card as the person was shown it, drawn while they still had access.
      const item = await itemFor(t, taskId);
      if (lose === "membership") t.memberships.delete("dev-a");
      if (lose === "grant") t.grants.delete("dev-a|payments");
      if (lose === "moved") t.memberships.set("dev-a", { companyId: OTHER, role: "owner" });
      const outcome = await t.deps.performer.approve(who, { card: item.card, item: item.item, requestId: randomUUID() });
      expect(outcome, lose).toEqual({ kind: "refused", reason: "forbidden" });
      expect(t.point.proofs.issue, lose).not.toHaveBeenCalled();
      expect((await t.stored(taskId)).stage, lose).toBe("PLAN_REVIEW");
    }
  });

  it("refuses another person's task, even a company admin's reach, and another company's caller", async () => {
    const t = await setup();
    const taskId = await t.waitingTask("dev-a");
    const item = await itemFor(t, taskId);
    // The last: this company's caller (orgId) carrying a principal that names another company.
    for (const who of [cardCaller("dev-b"), cardCaller("dev-x", OTHER), { ...cardCaller("dev-a"), developerId: developerIdOf(principalOf("dev-b")) }, { ...cardCaller("dev-a"), principal: { ...principalOf("dev-a", OTHER), authTime: STEP_UP.at } }]) {
      expect(await t.deps.performer.approve(who, { card: item.card, item: item.item, requestId: randomUUID() })).toEqual({ kind: "refused", reason: "forbidden" });
    }
    expect(t.point.proofs.issue).not.toHaveBeenCalled();
    expect((await t.stored(taskId)).stage).toBe("PLAN_REVIEW");
  });

  it("refuses, before any proof, a card of the person's task in another company acted on through this company", async () => {
    const t = await setup();
    t.memberships.set("dev-a", { companyId: OTHER, role: "member" });
    const elsewhere = await t.waitingTask("dev-a", OTHER);
    const items = await t.otherDeps.sources.list(cardCaller("dev-a", OTHER, { stepUp: false }));
    const card = projectDecisionCards(items).cards.find((entry) => entry.id === cardOf(elsewhere))!;
    t.memberships.set("dev-a", { companyId: ORG, role: "member" });
    expect(await t.deps.performer.approve(cardCaller("dev-a"), { card, item: items[0]!, requestId: randomUUID() })).toEqual({ kind: "refused", reason: "forbidden" });
    expect(t.point.proofs.issue).not.toHaveBeenCalled();
  });

  it("records nothing when the point vouches for someone other than the task's owner (the gate's subject accepts only the owner)", async () => {
    const t = await setup({ permissive: true });
    const taskId = await t.waitingTask("dev-a");
    const original = t.point.proofs.issue;
    t.point.proofs.issue = vi.fn(async (act: DecisionAct) => original.call(t.point.proofs, { ...act, personId: "dev-b" }));
    await expect(approve(t.deps, taskId, cardCaller("dev-a"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await t.stored(taskId)).stage).toBe("PLAN_REVIEW");
    expect((await t.stored(taskId)).decisions).toEqual([]);
  });

  it("refuses when the point gives no usable proof (a throw, another method, an empty token), with nothing decided and no echo", async () => {
    for (const issue of [() => { throw new Error("secret-ish detail zzq"); }, () => ({ method: "local-session", token: "t" }), () => ({ method: METHOD, token: "" }), () => null as never]) {
      const t = await setup();
      const taskId = await t.waitingTask("dev-a");
      t.point.proofs.issue = vi.fn(issue);
      let thrown: unknown;
      try { await approve(t.deps, taskId, cardCaller("dev-a")); } catch (error) { thrown = error; }
      expect(thrown).toMatchObject({ code: "FORBIDDEN" });
      expect(String((thrown as Error).message)).not.toContain("zzq");
      expect((await t.stored(taskId)).stage).toBe("PLAN_REVIEW");
    }
  });

  it("requests changes on the card, and rejects through the performer, through the same gate, each with its own outcome in the proof", async () => {
    const t = await setup();
    const changed = await t.waitingTask("dev-a");
    const rejected = await t.waitingTask("dev-a");
    const who = cardCaller("dev-a");
    const shownDigest = (await view(t.deps, "dev-a")).digests[cardOf(changed)]!;
    const changes = await call(t.deps, who, "POST", `${decisionCardPath(cardOf(changed))}/request-changes`, { requestId: randomUUID(), shownDigest, reason: "Use the shared client." });
    expect(changes?.statusCode).toBe(200);
    expect((await t.stored(changed)).stage).not.toBe("PLAN_REVIEW");
    // A coding plan's card offers no Reject; the performer's reject still goes through the gate with its own outcome (a design or requirements card's).
    const item = await itemFor(t, rejected);
    expect(await t.deps.performer.reject(who, { card: item.card, item: item.item, requestId: randomUUID(), reason: "wrong_approach" })).toHaveProperty("kind");
    expect(t.point.acts.map((act) => [act.taskId, act.outcome])).toEqual([[changed, "request_changes"], [rejected, "reject"]]);
  });
});

/** The card and item the person was shown for one task (as the route projects them). */
async function itemFor(t: Awaited<ReturnType<typeof setup>>, taskId: string) {
  const items = await t.deps.sources.list(cardCaller("dev-a", ORG, { stepUp: false }));
  const card = projectDecisionCards(items).cards.find((entry) => entry.id === cardOf(taskId));
  const item = items.find((entry) => entry.taskId === taskId);
  if (card === undefined || item === undefined) throw new Error("no card");
  return { card, item };
}

describe("lane L11's wiring parts", () => {
  it("gives the session levels always, the cards only with the point's proof issuer, and how we work only with a code host and the company's settings", async () => {
    const t = await setup();
    const bare = deployedDevWiringParts({ runtime: t.runtime, registry: t.registry, people: t.people });
    expect(bare.members).toBeDefined();
    expect(bare.decisions).toBeUndefined();
    expect(bare.playbook).toBeUndefined();
    const full = deployedDevWiringParts({ runtime: t.runtime, registry: t.registry, people: t.people, decisionProofs: t.point.proofs, codeSettings: fixedCodeSettings() });
    expect(full.decisions).toBeDefined();
    expect(full.playbook).toBeDefined();
    // A registry with no code host registered (the deployed broker's until lane L1b): no how we work, never "no file".
    const noHost = { ...t.registry, names: (point: string) => (point === "code-host" ? [] : t.registry.names(point as never)) } as unknown as AdapterRegistry;
    expect(deployedDevWiringParts({ runtime: t.runtime, registry: noHost, people: t.people, codeSettings: fixedCodeSettings() }).playbook).toBeUndefined();
  });

  it("on the deployed routes: without the issuer the cards answer \"not on the core yet\"; with it the caller's own cards are listed", async () => {
    const t = await setup();
    const taskId = await t.waitingTask("dev-a");
    const companyOf = async (caller: { principal: Principal }) => t.memberships.get(caller.principal.personId);
    const caller = { principal: principalOf("dev-a"), client: "app" };
    const without = createCoreDevRoutes({ app: t.app, companyOf, wiring: async (runtime) => ({ origin: () => "https://api.example", ...deployedDevWiringParts({ runtime, registry: t.registry, people: t.people }) }) });
    const unwired = await without.route({ method: "GET", path: "/v1/app/decisions", headers: {} }, caller);
    expect(unwired?.statusCode).toBe(404);
    expect(JSON.parse(unwired!.body)).toMatchObject({ error: { message: NOT_ON_THE_CORE_YET } });
    const wired = createCoreDevRoutes({ app: t.app, companyOf, wiring: async (runtime) => ({ origin: () => "https://api.example", ...deployedDevWiringParts({ runtime, registry: t.registry, people: t.people, decisionProofs: t.point.proofs }) }) });
    const listed = await wired.route({ method: "GET", path: "/v1/app/decisions", headers: {} }, caller);
    expect(listed?.statusCode).toBe(200);
    expect(DecisionCardsViewSchema.parse(JSON.parse(listed!.body)).cards.map((card) => card.id)).toEqual([cardOf(taskId)]);
  });
});
