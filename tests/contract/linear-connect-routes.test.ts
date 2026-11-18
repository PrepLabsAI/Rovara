// Guided onboarding PR 7: Linear by OAuth as the app. The routes through the real developer dispatcher, the real connection store over the DynamoDB double, a real AES-GCM
// sealer (the encryption context is its additional data) and a fake Linear behind the fetch seam. Two companies throughout.
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { companyRouteHarness, PERSON, TIME } from "../support/company-route-harness.js";
import { fakeLinear, LINEAR_APP, LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET, LINEAR_REDIRECT, LINEAR_WEBHOOK_SECRET, testSealer, WORKSPACE_A, WORKSPACE_B, WORKSPACE_C, type FakeWorkspace } from "../support/fake-linear-oauth.js";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import {
  LinearConnections, linearConnectionKey, linearStateKey, linearTeamKey, linearWorkspaceKey, LINEAR_NEEDS_RECONNECT, LINEAR_NOT_CONNECTED, REFRESH_LEASE_MS, REFRESH_MARGIN_MS, type LinearAppSettings,
} from "../../packages/broker/src/aws/linear-connections.js";
import {
  routeLinearConnect, CONNECT_ADMIN_ONLY, CONNECT_NOT_SET_UP, DISCONNECT_OWNER_ONLY, DISCONNECT_STEP_UP, LINEAR_OTHER_WORKSPACE, LINEAR_TAKEN, PROJECT_NOT_FOUND, START_AGAIN, TEAM_ADMIN_ONLY, TEAM_NOT_FOUND,
} from "../../packages/broker/src/aws/linear-connect-routes.js";
import { handleLinearAppWebhook, LINEAR_WEBHOOK_WINDOW_MS, WEBHOOK_REFUSED, type LinearProjectEvent } from "../../packages/broker/src/aws/linear-app-webhook.js";
import { linearCompanyApiAccess } from "../../packages/broker/src/aws/linear-wiring.js";
import { LINEAR_SCOPES } from "../../packages/broker/src/aws/linear-oauth-client.js";
import { COMPANY_A_ID as A, COMPANY_B_ID as B } from "../../packages/testing/src/isolation/two-company.js";
import { companyProjectRow } from "../support/company-layout-projects.js";

const PERSON_B = "e".repeat(64);
const PERSON_C = "c".repeat(64);
const BASE = "/v1/dev/company/linear";
type Answer = Record<string, unknown> & { error: { code: string; message: string } };

function world() {
  const h = companyRouteHarness();
  let now = Date.parse(TIME);
  h.deps.now = () => now;
  const linear = fakeLinear(() => now);
  const sealer = testSealer();
  const logs: Array<Record<string, unknown>> = [];
  let app: LinearAppSettings | undefined = { ...LINEAR_APP };
  const settings = async () => app;
  const connections = new LinearConnections({ documentClient: h.db, tableName: "State", sealer, fetch: linear.fetch, now: () => now, app: settings, log: (e) => logs.push(e),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2))) });
  h.deps.companies = companyMembershipFromDynamo(h.db, "SignIn");
  h.deps.developer.linearConnect = { connections, app: settings, fetch: linear.fetch, log: (e) => logs.push(e) };
  const claimsFor = new Map<string, Record<string, unknown>>();
  const as = (personId: string, companyId: string, role: "owner" | "admin" | "member" = "admin", sid = `session-${personId.slice(0, 4)}`) => {
    h.db.set({ ...membershipKey(personId), entityType: "COMPANY_MEMBERSHIP", personId, companyId, role, joinedAt: TIME });
    h.db.set({ pk: `SESSION#${sid}`, sk: "META", developerId: personId, amr: "slack", startedAt: TIME, endsAt: Date.parse(TIME) / 1000 + 86_400 * 60 });
    h.db.set({ pk: `DEVELOPER#${personId}`, sk: "META", displayName: personId === PERSON ? "Ada Admin" : "Bea Admin" });
    h.claims.sub = personId; h.claims.sid = sid; delete h.claims.step_up_at; delete h.claims.step_up_amr; delete h.claims.azp;
  };
  // The web app's sign-in client: only its tokens carry a step-up (developer-routes.ts authenticateCallerWithStepUp), as Cloud's calls do.
  h.db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false,
    installLevel: true, secretHash: "f".repeat(64), fullAccess: true, webApp: true, createdAt: TIME, updatedAt: TIME, updatedBy: "admin" });
  const asWeb = (personId: string, companyId: string, role: "owner" | "admin" | "member") => {
    const sid = `web-${personId.slice(0, 4)}`;
    as(personId, companyId, role, sid);
    h.db.set({ pk: `SESSION#${sid}`, sk: "META", sessionId: sid, developerId: personId, amr: "slack", clientId: "web-app", startedAt: TIME, endsAt: Date.parse(TIME) / 1000 + 86_400 * 60 });
    h.claims.azp = "web-app";
  };
  const web = async (method: string, path: string) => {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const answer = await h.read(path, { method, headers: { authorization: `Bearer ${part({ alg: "none" })}.${part(h.claims)}.sig` } });
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Answer, raw: answer.body };
  };
  const stepUp = (ageSeconds = 30) => { h.claims.step_up_at = Math.floor((now - ageSeconds * 1000) / 1000); h.claims.step_up_amr = "passkey"; };
  h.deps.developer.verifyAccessToken = async (authorization) => claimsFor.get(authorization ?? "") ?? h.claims;
  const call = async (method: string, path: string, body?: unknown, who?: { sub: string; sid: string }) => {
    const authorization = who === undefined ? undefined : `Bearer ${who.sub}.${who.sid}`;
    if (who !== undefined) claimsFor.set(authorization!, { ...h.claims, ...who });
    const answer = await h.read(path, { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }), headers: authorization === undefined ? {} : { authorization } });
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Answer, raw: answer.body };
  };
  const start = () => call("POST", `${BASE}/connect`, {});
  const complete = (body: unknown) => call("POST", `${BASE}/complete`, body);
  /** The whole connect: start, Linear's consent for `workspace`, complete. */
  const connect = async (workspace: FakeWorkspace) => {
    const started = await start();
    const code = linear.approve(started.body.authorizeUrl as string, workspace);
    return complete({ state: started.body.state, code });
  };
  const projectOf = (name: string, companyId: string, grants: Array<{ personId: string; role: "administrator" | "developer" }> = []) => {
    h.db.set({ pk: `PROJECT#${name}`, sk: "REV#000000000001", entityType: "PROJECT", definition: { name, revision: 1 }, companyId });
    h.db.set(companyProjectRow(companyId, name, 1)); // DEC 254zzz80: a named company's project readers read its own partition
    for (const grant of grants) h.db.set({ pk: `MEMBER#${grant.personId}`, sk: `PROJECT#${name}`, projectName: name, role: grant.role, companyId });
  };
  const stored = () => JSON.stringify([...h.db.items.values()]);
  return { ...h, linear, sealer, logs, connections, as, asWeb, web, stepUp, call, start, complete, connect, projectOf, stored, setApp: (value: LinearAppSettings | undefined) => { app = value; },
    tick: (ms: number) => { now += ms; }, now: () => now };
}

const refused = (answer: { status: number; body: Answer }) => ({ status: answer.status, error: answer.body.error });
const startAgain = { status: 403, error: { code: "FORBIDDEN", message: START_AGAIN } };

describe("connect start", () => {
  it("an admin gets a single-use state (stored only as its hash) and Linear's consent address: actor=app, the four scopes, consent, PKCE S256, Cloud's callback", async () => {
    const w = world(); w.as(PERSON, A);
    const answer = await w.start();
    expect(answer.status).toBe(200);
    const state = answer.body.state as string;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const url = new URL(answer.body.authorizeUrl as string);
    expect(`${url.origin}${url.pathname}`).toBe("https://linear.app/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: LINEAR_CLIENT_ID, redirect_uri: LINEAR_REDIRECT, response_type: "code", scope: "read,write,comments:create,issues:create", state, actor: "app", prompt: "consent",
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as string, code_challenge_method: "S256",
    });
    expect(LINEAR_SCOPES).not.toContain("admin");
    expect(LINEAR_SCOPES).toEqual(["read", "write", "comments:create", "issues:create"]);
    expect(answer.body.expiresAt).toBe(new Date(Date.parse(TIME) + 600_000).toISOString());
    expect(w.db.get(linearStateKey(state).pk, "META")).toMatchObject({ companyId: A, personId: PERSON, provider: "linear", status: "live", indexExpiresAt: Date.parse(TIME) / 1000 + 600 + 86_400 });
    expect(w.stored()).not.toContain(state);
    expect(answer.raw).not.toContain(LINEAR_CLIENT_SECRET);
  });
  it("an owner may start; a plain member is refused", async () => {
    const w = world(); w.as(PERSON, A, "owner"); expect((await w.start()).status).toBe(200);
    w.as(PERSON, A, "member");
    expect(refused(await w.start())).toEqual({ status: 403, error: { code: "FORBIDDEN", message: CONNECT_ADMIN_ONLY } });
  });
  it("says it isn't set up when the app's settings are missing", async () => {
    const w = world(); w.as(PERSON, A); w.setApp(undefined);
    expect(refused(await w.start())).toEqual({ status: 503, error: { code: "RUNTIME_UNAVAILABLE", message: CONNECT_NOT_SET_UP } });
  });
  it("is unknown without the company layer or the wiring, before anyone is authenticated", async () => {
    const w = world(); w.as(PERSON, A);
    delete w.deps.developer.linearConnect;
    expect((await w.start()).status).toBe(404);
    const v = world(); v.as(PERSON, A); delete v.deps.companies;
    expect((await v.start()).status).toBe(404);
  });
});

describe("complete", () => {
  it("binds the workspace, stores both tokens only sealed under the company, writes an audit row naming the person, and answers no token", async () => {
    const w = world(); w.as(PERSON, A);
    const answer = await w.connect(WORKSPACE_A);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ status: "connected", reconnected: false, workspace: { id: WORKSPACE_A.id, name: "Acme Linear", urlKey: "acme" } });
    expect(w.db.get(linearWorkspaceKey(WORKSPACE_A.id).pk, "BINDING")).toMatchObject({ companyId: A, boundBy: PERSON });
    const row = w.db.get(linearConnectionKey(A).pk, "META") as Record<string, unknown>;
    expect(row).toMatchObject({ companyId: A, organizationId: WORKSPACE_A.id, status: "connected", connectedBy: PERSON, version: 1 });
    const grant = w.linear.grants[0]!;
    expect(w.stored()).not.toContain(grant.current);
    for (const access of grant.access) { expect(w.stored()).not.toContain(access); expect(answer.raw).not.toContain(access); }
    const audits = [...w.db.items.values()].filter((item) => (item as { entityType?: string }).entityType === "LINEAR_CONNECTION_AUDIT");
    expect(audits).toEqual([expect.objectContaining({ companyId: A, action: "connect", actor: PERSON, organizationId: WORKSPACE_A.id })]);
    expect(w.logs).toContainEqual(expect.objectContaining({ companyId: A, event: "linear.connection_bound", actor: PERSON }));
    const status = await w.call("GET", BASE);
    expect(Object.keys(status.body).sort()).toEqual(["connectedAt", "connectedBy", "requestId", "status", "statusAt", "workspace"]);
    expect(Object.keys(status.body.workspace as object).sort()).toEqual(["id", "name", "urlKey"]);
    expect(status.body).toMatchObject({ status: "connected", workspace: { name: "Acme Linear" }, connectedAt: TIME, connectedBy: { personId: PERSON, name: "Ada Admin" } });
    expect(status.raw).not.toMatch(/tok_/);
  });
  it("every refusal before the exchange is one answer: member, malformed body, unknown, used, expired, other session, other person, other company", async () => {
    const w = world(); w.as(PERSON, A);
    const first = await w.start();
    const code = w.linear.approve(first.body.authorizeUrl as string, WORKSPACE_A);
    w.as(PERSON, A, "member");
    expect(refused(await w.complete({ state: first.body.state, code }))).toEqual(startAgain);
    w.as(PERSON, A);
    for (const body of [{}, { state: first.body.state }, { state: "short", code }, { state: first.body.state, code, extra: 1 }, "not json", { state: first.body.state, code: "bad code!" }]) {
      expect(refused(await w.complete(body))).toEqual(startAgain);
    }
    expect(refused(await w.complete({ state: "A".repeat(43), code }))).toEqual(startAgain);
    // Another session of the same person, another person of the same company, a person of another company.
    w.db.set({ pk: "SESSION#other-session", sk: "META", developerId: PERSON, amr: "slack", startedAt: TIME, endsAt: Date.parse(TIME) / 1000 + 86_400 });
    expect(refused(await w.call("POST", `${BASE}/complete`, { state: first.body.state, code }, { sub: PERSON, sid: "other-session" }))).toEqual(startAgain);
    w.as(PERSON_C, A); w.as(PERSON, A);
    expect(refused(await w.call("POST", `${BASE}/complete`, { state: first.body.state, code }, { sub: PERSON_C, sid: "session-cccc" }))).toEqual(startAgain);
    w.as(PERSON_B, B); w.as(PERSON, A);
    expect(refused(await w.call("POST", `${BASE}/complete`, { state: first.body.state, code }, { sub: PERSON_B, sid: "session-eeee" }))).toEqual(startAgain);
    // The store itself, with the starter's own session: another person, another company, never spend it (only the company and person checks can refuse these).
    const starter = { companyId: A, personId: PERSON, sessionId: "session-dddd" };
    expect(await w.connections.spendState(first.body.state as string, { ...starter, personId: PERSON_C })).toBeUndefined();
    expect(await w.connections.spendState(first.body.state as string, { ...starter, companyId: B })).toBeUndefined();
    // Still live after all that: the owner's own completes once, and only once (a FRESH code from Linear for the same state, so only the state's single use can refuse it).
    expect((await w.complete({ state: first.body.state, code })).status).toBe(200);
    const again = w.linear.approve(first.body.authorizeUrl as string, WORKSPACE_A);
    expect(refused(await w.complete({ state: first.body.state, code: again }))).toEqual(startAgain);
    expect(await w.connections.spendState(first.body.state as string, starter)).toBeUndefined();
    // Expired.
    const late = await w.start();
    const lateCode = w.linear.approve(late.body.authorizeUrl as string, WORKSPACE_A);
    w.tick(600_001);
    expect(refused(await w.complete({ state: late.body.state, code: lateCode }))).toEqual(startAgain);
  });
  it("a code Linear refuses (or one from another start: PKCE) is the same answer, and nothing is stored", async () => {
    const w = world(); w.as(PERSON, A);
    const one = await w.start(); const two = await w.start();
    const codeForOne = w.linear.approve(one.body.authorizeUrl as string, WORKSPACE_A);
    // The code was issued for start one's challenge: start two's verifier does not match it.
    expect(refused(await w.complete({ state: two.body.state, code: codeForOne }))).toEqual(startAgain);
    expect(refused(await w.complete({ state: one.body.state, code: "neverissued" }))).toEqual(startAgain);
    expect(w.db.get(linearConnectionKey(A).pk, "META")).toBeUndefined();
  });
  it("reads the live membership at every call: a revoked membership, or one in another company than the resolved one, is 401", async () => {
    const w = world(); w.as(PERSON, A);
    const ctx = { documentClient: w.db, signInTableName: "SignIn", now: w.now, wiring: w.deps.developer.linearConnect!, projectInCompany: async () => true, projectRole: async () => undefined };
    const caller = { developerId: PERSON, sessionId: "session-dddd", amr: "slack", name: "Ada" } as Parameters<typeof routeLinearConnect>[1];
    const request = { method: "GET", path: BASE, headers: {}, requestId: "r" };
    const url = new URL(BASE, "https://broker.example.test");
    await expect(routeLinearConnect(ctx, caller, A, request, url)).resolves.toEqual({ status: "disconnected" });
    await expect(routeLinearConnect(ctx, caller, B, request, url)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    w.db.set({ ...membershipKey(PERSON), entityType: "COMPANY_MEMBERSHIP", personId: PERSON, companyId: A, role: "owner", joinedAt: TIME, revokedAt: TIME });
    await expect(routeLinearConnect(ctx, caller, A, request, url)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
  it("re-reads the role at complete: a person demoted after start is refused", async () => {
    const w = world(); w.as(PERSON, A);
    const started = await w.start();
    const code = w.linear.approve(started.body.authorizeUrl as string, WORKSPACE_A);
    w.db.set({ ...membershipKey(PERSON), entityType: "COMPANY_MEMBERSHIP", personId: PERSON, companyId: A, role: "member", joinedAt: TIME });
    expect(refused(await w.complete({ state: started.body.state, code }))).toEqual(startAgain);
  });
});

describe("two companies", () => {
  it("B connecting A's workspace is refused after the exchange: the new tokens are revoked and nothing is stored for B; A is untouched", async () => {
    const w = world(); w.as(PERSON, A);
    expect((await w.connect(WORKSPACE_A)).status).toBe(200);
    const before = JSON.stringify(w.db.get(linearConnectionKey(A).pk, "META"));
    w.as(PERSON_B, B);
    const answer = await w.connect(WORKSPACE_A);
    expect(refused(answer)).toEqual({ status: 409, error: { code: "LINEAR_WORKSPACE_TAKEN", message: LINEAR_TAKEN } });
    const bGrant = w.linear.grants[1]!;
    expect(bGrant.revoked).toBe(true);
    expect(w.linear.revoked).toEqual(expect.arrayContaining([...bGrant.access]));
    expect(w.db.get(linearConnectionKey(B).pk, "META")).toBeUndefined();
    expect(w.db.get(linearWorkspaceKey(WORKSPACE_A.id).pk, "BINDING")).toMatchObject({ companyId: A });
    expect(JSON.stringify(w.db.get(linearConnectionKey(A).pk, "META"))).toBe(before);
    expect(answer.raw).not.toContain(WORKSPACE_A.name);
  });
  it("a company already connected to one workspace cannot connect another (revoked, nothing changed)", async () => {
    const w = world(); w.as(PERSON, A);
    await w.connect(WORKSPACE_A);
    const answer = await w.connect(WORKSPACE_C);
    expect(refused(answer)).toEqual({ status: 409, error: { code: "LINEAR_WORKSPACE_TAKEN", message: LINEAR_OTHER_WORKSPACE } });
    expect(w.linear.grants[1]!.revoked).toBe(true);
    expect(w.db.get(linearWorkspaceKey(WORKSPACE_C.id).pk, "BINDING")).toBeUndefined();
    expect(w.db.get(linearConnectionKey(A).pk, "META")).toMatchObject({ organizationId: WORKSPACE_A.id });
  });
  it("A's token is never used for B's projects: each company's calls carry only its own token, and a sealed token moved to another company does not open", async () => {
    const w = world(); w.as(PERSON, A); await w.connect(WORKSPACE_A);
    w.as(PERSON_B, B); await w.connect(WORKSPACE_B);
    const [aGrant, bGrant] = w.linear.grants;
    w.linear.requests.length = 0;
    const access = linearCompanyApiAccess(w.connections, B, w.linear.fetch);
    await access.readIssue!(B, "WEB-1").catch(() => undefined);
    const graph = w.linear.requests.filter((r) => r.url === "https://api.linear.app/graphql");
    expect(graph.length).toBeGreaterThan(0);
    for (const request of graph) expect([...bGrant!.access].map((t) => `Bearer ${t}`)).toContain(request.authorization);
    // Moving A's sealed tokens into B's record: they do not open under B's context.
    const aRow = w.db.get(linearConnectionKey(A).pk, "META") as Record<string, unknown>;
    const bRow = w.db.get(linearConnectionKey(B).pk, "META") as Record<string, unknown>;
    w.db.set({ ...bRow, sealedAccess: aRow.sealedAccess });
    await expect(w.connections.accessToken(B)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    void aGrant;
  });
  it("A cannot pick a team with B's connection: only A's own workspace's teams are offered or accepted", async () => {
    const w = world(); w.as(PERSON, A); await w.connect(WORKSPACE_A);
    w.projectOf("alpha", A);
    w.as(PERSON_B, B); await w.connect(WORKSPACE_B);
    w.as(PERSON, A);
    const listed = await w.call("GET", `${BASE}/projects/alpha`);
    expect(listed.body.teams).toEqual(WORKSPACE_A.teams);
    expect(refused(await w.call("PUT", `${BASE}/projects/alpha`, { teamId: WORKSPACE_B.teams[0]!.id }))).toEqual({ status: 404, error: { code: "NOT_FOUND", message: TEAM_NOT_FOUND } });
    expect(w.db.get(linearTeamKey(A, "alpha").pk, "PROJECT#alpha")).toBeUndefined();
  });
});

describe("refresh", () => {
  const expire = (w: ReturnType<typeof world>) => w.tick(86_400_000 - REFRESH_MARGIN_MS + 1);
  it("refreshes before the access token ends, storing the ROTATED refresh token sealed", async () => {
    const w = world(); w.as(PERSON, A); await w.connect(WORKSPACE_A);
    const fresh = await w.connections.accessToken(A);
    expect(w.linear.refreshCalls).toBe(0);
    expire(w);
    const next = await w.connections.accessToken(A);
    expect(next).not.toBe(fresh);
    expect(w.linear.refreshCalls).toBe(1);
    expect(w.linear.validAccess(next)).toBe(true);
    expect(w.db.get(linearConnectionKey(A).pk, "META")).toMatchObject({ version: 2 });
    expect(w.stored()).not.toContain(w.linear.grants[0]!.current);
  });
  it("two concurrent refreshers: one refresh at Linear, both get the same valid token, exactly one valid refresh token stored", async () => {
    const w = world(); w.as(PERSON, A); await w.connect(WORKSPACE_A);
    expire(w);
    const [one, two] = await Promise.all([w.connections.accessToken(A), w.connections.accessToken(A)]);
    expect(one).toBe(two);
    expect(w.linear.refreshCalls).toBe(1);
    expect(await storedRefresh(w)).toBe(w.linear.grants[0]!.current);
  });
  it("a refresher whose lease ended while Linear answered discards what it got; the stored refresh token is the one Linear will keep accepting", async () => {
    const w = world(); w.as(PERSON, A); await w.connect(WORKSPACE_A);
    expire(w);
    const release = w.linear.holdNextRefresh();
    const slow = w.connections.accessToken(A);
    await waitFor(() => w.linear.refreshCalls === 1);
    w.tick(REFRESH_LEASE_MS + 1);
    // The second refresher takes the lease over and refreshes with the OLD refresh token (inside Linear's 30-minute retry window).
    const second = await w.connections.accessToken(A);
    release();
    const first = await slow;
    expect(first).toBe(second);
    expect(w.linear.refreshCalls).toBe(2);
    expect(await storedRefresh(w)).toBe(w.linear.grants[0]!.current);
    // Past the retry window, the stored one still refreshes.
    w.tick(31 * 60_000 + 86_400_000);
    expect(w.linear.validAccess(await w.connections.accessToken(A))).toBe(true);
  });
  it("Linear refusing the refresh marks the connection needs_reconnect, drops the tokens, and every use says so; reconnecting restores it", async () => {
    const w = world(); w.as(PERSON, A); await w.connect(WORKSPACE_A);
    w.projectOf("alpha", A);
    w.linear.revokeGrantOf(WORKSPACE_A);
    expire(w);
    await expect(w.connections.accessToken(A)).rejects.toMatchObject({ code: "LINEAR_NOT_CONNECTED" });
    const row = w.db.get(linearConnectionKey(A).pk, "META") as Record<string, unknown>;
    expect(row).toMatchObject({ status: "needs_reconnect" });
    expect(row.sealedAccess).toBeUndefined(); expect(row.sealedRefresh).toBeUndefined();
    expect([...w.db.items.values()]).toContainEqual(expect.objectContaining({ entityType: "LINEAR_CONNECTION_AUDIT", action: "needs_reconnect", actor: "linear" }));
    expect((await w.call("GET", BASE)).body.status).toBe("needs_reconnect");
    expect(refused(await w.call("GET", `${BASE}/projects/alpha`))).toEqual({ status: 409, error: { code: "LINEAR_NOT_CONNECTED", message: LINEAR_NEEDS_RECONNECT } });
    const again = await w.connect(WORKSPACE_A);
    expect(again.body).toMatchObject({ status: "connected", reconnected: true });
    // A reconnect over a still-stored pair revokes the pair it replaces.
    const third = await w.connect(WORKSPACE_A);
    expect(third.body).toMatchObject({ reconnected: true });
    const replaced = w.linear.grants[w.linear.grants.length - 2]!;
    expect(replaced.revoked).toBe(true);
    expect(w.linear.grants[w.linear.grants.length - 1]!.revoked).toBe(false);
    expect((await w.call("GET", BASE)).body.status).toBe("connected");
  });
  it("a store blip while writing the rotated pair is retried under the same lease, so the rotated refresh token is not lost", async () => {
    const w = world(); w.as(PERSON, A); await w.connect(WORKSPACE_A);
    expire(w);
    let blips = 2;
    const db = { send: async (command: unknown) => {
      const input = (command as { input?: { UpdateExpression?: string } }).input;
      if (blips > 0 && input?.UpdateExpression?.startsWith("SET sealedAccess") === true) { blips--; throw Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" }); }
      return w.db.send(command as never);
    } };
    const flaky = new LinearConnections({ documentClient: db, tableName: "State", sealer: w.sealer, fetch: w.linear.fetch, now: w.now, app: async () => ({ ...LINEAR_APP }), log: () => undefined });
    const access = await flaky.accessToken(A);
    expect(w.linear.validAccess(access)).toBe(true);
    expect(await storedRefresh(w)).toBe(w.linear.grants[0]!.current);
    expect((w.db.get(linearConnectionKey(A).pk, "META") as Record<string, unknown>).leaseId).toBeUndefined();
  });
  it("a write that never lands gives the lease back and says unavailable", async () => {
    const w = world(); w.as(PERSON, A); await w.connect(WORKSPACE_A);
    expire(w);
    const db = { send: async (command: unknown) => {
      if ((command as { input?: { UpdateExpression?: string } }).input?.UpdateExpression?.startsWith("SET sealedAccess") === true) throw Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" });
      return w.db.send(command as never);
    } };
    const flaky = new LinearConnections({ documentClient: db, tableName: "State", sealer: w.sealer, fetch: w.linear.fetch, now: w.now, app: async () => ({ ...LINEAR_APP }), log: () => undefined });
    await expect(flaky.accessToken(A)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect((w.db.get(linearConnectionKey(A).pk, "META") as Record<string, unknown>).leaseId).toBeUndefined();
  });
  it("a misconfigured app (invalid_client) or Linear down is unavailable, never needs_reconnect", async () => {
    const w = world(); w.as(PERSON, A); await w.connect(WORKSPACE_A);
    expire(w);
    w.setApp({ ...LINEAR_APP, clientSecret: "wrong-secret-value" });
    await expect(w.connections.accessToken(A)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.db.get(linearConnectionKey(A).pk, "META")).toMatchObject({ status: "connected" });
    expect((w.db.get(linearConnectionKey(A).pk, "META") as Record<string, unknown>).leaseId).toBeUndefined();
  });
});

describe("team pick", () => {
  it("an admin lists the teams and sets one; the project's own admin may too; a developer is refused; no grant, another company's or a missing project are the same 404", async () => {
    const w = world(); w.as(PERSON, A); await w.connect(WORKSPACE_A);
    w.as(PERSON_C, A, "member");
    w.projectOf("alpha", A, [{ personId: PERSON_C, role: "administrator" }]);
    w.projectOf("beta", A, [{ personId: PERSON_C, role: "developer" }]);
    w.projectOf("gamma", A);
    w.projectOf("other", B, [{ personId: PERSON_C, role: "administrator" }]);
    const set = await w.call("PUT", `${BASE}/projects/alpha`, { teamId: "team-a-eng" });
    expect(set.body).toMatchObject({ project: "alpha", team: { id: "team-a-eng", key: "ENG", name: "Engineering" } });
    expect(w.db.get(linearTeamKey(A, "alpha").pk, "PROJECT#alpha")).toMatchObject({ companyId: A, teamId: "team-a-eng", setBy: PERSON_C });
    expect((await w.call("GET", `${BASE}/projects/alpha`)).body).toMatchObject({ team: { id: "team-a-eng" }, teams: WORKSPACE_A.teams });
    expect(refused(await w.call("PUT", `${BASE}/projects/beta`, { teamId: "team-a-eng" }))).toEqual({ status: 403, error: { code: "FORBIDDEN", message: TEAM_ADMIN_ONLY } });
    for (const name of ["gamma", "other", "missing", "Bad%20Name"]) {
      expect(refused(await w.call("PUT", `${BASE}/projects/${name}`, { teamId: "team-a-eng" }))).toEqual({ status: 404, error: { code: "NOT_FOUND", message: PROJECT_NOT_FOUND } });
    }
    w.as(PERSON, A);
    expect(refused(await w.call("GET", `${BASE}/projects/other`))).toEqual({ status: 404, error: { code: "NOT_FOUND", message: PROJECT_NOT_FOUND } });
    expect((await w.call("PUT", `${BASE}/projects/gamma`, { teamId: "team-a-ops" })).status).toBe(200);
    expect((await w.call("DELETE", `${BASE}/projects/gamma`)).body).toMatchObject({ project: "gamma", team: null, cleared: true });
    expect([...w.db.items.values()]).toContainEqual(expect.objectContaining({ entityType: "LINEAR_CONNECTION_AUDIT", action: "team_set", actor: PERSON_C, project: "alpha" }));
  });
  it("is refused without a connection", async () => {
    const w = world(); w.as(PERSON, A); w.projectOf("alpha", A);
    expect(refused(await w.call("PUT", `${BASE}/projects/alpha`, { teamId: "team-a-eng" }))).toEqual({ status: 409, error: { code: "LINEAR_NOT_CONNECTED", message: LINEAR_NOT_CONNECTED } });
    expect(refused(await w.call("GET", `${BASE}/projects/alpha`))).toEqual({ status: 409, error: { code: "LINEAR_NOT_CONNECTED", message: LINEAR_NOT_CONNECTED } });
  });
});

describe("disconnect", () => {
  it("needs a live owner, then a fresh step-up; then revokes both tokens, unbinds, clears every pick and names the projects", async () => {
    const w = world(); w.as(PERSON, A, "owner"); await w.connect(WORKSPACE_A);
    w.projectOf("alpha", A); w.projectOf("gamma", A);
    await w.call("PUT", `${BASE}/projects/alpha`, { teamId: "team-a-eng" });
    await w.call("PUT", `${BASE}/projects/gamma`, { teamId: "team-a-ops" });
    w.asWeb(PERSON, A, "admin"); w.stepUp();
    expect(refused(await w.web("DELETE", BASE))).toEqual({ status: 403, error: { code: "FORBIDDEN", message: DISCONNECT_OWNER_ONLY } });
    w.asWeb(PERSON, A, "owner");
    expect(refused(await w.web("DELETE", BASE))).toEqual({ status: 403, error: { code: "REAUTH_REQUIRED", message: DISCONNECT_STEP_UP } });
    // The CLI's token never carries a step-up.
    w.as(PERSON, A, "owner"); w.stepUp();
    expect(refused(await w.call("DELETE", BASE))).toEqual({ status: 403, error: { code: "REAUTH_REQUIRED", message: DISCONNECT_STEP_UP } });
    w.asWeb(PERSON, A, "owner"); w.stepUp(11 * 60);
    expect(refused(await w.web("DELETE", BASE))).toEqual({ status: 403, error: { code: "REAUTH_REQUIRED", message: DISCONNECT_STEP_UP } });
    expect(w.db.get(linearConnectionKey(A).pk, "META")).toBeDefined();
    w.stepUp();
    const grant = w.linear.grants[0]!;
    const answer = await w.web("DELETE", BASE);
    expect(answer.body).toMatchObject({ status: "disconnected", workspaceName: "Acme Linear", projects: ["alpha", "gamma"] });
    expect(grant.revoked).toBe(true);
    expect(w.linear.revoked.length).toBe(2);
    expect(w.db.get(linearConnectionKey(A).pk, "META")).toBeUndefined();
    expect(w.db.get(linearWorkspaceKey(WORKSPACE_A.id).pk, "BINDING")).toBeUndefined();
    expect(w.db.get(linearTeamKey(A, "alpha").pk, "PROJECT#alpha")).toBeUndefined();
    expect([...w.db.items.values()]).toContainEqual(expect.objectContaining({ entityType: "LINEAR_CONNECTION_AUDIT", action: "disconnect", actor: PERSON }));
    expect((await w.web("GET", BASE)).body).toMatchObject({ status: "disconnected" });
    expect(refused(await w.web("DELETE", BASE))).toEqual({ status: 409, error: { code: "LINEAR_NOT_CONNECTED", message: LINEAR_NOT_CONNECTED } });
    // The workspace is free again: another company may now bind it.
    w.as(PERSON_B, B);
    expect((await w.connect(WORKSPACE_A)).status).toBe(200);
  });

  /** A connected company with one pick, ready for an owner to disconnect; returns the tokens Rovara holds. */
  async function connectedOwner() {
    const w = world(); w.as(PERSON, A, "owner"); await w.connect(WORKSPACE_A);
    w.asWeb(PERSON, A, "owner"); w.stepUp();
    return w;
  }
  const revokeLogs = (w: ReturnType<typeof world>) => w.logs.filter((e) => e.event === "linear.revoke_failed");

  it("revokes the REFRESH token first (token_type_hint=refresh_token) and then the ACCESS token (access_token), because Linear does not say one revoke ends the grant", async () => {
    const w = await connectedOwner();
    expect((await w.web("DELETE", BASE)).body).toMatchObject({ status: "disconnected" });
    expect(w.linear.revokeCalls.map((c) => c.hint)).toEqual(["refresh_token", "access_token"]);
    const [refresh, access] = w.linear.revokeCalls;
    expect(w.linear.isCurrentRefresh(refresh!.token)).toBe(false);
    expect(w.linear.validAccess(access!.token)).toBe(false);
    expect(refresh!.token).not.toBe(access!.token);
    expect(revokeLogs(w)).toEqual([]);
  });
  it("Linear answering 400 (already revoked) counts as done: no failure line, the connection is gone", async () => {
    const w = await connectedOwner(); w.linear.answerRevokeWith(400);
    expect((await w.web("DELETE", BASE)).body).toMatchObject({ status: "disconnected" });
    expect(w.linear.revokeCalls.length).toBe(2);
    expect(revokeLogs(w)).toEqual([]);
    expect(w.db.get(linearConnectionKey(A).pk, "META")).toBeUndefined();
  });
  it("Linear failing (500 or unreachable) never keeps Rovara's tokens: they are deleted first, both revokes are tried, and each failure is one fixed line with no token in it", async () => {
    for (const failure of [500, "down"] as const) {
      const w = await connectedOwner(); w.linear.answerRevokeWith(failure);
      const answer = await w.web("DELETE", BASE);
      expect(answer.body).toMatchObject({ status: "disconnected" });
      expect(w.db.get(linearConnectionKey(A).pk, "META")).toBeUndefined();
      expect(w.linear.revokeCalls.map((c) => c.hint)).toEqual(["refresh_token", "access_token"]);
      expect(revokeLogs(w)).toEqual([{ companyId: A, event: "linear.revoke_failed" }, { companyId: A, event: "linear.revoke_failed" }]);
      const logged = JSON.stringify(w.logs);
      for (const call of w.linear.revokeCalls) expect(logged).not.toContain(call.token);
      expect((await w.web("GET", BASE)).body).toMatchObject({ status: "disconnected" });
    }
  });
  it("disconnects a company with more picks than the routing read's cap, clearing all of them", async () => {
    const w = world(); w.as(PERSON, A, "owner"); await w.connect(WORKSPACE_A);
    for (let i = 0; i < 502; i++) w.db.set({ ...linearTeamKey(A, `p${String(i)}`), entityType: "LINEAR_PROJECT_TEAM", companyId: A, project: `p${String(i)}`, teamId: "team-a-eng", teamKey: "ENG", teamName: "Engineering", setBy: PERSON, setAt: TIME });
    w.asWeb(PERSON, A, "owner"); w.stepUp();
    const answer = await w.web("DELETE", BASE);
    expect(answer.status).toBe(200);
    expect((answer.body.projects as string[]).length).toBe(502);
    expect(w.db.get(linearTeamKey(A, "p501").pk, "PROJECT#p501")).toBeUndefined();
  });
  it("an owner of another company cannot disconnect A's connection (it is always the caller's own)", async () => {
    const w = world(); w.as(PERSON, A); await w.connect(WORKSPACE_A);
    w.asWeb(PERSON_B, B, "owner"); w.stepUp();
    expect(refused(await w.web("DELETE", BASE))).toEqual({ status: 409, error: { code: "LINEAR_NOT_CONNECTED", message: LINEAR_NOT_CONNECTED } });
    expect(w.db.get(linearConnectionKey(A).pk, "META")).toBeDefined();
  });
});

const sign = (raw: string, secret = LINEAR_WEBHOOK_SECRET) => createHmac("sha256", secret).update(Buffer.from(raw, "utf8")).digest("hex");

describe("app webhooks", () => {
  const setup = async () => {
    const w = world(); w.as(PERSON, A); await w.connect(WORKSPACE_A);
    w.projectOf("alpha", A); w.projectOf("gamma", A);
    await w.call("PUT", `${BASE}/projects/alpha`, { teamId: "team-a-eng" });
    await w.call("PUT", `${BASE}/projects/gamma`, { teamId: "team-a-ops" });
    w.as(PERSON_B, B); await w.connect(WORKSPACE_B);
    w.projectOf("bravo", B); await w.call("PUT", `${BASE}/projects/bravo`, { teamId: "team-b-web" });
    const delivered: LinearProjectEvent[] = [];
    const deliver = (body: Record<string, unknown>, options: { secret?: string; raw?: string; headers?: Record<string, string> } = {}) => {
      const raw = options.raw ?? JSON.stringify({ webhookTimestamp: w.now(), ...body });
      return handleLinearAppWebhook({ connections: w.connections, app: async () => ({ ...LINEAR_APP }), now: w.now, deliver: async (event) => { delivered.push(event); }, log: (e) => w.logs.push(e) },
        { rawBody: raw, headers: options.headers ?? { "linear-signature": sign(raw, options.secret) } });
    };
    return { w, delivered, deliver };
  };
  const issue = (organizationId: string, teamId: string, extra: Record<string, unknown> = {}) => ({ type: "Issue", action: "create", organizationId, data: { id: "issue-1", teamId, identifier: "ENG-1" }, ...extra });
  it("routes by the workspace's bound company, then only to that company's projects whose picked team is the event's", async () => {
    const { delivered, deliver } = await setup();
    expect(await deliver(issue(WORKSPACE_A.id, "team-a-eng"))).toEqual({ status: 200, body: { ok: true } });
    expect(delivered.map((e) => [e.companyId, e.project, e.type])).toEqual([[A, "alpha", "Issue"]]);
    await deliver({ type: "Comment", action: "create", organizationId: WORKSPACE_B.id, data: { id: "c1", issue: { id: "i2", teamId: "team-b-web" } } });
    expect(delivered.map((e) => [e.companyId, e.project, e.type])).toEqual([[A, "alpha", "Issue"], [B, "bravo", "Comment"]]);
  });
  it("B's workspace's events never reach A's projects, even naming A's team", async () => {
    const { delivered, deliver } = await setup();
    await deliver(issue(WORKSPACE_B.id, "team-a-eng"));
    expect(delivered).toEqual([]);
  });
  it("an unknown workspace is the same 200 as a delivered one (no oracle), and nothing happens", async () => {
    const { delivered, deliver } = await setup();
    const unknown = await deliver(issue(WORKSPACE_C.id, "team-c-x"));
    const known = await deliver(issue(WORKSPACE_A.id, "team-x-none"));
    expect(unknown).toEqual(known);
    expect(delivered).toEqual([]);
  });
  it("refuses a forged, missing or other-secret signature, a body changed after signing, an old or future timestamp, and a body that is not one", async () => {
    const { w, delivered, deliver } = await setup();
    const no = { status: 401, body: { error: { code: "CALLBACK_FORBIDDEN", message: WEBHOOK_REFUSED } } };
    expect(await deliver(issue(WORKSPACE_A.id, "team-a-eng"), { secret: "someone-elses-secret" })).toEqual(no);
    expect(await deliver(issue(WORKSPACE_A.id, "team-a-eng"), { headers: {} })).toEqual(no);
    expect(await deliver(issue(WORKSPACE_A.id, "team-a-eng"), { headers: { "linear-signature": "0".repeat(64) } })).toEqual(no);
    const raw = JSON.stringify({ webhookTimestamp: w.now(), ...issue(WORKSPACE_A.id, "team-a-eng") });
    expect(await deliver({}, { raw: raw.replace("team-a-eng", "team-a-ops"), headers: { "linear-signature": sign(raw) } })).toEqual(no);
    expect(await deliver({ ...issue(WORKSPACE_A.id, "team-a-eng"), webhookTimestamp: w.now() - LINEAR_WEBHOOK_WINDOW_MS - 1 })).toEqual(no);
    expect(await deliver({ ...issue(WORKSPACE_A.id, "team-a-eng"), webhookTimestamp: w.now() + LINEAR_WEBHOOK_WINDOW_MS + 1 })).toEqual(no);
    expect(await deliver({}, { raw: "not json" })).toEqual(no);
    expect(await deliver({}, { raw: JSON.stringify({ type: "Issue", action: "create", organizationId: WORKSPACE_A.id }) })).toEqual(no);
    expect(await deliver({}, { raw: JSON.stringify({ webhookTimestamp: w.now(), ...issue(WORKSPACE_A.id, "team-a-eng"), pad: "x".repeat(1_048_577) }) })).toEqual(no);
    expect(delivered).toEqual([]);
    // Inside the window, on the edge.
    expect((await deliver({ ...issue(WORKSPACE_A.id, "team-a-eng"), webhookTimestamp: w.now() - LINEAR_WEBHOOK_WINDOW_MS })).status).toBe(200);
  });
  it("a failed signature logs ONE fixed line naming the workspace (never the secret or signature), so a per-workspace signing secret would show quickly; a hostile workspace value is not logged", async () => {
    const { w, deliver } = await setup();
    const failures = () => w.logs.filter((e) => e.event === "linear.webhook_signature_failed");
    expect(await deliver(issue(WORKSPACE_B.id, "team-b-web"), { secret: "someone-elses-secret" })).toMatchObject({ status: 401 });
    expect(failures()).toEqual([{ event: "linear.webhook_signature_failed", organizationId: WORKSPACE_B.id }]);
    const forged = "f".repeat(64);
    await deliver(issue(WORKSPACE_A.id, "team-a-eng"), { headers: { "linear-signature": forged } });
    expect(failures().length).toBe(2);
    await deliver({}, { raw: JSON.stringify({ webhookTimestamp: w.now(), type: "Issue", action: "create", organizationId: "x\nINJECTED line" }), headers: { "linear-signature": forged } });
    await deliver({}, { raw: "not json", headers: { "linear-signature": forged } });
    expect(failures().slice(2)).toEqual([{ event: "linear.webhook_signature_failed" }, { event: "linear.webhook_signature_failed" }]);
    const logged = JSON.stringify(w.logs);
    for (const secret of [LINEAR_WEBHOOK_SECRET, "someone-elses-secret", forged, "INJECTED"]) expect(logged).not.toContain(secret);
    // A delivery that verifies logs no failure.
    const before = failures().length;
    expect((await deliver(issue(WORKSPACE_A.id, "team-a-eng"))).status).toBe(200);
    expect(failures().length).toBe(before);
  });
  it("a replay of a delivered body inside the window is taken once", async () => {
    const { w, delivered, deliver } = await setup();
    const raw = JSON.stringify({ webhookTimestamp: w.now(), ...issue(WORKSPACE_A.id, "team-a-eng") });
    expect((await deliver({}, { raw })).status).toBe(200);
    expect((await deliver({}, { raw })).status).toBe(200);
    expect(delivered).toHaveLength(1);
  });
  it("a delivery whose processing fails is given back (503), so Linear's retry is taken", async () => {
    const { w } = await setup();
    const raw = JSON.stringify({ webhookTimestamp: w.now(), ...issue(WORKSPACE_A.id, "team-a-eng") });
    let fail = true; const seen: string[] = [];
    const run = () => handleLinearAppWebhook({ connections: w.connections, app: async () => ({ ...LINEAR_APP }), now: w.now, log: () => undefined,
      deliver: async (event) => { if (fail) throw new Error("down"); seen.push(event.project); } }, { rawBody: raw, headers: { "linear-signature": sign(raw) } });
    expect((await run()).status).toBe(503);
    fail = false;
    expect((await run()).status).toBe(200);
    expect(seen).toEqual(["alpha"]);
  });
  it("OAuthApp revoked marks the connection disconnected and drops its tokens; later events deliver nothing; another app's revoke is ignored", async () => {
    const { w, delivered, deliver } = await setup();
    await deliver({ type: "OAuthApp", action: "revoked", organizationId: WORKSPACE_A.id, oauthClientId: "someone-elses-app" });
    expect(w.db.get(linearConnectionKey(A).pk, "META")).toMatchObject({ status: "connected" });
    await deliver({ type: "OAuthApp", action: "revoked", organizationId: WORKSPACE_A.id, oauthClientId: LINEAR_CLIENT_ID });
    const row = w.db.get(linearConnectionKey(A).pk, "META") as Record<string, unknown>;
    expect(row).toMatchObject({ status: "disconnected" });
    expect(row.sealedAccess).toBeUndefined(); expect(row.sealedRefresh).toBeUndefined();
    expect([...w.db.items.values()]).toContainEqual(expect.objectContaining({ entityType: "LINEAR_CONNECTION_AUDIT", action: "revoked", actor: "linear", companyId: A }));
    expect(w.db.get(linearConnectionKey(B).pk, "META")).toMatchObject({ status: "connected" });
    await deliver(issue(WORKSPACE_A.id, "team-a-eng"));
    expect(delivered).toEqual([]);
    await expect(w.connections.accessToken(A)).rejects.toMatchObject({ code: "LINEAR_NOT_CONNECTED", message: expect.stringContaining(LINEAR_NOT_CONNECTED) as string });
    w.as(PERSON, A);
    expect((await w.call("GET", BASE)).body.status).toBe("disconnected");
  });
  it("answers 503 (not set up) without the app's settings", async () => {
    const { w } = await setup();
    const raw = JSON.stringify({ webhookTimestamp: w.now(), ...issue(WORKSPACE_A.id, "team-a-eng") });
    expect((await handleLinearAppWebhook({ connections: w.connections, app: async () => undefined, now: w.now, log: () => undefined }, { rawBody: raw, headers: { "linear-signature": sign(raw) } })).status).toBe(503);
  });
});

describe("leaks", () => {
  it("no token, code, state, verifier, client secret or signing secret in any answer, log line or error; the store holds none in the clear", async () => {
    const w = world(); w.as(PERSON, A, "owner");
    const answers: string[] = [];
    const started = await w.start(); answers.push(started.raw);
    const state = started.body.state as string;
    const verifierRequests = () => w.linear.requests.filter((r) => r.url === "https://api.linear.app/oauth/token").map((r) => new URLSearchParams(r.body).get("code_verifier"));
    const code = w.linear.approve(started.body.authorizeUrl as string, WORKSPACE_A);
    answers.push((await w.complete({ state, code })).raw);
    w.projectOf("alpha", A);
    answers.push((await w.call("GET", BASE)).raw, (await w.call("GET", `${BASE}/projects/alpha`)).raw, (await w.call("PUT", `${BASE}/projects/alpha`, { teamId: "team-a-eng" })).raw);
    // Refusals too.
    answers.push((await w.complete({ state, code })).raw);
    w.as(PERSON_B, B); answers.push((await w.connect(WORKSPACE_A)).raw);
    const errors: string[] = [];
    w.tick(86_400_000);
    w.linear.revokeGrantOf(WORKSPACE_A);
    await w.connections.accessToken(A).catch((error: Error) => errors.push(error.message));
    const secrets = [state, code, LINEAR_CLIENT_SECRET, LINEAR_WEBHOOK_SECRET, ...verifierRequests().filter((v): v is string => v !== null),
      ...w.linear.grants.flatMap((g) => [g.current, ...g.access])];
    const everything = [...answers, JSON.stringify(w.logs), ...errors];
    // The state is answered once, to the caller that started (Cloud keeps it beside its cookie); nowhere else.
    for (const secret of secrets) for (const text of everything) if (!(secret === state && text === started.raw)) expect(text).not.toContain(secret);
    const store = w.stored();
    for (const secret of secrets.filter((s) => s !== state)) expect(store).not.toContain(secret);
    expect(store).not.toContain(state);
    expect(store).toContain(createHash("sha256").update(state).digest("hex"));
  });
});

async function storedRefresh(w: ReturnType<typeof world>): Promise<string> {
  const row = w.db.get(linearConnectionKey(A).pk, "META") as { sealedRefresh: string; organizationId: string };
  return w.sealer.open(row.sealedRefresh, { purpose: "linear-connection", companyId: A, organizationId: row.organizationId, field: "refresh" });
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
  if (!condition()) throw new Error("timed out");
}
