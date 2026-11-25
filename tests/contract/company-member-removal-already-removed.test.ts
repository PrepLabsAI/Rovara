// Opus review addition (member removal, 3072d8f1f): a person whose membership was ended OUTSIDE the removal route (the operator's company-member-revoke, or another remover) and is then
// removed again through the route: the answer stays "already removed", and the cleanup still runs (their non-administrator grants drop, quietly; their sessions end). Their administrator grants
// are left for the hand-over, and another company is untouched. Setup copied from company-member-removal-rejoin.test.ts.
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
  const restore = async (id: string) => (await (lambda as unknown as (event: unknown) => Promise<{ ok?: boolean }>)({ kind: "company-member-restore", companyId: A, personId: id })).ok === true;
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
  return { db, lambda, claims, call, as, revoked, restore, grant, held, reverse, sessionWorks, endedAt, down, lines };
}

describe("a membership ended outside the route, removed again through it", () => {
  it("answers already removed, and still drops their non-administrator grants and ends their sessions; administrator grants and another company stay", async () => {
    const h = world();
    h.grant(A, LEAVER, "alpha", "developer"); h.grant(A, LEAVER, "gamma", "administrator"); h.grant(B, OTHER, "alpha", "developer"); h.grant(A, PEER, "alpha", "developer");
    const operate = h.lambda as unknown as (event: unknown) => Promise<{ ok?: boolean }>;
    expect(await operate({ kind: "company-member-revoke", companyId: A, personId: LEAVER, createdBy: OWNER })).toMatchObject({ ok: true });
    expect(h.held(A, LEAVER)).toEqual(["alpha:developer", "gamma:administrator"]);
    expect(h.endedAt(LEAVER)).toBeUndefined();
    expect(await h.call("POST", removal(LEAVER))).toEqual(refusal(409, "MEMBER_ALREADY_REMOVED", MEMBER_REVOKED));
    expect(h.held(A, LEAVER)).toEqual(["gamma:administrator"]); expect(h.reverse(A, LEAVER)).toEqual(["gamma:administrator"]);
    expect(h.endedAt(LEAVER)).toBe(new Date(NOW).toISOString());
    expect(h.held(A, PEER)).toEqual(["alpha:developer"]); expect(h.held(B, OTHER)).toEqual(["alpha:developer"]); expect(h.reverse(B, OTHER)).toEqual(["alpha:developer"]);
    expect(h.endedAt(PEER)).toBeUndefined(); expect(h.endedAt(OTHER)).toBeUndefined();
  });

  it("a grant that cannot be dropped there leaves the answer unchanged, logged without the cause; a later request drops it", async () => {
    const h = world();
    h.grant(A, LEAVER, "alpha", "developer");
    const operate = h.lambda as unknown as (event: unknown) => Promise<{ ok?: boolean }>;
    expect(await operate({ kind: "company-member-revoke", companyId: A, personId: LEAVER, createdBy: OWNER })).toMatchObject({ ok: true });
    h.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("PROJECT_MEMBERS#alpha"), error: { name: "InternalServerError", message: CANARY } });
    const answer = await h.call("POST", removal(LEAVER));
    expect(answer).toEqual(refusal(409, "MEMBER_ALREADY_REMOVED", MEMBER_REVOKED));
    expect(JSON.stringify(answer)).not.toContain(CANARY); expect(h.lines.join("\n")).not.toContain(CANARY);
    expect(h.lines.filter((line) => line.includes("member_removal.")).map((line) => JSON.parse(line) as unknown))
      .toEqual([{ component: "broker", event: "member_removal.grants_not_removed", level: "error", companyId: A, person: LEAVER }]);
    expect(h.held(A, LEAVER)).toEqual(["alpha:developer"]);
    expect(await h.call("POST", removal(LEAVER))).toEqual(refusal(409, "MEMBER_ALREADY_REMOVED", MEMBER_REVOKED));
    expect(h.held(A, LEAVER)).toEqual([]);
  });

  it("another company's administrator cannot reach the person at all (not found), and nothing of theirs changes", async () => {
    const h = world();
    h.grant(A, LEAVER, "alpha", "developer");
    h.as(OTHER);
    const answer = await h.call("POST", removal(LEAVER), { requestId: randomUUID(), expectedRole: "admin" });
    expect(answer.status).toBe(404);
    expect(h.revoked(LEAVER)).toBe(false); expect(h.held(A, LEAVER)).toEqual(["alpha:developer"]); expect(h.endedAt(LEAVER)).toBeUndefined();
  });

  it("a plain member of the company cannot trigger it (not found), and nothing changes", async () => {
    const h = world();
    h.grant(A, LEAVER, "alpha", "developer");
    h.as(PEER);
    const answer = await h.call("POST", removal(LEAVER), { requestId: randomUUID(), expectedRole: "admin" });
    expect(answer.status).toBe(404);
    expect(h.revoked(LEAVER)).toBe(false); expect(h.held(A, LEAVER)).toEqual(["alpha:developer"]); expect(h.endedAt(LEAVER)).toBeUndefined();
  });
});
