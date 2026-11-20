import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type AuditSink, type WikiPageWrite } from "@agentx/contracts";
import { createScriptToken } from "../../packages/broker/src/core/script-tokens/store.js";
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

});
