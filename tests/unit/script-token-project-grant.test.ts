// PROJECT-GRANT-RECHECK: a script token's project list is what the token MAY name, never proof its creator still holds the project. At every use the creator's project is read live
// (`ScriptTokenAuthDependencies.projectGrant`): a project the creator lost is refused for that project only, and the token stays valid for the rest.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scriptTokenKey, type AuditSink, type OrgId, type Principal } from "@agentx/contracts";
import { authenticateScriptToken } from "../../packages/broker/src/core/script-tokens/authenticate.js";
import { createScriptToken } from "../../packages/broker/src/core/script-tokens/store.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";

const COMPANY = "org_grantrecheck00000001" as OrgId;
const PERSON = "person-leaver";
const principalOf = (role: "member" | "admin" | "owner"): Principal => ({ companyId: COMPANY, personId: PERSON, displayName: "Leaver", roles: [role], provider: "hosted" });
const TASK = "11111111-2222-4333-8444-555555555555";

async function world(grants: Set<string> | ((project: string) => boolean), role: "member" | "admin" = "member") {
  const store = new MemoryDocumentStore();
  const audit = { stage: () => [], record: async () => undefined } as unknown as AuditSink;
  let clock = Date.parse("2026-11-25T12:00:00.000Z");
  const now = () => clock;
  const principal = principalOf(role);
  const made = await createScriptToken({ store, audit, now },
    { developerId: developerIdOf(principal), personId: PERSON, orgId: COMPANY, orgRole: "admin" },
    { requestId: randomUUID(), name: "tool", projects: ["payments", "billing"], permissions: ["read", "start", "lessons"] }, async () => undefined);
  // The token was made while an admin; the creator's role now (and the role the record keeps) is the one under test.
  await store.update({ key: scriptTokenKey(COMPANY, made.token.tokenId), ops: [{ op: "set", path: ["createdRole"], value: role }] });
  for (const project of ["payments", "billing"]) await store.put({ item: { ...taskKey(project === "payments" ? TASK : "99999999-2222-4333-8444-555555555555"), orgId: COMPANY, companyId: COMPANY, project, developerId: developerIdOf(principal) } });
  const asked: string[] = [];
  const deps = {
    store, audit, now, companyId: COMPANY, enabled: () => true,
    identity: { getPrincipal: async () => principal },
    projectGrant: async (_person: string, project: string) => { asked.push(project); return typeof grants === "function" ? grants(project) : grants.has(project); },
  };
  const call = (method: string, path: string, body?: unknown) => authenticateScriptToken(deps, { method, path, headers: { authorization: `Bearer ${made.secret}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { call, asked, tick: () => { clock += 1_000; } };
}

describe("a script token whose creator lost a project", () => {
  it("is refused for the project the creator lost (list, start, task read, lessons) and works for the project the creator still holds", async () => {
    const w = await world(new Set(["billing"]));
    // payments is gone for the creator: every route naming it is refused, with the fixed words.
    await expect(w.call("GET", "/v1/dev/tasks?project=payments")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(w.call("POST", "/v1/dev/tasks", { project: "payments", instructions: "x", requestId: randomUUID() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(w.call("POST", "/v1/dev/projects/payments/lessons", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(w.call("GET", `/v1/dev/tasks/${TASK}`)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // billing is still theirs: the same token is served there (the list names the one project; a task read of a billing task answers).
    expect((await w.call("GET", "/v1/dev/tasks?project=billing")).listProject).toBe("billing");
    expect((await w.call("GET", "/v1/dev/tasks/99999999-2222-4333-8444-555555555555")).caller.scriptToken.projects).toEqual(["billing", "payments"]);
    w.tick();
    // The token was never revoked by the refusals above: it still works for billing a moment later.
    expect((await w.call("GET", "/v1/dev/tasks?project=billing")).listProject).toBe("billing");
  });

  it("reads the grant at every use: a project granted back works again at once, and one dropped stops at once", async () => {
    const grants = new Set(["payments", "billing"]);
    const w = await world(grants);
    expect((await w.call("GET", "/v1/dev/tasks?project=payments")).listProject).toBe("payments");
    grants.delete("payments");
    await expect(w.call("GET", "/v1/dev/tasks?project=payments")).rejects.toMatchObject({ code: "FORBIDDEN" });
    grants.add("payments");
    expect((await w.call("GET", "/v1/dev/tasks?project=payments")).listProject).toBe("payments");
  });

  it("a grant read that fails refuses (never serves on a guess)", async () => {
    const w = await world(() => { throw new Error("grant store unavailable"); });
    await expect(w.call("GET", "/v1/dev/tasks?project=payments")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
