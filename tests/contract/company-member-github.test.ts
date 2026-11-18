// DEC 254n (2): a GitHub-signed-in company owner or admin gets exactly the member powers a Slack/OIDC person of the same role gets, and no more.
// Real route -> T3b's member helper -> identity-side operator and store; two companies; GitHub sessions carry the shared-method mark (DEC 254h).
import { describe, expect, it, vi } from "vitest";
import { AgentXError } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { companyMemberActionsThroughLambda, companyMembersThroughLambda } from "../../packages/broker/src/aws/company-member-forwarding.js";
import { authenticateCaller, routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { devRouteOf } from "../../packages/broker/src/aws/dev-route-scopes.js";
import { MEMBER_NOT_FOUND, NOT_FOUND, OWNER_ONLY } from "../../packages/broker/src/aws/company-member-routes.js";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { companyOperator } from "../../packages/broker/src/developer/company-operator.js";
import { companyIssuerKey } from "../../packages/broker/src/developer/company-issuer.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const TIME = "2026-11-01T09:00:00.000Z";
const A = COMPANY_A.orgId, B = COMPANY_B.orgId;
const OWNER = "a".repeat(64), ADMIN = "b".repeat(64), MEMBER = "c".repeat(64), TARGET = "d".repeat(64), OTHER = "e".repeat(64), OTHER_TARGET = "f".repeat(64);
const SESSIONS: Record<string, string> = {
  [OWNER]: "11111111-1111-4111-8111-111111111111", [ADMIN]: "22222222-2222-4222-8222-222222222222", [MEMBER]: "33333333-3333-4333-8333-333333333333",
  [OTHER]: "55555555-5555-4555-8555-555555555555",
};
const COMPANY_OF: Record<string, string> = { [OWNER]: A, [ADMIN]: A, [MEMBER]: A, [OTHER]: B };
const MEMBERS = "/v1/dev/company/members";
const member = (id: string, action: "removal-preview" | "removal" | "role") => `${MEMBERS}/${id}/${action}`;

function world(amr: "github" | "slack" = "github", options: { githubOn?: boolean } = {}) {
  const db = new FakeDynamoDb({ seed: 11 });
  // Cloud's web app: a full-access, install-level sign-in client (as company-member-routes.test.ts).
  const claims: Record<string, unknown> = { azp: "web-app", env: "test", sub: ADMIN, sid: SESSIONS[ADMIN], amr };
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false, installLevel: true, secretHash: "f".repeat(64), fullAccess: true, createdAt: TIME, updatedAt: TIME, updatedBy: "admin" });
  const join = (id: string, companyId: string, role: "owner" | "admin" | "member") => {
    db.set({ ...membershipKey(id), entityType: "COMPANY_MEMBERSHIP", personId: id, companyId, role, joinedAt: TIME });
    db.set({ pk: `ORG#${companyId}#MEMBERS`, sk: `MEMBER#${id}`, entityType: "COMPANY_MEMBER_VIEW", personId: id, companyId, role, joinedAt: TIME });
  };
  for (const [id, name] of [[OWNER, "Olive"], [ADMIN, "Ada"], [MEMBER, "Max"], [TARGET, "Tia"], [OTHER, "Bea"], [OTHER_TARGET, "Bo"]] as const) {
    db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, ...(amr === "github" ? { provider: "github", issuer: "https://github.com", subject: String(id.charCodeAt(0)) } : { provider: "slack" }), displayName: name, revoked: false });
    if (SESSIONS[id] !== undefined) {
      db.set({ pk: `SESSION#${SESSIONS[id]}`, sk: "META", sessionId: SESSIONS[id], developerId: id, amr, clientId: "web-app", companyId: COMPANY_OF[id], installMethod: true,
        startedAt: new Date(NOW - 60_000).toISOString(), endsAt: NOW / 1000 + 3600 });
    }
  }
  join(OWNER, A, "owner"); join(ADMIN, A, "admin"); join(MEMBER, A, "member"); join(TARGET, A, "member");
  join(OTHER, B, "owner"); join(OTHER_TARGET, B, "member");
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
      issuer: "https://signin.example.test", env: "test", methods: { slack: true, oidc: true, github: options.githubOn ?? true }, signInTableName: "SignIn",
      verifyAccessToken: async () => claims, channelMembers: async (request) => ({ ok: true, memberOf: request.channelIds }),
      companyMembers: companyMemberActionsThroughLambda({ documentClient: db, tableName: "SignIn", invoke }),
    },
  };
  const jwt = () => { const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url"); return `Bearer ${part({ alg: "none" })}.${part(claims)}.sig`; };
  const call = async (method: string, path: string, body?: unknown) => {
    const request = { method, path, headers: { authorization: jwt() }, requestId: "r", ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    try { return { status: 200, body: await routeDeveloperRequest(deps, request, new URL(path, "https://broker.example.test")) as Record<string, unknown> }; } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { status: error.statusCode, body: { error: { code: error.code, message: error.message.slice(error.code.length + 2) } } as Record<string, unknown> };
    }
  };
  const as = (id: string) => { claims.sub = id; claims.sid = SESSIONS[id]; };
  const role = (id: string) => (db.get(membershipKey(id).pk, "COMPANY") as { role?: string } | undefined)?.role;
  const revoked = (id: string) => (db.get(membershipKey(id).pk, "COMPANY") as { revokedAt?: string } | undefined)?.revokedAt !== undefined;
  return { db, claims, deps, jwt, call, as, forwarded, role, revoked, session: (id: string) => `SESSION#${SESSIONS[id]}` };
}
const refusal = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });

describe("GitHub-signed-in company admins (DEC 254n)", () => {
  it.each([["owner", OWNER], ["admin", ADMIN]] as const)("a GitHub %s lists, previews, sets a member's role and removes a member of their own company", async (_role, id) => {
    const h = world(); h.as(id);
    const list = await h.call("GET", MEMBERS);
    expect(list.status).toBe(200);
    expect((list.body["members"] as Array<{ personId: string }>).map((row) => row.personId).sort()).toEqual([OWNER, ADMIN, MEMBER, TARGET].sort());
    expect((await h.call("GET", member(TARGET, "removal-preview"))).status).toBe(200);
    expect(await h.call("PUT", member(TARGET, "role"), { role: "member" })).toEqual({ status: 200, body: { ok: true } });
    expect(await h.call("POST", member(TARGET, "removal"), {})).toEqual({ status: 200, body: { ok: true } });
    expect(h.revoked(TARGET)).toBe(true);
    // The identity side heard the caller's live company and the caller as the actor, nothing the request named.
    expect(h.forwarded).toEqual([
      { kind: "company-member-list", companyId: A },
      { kind: "company-member-role-set", companyId: A, personId: TARGET, role: "member", createdBy: id },
      { kind: "company-member-revoke", companyId: A, personId: TARGET, createdBy: id },
    ]);
  });

  it("only a GitHub owner touches an owner: a GitHub admin is refused before the store, an owner promotes with no step-up (DEC 254zzz73)", async () => {
    const h = world(); h.as(ADMIN);
    expect(await h.call("PUT", member(TARGET, "role"), { role: "owner" })).toEqual(refusal(403, "FORBIDDEN", OWNER_ONLY));
    expect(await h.call("POST", member(OWNER, "removal"), {})).toEqual(refusal(403, "FORBIDDEN", OWNER_ONLY));
    expect(h.forwarded).toEqual([]);
    h.as(OWNER);
    expect(await h.call("PUT", member(TARGET, "role"), { role: "owner" })).toEqual({ status: 200, body: { ok: true } });
    expect(h.forwarded).toEqual([{ kind: "company-member-role-set", companyId: A, personId: TARGET, role: "owner", createdBy: OWNER }]);
    expect(h.role(TARGET)).toBe("owner"); expect(h.revoked(OWNER)).toBe(false);
  });

  it.each([OWNER, ADMIN, MEMBER, OTHER])("a GitHub caller gets exactly what a Slack caller of the same role gets, action by action (%s)", async (id) => {
    const script = [
      ["GET", MEMBERS], ["GET", member(TARGET, "removal-preview")], ["PUT", member(TARGET, "role"), { role: "member" }], ["PUT", member(TARGET, "role"), { role: "admin" }],
      ["PUT", member(OWNER, "role"), { role: "member" }], ["PUT", member(ADMIN, "role"), { role: "member" }], ["POST", member(OWNER, "removal"), {}],
      ["POST", member(OTHER_TARGET, "removal"), {}], ["POST", member(TARGET, "removal"), {}], ["POST", member(TARGET, "removal"), {}],
    ] as const;
    const run = async (amr: "github" | "slack") => {
      const h = world(amr); h.as(id);
      const answers = [];
      for (const entry of script) { const [method, path, body] = entry as readonly [string, string, unknown?]; answers.push(await h.call(method, path, body)); }
      return { answers, forwarded: h.forwarded, state: [OWNER, ADMIN, MEMBER, TARGET, OTHER, OTHER_TARGET].map((p) => [h.role(p), h.revoked(p)]) };
    };
    const slack = await run("slack");
    expect(slack.answers.some((answer) => answer.status === 200)).toBe(id !== MEMBER);
    expect(await run("github")).toEqual(slack);
  });

  it("a GitHub plain member gets not found on every member route and nothing is forwarded", async () => {
    const h = world(); h.as(MEMBER);
    for (const [method, path, body] of [["GET", MEMBERS], ["GET", member(TARGET, "removal-preview")], ["PUT", member(TARGET, "role"), { role: "admin" }], ["POST", member(TARGET, "removal"), {}]] as const) {
      expect(await h.call(method, path, body)).toEqual(refusal(404, "NOT_FOUND", NOT_FOUND));
    }
    expect(h.forwarded).toEqual([]); expect(h.role(TARGET)).toBe("member"); expect(h.revoked(TARGET)).toBe(false);
  });

  it("a GitHub owner of another company cannot see or touch this company's people, and A's owner cannot touch B's", async () => {
    const h = world(); h.as(OTHER);
    const list = await h.call("GET", MEMBERS);
    expect((list.body["members"] as Array<{ personId: string }>).map((row) => row.personId).sort()).toEqual([OTHER, OTHER_TARGET].sort());
    for (const [method, path, body] of [["GET", member(TARGET, "removal-preview")], ["PUT", member(TARGET, "role"), { role: "admin" }], ["POST", member(TARGET, "removal"), {}]] as const) {
      expect(await h.call(method, path, body)).toEqual(refusal(404, "NOT_FOUND", MEMBER_NOT_FOUND));
    }
    h.as(OWNER);
    expect(await h.call("POST", member(OTHER_TARGET, "removal"), {})).toEqual(refusal(404, "NOT_FOUND", MEMBER_NOT_FOUND));
    expect(h.role(TARGET)).toBe("member"); expect(h.revoked(TARGET)).toBe(false); expect(h.revoked(OTHER_TARGET)).toBe(false);
    expect(h.forwarded).toEqual([{ kind: "company-member-list", companyId: B }]);
  });
});

describe("GitHub sessions not bound to the company reach no member route (review Low 2)", () => {
  it.each([
    ["no shared-method mark", (h: ReturnType<typeof world>) => { const row = { ...(h.db.get(h.session(OWNER), "META") as Record<string, unknown>) }; delete row.installMethod; h.db.set(row); }],
    ["bound to another company", (h: ReturnType<typeof world>) => { h.db.set({ ...(h.db.get(h.session(OWNER), "META") as Record<string, unknown>), companyId: B }); }],
    ["a company with its own issuer", (h: ReturnType<typeof world>) => { h.db.set({ ...companyIssuerKey(A), entityType: "COMPANY_SIGNIN_ISSUER", enabled: true }); }],
  ] as const)("%s: refused, nothing forwarded, nobody changed", async (_name, damage) => {
    const h = world(); h.as(OWNER); damage(h);
    for (const [method, path, body] of [["GET", MEMBERS], ["PUT", member(TARGET, "role"), { role: "member" }], ["POST", member(TARGET, "removal"), {}]] as const) {
      expect((await h.call(method, path, body)).status).toBe(401);
    }
    expect(h.forwarded).toEqual([]); expect(h.revoked(TARGET)).toBe(false);
  });

  it("GitHub sign-in switched off: refused", async () => {
    const h = world("github", { githubOn: false }); h.as(OWNER);
    expect((await h.call("GET", MEMBERS)).status).toBe(401);
    expect(h.forwarded).toEqual([]);
  });
});

describe("the member helper's caller methods", () => {
  const helperWorld = () => {
    const db = new FakeDynamoDb(); const forwarded: unknown[] = [];
    db.set({ ...membershipKey(ADMIN), entityType: "COMPANY_MEMBERSHIP", personId: ADMIN, role: "admin", companyId: A, joinedAt: TIME });
    db.set({ ...membershipKey(TARGET), entityType: "COMPANY_MEMBERSHIP", personId: TARGET, role: "member", companyId: A, joinedAt: TIME });
    const store = new CompanySignInStore({ documentClient: db, tableName: "signin", now: () => NOW });
    const forward = companyMembersThroughLambda({ documentClient: db, tableName: "signin", invoke: async (payload) => {
      const event = JSON.parse(Buffer.from(payload).toString()) as Record<string, unknown>; forwarded.push(event);
      return { Payload: Buffer.from(JSON.stringify(await companyOperator({ store, now: () => NOW, log: () => {} }, event))) };
    } });
    return { forward, forwarded, db };
  };
  const request = { kind: "company-member-revoke", companyId: A, personId: TARGET };

  it.each(["slack", "oidc", "github"])("a live admin signed in with %s forwards the same request", async (amr) => {
    const h = helperWorld();
    expect(await h.forward({ developerId: ADMIN, sessionId: "s", amr: amr as never, name: "Ada" }, request)).toEqual({ ok: true });
    expect(h.forwarded).toEqual([{ ...request, createdBy: ADMIN }]);
  });

  it.each(["owner", "member", "revoked", "foreign", "missing"])("a GitHub caller whose live membership is %s gets exactly the Slack caller's answer", async (mode) => {
    const run = async (amr: string) => {
      const h = helperWorld();
      if (mode === "missing") h.db.delete(membershipKey(ADMIN).pk, "COMPANY");
      else h.db.set({ ...membershipKey(ADMIN), entityType: "COMPANY_MEMBERSHIP", personId: ADMIN, role: mode === "owner" ? "owner" : mode === "member" ? "member" : "admin",
        companyId: mode === "foreign" ? B : A, joinedAt: TIME, ...(mode === "revoked" ? { revokedAt: TIME } : {}) });
      return { answer: await h.forward({ developerId: ADMIN, sessionId: "s", amr: amr as never, name: "Ada" }, request), forwarded: h.forwarded };
    };
    const github = await run("github");
    expect(github).toEqual(await run("slack"));
    expect(github.answer).toEqual(mode === "owner" ? { ok: true } : { ok: false, error: "not_found" });
  });

  it("a GitHub admin of another company naming this company is refused before anything is forwarded", async () => {
    const h = helperWorld();
    h.db.set({ ...membershipKey(OTHER), entityType: "COMPANY_MEMBERSHIP", personId: OTHER, role: "owner", companyId: B, joinedAt: TIME });
    for (const kind of ["company-member-list", "company-member-revoke"]) {
      expect(await h.forward({ developerId: OTHER, sessionId: "s", amr: "github", name: "Bea" }, kind === "company-member-list" ? { kind, companyId: A } : { ...request, kind })).toEqual({ ok: false, error: "not_found" });
    }
    expect(h.forwarded).toEqual([]);
  });

  it.each(["cloud", "saml", "local", "GitHub", "", undefined])("any other method (%s) is refused before any read", async (amr) => {
    const h = helperWorld();
    expect(await h.forward({ developerId: ADMIN, sessionId: "s", amr: amr as never, name: "Ada" }, request)).toEqual({ ok: false, error: "not_found" });
    expect(h.forwarded).toEqual([]); expect(h.db.commandNames()).toEqual([]);
  });
});

describe("GitHub people in the member list (DEC 254p (a))", () => {
  type Row = { personId: string; name?: string };
  it("show their GitHub name, the same way Slack people show theirs", async () => {
    for (const amr of ["github", "slack"] as const) {
      const h = world(amr); h.as(ADMIN);
      const rows = (await h.call("GET", MEMBERS)).body["members"] as Row[];
      expect(rows.find((row) => row.personId === ADMIN)!.name).toBe("Ada");
    }
  });
  it("show a hostile name as plain text of at most 80 code points, even when the stored one is very long", async () => {
    const h = world("github"); h.as(ADMIN);
    h.db.set({ ...h.db.get(`DEVELOPER#${TARGET}`, "META")!, displayName: `<img src=x onerror=alert(1)>[a](https://evil.example) **${"w".repeat(5_000)}` });
    h.db.set({ ...h.db.get(`DEVELOPER#${MEMBER}`, "META")!, displayName: "<>**" });
    const rows = (await h.call("GET", MEMBERS)).body["members"] as Row[];
    const named = rows.find((row) => row.personId === TARGET)!;
    expect(named.name).not.toMatch(/[<>[\]`*]/u);
    expect(Array.from(named.name!).length).toBeLessThanOrEqual(80);
    expect(rows.find((row) => row.personId === MEMBER)!.name).toBe(`GitHub user ${MEMBER.charCodeAt(0)}`);
  });
  it("reach tasks and admin screens as clean text: the signed-in caller's name", async () => {
    const route = devRouteOf("GET", "/v1/dev/projects")!;
    const nameOf = async (h: ReturnType<typeof world>) => (await authenticateCaller(h.deps, h.jwt(), route)).name;
    const github = world("github"); github.as(ADMIN);
    expect(await nameOf(github)).toBe("Ada");
    github.db.set({ ...github.db.get(`DEVELOPER#${ADMIN}`, "META")!, displayName: `<img src=x onerror=alert(1)>[a](https://evil.example) ${"v".repeat(900)}` });
    const hostile = await nameOf(github);
    expect(hostile).not.toMatch(/[<>[\]`*]/u);
    expect(Array.from(hostile).length).toBeLessThanOrEqual(80);
    const slack = world("slack"); slack.as(ADMIN);
    slack.db.set({ ...slack.db.get(`DEVELOPER#${ADMIN}`, "META")!, displayName: "<b>Ada</b>" });
    expect(await nameOf(slack)).toBe("<b>Ada</b>");
  });
  it("leave a Slack person's stored name exactly as stored, including the old 200-character limit", async () => {
    const h = world("slack"); h.as(ADMIN);
    h.db.set({ ...h.db.get(`DEVELOPER#${TARGET}`, "META")!, displayName: "<b>Tia</b>" });
    h.db.set({ ...h.db.get(`DEVELOPER#${MEMBER}`, "META")!, displayName: "m".repeat(201), email: "m@example.test" });
    const rows = (await h.call("GET", MEMBERS)).body["members"] as Row[];
    expect(rows.find((row) => row.personId === TARGET)!.name).toBe("<b>Tia</b>");
    // As before: a record that does not read (a Slack name over 200 characters) leaves both name and email out.
    expect(rows.find((row) => row.personId === MEMBER)).not.toHaveProperty("name");
    expect(rows.find((row) => row.personId === MEMBER)).not.toHaveProperty("email");
  });
  it("never show another company's names to a company's admin", async () => {
    const h = world("github"); h.as(ADMIN);
    const text = JSON.stringify((await h.call("GET", MEMBERS)).body);
    for (const other of [OTHER, OTHER_TARGET]) expect(text).not.toContain(other);
    expect(text).not.toContain("Bea");
    h.as(OTHER);
    const own = (await h.call("GET", MEMBERS)).body["members"] as Row[];
    expect(own.map((row) => row.personId).sort()).toEqual([OTHER, OTHER_TARGET].sort());
    expect(own.find((row) => row.personId === OTHER)!.name).toBe("Bea");
  });
});
