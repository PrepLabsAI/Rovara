import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { E2E_ANONYMOUS_ACCOUNT_PROFILE_ID, E2E_EXECUTOR_COMPILED_ORIGIN, e2eAnonymousAccountIdDigest, e2eAnonymousRuntimeAccountRef, readE2EApplicationProjectContract, type E2ERuntimeAccountRef } from "@agentx/contracts";
import { createExecutorSessionStore, validateFormLogins } from "../../packages/verifier/src/executor/accounts.js";
import { runE2EExecutor } from "../../packages/verifier/src/executor/run.js";
import { FormLoginError, type FormLoginDriver, type FormLoginStorageState, type FormRequestContext, type StorageCookie } from "../../packages/verifier/src/executor/form-login.js";
import { createAccountsExecutorPlan } from "../support/e2e-accounts-fixture.js";
import { createInferredExecutorPlan } from "../support/e2e-inferred-fixture.js";

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
function fakeApplication(options: { failFor?: string; identityOf?: (profileId: string) => Identity; tag?: string; extraCookies?: Array<Partial<StorageCookie> & { name: string; value: string }>; rotate?: string[] } = {}) {
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
      const state: FormLoginStorageState = { cookies: [{ name: "sid", value: token, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Strict" },
          ...(options.extraCookies ?? []).map((cookie) => ({ domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" as const, ...cookie }))],
        origins: [{ origin: input.origin, localStorage: [{ name: "theme", value: "dark" }] }] };
      return { state, status: 200 };
    },
    async requestContext({ state }): Promise<FormRequestContext> {
      const token = state.cookies.find((cookie) => cookie.name === "sid")!.value;
      return { async request({ method, path, body }) {
        requests.push({ token, method, path, body });
        const session = sessions.get(token);
        const json = (status: number, value: unknown) => ({ status, body: new TextEncoder().encode(JSON.stringify(value)), contentType: "application/json", setCookies: [] as string[] });
        if (path === "/api/rotate") return { ...json(200, {}), setCookies: options.rotate ?? [] };
        if (!session) return json(401, { error: "authentication required" });
        if (path === "/api/me") return json(200, session.identity);
        if (path === "/api/orders.csv") return session.identity.role === "owner" ? { status: 200, body: new TextEncoder().encode("id\r\na1\r\n"), contentType: "text/csv", setCookies: [] } : json(403, { error: "owner role required" });
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

  it("refuses a plan whose login differs from the approved source's when the store is made, before any case, and signs nobody in", async () => {
    const app = fakeApplication();
    const tampered = { ...fixture.plan, accounts: fixture.plan.accounts.map((account) => (account.profileId === "orders-owner" && account.login ? { ...account, login: { ...account.login, successTestId: "other" } } : account)) };
    expect(() => createExecutorSessionStore({ plan: tampered, formLogin: app.driver })).toThrow(/account profile orders-owner/);
    expect(() => validateFormLogins(tampered, true)).toThrow(/orders-owner/);
    expect(app.signIns).toHaveLength(0);
  });

  it("refuses, when the store is made, a plan that lacks the login its profile declares, one that has a login its profile does not declare, and a login with no browser to sign in through", () => {
    const app = fakeApplication();
    const stripped = { ...fixture.plan, accounts: fixture.plan.accounts.map((account) => { const { login, ...rest } = account; void login; return rest; }) };
    expect(() => createExecutorSessionStore({ plan: stripped, formLogin: app.driver })).toThrow(/login/i);
    expect(() => createExecutorSessionStore({ plan: fixture.plan })).toThrow(/browser/i);
    expect(app.signIns).toHaveLength(0);
    expect(() => createExecutorSessionStore({ plan: fixture.plan, formLogin: app.driver })).not.toThrow();
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

  describe("which cookies are session secrets", () => {
    const registered = async (extraCookies: NonNullable<NonNullable<Parameters<typeof fakeApplication>[0]>["extraCookies"]>) => {
      const secrets: string[] = [];
      const app = fakeApplication({ tag: "p", extraCookies });
      await storeWith(app, { registerSecret: (value) => secrets.push(value) }).open(openFor("orders-owner"), signal);
      return secrets;
    };

    it("keeps real session ids (16 characters or more, or HttpOnly and 8 or more) and drops values like 1, true, accepted and dark, which would corrupt a report that holds them", async () => {
      const secrets = await registered([
        { name: "consent", value: "1" }, { name: "ok", value: "true" }, { name: "cookie_consent", value: "accepted" }, { name: "theme", value: "dark" },
        { name: "short_http_only", value: "abc12", httpOnly: true }, { name: "lang", value: "en-US" },
        { name: "long_plain", value: "0123456789abcdefghij" }, { name: "http_only_12", value: "abcdef123456", httpOnly: true },
      ]);
      expect(secrets.filter((value) => !value.startsWith("tok-p")).sort()).toEqual(["0123456789abcdefghij", "abcdef123456"]);
      expect(secrets.some((value) => value.startsWith("tok-p"))).toBe(true);
      for (const word of ["1", "true", "accepted", "dark", "abc12", "en-US"]) expect(secrets).not.toContain(word);
    });

    it("counts an HttpOnly cookie of 8 to 15 characters only when it mixes letters and digits, so a plain word or number that a framework made HttpOnly is not scrubbed from reports (N1)", async () => {
      const secrets = await registered([
        { name: "consent", value: "accepted", httpOnly: true }, { name: "mode", value: "AllowAnalytics", httpOnly: true }, { name: "count", value: "123456789012", httpOnly: true },
        { name: "locale", value: "en-US-latin", httpOnly: true }, { name: "mixed_8", value: "abcd1234", httpOnly: true }, { name: "mixed_15", value: "Zz9-aa_bb-cc-dd", httpOnly: true },
        { name: "digit_first", value: "9lives-cat", httpOnly: true },
        // 16 characters or more is a secret whatever it holds, HttpOnly or not.
        { name: "long_word", value: "acceptedallwordsonly", httpOnly: true }, { name: "long_plain_word", value: "anotherplainwordss" },
      ]);
      expect(secrets.filter((value) => !value.startsWith("tok-p")).sort()).toEqual(["9lives-cat", "Zz9-aa_bb-cc-dd", "abcd1234", "acceptedallwordsonly", "anotherplainwordss"].sort());
      for (const word of ["accepted", "AllowAnalytics", "123456789012", "en-US-latin"]) expect(secrets).not.toContain(word);
    });
  });

  describe("cookies the application replaces after the sign-in", () => {
    it("registers a rotated session value an API answer sets, and ignores a short one", async () => {
      const secrets: string[] = [];
      const app = fakeApplication({ rotate: ["sid=rotated-session-value-0123456789; HttpOnly; Path=/", "consent=2; Path=/", "flag=yes; Path=/", "x=; Max-Age=0"] });
      const store = storeWith(app, { registerSecret: (value) => secrets.push(value) });
      const { sessionRef } = await store.open(openFor("orders-owner"), signal);
      const before = secrets.length;
      await store.request({ sessionRef, origin: E2E_EXECUTOR_COMPILED_ORIGIN, method: "GET", path: "/api/rotate" }, signal);
      expect(secrets.slice(before)).toEqual(["rotated-session-value-0123456789"]);
    });
  });
});

describe("the executor refuses a form-login plan that does not match its source before it starts anything", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
  it("exits 2 plan-invalid, says which profile, and never waits for the application", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plan-login-")); dirs.push(dir);
    const tampered = { ...fixture.plan, accounts: fixture.plan.accounts.map((account) => (account.profileId === "orders-owner" && account.login ? { ...account, login: { ...account.login, path: "/signin" } } : account)) };
    await writeFile(join(dir, "plan.json"), JSON.stringify(tampered));
    const result = await runE2EExecutor({ planPath: join(dir, "plan.json"), outDir: join(dir, "out"), signal, localAppUpstream: "http://127.0.0.1:9" });
    expect(result).toEqual({ exitCode: 2, reason: "plan-invalid" });
    const log = await readFile(join(dir, "out", "executor.log"), "utf8");
    expect(log).toContain("plan-invalid");
    expect(log).toContain("orders-owner");
    expect(log).not.toContain("waiting for");
  });
});


// Task 3.3 (Ruling AZ): the signed-out visitor. The executor opens no session for it and no login is made: a fresh context with no cookies, bound to the fixed anonymous reference.
describe("the anonymous profile in the executor (rovara-anonymous)", () => {
  const anonymous = createInferredExecutorPlan();
  const anonymousApplicationId = anonymous.compiled.originByApplicationId[0]!.applicationId;
  const anonymousOpen = (overrides: { ref?: E2ERuntimeAccountRef; origin?: string } = {}) => ({ binding: {}, applicationId: anonymousApplicationId, profileId: E2E_ANONYMOUS_ACCOUNT_PROFILE_ID,
    approvedAccountRef: overrides.ref ?? e2eAnonymousRuntimeAccountRef(anonymousApplicationId), origin: overrides.origin ?? E2E_EXECUTOR_COMPILED_ORIGIN });
  const spy = () => {
    const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: String(init?.method ?? "GET"), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { calls, fetchImpl };
  };

  it("plans the case with no seeded account at all, on the fixed anonymous reference", () => {
    expect(anonymous.plan.accounts).toEqual([]);
    expect(anonymous.compiled.expectedCases.every((item) => item.accountProfileId === E2E_ANONYMOUS_ACCOUNT_PROFILE_ID)).toBe(true);
    expect(anonymous.compiled.runtimeAdmissionContext.selectionInput.runtimeAccountRefs).toEqual([e2eAnonymousRuntimeAccountRef(anonymousApplicationId)]);
  });

  it("opens an anonymous session without any request to the application: the sentinel session, the fixed identity digest, nothing logged in", async () => {
    const { calls, fetchImpl } = spy();
    const store = createExecutorSessionStore({ plan: anonymous.plan, fetchImpl });
    const opened = await store.open(anonymousOpen(), signal);
    expect(calls).toEqual([]);
    // The browser port asks, so that what the application sets for a visitor (a visitor id, a cart) is never taken for a session secret (F6).
    expect(store.isAnonymous(opened.sessionRef)).toBe(true);
    expect(store.isAnonymous("rovara-session-unknown")).toBe(false);
    expect(opened.sessionRef).toMatch(/^rovara-anonymous-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(opened.accountIdDigest).toBe(e2eAnonymousAccountIdDigest(anonymousApplicationId));
    const facts = store.sessionFacts(opened.sessionRef, "service");
    expect(facts).toMatchObject({ sessionRef: opened.sessionRef, accountIdDigest: opened.accountIdDigest, login: null, identity: null });
    expect(facts.subject).toEqual({ kind: "service", processId: "candidate-app-container", origin: E2E_EXECUTOR_COMPILED_ORIGIN });
  });

  it("gives the browser context no cookie and no local storage, and refuses to hand out the orders cookie", async () => {
    const store = createExecutorSessionStore({ plan: anonymous.plan, fetchImpl: spy().fetchImpl });
    const { sessionRef } = await store.open(anonymousOpen(), signal);
    expect(store.browserStateFor(sessionRef)).toEqual({ cookies: [], localStorage: [] });
    expect(() => store.cookieFor(sessionRef)).toThrow();
  });

  it("sends an anonymous API request with no cookie, and closes without a logout", async () => {
    const { calls, fetchImpl } = spy();
    const store = createExecutorSessionStore({ plan: anonymous.plan, fetchImpl });
    const { sessionRef } = await store.open(anonymousOpen(), signal);
    const answered = await store.request({ sessionRef, origin: E2E_EXECUTOR_COMPILED_ORIGIN, method: "GET", path: "/api/admin/orders", requestId: "r1" }, signal);
    expect(answered).toMatchObject({ requestId: "r1", status: 200, path: "/api/admin/orders" });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!.headers).map((name) => name.toLowerCase())).not.toContain("cookie");
    await expect(store.close(sessionRef, signal)).resolves.toEqual({ confirmed: true });
    await expect(store.close(sessionRef, signal)).resolves.toEqual({ confirmed: true });
    expect(calls).toHaveLength(1);
    await expect(store.request({ sessionRef, origin: E2E_EXECUTOR_COMPILED_ORIGIN, method: "GET", path: "/" }, signal)).rejects.toThrow();
  });

  it("gives every case a session of its own", async () => {
    const store = createExecutorSessionStore({ plan: anonymous.plan, fetchImpl: spy().fetchImpl });
    const first = await store.open(anonymousOpen(), signal);
    const second = await store.open(anonymousOpen(), signal);
    expect(second.sessionRef).not.toBe(first.sessionRef);
    expect(second.accountIdDigest).toBe(first.accountIdDigest);
  });

  it("refuses an anonymous open outside the admitted application, origin and account reference, and a reference that is a registered account's", async () => {
    const store = createExecutorSessionStore({ plan: anonymous.plan, fetchImpl: spy().fetchImpl });
    await expect(store.open(anonymousOpen({ origin: "http://elsewhere.example" }), signal)).rejects.toThrow();
    await expect(store.open(anonymousOpen({ ref: { ...e2eAnonymousRuntimeAccountRef(anonymousApplicationId), definitionDigest: "8".repeat(64) } }), signal)).rejects.toThrow();
    await expect(store.open(anonymousOpen({ ref: { ...e2eAnonymousRuntimeAccountRef(anonymousApplicationId), revision: 2 } }), signal)).rejects.toThrow();
    await expect(store.open({ ...anonymousOpen(), applicationId: "someone-else" }, signal)).rejects.toThrow();
  });

  it("does not let a signed-in profile borrow the anonymous path: an account profile with no seeded account is still refused", async () => {
    const store = createExecutorSessionStore({ plan: anonymous.plan, fetchImpl: spy().fetchImpl });
    await expect(store.open({ ...anonymousOpen(), profileId: "orders-owner", approvedAccountRef: { ...e2eAnonymousRuntimeAccountRef(anonymousApplicationId), profileId: "orders-owner" } }, signal)).rejects.toThrow();
  });

  it("is the same on a plan that carries both a signed-in account and the anonymous profile", async () => {
    const { calls, fetchImpl } = spy();
    const store = createExecutorSessionStore({ plan: fixture.plan, formLogin: fakeApplication().driver, fetchImpl });
    // The accounts fixture's app has a project contract; the anonymous profile is not one of its declared accounts, and still needs no login.
    const opened = await store.open({ binding: {}, applicationId, profileId: E2E_ANONYMOUS_ACCOUNT_PROFILE_ID, approvedAccountRef: e2eAnonymousRuntimeAccountRef(applicationId),
      origin: E2E_EXECUTOR_COMPILED_ORIGIN }, signal);
    expect(calls).toEqual([]);
    expect(store.sessionFacts(opened.sessionRef, "service")).toMatchObject({ login: null, identity: null });
  });
});
