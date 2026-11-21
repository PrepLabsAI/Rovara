// Lead 4 L4-MF3: the company-wide agent directory on the deployed API (`GET /v1/app/agents`). Only a LIVE company owner or administrator reads it (the role is membership's, read for each request);
// a member (and any unknown role) gets one fixed 403 before anything is read; the company is the membership's, so two companies never meet; hosted Code cannot run a custom agent, and the list says so;
// nothing is invented (no budgets, no shares); the answer parses with the contract's strict schema; refusals are fixed words with no echo.
import { describe, expect, it, vi } from "vitest";
import { AgentDirectoryResponseSchema, AgentViewSchema, DEFAULT_AGENT_GUARDRAILS, agentGuardrailsKey, agentKey, change, type AuditSink, type OrgId, type OrgRole } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { AgentStore } from "../../packages/broker/src/core/agents/store.js";
import { writeGuardrails } from "../../packages/broker/src/core/agents/guardrails.js";
import {
  AGENTS_PATH, AGENT_CANT_RUN_ON_HOSTED, AGENT_DIRECTORY_BAD_VIEW, AGENT_DIRECTORY_MAX, AGENT_DIRECTORY_NOT_ALLOWED, AGENT_DIRECTORY_PROJECT_NOT_HERE, AGENT_DIRECTORY_UNAVAILABLE, routeHostedAgentDirectory,
} from "../../packages/broker/src/core-host/agent-directory-routes.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CompanyMembership, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const T0 = Date.parse("2026-11-17T10:00:00.000Z");
const ADA = "a".repeat(64);
const BOB = "b".repeat(64);
const CAT = "c".repeat(64);
const audit: AuditSink = { stage: () => [], record: async () => undefined };
// A clock that moves on each read, so agents made one after the other have distinct creation times (oldest first is then a real order).
let tick = 0;
const now = () => T0 + 1000 * tick++;

function world() {
  const store = new MemoryDocumentStore();
  const agents = (companyId: OrgId) => new AgentStore({ store, now, audit, companyId });
  const get = async (companyId: OrgId, role: unknown, query = "", developerId = ADA) => {
    const path = AGENTS_PATH;
    const answer = await routeHostedAgentDirectory({ request: { method: "GET", path: query === "" ? path : `${path}?${query}`, headers: {} }, path, companyId, role: role as OrgRole, developerId, store, audit, now });
    return { status: answer.statusCode, body: JSON.parse(answer.body ?? "{}") as Record<string, unknown>, raw: answer.body ?? "" };
  };
  return { store, agents, get };
}
type Row = { agentId: string; name: string; builtin: boolean; owner?: { developerId: string }; disabled?: boolean; status: string; needsLaterConnectors?: string };
const rows = (answer: { body: Record<string, unknown> }) => (answer.body["agents"] as Row[]);
const names = (answer: { body: Record<string, unknown> }) => rows(answer).map((row) => row.name);

async function seeded() {
  const w = world();
  await w.agents(A).create({ orgId: A, name: "Release notes A", description: "Writes the notes.", by: ADA });
  await w.agents(A).create({ orgId: A, name: "Triage A", by: BOB });
  await w.agents(B).create({ orgId: B, name: "Secret of B", by: CAT });
  return w;
}

describe("what it lists", () => {
  it("each custom agent: its owner, its status and that hosted Code cannot run it yet; no budget, no accountable person (Code stores none)", async () => {
    const w = await seeded();
    const answer = await w.get(A, "owner");
    const custom = rows(answer).filter((row) => !row.builtin);
    expect(custom.map((row) => row.owner)).toEqual([{ kind: "member", developerId: ADA }, { kind: "member", developerId: BOB }]);
    for (const row of custom) {
      expect(row.needsLaterConnectors).toBe(AGENT_CANT_RUN_ON_HOSTED);
      expect(row.status).toBe("active");
      expect(Object.keys(row)).not.toEqual(expect.arrayContaining(["monthlyBudgetUsd"]));
      expect("accountable" in row).toBe(false);
      expect("maxPerRunUsd" in row).toBe(false);
    }
    expect(AGENT_CANT_RUN_ON_HOSTED).toBe("Can't run on hosted yet.");
    for (const row of rows(answer).filter((r) => r.builtin)) expect(row.needsLaterConnectors).toBeUndefined();
    // A built-in on its default release: Rovara Code stays on release 1 until the company adopts 2, and says an update is available.
    const code = (answer.body["agents"] as Array<Record<string, unknown>>).find((row) => row["agentId"] === "rovara-code")!;
    expect(code).toMatchObject({ pinnedVersion: 1, currentVersion: 1, latestVersion: 2, updateAvailable: { from: 1, to: 2 }, access: "manage", status: "active" });
  });

  it("reads legacy member owners and round-trips project owners; mine excludes project-owned agents", async () => {
    const w = world();
    const legacy = await w.agents(A).create({ orgId: A, name: "Legacy owner", by: ADA });
    await w.store.update({ key: agentKey(A, legacy.agentId, "META"), ops: [change.set(["owner"], { developerId: ADA })] });
    expect((await w.agents(A).get(A, legacy.agentId))?.owner).toEqual({ kind: "member", developerId: ADA });

    const project = await w.agents(A).create({ orgId: A, name: "Project owned", by: ADA });
    const projectOwner = { kind: "project", project: "payments" } as const;
    await w.store.update({ key: agentKey(A, project.agentId, "META"), ops: [change.set(["owner"], projectOwner)] });
    expect((await w.agents(A).get(A, project.agentId))?.owner).toEqual(projectOwner);
    const all = rows(await w.get(A, "owner"));
    expect(all.find((row) => row.name === "Project owned")?.owner).toEqual(projectOwner);
    expect(names(await w.get(A, "owner", "scope=mine", ADA))).toEqual(["Legacy owner"]);
  });

  it("a built-in the company turned off in its guardrails says so; another company's setting is not read", async () => {
    const w = world();
    await writeGuardrails({ store: w.store, now }, A, { ...DEFAULT_AGENT_GUARDRAILS, disabledBuiltins: ["ticket-triage"] }, "owner");
    const mine = rows(await w.get(A, "owner")).filter((row) => row.disabled === true).map((row) => row.agentId);
    const theirs = rows(await w.get(B, "owner")).filter((row) => row.disabled === true);
    expect(mine).toEqual(["ticket-triage"]);
    expect(theirs).toEqual([]);
  });

  it("a view it does not offer is a fixed refusal: an unknown or repeated scope, another parameter, or a project's list", async () => {
    const w = await seeded();
    for (const query of ["scope=nonsense", "scope=ALL", "scope=", "scope=mine&scope=all", "scope=all&q=x", "q=1"]) {
      const answer = await w.get(A, "owner", query);
      expect(answer.status, query).toBe(400);
      expect(answer.body).toEqual({ error: { code: "CONFIG_INVALID", message: AGENT_DIRECTORY_BAD_VIEW } });
    }
    for (const query of ["project=alpha", "scope=all&project=alpha"]) {
      const answer = await w.get(A, "owner", query);
      expect(answer.status, query).toBe(404);
      expect(answer.body).toEqual({ error: { code: "NOT_FOUND", message: AGENT_DIRECTORY_PROJECT_NOT_HERE } });
    }
  });
});

describe("two companies", () => {

  it("a directory row of this company that points at an agent record naming another company is not listed (the record is read under this company's key and must name it)", async () => {
    const w = await seeded();
    const made = await w.agents(A).create({ orgId: A, name: "Planted", by: ADA });
    await w.store.update({ key: agentKey(A, made.agentId, "META"), ops: [change.set(["orgId"], B)] });
    const answer = await w.get(A, "owner");
    expect(names(answer)).not.toContain("Planted");
    expect(answer.status).toBe(200);
  });
});

describe("unreadable data is a fixed 503, never a shorter list", () => {
  it("a record whose owner is not a developer id, an unreadable guardrails row, a failing store and a directory over the bound", async () => {
    const w = await seeded();
    const made = await w.agents(A).create({ orgId: A, name: "Broken owner", by: ADA });
    await w.store.update({ key: agentKey(A, made.agentId, "META"), ops: [change.set(["owner"], { kind: "member", developerId: "not-a-hash" })] });
    const broken = await w.get(A, "owner");
    expect(broken.status).toBe(503);
    expect(broken.body).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: AGENT_DIRECTORY_UNAVAILABLE } });
    expect(broken.raw).not.toContain("not-a-hash");

    const guard = world();
    await guard.store.put({ item: { ...agentGuardrailsKey(A), entityType: "AGENT_GUARDRAILS", guardrails: { nonsense: true }, revision: 1 } });
    const unreadable = await guard.get(A, "owner");
    expect(unreadable.status).toBe(503);
    expect(unreadable.body).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: AGENT_DIRECTORY_UNAVAILABLE } });
    // The same row is another company's: this company's read is not affected.
    expect((await guard.get(B, "owner")).status).toBe(200);
    const sick = vi.spyOn(guard.store, "get").mockRejectedValue(new Error("table down: secret-detail"));
    const down = await guard.get(A, "owner");
    expect(down.status).toBe(503);
    expect(down.raw).not.toContain("secret-detail");
    sick.mockRestore();

    const big = world();
    for (let i = 0; i < AGENT_DIRECTORY_MAX + 1; i += 1) await big.store.put({ item: { pk: `ORG#${A}#AGENT_DIRECTORY`, sk: `agt_${String(i).padStart(20, "0")}`, entityType: "AGENT_DIRECTORY", orgId: A } });
    const over = await big.get(A, "owner");
    expect(over.status).toBe(503);
    expect(over.body).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: AGENT_DIRECTORY_UNAVAILABLE } });
  });
});

describe("the strict contract (Cloud's reader parses this)", () => {
  it("accepts a full view, and refuses an unknown field, a bad access level and a bad owner", () => {
    const view = { agentId: "rovara-code", name: "n", description: "d", builtin: true, access: "manage", status: "active", latestVersion: 2 };
    expect(AgentViewSchema.safeParse(view).success).toBe(true);
    expect(AgentViewSchema.safeParse({ ...view, extra: 1 }).success).toBe(false);
    expect(AgentViewSchema.safeParse({ ...view, access: "root" }).success).toBe(false);
    expect(AgentViewSchema.safeParse({ ...view, owner: { kind: "member", developerId: "x" } }).success).toBe(false);
    expect(AgentViewSchema.safeParse({ ...view, monthlyBudgetUsd: -1 }).success).toBe(false);
    expect(AgentDirectoryResponseSchema.safeParse({ agents: [view], extra: 1 }).success).toBe(false);
  });
});

// ---- Through the dev routes: the live role from membership, the caller's company, script tokens, other methods ----

const get = (path: string, method = "GET") => ({ method, path, headers: {}, body: "" });
function appOver(w: FakeWorld): CoreHostApp {
  return createCoreHostApp({
    modules: w.modules, context: () => w.context(), nowMs: () => w.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(w.clock.now), log: () => undefined, services: () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } }), ciReporting: { honest: true as const, ciMode: () => "their_ci_fix" as const } }),
  });
}
async function over() {
  const w = createFakeWorld();
  const app = appOver(w);
  const roles = new Map<string, OrgRole>();
  const companyOf = vi.fn(async (caller: DeployedCaller): Promise<CompanyMembership | undefined> => {
    const role = roles.get(caller.principal.personId + caller.principal.companyId);
    return role === undefined ? undefined : { companyId: caller.principal.companyId, role };
  });
  const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ origin: () => "https://api.example" }) });
  const person = (companyId: string, role: OrgRole, personId = "owner"): DeployedCaller => {
    const caller: DeployedCaller = { principal: localOwnerPrincipal({ companyId, personId }), client: "cli" };
    roles.set(personId + companyId, role);
    return caller;
  };
  const agents = (companyId: string) => new AgentStore({ store: w.store, now, audit, companyId: companyId });
  return { w, app, routes, person, roles, companyOf, agents };
}
const bodyOf = (answer: { body: string } | undefined) => JSON.parse(answer!.body) as { agents?: Row[]; error?: { code: string; message: string } };

describe("through the dev routes", () => {
  it("an owner and an admin read 200; a member is refused 403; the role is read live for each request (a demotion takes effect at once)", async () => {
    const h = await over();
    await h.agents(FAKE_COMPANY).create({ orgId: FAKE_COMPANY, name: "Mine", by: developerIdOf(localOwnerPrincipal({ companyId: FAKE_COMPANY, personId: "ada" })) });
    const owner = h.person(FAKE_COMPANY, "owner", "owner"), admin = h.person(FAKE_COMPANY, "admin", "ada"), member = h.person(FAKE_COMPANY, "member", "bo");
    expect((await h.routes.route(get(AGENTS_PATH), owner))?.statusCode).toBe(200);
    expect((await h.routes.route(get(`${AGENTS_PATH}?scope=all`), admin))?.statusCode).toBe(200);
    const refused = await h.routes.route(get(AGENTS_PATH), member);
    expect(refused?.statusCode).toBe(403);
    expect(bodyOf(refused).error?.message).toBe(AGENT_DIRECTORY_NOT_ALLOWED);
    // Demoted: the very next request is refused. Promoted: the very next one is served.
    h.roles.set("ada" + FAKE_COMPANY, "member");
    expect((await h.routes.route(get(AGENTS_PATH), admin))?.statusCode).toBe(403);
    h.roles.set("bo" + FAKE_COMPANY, "admin");
    expect((await h.routes.route(get(AGENTS_PATH), member))?.statusCode).toBe(200);
    // "mine" is the caller's own developer id: ada owns "Mine" (the same developer id derivation as a task's owner).
    h.roles.set("ada" + FAKE_COMPANY, "admin");
    expect(bodyOf(await h.routes.route(get(`${AGENTS_PATH}?scope=mine`), admin)).agents?.map((row) => row.name)).toEqual(["Mine"]);
    expect(bodyOf(await h.routes.route(get(`${AGENTS_PATH}?scope=mine`), owner)).agents).toEqual([]);
  });
});
