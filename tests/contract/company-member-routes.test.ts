// Lane W part 4: the company administrator's routes on the deployed developer API, through T3b's member helper and the real identity-side operator and store.
// Two companies; full access only; a live admin or owner; only an owner changes or removes an owner; no step-up (DEC 254zzz73); fixed refusals that echo nothing.
import { describe, expect, it, vi } from "vitest";
import { AgentXError } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { companyMemberActionsThroughLambda } from "../../packages/broker/src/aws/company-member-forwarding.js";
import { routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import {
  LIST_QUERY, MEMBERS_UNAVAILABLE, MEMBER_NOT_FOUND, NOT_FOUND, OWNER_ONLY, OWN_MEMBERSHIP, REMOVAL_BODY, ROLE_BODY, TOO_MUCH_WORK,
} from "../../packages/broker/src/aws/company-member-routes.js";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { companyOperator } from "../../packages/broker/src/developer/company-operator.js";
import { MEMBER_LAST_OWNER, MEMBER_ONLY_OWNER, MEMBER_REVOKED } from "../../packages/broker/src/developer/company-member-contract.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const TIME = "2026-11-01T09:00:00.000Z";
const A = COMPANY_A.orgId, B = COMPANY_B.orgId;
const OWNER = "a".repeat(64), ADMIN = "b".repeat(64), MEMBER = "c".repeat(64), OWNER2 = "d".repeat(64), OTHER = "e".repeat(64), MISSING = "f".repeat(64);
const CANARY = "leak-canary-47";
const SESSIONS: Record<string, string> = { [OWNER]: "s-owner", [ADMIN]: "s-admin", [MEMBER]: "s-member", [OWNER2]: "s-owner2", [OTHER]: "s-other" };
const MEMBERS = "/v1/dev/company/members";
const member = (id: string, action: "removal-preview" | "removal" | "role") => `${MEMBERS}/${id}/${action}`;

function world(options: { fullAccess?: boolean; helper?: boolean } = {}) {
  const db = new FakeDynamoDb({ seed: 7 });
  const claims: Record<string, unknown> = { azp: "web-app", env: "test", sub: ADMIN, sid: "s-admin", amr: "slack" };
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false, installLevel: true, secretHash: "f".repeat(64), ...(options.fullAccess === false ? { scopes: ["tasks:read"] } : { fullAccess: true }), createdAt: TIME, updatedAt: TIME, updatedBy: "admin" });
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
    const request = { method, path, headers: { authorization: jwt() }, requestId: "r", ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
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
  it("lists the caller's own company, with names and emails, never another company's people", async () => {
    const h = world();
    const answer = await h.call("GET", MEMBERS);
    expect(answer.status).toBe(200);
    const members = answer.body["members"] as Array<Record<string, unknown>>;
    expect(members.map((row) => [row["personId"], row["role"], row["name"], row["email"]]).sort()).toEqual([
      [OWNER, "owner", "Olive", "olive@example.test"], [ADMIN, "admin", "Ada", "ada@example.test"], [MEMBER, "member", "Max", "max@example.test"],
    ].sort());
    expect(answer.body["more"]).toBe(false);
    expect(JSON.stringify(answer.body)).not.toContain(OTHER);
    expect(JSON.stringify(answer.body)).not.toMatch(/"pk"|"sk"|COMPANY_MEMBER#|ORG#/);
    expect(h.forwarded).toEqual([{ kind: "company-member-list", companyId: A }]);
  });

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

  it("the company is the live membership, never a claim: a forged company claim changes nothing", async () => {
    const h = world(); h.as(OTHER); Object.assign(h.claims, { companyId: A, orgId: A, role: "owner" });
    expect((await h.call("GET", MEMBERS)).body["members"]).toEqual([expect.objectContaining({ personId: OTHER, companyId: B })]);
    expect(h.forwarded).toEqual([{ kind: "company-member-list", companyId: B }]);
  });

  it("a membership that moved to another company after the company was resolved refuses the sign-in", async () => {
    const h = world(); h.deps.companies = { companyOf: async () => B };
    expect((await h.call("GET", MEMBERS)).status).toBe(401);
    expect(h.forwarded).toEqual([]);
  });

  it("the route re-reads the membership itself: revoked, missing or unreadable refuses even when the company was resolved", async () => {
    for (const damage of ["revoked", "missing", "malformed"] as const) {
      const h = world(); h.deps.companies = { companyOf: async () => A };
      if (damage === "revoked") h.join(ADMIN, A, "admin", { revokedAt: TIME });
      if (damage === "missing") h.db.delete(membershipKey(ADMIN).pk, "COMPANY");
      if (damage === "malformed") h.db.set({ ...h.db.get(membershipKey(ADMIN).pk, "COMPANY")!, personId: OTHER });
      expect((await h.call("GET", member(MEMBER, "removal-preview"))).status, damage).toBe(401);
      expect(h.forwarded).toEqual([]);
    }
  });

  it("a person id that is not one of Code's ids is not found, even if a row answers to it", async () => {
    const h = world(); const legacy = "legacy-person";
    h.db.set({ ...membershipKey(legacy), entityType: "COMPANY_MEMBERSHIP", personId: legacy, companyId: A, role: "member", joinedAt: TIME });
    expect(await h.call("GET", member(legacy, "removal-preview"))).toEqual(refusal(404, "NOT_FOUND", MEMBER_NOT_FOUND));
  });

  it("a member list naming another company's person is refused whole, even if the helper let it through", async () => {
    const h = world();
    const row = { entityType: "COMPANY_MEMBERSHIP" as const, personId: OTHER, companyId: B, role: "admin" as const, joinedAt: TIME };
    h.deps.developer.companyMembers = { list: async () => ({ ok: true as const, members: [row], more: false }), revoke: async () => ({ ok: true as const }), setRole: async () => ({ ok: true as const }) };
    expect(await h.call("GET", MEMBERS)).toEqual(refusal(503, "RUNTIME_UNAVAILABLE", MEMBERS_UNAVAILABLE));
  });

  it("a membership that is revoked, missing or does not read refuses the sign-in, before anything is forwarded", async () => {
    for (const damage of ["revoked", "missing", "malformed"] as const) {
      const h = world();
      if (damage === "revoked") h.join(ADMIN, A, "admin", { revokedAt: TIME });
      if (damage === "missing") h.db.delete(membershipKey(ADMIN).pk, "COMPANY");
      if (damage === "malformed") h.db.set({ ...h.db.get(membershipKey(ADMIN).pk, "COMPANY")!, role: CANARY });
      const answer = await h.call("GET", MEMBERS);
      expect(answer.status, damage).toBe(401);
      expect(JSON.stringify(answer)).not.toContain(CANARY);
      expect(h.forwarded).toEqual([]);
    }
  });
});

describe("who may use the routes", () => {
  it("a plain member gets not found everywhere and nothing is forwarded", async () => {
    const h = world(); h.as(MEMBER);
    for (const [method, path, body] of [["GET", MEMBERS, undefined], ["GET", member(ADMIN, "removal-preview"), undefined], ["POST", member(ADMIN, "removal"), {}], ["PUT", member(ADMIN, "role"), { role: "member" }]] as const) {
      expect(await h.call(method, path, body)).toEqual(refusal(404, "NOT_FOUND", NOT_FOUND));
    }
    expect(h.forwarded).toEqual([]);
  });

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
    expect(await h.call("POST", member(MEMBER, "removal"), {})).toEqual(refusal(404, "NOT_FOUND", "route not found"));
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
  it("an admin removes a member with no step-up claim (DEC 254zzz73)", async () => {
    const h = world();
    expect(await h.call("POST", member(MEMBER, "removal"))).toEqual({ status: 200, body: { ok: true } });
    expect(h.revoked(MEMBER)).toBe(true);
    expect(h.forwarded).toEqual([{ kind: "company-member-revoke", companyId: A, personId: MEMBER, createdBy: ADMIN }]);
    expect(await h.call("POST", member(MEMBER, "removal"), {})).toEqual(refusal(409, "MEMBER_ALREADY_REMOVED", MEMBER_REVOKED));
  });

  it("an admin demotes another admin with no step-up (DEC 254zzz73: T3b has no step-up seam)", async () => {
    const h = world(); h.join(OWNER2, A, "admin");
    expect(await h.call("PUT", member(OWNER2, "role"), { role: "member" })).toEqual({ status: 200, body: { ok: true } });
    expect(h.role(OWNER2)).toBe("member");
    expect(h.forwarded).toEqual([{ kind: "company-member-role-set", companyId: A, personId: OWNER2, role: "member", createdBy: ADMIN }]);
  });

  it("an admin promotes a member to admin with no step-up, and T3b's removed-member refusal keeps its fixed words", async () => {
    const h = world();
    expect(await h.call("PUT", member(MEMBER, "role"), { role: "admin" })).toEqual({ status: 200, body: { ok: true } });
    expect(h.role(MEMBER)).toBe("admin");
    h.join(OWNER2, A, "member", { revokedAt: TIME });
    expect(await h.call("PUT", member(OWNER2, "role"), { role: "member" })).toEqual(refusal(409, "MEMBER_ALREADY_REMOVED", MEMBER_REVOKED));
  });

  it("nobody changes their own role or removes themselves here", async () => {
    const h = world(); h.as(OWNER);
    expect(await h.call("PUT", member(OWNER, "role"), { role: "member" })).toEqual(refusal(403, "FORBIDDEN", OWN_MEMBERSHIP));
    expect(await h.call("POST", member(OWNER, "removal"))).toEqual(refusal(403, "FORBIDDEN", OWN_MEMBERSHIP));
    expect(h.forwarded).toEqual([]);
  });

  it("refuses unknown fields, bad roles and non-JSON in fixed words that never echo the body", async () => {
    const h = world();
    for (const body of [{ role: CANARY }, { role: "admin", companyId: B }, { role: "member", createdBy: OWNER }, {}, CANARY, [CANARY]]) {
      const answer = await h.call("PUT", member(MEMBER, "role"), body);
      expect(answer).toEqual(refusal(400, "CONFIG_INVALID", ROLE_BODY));
    }
    for (const body of [{ personId: OTHER }, { companyId: B }, CANARY]) expect(await h.call("POST", member(MEMBER, "removal"), body)).toEqual(refusal(400, "CONFIG_INVALID", REMOVAL_BODY));
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

  it("an owner demotes and then removes another owner with no step-up (DEC 254zzz73)", async () => {
    const h = world(); h.join(OWNER2, A, "owner"); h.as(OWNER);
    expect(await h.call("PUT", member(OWNER2, "role"), { role: "member" })).toEqual({ status: 200, body: { ok: true } });
    expect(await h.call("POST", member(OWNER2, "removal"))).toEqual({ status: 200, body: { ok: true } });
    expect(h.role(OWNER2)).toBe("member"); expect(h.revoked(OWNER2)).toBe(true);
    expect(h.forwarded.map((event) => [event["kind"], event["createdBy"]])).toEqual([["company-member-role-set", OWNER], ["company-member-revoke", OWNER]]);
  });

  it("T3b's own owner-only refusal reaches the caller as 403 in its words: the target became an owner after the route read it", async () => {
    const h = world(); h.join(OWNER2, A, "member");
    const helper = h.deps.developer.companyMembers!;
    // An owner promotes the target between the route's read and the identity side's write; T3b's store refuses the admin inside its own check.
    h.deps.developer.companyMembers = { ...helper, revoke: async (caller, request) => { h.join(OWNER2, A, "owner"); return helper.revoke(caller, request); } };
    expect(await h.call("POST", member(OWNER2, "removal"))).toEqual(refusal(403, "FORBIDDEN", OWNER_ONLY));
    expect(h.revoked(OWNER2)).toBe(false); expect(h.role(OWNER2)).toBe("owner");
    expect(OWNER_ONLY).toBe(MEMBER_ONLY_OWNER);
  });

  it("the preview tells the caller whether they may remove the person", async () => {
    const h = world();
    expect((await h.call("GET", member(OWNER, "removal-preview"))).body["mayRemove"]).toBe(false);
    expect((await h.call("GET", member(MEMBER, "removal-preview"))).body["mayRemove"]).toBe(true);
    expect((await h.call("GET", member(ADMIN, "removal-preview"))).body["mayRemove"]).toBe(false);
    h.as(OWNER);
    expect((await h.call("GET", member(ADMIN, "removal-preview"))).body["mayRemove"]).toBe(true);
  });
});

describe("no step-up (DEC 254zzz73)", () => {
  it.each([
    ["no step-up claim", () => undefined],
    ["a leftover step-up claim of any age or method", (h: ReturnType<typeof world>) => { h.claims.step_up_at = 1; h.claims.step_up_amr = "slack"; }],
  ])("an admin removes a member and changes an admin's role with %s", async (_name, setUp) => {
    const h = world(); setUp(h);
    expect(await h.call("POST", member(MEMBER, "removal"))).toEqual({ status: 200, body: { ok: true } });
    h.join(OWNER2, A, "admin");
    expect(await h.call("PUT", member(OWNER2, "role"), { role: "member" })).toEqual({ status: 200, body: { ok: true } });
    expect(h.revoked(MEMBER)).toBe(true); expect(h.role(OWNER2)).toBe("member");
  });

  it("the role and company rules still hold without a step-up: a plain member, an admin on an owner, and another company's admin change nothing", async () => {
    const h = world(); h.join(OWNER2, A, "admin");
    h.as(MEMBER);
    expect(await h.call("POST", member(OWNER2, "removal"))).toEqual(refusal(404, "NOT_FOUND", NOT_FOUND));
    expect(await h.call("PUT", member(OWNER2, "role"), { role: "member" })).toEqual(refusal(404, "NOT_FOUND", NOT_FOUND));
    h.as(ADMIN);
    expect(await h.call("POST", member(OWNER, "removal"))).toEqual(refusal(403, "FORBIDDEN", OWNER_ONLY));
    expect(await h.call("PUT", member(OWNER, "role"), { role: "member" })).toEqual(refusal(403, "FORBIDDEN", OWNER_ONLY));
    h.as(OTHER);
    expect(await h.call("POST", member(OWNER2, "removal"))).toEqual(refusal(404, "NOT_FOUND", MEMBER_NOT_FOUND));
    expect(await h.call("PUT", member(OWNER2, "role"), { role: "member" })).toEqual(refusal(404, "NOT_FOUND", MEMBER_NOT_FOUND));
    expect(h.role(OWNER2)).toBe("admin"); expect(h.revoked(OWNER2)).toBe(false); expect(h.role(OWNER)).toBe("owner"); expect(h.revoked(OWNER)).toBe(false);
    expect(h.forwarded).toEqual([]);
  });
});

describe("the removal preview", () => {
  it("counts the person's open tasks in this company, those waiting on their decision, and their projects here", async () => {
    const h = world();
    const project = (name: string, companyId: string) => h.db.set({ pk: `PROJECT#${name}`, sk: "REV#000000000001", entityType: "PROJECT", companyId, definition: { name, revision: 1 } });
    const grant = (name: string, role: string) => h.db.set({ pk: `MEMBER#${MEMBER}`, sk: `PROJECT#${name}`, entityType: "MEMBERSHIP", projectName: name, role });
    project("alpha", A); project("beta", A); project("gamma", B);
    grant("alpha", "administrator"); grant("beta", "developer"); grant("gamma", "administrator");
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
      personId: MEMBER, role: "member", openTasks: 2, awaitingTheirDecision: 1, ownedProjects: ["alpha"], projectGrants: ["beta"], mayRemove: true,
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

  it("the last-owner refusal reaches the caller in T3b's words", async () => {
    const h = world(); h.join(OWNER2, A, "owner"); h.as(OWNER);
    // A concurrent change revokes the caller's own ownership witness between the route's read and the write: T3b's store refuses with its fixed last-owner words.
    h.deps.developer.companyMembers = companyMemberActionsThroughLambda({ documentClient: h.db, tableName: "SignIn", invoke: async () => ({ Payload: Buffer.from(JSON.stringify({ ok: false, error: "unavailable", message: MEMBER_LAST_OWNER })) }) });
    expect(await h.call("POST", member(OWNER2, "removal"))).toEqual(refusal(409, "LAST_OWNER", MEMBER_LAST_OWNER));
  });
});
