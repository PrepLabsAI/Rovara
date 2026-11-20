// L4-GH2: removing a member from the company takes their GitHub link with it (core/people/github-links.ts, aws/company-member-routes.ts). Through the real developer dispatcher, T3b's real
// member helper and operator, and the real link store (memory document store). Two companies throughout. The cleanup runs only after the removal itself succeeded, is conditional and idempotent,
// never blocks the removal (a failure is logged in fixed words and a repeat of the removal request retries it), and re-adding the person starts with no link.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentXError, type DocumentStore, type OrgId } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { companyMemberActionsThroughLambda } from "../../packages/broker/src/aws/company-member-forwarding.js";
import { routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { companyOperator } from "../../packages/broker/src/developer/company-operator.js";
import { MEMBER_REVOKED } from "../../packages/broker/src/developer/company-member-contract.js";
import { githubLinkOf, githubLinkReaderOver, linkGithubAccount, linkedGithubPerson } from "../../packages/broker/src/core/people/github-links.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const TIME = "2026-11-01T09:00:00.000Z";
const A = COMPANY_A.orgId, B = COMPANY_B.orgId;
const OWNER = "a".repeat(64), ADMIN = "b".repeat(64), MEMBER = "c".repeat(64), PEER = "d".repeat(64), OTHER = "e".repeat(64);
const SESSIONS: Record<string, string> = { [OWNER]: "s-owner", [ADMIN]: "s-admin", [MEMBER]: "s-member", [PEER]: "s-peer", [OTHER]: "s-other" };
const CANARY = "leak-canary-47";
const removal = (id: string) => `/v1/dev/company/members/${id}/removal`;
const refusal = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });
/** DEC 254zzz84 (5): a removal names its request, the role the remover saw, and (default: the remover) who takes over. */
const ROLES: Record<string, string> = { [OWNER]: "owner", [ADMIN]: "admin", [MEMBER]: "member", [PEER]: "member", [OTHER]: "admin" };
const removed = (status: number) => status === 200;

function world(options: { store?: DocumentStore; noWiring?: boolean } = {}) {
  const db = new FakeDynamoDb({ seed: 7 });
  const claims: Record<string, unknown> = { azp: "web-app", env: "test", sub: ADMIN, sid: "s-admin", amr: "slack" };
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false, installLevel: true, secretHash: "f".repeat(64), fullAccess: true, webApp: true, createdAt: TIME, updatedAt: TIME, updatedBy: "admin" });
  const join = (id: string, companyId: string, role: "owner" | "admin" | "member") => {
    db.set({ ...membershipKey(id), entityType: "COMPANY_MEMBERSHIP", personId: id, companyId, role, joinedAt: TIME });
    db.set({ pk: `ORG#${companyId}#MEMBERS`, sk: `MEMBER#${id}`, entityType: "COMPANY_MEMBER_VIEW", personId: id, companyId, role, joinedAt: TIME });
  };
  for (const [id, name] of [[OWNER, "Olive"], [ADMIN, "Ada"], [MEMBER, "Max"], [PEER, "Pat"], [OTHER, "Bea"]] as const) {
    db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "slack", displayName: name, email: `${name.toLowerCase()}@example.test`, revoked: false });
    db.set({ pk: `SESSION#${SESSIONS[id]}`, sk: "META", sessionId: SESSIONS[id], developerId: id, amr: "slack", clientId: "web-app", startedAt: new Date(NOW - 60_000).toISOString(), endsAt: NOW / 1000 + 3600 });
  }
  join(OWNER, A, "owner"); join(ADMIN, A, "admin"); join(MEMBER, A, "member"); join(PEER, A, "member"); join(OTHER, B, "admin");
  const signIn = new CompanySignInStore({ documentClient: db, tableName: "SignIn", now: () => NOW });
  const operate = (event: Record<string, unknown>) => companyOperator({ store: signIn, now: () => NOW, log: () => {} }, event);
  const invoke = async (payload: Uint8Array) => ({ Payload: Buffer.from(JSON.stringify(await operate(JSON.parse(Buffer.from(payload).toString()) as Record<string, unknown>))) });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const links = options.store ?? new MemoryDocumentStore();
  const logs: Array<Record<string, unknown>> = [];
  const deps: DeveloperRouteDependencies = {
    documentClient: db, tableName: "State", now: () => NOW, companies: companyMembershipFromDynamo(db, "SignIn"),
    developer: {
      issuer: "https://signin.example.test", env: "test", methods: { slack: true, oidc: true }, signInTableName: "SignIn",
      verifyAccessToken: async () => claims, channelMembers: async (request) => ({ ok: true, memberOf: request.channelIds }),
      companyMembers: companyMemberActionsThroughLambda({ documentClient: db, tableName: "SignIn", invoke }),
      ...(options.noWiring === true ? {} : { githubLink: { store: links, github: { oauthClient: async () => undefined, githubUserOfCode: async () => { throw new Error("unused"); } }, log: (entry: Record<string, unknown>) => logs.push(entry) } }),
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
  const revoked = (id: string) => (db.get(membershipKey(id).pk, "COMPANY") as { revokedAt?: string } | undefined)?.revokedAt !== undefined;
  const link = (company: OrgId, person: string, accountId: string, login: string) => linkGithubAccount(links, { companyId: company, githubUserId: accountId, login, personId: person, linkedAt: TIME });
  return { db, claims, deps, call, as, revoked, links, logs, link, operate, join };
}

const linkedTo = async (links: DocumentStore, company: OrgId, person: string) => (await githubLinkOf(links, company, person))?.accountId;

describe("removing a member takes their GitHub link with it", () => {

  it("re-adding the person starts with no link: the account is nobody's, the person has none, and the account can be linked again by anyone", async () => {
    const h = world();
    await h.link(A, MEMBER, "7", "max");
    await h.call("POST", removal(MEMBER));
    expect(await h.operate({ kind: "company-member-restore", companyId: A, personId: MEMBER })).toMatchObject({ ok: true });
    expect(h.revoked(MEMBER)).toBe(false);
    expect(await linkedTo(h.links, A, MEMBER)).toBeUndefined();
    const reader = githubLinkReaderOver(h.links);
    expect(await reader.personOf(A, "7")).toBeUndefined();
    expect(await reader.accountOf(A, MEMBER)).toBeUndefined();
    // A first link wins again, from nothing: another member may now take the account, and the re-added person links a different one.
    expect(await h.link(A, PEER, "7", "pat")).toBe("linked");
    expect(await h.link(A, MEMBER, "12", "max-new")).toBe("linked");
  });

  it("a member with no link: the removal succeeds, writes nothing and logs nothing", async () => {
    const h = world();
    const writes = vi.spyOn(h.links, "transact"); const deletes = vi.spyOn(h.links, "delete");
    expect(removed((await h.call("POST", removal(MEMBER))).status)).toBe(true);
    expect(writes).not.toHaveBeenCalled(); expect(deletes).not.toHaveBeenCalled();
    expect(h.logs).toEqual([]);
  });

  it("an account row that names someone else is not removed with this person's (conditional deletes)", async () => {
    const h = world();
    await h.link(A, MEMBER, "7", "max");
    // The account moved to another member after the person row was written (a stale person row remains).
    const { githubAccountKey } = await import("../../packages/broker/src/core/people/github-links.js");
    await h.links.put({ item: { ...githubAccountKey(A, "7"), entityType: "GITHUB_ACCOUNT_LINK", companyId: A, githubUserId: "7", login: "pat", personId: PEER, linkedAt: TIME } });
    expect(removed((await h.call("POST", removal(MEMBER))).status)).toBe(true);
    expect(await linkedGithubPerson(h.links, A, "7")).toBe(PEER);
  });
});

describe("the cleanup never removes a row another member wrote since", () => {
  it("an account row that changed hands between the cleanup's read and its delete stays the other member's", async () => {
    const h = world();
    const { githubAccountKey } = await import("../../packages/broker/src/core/people/github-links.js");
    await h.link(A, MEMBER, "7", "max");
    const remove = h.links.delete.bind(h.links);
    let moved = false;
    h.links.delete = (async (request: Parameters<typeof remove>[0]) => {
      // Once, just before the cleanup's first delete (the account row's): the account now belongs to another member.
      if (!moved) await h.links.put({ item: { ...githubAccountKey(A, "7"), entityType: "GITHUB_ACCOUNT_LINK", companyId: A, githubUserId: "7", login: "pat", personId: PEER, linkedAt: TIME } });
      moved = true;
      return remove(request);
    });
    expect(removed((await h.call("POST", removal(MEMBER))).status)).toBe(true);
    expect(await linkedGithubPerson(h.links, A, "7")).toBe(PEER);
  });
});

/** A store whose deletes and transactions fail until `heal()`, with the cause in the error text (it must never be logged or returned). */
function failingStore() {
  const inner = new MemoryDocumentStore();
  let broken = false;
  const store = new Proxy(inner, { get: (target, field) => {
    const value = (target as unknown as Record<PropertyKey, unknown>)[field];
    if (typeof value !== "function") return value;
    if (field === "delete" || field === "transact") return async (...args: unknown[]) => { if (broken) throw new Error(CANARY); return (value as (...a: unknown[]) => unknown).apply(target, args); };
    return (value as (...a: unknown[]) => unknown).bind(target);
  } }) as DocumentStore;
  return { store, break: () => { broken = true; }, heal: () => { broken = false; } };
}

describe("a failed cleanup never blocks the removal", () => {
  it("the removal still succeeds, the failure is logged in fixed words without the cause, and a repeat of the removal request retries it", async () => {
    const failing = failingStore();
    const h = world({ store: failing.store });
    await h.link(A, MEMBER, "7", "max");
    failing.break();
    expect(removed((await h.call("POST", removal(MEMBER))).status)).toBe(true);
    expect(h.revoked(MEMBER)).toBe(true);
    expect(h.logs).toEqual([{ event: "member_removal.github_link_not_removed", level: "error", companyId: A, person: MEMBER }]);
    expect(JSON.stringify(h.logs)).not.toContain(CANARY);
    failing.heal();
    expect(await linkedTo(h.links, A, MEMBER)).toBe("7");
    // The same request again: the member is already removed (the answer is unchanged), and the leftover link is taken now.
    expect(await h.call("POST", removal(MEMBER))).toEqual(refusal(409, "MEMBER_ALREADY_REMOVED", MEMBER_REVOKED));
    expect(await linkedTo(h.links, A, MEMBER)).toBeUndefined();
    expect(await linkedGithubPerson(h.links, A, "7")).toBeUndefined();
  });

});
