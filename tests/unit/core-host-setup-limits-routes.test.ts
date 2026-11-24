// SETUP-LIMITS: the project's setup-run limits on the deployed API (GET / PUT /v1/app/projects/{p}/setup-agent/limits). Any live role on the project reads; only the people who start a run (a live company owner or admin, or
// the project's administrator) change them; every value is bounded by the contract's maxima and the company's cap; a stale revision is a conflict; a repeat of one request id writes once; the change is audited; and the NEXT run
// starts with the new limits (a run going keeps its own).
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, type AuditEvent, type AuditSink, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { setupAgentKey } from "../../packages/broker/src/core/setup-agent/keys.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { NOT_FOR_SCRIPT_TOKENS, NOT_ON_THE_CORE_YET, createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import {
  SETUP_LIMITS_NOT_ALLOWED, SETUP_RUN_PROJECT_NOT_FOUND, type HostedSetupRunWiring, type SetupRunStanding,
} from "../../packages/broker/src/core-host/setup-run-routes.js";
import { ON_THE_WEBSITE_MESSAGE, setupLimitsKey, setupLocksKey } from "@agentx/contracts";
import { SETUP_LIMITS_AUDIT_UNAVAILABLE, SETUP_LIMITS_STALE, SETUP_LIMITS_UNREADABLE } from "../../packages/broker/src/core/setup-agent/limits.js";
import { HOSTED_IDENTITY_PROVIDER } from "../../packages/broker/src/core-host/hosted-modules.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";

const OTHER = "org_corehost00000000000b";
const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const project = (name: string): ProjectDefinition => ({
  name, revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
});

function appOver(world: FakeWorld, startModelCheck?: () => Promise<undefined>): CoreHostApp {
  return createCoreHostApp({
    modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ ...(startModelCheck === undefined ? {} : { flowOptions: { startModelCheck } }), callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
  });
}

async function register(world: FakeWorld, companyId: string, name: string): Promise<void> {
  const definition = project(name);
  await world.store.put({ item: { ...projectRevisionKey(companyId, name, 1), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(definition)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, name), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
}

const get = (path: string) => ({ method: "GET", path, headers: {}, body: "" });
const post = (path: string, body: unknown = {}) => ({ method: "POST", path, headers: {}, body: JSON.stringify(body) });
const RUN = "/v1/app/projects/payments/setup-agent";

interface Person { caller: DeployedCaller; membership: CompanyMembership; grant?: "developer" | "administrator" }

async function setupWorld(options: { startModelCheck?: () => Promise<undefined>; env?: NodeJS.ProcessEnv; gateway?: boolean; standing?: HostedSetupRunWiring["standing"]; audit?: (sink: AuditSink) => AuditSink } = {}) {
  const world = createFakeWorld();
  await register(world, FAKE_COMPANY, "payments");
  await register(world, OTHER, "payments");
  await register(world, OTHER, "ledger");
  const app = appOver(world, options.startModelCheck);
  const people = new Map<string, Person>();
  const person = (personId: string, companyId: string, role: CompanyMembership["role"], grant?: Person["grant"]): DeployedCaller => {
    const caller: DeployedCaller = { principal: { companyId, personId, displayName: `Name ${personId}`, roles: [role], provider: HOSTED_IDENTITY_PROVIDER }, client: "cloud", webApp: true };
    people.set(personId, { caller, membership: { companyId, role }, ...(grant === undefined ? {} : { grant }) });
    return caller;
  };
  // The rule as the deployment wires it (PR 16's lifecycleAccess over live membership and the grant), over this test's people; the root's own wiring is tested in core-engine-root.test.ts.
  const standing = vi.fn(options.standing ?? (async (personId: string, companyId: string): Promise<SetupRunStanding> => {
    const found = people.get(personId);
    if (found === undefined || found.membership.companyId !== companyId) return { access: "none" };
    if (found.membership.role === "owner") return { access: "manage", basis: "company-owner" };
    if (found.membership.role === "admin") return { access: "manage", basis: "company-admin" };
    if (found.grant === "administrator") return { access: "manage", basis: "project-admin" };
    return found.grant === "developer" ? { access: "view" } : { access: "none" };
  }));
  const setupRun: HostedSetupRunWiring = { standing, modelAccessConfigured: () => options.gateway ?? true, displayName: async (id) => people.get(id)?.caller.principal.displayName };
  const wiring: CoreDevWiring = { origin: () => "https://api.example", setupRun, ...(options.audit === undefined ? {} : { auditFor: (_caller, sink) => options.audit!(sink) }) };
  const routes = createCoreDevRoutes({ app, companyOf: async (caller) => people.get(caller.principal.personId)?.membership, wiring: () => wiring });
  const call = async (request: { method: string; path: string; headers: Record<string, string>; body: string }, caller: DeployedCaller) => {
    const answer = await routes.route(request, caller);
    if (answer === undefined) throw new Error("not served");
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Record<string, unknown>, raw: answer.body };
  };
  return { world, app, person, standing, call, routes, wiring };
}

const pointerOf = (world: FakeWorld, companyId: string, name = "payments") => world.store.get(setupAgentKey(companyId, name));
const LIMITS = "/v1/app/projects/payments/setup-agent/limits";
const put = (body: unknown, path = LIMITS) => ({ method: "PUT", path, headers: {}, body: JSON.stringify(body) });
const DEFAULTS = { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 };
const MAXIMA = { commands: 120, sameStepTries: 5, wallClockMin: 120, budgetCents: 2_000, hostAsks: 10 };
const limitEvents = (world: FakeWorld): AuditEvent[] => world.audit.filter((event) => event.action === "setup.limits_changed");
const rowOf = (world: FakeWorld, companyId: string = FAKE_COMPANY, name = "payments") => world.store.get(setupLimitsKey(companyId, name));
const change = (expectedRevision: number, limits: Record<string, unknown>, requestId = randomUUID()) => ({ requestId, expectedRevision, limits });

async function people(h: Awaited<ReturnType<typeof setupWorld>>) {
  return {
    owner: h.person("p-owner", FAKE_COMPANY, "owner"), admin: h.person("p-admin", FAKE_COMPANY, "admin"),
    maintainer: h.person("p-maint", FAKE_COMPANY, "member", "administrator"), reader: h.person("p-reader", FAKE_COMPANY, "member", "developer"),
    stranger: h.person("p-stranger", FAKE_COMPANY, "member"), outsider: h.person("p-outside", OTHER, "owner"),
  };
}

describe("the project's setup limits: who may read and who may change", () => {
  it("shows every person who uses the project the limits, the bounds and what a run would use; a person with no access sees the uniform 404", async () => {
    const h = await setupWorld();
    const who = await people(h);
    for (const caller of [who.owner, who.admin, who.maintainer, who.reader]) {
      const answer = await h.call(get(LIMITS), caller);
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ revision: 0, limits: {}, companyLock: {}, effective: DEFAULTS, defaults: DEFAULTS, maxima: MAXIMA });
    }
    const other = "/v1/app/projects/ledger/setup-agent/limits";
    for (const [caller, path] of [[who.stranger, LIMITS], [who.admin, other], [who.admin, "/v1/app/projects/missing/setup-agent/limits"], [who.admin, "/v1/app/projects/-bad/setup-agent/limits"]] as const) {
      expect(await h.call(get(path), caller), path).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND", message: SETUP_RUN_PROJECT_NOT_FOUND } } });
      expect((await h.call(put(change(0, { commands: 10 }), path), caller)).status, path).toBe(404);
    }
    expect((await h.call(put(change(0, { commands: 10 }), other), who.outsider)).status).toBe(200);
    expect((await h.call(get(LIMITS), who.outsider)).body).toMatchObject({ revision: 0 });
    expect(await rowOf(h.world)).toBeUndefined();
  });

  it("lets a company owner, a company admin and the project's administrator change them (the people who start a run), each audited with why they were allowed", async () => {
    const h = await setupWorld();
    const who = await people(h);
    let revision = 0;
    for (const [caller, basis, id] of [[who.owner, "company-owner", "p-owner"], [who.admin, "company-admin", "p-admin"], [who.maintainer, "project-admin", "p-maint"]] as const) {
      const answer = await h.call(put(change(revision, { commands: 30 + revision })), caller);
      expect(answer.status, id).toBe(200);
      revision += 1;
      expect(answer.body).toMatchObject({ revision, limits: { commands: 29 + revision } });
      expect(limitEvents(h.world).at(-1)).toMatchObject({ actor: { type: "person", id }, subject: { type: "project", id: "payments" }, companyId: FAKE_COMPANY });
      expect(limitEvents(h.world).at(-1)?.details).toMatchObject({ project: "payments", basis, revision });
    }
    expect(limitEvents(h.world)).toHaveLength(3);
    // A person who only uses the project reads and is refused a change in fixed words; the row is not touched.
    const before = await rowOf(h.world);
    const refused = await h.call(put(change(3, { commands: 5 })), who.reader);
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: SETUP_LIMITS_NOT_ALLOWED } } });
    expect(await rowOf(h.world)).toEqual(before);
    expect(limitEvents(h.world)).toHaveLength(3);
  });

  it("re-reads the standing live: a person who lost it between two requests is refused the second", async () => {
    let calls = 0;
    const h = await setupWorld({ standing: async () => (calls++ === 0 ? { access: "manage", basis: "company-admin" } : { access: "view" }) });
    const admin = h.person("p-admin", FAKE_COMPANY, "admin");
    expect((await h.call(put(change(0, { commands: 20 })), admin)).status).toBe(200);
    expect((await h.call(put(change(1, { commands: 21 })), admin)).status).toBe(403);
    expect((await rowOf(h.world))?.["limits"]).toEqual({ commands: 20 });
  });

  it("never serves a script token, and says 'not on the core yet' when the setup run is not wired", async () => {
    const h = await setupWorld();
    const owner = h.person("p-owner", FAKE_COMPANY, "owner");
    const token = await h.call(put(change(0, { commands: 5 })), { ...owner, scriptToken: { tokenId: "t1" } });
    expect(token.body).toEqual({ error: { code: "FORBIDDEN", message: NOT_FOR_SCRIPT_TOKENS } });
    const bare = createCoreDevRoutes({ app: h.app, companyOf: async () => ({ companyId: FAKE_COMPANY, role: "owner" }), wiring: () => ({ origin: () => "https://api.example" }) });
    const answer = await bare.route(put(change(0, { commands: 5 })), owner);
    expect(JSON.parse(answer!.body)).toEqual({ error: { code: "NOT_FOUND", message: NOT_ON_THE_CORE_YET } });
    expect(await rowOf(h.world)).toBeUndefined();
  });

  it("serves no other method on the path", async () => {
    const h = await setupWorld();
    const owner = h.person("p-owner", FAKE_COMPANY, "owner");
    for (const method of ["POST", "DELETE", "PATCH"]) expect(await h.routes.route({ method, path: LIMITS, headers: {}, body: "{}" }, owner), method).toBeUndefined();
  });
});

describe("the project's setup limits: what a change may say", () => {
  it("refuses every value outside 1 to the contract's maximum, a non-whole number, an unknown limit and a loose body, writing and recording nothing", async () => {
    const h = await setupWorld();
    const { owner } = await people(h);
    const bad: unknown[] = [
      change(0, { commands: 0 }), change(0, { commands: 121 }), change(0, { sameStepTries: 6 }), change(0, { wallClockMin: 121 }), change(0, { budgetCents: 2_001 }), change(0, { hostAsks: 11 }),
      change(0, { commands: -1 }), change(0, { commands: 1.5 }), change(0, { commands: "10" }), change(0, { commands: null }), change(0, { speed: 3 }), change(0, { commands: 10, budgetCents: 99_999 }),
      { requestId: "nope", expectedRevision: 0, limits: {} }, { expectedRevision: 0, limits: {} }, { requestId: randomUUID(), limits: {} }, { requestId: randomUUID(), expectedRevision: -1, limits: {} },
      { requestId: randomUUID(), expectedRevision: 0 }, { requestId: randomUUID(), expectedRevision: 0, limits: {}, payer: "x" }, { requestId: randomUUID(), expectedRevision: 0, limits: [] }, {},
    ];
    for (const body of bad) {
      const answer = await h.call(put(body), owner);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(answer.body, JSON.stringify(body)).toMatchObject({ error: { code: "CONFIG_INVALID" } });
    }
    const notJson = await h.call({ method: "PUT", path: LIMITS, headers: {}, body: "{not json" }, owner);
    expect(notJson.status).toBe(400);
    expect(await rowOf(h.world)).toBeUndefined();
    expect(limitEvents(h.world)).toEqual([]);
  });

  it("accepts the smallest and the largest value of each limit, and an empty setting (which removes the project's own limits)", async () => {
    const h = await setupWorld();
    const { owner } = await people(h);
    const low = await h.call(put(change(0, { commands: 1, sameStepTries: 1, wallClockMin: 1, budgetCents: 1, hostAsks: 1 })), owner);
    expect(low.body).toMatchObject({ revision: 1, effective: { commands: 1, sameStepTries: 1, wallClockMin: 1, budgetCents: 1, hostAsks: 1 } });
    const high = await h.call(put(change(1, MAXIMA)), owner);
    expect(high.body).toMatchObject({ revision: 2, limits: MAXIMA, effective: MAXIMA });
    const none = await h.call(put(change(2, {})), owner);
    expect(none.body).toMatchObject({ revision: 3, limits: {}, effective: DEFAULTS });
    expect((await h.call(get(LIMITS), owner)).body).toMatchObject({ revision: 3, limits: {}, effective: DEFAULTS });
  });

  it("holds a value to the company's cap: above it is refused, at it is accepted, and the view shows the cap and what a run would use", async () => {
    const h = await setupWorld();
    const { owner, reader } = await people(h);
    await h.world.store.put({ item: { ...setupLocksKey(FAKE_COMPANY), entityType: "SETUP_LOCKS", limits: { commands: 20, budgetCents: 250 } } });
    expect((await h.call(put(change(0, { commands: 21 })), owner)).body).toEqual({ error: { code: "CONFIG_INVALID", message: "commands: the company's cap is 20" } });
    expect((await h.call(put(change(0, { budgetCents: 251 })), owner)).status).toBe(400);
    expect(await rowOf(h.world)).toBeUndefined();
    const saved = await h.call(put(change(0, { commands: 20, wallClockMin: 90 })), owner);
    expect(saved.status).toBe(200);
    const seen = await h.call(get(LIMITS), reader);
    expect(seen.body).toMatchObject({ revision: 1, limits: { commands: 20, wallClockMin: 90 }, companyLock: { commands: 20, budgetCents: 250 }, effective: { ...DEFAULTS, commands: 20, wallClockMin: 90, budgetCents: 250 } });
  });

  it("cuts a stored value down to a cap set later, and holds a damaged lock to the defaults (never looser)", async () => {
    const h = await setupWorld();
    const { owner } = await people(h);
    await h.call(put(change(0, { commands: 100, budgetCents: 1_500 })), owner);
    await h.world.store.put({ item: { ...setupLocksKey(FAKE_COMPANY), entityType: "SETUP_LOCKS", limits: { commands: 50 } } });
    expect((await h.call(get(LIMITS), owner)).body).toMatchObject({ limits: { commands: 100, budgetCents: 1_500 }, effective: { commands: 50, budgetCents: 1_500 } });
    await h.world.store.put({ item: { ...setupLocksKey(FAKE_COMPANY), entityType: "SETUP_LOCKS", limits: { commands: "lots" } } });
    expect((await h.call(get(LIMITS), owner)).body).toMatchObject({ companyLock: { commands: 40 }, effective: { commands: 40, budgetCents: 1_500 } });
    await h.world.store.put({ item: { ...setupLocksKey(FAKE_COMPANY), entityType: "SETUP_LOCKS", limits: "broken" } });
    expect((await h.call(get(LIMITS), owner)).body).toMatchObject({ effective: DEFAULTS });
  });
});

describe("the project's setup limits: revisions and repeats", () => {
  it("refuses a stale revision as a conflict and writes nothing: a person who read revision 0 cannot overwrite revision 1", async () => {
    const h = await setupWorld();
    const { owner, admin } = await people(h);
    expect((await h.call(put(change(0, { commands: 10 })), owner)).status).toBe(200);
    const stale = await h.call(put(change(0, { commands: 99 })), admin);
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: { code: "CHANGE_STALE", message: SETUP_LIMITS_STALE } });
    const ahead = await h.call(put(change(5, { commands: 99 })), admin);
    expect(ahead.status).toBe(409);
    expect((await rowOf(h.world))?.["limits"]).toEqual({ commands: 10 });
    expect(limitEvents(h.world)).toHaveLength(1);
    expect((await h.call(put(change(1, { commands: 11 })), admin)).body).toMatchObject({ revision: 2, limits: { commands: 11 } });
  });

  it("refuses the second of two writes made from the same revision at the store (the condition holds even when the read was fresh)", async () => {
    const h = await setupWorld();
    const { owner } = await people(h);
    await h.call(put(change(0, { commands: 10 })), owner);
    // A write that read revision 1 but lost the race: the store's condition fails after the read.
    const real = h.world.store.get.bind(h.world.store);
    let injected = false;
    vi.spyOn(h.world.store, "get").mockImplementation(async (key) => {
      const item = await real(key);
      if (!injected && key.sk === "LIMITS") { injected = true; await h.world.store.update({ key, ops: [{ op: "set", path: ["revision"], value: 2 }] } as never); }
      return item;
    });
    const raced = await h.call(put(change(1, { commands: 12 })), owner);
    expect(raced.status).toBe(409);
    expect(raced.body).toMatchObject({ error: { code: "CHANGE_STALE" } });
    expect((await rowOf(h.world))?.["limits"]).toEqual({ commands: 10 });
    // The audit row is in the same transaction: the lost write left none (the fake sink notes every event it is asked to stage, so the outbox is what counts).
    const outbox = await h.world.store.query({ pk: `ORG#${FAKE_COMPANY}#AUDIT_OUTBOX`, sk: { op: "beginsWith", prefix: "EVENT#setup.limits_changed" } } as never);
    expect(outbox.items).toHaveLength(1);
  });

  it("answers a repeat of the same request as the first: one row change, one audit record, the same view", async () => {
    const h = await setupWorld();
    const { owner } = await people(h);
    const body = change(0, { commands: 33, hostAsks: 2 });
    const first = await h.call(put(body), owner);
    const again = await h.call(put(body), owner);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(first.body).toMatchObject({ revision: 1 });
    expect(limitEvents(h.world)).toHaveLength(1);
    // The same id with other limits is a conflict, not a second write.
    const reused = await h.call(put({ ...body, limits: { commands: 34 } }), owner);
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
    expect((await rowOf(h.world))?.["limits"]).toEqual({ commands: 33, hostAsks: 2 });
  });

  it("keeps each company's and each project's limits apart", async () => {
    const h = await setupWorld();
    const { owner, outsider } = await people(h);
    await h.call(put(change(0, { commands: 7 })), owner);
    await h.call(put(change(0, { commands: 9 }), "/v1/app/projects/ledger/setup-agent/limits"), outsider);
    expect((await h.call(get(LIMITS), outsider)).body).toMatchObject({ revision: 0, limits: {} });
    expect((await h.call(get("/v1/app/projects/ledger/setup-agent/limits"), outsider)).body).toMatchObject({ revision: 1, limits: { commands: 9 } });
    expect((await rowOf(h.world))?.["limits"]).toEqual({ commands: 7 });
    expect(await rowOf(h.world, OTHER, "payments")).toBeUndefined();
    expect((await rowOf(h.world, OTHER, "ledger"))?.["limits"]).toEqual({ commands: 9 });
  });
});

describe("the project's setup limits: the audit record and a row that does not read", () => {
  it("writes nothing when the audit record cannot be written", async () => {
    const h = await setupWorld({ audit: () => ({ stage: () => [], record: async () => { throw new Error("audit down"); } }) });
    const { owner } = await people(h);
    const answer = await h.call(put(change(0, { commands: 10 })), owner);
    expect(answer.status).toBe(503);
    expect(answer.body).toEqual({ error: { code: "AUDIT_UNAVAILABLE", message: SETUP_LIMITS_AUDIT_UNAVAILABLE } });
    expect(await rowOf(h.world)).toBeUndefined();
  });

  it("commits the audit record with the row: the numbers before and after, no other text", async () => {
    const h = await setupWorld();
    const { owner } = await people(h);
    await h.call(put(change(0, { commands: 10, budgetCents: 100 })), owner);
    await h.call(put(change(1, { commands: 12 })), owner);
    expect(limitEvents(h.world).map((event) => event.details)).toMatchObject([
      { revision: 1, before: {}, after: { commands: 10, budgetCents: 100 } }, { revision: 2, before: { commands: 10, budgetCents: 100 }, after: { commands: 12 } },
    ]);
    const outbox = await h.world.store.query({ pk: `ORG#${FAKE_COMPANY}#AUDIT_OUTBOX`, sk: { op: "beginsWith", prefix: "EVENT#setup.limits_changed" } } as never);
    expect(outbox.items).toHaveLength(2);
  });

  it("never reads a row that names another company or project, whatever its key says", async () => {
    const h = await setupWorld();
    const { owner } = await people(h);
    for (const wrong of [{ orgId: OTHER, project: "payments" }, { orgId: FAKE_COMPANY, project: "ledger" }]) {
      await h.world.store.put({ item: { ...setupLimitsKey(FAKE_COMPANY, "payments"), entityType: "SETUP_LIMITS", ...wrong, revision: 1, limits: { commands: 9 } } });
      expect((await h.call(get(LIMITS), owner)).status, JSON.stringify(wrong)).toBe(503);
    }
  });

  it("refuses to read or change a row that does not read, in fixed words, and a run is held to the defaults", async () => {
    const h = await setupWorld();
    const { owner } = await people(h);
    await h.world.store.put({ item: { ...setupLimitsKey(FAKE_COMPANY, "payments"), entityType: "SETUP_LIMITS", orgId: FAKE_COMPANY, project: "payments", revision: 1, limits: { commands: 9_999 }, secret: "do-not-echo" } });
    for (const answer of [await h.call(get(LIMITS), owner), await h.call(put(change(1, { commands: 5 })), owner)]) {
      expect(answer.status).toBe(503);
      expect(answer.body).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: SETUP_LIMITS_UNREADABLE } });
      expect(answer.raw).not.toContain("do-not-echo");
    }
    const started = await h.call(post(RUN, { requestId: randomUUID() }), owner);
    expect(started.status).toBe(202);
    expect((started.body as { limits: unknown }).limits).toEqual(DEFAULTS);
  });
});

describe("the project's setup limits: the next run uses them", () => {
  it("starts the next run with the saved limits (kept on the run's pointer and task), shows them on the setup page before any run, and a run going keeps its own", async () => {
    const h = await setupWorld();
    const { owner, reader } = await people(h);
    const saved = { commands: 12, sameStepTries: 2, wallClockMin: 20, budgetCents: 150, hostAsks: 3 };
    await h.call(put(change(0, saved)), owner);
    // The setup page of a project with no run says what a run would start with.
    expect((await h.call(get(RUN), reader)).body).toMatchObject({ status: "none", limits: saved });
    const started = await h.call(post(RUN, { requestId: randomUUID() }), owner);
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ limits: saved });
    expect((await pointerOf(h.world, FAKE_COMPANY))?.["limits"]).toEqual(saved);
    expect((await h.world.store.get(taskKey(started.body["taskId"] as string)))?.["setupAgentLimits"]).toEqual(saved);
    // Changing the limits while the run goes does not change that run's.
    await h.call(put(change(1, { commands: 99 })), owner);
    expect((await h.call(get(RUN), reader)).body).toMatchObject({ status: "running", limits: saved });
    expect((await pointerOf(h.world, FAKE_COMPANY))?.["limits"]).toEqual(saved);
  });

  it("cuts the next run's limits to the company's cap even when the project's own value is higher", async () => {
    const h = await setupWorld();
    const { owner } = await people(h);
    await h.call(put(change(0, { commands: 100, budgetCents: 1_800 })), owner);
    await h.world.store.put({ item: { ...setupLocksKey(FAKE_COMPANY), entityType: "SETUP_LOCKS", limits: { budgetCents: 300 } } });
    const started = await h.call(post(RUN, { requestId: randomUUID() }), owner);
    expect(started.body).toMatchObject({ limits: { ...DEFAULTS, commands: 100, budgetCents: 300 } });
  });

  it("uses Rovara's defaults for a project that never set any", async () => {
    const h = await setupWorld();
    const { owner } = await people(h);
    const started = await h.call(post(RUN, { requestId: randomUUID() }), owner);
    expect(started.body).toMatchObject({ limits: DEFAULTS });
  });
});

// Lead 4 Opus review (7d00c2be0): the two money gaps and the edge bounds.
describe("the project's setup limits: Opus review", () => {
  it("holds a run to the company's cap even when the project's own row does not read (a damaged row never lifts a run above the lock)", async () => {
    const h = await setupWorld();
    const { owner } = await people(h);
    await h.world.store.put({ item: { ...setupLocksKey(FAKE_COMPANY), entityType: "SETUP_LOCKS", limits: { budgetCents: 100, wallClockMin: 10 } } });
    await h.world.store.put({ item: { ...setupLimitsKey(FAKE_COMPANY, "payments"), entityType: "SETUP_LIMITS", orgId: FAKE_COMPANY, project: "payments", revision: 1, limits: { commands: 9_999 } } });
    const started = await h.call(post(RUN, { requestId: randomUUID() }), owner);
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ limits: { ...DEFAULTS, budgetCents: 100, wallClockMin: 10 } });
  });

  it("raises a limit only from the Rovara website's own client (DEC 254zzz91); lowering one is allowed from any full-access client", async () => {
    const h = await setupWorld();
    const { owner } = await people(h);
    const cli: DeployedCaller = { principal: owner.principal, client: "cli" };
    const raised = await h.call(put(change(0, { budgetCents: 2_000 })), cli);
    expect(raised).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: ON_THE_WEBSITE_MESSAGE } } });
    expect(await rowOf(h.world)).toBeUndefined();
    expect((await h.call(put(change(0, { budgetCents: 200 })), cli)).status).toBe(200);
    expect((await h.call(put(change(1, { budgetCents: 300 })), cli)).status).toBe(403);
    expect((await h.call(put(change(1, { budgetCents: 2_000 })), owner)).status).toBe(200);
  });

  it("refuses null, a numeric string, a boolean, a huge number, a nested object and a __proto__ key, writing nothing", async () => {
    const h = await setupWorld();
    const { owner } = await people(h);
    for (const limits of [{ commands: null }, { commands: "10" }, { commands: true }, { budgetCents: 1e21 }, { budgetCents: { value: 5 } }]) {
      expect((await h.call(put(change(0, limits)), owner)).status, JSON.stringify(limits)).toBe(400);
    }
    const proto = { method: "PUT", path: LIMITS, headers: {}, body: `{"requestId":"${randomUUID()}","expectedRevision":0,"limits":{"__proto__":{"budgetCents":2000}}}` };
    expect((await h.call(proto, owner)).status).toBe(400);
    for (const body of [{ requestId: randomUUID(), limits: {} }, { expectedRevision: 0, limits: {} }, { requestId: randomUUID(), expectedRevision: -1, limits: {} }, { requestId: randomUUID(), expectedRevision: 0.5, limits: {} }]) {
      expect((await h.call(put(body), owner)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await rowOf(h.world)).toBeUndefined();
    expect(limitEvents(h.world)).toHaveLength(0);
  });
});
