// Signing in to the setup page (the install in the cloud): the identity stack's setup page
// callback and invitation, the page's hosted sign-in for administrators only, the sealed hand-off
// of the admin's sign-in to the installer job, and the admin user made as soon as the identity
// stack is up. Nothing here reaches AWS or Cognito.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { IdentityStack, SETUP_CALLBACK_PATH as STACK_CALLBACK_PATH } from "../../infra/lib/identity.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { tokenStoreKey } from "../../packages/cli/src/auth.js";
import { stackParameters } from "../../packages/cli/src/deploy/parameters.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { adminUserForSetupPage } from "../../packages/cli/src/init/finish-steps.js";
import { emptyProgress } from "../../packages/cli/src/init/install-state.js";
import { hashSessionId, SESSION_COOKIE, SETUP_CALLBACK_PATH, setupPageLogin, type TokenSeal } from "../../packages/cli/src/init/ui/setup-auth.js";
import { SETTING_UP_HTML, setupPageHandler, type SetupRequest, type SetupResponse } from "../../packages/cli/src/init/ui/setup-handler.js";
import { memorySetupStore } from "../../packages/cli/src/init/ui/setup-store.js";
import { wizardHtml } from "../../packages/cli/src/init/ui/page.js";
import { initContext, progressHandle, sampleAnswers, T0 } from "../support/init-fakes.js";
import { accessToken, ADMIN_EMAIL, fakeCognito, setupServices } from "../support/setup-fakes.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const ORIGIN = "https://setup.example.com";
const HOST = "setup.example.com";
const IDENTITY = { hostedUiDomain: "https://agentx-staging-123456789012.auth.us-east-1.amazoncognito.com", clientId: "cli-client-id" };
/** Seals by marking, so a test can see what was sealed and that the job opened it. */
const SEAL: TokenSeal = { seal: async (plain) => `sealed:${plain}`, open: async (sealed) => sealed.replace(/^sealed:/, "") };
const ADMIN_TOKEN = accessToken({ "cognito:groups": ["agentx-admin"], username: "alice" });
const AUTH = { issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc", clientId: "client123", audience: "client123" };

function signedInHandler(options: { identity?: typeof IDENTITY | undefined; token?: string; tokenStatus?: number } = {}) {
  let clock = T0;
  const store = memorySetupStore(() => clock);
  const exchanged: Array<Record<string, string>> = [];
  const fetchToken = (async (_url: string | URL, init?: RequestInit) => {
    exchanged.push(Object.fromEntries(new URLSearchParams(typeof init?.body === "string" ? init.body : "")));
    return new Response(JSON.stringify({ access_token: options.token ?? ADMIN_TOKEN, id_token: "id", expires_in: 3600 }), { status: options.tokenStatus ?? 200 });
  }) as typeof fetch;
  const handle = setupPageHandler({
    store, env: "staging", origin: ORIGIN, now: () => clock,
    auth: { kind: "cognito", identity: async () => ("identity" in options ? options.identity : IDENTITY), seal: SEAL, fetch: fetchToken },
  });
  const get = (path: string, extra: { query?: Record<string, string>; cookie?: string; site?: string } = {}) => handle({
    method: "GET", path, query: extra.query ?? {},
    headers: { host: HOST, ...(extra.cookie === undefined ? {} : { cookie: extra.cookie }), ...(extra.site === undefined ? {} : { "sec-fetch-site": extra.site }) },
  });
  /** The whole sign-in: the login redirect, then Cognito's redirect back with a code. */
  const signIn = async (): Promise<{ login: SetupResponse; callback: SetupResponse; sessionCookie?: string }> => {
    const login = await get("/auth/login", { site: "cross-site" });
    const state = new URL(login.headers.location ?? "").searchParams.get("state") ?? "";
    const loginCookie = (login.cookies?.[0] ?? "").split(";")[0] ?? "";
    const callback = await get(SETUP_CALLBACK_PATH, { query: { code: "the-code", state }, cookie: loginCookie, site: "cross-site" });
    const sessionCookie = callback.cookies?.find((value) => value.startsWith(`${SESSION_COOKIE}=`))?.split(";")[0];
    return { login, callback, ...(sessionCookie === undefined ? {} : { sessionCookie }) };
  };
  return { store, handle, get, signIn, exchanged, advance: (ms: number) => { clock += ms; } };
}

describe("the identity stack while the install runs in the cloud", () => {
  const template = () => Template.fromStack(new IdentityStack(new App(), "Identity", { naming: environmentNaming("staging"), env: { region: "us-east-1", account: "123456789012" } }));

  it("takes the setup page's address, empty by default, for the CLI client's callbacks and the invitation", () => {
    const json = template().toJSON() as { Parameters: Record<string, { Default?: string }>; Resources: Record<string, { Type: string; Properties: Record<string, unknown> }> };
    expect(json.Parameters.SetupPageUrl?.Default).toBe("");
    const client = Object.values(json.Resources).find((resource) => resource.Type === "AWS::Cognito::UserPoolClient")!;
    expect(JSON.stringify(client.Properties.CallbackURLs)).toContain(`"${STACK_CALLBACK_PATH}"`);
    const pool = Object.values(json.Resources).find((resource) => resource.Type === "AWS::Cognito::UserPool")!;
    const invitation = JSON.stringify(pool.Properties.AdminCreateUserConfig);
    expect(invitation).toContain("{username}");
    expect(invitation).toContain("{####}");
    expect(invitation).toContain("AllowAdminCreateUserOnly");
  });

  it("uses the same callback path the setup page serves", () => {
    expect(STACK_CALLBACK_PATH).toBe(SETUP_CALLBACK_PATH);
  });

  it("is deployed with the address only by an install in the cloud", () => {
    const outputs = {};
    const base = { env: "staging", region: "us-east-1", account: "123456789012", release: { version: "1.2.3" } as never, models: sampleAnswers().models, identity: { mode: "cognito" as const }, github: { appId: "", privateKeySecretArn: "" }, callbackSigningKey: "k".repeat(40) };
    expect(stackParameters("identity", base, outputs, { packages: false })).not.toHaveProperty("SetupPageUrl");
    expect(stackParameters("identity", { ...base, setupPageUrl: ORIGIN }, outputs, { packages: false })).toMatchObject({ SetupPageUrl: ORIGIN });
  });
});

describe("signing in to the setup page", () => {
  it("before the identity stack is up, says sign-in is still being set up and serves nothing else", async () => {
    const page = signedInHandler({ identity: undefined });
    expect((await page.get("/")).body).toBe(SETTING_UP_HTML);
    expect((await page.get("/auth/login")).body).toBe(SETTING_UP_HTML);
    expect((await page.get("/state")).status).toBe(401);
  });

  it("sends a visit from the invitation email to the hosted sign-in, with PKCE", async () => {
    const page = signedInHandler();
    const visit = await page.get("/", { site: "cross-site" });
    expect(visit).toMatchObject({ status: 302, headers: { location: "/auth/login" } });
    const login = await page.get("/auth/login", { site: "cross-site" });
    const authorize = new URL(login.headers.location ?? "");
    expect(authorize.origin).toBe(IDENTITY.hostedUiDomain);
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      client_id: IDENTITY.clientId, redirect_uri: `${ORIGIN}${SETUP_CALLBACK_PATH}`, response_type: "code", code_challenge_method: "S256",
    });
    expect(login.cookies?.[0]).toMatch(/^rovara_login=[^;]+; Path=\/auth; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
  });

  it("signs an administrator in: a session cookie for the page, and the sign-in sealed for the job", async () => {
    const page = signedInHandler();
    const { callback, sessionCookie } = await page.signIn();
    expect(callback).toMatchObject({ status: 302, headers: { location: "/" } });
    expect(page.exchanged[0]).toMatchObject({ grant_type: "authorization_code", code: "the-code", client_id: IDENTITY.clientId, redirect_uri: `${ORIGIN}${SETUP_CALLBACK_PATH}` });
    expect(page.exchanged[0]?.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessionCookie).toBeDefined();
    // The table holds the session id's hash, never the id itself.
    const id = sessionCookie!.slice(`${SESSION_COOKIE}=`.length);
    expect([...page.store.sessions.keys()]).toEqual([hashSessionId(id)]);
    expect(await page.store.takeAdminToken()).toEqual({ sealed: `sealed:${ADMIN_TOKEN}`, expiresAt: T0 + 3_600_000 });

    const shown = await page.get("/", { cookie: sessionCookie! });
    expect(shown).toMatchObject({ status: 200, body: wizardHtml("", { poll: true }) });
    expect((await page.get("/state", { cookie: sessionCookie! })).status).toBe(200);
    page.advance(3_600_000);
    expect((await page.get("/state", { cookie: sessionCookie! })).status).toBe(401);
  });

  it("refuses someone who is not an administrator, and a sign-in started elsewhere", async () => {
    const outsider = signedInHandler({ token: accessToken({ "cognito:groups": ["developers"] }) });
    const refused = (await outsider.signIn()).callback;
    expect(refused).toMatchObject({ status: 403, body: "This account is not an AgentX administrator, so it cannot set AgentX up.\n" });
    expect(outsider.store.sessions.size).toBe(0);
    expect(await outsider.store.takeAdminToken()).toBeUndefined();

    const page = signedInHandler();
    const forged = await page.get(SETUP_CALLBACK_PATH, { query: { code: "c", state: "not-the-state" }, cookie: "rovara_login=real-state.verifier" });
    expect(forged.status).toBe(400);
    expect(page.exchanged).toEqual([]);
  });

  it("takes an answer only from the page itself, signed in", async () => {
    const page = signedInHandler();
    const { sessionCookie } = await page.signIn();
    const post = (headers: Record<string, string>) => page.handle({
      method: "POST", path: "/close", query: {}, body: "{}", headers: { host: HOST, ...headers },
    } satisfies SetupRequest);
    expect((await post({ origin: "https://evil.example.com", cookie: sessionCookie! })).status).toBe(403);
    expect((await post({ origin: ORIGIN, "sec-fetch-site": "cross-site", cookie: sessionCookie! })).status).toBe(403);
    expect((await post({ origin: ORIGIN })).status).toBe(401);
    expect((await post({ origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: sessionCookie! })).status).toBe(200);
    expect(await page.store.takeClose()).toBe(true);
  });
});

describe("the job's sign-in from the setup page", () => {
  it("opens the sealed sign-in the page left, and takes it only once", async () => {
    const store = memorySetupStore(() => T0);
    await store.putAdminToken(`sealed:${ADMIN_TOKEN}`, T0 + 3_600_000);
    const login = setupPageLogin({ store, seal: SEAL, signInUrl: `${ORIGIN}/auth/login`, sleep: async () => undefined, now: () => T0 });
    const tokenStore = new InMemoryTokenStore();
    expect(await login({ ...AUTH, tokenStore })).toEqual({ accessToken: ADMIN_TOKEN, expiresAt: T0 + 3_600_000 });
    expect(await store.takeAdminToken()).toBeUndefined();
    // Kept where the admin session looks first, so the next step needs no new sign-in.
    expect(await tokenStore.get(tokenStoreKey(AUTH))).toEqual({ accessToken: ADMIN_TOKEN, expiresAt: T0 + 3_600_000 });
  });

  it("with none waiting, shows the page's Sign in link and waits for the next, then gives up", async () => {
    let clock = T0;
    const store = memorySetupStore(() => clock);
    const opened: string[] = [];
    const login = setupPageLogin({
      store, seal: SEAL, signInUrl: `${ORIGIN}/auth/login`, now: () => clock,
      sleep: async (ms) => { clock += ms; if (clock === T0 + 4_000) await store.putAdminToken(`sealed:${ADMIN_TOKEN}`, clock + 1_000_000); },
    });
    expect(await login({ ...AUTH, tokenStore: new InMemoryTokenStore(), openBrowser: async (url) => { opened.push(url); } })).toMatchObject({ accessToken: ADMIN_TOKEN });
    expect(opened).toEqual([`${ORIGIN}/auth/login`]);
    await expect(login({ ...AUTH, tokenStore: new InMemoryTokenStore(), timeoutMilliseconds: 10_000 })).rejects.toThrow("the admin did not sign in on the setup page in time");
  });
});

describe("the admin user, in the cloud", () => {
  it("is made as soon as the identity stack is up, so the invitation with the page's address goes out during the build", async () => {
    const cognito = fakeCognito();
    const context = initContext({ setupPageUrl: ORIGIN, setup: setupServices({ cognito }), answers: sampleAnswers({ adminEmail: ADMIN_EMAIL }) });
    // The core step has just deployed the identity stack.
    await context.deployer.deploy({ stackName: "agentx-staging-identity" } as never);
    const progress = progressHandle();
    await adminUserForSetupPage(context, progress);
    expect(cognito.created).toEqual([ADMIN_EMAIL]);
    expect(progress.current().admin).toEqual({ username: ADMIN_EMAIL, mode: "cognito" });
    // Run again (a resumed job): nothing more is made.
    await adminUserForSetupPage(context, progress);
    expect(cognito.created).toEqual([ADMIN_EMAIL]);
  });

  it("waits for the admin-user step on any other install", async () => {
    const cognito = fakeCognito();
    const context = initContext({ setup: setupServices({ cognito }), answers: sampleAnswers({ adminEmail: ADMIN_EMAIL }) });
    await adminUserForSetupPage(context, progressHandle({ ...emptyProgress("staging", T0) }));
    expect(cognito.created).toEqual([]);
  });
});
