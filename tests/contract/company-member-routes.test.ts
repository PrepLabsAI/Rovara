// Lane W part 4: the company administrator's routes on the deployed developer API, through T3b's member helper and the real identity-side operator and store.
// Two companies; full access only; a live admin or owner; only an owner changes or removes an owner; no step-up (DEC 254zzz73); fixed refusals that echo nothing.
// The hand-over itself (DEC 254zzz84 (5)) is company-member-handover.test.ts.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentXError } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { companyMemberActionsThroughLambda } from "../../packages/broker/src/aws/company-member-forwarding.js";
import { routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { LIST_QUERY, MEMBERS_UNAVAILABLE, MEMBER_NOT_FOUND, OWNER_ONLY, OWN_MEMBERSHIP, REMOVAL_BODY, ROLE_BODY, TOO_MUCH_WORK } from "../../packages/broker/src/aws/company-member-routes.js";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { companyOperator } from "../../packages/broker/src/developer/company-operator.js";
import { MEMBER_ONLY_OWNER, MEMBER_REVOKED } from "../../packages/broker/src/developer/company-member-contract.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { companyProjectRow } from "../support/company-layout-projects.js";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const TIME = "2026-11-01T09:00:00.000Z";
const A = COMPANY_A.orgId, B = COMPANY_B.orgId;
const OWNER = "a".repeat(64), ADMIN = "b".repeat(64), MEMBER = "c".repeat(64), OWNER2 = "d".repeat(64), OTHER = "e".repeat(64), MISSING = "f".repeat(64);
const CANARY = "leak-canary-47";
const SESSIONS: Record<string, string> = { [OWNER]: "s-owner", [ADMIN]: "s-admin", [MEMBER]: "s-member", [OWNER2]: "s-owner2", [OTHER]: "s-other" };
const MEMBERS = "/v1/dev/company/members";
const member = (id: string, action: "removal-preview" | "removal" | "role") => `${MEMBERS}/${id}/${action}`;
/** DEC 254zzz84 (5): a removal sends its request id and the role the remover saw; with no successor named, the remover takes over. */
const ROLES: Record<string, string> = { [OWNER]: "owner", [ADMIN]: "admin", [MEMBER]: "member", [OWNER2]: "owner", [OTHER]: "admin" };
const nothingMoved = { agents: 0, chains: 0, projects: 0, tasks: 0, tasksLeft: 0 };

function world(options: { fullAccess?: boolean; helper?: boolean; webApp?: boolean } = {}) {
  const db = new FakeDynamoDb({ seed: 7 });
  const claims: Record<string, unknown> = { azp: "web-app", env: "test", sub: ADMIN, sid: "s-admin", amr: "slack" };
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false, installLevel: true, secretHash: "f".repeat(64), ...(options.fullAccess === false ? { scopes: ["tasks:read"] } : { fullAccess: true }),
    // Owner DEC 254zzz91: the operator-marked Rovara website client by default (role changes and removals are its acts alone).
    ...(options.webApp === false || options.fullAccess === false ? {} : { webApp: true }), createdAt: TIME, updatedAt: TIME, updatedBy: "admin" });
  const join = (id: string, companyId: string, role: "owner" | "admin" | "member", extra: Record<string, unknown> = {}) => {
    db.set({ ...membershipKey(id), entityType: "COMPANY_MEMBERSHIP", personId: id, companyId, role, joinedAt: TIME, ...extra });
    db.set({ pk: `ORG#${companyId}#MEMBERS`, sk: `MEMBER#${id}`, entityType: "COMPANY_MEMBER_VIEW", personId: id, companyId, role, joinedAt: TIME, ...extra });
  };
  for (const [id, name] of [[OWNER, "Olive"], [ADMIN, "Ada"], [MEMBER, "Max"], [OWNER2, "Odo"], [OTHER, "Bea"]] as const) {
    db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "slack", displayName: name, email: `${name.toLowerCase()}@example.test`, revoked: false });
    db.set({ pk: `SESSION#${SESSIONS[id]}`, sk: "META", sessionId: SESSIONS[id], developerId: id, amr: "slack", clientId: "web-app", startedAt: new Date(NOW - 60_000).toISOString(), endsAt: NOW / 1000 + 3600 });
  }
  join(OWNER, A, "owner"); join(ADMIN, A, "admin"); join(MEMBER, A, "member"); join(OTHER, B, "admin");
  const store = new CompanySignInStore({ documentClient: db, tableName: "SignIn", now: () => NOW });
  const forwarded: Array<Record<string, unknown>> = [];
  const invoke = async (payload: Uint8Array) => {
    const event = JSON.parse(Buffer.from(payload).toString()) as Record<string, unknown>; forwarded.push(event);
    return { Payload: Buffer.from(JSON.stringify(await companyOperator({ store, now: () => NOW, log: () => {} }, event))) };
  };
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const deps: DeveloperRouteDependencies = {
    documentClient: db, tableName: "State", now: () => NOW, companies: companyMembershipFromDynamo(db, "SignIn"),
    developer: {
      issuer: "https://signin.example.test", env: "test", methods: { slack: true, oidc: true }, signInTableName: "SignIn",
      verifyAccessToken: async () => claims, channelMembers: async (request) => ({ ok: true, memberOf: request.channelIds }),
      ...(options.helper === false ? {} : { companyMembers: companyMemberActionsThroughLambda({ documentClient: db, tableName: "SignIn", invoke }) }),
    },
  };
  const jwt = () => { const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url"); return `Bearer ${part({ alg: "none" })}.${part(claims)}.sig`; };
  const call = async (method: string, path: string, body?: unknown) => {
    const target = /\/members\/([a-f0-9]{64})\/removal$/u.exec(path)?.[1];
    const sent = body ?? (method === "POST" && target !== undefined ? { requestId: randomUUID(), expectedRole: ROLES[target] ?? "member" } : undefined);
    const request = { method, path, headers: { authorization: jwt() }, requestId: "r", ...(sent === undefined ? {} : { body: typeof sent === "string" ? sent : JSON.stringify(sent) }) };
    try { return { status: 200, body: await routeDeveloperRequest(deps, request, new URL(path, "https://broker.example.test")) as Record<string, unknown> }; } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { status: error.statusCode, body: { error: { code: error.code, message: error.message.slice(error.code.length + 2) } } as Record<string, unknown> };
    }
  };
  const as = (id: string) => { claims.sub = id; claims.sid = SESSIONS[id]; };
  const role = (id: string) => (db.get(membershipKey(id).pk, "COMPANY") as { role?: string } | undefined)?.role;
  const revoked = (id: string) => (db.get(membershipKey(id).pk, "COMPANY") as { revokedAt?: string } | undefined)?.revokedAt !== undefined;
  return { db, claims, deps, call, as, join, forwarded, role, revoked };
}
const refusal = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });

describe("the member list", () => {

  it("pages with the opaque cursor it gave; another company's cursor and unknown query keys are refused without echo", async () => {
    const h = world();
    const first = await h.call("GET", `${MEMBERS}?limit=1`);
    expect((first.body["members"] as unknown[]).length).toBe(1);
    expect(first.body["more"]).toBe(true);
    const second = await h.call("GET", `${MEMBERS}?limit=2&cursor=${first.body["cursor"] as string}`);
    expect((second.body["members"] as unknown[]).length).toBe(2);
    h.as(OTHER);
    expect(await h.call("GET", `${MEMBERS}?cursor=${first.body["cursor"] as string}`)).toEqual(refusal(400, "CONFIG_INVALID", LIST_QUERY));
    expect(h.forwarded.filter((event) => event["companyId"] === B)).toEqual([]);
    h.as(ADMIN);
    for (const query of [`?limit=0`, `?limit=101`, `?limit=${CANARY}`, `?${CANARY}=1`, `?limit=1&limit=2`, `?cursor=${"x".repeat(513)}`]) {
      const answer = await h.call("GET", `${MEMBERS}${query}`);
      expect(answer).toEqual(refusal(400, "CONFIG_INVALID", LIST_QUERY));
    }
  });
});

describe("company isolation", () => {
  it("another company's admin gets the same answer for A's people as for nobody, and changes nothing", async () => {
    const h = world(); h.as(OTHER);
    for (const [method, action, body] of [["GET", "removal-preview", undefined], ["POST", "removal", {}], ["PUT", "role", { role: "admin" }]] as const) {
      const foreign = await h.call(method, member(MEMBER, action), body);
      expect(foreign).toEqual(refusal(404, "NOT_FOUND", MEMBER_NOT_FOUND));
      expect(await h.call(method, member(MISSING, action), body)).toEqual(foreign);
      expect(await h.call(method, member(CANARY, action), body)).toEqual(foreign);
    }
    expect(h.role(MEMBER)).toBe("member"); expect(h.revoked(MEMBER)).toBe(false);
    expect(h.forwarded).toEqual([]);
  });

  it("a membership that moved to another company after the company was resolved refuses the sign-in", async () => {
    const h = world(); h.deps.companies = { companyOf: async () => B };
    expect((await h.call("GET", MEMBERS)).status).toBe(401);
    expect(h.forwarded).toEqual([]);
  });

  it("a member list naming another company's person is refused whole, even if the helper let it through", async () => {
    const h = world();
    const row = { entityType: "COMPANY_MEMBERSHIP" as const, personId: OTHER, companyId: B, role: "admin" as const, joinedAt: TIME };
    h.deps.developer.companyMembers = { list: async () => ({ ok: true as const, members: [row], more: false }), revoke: async () => ({ ok: true as const }), setRole: async () => ({ ok: true as const }) };
    expect(await h.call("GET", MEMBERS)).toEqual(refusal(503, "RUNTIME_UNAVAILABLE", MEMBERS_UNAVAILABLE));
  });

});

describe("who may use the routes", () => {

  it("a sign-in client without full access is refused, whatever scope it holds", async () => {
    const h = world({ fullAccess: false }); h.claims.scope = "tasks:read";
    for (const [method, path] of [["GET", MEMBERS], ["GET", member(MEMBER, "removal-preview")], ["POST", member(MEMBER, "removal")], ["PUT", member(MEMBER, "role")]] as const) {
      expect((await h.call(method, path, method === "PUT" ? { role: "admin" } : undefined)).status).toBe(403);
    }
    expect(h.forwarded).toEqual([]);
  });

  it("a deployment without the member helper does not know the routes and authenticates nobody", async () => {
    const h = world({ helper: false });
    const verify = vi.spyOn(h.deps.developer, "verifyAccessToken");
    expect(await h.call("GET", MEMBERS)).toEqual(refusal(404, "NOT_FOUND", "route not found"));
    expect(await h.call("POST", member(MEMBER, "removal"))).toEqual(refusal(404, "NOT_FOUND", "route not found"));
    expect(verify).not.toHaveBeenCalled();
    delete h.deps.companies;
    h.deps.developer.companyMembers = companyMemberActionsThroughLambda({ documentClient: h.db, tableName: "SignIn", invoke: async () => { throw new Error("must not run"); } });
    expect(await h.call("GET", MEMBERS)).toEqual(refusal(404, "NOT_FOUND", "route not found"));
  });

  it("unknown methods and paths under the routes are not found", async () => {
    const h = world();
    for (const [method, path] of [["DELETE", MEMBERS], ["POST", MEMBERS], ["GET", member(MEMBER, "removal")], ["GET", `${MEMBERS}/${MEMBER}/other`]] as const) {
      expect((await h.call(method, path)).status).toBe(404);
    }
    expect(h.forwarded).toEqual([]);
  });
});

describe("removal and role change", () => {

  it("an admin promotes a member to admin with no step-up, and T3b's removed-member refusal keeps its fixed words", async () => {
    const h = world();
    expect(await h.call("PUT", member(MEMBER, "role"), { role: "admin" })).toEqual({ status: 200, body: { ok: true } });
    expect(h.role(MEMBER)).toBe("admin");
    h.join(OWNER2, A, "member", { revokedAt: TIME });
    expect(await h.call("PUT", member(OWNER2, "role"), { role: "member" })).toEqual(refusal(409, "MEMBER_ALREADY_REMOVED", MEMBER_REVOKED));
  });

  it("refuses unknown fields, bad roles and non-JSON in fixed words that never echo the body", async () => {
    const h = world();
    for (const body of [{ role: CANARY }, { role: "admin", companyId: B }, { role: "member", createdBy: OWNER }, {}, CANARY, [CANARY]]) {
      const answer = await h.call("PUT", member(MEMBER, "role"), body);
      expect(answer).toEqual(refusal(400, "CONFIG_INVALID", ROLE_BODY));
    }
    for (const body of [{ personId: OTHER }, { companyId: B }, CANARY, {}, { requestId: CANARY, expectedRole: "member" }, { requestId: randomUUID(), expectedRole: CANARY },
      { requestId: randomUUID(), expectedRole: "member", successorId: CANARY }, { requestId: randomUUID(), expectedRole: "member", companyId: B }]) {
      const answer = await h.call("POST", member(MEMBER, "removal"), body);
      expect(answer).toEqual(refusal(400, "CONFIG_INVALID", REMOVAL_BODY));
      expect(JSON.stringify(answer)).not.toContain(CANARY);
    }
    expect(h.forwarded).toEqual([]);
  });
});

describe("only an owner changes or removes an owner (DEC 232e)", () => {
  it("an admin cannot remove, demote or create an owner; nothing is forwarded", async () => {
    const h = world();
    expect(await h.call("POST", member(OWNER, "removal"))).toEqual(refusal(403, "FORBIDDEN", OWNER_ONLY));
    expect(await h.call("PUT", member(OWNER, "role"), { role: "admin" })).toEqual(refusal(403, "FORBIDDEN", OWNER_ONLY));
    expect(await h.call("PUT", member(MEMBER, "role"), { role: "owner" })).toEqual(refusal(403, "FORBIDDEN", OWNER_ONLY));
    expect(h.role(OWNER)).toBe("owner"); expect(h.revoked(OWNER)).toBe(false); expect(h.role(MEMBER)).toBe("member");
    expect(h.forwarded).toEqual([]);
  });

  it("T3b's own owner-only refusal reaches the caller as 403 in its words: the target became an owner after the route read it", async () => {
    const h = world(); h.join(OWNER2, A, "member");
    const helper = h.deps.developer.companyMembers!;
    // An owner promotes the target between the route's read and the identity side's write; T3b's store refuses the admin inside its own check.
    h.deps.developer.companyMembers = { ...helper, revoke: async (caller, request) => { h.join(OWNER2, A, "owner"); return helper.revoke(caller, request); } };
    expect(await h.call("POST", member(OWNER2, "removal"), { requestId: randomUUID(), expectedRole: "member" })).toEqual(refusal(403, "FORBIDDEN", OWNER_ONLY));
    expect(h.revoked(OWNER2)).toBe(false); expect(h.role(OWNER2)).toBe("owner");
    expect(OWNER_ONLY).toBe(MEMBER_ONLY_OWNER);
  });

  it("the preview tells the caller whether they may remove the person; nobody previews their own removal", async () => {
    const h = world();
    expect((await h.call("GET", member(OWNER, "removal-preview"))).body["mayRemove"]).toBe(false);
    expect((await h.call("GET", member(MEMBER, "removal-preview"))).body["mayRemove"]).toBe(true);
    expect(await h.call("GET", member(ADMIN, "removal-preview"))).toEqual(refusal(403, "FORBIDDEN", OWN_MEMBERSHIP));
    h.as(OWNER);
    expect((await h.call("GET", member(ADMIN, "removal-preview"))).body["mayRemove"]).toBe(true);
  });
});

describe("the removal preview", () => {
  it("counts the person's open tasks in this company, those waiting on their decision, and their projects here", async () => {
    const h = world();
    const project = (name: string, companyId: string) => h.db.set(companyProjectRow(companyId, name, 1)); // DEC 254zzz80: a named company's project in its own partition
    // DEC 254zzz80: a named company's grants live in its own partition.
    const grant = (name: string, role: string, extra: Record<string, unknown> = {}) => h.db.set({ pk: `ORG#${A}#MEMBER#${MEMBER}`, sk: `PROJECT#${name}`, entityType: "MEMBERSHIP", projectName: name, role, ...extra });
    project("alpha", A); project("beta", A); project("gamma", B); project("delta", A); project("epsilon", A);
    grant("alpha", "administrator"); grant("beta", "developer"); grant("gamma", "administrator");
    // Neither a legacy grant row nor a row in the company's partition that names another company is one of its grants.
    h.db.set({ pk: `MEMBER#${MEMBER}`, sk: "PROJECT#delta", entityType: "MEMBERSHIP", projectName: "delta", role: "administrator", companyId: A });
    grant("epsilon", "developer", { companyId: B });
    const task = (id: string, extra: Record<string, unknown>, status = "RUNNING") => {
      h.db.set({ pk: `DEVTASK#${id}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: id, developerId: MEMBER, companyId: A, ...extra });
      h.db.set({ pk: `DEVELOPER#${MEMBER}`, sk: `TASK#${TIME}#${id}`, entityType: "DEVELOPER_TASK_INDEX", taskId: id, status });
    };
    task("t1", { workflow: { state: "WAITING", stage: "PLAN_REVIEW" } });
    task("t2", { workflow: { state: "RUNNING" } });
    task("t3", { companyId: B });
    task("t4", { closedAt: TIME });
    task("t5", {}, "CLOSED");
    task("t6", { developerId: OWNER });
    expect(await h.call("GET", member(MEMBER, "removal-preview"))).toEqual({ status: 200, body: {
      personId: MEMBER, role: "member", name: "Max", openTasks: 2, awaitingTheirDecision: 1, ownedProjects: ["alpha"], projectGrants: ["beta"], mayRemove: true,
      // Only alpha is handed over: gamma (a grant row in this company naming company B's project) and the legacy/foreign rows are not this company's projects (b21 hand-over fix).
      successor: { personId: ADMIN, name: "Ada" }, handOver: { ...nothingMoved, projects: 1 },
    } });
    expect(h.forwarded).toEqual([]);
  });

  it("refuses the whole preview past its bounds, never a partial one", async () => {
    const h = world();
    for (let i = 0; i < 201; i++) h.db.set({ pk: `DEVELOPER#${MEMBER}`, sk: `TASK#${TIME}#t${String(i).padStart(3, "0")}`, taskId: `t${i}`, status: "RUNNING" });
    expect(await h.call("GET", member(MEMBER, "removal-preview"))).toEqual(refusal(400, "CONFIG_INVALID", TOO_MUCH_WORK));
  });

  it("a removed member has no preview", async () => {
    const h = world(); h.join(MEMBER, A, "member", { revokedAt: TIME });
    expect(await h.call("GET", member(MEMBER, "removal-preview"))).toEqual(refusal(404, "NOT_FOUND", MEMBER_NOT_FOUND));
  });
});

describe("transport failures", () => {
  it("a member helper that cannot reach the identity side answers fixed words and leaks no cause", async () => {
    const h = world();
    h.deps.developer.companyMembers = companyMemberActionsThroughLambda({ documentClient: h.db, tableName: "SignIn", invoke: async () => { throw new Error(CANARY); } });
    for (const [method, path] of [["GET", MEMBERS], ["POST", member(MEMBER, "removal")]] as const) {
      const answer = await h.call(method, path);
      expect(answer).toEqual(refusal(503, "RUNTIME_UNAVAILABLE", MEMBERS_UNAVAILABLE));
    }
  });

});

