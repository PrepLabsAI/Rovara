import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { E2E_EXECUTOR_COMPILED_ORIGIN, readE2EApplicationProjectContract, type E2ERuntimeAccountRef } from "@agentx/contracts";
import { createExecutorSessionStore } from "../../packages/verifier/src/executor/accounts.js";
import { FormLoginError, type FormLoginDriver, type FormLoginStorageState, type FormRequestContext } from "../../packages/verifier/src/executor/form-login.js";
import { createAccountsExecutorPlan } from "../support/e2e-accounts-fixture.js";

// Task 3.2: the executor's `rovara-form-login/v1`. The store signs each case's account in through the application's own form (a driver stands in for the browser here), keeps the
// storage state for the case, answers API requests through a request context that carries its cookies, and checks that the session is the account the case is bound to.
const signal = new AbortController().signal;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const fixture = createAccountsExecutorPlan();
const applicationId = fixture.compiled.originByApplicationId[0]!.applicationId;
const contract = readE2EApplicationProjectContract(fixture.compiled.runtimeAdmissionContext.selectionInput.sourceSnapshot, applicationId)!;
const refFor = (profileId: string): E2ERuntimeAccountRef => ({ applicationId, profileId, revision: 1, definitionDigest: "8".repeat(64) });
const openFor = (profileId: string, overrides: { applicationId?: string; origin?: string } = {}) => ({ binding: {}, applicationId: overrides.applicationId ?? applicationId, profileId,
  approvedAccountRef: refFor(profileId), origin: overrides.origin ?? E2E_EXECUTOR_COMPILED_ORIGIN });

type SignIn = Parameters<FormLoginDriver["signIn"]>[0];
type Identity = { subjectId: string; tenantId: string; role: string };

/** A stand-in for the application and the browser: it knows the plan's accounts, issues one cookie per sign-in, and answers /api/me and /api/orders.csv for the cookie's account. */
function fakeApplication(options: { failFor?: string; identityOf?: (profileId: string) => Identity; tag?: string } = {}) {
  const signIns: SignIn[] = []; const requests: { token: string; method: string; path: string; body: unknown }[] = []; const disposed: string[] = [];
  const sessions = new Map<string, { profileId: string; identity: Identity }>();
  const identityOf = options.identityOf ?? ((profileId: string) => {
    const profile = contract.accountProfiles.find((item) => item.profileId === profileId)!;
    return { subjectId: `subject-${sha(profileId).slice(0, 12)}`, tenantId: profile.tenantRef, role: profile.roleRef };
  });
  const driver: FormLoginDriver = {
    async signIn(input) {
      signIns.push(input);
      const account = fixture.plan.accounts.find((item) => item.email === input.email && item.password === input.password);
      if (!account || account.profileId === options.failFor) throw new Error(`page said: bad credentials for ${input.email} / ${input.password}`);
      const token = `tok-${options.tag ?? ""}${sha(`${input.email}${signIns.length}`).slice(0, 24)}`;
      sessions.set(token, { profileId: account.profileId, identity: identityOf(account.profileId) });
      const state: FormLoginStorageState = { cookies: [{ name: "sid", value: token, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Strict" }],
        origins: [{ origin: input.origin, localStorage: [{ name: "theme", value: "dark" }] }] };
      return { state, status: 200 };
    },
    async requestContext({ state }): Promise<FormRequestContext> {
      const token = state.cookies.find((cookie) => cookie.name === "sid")!.value;
      return { async request({ method, path, body }) {
        requests.push({ token, method, path, body });
        const session = sessions.get(token);
        const json = (status: number, value: unknown) => ({ status, body: new TextEncoder().encode(JSON.stringify(value)), contentType: "application/json" });
        if (!session) return json(401, { error: "authentication required" });
        if (path === "/api/me") return json(200, session.identity);
        if (path === "/api/orders.csv") return session.identity.role === "owner" ? { status: 200, body: new TextEncoder().encode("id\r\na1\r\n"), contentType: "text/csv" } : json(403, { error: "owner role required" });
        return json(404, {});
      }, async dispose() { disposed.push(token); } };
    },
  };
  return { driver, signIns, requests, disposed };
}
const storeWith = (app: ReturnType<typeof fakeApplication>, extra: { registerSecret?: (value: string) => void; onLoginFailed?: (profileId: string) => void } = {}) =>
  createExecutorSessionStore({ plan: fixture.plan, formLogin: app.driver, ...extra });

describe("the executor's form login (rovara-form-login/v1)", () => {
  it("fills the form of the account's own profile in the compiled origin: its login, its email and its password", async () => {
    const app = fakeApplication(); const store = storeWith(app);
    await store.open(openFor("orders-owner"), signal);
    const account = fixture.plan.accounts.find((item) => item.profileId === "orders-owner")!;
    expect(app.signIns).toHaveLength(1);
    expect(app.signIns[0]).toMatchObject({ origin: E2E_EXECUTOR_COMPILED_ORIGIN, email: account.email, password: account.password,
      login: { kind: "form", path: "/", usernameTestId: "email", passwordTestId: "password", submitTestId: "login-submit", successTestId: "identity" } });
  });

  it("opens three sessions for three accounts in two tenants, each bound to its own profile, tenant and role", async () => {
    const app = fakeApplication(); const store = storeWith(app);
    const opened = new Map<string, Awaited<ReturnType<typeof store.open>>>();
    for (const profileId of ["orders-viewer", "orders-owner", "orders-owner-b"]) opened.set(profileId, await store.open(openFor(profileId), signal));
    expect(new Set([...opened.values()].map((item) => item.sessionRef)).size).toBe(3);
    expect(new Set([...opened.values()].map((item) => item.accountIdDigest)).size).toBe(3);
    const facts = (profileId: string) => store.sessionFacts(opened.get(profileId)!.sessionRef, "service");
    expect(facts("orders-viewer").identity).toMatchObject({ status: 200, tenantId: "tenant-a", role: "viewer" });
    expect(facts("orders-owner").identity).toMatchObject({ status: 200, tenantId: "tenant-a", role: "owner" });
    expect(facts("orders-owner-b").identity).toMatchObject({ status: 200, tenantId: "tenant-b", role: "owner" });
    expect(facts("orders-owner-b").login).toEqual({ status: 200, role: "owner" });
    // Each session is that account's alone: a request made on one session reaches the application with that session's cookie.
    const cookies = new Map<string, string>();
    for (const [profileId, item] of opened) cookies.set(profileId, store.browserStateFor(item.sessionRef).cookies[0]!.value);
    expect(new Set(cookies.values()).size).toBe(3);
    await store.request({ sessionRef: opened.get("orders-viewer")!.sessionRef, origin: E2E_EXECUTOR_COMPILED_ORIGIN, method: "GET", path: "/api/orders.csv" }, signal);
    await store.request({ sessionRef: opened.get("orders-owner")!.sessionRef, origin: E2E_EXECUTOR_COMPILED_ORIGIN, method: "GET", path: "/api/orders.csv" }, signal);
    expect(app.requests.filter((item) => item.path === "/api/orders.csv").map((item) => item.token)).toEqual([cookies.get("orders-viewer"), cookies.get("orders-owner")]);
  });

  it("signs in afresh for every case: two cases of one account get two sessions, two sign-ins and two cookies", async () => {
    const app = fakeApplication(); const store = storeWith(app);
    const first = await store.open(openFor("orders-owner"), signal);
    const second = await store.open(openFor("orders-owner"), signal);
    expect(second.sessionRef).not.toBe(first.sessionRef);
    expect(app.signIns).toHaveLength(2);
    expect(store.browserStateFor(first.sessionRef).cookies[0]!.value).not.toBe(store.browserStateFor(second.sessionRef).cookies[0]!.value);
  });

  it("refuses a session whose identity is another role or tenant than the account profile declares, and reports a failed login", async () => {
    const failed: string[] = [];
    const wrongRole = fakeApplication({ identityOf: (profileId) => ({ subjectId: "s1", tenantId: "tenant-a", role: profileId === "orders-viewer" ? "owner" : "owner" }) });
    await expect(storeWith(wrongRole, { onLoginFailed: (profileId) => failed.push(profileId) }).open(openFor("orders-viewer"), signal)).rejects.toThrow(FormLoginError);
    const wrongTenant = fakeApplication({ identityOf: () => ({ subjectId: "s2", tenantId: "tenant-a", role: "owner" }) });
    await expect(storeWith(wrongTenant, { onLoginFailed: (profileId) => failed.push(profileId) }).open(openFor("orders-owner-b"), signal)).rejects.toThrow(FormLoginError);
    expect(failed).toEqual(["orders-viewer", "orders-owner-b"]);
  });

  it("turns any sign-in failure into a login failure that names the profile only, and tells the host", async () => {
    const failed: string[] = [];
    const app = fakeApplication({ failFor: "orders-viewer" });
    const error = await storeWith(app, { onLoginFailed: (profileId) => failed.push(profileId) }).open(openFor("orders-viewer"), signal).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FormLoginError);
    const account = fixture.plan.accounts.find((item) => item.profileId === "orders-viewer")!;
    const text = `${(error as Error).message}\n${(error as Error).stack ?? ""}\n${JSON.stringify(error)}`;
    expect(text).toContain("orders-viewer");
    expect(text).not.toContain(account.password);
    expect(text).not.toContain(account.email);
    expect(text).not.toContain("bad credentials");
    expect(failed).toEqual(["orders-viewer"]);
  });

  it("also treats an aborted or timed-out sign-in as a login failure", async () => {
    const failed: string[] = [];
    const store = createExecutorSessionStore({ plan: fixture.plan, onLoginFailed: (profileId) => failed.push(profileId),
      formLogin: { signIn: async () => { throw new DOMException("The operation was aborted", "TimeoutError"); }, requestContext: async () => { throw new Error("unused"); } } });
    await expect(store.open(openFor("orders-owner"), signal)).rejects.toThrow(FormLoginError);
    expect(failed).toEqual(["orders-owner"]);
  });

  it("refuses a plan account whose login differs from the one the approved source declares", async () => {
    const app = fakeApplication();
    const tampered = { ...fixture.plan, accounts: fixture.plan.accounts.map((account) => (account.profileId === "orders-owner" && account.login ? { ...account, login: { ...account.login, successTestId: "other" } } : account)) };
    const store = createExecutorSessionStore({ plan: tampered, formLogin: app.driver });
    await expect(store.open(openFor("orders-owner"), signal)).rejects.toThrow(/login/i);
    expect(app.signIns).toHaveLength(0);
  });

  it("refuses an account whose plan entry carries no login while the profile declares one, and a login with no driver", async () => {
    const app = fakeApplication();
    const stripped = { ...fixture.plan, accounts: fixture.plan.accounts.map((account) => { const { login, ...rest } = account; void login; return rest; }) };
    await expect(createExecutorSessionStore({ plan: stripped, formLogin: app.driver }).open(openFor("orders-owner"), signal)).rejects.toThrow(/login/i);
    await expect(createExecutorSessionStore({ plan: fixture.plan }).open(openFor("orders-owner"), signal)).rejects.toThrow(/browser/i);
    expect(app.signIns).toHaveLength(0);
  });

  it("refuses an account open outside the admitted application, origin and account", async () => {
    const app = fakeApplication(); const store = storeWith(app);
    await expect(store.open(openFor("orders-owner", { origin: "http://elsewhere.example" }), signal)).rejects.toThrow();
    await expect(store.open(openFor("orders-owner", { applicationId: "someone-else" }), signal)).rejects.toThrow();
    await expect(store.open({ ...openFor("orders-owner"), profileId: "orders-viewer" }, signal)).rejects.toThrow();
    expect(app.signIns).toHaveLength(0);
  });

  it("gives the case's browser context the cookies and local storage of the context that signed in", async () => {
    const app = fakeApplication(); const store = storeWith(app);
    const { sessionRef } = await store.open(openFor("orders-owner"), signal);
    const state = store.browserStateFor(sessionRef);
    expect(state.cookies).toHaveLength(1);
    expect(state.cookies[0]).toMatchObject({ name: "sid", domain: "127.0.0.1", httpOnly: true, sameSite: "Strict" });
    expect(state.localStorage).toEqual([{ origin: E2E_EXECUTOR_COMPILED_ORIGIN, entries: [{ name: "theme", value: "dark" }] }]);
  });

  it("answers API requests through a request context that carries the session's cookies, and reports the status the application gave", async () => {
    const app = fakeApplication(); const store = storeWith(app);
    const viewer = await store.open(openFor("orders-viewer"), signal);
    const owner = await store.open(openFor("orders-owner"), signal);
    const refused = await store.request({ sessionRef: viewer.sessionRef, origin: E2E_EXECUTOR_COMPILED_ORIGIN, method: "GET", path: "/api/orders.csv", requestId: "r1" }, signal);
    const allowed = await store.request({ sessionRef: owner.sessionRef, origin: E2E_EXECUTOR_COMPILED_ORIGIN, method: "GET", path: "/api/orders.csv" }, signal);
    expect([refused.status, allowed.status]).toEqual([403, 200]);
    expect(refused).toMatchObject({ requestId: "r1", method: "GET", path: "/api/orders.csv", origin: E2E_EXECUTOR_COMPILED_ORIGIN });
    expect(Buffer.from(allowed.body).toString("utf8")).toBe("id\r\na1\r\n");
    await expect(store.request({ sessionRef: owner.sessionRef, origin: "http://elsewhere.example", method: "GET", path: "/api/orders.csv" }, signal)).rejects.toThrow();
    await expect(store.request({ sessionRef: owner.sessionRef, origin: E2E_EXECUTOR_COMPILED_ORIGIN, method: "GET", path: "//elsewhere.example/x" }, signal)).rejects.toThrow();
  });

  it("closes a form session by disposing its request context, once, and refuses it afterwards", async () => {
    const app = fakeApplication(); const store = storeWith(app);
    const { sessionRef } = await store.open(openFor("orders-owner"), signal);
    const token = store.browserStateFor(sessionRef).cookies[0]!.value;
    await expect(store.close(sessionRef, signal)).resolves.toEqual({ confirmed: true });
    await expect(store.close(sessionRef, signal)).resolves.toEqual({ confirmed: true });
    expect(app.disposed).toEqual([token]);
    await expect(store.request({ sessionRef, origin: E2E_EXECUTOR_COMPILED_ORIGIN, method: "GET", path: "/api/me" }, signal)).rejects.toThrow();
  });

  it("registers every cookie value, and local storage values long enough to be tokens, as session secrets before the session is used", async () => {
    const secrets: string[] = [];
    const app = fakeApplication({ tag: "a" }); const store = storeWith(app, { registerSecret: (value) => secrets.push(value) });
    const { sessionRef } = await store.open(openFor("orders-owner"), signal);
    expect(secrets).toContain(store.browserStateFor(sessionRef).cookies[0]!.value);
    // "dark" is a theme, not a token.
    expect(secrets).not.toContain("dark");
  });

  it("registers the cookie of a sign-in even when the identity check then refuses it", async () => {
    const secrets: string[] = [];
    const app = fakeApplication({ identityOf: () => ({ subjectId: "s", tenantId: "tenant-z", role: "owner" }), tag: "b" });
    await expect(storeWith(app, { registerSecret: (value) => secrets.push(value) }).open(openFor("orders-owner"), signal)).rejects.toThrow(FormLoginError);
    expect(secrets.some((value) => value.startsWith("tok-b"))).toBe(true);
  });

  it("describes the session to the ledger as a service session (API) or a browser session once the browser is bound, never with a credential", async () => {
    const app = fakeApplication(); const store = storeWith(app);
    const { sessionRef } = await store.open(openFor("orders-owner"), signal);
    const service = store.sessionFacts(sessionRef, "service");
    expect(service.subject).toEqual({ kind: "service", processId: "candidate-app-container", origin: E2E_EXECUTOR_COMPILED_ORIGIN });
    expect(() => store.sessionFacts(sessionRef, "browser")).toThrow(/subject/);
    store.bindSubject(sessionRef, { kind: "browser", processId: "chromium-1", contextId: "ctx-1", pageId: "page-1" });
    expect(store.sessionFacts(sessionRef, "browser").subject).toMatchObject({ kind: "browser", contextId: "ctx-1" });
    const account = fixture.plan.accounts.find((item) => item.profileId === "orders-owner")!;
    const text = JSON.stringify(service);
    expect(text).not.toContain(account.password);
    expect(text).not.toContain(account.email);
    expect(text).not.toContain(store.browserStateFor(sessionRef).cookies[0]!.value);
  });
});
