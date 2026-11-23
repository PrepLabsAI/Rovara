// Browser testing tests: an in-memory object storage that behaves as the port says (immutable keys), shared by the proposal, route and renewal tests.
import { ObjectConflictError, type DocumentStore, type TransactItem, change, orgProjectCatalogKey, projectMetaKey, projectRevisionKey, type ObjectMeta, type ObjectStorage, type AuditEvent, type E2ESourceSnapshot, type JsonValue, type OrgId, type OrgRole, type ProjectDefinition } from "@agentx/contracts";
import { randomUUID } from "node:crypto";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createCoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CompanyMembership, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import type { HostedSetupRunWiring, SetupRunStanding } from "../../packages/broker/src/core-host/setup-run-routes.js";
import { createHostedSetupApproval, type HostedSetupApproval } from "../../packages/broker/src/core-host/setup-approval.js";
import { createHostedApprovers, approvalProofKeyOf } from "../../packages/broker/src/core-host/hosted-approvers.js";
import { HOSTED_IDENTITY_PROVIDER, createHostedIdentity } from "../../packages/broker/src/core-host/hosted-modules.js";
import { setupApplyKey } from "../../packages/broker/src/core/setup-agent/apply.js";
import { browserDraftKey } from "../../packages/broker/src/core/setup-agent/browser-testing-state.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "./core-host-fakes.js";
import { binding } from "./e2e-application-plan-fixtures.js";

export interface MemoryObjects extends ObjectStorage { map: Map<string, Uint8Array> }

export function memoryObjects(): MemoryObjects {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    async put(key: string, bytes: Uint8Array, _meta: ObjectMeta, options?: { overwrite?: true }) {
      if (map.has(key) && options?.overwrite !== true) throw new ObjectConflictError(key);
      map.set(key, Buffer.from(bytes));
    },
    async get(key: string, maxBytes: number) { const found = map.get(key); return found === undefined || found.byteLength > maxBytes ? undefined : found; },
    async stat(key: string) { const found = map.get(key); return found === undefined ? undefined : { bytes: found.byteLength, metadata: {} }; },
    async delete(key: string) { map.delete(key); },
    async deletePrefix(prefix: string) { for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key); return true; },
  };
}

// ---- a hosted company with projects, people and the browser testing wiring, over fakes


export const OTHER_COMPANY = "org_corehost00000000000b" as const;
export const REGISTRANT = "owner-key-of-the-registrant";
const KEY = approvalProofKeyOf("callback-signing-key-for-tests-0123456789abcdef");
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const command = (executable: string, args: string[] = []) => ({ cwd: "repo/demo", executable, args, timeoutSeconds: 600 });
export const projectDefinition = (name: string): ProjectDefinition => ({
  name, revision: 1, setup: [command("npm", ["ci"])], readiness: [command("npm", ["test"])], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
});

/** A project of a company at revision 1, registered the way a hosted project is: a registrant and a runtime binding on its row. */
export async function registerProject(world: FakeWorld, companyId: string, name: string, extra: Record<string, unknown> = { registeredBy: REGISTRANT, runtimeBinding: binding }): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, name, 1), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(projectDefinition(name))) as JsonValue, ...(extra as Record<string, JsonValue>) } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, name), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
  await world.store.put({ item: { ...projectMetaKey(companyId, name), entityType: "PROJECT_META", status: "active" } });
}

export interface BrowserWorldOptions {
  /** The files the code host gives for the project's repository (a function: a test changes them between reads). */
  snapshot: () => E2ESourceSnapshot;
  /** Whether the sandbox is available (a test flips it). */
  sandbox?: { available: boolean };
  /** The audit sink refuses (a test sets it). */
  audit?: { failing: boolean };
}
interface Person { companyId: OrgId; role: OrgRole; grants: Record<string, "developer" | "administrator"> }
const get = (path: string) => ({ method: "GET", path, headers: {}, body: "" });
const send = (method: string, path: string, body: unknown = {}) => ({ method, path, headers: {}, body: JSON.stringify(body) });
export const BT = "/v1/app/projects/payments/browser-testing";
export const browserGet = (path = BT) => get(path);
export const browserPost = (tail: string, body: unknown = {}, base = BT) => send("POST", `${base}/${tail}`, body);
export const browserPut = (tail: string, body: unknown = {}, base = BT) => send("PUT", `${base}/${tail}`, body);

/** The whole hosted shape: the dev routes over a fake world, three people of every role, the ONE approval gate and the browser testing wiring. */
export async function browserWorld(options: BrowserWorldOptions) {
  const objects = memoryObjects();
  // The store every module uses, behind one switch: a test can see (and race) every transaction. Nothing is hooked unless a test sets it.
  const hooks: { transact?: (items: readonly TransactItem[], real: DocumentStore) => Promise<unknown> } = {};
  const inner = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, ttlAttribute: "indexExpiresAt", nowSeconds: () => Math.floor(Date.parse("2026-11-15T10:00:00.000Z") / 1_000) });
  const world = createFakeWorld({ store: storeWith(inner, { transact: (async (items: readonly TransactItem[]) => (hooks.transact === undefined ? inner.transact(items) : hooks.transact(items, inner))) }), objects });
  for (const [company, name] of [[FAKE_COMPANY, "payments"], [OTHER_COMPANY, "payments"]] as const) await registerProject(world, company, name);
  const app = createCoreHostApp({
    modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: { honest: true as const, ciMode: () => "their_ci_fix" as const } }),
  });
  const people = new Map<string, Person>();
  const membershipOf = async (personId: string) => { const found = people.get(personId); return found === undefined ? undefined : { companyId: found.companyId, role: found.role }; };
  const projectGrantRole = async (personId: string, name: string) => people.get(personId)?.grants[name];
  const person = (personId: string, companyId: OrgId, role: OrgRole, grants: Person["grants"] = {}): DeployedCaller => {
    people.set(personId, { companyId, role, grants });
    return { principal: { companyId, personId, displayName: personId, roles: [role], provider: HOSTED_IDENTITY_PROVIDER }, client: "cloud" };
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
  const sink = { stage: (event: AuditEvent) => { audit.push(event); return []; }, record: async (event: AuditEvent) => { if (options.audit?.failing === true) throw new Error("audit down"); audit.push(event); } };
  const sandbox = options.sandbox ?? { available: true };
  const approvals = new Map<string, HostedSetupApproval>();
  const approvalFor = (companyId: OrgId): HostedSetupApproval => {
    let found = approvals.get(companyId);
    if (found === undefined) {
      found = createHostedSetupApproval({ flow: { store: world.store, companyId, now: () => new Date(world.clock.now) }, store: world.store, approvers, audit: sink, identity, people: { membershipOf, projectGrantRole }, proofKey: KEY, now: () => new Date(world.clock.now), objects });
      approvals.set(companyId, found);
    }
    return found;
  };
  const READY = [{ kind: "web" as const, profileId: "linux-arm64-web-api-v1" }];
  const routes = createCoreDevRoutes({
    app, companyOf: async (caller): Promise<CompanyMembership | undefined> => { const found = people.get(caller.principal.personId); return found === undefined ? undefined : { companyId: found.companyId, role: found.role }; },
    wiring: (runtime) => ({
      origin: () => "https://api.example",
      setupRun: { standing, modelAccessConfigured: () => true, approval: approvalFor(runtime.companyId) } satisfies HostedSetupRunWiring,
      browserTesting: {
        standing, approval: approvalFor(runtime.companyId), objects,
        capture: async () => options.snapshot(), readyProfiles: async () => READY, sandboxAvailable: async () => sandbox.available,
      },
      auditFor: (_caller, inner) => ({ stage: (event) => inner.stage(event), record: async (event) => sink.record(event) }),
    }),
  });
  const call = async (request: { method: string; path: string; headers: Record<string, string>; body: string }, caller: DeployedCaller) => {
    const answer = await routes.route(request, caller);
    if (answer === undefined) throw new Error("not served");
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Record<string, unknown>, raw: answer.body };
  };
  /** The check's workspace of the waiting candidate reaches READY (its commands passed). */
  const passCheck = async (companyId: OrgId = FAKE_COMPANY): Promise<void> => {
    const row = await world.store.get(setupApplyKey(companyId, "payments"));
    const workspaceId = (row?.["check"] as { workspaceId: string }).workspaceId;
    await world.store.update({ key: workspaceKey(companyId, workspaceId), ops: [change.set("status", "READY")] });
  };
  const failCheck = async (companyId: OrgId = FAKE_COMPANY): Promise<void> => {
    const row = await world.store.get(setupApplyKey(companyId, "payments"));
    const workspaceId = (row?.["check"] as { workspaceId: string }).workspaceId;
    await world.store.update({ key: workspaceKey(companyId, workspaceId), ops: [change.set("status", "PREPARATION_FAILED")] });
  };
  const owner = person("p-owner", FAKE_COMPANY, "owner");
  const admin = person("p-admin", FAKE_COMPANY, "admin");
  const projectAdmin = person("p-pm", FAKE_COMPANY, "member", { payments: "administrator" });
  const developer = person("p-dev", FAKE_COMPANY, "member", { payments: "developer" });
  const stranger = person("p-stranger", FAKE_COMPANY, "member");
  const outsider = person("p-out", OTHER_COMPANY, "owner");
  const latestRevision = async (companyId: OrgId = FAKE_COMPANY) => (await world.store.get(orgProjectCatalogKey(companyId, "payments")))?.["latestRevision"];
  /** The id the page offers the person for the waiting candidate (what the approve button sends). */
  const offered = async (caller: DeployedCaller) => ((await call(get(BT), caller)).body["candidate"] as { approval: { requestId: string; revision: number; artifactDigest: string } | null } | null)?.approval ?? undefined;
  const refresh = async (caller = owner) => call(browserPost("refresh", { requestId: randomUUID() }), caller);
  return { world, hooks, objects, people, person, call, audit, approvalFor, approvers, sandbox, passCheck, failCheck, owner, admin, projectAdmin, developer, stranger, outsider, latestRevision, offered, refresh, membershipOf, draftKey: browserDraftKey, READY };
}
export type BrowserWorld = Awaited<ReturnType<typeof browserWorld>>;

/** A store that behaves as `store` does, except for the named methods (a test makes a write fail, or lose a race, without touching the real one). */
export function storeWith(store: DocumentStore, overrides: Partial<Record<"transact" | "put" | "update" | "get" | "query", (...args: never[]) => unknown>>): DocumentStore {
  return new Proxy(store, { get: (target, property) => {
    const override = overrides[property as keyof typeof overrides];
    if (override !== undefined) return override;
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  } });
}
