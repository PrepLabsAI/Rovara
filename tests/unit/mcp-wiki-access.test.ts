import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CreateScriptTokenBodySchema, scriptTokenKey, type AuditSink, type WikiPageWrite } from "@agentx/contracts";
import { createScriptToken, readScriptToken } from "../../packages/broker/src/core/script-tokens/store.js";
import { authenticateScriptToken, scriptTokenRoute } from "../../packages/broker/src/core/script-tokens/authenticate.js";
import { createWikiStore } from "../../packages/broker/src/core/wiki/store.js";
import { createCoreDevRoutes } from "../../packages/broker/src/core-host/dev-routes.js";
import { createCoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { createFakeWorld, FAKE_COMPANY } from "../support/core-host-fakes.js";

const OTHER = "org_corehost00000000000b";
const paths = ["/v1/app/projects/alpha/wiki", "/v1/app/projects/alpha/wiki/pages/overview"] as const;
const page = (tag: string): WikiPageWrite => ({ pageId: "overview", kind: "overview", title: tag, summary: tag, order: 0, repos: [{ repo: "web", commit: "a".repeat(40) }], blocks: [{ kind: "heading", blockId: "head-1", level: 2, text: tag }], claims: [], buildId: "build-0001" });
async function world() {
  const w = createFakeWorld();
  const principal = localOwnerPrincipal({ companyId: FAKE_COMPANY });
  const audit: AuditSink = { stage: (event) => [{ kind: "put", item: { pk: `ORG#${event.companyId}#AUDIT_OUTBOX`, sk: `EVENT#${event.eventId}` } }], record: async () => undefined };
  const deps = { store: w.store, audit, now: () => w.clock.now };
  const token = async (permissions: string[] = ["wiki"], projects = ["alpha"], companyId: string = FAKE_COMPANY) => {
    const p = localOwnerPrincipal({ companyId });
    return await createScriptToken(deps, { orgId: companyId, developerId: developerIdOf(p), personId: p.personId, orgRole: "owner" }, { requestId: randomUUID(), name: "wiki reader", projects, permissions }, async () => undefined);
  };
  const app = createCoreHostApp({ env: { ROVARA_CORE_ENGINE: "on" }, modules: w.modules, context: () => w.context(), nowMs: () => w.clock.now, runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(w.clock.now), log: () => undefined, services: () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } }), ciReporting: { honest: true, ciMode: () => "their_ci_fix" } }) });
  let standing: "view" | "none" = "view";
  const calls: string[] = [];
  const routes = createCoreDevRoutes({ app, companyOf: async (c) => ({ companyId: c.principal.companyId, role: "owner" }), wiring: () => ({ origin: () => "https://api.example", scriptTokens: { enabled: () => true }, wiki: { standing: async (_person, company, project) => { calls.push(`${company}/${project}`); return { access: standing }; }, projectRepositories: async () => ["web"] } }) });
  for (const [company, project, tag] of [[FAKE_COMPANY, "alpha", "A-alpha"], [FAKE_COMPANY, "beta", "A-beta"], [OTHER, "alpha", "B-alpha"]]) await createWikiStore({ store: w.store, companyId: company!, now: deps.now }).writePage(project!, page(tag!));
  const read = async (tokenId: string, path: string, companyId: string = FAKE_COMPANY) => routes.route({ method: "GET", path, headers: {} }, { principal: localOwnerPrincipal({ companyId }), scriptToken: { tokenId } });
  return { ...w, deps, principal, token, read, calls, denyRole: () => { standing = "none"; } };
}

describe("MCP wiki script-token permission", () => {
  it("accepts and persists wiki independently, with no implicit read/start/lessons", async () => {
    expect(CreateScriptTokenBodySchema.safeParse({ requestId: randomUUID(), name: "wiki", projects: ["alpha"], permissions: ["wiki"] }).success).toBe(true);
    const w = await world();
    const made = await w.token();
    expect(made.token.permissions).toEqual(["wiki"]);
    expect((await readScriptToken(w.deps, FAKE_COMPANY, made.token.tokenId))?.permissions).toEqual(["wiki"]);
    for (const path of paths) expect(scriptTokenRoute("GET", path)).toEqual({ permission: "wiki", project: "path", name: "alpha" });
    for (const invalid of ["Alpha", "a".repeat(64), "alpha.wiki"]) expect(scriptTokenRoute("GET", `/v1/app/projects/${invalid}/wiki`)).toBeUndefined();
    for (const invalid of ["Overview", "a".repeat(121), "overview.md"]) expect(scriptTokenRoute("GET", `/v1/app/projects/alpha/wiki/pages/${invalid}`)).toBeUndefined();
    for (const [method, path] of [["POST", paths[0]], ["GET", `${paths[1]}/sources`], ["POST", "/v1/app/projects/alpha/wiki/ask"], ["GET", "/v1/app/wiki"], ["GET", "/v1/app/projects/alpha/wiki/pages/overview/extra"]]) expect(scriptTokenRoute(method!, path!)).toBeUndefined();
  });

  it("authentication requires wiki and a named project, never read or lessons", async () => {
    const w = await world();
    const auth = (secret: string, path: string) => authenticateScriptToken({ ...w.deps, companyId: FAKE_COMPANY, identity: { getPrincipal: async () => w.principal }, enabled: () => true }, { method: "GET", path, headers: { authorization: `Bearer ${secret}` } });
    const wiki = await w.token();
    for (const path of paths) expect((await auth(wiki.secret, path)).caller.scriptToken.permissions).toEqual(["wiki"]);
    for (const permission of ["read", "start", "lessons"]) {
      const made = await w.token([permission]);
      for (const path of paths) await expect(auth(made.secret, path)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    for (const path of [paths[0].replace("alpha", "beta"), `${paths[1]}/sources`, "/v1/dev/tasks?project=alpha", "/v1/app/projects/alpha/wiki/../wiki"]) await expect(auth(wiki.secret, path)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const other = await w.token(["wiki"], ["alpha"], OTHER);
    await expect(auth(other.secret, paths[0])).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("hosted list/read stay inside the token's company and project and still check the live role", async () => {
    const w = await world();
    const a = await w.token();
    const b = await w.token(["wiki"], ["alpha"], OTHER);
    for (const path of paths) {
      const own = await w.read(a.token.tokenId, path);
      expect(own?.statusCode).toBe(200);
      expect(own?.body).toContain("A-alpha");
      expect(own?.body).not.toMatch(/A-beta|B-alpha/u);
      expect((await w.read(a.token.tokenId, path.replace("alpha", "beta")))?.statusCode).toBe(403);
      expect((await w.read(a.token.tokenId, path, OTHER))?.statusCode).toBe(403);
      const other = await w.read(b.token.tokenId, path, OTHER);
      expect(other?.statusCode).toBe(200);
      expect(other?.body).toContain("B-alpha");
      expect(other?.body).not.toMatch(/A-alpha|A-beta/u);
    }
    w.denyRole();
    expect((await w.read(a.token.tokenId, paths[0]))?.statusCode).toBe(404);
  });

  it("hosted Cloud records without personId still require the matching developer", async () => {
    const w = await world();
    const made = await w.token();
    const key = scriptTokenKey(FAKE_COMPANY, made.token.tokenId);
    const original = (await w.store.get(key))!;
    const cloudRecord = { ...original };
    delete cloudRecord.personId;
    await w.store.put({ item: cloudRecord });
    for (const path of paths) expect((await w.read(made.token.tokenId, path))?.statusCode).toBe(200);
    await w.store.put({ item: { ...cloudRecord, developerId: developerIdOf(localOwnerPrincipal({ companyId: FAKE_COMPANY, personId: "another-person" })) } });
    for (const path of paths) expect((await w.read(made.token.tokenId, path))?.statusCode).toBe(403);
    expect(w.calls).toHaveLength(2);
  });

  it("hosted tokens missing wiki, expired, revoked or held by someone else never reach wiki data", async () => {
    const w = await world();
    for (const permission of ["read", "lessons"]) {
      const made = await w.token([permission]);
      for (const path of paths) expect((await w.read(made.token.tokenId, path))?.statusCode).toBe(403);
    }
    const made = await w.token();
    expect((await w.read(made.token.tokenId, `${paths[1]}/sources`))?.statusCode).toBe(403);
    expect(w.calls).toEqual([]);
    const key = scriptTokenKey(FAKE_COMPANY, made.token.tokenId);
    const original = (await w.store.get(key))!;
    for (const changed of [{ revokedAt: new Date(w.clock.now).toISOString() }, { expiresAt: new Date(w.clock.now - 1).toISOString() }, { personId: "someone-else" }, { createdRole: "member" }]) {
      await w.store.put({ item: { ...original, ...changed } });
      expect((await w.read(made.token.tokenId, paths[0]))?.statusCode).toBe(403);
    }
    expect(w.calls).toEqual([]);
  });
});
