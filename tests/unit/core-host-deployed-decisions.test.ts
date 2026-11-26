// Switch-on lane L11: the decision cards, the session levels and how we work on the deployed core, from the company's own records. The session levels read live membership and the broker's
// project grant and fail closed; a card lists only the task's own person's waiting documents, in their own company, while they are a member with the grant; an act re-checks that live authority,
// carries the approvers point's own proof (lane L2a's issuer) through the real approval gate, and records the approver only as the task's owner.
import { createHash, randomUUID } from "node:crypto";
import type { GetCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  agentXError, change, orgScoped, spendUnreadableWords, INDEX_EXPIRY_ATTRIBUTE, DecisionCardsViewSchema, createWorkflowSnapshot, orgProjectCatalogKey, projectRevisionKey, submitWorkflowArtifact,
  type AdapterRegistry, type ApprovalProof, type ApprovalRequest, type Approvers, type JsonValue, type OrgId, type OrgRole, type Principal, type ProjectDefinition, type WorkflowSnapshot,
} from "@agentx/contracts";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { coreAdapter } from "../../packages/broker/src/core-host/registry.js";
import { NOT_ON_THE_CORE_YET, createCoreDevRoutes, type DeployedDecisionCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import {
  DECISION_SOURCE_TASKS_MAX, INVOLVED_TASKS_MAX, deployedDecisionCards, deployedDevWiringParts, deployedSessionMembers, approvalDecisionProofs,
  type DecisionAct, type DecisionProofIssuer, type DeployedPeople,
} from "../../packages/broker/src/core-host/deployed-decisions.js";
import type { CoreRuntime } from "../../packages/broker/src/core-host/core-runtime.js";
import { HOSTED_IDENTITY_PROVIDER, createHostedIdentity } from "../../packages/broker/src/core-host/hosted-modules.js";
import { createHostedApprovers, approvalProofKeyOf } from "../../packages/broker/src/core-host/hosted-approvers.js";
import { hostedTaskAccess } from "../../packages/broker/src/aws/core-engine-root.js";
import { routeDecisionCards } from "../../packages/broker/src/core/decisions/routes.js";
import { decisionCardPath, projectDecisionCards } from "../../packages/broker/src/core/decisions/project.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { fixedCodeSettings } from "../../packages/broker/src/core/merge/defaults.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { hostAskDigest, hostAskSubjectId, requestHostAsk, type SetupHostAsk } from "../../packages/broker/src/core/setup-agent/host-ask.js";
import { hostAskKey } from "../../packages/broker/src/core/setup-agent/keys.js";
import { deleteInvolvedRow, writeInvolvedRow } from "../../packages/broker/src/core/task-flow/involved.js";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import type { TaskPeopleDependencies } from "../../packages/broker/src/developer/task-people.js";
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
      return act === undefined ? { approved: false, reason: "invalid_proof" } : { approved: true, approver: principalOf(act.personId, act.companyId), method: proof.method, proofId: proof.proofId };
    },
  };
  return { proofs, approvers, acts };
}

async function registerProject(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

/** The world, with lane L2a's real approvers point (the deployed identity over the company's memberships, the proof key) unless `permissive`. */
async function setup(options: { permissive?: boolean; people?: boolean; involved?: (caller: DeployedDecisionCaller) => Promise<readonly string[]> } = {}) {
  const world = createFakeWorld({ without: ["approvers", "identity"] });
  const { memberships, grants, people } = records();
  const identity = createHostedIdentity({ membershipOf: people.membershipOf, displayNameOf: async (personId) => personId });
  const key = approvalProofKeyOf("k".repeat(32));
  const acts: DecisionAct[] = [];
  const hosted = approvalDecisionProofs(key, () => world.clock.now);
  const fake = permissivePoint();
  const proofs: DecisionProofIssuer = options.permissive === true ? fake.proofs : { method: hosted.method, issue: vi.fn((act: DecisionAct) => { acts.push(act); return hosted.issue(act); }) };
  const point = { proofs, acts: options.permissive === true ? fake.acts : acts };
  // With `people`, the task access is the deployed one over the task's PEOPLE list (web task channel C6): the live proof of each person is the test's `proof` table (default: eligible and present).
  const proof = new Map<string, { eligible: boolean; channelMember: boolean }>();
  const check = vi.fn(async (_task: unknown, developerId: string) => {
    const state = proof.get(developerId);
    if (state === undefined) throw new Error("no such person on the task");
    return { subject: { developerId, slackUserId: `U0${developerId.slice(0, 8).toUpperCase()}` }, identity: { developerId, slackUserId: `U0${developerId.slice(0, 8).toUpperCase()}`, name: `Person ${developerId.slice(0, 4)}`, method: "slack", issuer: "https://slack.com", subject: developerId }, ...state };
  });
  const peopleDeps: TaskPeopleDependencies = {
    documentClient: { send: async (command) => ({ Item: await world.store.get((command as GetCommand).input.Key as { pk: string; sk: string }) }) }, tableName: "state", now: () => world.clock.now, checkTaskPerson: check as never,
  };
  const accessFor = (companyId: OrgId) => hostedTaskAccess({
    companyId, membershipOf: people.membershipOf, projectGrant: async (p, project) => (await people.projectGrantRole(p, project)) !== undefined,
    ...(options.people === true ? { storage: async () => world.store, people: peopleDeps } : {}),
  });
  world.modules.push(coreAdapter({ point: "identity", name: HOSTED_IDENTITY_PROVIDER, owner: "fake", create: () => identity }));
  world.modules.push(coreAdapter({
    point: "approvers", name: "deployed", owner: "fake",
    create: () => (options.permissive === true ? fake.approvers : createHostedApprovers({
      store: world.store, identity, key, now: () => new Date(world.clock.now),
      ...(options.people === true ? { taskOwner: ({ companyId, principal, task }) => accessFor(companyId).canAct(principal, task) } : {}),
    })),
  }));
  await registerProject(world, ORG);
  await registerProject(world, OTHER);
  const app: CoreHostApp = createCoreHostApp({
    modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: (_registry, companyId) => ({
      callbackSigningKey: Buffer.alloc(32, 7), access: accessFor(companyId),
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
  const deps = deployedDecisionCards({ runtime, registry, people, proofs: point.proofs, log, ...(options.involved === undefined ? {} : { involvedTaskIds: options.involved }) });
  const otherDeps = deployedDecisionCards({ runtime: otherRuntime, registry, people, proofs: point.proofs, log, ...(options.involved === undefined ? {} : { involvedTaskIds: options.involved }) });

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
  /** The task's PEOPLE list, as the broker keeps it (an explicit role per person; the proof table says who is eligible and present). */
  const seedPeople = async (taskId: string, entries: Array<[string, "owner" | "commenter" | "viewer" | "denied"]>, revision = 3, orphaned = false) => {
    for (const [developerId] of entries) if (!proof.has(developerId)) proof.set(developerId, { eligible: true, channelMember: true });
    await world.store.put({ item: { pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision, orphaned, people: entries.map(([developerId, role]) => ({ developerId, slackUserId: `U0${developerId.slice(0, 8).toUpperCase()}`, name: `Person ${developerId.slice(0, 4)}`, role })) } });
  };
  return { world, app, registry, runtime, otherRuntime, deps, otherDeps, point, memberships, grants, people, log, waitingTask, stored, proof, check, seedPeople, accessFor };
}

/** The caller the card routes pass: the signed-in person, with no sign-in time and no step-up (DEC 254zzz73). */
function cardCaller(personId: string, companyId: string = ORG): DeployedDecisionCaller {
  const principal = principalOf(personId, companyId);
  return { orgId: companyId, developerId: developerIdOf(principal), principal };
}

type Deps = ReturnType<typeof deployedDecisionCards>;
const call = (deps: Deps, who: DeployedDecisionCaller, method: string, pathname: string, body?: unknown) => routeDecisionCards(deps, who, { method, pathname, searchParams: new URLSearchParams(), body: body ?? {} });
const view = async (deps: Deps, personId: string, companyId: string = ORG) => DecisionCardsViewSchema.parse((await call(deps, cardCaller(personId, companyId), "GET", "/v1/app/decisions"))?.body);
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
    // A read that FAILED is not "no membership" / "no grant": it throws the retryable failure (membership-read.ts), so no session answers "no such session" for it.
    await expect(failing.companyRole(person("dev-o"))).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(failing.projectGrant(person("dev-o"), "payments")).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    const grantFails = deployedSessionMembers(ORG, people({ projectGrantRole: async () => { throw new Error("dynamo down"); } }));
    await expect(grantFails.projectGrant(person("dev-o"), "payments")).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    // A revoked or unknown role is no membership.
    const odd = deployedSessionMembers(ORG, people({ membershipOf: async () => ({ companyId: ORG, role: "superuser" as never }) }));
    expect(await odd.companyRole(person("dev-o"))).toBeUndefined();
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

  it("reads a document's facts only from the task's own storage: a pointer elsewhere reads as unread", async () => {
    const t = await setup();
    await t.waitingTask("dev-a");
    await t.waitingTask("dev-a", ORG, { foreignKey: true });
    const items = await t.deps.sources.list(cardCaller("dev-a", ORG));
    expect(items.map((item) => (item as { files?: readonly string[] }).files).sort()).toEqual([[], ["src/health.ts"]]);
  });

  it("leaves out a closed task, a task that waits on nothing, and a structured document that does not read back", async () => {
    const t = await setup();
    await t.waitingTask("dev-a", ORG, { closed: true });
    await t.waitingTask("dev-a", ORG, { notWaiting: true });
    await t.waitingTask("dev-a", ORG, { structured: "bad" });
    expect((await view(t.deps, "dev-a")).cards).toEqual([]);
  });

  it("reads at most DECISION_SOURCE_TASKS_MAX index rows per listing, and says so when it cut", async () => {
    const t = await setup();
    const query = vi.fn(async () => ({ items: Array.from({ length: 100 }, () => ({ taskId: randomUUID(), orgId: ORG })), cursor: "more" }));
    const get = vi.fn(async () => undefined);
    const runtime = { companyId: ORG, flow: { deps: { ...t.runtime.flow.deps, companyId: ORG, store: { ...t.runtime.flow.deps.store, query, get } } } } as unknown as CoreRuntime;
    const deps = deployedDecisionCards({ runtime, registry: t.registry, people: t.people, proofs: t.point.proofs, log: t.log });
    expect(await deps.sources.list(cardCaller("dev-a", ORG))).toEqual([]);
    expect(get).toHaveBeenCalledTimes(DECISION_SOURCE_TASKS_MAX);
    expect(t.log).toHaveBeenCalledWith(expect.objectContaining({ event: "core_engine.decision_cards_cut", read: DECISION_SOURCE_TASKS_MAX }));
  });
});

describe("the deployed decision cards: acting", () => {

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
    for (const who of [cardCaller("dev-b"), cardCaller("dev-x", OTHER), { ...cardCaller("dev-a"), developerId: developerIdOf(principalOf("dev-b")) }, { ...cardCaller("dev-a"), principal: principalOf("dev-a", OTHER) }]) {
      expect(await t.deps.performer.approve(who, { card: item.card, item: item.item, requestId: randomUUID() })).toEqual({ kind: "refused", reason: "forbidden" });
    }
    expect(t.point.proofs.issue).not.toHaveBeenCalled();
    expect((await t.stored(taskId)).stage).toBe("PLAN_REVIEW");
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
  const items = await t.deps.sources.list(cardCaller("dev-a", ORG));
  const card = projectDecisionCards(items).cards.find((entry) => entry.id === cardOf(taskId));
  const item = items.find((entry) => entry.taskId === taskId);
  if (card === undefined || item === undefined) throw new Error("no card");
  return { card, item };
}

// People entries name a person by the broker's 64-hex developer id, so these tests' people are hex ids.
const hex = (name: string) => createHash("sha256").update(name).digest("hex");
const [PA, PB, PC, PD, PE, PF, PX] = ["dev-a", "dev-b", "dev-c", "dev-d", "dev-e", "dev-f", "dev-x"].map(hex) as [string, string, string, string, string, string, string];
async function hexSetup(options: Parameters<typeof setup>[0] = {}) {
  const t = await setup(options);
  for (const personId of [PA, PB, PC, PD, PE, PF]) { t.memberships.set(personId, { companyId: ORG, role: "member" }); t.grants.set(`${personId}|payments`, "developer"); }
  t.memberships.set(PX, { companyId: OTHER, role: "owner" }); t.grants.set(`${PX}|payments`, "developer");
  return t;
}
// Web task channel C6 (plan 4.1, decision D5): the task's People co-owners decide a core task's documents under the same live rule as the owner moves (live membership, the live proof of the person, the project
// grant, the People revision fenced into the decision); commenters and viewers never decide; no step-up is asked (DEC 254zzz73).
describe("the deployed decision cards: People co-owners (web task channel C6)", () => {
  
  /** A world with the deployed task access over PEOPLE; dev-a owns the task, dev-b co-owns it, dev-c comments, dev-d views, dev-e is not on it. `involved` is the task ids the involved rows would give. */
  async function peopleWorld(entries: Array<[string, "owner" | "commenter" | "viewer" | "denied"]> = [[PA, "owner"], [PB, "owner"], [PC, "commenter"], [PD, "viewer"]]) {
    const involved: string[] = [];
    const t = await hexSetup({ people: true, involved: async () => involved });
    const taskId = await t.waitingTask(PA);
    await t.seedPeople(taskId, entries);
    involved.push(taskId);
    return { ...t, taskId, involved };
  }
  type World = Awaited<ReturnType<typeof peopleWorld>>;
  const listFor = (t: World, personId: string, companyId: string = ORG) => (companyId === ORG ? t.deps : t.otherDeps).sources.list(cardCaller(personId, companyId));
  /** The card and item as the task's own person was shown them (drawn while everything still held). */
  async function shown(t: World) {
    const items = await listFor(t, PA);
    const card = projectDecisionCards(items).cards.find((entry) => entry.id === cardOf(t.taskId));
    const item = items.find((entry) => entry.taskId === t.taskId);
    if (card === undefined || item === undefined) throw new Error("no card");
    return { card, item };
  }
  const decided = async (t: World) => (await t.stored(t.taskId)).stage !== "PLAN_REVIEW";

  it("lists the card for a co-owner and approves it; the decision is recorded as the co-owner, with the point's proof for the co-owner", async () => {
    const t = await peopleWorld();
    const before = await t.stored(t.taskId);
    await t.world.store.put({ item: { ...await t.world.store.get(taskKey(t.taskId)), runEstimate: { lowUsd: 4.37, highUsd: 12.71 } } as never });
    expect(JSON.stringify(await view(t.deps, PB))).not.toMatch(/12\.71|4\.37|\$/u);
    expect(JSON.stringify(await view(t.deps, PA))).toContain("$12.71");
    expect((await view(t.deps, PB)).cards.map((card) => card.id)).toEqual([cardOf(t.taskId)]);
    const reply = await approve(t.deps, t.taskId, cardCaller(PB));
    expect(reply?.statusCode).toBe(200);
    expect(reply?.body).toMatchObject({ cardId: cardOf(t.taskId), outcome: "approved" });
    const after = await t.stored(t.taskId);
    expect(after.stage).toBe("IMPLEMENT");
    expect(after.decisions.at(-1)).toMatchObject({ decision: "APPROVE", actorId: taskOwnerKey(PB, t.taskId), actorRole: "TASK_OWNER" });
    expect(after.decisions.at(-1)!.actorId).not.toBe(before.ownerId);
    expect(t.point.acts).toEqual([expect.objectContaining({ companyId: ORG, personId: PB, taskId: t.taskId, outcome: "approve" })]);
  });

  it("the task's own person still decides while they are an owner on the list; requests changes and rejects as a co-owner too, each through the same gate", async () => {
    const t = await peopleWorld();
    expect((await approve(t.deps, t.taskId, cardCaller(PA)))?.statusCode).toBe(200);
    expect((await t.stored(t.taskId)).decisions.at(-1)).toMatchObject({ actorId: before0(t) });
    const u = await peopleWorld();
    const shownDigest = (await view(u.deps, PB)).digests[cardOf(u.taskId)]!;
    const changes = await call(u.deps, cardCaller(PB), "POST", `${decisionCardPath(cardOf(u.taskId))}/request-changes`, { requestId: randomUUID(), shownDigest, reason: "Use the shared client." });
    expect(changes?.statusCode).toBe(200);
    expect((await u.stored(u.taskId)).decisions.at(-1)).toMatchObject({ decision: "REQUEST_CHANGES", actorId: taskOwnerKey(PB, u.taskId) });
    const r = await peopleWorld();
    const item = await shown(r);
    expect(await r.deps.performer.reject(cardCaller(PB), { card: item.card, item: item.item, requestId: randomUUID(), reason: "wrong_approach" })).toHaveProperty("kind");
    expect(r.point.acts.map((act) => [act.personId, act.outcome])).toEqual([[PB, "reject"]]);
  });
  const before0 = (t: World) => taskOwnerKey(PA, t.taskId);

  it("refuses a co-owner at once when membership, the grant or the live proof is lost, or their role is cut, and decides nothing", async () => {
    const losses: Array<[string, (t: World) => Promise<void> | void]> = [
      ["membership gone", (t) => { t.memberships.delete(PB); }],
      ["moved to another company", (t) => { t.memberships.set(PB, { companyId: OTHER, role: "owner" }); }],
      ["grant gone", (t) => { t.grants.delete(`${PB}|payments`); }],
      ["proof: no longer eligible", (t) => { t.proof.set(PB, { eligible: false, channelMember: true }); }],
      ["proof: no longer present", (t) => { t.proof.set(PB, { eligible: true, channelMember: false }); }],
      ["proof: unreadable", (t) => { t.proof.delete(PB); }],
      ["role cut to commenter", (t) => t.seedPeople(t.taskId, [[PA, "owner"], [PB, "commenter"]], 4)],
      ["removed (denied)", (t) => t.seedPeople(t.taskId, [[PA, "owner"], [PB, "denied"]], 4)],
      ["no longer on the list", (t) => t.seedPeople(t.taskId, [[PA, "owner"]], 4)],
      ["the list is gone", (t) => { void t.world.store.delete({ key: { pk: `DEVTASK#${t.taskId}`, sk: "PEOPLE" } }); }],
    ];
    for (const [name, lose] of losses) {
      const t = await peopleWorld();
      const item = await shown(t);
      await lose(t);
      expect(await t.deps.performer.approve(cardCaller(PB), { card: item.card, item: item.item, requestId: randomUUID() }), name).toEqual({ kind: "refused", reason: "forbidden" });
      expect(await listFor(t, PB), name).toEqual([]);
      expect(t.point.proofs.issue, name).not.toHaveBeenCalled();
      expect(await decided(t), name).toBe(false);
    }
  });

  it("a co-owner decides with no step-up, while a commenter, a viewer and a person not on the task decide nothing", async () => {
    const t = await peopleWorld();
    for (const who of [PC, PD, PE]) await expect(approve(t.deps, t.taskId, cardCaller(who), who)).rejects.toBeDefined();
    expect(t.point.proofs.issue).not.toHaveBeenCalled();
    expect(await decided(t)).toBe(false);
    expect((await approve(t.deps, t.taskId, cardCaller(PB), PB))?.statusCode).toBe(200);
  });

  it("does not believe a rule that names another actor than the person asking (the engine records one actor under the person's own owner id)", async () => {
    for (const rogue of ["other-person", "legacy"] as const) {
      const t = await peopleWorld();
      const item = await shown(t);
      const access = t.runtime.flow.deps.access;
      const real = access.ownerActing!.bind(access);
      access.ownerActing = async (principal, task) => {
        const acting = await real(principal, task);
        return acting === undefined ? acting : rogue === "other-person" ? { ...acting, actorId: taskOwnerKey(PC, t.taskId) } : { actorId: task.ownerKey };
      };
      expect(await t.deps.performer.approve(cardCaller(PB), { card: item.card, item: item.item, requestId: randomUUID() }), rogue).toEqual({ kind: "refused", reason: "forbidden" });
      expect(t.point.proofs.issue, rogue).not.toHaveBeenCalled();
      expect(await decided(t), rogue).toBe(false);
    }
  });

  it("the workflow subject refuses a decision whose live owner rule throws, whatever the host", async () => {
    const t = await peopleWorld();
    const { createWorkflowDocumentSubject } = await import("../../packages/broker/src/core/decisions/workflow-subject.js");
    const workflow = await t.stored(t.taskId);
    const decide = async (ownerActing: NonNullable<Parameters<typeof createWorkflowDocumentSubject>[0]["ownerActing"]>) => {
      const subject = createWorkflowDocumentSubject({ store: t.world.store, ownerActing });
      const loaded = (await subject.load(ORG, t.taskId))!;
      return await subject.apply(loaded, { requestId: randomUUID(), outcome: "approve", seen: { revision: workflow.revision, artifactDigest: workflow.artifacts.at(-1)!.sha256 } } as never, [principalOf(PB)], new Date(t.world.clock.now).toISOString());
    };
    await expect(decide(async () => { throw new Error("people down zzq"); })).rejects.toMatchObject({ code: "not_the_approver" });
    await expect(decide(async () => undefined)).rejects.toMatchObject({ code: "not_the_approver" });
    // The same rule answering yes decides, as the co-owner, under the authority it names.
    const decided = await decide(async () => ({ actorId: taskOwnerKey(PB, t.taskId), authority: { actorId: taskOwnerKey(PB, t.taskId), ownerIds: [taskOwnerKey(PA, t.taskId), taskOwnerKey(PB, t.taskId)] }, items: [{ kind: "check", key: { pk: `DEVTASK#${t.taskId}`, sk: "PEOPLE" }, condition: { op: "eq", path: ["revision"], value: 3 } }] }));
    expect(decided.extra).toEqual([expect.objectContaining({ kind: "check" })]);
    // Two approvers carrying the same fence leave one fence item, not two (a transaction cannot name one key twice).
    const same: Awaited<ReturnType<NonNullable<Parameters<typeof createWorkflowDocumentSubject>[0]["ownerActing"]>>> = { actorId: taskOwnerKey(PB, t.taskId), authority: { actorId: taskOwnerKey(PB, t.taskId), ownerIds: [taskOwnerKey(PB, t.taskId)] }, items: [{ kind: "check", key: { pk: `DEVTASK#${t.taskId}`, sk: "PEOPLE" }, condition: { op: "eq", path: ["revision"], value: 3 } }] };
    const subject = createWorkflowDocumentSubject({ store: t.world.store, ownerActing: async () => same });
    const loaded = (await subject.load(ORG, t.taskId))!;
    const twice = await subject.apply(loaded, { requestId: randomUUID(), outcome: "approve", seen: { revision: workflow.revision, artifactDigest: workflow.artifacts.at(-1)!.sha256 } } as never, [principalOf(PB), principalOf(PB)], new Date(t.world.clock.now).toISOString());
    expect(twice.extra).toHaveLength(1);
  });

  it("without the host's owner rule only the task's own person decides (Code's rule), and nobody else is let in by the fallback", async () => {
    const t = await hexSetup();
    const taskId = await t.waitingTask(PA);
    const access = t.runtime.flow.deps.access;
    delete access.ownerActing;
    const bare = deployedDecisionCards({ runtime: t.runtime, registry: t.registry, people: t.people, proofs: t.point.proofs, log: t.log });
    const items = await bare.sources.list(cardCaller(PA, ORG));
    expect(items.map((entry) => entry.taskId)).toEqual([taskId]);
    const item = { item: items[0]!, card: projectDecisionCards(items).cards[0]! };
    expect(await bare.performer.approve(cardCaller(PB), { ...item, requestId: randomUUID() })).toEqual({ kind: "refused", reason: "forbidden" });
    expect(t.point.proofs.issue).not.toHaveBeenCalled();
  });

  it("reads the involved ids defensively: a throw, a malformed or foreign id, a repeat and an over-long list never widen or break the listing", async () => {
    const own = randomUUID();
    const t = await hexSetup({ people: true, involved: async () => { throw new Error("involved down zzq"); } });
    const mine = await t.waitingTask(PA);
    expect((await t.deps.sources.list(cardCaller(PA, ORG))).map((entry) => entry.taskId)).toEqual([mine]);
    const foreignTask = await t.waitingTask(PX, OTHER);
    const ids = ["not-a-task-id", "", 7 as never, foreignTask, own, mine, mine, ...Array.from({ length: 300 }, () => randomUUID())];
    const wide = deployedDecisionCards({ runtime: t.runtime, registry: t.registry, people: t.people, proofs: t.point.proofs, log: t.log, involvedTaskIds: async () => ids });
    expect((await wide.sources.list(cardCaller(PA, ORG))).map((entry) => entry.taskId)).toEqual([mine]);
    const store = t.runtime.flow.deps.store;
    const reads = vi.fn(store.get.bind(store));
    const counting = new Proxy(store, { get: (target, property): unknown => { const value: unknown = Reflect.get(target, property); return property === "get" ? reads : typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value; } });
    const counted = { companyId: ORG, flow: { deps: { ...t.runtime.flow.deps, store: counting } } } as unknown as CoreRuntime;
    const bounded = deployedDecisionCards({ runtime: counted, registry: t.registry, people: t.people, proofs: t.point.proofs, log: t.log, involvedTaskIds: async () => ids });
    await bounded.sources.list(cardCaller(PA, ORG));
    expect(reads.mock.calls.length).toBeLessThanOrEqual(1 + INVOLVED_TASKS_MAX + 5);
  });
});

describe("a core task's read by the People list's commenters and viewers (web task channel C6)", () => {
  const TASK_GET = (taskId: string) => ({ method: "GET", path: `/v1/dev/tasks/${taskId}`, headers: {} });
  async function readWorld() {
    const t = await hexSetup({ people: true });
    const taskId = await t.waitingTask(PA);
    await t.seedPeople(taskId, [[PA, "owner"], [PB, "owner"], [PC, "commenter"], [PD, "viewer"]]);
    const companyOf = async (caller: { principal: Principal }) => t.memberships.get(caller.principal.personId);
    const routes = createCoreDevRoutes({ app: t.app, companyOf, wiring: async (runtime) => ({ origin: () => "https://api.example", ...deployedDevWiringParts({ runtime, registry: t.registry, people: t.people, decisionProofs: t.point.proofs }) }) });
    const get = async (personId: string, extra: { scriptToken?: { tokenId: string } } = {}) => routes.route(TASK_GET(taskId), { principal: principalOf(personId), client: "app", ...extra });
    return { ...t, taskId, get, routes };
  }

  it("returns HTTP 404 to a same-company non-reader on a hosted task with People", async () => {
    const t = await readWorld();
    const task = await t.world.store.get(taskKey(t.taskId));
    await t.world.store.put({ item: { ...task!, provider: "rovara-sign-in" } });
    const original = t.check.getMockImplementation()!;
    t.check.mockImplementation(async (task, developerId) => {
      if (developerId === PE) throw agentXError("PROJECT_ACCESS_DENIED", "task access could not be verified");
      return original(task, developerId);
    });
    expect((await t.get(PA))?.statusCode).toBe(200);
    expect((await t.get(PE))?.statusCode).toBe(404);
  });

  it("refuses the reader when membership, the grant or the live proof is lost, or the list has no one left to own the task, at once", async () => {
    const losses: Array<[string, (t: Awaited<ReturnType<typeof readWorld>>) => Promise<void> | void]> = [
      ["membership", (t) => { t.memberships.delete(PC); }],
      ["other company", (t) => { t.memberships.set(PC, { companyId: OTHER, role: "member" }); }],
      ["grant", (t) => { t.grants.delete(`${PC}|payments`); }],
      ["proof ineligible", (t) => { t.proof.set(PC, { eligible: false, channelMember: true }); }],
      ["proof unreadable", (t) => { t.proof.delete(PC); }],
      ["orphaned", (t) => t.seedPeople(t.taskId, [[PA, "denied"], [PC, "commenter"]], 4, true)],
      ["denied", (t) => t.seedPeople(t.taskId, [[PA, "owner"], [PC, "denied"]], 4)],
    ];
    for (const [name, lose] of losses) {
      const t = await readWorld();
      expect((await t.get(PC))?.statusCode, name).toBe(200);
      await lose(t);
      expect((await t.get(PC))?.statusCode, name).not.toBe(200);
    }
  });

  it("answers the approvers point's owner check with the same rule as the owner moves (hostedTaskOwner)", async () => {
    const t = await readWorld();
    const { hostedTaskOwner } = await import("../../packages/broker/src/aws/core-engine-root.js");
    const people = { documentClient: { send: async (command: unknown) => ({ Item: await t.world.store.get((command as GetCommand).input.Key as { pk: string; sk: string }) }) }, tableName: "state", now: () => t.world.clock.now, checkTaskPerson: t.check as never };
    const rule = hostedTaskOwner({ membershipOf: t.people.membershipOf, projectGrant: async (p, project) => (await t.people.projectGrantRole(p, project)) !== undefined, people });
    const task = { taskId: t.taskId, developerId: PA, project: "payments" };
    const asked = (personId: string, companyId: OrgId = ORG) => rule({ companyId, store: t.world.store, principal: principalOf(personId, companyId), task });
    expect(await asked(PA)).toBe(true);
    expect(await asked(PB)).toBe(true);
    expect(await asked(PC)).toBe(false);
    expect(await asked(PD)).toBe(false);
    expect(await asked(PB, OTHER)).toBe(false);
    expect(await asked(PE)).toBe(false);
  });
});

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

// Web task channel, involved wiring: the host feeds C5's involved rows to the cards listing, so a co-owner who did not start the task sees its card. The ids are only a source: the live owner rule judges each.
describe("the deployed decision cards fed by the involved rows (the host's own wiring)", () => {
  async function involvedWorld() {
    const t = await hexSetup({ people: true });
    const taskId = await t.waitingTask(PA);
    await t.seedPeople(taskId, [[PA, "owner"], [PB, "owner"], [PC, "commenter"], [PD, "viewer"]]);
    const createdAt = (await t.world.store.get(taskKey(taskId)))!["createdAt"] as string;
    const wired = (runtime: CoreRuntime) => deployedDevWiringParts({ runtime, registry: t.registry, people: t.people, decisionProofs: t.point.proofs }).decisions!;
    const list = async (personId: string, companyId: string = ORG) => (await wired(companyId === ORG ? t.runtime : t.otherRuntime).sources.list(cardCaller(personId, companyId))).map((item) => item.taskId);
    const row = (personId: string, companyId: string = ORG) => ({ companyId, personId, taskId, createdAt });
    return { ...t, taskId, list, row, createdAt };
  }

  it("lists a co-owner's card once their involved row exists, and not before", async () => {
    const t = await involvedWorld();
    expect(await t.list(PB)).toEqual([]);
    await writeInvolvedRow({ store: t.world.store }, t.row(PB));
    expect(await t.list(PB)).toEqual([t.taskId]);
    expect(await t.list(PA)).toEqual([t.taskId]);
  });

  it("stops listing it when the row is deleted (a removed or demoted co-owner)", async () => {
    const t = await involvedWorld();
    await writeInvolvedRow({ store: t.world.store }, t.row(PB));
    await deleteInvolvedRow({ store: t.world.store }, t.row(PB));
    expect(await t.list(PB)).toEqual([]);
  });
});

it.each(["tracker", "chosen", "none"] as const)("real approve_plan confirms only a suggestion (%s)", async (kind) => {
  const t = await setup();
  const taskId = await t.waitingTask("dev-a");
  const { createFeatureStore } = await import("../../packages/broker/src/core/report/feature-store.js");
  const features = createFeatureStore({ store: t.world.store, companyId: ORG, audit: t.runtime.flow.deps.audit, now: () => t.world.clock.now });
  const feature = await features.create({ name: "Payments" }, { type: "system", id: "test" });
  await features.setTaskFeature({ taskId, project: "payments", featureId: kind === "none" ? null : feature.id, source: kind === "tracker" ? "tracker" : "chosen" }, { type: "person", id: "dev-a" });
  const result = await approve(t.deps, taskId, cardCaller("dev-a"));
  expect(result?.statusCode).toBe(200);
  expect((await t.stored(taskId)).decisions.at(-1)?.decision).toBe("APPROVE");
  expect(await features.taskFeature(taskId)).toMatchObject({ featureId: kind === "none" ? null : feature.id, source: kind === "tracker" ? "confirmed_at_plan" : "chosen" });
});

it("a feature-store failure cannot turn a committed approval into an error", async () => {
  const t = await setup();
  const taskId = await t.waitingTask("dev-a");
  const get = t.world.store.get.bind(t.world.store);
  vi.spyOn(t.world.store, "get").mockImplementation(async (key) => { if (key.sk.startsWith("TASKFEAT#")) throw new Error("private canary"); return get(key); });
  expect((await approve(t.deps, taskId, cardCaller("dev-a")))?.statusCode).toBe(200);
  expect((await t.stored(taskId)).decisions.at(-1)?.decision).toBe("APPROVE");
});

// ---- lead 4 PCF: the feature line on a coding plan's card

describe("the plan card's feature line (lead 4 PCF)", () => {
  async function withFeatures() {
    const t = await setup();
    const { createFeatureStore } = await import("../../packages/broker/src/core/report/feature-store.js");
    const features = (companyId: OrgId = ORG) => createFeatureStore({ store: t.world.store, companyId, audit: (companyId === ORG ? t.runtime : t.otherRuntime).flow.deps.audit, now: () => t.world.clock.now });
    return { ...t, features };
  }
  const planFeature = async (t: Awaited<ReturnType<typeof withFeatures>>, personId: string, taskId: string, companyId: OrgId = ORG) => (await view(companyId === ORG ? t.deps : t.otherDeps, personId, companyId)).cards.find((card) => card.id === cardOf(taskId))?.planFeature;

  it("names the Linear parent the tracker suggested; an admin may also make a feature, a member may not", async () => {
    const t = await withFeatures();
    const parent = await t.features().create({ name: "Checkout v2", trackerLink: { tracker: "linear", id: "PRJ-1", url: "https://linear.app/x/project/1" } }, { type: "system", id: "test" });
    const member = await t.waitingTask("dev-a"), admin = await t.waitingTask("dev-b");
    for (const taskId of [member, admin]) await t.features().setTaskFeature({ taskId, project: "payments", featureId: parent.id, source: "tracker" }, { type: "system", id: "tracker" });
    expect(await planFeature(t, "dev-a", member)).toMatchObject({ line: "Feature: Checkout v2 (from the Linear parent)", feature: { id: parent.id, source: "tracker" }, canChange: true, canCreate: false });
    expect(await planFeature(t, "dev-b", admin)).toMatchObject({ canChange: true, canCreate: true });
  });

  it("an item whose feature line does not read is left off the card, and the card stays", () => {
    const base = { kind: "approve_plan" as const, subjectId: randomUUID(), project: "payments", title: "t", createdAt: "2026-11-15T10:00:00.000Z", openPath: "/app/tasks/x", contentVersion: "v1", path: "quick" as const, files: [], claims: 0, untestedClaims: 0 };
    const good = { line: "Feature: A (chosen)", feature: null, canChange: true, canCreate: false };
    expect(projectDecisionCards([{ ...base, planFeature: good }]).cards[0]!.planFeature).toEqual(good);
    const bad = projectDecisionCards([{ ...base, planFeature: { ...good, line: "x\u0000y" } }]);
    expect(bad.cards).toHaveLength(1);
    expect(bad.cards[0]!.planFeature).toBeUndefined();
    // only a plan card carries one
    const requirements = projectDecisionCards([{ kind: "approve_requirements", subjectId: randomUUID(), project: "payments", title: "t", createdAt: base.createdAt, openPath: "/app/tasks/x", contentVersion: "v1", claims: 0, planFeature: good } as never]);
    expect(requirements.cards[0]!.planFeature).toBeUndefined();
  });
});

describe("the retired workflow decision wire shape on deployed core", () => {
  it("decides through the real hosted proof and gate, replays, and rejects a stale digest", async () => {
    const { app, deps, waitingTask, stored, world } = await setup();
    const taskId = await waitingTask("dev-a");
    const workflow = await stored(taskId);
    const request = { requestId: randomUUID(), expectedRevision: workflow.revision, artifactDigest: workflow.artifacts.at(-1)!.sha256, decision: "APPROVE" as const, reason: "Ship it" };
    const routes = createCoreDevRoutes({ app, companyOf: async () => ({ companyId: ORG, role: "member" }), wiring: () => ({ origin: () => "https://api.example", workflowDecision: deps.decideWorkflow }) });
    const reply = await routes.route({ method: "POST", path: `/v1/dev/tasks/${taskId}/workflow/decision`, headers: {}, body: JSON.stringify(request) }, { principal: principalOf("dev-a"), client: "cli" });
    expect(reply?.statusCode).toBe(200);
    const audit = world.audit.find((event) => event.action === "decision.approved");
    expect(audit?.actor).toEqual({ type: "person", id: "dev-a" });
    expect(audit?.details?.["via"]).toBe("tool");
    expect(JSON.parse(reply!.body)).toMatchObject({ task: { taskId, workflow: { stage: "IMPLEMENT" } } });
    expect(await stored(taskId)).toMatchObject({ stage: "IMPLEMENT", decisions: [expect.objectContaining({ requestId: request.requestId, decision: "APPROVE" })] });
    const after = await stored(taskId);
    await deps.decideWorkflow(cardCaller("dev-a"), taskId, request);
    expect(await stored(taskId)).toEqual(after);
    await expect(deps.decideWorkflow(cardCaller("dev-a"), taskId, { ...request, requestId: randomUUID(), artifactDigest: "f".repeat(64) })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("keeps live owner, membership, grant and company checks before issuing a proof", async () => {
    const { deps, waitingTask, stored, point, grants, memberships } = await setup();
    const taskId = await waitingTask("dev-a");
    const workflow = await stored(taskId);
    const request = { requestId: randomUUID(), expectedRevision: workflow.revision, artifactDigest: workflow.artifacts.at(-1)!.sha256, decision: "REQUEST_CHANGES" as const, reason: "Add tests" };
    for (const caller of [cardCaller("dev-b"), cardCaller("dev-x", OTHER)]) await expect(deps.decideWorkflow(caller, taskId, request)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    grants.delete("dev-a|payments");
    await expect(deps.decideWorkflow(cardCaller("dev-a"), taskId, request)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    grants.set("dev-a|payments", "developer");
    memberships.delete("dev-a");
    await expect(deps.decideWorkflow(cardCaller("dev-a"), taskId, request)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(point.acts).toHaveLength(0);
    expect(await stored(taskId)).toEqual(workflow);
  });
});


describe("hosted tool approval owner ruling DEC 254zzz334", () => {
  it.each(["approve", "reject"] as const)("keeps the strong-method refusal for %s", async (outcome) => {
    const t = await setup({ permissive: true });
    const taskId = await t.waitingTask("dev-a");
    const before = await t.stored(taskId);
    await t.world.store.put({ item: { ...await t.world.store.get(taskKey(taskId)), runEstimate: { highUsd: 1_000 } } as never });
    vi.spyOn(t.registry.require("approvers"), "requirement").mockResolvedValue({ methods: [METHOD], minApprovers: 1, selfApprovalAllowed: true, strongMethods: ["code-host-comment"], rejectMethods: ["code-host-comment"] });
    await expect(t.deps.decideWorkflow(cardCaller("dev-a"), taskId, { requestId: randomUUID(), expectedRevision: before.revision, artifactDigest: before.artifacts.at(-1)!.sha256, decision: outcome === "approve" ? "APPROVE" : "REJECT", reason: "Owner answer" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await t.stored(taskId)).toEqual(before);
    expect(t.world.audit.filter((event) => event.action.startsWith("decision."))).toEqual([]);
  });

  it.each(["spent", "unknown-spend", "unknown-cap", "unreadable"] as const)("enforces the task run limit on tool and page approvals: %s", async (state) => {
    const t = await setup();
    const taskId = await t.waitingTask("dev-a");
    const before = await t.stored(taskId);
    t.runtime.flow.deps.taskCapUsd = async () => state === "unknown-cap" ? undefined : 10;
    t.runtime.flow.deps.taskSpendUsd = async () => { if (state === "unreadable") throw new Error("unreadable"); return state === "unknown-spend" ? undefined : 10; };
    await expect(t.deps.decideWorkflow(cardCaller("dev-a"), taskId, { requestId: randomUUID(), expectedRevision: before.revision, artifactDigest: before.artifacts.at(-1)!.sha256, decision: "APPROVE", reason: "Ship it", acknowledgedRunLimitUsd: 100_000 })).rejects.toThrow(state === "spent" ? "used its run limit" : spendUnreadableWords());
    const items = await t.deps.sources.list(cardCaller("dev-a"));
    const item = items.find((entry) => entry.taskId === taskId)!;
    const card = projectDecisionCards(items).cards.find((entry) => entry.id === cardOf(taskId))!;
    expect(await t.deps.performer.approve(cardCaller("dev-a"), { item, card, requestId: randomUUID() })).toMatchObject({ kind: "refused" });
    expect(await t.stored(taskId)).toEqual(before);
    expect(t.world.audit.filter((event) => event.action.startsWith("decision."))).toEqual([]);
  });

  it("approves below the task limit and replays after the limit is reached without another decision", async () => {
    const t = await setup();
    const taskId = await t.waitingTask("dev-a");
    const before = await t.stored(taskId);
    let spent = 9;
    t.runtime.flow.deps.taskCapUsd = async () => 10;
    t.runtime.flow.deps.taskSpendUsd = async () => spent;
    const request = { requestId: randomUUID(), expectedRevision: before.revision, artifactDigest: before.artifacts.at(-1)!.sha256, decision: "APPROVE" as const, reason: "Ship it" };
    await t.deps.decideWorkflow(cardCaller("dev-a"), taskId, request);
    const after = await t.stored(taskId);
    expect(after.stage).toBe("IMPLEMENT");
    spent = 10;
    await t.deps.decideWorkflow(cardCaller("dev-a"), taskId, request);
    expect(await t.stored(taskId)).toEqual(after);
    expect(t.world.audit.filter((event) => event.action === "decision.approved")).toHaveLength(1);
  });
});

it("lets a hosted tool token with decisions:decide approve as its person, and refuses a token missing that scope", async () => {
  const { MAYA, TOOL_CLIENT, clientBearer, createDeveloperTaskBroker } = await import("../support/developer-task-broker.js");
  const { coreTaskEntryFrom } = await import("../../packages/broker/src/aws/engine-boundary.js");
  const { coreTaskMarkKey } = await import("../../packages/broker/src/core-host/core-task-mark.js");
  const t = await setup();
  t.memberships.set(MAYA.developerId, { companyId: ORG, role: "member" });
  t.grants.set(`${MAYA.developerId}|payments`, "developer");
  const taskId = await t.waitingTask(MAYA.developerId);
  const before = await t.stored(taskId);
  const routes = createCoreDevRoutes({ app: t.app, companyOf: async (caller) => t.memberships.get(caller.principal.personId), wiring: () => ({ origin: () => "https://api.example", workflowDecision: t.deps.decideWorkflow }) });
  const coreTasks = coreTaskEntryFrom(routes, async (caller) => ({ principal: principalOf(caller.developerId), client: caller.clientId }));
  const broker = await createDeveloperTaskBroker({ register: false, developerExtra: { coreTasks } });
  for (const key of [taskKey(taskId), coreTaskMarkKey(taskId)]) broker.db.set({ ...await t.world.store.get(key), ...key });
  const request = { requestId: randomUUID(), expectedRevision: before.revision, artifactDigest: before.artifacts.at(-1)!.sha256, decision: "APPROVE", reason: "Ship it" };
  const path = `/v1/dev/tasks/${taskId}/workflow/decision`;
  const denied = await broker.client("tool", MAYA, "POST", path, request);
  expect(denied.status).toBe(403);
  expect(await t.stored(taskId)).toEqual(before);
  expect(t.point.acts).toHaveLength(0);
  broker.db.set({ ...broker.db.get("SIGNIN_CLIENTS", "CLIENT#tool-app")!, scopes: ["tasks:read", "tasks:act", "decisions:decide"] });
  const response = await broker.handler({ version: "2.0", rawPath: path, rawQueryString: "", headers: { authorization: await clientBearer(MAYA, { ...TOOL_CLIENT, scope: "decisions:decide" }, `${TOOL_CLIENT.clientId}-${MAYA.sessionId}`) }, body: JSON.stringify(request), requestContext: { requestId: randomUUID(), http: { method: "POST" } } });
  expect(response.statusCode).toBe(200);
  expect(await t.stored(taskId)).toMatchObject({ stage: "IMPLEMENT", decisions: [expect.objectContaining({ actorId: taskOwnerKey(MAYA.developerId, taskId), decision: "APPROVE" })] });
  const audit = t.world.audit.find((event) => event.action === "decision.approved");
  expect(audit?.actor).toEqual({ type: "person", id: MAYA.developerId });
  expect(audit?.details?.["via"]).toBe("tool");
  const after = await t.stored(taskId);
  const replay = await broker.handler({ version: "2.0", rawPath: path, rawQueryString: "", headers: { authorization: await clientBearer(MAYA, { ...TOOL_CLIENT, scope: "decisions:decide" }, `${TOOL_CLIENT.clientId}-${MAYA.sessionId}`) }, body: JSON.stringify(request), requestContext: { requestId: randomUUID(), http: { method: "POST" } } });
  expect(replay.statusCode).toBe(200);
  expect(await t.stored(taskId)).toEqual(after);
  expect(t.world.audit.filter((event) => event.action === "decision.approved")).toHaveLength(1);
});

// PROD BUG (setup host asks): a setup run's website ask said "waiting for an administrator on the Decisions page", but the list never held a card for it. The list now draws one card per open ask of
// the company for the people who may decide it (a company owner or admin, the rule of the run page's host-decide route), and nobody else.
describe("the deployed decision cards: a setup run's website asks", () => {
  const HOST = "deps.exampledeps.dev";
  async function hostWorld() {
    const t = await setup();
    t.memberships.set("dev-o", { companyId: ORG, role: "owner" });
    t.grants.set("dev-o|payments", "developer");
    // A project maintainer who is only a member, and a plain member with no grant on the project.
    t.memberships.set("dev-m", { companyId: ORG, role: "member" });
    t.grants.set("dev-m|payments", "administrator");
    t.memberships.set("dev-n", { companyId: ORG, role: "member" });
    const seedAsk = async (companyId: OrgId, project: string, host = HOST): Promise<SetupHostAsk> => {
      const taskId = randomUUID();
      await t.world.store.put({ item: { pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", purpose: "setup_agent", companyId, project, developerId: "dev-starter", provider: HOSTED_IDENTITY_PROVIDER, workspaceId: randomUUID() } });
      const outcome = await requestHostAsk({ store: t.world.store, now: () => t.world.clock.now }, { orgId: companyId, project, host, taskId, projectDomains: [], journalN: 4, from: { path: "package.json", line: 12 } });
      if (outcome.outcome !== "created") throw new Error(`the ask was not made: ${outcome.outcome}`);
      return outcome.ask;
    };
    return { ...t, seedAsk };
  }
  const hostCards = async (deps: Deps, personId: string, companyId: string = ORG) => (await view(deps, personId, companyId)).cards.filter((card) => card.kind === "setup_host");

  it("lists an open ask as one card for a company owner and for an admin, with the host, where it came from, and the way to the run page", async () => {
    const t = await hostWorld();
    const ask = await t.seedAsk(ORG, "payments");
    const subjectId = hostAskSubjectId(ORG, "payments", HOST);
    for (const person of ["dev-o", "dev-b"]) {
      const cards = await hostCards(t.deps, person);
      expect(cards, person).toHaveLength(1);
      expect(cards[0]).toMatchObject({ id: `setup_host:${subjectId}`, kind: "setup_host", project: "payments" });
      expect(JSON.stringify(cards[0])).toContain(HOST);
      expect(JSON.stringify(cards[0])).toContain("package.json:12");
      expect(JSON.stringify(cards[0])).toContain("/app/projects/payments/setup");
      // Open-only: the person decides on the setup page (the decisions performer has no handler for it), so the card has no Approve, Reject or Request changes.
      expect(cards[0]!.actions.map((action) => action.kind), person).toEqual(["open"]);
      expect(cards[0]!.actions[0]).toMatchObject({ method: "GET", href: "/app/projects/payments/setup", label: "Open the setup" });
      expect(cards[0]!.rejectReasons).toEqual([]);
    }
    expect(hostAskDigest(ask)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("shows the card to nobody who may not decide it: a plain member, a project maintainer who is only a member, a non-member", async () => {
    const t = await hostWorld();
    await t.seedAsk(ORG, "payments");
    for (const person of ["dev-a", "dev-m", "dev-n"]) expect(await hostCards(t.deps, person), person).toEqual([]);
    expect(await hostCards(t.deps, "nobody")).toEqual([]);
  });

  it("never lists another company's ask, and the other company's owner sees only theirs", async () => {
    const t = await hostWorld();
    await t.seedAsk(OTHER, "payments", "theirs.exampledeps.dev");
    expect(await hostCards(t.deps, "dev-b")).toEqual([]);
    expect(await hostCards(t.deps, "dev-o")).toEqual([]);
    await t.seedAsk(ORG, "payments");
    const mine = await hostCards(t.deps, "dev-b");
    expect(mine).toHaveLength(1);
    expect(JSON.stringify(mine)).not.toContain("theirs.exampledeps.dev");
    const theirs = await hostCards(t.otherDeps, "dev-x", OTHER);
    expect(theirs).toHaveLength(1);
    expect(JSON.stringify(theirs)).toContain("theirs.exampledeps.dev");
    expect(JSON.stringify(theirs)).not.toContain(HOST);
  });

  it("drops a resolved ask: approved or refused (the index row is removed), and a stale index row whose ask is no longer open", async () => {
    const t = await hostWorld();
    const first = await t.seedAsk(ORG, "payments");
    const second = await t.seedAsk(ORG, "payments", "other.exampledeps.dev");
    expect(await hostCards(t.deps, "dev-b")).toHaveLength(2);
    // What the decision's transaction does: the ask's state changes and its index row goes.
    await t.world.store.update({ key: hostAskKey(ORG, "payments", first.host), ops: [change.set("state", "approved")] });
    await t.world.store.delete({ key: { pk: orgScoped(ORG, "SETUP_HOST_OPEN"), sk: `payments#${first.host}` } });
    const remaining = await hostCards(t.deps, "dev-b");
    expect(remaining).toHaveLength(1);
    expect(JSON.stringify(remaining)).toContain("other.exampledeps.dev");
    // The index row alone is not enough: an ask that is no longer open is not listed even when its row was left behind.
    await t.world.store.update({ key: hostAskKey(ORG, "payments", second.host), ops: [change.set("state", "refused")] });
    expect(await hostCards(t.deps, "dev-b")).toEqual([]);
  });

  // Review test (lead 4 Opus, e9add25b3): a row whose store lifetime has passed is no longer an ask, whichever of the two rows (the company's index pointer, or the ask itself) ran out first.
  it("drops an ask whose store lifetime has passed: the index row's, or the ask row's own", async () => {
    const t = await hostWorld();
    const first = await t.seedAsk(ORG, "payments");
    const second = await t.seedAsk(ORG, "payments", "other.exampledeps.dev");
    expect(await hostCards(t.deps, "dev-b")).toHaveLength(2);
    const past = Math.floor(t.world.clock.now / 1000) - 1;
    // The index row ran out (the store has not removed it yet); the ask row itself still looks open and fresh.
    await t.world.store.update({ key: { pk: orgScoped(ORG, "SETUP_HOST_OPEN"), sk: `payments#${first.host}` }, ops: [change.set(INDEX_EXPIRY_ATTRIBUTE, past)] });
    const left = await hostCards(t.deps, "dev-b");
    expect(left).toHaveLength(1);
    expect(JSON.stringify(left)).toContain("other.exampledeps.dev");
    // The ask row ran out while its index row is still fresh.
    await t.world.store.update({ key: hostAskKey(ORG, "payments", second.host), ops: [change.set(INDEX_EXPIRY_ATTRIBUTE, past)] });
    expect(await hostCards(t.deps, "dev-b")).toEqual([]);
  });

  it("is mounted: the deployed developer route lists it for an admin and not for a member", async () => {
    const t = await hostWorld();
    await t.seedAsk(ORG, "payments");
    const companyOf = async (caller: { principal: Principal }) => t.memberships.get(caller.principal.personId);
    const wired = createCoreDevRoutes({ app: t.app, companyOf, wiring: async (runtime) => ({ origin: () => "https://api.example", ...deployedDevWiringParts({ runtime, registry: t.registry, people: t.people, decisionProofs: t.point.proofs }) }) });
    const list = async (personId: string) => {
      const answer = await wired.route({ method: "GET", path: "/v1/app/decisions", headers: {} }, { principal: principalOf(personId), client: "app" });
      expect(answer?.statusCode).toBe(200);
      return DecisionCardsViewSchema.parse(JSON.parse(answer!.body)).cards.filter((card) => card.kind === "setup_host");
    };
    expect(await list("dev-b")).toHaveLength(1);
    expect(await list("dev-a")).toEqual([]);
  });
});
