// The start box's suggestion through the deployed API's guards (lead 4 J3): full access only (a script token is refused before anything is read), a caller with no company is refused, the member company's own role
// is read, and an unwired deployment says "not on the core yet".
import { describe, expect, it, vi } from "vitest";
import { START_SUGGEST_WORDS, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { NOT_FOR_SCRIPT_TOKENS, NOT_ON_THE_CORE_YET, createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { FAKE_COMPANY, createFakeWorld } from "../support/core-host-fakes.js";

const PATH = "/v1/app/projects/alpha/code/suggest";
const suggestBody = () => ({ requestId: "request-0001", text: "Fix the typo in the README title" });

describe("the suggest route through the deployed API's guards", () => {
  const PROJECT: ProjectDefinition = { name: "alpha", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "web", url: "https://github.com/example/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "host-app" }] };
  const WIRED: CoreDevWiring = { origin: () => "https://api.example", scriptTokens: { enabled: () => true } };
  async function over() {
    const fake = createFakeWorld();
    for (const company of [FAKE_COMPANY]) {
      await fake.store.put({ item: { ...projectRevisionKey(company, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
      await fake.store.put({ item: { ...orgProjectCatalogKey(company, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
    }
    const services = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
    const app = createCoreHostApp({
      env: { ROVARA_CORE_ENGINE: "on" }, modules: fake.modules, context: () => fake.context(), nowMs: () => fake.clock.now,
      runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(fake.clock.now), log: () => undefined, services, ciReporting: { honest: true as const, ciMode: () => "their_ci_fix" as const } }),
    });
    const member = new Map<string, CompanyMembership>();
    const companyOf = vi.fn(async (caller: DeployedCaller) => member.get(caller.principal.personId + caller.principal.companyId));
    const caller = { principal: localOwnerPrincipal({ companyId: FAKE_COMPANY }), client: "cli" } as DeployedCaller;
    member.set(caller.principal.personId + FAKE_COMPANY, { companyId: FAKE_COMPANY, role: "owner" });
    return { app, companyOf, caller };
  }
  const post = (path: string, body: unknown = {}) => ({ method: "POST", path, headers: {}, body: JSON.stringify(body) });

  it("serves the member company's own suggestion, refuses a script token (403) and a caller with no company (401) before anything is read, and says 'not on the core yet' when unwired", async () => {
    const { app, companyOf, caller } = await over();
    const standing = vi.fn(async () => ({ access: "view" as const }));
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, startSuggest: { standing } }) });
    const served = await routes.route(post(PATH, suggestBody()), caller);
    expect(served?.statusCode).toBe(200);
    expect(JSON.parse(served!.body)).toEqual({ kind: "unknown", classifier: "unavailable", pick: "answer" });
    expect(standing).toHaveBeenCalledWith(caller.principal.personId, FAKE_COMPANY, "alpha");
    standing.mockClear();
    const token = await routes.route(post(PATH, suggestBody()), { ...caller, scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } });
    expect(token?.statusCode).toBe(403);
    expect((JSON.parse(token!.body) as { error: { message: string } }).error.message).toBe(NOT_FOR_SCRIPT_TOKENS);
    expect((await routes.route(post(PATH, suggestBody()), { ...caller, principal: { ...caller.principal, personId: "no-membership" } }))?.statusCode).toBe(401);
    expect(standing).not.toHaveBeenCalled();
    const none = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, startSuggest: { standing: async () => ({ access: "none" as const }) } }) });
    const refused = await none.route(post(PATH, suggestBody()), caller);
    expect(refused?.statusCode).toBe(404);
    expect(JSON.parse(refused!.body)).toEqual({ error: { code: "NOT_FOUND", message: START_SUGGEST_WORDS.projectNotFound } });
    const unwired = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
    expect((JSON.parse((await unwired.route(post(PATH, suggestBody()), caller))!.body) as { error: { message: string } }).error.message).toBe(NOT_ON_THE_CORE_YET);
    expect(await routes.route({ method: "GET", path: PATH, headers: {}, body: "" }, caller)).toBeUndefined();
  });
});
