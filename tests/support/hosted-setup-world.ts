// L4-SF: a hosted company world for the setup approval's follow-ups (the old registry mirror, website asks): two companies, two projects, people with live roles and grants, the real hosted approval over the
// real approvers point. Shared by tests/unit/setup-registry-mirror.test.ts and tests/unit/core-host-setup-host-approval.test.ts.
import { randomUUID } from "node:crypto";
import { orgProjectCatalogKey, projectCatalogKey, projectMetaKey, projectRevisionKey, type AuditEvent, type JsonValue, type OrgId, type OrgRole, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { setupApplyDigest, setupApplyKey } from "../../packages/broker/src/core/setup-agent/apply.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CompanyMembership, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import type { HostedSetupRunWiring, SetupRunStanding } from "../../packages/broker/src/core-host/setup-run-routes.js";
import { createHostedSetupApproval, setupDecisionRequestId } from "../../packages/broker/src/core-host/setup-approval.js";
import { createHostedApprovers, approvalProofKeyOf } from "../../packages/broker/src/core-host/hosted-approvers.js";
import { HOSTED_IDENTITY_PROVIDER, createHostedIdentity } from "../../packages/broker/src/core-host/hosted-modules.js";
import { createSetupRegistryMirror } from "../../packages/broker/src/aws/setup-registry-mirror.js";
import { projectKey } from "../../packages/broker/src/aws/project-records.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "./core-host-fakes.js";

export { FAKE_COMPANY };
export const OTHER = "org_corehost00000000000b" as OrgId;
export const KEY = approvalProofKeyOf("callback-signing-key-for-tests-0123456789abcdef");
const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
export const command = (executable: string, args: string[] = []) => ({ cwd: "repo/demo", executable, args, timeoutSeconds: 600 });
export const projectDefinition = (name: string, revision = 1): ProjectDefinition => ({
  name, revision, setup: [command("npm", ["ci"])], readiness: [command("npm", ["test"])], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
});
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

function appOver(world: FakeWorld): CoreHostApp {
  return createCoreHostApp({
    modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
  });
}

/** The core's own copy of a project at revision 1 (catalog, revision, meta). */
export async function register(world: FakeWorld, companyId: string, name: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, name, 1), entityType: "PROJECT", definition: json(projectDefinition(name)) } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, name), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
  await world.store.put({ item: { ...projectMetaKey(companyId, name), entityType: "PROJECT_META", status: "active" } });
}

/** The old broker's registry rows of a project at revision 1: the revision record and the catalog row. `companyId` undefined: the old rows name no company (the implicit company's). */
export async function registerLegacy(world: FakeWorld, name: string, companyId: string | undefined, extra: Record<string, unknown> = {}): Promise<void> {
  await world.store.put({ item: { ...projectKey(name, 1), entityType: "PROJECT", ...(companyId === undefined ? {} : { companyId }), definition: json(projectDefinition(name)), runtimeBinding: { deploymentMode: "ec2-ebs", image: "demo@sha256:abc" }, registeredBy: "owner-key-1", registeredAt: "2026-11-01T00:00:00.000Z", ...json(extra) as Record<string, JsonValue> } });
  await world.store.put({ item: { ...projectCatalogKey(name), entityType: "PROJECT_CATALOG", name, latestRevision: 1, firstRegisteredAt: "2026-11-01T00:00:00.000Z" } });
}

/** A candidate revision 2 waiting for a decision, its check on a workspace in `status` (READY: passed). */
export async function seedCandidate(world: FakeWorld, companyId: string, name: string, changes: Record<string, unknown>, status = "READY"): Promise<{ digest: string; workspaceId: string }> {
  const definition = { ...projectDefinition(name), revision: 2, ...changes };
  await world.store.put({ item: { ...projectRevisionKey(companyId, name, 2), entityType: "PROJECT", candidate: true, definition: json(definition) } });
  const workspaceId = randomUUID();
  await world.store.put({ item: { ...workspaceKey(companyId, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId, orgId: companyId, status } });
  const digest = setupApplyDigest(definition.setup, definition.readiness);
  const at = new Date(world.clock.now).toISOString();
  await world.store.put({ item: {
    ...setupApplyKey(companyId, name), entityType: "SETUP_APPLY", orgId: companyId, project: name, taskId: "", requestId: randomUUID(), by: "p-runner", digest, baseRevision: 1, candidateRevision: 2,
    state: "checking", check: { workspaceId, revision: 2, startedAt: at, startedBy: "p-runner" }, reply: {}, createdAt: at,
  } });
  return { digest, workspaceId };
}

export const get = (path: string) => ({ method: "GET", path, headers: {}, body: "" });
export const post = (path: string, body: unknown = {}) => ({ method: "POST", path, headers: {}, body: JSON.stringify(body) });
export const RUN = "/v1/app/projects/payments/setup-agent";
export const LEDGER = "/v1/app/projects/ledger/setup-agent";

interface Person { companyId: OrgId; role: OrgRole; grants: Record<string, "developer" | "administrator"> }

export interface SetupWorldOptions {
  /** Wire the old-registry mirror into each company's hosted approval (default true). */
  mirror?: boolean;
  /** Seed the old registry rows for these projects, as `[project, companyId | undefined]`. */
  legacy?: ReadonlyArray<readonly [string, string | undefined]>;
}

export interface SetupWorld {
  world: FakeWorld;
  person: (personId: string, companyId: OrgId, role: OrgRole, grants?: Person["grants"]) => DeployedCaller;
  call: (request: { method: string; path: string; headers: Record<string, string>; body: string }, caller: DeployedCaller) => Promise<{ status: number; body: Record<string, unknown>; raw: string }>;
  routes: ReturnType<typeof createCoreDevRoutes>;
  audit: AuditEvent[];
  wirings: Map<string, HostedSetupRunWiring>;
}

export async function setupWorld(options: SetupWorldOptions = {}): Promise<SetupWorld> {
  const world = createFakeWorld();
  for (const [company, name] of [[FAKE_COMPANY, "payments"], [FAKE_COMPANY, "ledger"], [OTHER, "payments"]] as const) await register(world, company, name);
  for (const [name, company] of options.legacy ?? []) await registerLegacy(world, name, company);
  const app = appOver(world);
  const people = new Map<string, Person>();
  const membershipOf = async (personId: string) => { const found = people.get(personId); return found === undefined ? undefined : { companyId: found.companyId, role: found.role }; };
  const projectGrantRole = async (personId: string, name: string) => people.get(personId)?.grants[name];
  const person = (personId: string, companyId: OrgId, role: OrgRole, grants: Person["grants"] = {}): DeployedCaller => {
    people.set(personId, { companyId, role, grants });
    return {
      principal: { companyId, personId, displayName: personId, roles: [role], provider: HOSTED_IDENTITY_PROVIDER }, client: "cloud",
    };
  };
  const standing = async (personId: string, companyId: string, name: string): Promise<SetupRunStanding> => {
    const found = people.get(personId);
    if (found === undefined || found.companyId !== companyId) return { access: "none" };
    if (found.role === "owner") return { access: "manage", basis: "company-owner" };
    if (found.role === "admin") return { access: "manage", basis: "company-admin" };
    if (found.grants[name] === "administrator") return { access: "manage", basis: "project-admin" };
    return found.grants[name] === "developer" ? { access: "view" } : { access: "none" };
  };
  const identity = createHostedIdentity({ membershipOf, displayNameOf: async (id) => id });
  const approvers = createHostedApprovers({ store: world.store, identity, key: KEY, now: () => new Date(world.clock.now) });
  const audit: AuditEvent[] = [];
  const sink = { stage: (event: AuditEvent) => { audit.push(event); return []; }, record: async (event: AuditEvent) => { audit.push(event); } };
  const wiringFor = (companyId: OrgId): HostedSetupRunWiring => ({
    standing, modelAccessConfigured: () => true,
    approval: createHostedSetupApproval({
      flow: { store: world.store, companyId, now: () => new Date(world.clock.now) }, store: world.store, approvers, audit: sink, identity,
      people: { membershipOf, projectGrantRole }, proofKey: KEY, now: () => new Date(world.clock.now),
      ...(options.mirror === false ? {} : { registryMirror: createSetupRegistryMirror({ store: world.store, companyId }) }),
    }),
  });
  const wirings = new Map<string, HostedSetupRunWiring>([[FAKE_COMPANY, wiringFor(FAKE_COMPANY)], [OTHER, wiringFor(OTHER)]]);
  const routes = createCoreDevRoutes({
    app, companyOf: async (caller): Promise<CompanyMembership | undefined> => { const found = people.get(caller.principal.personId); return found === undefined ? undefined : { companyId: found.companyId, role: found.role }; },
    wiring: (runtime) => ({ origin: () => "https://api.example", setupRun: wirings.get(runtime.companyId)!, auditFor: (_caller, inner) => ({ stage: (event) => { audit.push(event); return inner.stage(event); }, record: async (event) => { audit.push(event); } }) }),
  });
  const call = async (request: { method: string; path: string; headers: Record<string, string>; body: string }, caller: DeployedCaller) => {
    const answer = await routes.route(request, caller);
    if (answer === undefined) throw new Error("not served");
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Record<string, unknown>, raw: answer.body };
  };
  return { world, person, call, routes, audit, wirings };
}

export const decideBody = (digest: string, outcome: "approve" | "reject" = "approve", revision = 2) => ({ requestId: setupDecisionRequestId(digest, revision) + randomUUID().slice(0, 8), outcome, seen: { revision, artifactDigest: digest } });
export const latestOf = async (world: FakeWorld, companyId: string, name = "payments") => (await world.store.get(orgProjectCatalogKey(companyId, name)))?.["latestRevision"];
export const applyRow = (world: FakeWorld, companyId: string, name = "payments") => world.store.get(setupApplyKey(companyId, name));
