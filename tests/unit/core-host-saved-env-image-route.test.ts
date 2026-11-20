// L4-MF1: a project's saved environment image panel on the deployed API (`GET /v1/app/projects/<p>/environment-image`, an APP_ROUTES row of its own, full access only). The core serves the Environment panel's own
// view (`savedEnvPanel`) from the company's saved-environment row for that project: the company is the membership's, a project the person may not read answers exactly like a missing one, another company's
// row and another project's row are never read, a script token is refused, a reader never gets `canReset`, and with the install switch off it is a plain 404 "off" (never made-up data).
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { documentSavedEnvStore } from "../../packages/broker/src/core/test-env/saved-env-store.js";
import type { SavedEnvState } from "../../packages/broker/src/core/test-env/saved-env.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { NOT_FOR_SCRIPT_TOKENS, NOT_ON_THE_CORE_YET, SAVED_ENV_OFF, createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";
import { DAY, dig, imageOf, iso, T0 } from "../support/saved-env-world.js";

const OTHER = "org_corehost00000000000b";
const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const projectOf = (name: string): ProjectDefinition => ({
  name, revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
});
const PATH = "/v1/app/projects/payments/environment-image";
const get = (path: string) => ({ method: "GET", path, headers: {}, body: "" });

function appOver(world: FakeWorld, env: NodeJS.ProcessEnv): CoreHostApp {
  return createCoreHostApp({
    env, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
  });
}

async function setup(enabled = true) {
  const world = createFakeWorld();
  for (const companyId of [FAKE_COMPANY, OTHER]) {
    for (const name of ["payments", "billing"]) {
      await world.store.put({ item: { ...projectRevisionKey(companyId, name, 1), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(projectOf(name))) as JsonValue } });
      await world.store.put({ item: { ...orgProjectCatalogKey(companyId, name), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
    }
  }
  const app = appOver(world, { ROVARA_CORE_ENGINE: "on" });
  const members = new Map<string, CompanyMembership>();
  const companyOf = vi.fn(async (caller: DeployedCaller) => members.get(caller.principal.personId + caller.principal.companyId));
  const callerOf = (companyId: string, role: CompanyMembership["role"] = "owner"): DeployedCaller => {
    const caller: DeployedCaller = { principal: localOwnerPrincipal({ companyId }), client: "cli" };
    members.set(caller.principal.personId + companyId, { companyId, role });
    return caller;
  };
  const allowed = new Set<string>(["payments", "billing"]);
  const wiring: CoreDevWiring = { origin: () => "https://api.example", canReadProject: async (_person, project) => allowed.has(project), savedEnv: { enabled } };
  const routes = createCoreDevRoutes({ app, companyOf, wiring: () => wiring });
  const rows = (companyId: string, projectId: string, change: Partial<SavedEnvState> = {}) => {
    const state: SavedEnvState = { orgId: companyId, projectId, version: 1, enabled: true, images: [], health: "never_proved", ...change };
    return documentSavedEnvStore({ store: world.store, audit: { stage: () => [], record: async () => undefined } }).commit(state, null, { action: "project_registered", orgId: companyId, projectId, at: iso(T0) });
  };
  return { world, app, routes, callerOf, allowed, companyOf, rows };
}
const bodyOf = (answer: { body: string } | undefined) => JSON.parse(answer!.body) as Record<string, unknown> & { error?: { message: string } };

describe("the panel read on the deployed API", () => {
  it("switch off: a plain 404 in fixed words, never made-up data, even where a row exists", async () => {
    const h = await setup(false);
    await h.rows(FAKE_COMPANY, "payments", { health: "healthy", images: [imageOf(dig(1))] });
    const answer = await h.routes.route(get(PATH), h.callerOf(FAKE_COMPANY));
    expect(answer?.statusCode).toBe(404);
    expect(bodyOf(answer).error?.message).toBe(SAVED_ENV_OFF);
    expect(SAVED_ENV_OFF).toBe("Saved environments are off for this install");
    expect(answer!.body).not.toContain("healthy");
  });

  it("switch on, a row: the panel's own view (image age, rebuild, last failure as a fixed word), even for an owner: canReset stays false", async () => {
    const h = await setup();
    const row = { health: "needs_repair" as const, images: [imageOf(dig(1), { recordedAt: iso(T0 - 3 * DAY) })], lastRebuildReason: "max_age" as const, lastFailureAt: iso(T0), lastFailure: "free text from a build log /secret/path", enabled: false };
    expect(await h.rows(FAKE_COMPANY, "payments", row)).toBe(true);
    // the fake world's clock is not T0: read the age from it
    const body = bodyOf(await h.routes.route(get(PATH), h.callerOf(FAKE_COMPANY, "owner")));
    expect(body).toMatchObject({ health: "needs_repair", image: { builtAt: iso(T0 - 3 * DAY), status: "ready" }, lastRebuildReason: "max_age", lastFailure: { at: iso(T0), reason: "failed" }, canReset: false, enabled: false, canChangeSetting: false });
    expect((body["image"] as { ageDays: number }).ageDays).toBe(Math.floor((h.world.clock.now - (T0 - 3 * DAY)) / DAY));
    // no digest, repository, tag, manifest or free text reaches the page
    expect(JSON.stringify(body)).not.toMatch(/sha256|manifest|secret|tag/u);
  });

  it("two companies: each reads only its own row under the same project name", async () => {
    const h = await setup();
    await h.rows(FAKE_COMPANY, "payments", { health: "healthy", images: [imageOf(dig(1))] });
    const mine = bodyOf(await h.routes.route(get(PATH), h.callerOf(FAKE_COMPANY)));
    const theirs = bodyOf(await h.routes.route(get(PATH), h.callerOf(OTHER)));
    expect(mine["health"]).toBe("healthy");
    expect(theirs).toEqual({ health: "never_proved", canReset: false, enabled: true, canChangeSetting: false });
    // and the reverse: another company's row never shows in mine
    await h.rows(OTHER, "billing", { health: "needs_repair" });
    expect(bodyOf(await h.routes.route(get("/v1/app/projects/billing/environment-image"), h.callerOf(FAKE_COMPANY)))["health"]).toBe("never_proved");
  });

  it("a project the person may not read answers exactly like a missing one, and nothing of it is read", async () => {
    const h = await setup();
    await h.rows(FAKE_COMPANY, "payments", { health: "healthy" });
    const caller = h.callerOf(FAKE_COMPANY);
    h.allowed.delete("payments");
    const spy = vi.spyOn(h.world.store, "get");
    const hidden = await h.routes.route(get(PATH), caller);
    h.allowed.add("ghost");
    const missing = await h.routes.route(get("/v1/app/projects/nothere/environment-image"), caller);
    expect(hidden?.statusCode).toBe(404);
    expect(hidden).toEqual(missing);
    expect(bodyOf(hidden).error?.message).toBe("project not found");
    const failing = createCoreDevRoutes({ app: h.app, companyOf: h.companyOf, wiring: () => ({ origin: () => "x", canReadProject: async () => { throw new Error("grant table down"); }, savedEnv: { enabled: true } }) });
    expect(await failing.route(get(PATH), caller)).toEqual(missing);
    expect(spy).not.toHaveBeenCalled();
    // the switch being off does not let an unreadable project be told apart either
    const off = await setup(false);
    off.allowed.delete("payments");
    expect(await off.routes.route(get(PATH), off.callerOf(FAKE_COMPANY))).toEqual(missing);
  });

  it("a row that does not read back is a fixed outage answer, never an empty panel", async () => {
    const h = await setup();
    await h.world.store.put({ item: { pk: `ORG#${FAKE_COMPANY}`, sk: "SAVED_ENV#payments", entityType: "SAVED_ENV", garbage: true } });
    const answer = await h.routes.route(get(PATH), h.callerOf(FAKE_COMPANY));
    expect(answer?.statusCode).toBe(503);
    expect(bodyOf(answer).error?.message).toBe("Saved project images could not be read.");
  });

  it("is not served without the access check or the wiring, refuses a script token and a caller with no membership, and leaves other methods to the old broker", async () => {
    const h = await setup();
    const caller = h.callerOf(FAKE_COMPANY);
    for (const wiring of [{ origin: () => "x", savedEnv: { enabled: true } }, { origin: () => "x", canReadProject: async () => true }]) {
      const routes = createCoreDevRoutes({ app: h.app, companyOf: h.companyOf, wiring: () => wiring });
      expect(bodyOf(await routes.route(get(PATH), caller)).error?.message).toBe(NOT_ON_THE_CORE_YET);
    }
    const token = await h.routes.route(get(PATH), { ...caller, scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } });
    expect(token?.statusCode).toBe(403);
    expect(bodyOf(token).error?.message).toBe(NOT_FOR_SCRIPT_TOKENS);
    const stranger: DeployedCaller = { principal: localOwnerPrincipal({ companyId: FAKE_COMPANY, personId: "nobody" }), client: "cli" };
    expect((await h.routes.route(get(PATH), stranger))?.statusCode).toBe(401);
    for (const method of ["POST", "PUT", "DELETE"]) expect(await h.routes.route({ ...get(PATH), method }, caller), method).toBeUndefined();
    expect(await h.routes.route(get(`${PATH}/setting`), caller)).toBeUndefined();
  });
});

describe("the hosted wiring", () => {
  it("core-engine-root wires the read from the install's saved-environments switch (hosted has no registry, so it stays off until that switch is on)", () => {
    const source = readFileSync(new URL("../../packages/broker/src/aws/core-engine-root.ts", import.meta.url), "utf8");
    expect(source).toContain("savedEnv: { enabled: savedEnvEnabled(env) }");
  });
});
