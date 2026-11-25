// R1 + L1 (6.1): "Connect your Linear account" (a member links their own Linear account to themselves) and the admin's list of links, through the real developer dispatcher, the real connection store
// over the DynamoDB double, the real link store (memory document store), a real AES-GCM sealer and a fake Linear behind the fetch seam. Two companies throughout. The person is the caller's live
// membership; the account is what Linear says for the code; every refusal before the Linear check is one answer; a link counts only in the workspace the company is connected to.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { companyRouteHarness, TIME } from "../support/company-route-harness.js";
import { fakeLinear, LINEAR_APP, LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET, LINEAR_REDIRECT, testSealer, WORKSPACE_A, WORKSPACE_B, type FakeLinearUser, type FakeWorkspace } from "../support/fake-linear-oauth.js";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { LinearConnections, type LinearAppSettings } from "../../packages/broker/src/aws/linear-connections.js";
import {
  LINK_HAS_ANOTHER, LINK_NOT_SET_UP, LINK_OTHER_WORKSPACE, LINK_START_AGAIN, LINK_TAKEN, LINK_WEB_ONLY, PEOPLE_ADMIN_ONLY,
} from "../../packages/broker/src/aws/linear-account-link-routes.js";
import { DISCONNECT_UNAVAILABLE } from "../../packages/broker/src/aws/linear-connect-routes.js";
import { LINEAR_NOT_CONNECTED } from "../../packages/broker/src/aws/linear-connections.js";
import { linearAccountResolver, linearCommentAuthorResolver, linearLinkResolver } from "../../packages/broker/src/aws/linear-account-links.js";
import { accountLinkAuditPk, accountLinkOf, linkAccount, personAccountLink } from "../../packages/broker/src/core/people/account-links.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { COMPANY_A_ID as A, COMPANY_B_ID as B } from "../../packages/testing/src/isolation/two-company.js";

const ADA = "a".repeat(64), BEA = "b".repeat(64), CAL = "c".repeat(64), ROOT = "f".repeat(64), DEE = "e".repeat(64);
const MAYA: FakeLinearUser = { id: "11111111-0000-4000-8000-000000000001", name: "Maya Lee" };
const NICO: FakeLinearUser = { id: "22222222-0000-4000-8000-000000000002", name: "Nico Park" };
const ME = "/v1/dev/me/tracker-accounts/linear";
const BASE = "/v1/dev/company/linear";
type Answer = Record<string, unknown> & { error: { code: string; message: string } };
const uniform = { status: 403, error: { code: "LINK_START_AGAIN", message: LINK_START_AGAIN } };

function world() {
  const h = companyRouteHarness();
  let now = Date.parse(TIME);
  h.deps.now = () => now;
  const linear = fakeLinear(() => now);
  const sealer = testSealer();
  const logs: Array<Record<string, unknown>> = [];
  let app: LinearAppSettings | undefined = { ...LINEAR_APP };
  const settings = async () => app;
  const links = new MemoryDocumentStore();
  const connections = new LinearConnections({ documentClient: h.db, tableName: "State", sealer, fetch: linear.fetch, now: () => now, app: settings, log: (e) => logs.push(e) });
  h.deps.companies = companyMembershipFromDynamo(h.db, "SignIn");
  h.deps.developer.linearConnect = { connections, app: settings, fetch: linear.fetch, log: (e) => logs.push(e), links };
  const wiring = { connections, links, app: settings, fetch: linear.fetch, log: (e: Record<string, unknown>) => logs.push(e) };
  h.deps.developer.linearLink = wiring;
  h.db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false,
    installLevel: true, secretHash: "f".repeat(64), fullAccess: true, webApp: true, createdAt: TIME, updatedAt: TIME, updatedBy: "admin" });
  const names: Record<string, string> = { [ADA]: "Ada Member", [BEA]: "Bea Member", [CAL]: "Cal Admin", [ROOT]: "Rae Owner", [DEE]: "Dee Other" };
  /** The person signs in, from the web app's client (`web: true`) or any other full-access client. */
  const as = (personId: string, companyId: string, role: "owner" | "admin" | "member" = "member", web = true, sid = `${web ? "web" : "cli"}-${personId.slice(0, 4)}`) => {
    h.db.set({ ...membershipKey(personId), entityType: "COMPANY_MEMBERSHIP", personId, companyId, role, joinedAt: TIME });
    h.db.set({ pk: `SESSION#${sid}`, sk: "META", sessionId: sid, developerId: personId, amr: "slack", ...(web ? { clientId: "web-app" } : {}), startedAt: TIME, endsAt: Date.parse(TIME) / 1000 + 86_400 * 60 });
    h.db.set({ pk: `DEVELOPER#${personId}`, sk: "META", displayName: names[personId] ?? "Someone" });
    h.claims.sub = personId; h.claims.sid = sid;
    if (web) h.claims.azp = "web-app"; else delete h.claims.azp;
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const answer = await h.read(path, { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }), headers: { authorization: `Bearer ${part({ alg: "none" })}.${part(h.claims)}.sig` } });
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Answer, raw: answer.body };
  };
  const connect = async (workspace: FakeWorkspace) => {
    const started = await call("POST", `${BASE}/connect`, {});
    return call("POST", `${BASE}/complete`, { state: started.body.state, code: linear.approve(started.body.authorizeUrl as string, workspace) });
  };
  const start = () => call("POST", `${ME}/link`, {});
  const claim = (body: unknown) => call("POST", `${ME}/link/claim`, body);
  /** One whole link as the signed-in person: start, Linear's own sign-in as `user` in `workspace`, claim. */
  const link = async (workspace: FakeWorkspace, user: FakeLinearUser) => {
    const started = await start();
    return claim({ state: started.body.state, code: linear.approve(started.body.authorizeUrl as string, workspace, user) });
  };
  const stored = () => JSON.stringify([...h.db.items.values()]);
  return { ...h, linear, sealer, logs, connections, links, wiring, as, call, connect, start, claim, link, stored, setApp: (value: LinearAppSettings | undefined) => { app = value; }, tick: (ms: number) => { now += ms; }, now: () => now };
}
type World = ReturnType<typeof world>;

/** Company A (owner ROOT) connected to workspace A, with members ADA and BEA; returns the world signed in as ADA. */
async function connectedWorld(): Promise<World> {
  const w = world();
  w.as(ROOT, A, "owner");
  expect((await w.connect(WORKSPACE_A)).status).toBe(200);
  w.as(ADA, A, "member"); w.as(BEA, A, "member"); w.as(CAL, A, "admin");
  w.as(ADA, A, "member");
  return w;
}
const accountOf = (w: World, company: string, workspace: FakeWorkspace, user: FakeLinearUser) => accountLinkOf(w.links, company, { provider: "linear", tenant: workspace.id, accountId: user.id });

describe("start", () => {
  it("a member gets a single-use state stored only as its hash in its OWN key family, and Linear's consent address: actor=user, scope read only, consent, PKCE S256, the app's callback", async () => {
    const w = await connectedWorld();
    const answer = await w.start();
    expect(answer.status).toBe(200);
    const state = answer.body.state as string;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const url = new URL(answer.body.authorizeUrl as string);
    expect(`${url.origin}${url.pathname}`).toBe("https://linear.app/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: LINEAR_CLIENT_ID, redirect_uri: LINEAR_REDIRECT, response_type: "code", scope: "read", state, actor: "user", prompt: "consent",
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as string, code_challenge_method: "S256",
    });
    expect(answer.body.expiresAt).toBe(new Date(w.now() + 600_000).toISOString());
    const hash = createHash("sha256").update(state).digest("hex");
    expect(w.db.get(`LINEAR_LINK#${hash}`, "META")).toMatchObject({ entityType: "LINEAR_LINK_STATE", companyId: A, personId: ADA, provider: "linear-link", status: "live", sessionId: "web-aaaa" });
    expect(w.db.get(`LINEAR_CONNECT#${hash}`, "META")).toBeUndefined();
    expect(w.stored()).not.toContain(state);
    expect(answer.raw).not.toContain(LINEAR_CLIENT_SECRET);
  });

  it("any member of the company may start; the person's own routes need the web app's client (another full-access client is refused, whatever the route)", async () => {
    const w = await connectedWorld();
    for (const id of [ADA, BEA, CAL, ROOT]) { w.as(id, A, id === ROOT ? "owner" : id === CAL ? "admin" : "member"); expect((await w.start()).status).toBe(200); }
    w.as(ADA, A, "member", false);
    for (const [method, path, body] of [["GET", ME], ["POST", `${ME}/link`, {}], ["POST", `${ME}/link/claim`, { state: "x".repeat(43), code: "c" }], ["DELETE", ME]] as const) {
      const answer = await w.call(method, path, body);
      expect({ status: answer.status, code: answer.body.error.code, message: answer.body.error.message }, `${method} ${path}`).toEqual({ status: 403, code: "FORBIDDEN", message: LINK_WEB_ONLY });
    }
  });

  it("needs the company's connection: none, or one that needs reconnecting, is the connection's own refusal; the app's settings missing says it isn't set up", async () => {
    const w = world(); w.as(ADA, A, "member");
    expect(await w.start()).toMatchObject({ status: 409, body: { error: { code: "LINEAR_NOT_CONNECTED", message: LINEAR_NOT_CONNECTED } } });
    const v = await connectedWorld();
    v.setApp(undefined);
    expect(await v.start()).toMatchObject({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: LINK_NOT_SET_UP } } });
  });

  it("refuses a body, a removed member, and a session that is not a sign-in session; unknown without the wiring or the company layer", async () => {
    const w = await connectedWorld();
    expect((await w.call("POST", `${ME}/link`, { companyId: B })).status).toBe(400);
    w.db.set({ ...membershipKey(ADA), entityType: "COMPANY_MEMBERSHIP", personId: ADA, companyId: A, role: "member", joinedAt: TIME, revokedAt: TIME });
    expect((await w.start()).status).toBe(401);
    const v = await connectedWorld(); delete v.deps.developer.linearLink;
    expect((await v.start()).status).toBe(404);
    const x = await connectedWorld(); delete x.deps.companies;
    expect((await x.start()).status).toBe(404);
  });
});

describe("claim", () => {
  it("links the account Linear names for the code, in the company's workspace; the answer, the stored rows and the logs carry no token, code or state; the user token is not revoked yet (plan change 6)", async () => {
    const w = await connectedWorld();
    const answer = await w.link(WORKSPACE_A, MAYA);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ status: "linked", alreadyLinked: false, account: { display: "Maya Lee" } });
    expect(await accountOf(w, A, WORKSPACE_A, MAYA)).toMatchObject({ personId: ADA, tenant: WORKSPACE_A.id, accountId: MAYA.id, display: "Maya Lee", via: "self" });
    expect(await personAccountLink(w.links, A, ADA, "linear")).toMatchObject({ accountId: MAYA.id });
    // The audit row names the person and the provider, never the Linear id or name; the ledger row is in the same transaction as the link.
    const audit = (await w.links.query({ pk: accountLinkAuditPk(A) })).items;
    expect(audit.map((row) => [row["action"], row["provider"], row["personId"], row["by"]])).toEqual([["tracker.account_linked", "linear", ADA, "self"]]);
    expect(JSON.stringify(audit)).not.toContain(MAYA.id);
    expect(JSON.stringify(audit)).not.toContain("Maya");
    const everything = JSON.stringify([w.links, [...w.db.items.values()], w.logs, answer.body]);
    expect(everything).not.toMatch(/access_tok|refresh_tok|code\d/u);
    expect(w.logs).toContainEqual({ companyId: A, event: "tracker.account_linked", provider: "linear", by: "self", actor: ADA });
    // The company's own grant is untouched, and only the one user token read (no revoke call).
    expect(w.linear.revokeCalls).toEqual([]);
    expect((await w.call("GET", ME)).body).toEqual({ connected: true, linked: true, display: "Maya Lee", linkedAt: new Date(w.now()).toISOString(), requestId: "company-test" });
  });

  it("every refusal before the Linear check is the ONE answer: bad body, unknown, spent, expired, another person's, another session's, another company's, and the OTHER flow's state", async () => {
    const w = await connectedWorld();
    const started = await w.start();
    const state = started.body.state as string;
    const code = () => w.linear.approve(started.body.authorizeUrl as string, WORKSPACE_A, MAYA);
    for (const body of [{}, { state }, { code: "c" }, { state: "short", code: "c" }, { state, code: "bad code" }, { state, code: "c", extra: 1 }, "not json", { state: "x".repeat(43), code: "c" }]) {
      const answer = await w.claim(body);
      expect({ status: answer.status, error: answer.body.error }, JSON.stringify(body)).toEqual(uniform);
    }
    // Another person, another session of the same person, another company: refused, and the state is NOT spent by them.
    w.as(BEA, A, "member"); expect((await w.claim({ state, code: code() })).body.error).toEqual(uniform.error);
    w.as(ADA, A, "member", true, "web-second"); expect((await w.claim({ state, code: code() })).body.error).toEqual(uniform.error);
    w.as(DEE, B, "member"); expect((await w.claim({ state, code: code() })).body.error).toEqual(uniform.error);
    w.as(ADA, A, "member");
    // A company-connection state never works as a link state, and a link state never works as a connection state.
    w.as(ROOT, A, "owner");
    const connectStart = await w.call("POST", `${BASE}/connect`, {});
    const connectState = connectStart.body.state as string;
    w.as(ADA, A, "member");
    expect((await w.claim({ state: connectState, code: w.linear.approve(connectStart.body.authorizeUrl as string, WORKSPACE_A, MAYA) })).body.error).toEqual(uniform.error);
    w.as(ROOT, A, "owner");
    expect((await w.call("POST", `${BASE}/complete`, { state, code: code() })).status).toBe(403);
    // Nothing was linked by any of that, and the right person can still spend the state, once.
    w.as(ADA, A, "member");
    expect(await accountOf(w, A, WORKSPACE_A, MAYA)).toBeUndefined();
    expect((await w.claim({ state, code: code() })).status).toBe(200);
    expect((await w.claim({ state, code: code() })).body.error).toEqual(uniform.error);
    // Expired.
    const late = await w.start(); w.tick(601_000);
    expect((await w.claim({ state: late.body.state, code: w.linear.approve(late.body.authorizeUrl as string, WORKSPACE_A, NICO) })).body.error).toEqual(uniform.error);
    expect(await accountOf(w, A, WORKSPACE_A, NICO)).toBeUndefined();
  });

  it("a code Linear refuses (wrong or used, or another PKCE verifier) is the same answer, and links nothing", async () => {
    const w = await connectedWorld();
    const started = await w.start();
    expect((await w.claim({ state: started.body.state, code: "not-a-real-code" })).body.error).toEqual(uniform.error);
    const other = await w.start();
    // A code approved for ANOTHER start's challenge does not exchange with this start's verifier.
    const foreign = w.linear.approve(other.body.authorizeUrl as string, WORKSPACE_A, MAYA);
    expect((await w.claim({ state: started.body.state, code: foreign })).body.error).toEqual(uniform.error);
    expect(await accountOf(w, A, WORKSPACE_A, MAYA)).toBeUndefined();
  });

  it("an account signed in to ANOTHER workspace than the company's connected one is refused (409 EXTERNAL_ACCOUNT_OTHER_WORKSPACE) and nothing is stored", async () => {
    const w = await connectedWorld();
    const answer = await w.link(WORKSPACE_B, MAYA);
    expect(answer).toMatchObject({ status: 409, body: { error: { code: "EXTERNAL_ACCOUNT_OTHER_WORKSPACE", message: LINK_OTHER_WORKSPACE } } });
    expect(await accountOf(w, A, WORKSPACE_B, MAYA)).toBeUndefined();
    expect(await accountOf(w, A, WORKSPACE_A, MAYA)).toBeUndefined();
    expect((await w.links.query({ pk: accountLinkAuditPk(A) })).items).toEqual([]);
    // A company that is not connected at claim time: the connection's own refusal, nothing stored.
    const started = await w.start();
    w.as(ROOT, A, "owner"); expect((await w.call("DELETE", BASE)).status).toBe(200);
    w.as(ADA, A, "member");
    expect(await w.claim({ state: started.body.state, code: w.linear.approve(started.body.authorizeUrl as string, WORKSPACE_A, MAYA) })).toMatchObject({ status: 409, body: { error: { code: "LINEAR_NOT_CONNECTED" } } });
    expect(await accountOf(w, A, WORKSPACE_A, MAYA)).toBeUndefined();
  });

  it("first link wins: another member claiming the same Linear account is refused (409 EXTERNAL_ACCOUNT_TAKEN) and the first link stands; the same person again is idempotent; a second account for the same person is refused", async () => {
    const w = await connectedWorld();
    expect((await w.link(WORKSPACE_A, MAYA)).status).toBe(200);
    w.as(BEA, A, "member");
    expect(await w.link(WORKSPACE_A, MAYA)).toMatchObject({ status: 409, body: { error: { code: "EXTERNAL_ACCOUNT_TAKEN", message: LINK_TAKEN } } });
    expect((await accountOf(w, A, WORKSPACE_A, MAYA))?.personId).toBe(ADA);
    expect(await personAccountLink(w.links, A, BEA, "linear")).toBeUndefined();
    w.as(ADA, A, "member");
    expect((await w.link(WORKSPACE_A, MAYA)).body).toMatchObject({ status: "linked", alreadyLinked: true });
    expect(await w.link(WORKSPACE_A, NICO)).toMatchObject({ status: 409, body: { error: { code: "EXTERNAL_ACCOUNT_LINK_EXISTS", message: LINK_HAS_ANOTHER } } });
    expect(await accountOf(w, A, WORKSPACE_A, NICO)).toBeUndefined();
    // After the person unlinks, the other member can take the account.
    expect((await w.call("DELETE", ME)).body).toMatchObject({ unlinked: true });
    w.as(BEA, A, "member");
    expect((await w.link(WORKSPACE_A, MAYA)).status).toBe(200);
    expect((await accountOf(w, A, WORKSPACE_A, MAYA))?.personId).toBe(BEA);
  });

  it("company B's links are its own: the same Linear user id in B's workspace is a different link, and A's rows never resolve for B", async () => {
    const w = await connectedWorld();
    expect((await w.link(WORKSPACE_A, MAYA)).status).toBe(200);
    w.as(ROOT, A, "owner"); // keep A's session; company B's owner connects workspace B
    w.as(DEE, B, "owner");
    expect((await w.connect(WORKSPACE_B)).status).toBe(200);
    expect((await w.link(WORKSPACE_B, MAYA)).status).toBe(200);
    expect((await accountOf(w, B, WORKSPACE_B, MAYA))?.personId).toBe(DEE);
    expect(await accountOf(w, B, WORKSPACE_A, MAYA)).toBeUndefined();
    expect((await accountOf(w, A, WORKSPACE_A, MAYA))?.personId).toBe(ADA);
    expect(await accountOf(w, A, WORKSPACE_B, MAYA)).toBeUndefined();
  });

  it("a disconnect that lands while the claim runs takes the new link with it (nothing outlives the connection it was made under)", async () => {
    const w = await connectedWorld();
    const started = await w.start();
    const code = w.linear.approve(started.body.authorizeUrl as string, WORKSPACE_A, MAYA);
    // The connection read AFTER the link was written sees the company already disconnected.
    let reads = 0;
    const real = w.connections.connection.bind(w.connections);
    w.wiring.connections = { ...w.connections, spendLinkState: w.connections.spendLinkState.bind(w.connections), mintLinkState: w.connections.mintLinkState.bind(w.connections),
      connection: async (company: string) => (++reads >= 2 ? undefined : real(company)) } as never;
    const answer = await w.claim({ state: started.body.state, code });
    expect(answer).toMatchObject({ status: 409, body: { error: { code: "LINEAR_NOT_CONNECTED" } } });
    expect(await accountOf(w, A, WORKSPACE_A, MAYA)).toBeUndefined();
    expect(await personAccountLink(w.links, A, ADA, "linear")).toBeUndefined();
  });
});

describe("read and unlink (the person's own)", () => {
  it("reads only the caller's own link; nobody else's, and not a link made in another workspace", async () => {
    const w = await connectedWorld();
    expect((await w.call("GET", ME)).body).toMatchObject({ connected: true, linked: false });
    expect((await w.link(WORKSPACE_A, MAYA)).status).toBe(200);
    w.as(BEA, A, "member");
    expect((await w.call("GET", ME)).body).toMatchObject({ connected: true, linked: false });
    // A stale link from another workspace (cannot come from the writer) does not show.
    await linkAccount(w.links, { companyId: A, provider: "linear", tenant: WORKSPACE_B.id, accountId: NICO.id, personId: BEA, display: "Nico", linkedAt: new Date(w.now()).toISOString() });
    expect((await w.call("GET", ME)).body).toMatchObject({ connected: true, linked: false });
    w.as(DEE, B, "member");
    expect((await w.call("GET", ME)).body).toEqual({ connected: false, linked: false, requestId: "company-test" });
  });

  it("unlinks only the caller's own, writes an audit row naming the person (by self), says so when nothing was linked, and takes no body", async () => {
    const w = await connectedWorld();
    expect((await w.call("DELETE", ME)).body).toMatchObject({ unlinked: false });
    expect((await w.link(WORKSPACE_A, MAYA)).status).toBe(200);
    expect((await w.call("DELETE", ME, { personId: BEA })).status).toBe(400);
    expect((await w.call("DELETE", ME)).body).toMatchObject({ unlinked: true });
    expect(await accountOf(w, A, WORKSPACE_A, MAYA)).toBeUndefined();
    expect((await w.links.query({ pk: accountLinkAuditPk(A) })).items.map((row) => [row["action"], row["personId"], row["actor"], row["by"]])).toEqual([
      ["tracker.account_linked", ADA, ADA, "self"], ["tracker.account_unlinked", ADA, ADA, "self"],
    ]);
    expect(w.logs).toContainEqual({ companyId: A, event: "tracker.account_unlinked", provider: "linear", by: "self", actor: ADA });
  });

  it("no route links or unlinks anyone else: a person id in the path or the body of the person's own routes is refused", async () => {
    const w = await connectedWorld();
    expect((await w.link(WORKSPACE_A, MAYA)).status).toBe(200);
    w.as(BEA, A, "member");
    expect((await w.call("DELETE", `${ME}/${ADA}`)).status).toBe(404);
    expect((await w.call("POST", `${ME}/link`, { personId: ADA })).status).toBe(400);
    expect((await w.call("DELETE", ME, { personId: ADA })).status).toBe(400);
    expect((await accountOf(w, A, WORKSPACE_A, MAYA))?.personId).toBe(ADA);
  });
});

describe("the admin's list and removal", () => {
  it("lists who linked (member name, Linear display text, date) for a company owner or admin only; never the Linear id", async () => {
    const w = await connectedWorld();
    expect((await w.link(WORKSPACE_A, MAYA)).status).toBe(200);
    w.tick(1000);
    w.as(BEA, A, "member"); expect((await w.link(WORKSPACE_A, NICO)).status).toBe(200);
    w.as(ADA, A, "member");
    expect(await w.call("GET", `${BASE}/people`)).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: PEOPLE_ADMIN_ONLY } } });
    expect((await w.call("DELETE", `${BASE}/people/${BEA}`)).status).toBe(403);
    for (const [id, role] of [[CAL, "admin"], [ROOT, "owner"]] as const) {
      w.as(id, A, role, false);
      const answer = await w.call("GET", `${BASE}/people`);
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ connected: true, people: [
        { personId: BEA, name: "Bea Member", display: "Nico Park", linkedAt: expect.any(String) as string },
        { personId: ADA, name: "Ada Member", display: "Maya Lee", linkedAt: expect.any(String) as string },
      ] });
      expect(answer.raw).not.toContain(MAYA.id);
      expect(answer.raw).not.toContain(NICO.id);
    }
    // Company B's admin sees none of company A's.
    w.as(DEE, B, "owner");
    expect((await w.call("GET", `${BASE}/people`)).body).toMatchObject({ connected: false, people: [] });
  });

  it("an admin removes one member's link (audited, by admin); another company's person and a malformed id remove nothing; it takes no body", async () => {
    const w = await connectedWorld();
    expect((await w.link(WORKSPACE_A, MAYA)).status).toBe(200);
    w.as(CAL, A, "admin");
    expect((await w.call("DELETE", `${BASE}/people/not-an-id`)).status).toBe(404);
    expect((await w.call("DELETE", `${BASE}/people/${ADA}`, { x: 1 })).status).toBe(400);
    expect((await w.call("DELETE", `${BASE}/people/${DEE}`)).body).toMatchObject({ unlinked: false });
    expect((await accountOf(w, A, WORKSPACE_A, MAYA))?.personId).toBe(ADA);
    expect((await w.call("DELETE", `${BASE}/people/${ADA}`)).body).toMatchObject({ unlinked: true });
    expect(await accountOf(w, A, WORKSPACE_A, MAYA)).toBeUndefined();
    expect((await w.call("DELETE", `${BASE}/people/${ADA}`)).body).toMatchObject({ unlinked: false });
    const audit = (await w.links.query({ pk: accountLinkAuditPk(A) })).items;
    expect(audit.map((row) => [row["action"], row["personId"], row["actor"], row["by"]])).toContainEqual(["tracker.account_unlinked", ADA, CAL, "admin"]);
    // Company B's admin cannot remove company A's link by naming the person.
    w.as(ADA, A, "member"); expect((await w.link(WORKSPACE_A, MAYA)).status).toBe(200);
    w.as(DEE, B, "owner");
    expect((await w.call("DELETE", `${BASE}/people/${ADA}`)).body).toMatchObject({ unlinked: false });
    expect((await accountOf(w, A, WORKSPACE_A, MAYA))?.personId).toBe(ADA);
  });
});

describe("a company's disconnect", () => {
  it("removes every link first and then the connection; a reconnect to the same workspace revives nothing; the resolver finds nobody", async () => {
    const w = await connectedWorld();
    expect((await w.link(WORKSPACE_A, MAYA)).status).toBe(200);
    w.as(BEA, A, "member"); expect((await w.link(WORKSPACE_A, NICO)).status).toBe(200);
    w.as(ROOT, A, "owner");
    expect((await w.call("DELETE", BASE)).status).toBe(200);
    expect(await accountOf(w, A, WORKSPACE_A, MAYA)).toBeUndefined();
    expect(await accountOf(w, A, WORKSPACE_A, NICO)).toBeUndefined();
    expect(await personAccountLink(w.links, A, ADA, "linear")).toBeUndefined();
    expect((await w.connect(WORKSPACE_A)).status).toBe(200);
    const principalOf = async (company: string, personId: string) => ({ companyId: company, personId, displayName: "x", roles: ["member"], provider: "hosted" }) as never;
    const resolve = linearCommentAuthorResolver({ store: w.links, connections: w.connections, principalOf });
    expect(await resolve(A, { provider: "linear", tenant: "", accountId: MAYA.id })).toBeUndefined();
    expect(await resolve(A, { provider: "linear", tenant: WORKSPACE_A.id, accountId: NICO.id })).toBeUndefined();
    // Another company's links are not touched by A's disconnect.
    w.as(DEE, B, "owner");
    expect((await w.connect(WORKSPACE_B)).status).toBe(200);
    expect((await w.link(WORKSPACE_B, MAYA)).status).toBe(200);
    w.as(ROOT, A, "owner"); expect((await w.call("DELETE", BASE)).status).toBe(200);
    expect((await accountOf(w, B, WORKSPACE_B, MAYA))?.personId).toBe(DEE);
  });

  it("if the links cannot be removed, nothing else changes: the disconnect is refused and the connection stands", async () => {
    const w = await connectedWorld();
    expect((await w.link(WORKSPACE_A, MAYA)).status).toBe(200);
    const real = w.links.query.bind(w.links);
    w.links.query = async () => { throw new Error("store down"); };
    w.as(ROOT, A, "owner");
    expect(await w.call("DELETE", BASE)).toMatchObject({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: DISCONNECT_UNAVAILABLE } } });
    expect((await w.call("GET", BASE)).body).toMatchObject({ status: "connected" });
    expect((await accountOf(w, A, WORKSPACE_A, MAYA))?.personId).toBe(ADA);
    w.links.query = real;
    expect((await w.call("DELETE", BASE)).status).toBe(200);
    expect(await accountOf(w, A, WORKSPACE_A, MAYA)).toBeUndefined();
  });

  it("a Linear-side revoke of the same workspace keeps the links (the binding is kept too); the resolver counts them again after the company reconnects the same workspace", async () => {
    const w = await connectedWorld();
    expect((await w.link(WORKSPACE_A, MAYA)).status).toBe(200);
    await w.connections.markRevoked(WORKSPACE_A.id);
    const principalOf = async (company: string, personId: string) => ({ companyId: company, personId, displayName: "x", roles: ["member"], provider: "hosted" }) as never;
    const resolve = linearAccountResolver({ store: w.links, connections: w.connections, principalOf });
    // While revoked: nobody.
    expect(await resolve(A, { provider: "linear", tenant: WORKSPACE_A.id, accountId: MAYA.id })).toBeUndefined();
    expect((await accountOf(w, A, WORKSPACE_A, MAYA))?.personId).toBe(ADA);
    w.as(ROOT, A, "owner");
    expect((await w.connect(WORKSPACE_A)).body).toMatchObject({ reconnected: true });
    expect((await resolve(A, { provider: "linear", tenant: WORKSPACE_A.id, accountId: MAYA.id }))?.personId).toBe(ADA);
  });
});

describe("the resolver (change 10)", () => {
  it("refuses an empty or other workspace, another provider, a company that is not connected, and a person who is gone; the comment source's resolver stamps an empty one with the connected workspace, and the link resolver says when the link was made", async () => {
    const w = await connectedWorld();
    expect((await w.link(WORKSPACE_A, MAYA)).status).toBe(200);
    let live = true;
    const principalOf = async (company: string, personId: string) => (live && company === A ? ({ companyId: company, personId, displayName: "x", roles: ["member"], provider: "hosted" }) as never : undefined);
    const strict = linearAccountResolver({ store: w.links, connections: w.connections, principalOf });
    const hosted = linearCommentAuthorResolver({ store: w.links, connections: w.connections, principalOf });
    const mine = { provider: "linear", tenant: WORKSPACE_A.id, accountId: MAYA.id };
    expect((await strict(A, mine))?.personId).toBe(ADA);
    expect(await strict(A, { ...mine, tenant: "" })).toBeUndefined();
    expect(await strict(A, { ...mine, tenant: WORKSPACE_B.id })).toBeUndefined();
    expect(await strict(A, { ...mine, provider: "github" })).toBeUndefined();
    expect(await strict(B, mine)).toBeUndefined();
    expect(await strict("not-a-company", mine)).toBeUndefined();
    expect((await hosted(A, { ...mine, tenant: "" }))?.personId).toBe(ADA);
    expect(await hosted(A, { ...mine, tenant: WORKSPACE_B.id })).toBeUndefined();
    expect(await hosted(B, { ...mine, tenant: "" })).toBeUndefined();
    // The link resolver names the person AND when they linked (an act older than that is not their consent).
    const linked = linearLinkResolver({ store: w.links, connections: w.connections, principalOf });
    expect(await linked(A, mine)).toMatchObject({ principal: { personId: ADA }, linkedAt: expect.any(String) as string });
    expect(await linked(A, { ...mine, tenant: "" })).toBeUndefined();
    live = false; expect(await strict(A, mine)).toBeUndefined();
    live = true;
    // A link made in workspace B (a stale or foreign row) is never read for a company connected to workspace A.
    await linkAccount(w.links, { companyId: A, provider: "linear", tenant: WORKSPACE_B.id, accountId: NICO.id, personId: BEA, display: "", linkedAt: new Date(w.now()).toISOString() });
    expect(await hosted(A, { provider: "linear", tenant: "", accountId: NICO.id })).toBeUndefined();
    expect(await strict(A, { provider: "linear", tenant: WORKSPACE_B.id, accountId: NICO.id })).toBeUndefined();
  });
});
