// Member removal is complete (arch cleanup, rule 7: one deletion path for "this person left this company"). A removed person who comes back (the operator's `company-member-restore`, the only way a
// revoked membership returns) must not silently get back what they held: their non-administrator project grants are dropped with the removal (aws/company-member-routes.ts, through the one grant
// revoke, admin-actions.ts revokeProjectAccess), and their sign-in sessions are ended with it (the sign-in Lambda's one end-sessions kind, the admin "end sign-in" path).
//
// What runs here is what the deployed broker runs: the real developer dispatcher (broker.ts hands every request to routeDeveloperRequest), T3b's real member helper and operator, the REAL
// sign-in Lambda handler (`createDeveloperIdentityHandler`, the function broker.ts invokes for both `company-member-*` and `end-developer-sessions`), and a fake DynamoDB. Two companies throughout.
// Not run here: the deployed Lambda's IAM and the real network hop (`lambdaClient.send`).
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentXError, type OrgId } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { companyMemberActionsThroughLambda } from "../../packages/broker/src/aws/company-member-forwarding.js";
import { endDeveloperSessionsThroughLambda, routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { grantKeyFor, grantsPkFor, projectMemberRowKeyFor } from "../../packages/broker/src/aws/company-layout.js";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { createDeveloperIdentityHandler } from "../../packages/broker/src/developer/server.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { slackDirectory } from "../../packages/broker/src/developer/slack-directory.js";
import { HANDOVER_UNFINISHED } from "../../packages/broker/src/aws/company-member-routes.js";
import { MEMBER_REVOKED } from "../../packages/broker/src/developer/company-member-contract.js";
import { BOT_TOKEN, ISSUER, TEAM, localSigner, routeFetch } from "../support/developer-fakes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const TIME = "2026-11-01T09:00:00.000Z";
const A = COMPANY_A.orgId, B = COMPANY_B.orgId;
const OWNER = "a".repeat(64), LEAVER = "c".repeat(64), PEER = "d".repeat(64), OTHER = "e".repeat(64), BYSTANDER = "f".repeat(64);
const NAMES: Record<string, string> = { [OWNER]: "Olive", [LEAVER]: "Lee", [PEER]: "Pat", [OTHER]: "Bea", [BYSTANDER]: "Ben" };
const ROLES: Record<string, string> = { [OWNER]: "owner", [LEAVER]: "admin", [PEER]: "member", [OTHER]: "admin", [BYSTANDER]: "admin" };
const SESSIONS: Record<string, string> = Object.fromEntries(Object.keys(NAMES).map((id, index) => [id, `s-${index}`]));
const CANARY = "leak-canary-member-removal";
const MEMBERS = "/v1/dev/company/members";
const removal = (id: string) => `${MEMBERS}/${id}/removal`;
const refusal = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });

function world() {
  const db = new FakeDynamoDb({ seed: 24 });
  const claims: Record<string, unknown> = { azp: "web-app", env: "test", sub: OWNER, sid: SESSIONS[OWNER], amr: "slack" };
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false, installLevel: true, secretHash: "f".repeat(64), fullAccess: true, webApp: true, createdAt: TIME, updatedAt: TIME, updatedBy: "admin" });
  const join = (id: string, companyId: string) => {
    db.set({ ...membershipKey(id), entityType: "COMPANY_MEMBERSHIP", personId: id, companyId, role: ROLES[id], joinedAt: TIME });
    db.set({ pk: `ORG#${companyId}#MEMBERS`, sk: `MEMBER#${id}`, entityType: "COMPANY_MEMBER_VIEW", personId: id, companyId, role: ROLES[id], joinedAt: TIME });
  };
  for (const id of Object.keys(NAMES)) {
    db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "slack", displayName: NAMES[id], email: `${NAMES[id]!.toLowerCase()}@example.test`, revoked: false });
    db.set({ pk: `SESSION#${SESSIONS[id]}`, sk: "META", sessionId: SESSIONS[id], developerId: id, amr: "slack", clientId: "web-app", startedAt: new Date(NOW - 60_000).toISOString(), endsAt: NOW / 1000 + 3600 });
    join(id, id === OTHER ? B : A);
  }
  const lines: string[] = [];
  // The one sign-in Lambda: it answers the company operator kinds and `end-developer-sessions`, as the function broker.ts invokes for both.
  const signInStore = new CompanySignInStore({ documentClient: db, tableName: "SignIn", now: () => NOW });
  const lambda = createDeveloperIdentityHandler({
    config: { env: "test", issuer: ISSUER, slack: { enabled: false } }, store: new DeveloperSignInStore({ documentClient: db, tableName: "SignIn", now: () => NOW }),
    signer: localSigner(), providers: {}, directory: slackDirectory({ teamId: TEAM, botToken: async () => BOT_TOKEN, fetch: routeFetch(), now: () => NOW }),
    now: () => NOW, log: () => {}, company: signInStore,
  });
  const down = { sessions: false };
  const invoke = async (payload: Uint8Array) => {
    const event = JSON.parse(Buffer.from(payload).toString()) as Record<string, unknown>;
    if (down.sessions && event["kind"] === "end-developer-sessions") throw new Error(CANARY);
    return { Payload: Buffer.from(JSON.stringify(await (lambda as unknown as (event: unknown) => Promise<unknown>)(event))) };
  };
  vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
  const deps: DeveloperRouteDependencies = {
    documentClient: db, tableName: "State", now: () => NOW, companies: companyMembershipFromDynamo(db, "SignIn"),
    developer: {
      issuer: "https://signin.example.test", env: "test", methods: { slack: true, oidc: true }, signInTableName: "SignIn",
      verifyAccessToken: async () => claims, channelMembers: async (request) => ({ ok: true, memberOf: request.channelIds }),
      companyMembers: companyMemberActionsThroughLambda({ documentClient: db, tableName: "SignIn", invoke }),
      endDeveloperSessions: endDeveloperSessionsThroughLambda(invoke),
    },
  };
  const jwt = () => { const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url"); return `Bearer ${part({ alg: "none" })}.${part(claims)}.sig`; };
  const call = async (method: string, path: string, body?: unknown) => {
    const target = /\/members\/([a-f0-9]{64})\/removal$/u.exec(path)?.[1];
    const sent = body ?? (method === "POST" && target !== undefined ? { requestId: randomUUID(), expectedRole: ROLES[target] } : undefined);
    const request = { method, path, headers: { authorization: jwt() }, requestId: "r", ...(sent === undefined ? {} : { body: JSON.stringify(sent) }) };
    try { return { status: 200, body: await routeDeveloperRequest(deps, request, new URL(path, "https://broker.example.test")) as Record<string, unknown> }; } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { status: error.statusCode, body: { error: { code: error.code, message: error.message.slice(error.code.length + 2) } } as Record<string, unknown> };
    }
  };
  const as = (id: string) => { claims.sub = id; claims.sid = SESSIONS[id]; };
  /** Whether this person's session still gets through the dispatcher (their company's member list needs an administrator's live session). */
  const sessionWorks = async (id: string) => { const before = claims.sub; as(id); const answer = await call("GET", MEMBERS); as(before as string); return answer.status === 200; };
  const operate = (event: Record<string, unknown>) => (lambda as unknown as (event: unknown) => Promise<{ ok?: boolean; message?: string }>)({ companyId: A, ...event });
  const restore = async (id: string) => (await operate({ kind: "company-member-restore", personId: id })).ok === true;
  const roleOf = (id: string) => (db.get(membershipKey(id).pk, "COMPANY") as { role?: string } | undefined)?.role;
  const log = () => db.find((row) => row.entityType === "COMPANY_LOG");
  const revoked = (id: string) => (db.get(membershipKey(id).pk, "COMPANY") as { revokedAt?: string } | undefined)?.revokedAt !== undefined;
  const projectOf = (companyId: string, project: string) => db.set({ pk: `ORG#${companyId}#PROJECT#${project}`, sk: "REV#000000000001", entityType: "PROJECT",
    definition: { name: project, revision: 1, orchestratorInstructions: "x", setup: [{ executable: "npm", args: ["ci"], cwd: "repo/r", timeoutSeconds: 900 }],
      readiness: [{ executable: "npm", args: ["test"], cwd: "repo/r", timeoutSeconds: 900 }], repositories: [{ name: "r", url: "https://github.com/acme/r", defaultBranch: "main", path: "repo/r", credentialRef: "github-agentx-sdlc" }] } });
  const grant = (companyId: OrgId, person: string, project: string, role: "developer" | "administrator", extra: Record<string, unknown> = {}) => {
    projectOf(companyId, project);
    db.set({ ...grantKeyFor(companyId, person, project), entityType: "MEMBERSHIP", ownerKey: person, projectName: project, role, grantId: randomUUID(), grantedAt: TIME, companyId, ...extra });
    db.set({ ...projectMemberRowKeyFor(companyId, project, person), entityType: "PROJECT_MEMBER", role, grantedAt: TIME, companyId });
  };
  /** Every project a person holds in a company, by the grant row, and by the project's reverse row. */
  const held = (companyId: OrgId, person: string) => db.find((item) => item.pk === grantsPkFor(companyId, person) && typeof item.sk === "string" && item.sk.startsWith("PROJECT#")).map((item) => `${String(item.projectName)}:${String(item.role)}`).sort();
  const reverse = (companyId: OrgId, person: string) => db.find((item) => item.sk === `DEVELOPER#${person}` && typeof item.pk === "string" && item.pk.startsWith(`ORG#${companyId}#PROJECT_MEMBERS#`)).map((item) => `${String(item.pk).split("#").pop()}:${String(item.role)}`).sort();
  const endedAt = (id: string) => (db.get(`DEVELOPER#${id}`, "META") as { sessionsEndedAt?: string } | undefined)?.sessionsEndedAt;
  return { db, claims, call, as, revoked, restore, operate, roleOf, log, grant, held, reverse, sessionWorks, endedAt, down, lines };
}

describe("a removed person who comes back gets nothing back silently", () => {
  it("REJOIN: after removal and the operator's restore, none of their old developer grants (nor the project-side rows) is there; an administrator grant went to the successor; a peer's grants stay", async () => {
    const h = world();
    h.grant(A, LEAVER, "alpha", "developer"); h.grant(A, LEAVER, "beta", "developer"); h.grant(A, LEAVER, "gamma", "administrator");
    h.grant(A, PEER, "alpha", "developer"); h.grant(A, PEER, "beta", "developer");
    h.grant(B, OTHER, "alpha", "developer");
    expect(h.held(A, LEAVER)).toEqual(["alpha:developer", "beta:developer", "gamma:administrator"]);
    expect((await h.call("POST", removal(LEAVER))).status).toBe(200);
    expect(h.revoked(LEAVER)).toBe(true);
    expect(await h.restore(LEAVER)).toBe(true);
    expect(h.revoked(LEAVER)).toBe(false);
    // The rejoined person holds no project, in either row the readers use.
    expect(h.held(A, LEAVER)).toEqual([]);
    expect(h.reverse(A, LEAVER)).toEqual([]);
    // The administrator grant moved to the successor (the remover), as before.
    expect(h.held(A, OWNER)).toEqual(["gamma:administrator"]);
    // Others untouched: a peer in the same company, and a person of another company.
    expect(h.held(A, PEER)).toEqual(["alpha:developer", "beta:developer"]); expect(h.reverse(A, PEER)).toEqual(["alpha:developer", "beta:developer"]);
    expect(h.held(B, OTHER)).toEqual(["alpha:developer"]); expect(h.reverse(B, OTHER)).toEqual(["alpha:developer"]);
  });

  it("a grant row under their key that names another company is not theirs to drop here; nothing of another company's partition is touched", async () => {
    const h = world();
    h.grant(A, LEAVER, "alpha", "developer");
    h.grant(A, LEAVER, "omega", "developer", { companyId: B });
    h.grant(B, LEAVER, "alpha", "developer");
    expect((await h.call("POST", removal(LEAVER))).status).toBe(200);
    expect(h.held(A, LEAVER)).toEqual(["omega:developer"]);
    expect(h.held(B, LEAVER)).toEqual(["alpha:developer"]);
  });

  it("the open sessions stop working at once, and stay dead after a restore; a bystander's session and sign-in record, and another company's, are untouched", async () => {
    const h = world();
    expect(await h.sessionWorks(LEAVER)).toBe(true); expect(await h.sessionWorks(BYSTANDER)).toBe(true);
    expect((await h.call("POST", removal(LEAVER))).status).toBe(200);
    expect(await h.sessionWorks(LEAVER)).toBe(false);
    expect(h.endedAt(LEAVER)).toBe(new Date(NOW).toISOString());
    expect(await h.restore(LEAVER)).toBe(true);
    // The restored administrator's old session does not come back with the membership: they sign in again.
    expect(await h.sessionWorks(LEAVER)).toBe(false);
    expect(await h.sessionWorks(BYSTANDER)).toBe(true);
    expect(h.endedAt(BYSTANDER)).toBeUndefined(); expect(h.endedAt(OWNER)).toBeUndefined(); expect(h.endedAt(PEER)).toBeUndefined(); expect(h.endedAt(OTHER)).toBeUndefined();
  });

  it("the sign-in email pointers are left alone", async () => {
    const h = world();
    h.db.set({ pk: "EMAIL#" + "9".repeat(64), sk: "META", entityType: "DEVELOPER_EMAIL", developerId: LEAVER });
    expect((await h.call("POST", removal(LEAVER))).status).toBe(200);
    expect(h.db.get("EMAIL#" + "9".repeat(64), "META")).toMatchObject({ developerId: LEAVER });
  });

  it("Code keeps no monthly limit override per member: the one per-person limit row, the open-workspace counter, is left as it is (open tasks give their slots back to it)", async () => {
    const h = world();
    h.db.set({ pk: `DEVELOPER_LIMIT#${LEAVER}`, sk: "MEMBER", entityType: "DEVELOPER_LIMIT", count: 1 });
    h.db.set({ pk: `DEVELOPER_LIMIT#${LEAVER}`, sk: "TASK#11111111-1111-4111-8111-111111111111", entityType: "DEVELOPER_LIMIT_TASK" });
    h.db.set({ pk: `DEVELOPER_LIMIT#${PEER}`, sk: "MEMBER", entityType: "DEVELOPER_LIMIT", count: 2 });
    expect((await h.call("POST", removal(LEAVER))).status).toBe(200);
    expect(h.db.get(`DEVELOPER_LIMIT#${LEAVER}`, "MEMBER")).toMatchObject({ count: 1 });
    expect(h.db.get(`DEVELOPER_LIMIT#${LEAVER}`, "TASK#11111111-1111-4111-8111-111111111111")).toBeDefined();
    expect(h.db.get(`DEVELOPER_LIMIT#${PEER}`, "MEMBER")).toMatchObject({ count: 2 });
  });
});

describe("removing twice does nothing harmful, and a failed cleanup is retried", () => {
  it("the same request again answers the same; a new request for the removed person is refused as already removed; nothing of anyone else changes", async () => {
    const h = world();
    h.grant(A, LEAVER, "alpha", "developer"); h.grant(A, PEER, "alpha", "developer");
    const requestId = randomUUID();
    const first = await h.call("POST", removal(LEAVER), { requestId, expectedRole: "admin" });
    expect(first.status).toBe(200);
    expect(await h.call("POST", removal(LEAVER), { requestId, expectedRole: "admin" })).toEqual(first);
    expect(await h.call("POST", removal(LEAVER))).toEqual(refusal(409, "MEMBER_ALREADY_REMOVED", MEMBER_REVOKED));
    expect(h.held(A, LEAVER)).toEqual([]); expect(h.held(A, PEER)).toEqual(["alpha:developer"]);
    expect(h.endedAt(LEAVER)).toBe(new Date(NOW).toISOString());
    expect(await h.sessionWorks(BYSTANDER)).toBe(true);
  });

  it("a grant that cannot be dropped: the removal says it is not finished, the same request finishes it; the person is already out and has no company access meanwhile", async () => {
    const h = world();
    h.grant(A, LEAVER, "alpha", "developer");
    h.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("PROJECT_MEMBERS#alpha"), error: { name: "InternalServerError", message: CANARY } });
    const requestId = randomUUID();
    const answer = await h.call("POST", removal(LEAVER), { requestId, expectedRole: "admin" });
    expect(answer).toEqual(refusal(503, "RUNTIME_UNAVAILABLE", HANDOVER_UNFINISHED));
    expect(JSON.stringify(answer)).not.toContain(CANARY);
    expect(h.revoked(LEAVER)).toBe(true);
    expect(await h.call("POST", removal(LEAVER), { requestId, expectedRole: "admin" })).toMatchObject({ status: 200, body: { state: "DONE" } });
    expect(h.held(A, LEAVER)).toEqual([]); expect(h.reverse(A, LEAVER)).toEqual([]);
  });

  it("sessions that cannot be ended never block the removal: it is logged without the cause, and a later removal request for the same person ends them", async () => {
    const h = world();
    h.down.sessions = true;
    expect((await h.call("POST", removal(LEAVER))).status).toBe(200);
    expect(h.revoked(LEAVER)).toBe(true);
    expect(h.endedAt(LEAVER)).toBeUndefined();
    const logged = h.lines.filter((line) => line.includes("member_removal."));
    expect(logged.map((line) => JSON.parse(line) as unknown)).toEqual([{ component: "broker", event: "member_removal.sessions_not_ended", level: "error", companyId: A, person: LEAVER }]);
    expect(h.lines.join("\n")).not.toContain(CANARY);
    h.down.sessions = false;
    expect(await h.call("POST", removal(LEAVER))).toEqual(refusal(409, "MEMBER_ALREADY_REMOVED", MEMBER_REVOKED));
    expect(h.endedAt(LEAVER)).toBe(new Date(NOW).toISOString());
  });
});

describe("a restored person comes back as a plain member (arch ruling: no old role returns)", () => {
  it("an administrator is removed and restored: they are a member; another administrator grants the role again, audited like any other grant", async () => {
    const h = world();
    expect((await h.call("POST", removal(LEAVER))).status).toBe(200);
    expect(h.roleOf(LEAVER)).toBe("admin");
    expect(await h.restore(LEAVER)).toBe(true);
    expect(h.revoked(LEAVER)).toBe(false);
    expect(h.roleOf(LEAVER)).toBe("member");
    // The company's member view (what the member list reads) says member too.
    expect(h.db.get(`ORG#${A}#MEMBERS`, `MEMBER#${LEAVER}`)).toMatchObject({ role: "member", personId: LEAVER });
    expect(h.log().filter((row) => row.event === "company-member-restore")).toEqual([expect.objectContaining({ personId: LEAVER, fromRole: "admin", toRole: "member" })]);
    // A member cannot grant themselves anything back.
    expect(await h.operate({ kind: "company-member-role-set", personId: LEAVER, role: "admin", createdBy: LEAVER })).toMatchObject({ ok: false });
    expect(h.roleOf(LEAVER)).toBe("member");
    // An administrator grants the role again; the grant is audited like any other role change.
    expect(await h.operate({ kind: "company-member-role-set", personId: LEAVER, role: "admin", createdBy: BYSTANDER })).toMatchObject({ ok: true });
    expect(h.roleOf(LEAVER)).toBe("admin");
    expect(h.log().filter((row) => row.event === "company-member-role-set")).toEqual([expect.objectContaining({ personId: LEAVER, createdBy: BYSTANDER, fromRole: "member", toRole: "admin" })]);
  });

  it("restoring someone who was never removed changes nothing: a live admin stays an admin", async () => {
    const h = world();
    const before = h.db.get(membershipKey(LEAVER).pk, "COMPANY");
    expect(h.revoked(LEAVER)).toBe(false);
    expect(await h.restore(LEAVER)).toBe(true);
    expect(h.roleOf(LEAVER)).toBe("admin");
    expect(h.db.get(membershipKey(LEAVER).pk, "COMPANY")).toEqual(before);
    expect(h.db.get(`ORG#${A}#MEMBERS`, `MEMBER#${LEAVER}`)).toMatchObject({ role: "admin" });
    expect(h.log().filter((row) => row.event === "company-member-restore")).toEqual([expect.objectContaining({ personId: LEAVER, fromRole: "admin", toRole: "admin" })]);
  });

  it("a restored member who was already a member stays one (nothing else about them is rewritten)", async () => {
    const h = world();
    expect((await h.call("POST", removal(PEER))).status).toBe(200);
    expect(await h.restore(PEER)).toBe(true);
    expect(h.roleOf(PEER)).toBe("member");
    expect(h.db.get(membershipKey(PEER).pk, "COMPANY")).not.toHaveProperty("updatedBy");
  });

  it("owner rules still hold: a restored owner is a member, so the company's owners are unchanged and the last owner still cannot leave or step down", async () => {
    const h = world();
    // A second owner (LEAVER) so the first removal is allowed; the owner row is rewritten in place.
    h.db.set({ ...h.db.get(membershipKey(LEAVER).pk, "COMPANY")!, role: "owner" });
    h.db.set({ ...h.db.get(`ORG#${A}#MEMBERS`, `MEMBER#${LEAVER}`)!, role: "owner" });
    expect(await h.operate({ kind: "company-member-revoke", personId: LEAVER, createdBy: OWNER })).toMatchObject({ ok: true });
    expect(await h.operate({ kind: "company-member-restore", personId: LEAVER, createdBy: OWNER })).toMatchObject({ ok: true });
    expect(h.roleOf(LEAVER)).toBe("member");
    expect(h.log().filter((row) => row.event === "company-member-restore")).toEqual([expect.objectContaining({ personId: LEAVER, fromRole: "owner", toRole: "member" })]);
    expect(h.roleOf(OWNER)).toBe("owner");
    // The restored person did not become a second owner, so the original owner is the last one and stays.
    const LAST = "a company must keep at least one active owner";
    expect(await h.operate({ kind: "company-member-revoke", personId: OWNER, createdBy: OWNER })).toMatchObject({ ok: false, message: LAST });
    expect(await h.operate({ kind: "company-member-role-set", personId: OWNER, role: "member", createdBy: OWNER })).toMatchObject({ ok: false, message: LAST });
    expect(h.revoked(OWNER)).toBe(false); expect(h.roleOf(OWNER)).toBe("owner");
    // An owner can still make the restored person an owner again, audited as an ordinary role change.
    expect(await h.operate({ kind: "company-member-role-set", personId: LEAVER, role: "owner", createdBy: OWNER })).toMatchObject({ ok: true });
    expect(h.log().filter((row) => row.event === "company-member-role-set")).toEqual([expect.objectContaining({ personId: LEAVER, fromRole: "member", toRole: "owner", createdBy: OWNER })]);
  });

  it("an administrator (not an owner) may restore a removed owner, who comes back as a member and gets no owner power", async () => {
    const h = world();
    h.db.set({ ...h.db.get(membershipKey(LEAVER).pk, "COMPANY")!, role: "owner" });
    h.db.set({ ...h.db.get(`ORG#${A}#MEMBERS`, `MEMBER#${LEAVER}`)!, role: "owner" });
    expect(await h.operate({ kind: "company-member-revoke", personId: LEAVER, createdBy: OWNER })).toMatchObject({ ok: true });
    expect(await h.operate({ kind: "company-member-restore", personId: LEAVER, createdBy: BYSTANDER })).toMatchObject({ ok: true });
    expect(h.roleOf(LEAVER)).toBe("member");
  });
});
