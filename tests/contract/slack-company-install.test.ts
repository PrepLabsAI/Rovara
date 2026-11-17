// Guided onboarding PR 4: Add to Slack, through the real developer dispatcher, the real binding rows, the real token-store writer (over a fake Secrets Manager) and the
// real reader (slack-workspace-tokens.ts), with a fake slack.com behind the fetch seam. Two companies throughout.
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { companyRouteHarness, PERSON, TIME } from "../support/company-route-harness.js";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import {
  companyInstallKey, handleSlackWorkspaceRemoved, SLACK_ADMIN_ONLY, SLACK_COMPANY_HAS_WORKSPACE, SLACK_DISCONNECT_STEP_UP, SLACK_ENTERPRISE_REFUSED, SLACK_INSTALL_BOT_SCOPES,
  SLACK_NOT_CONNECTED, SLACK_NOT_SET_UP, SLACK_OWNER_ONLY, SLACK_WORKSPACE_TAKEN, START_AGAIN, type SlackInstallWiring,
} from "../../packages/broker/src/aws/slack-company-install.js";
import { handleSlackInstallRequest, slackInstallSecretsFromSecretsManager, slackInstallThroughLambda, type SlackInstallIdentityDependencies } from "../../packages/broker/src/aws/slack-install-identity.js";
import { slackWorkspaceRemovalOf } from "../../packages/broker/src/aws/slack-workspace-removal.js";
import { createSlackWorkspaceBindings } from "../../packages/broker/src/aws/slack-workspace-binding.js";
import { createSlackWorkspaceTokens } from "../../packages/broker/src/aws/slack-workspace-tokens.js";
import { createSlackAdapterFront, createSlackIngressHandler, type SlackIngressDependencies } from "../../packages/broker/src/aws/slack-ingress.js";
import { SLACK_BOT_SCOPES } from "../../packages/cli/src/init/slack-app.js";
import { COMPANY_A_ID as A, COMPANY_B_ID as B } from "../../packages/testing/src/isolation/two-company.js";

const PERSON_B = "e".repeat(64);
const CALLBACK = "https://app.rovara.test/api/connect/slack/callback";
// Built at run time (public push protection refuses key-shaped literals).
const CLIENT_SECRET = ["c0ffee", "c0ffee", "c0ffee", "c0ffee", "c0ffee", "aa"].join("");
const CLIENT_ID = "1234.5678";
const tokenOf = (name: string) => ["xoxb", "100", name.replace(/[^A-Za-z0-9]/g, "")].join("-");

type Answer = Record<string, unknown> & { error: { code: string; message: string } };
interface Grant { team?: { id: string; name?: string }; enterprise?: boolean; ok?: boolean; tokenType?: string; installer?: string; status?: number; okFalseWithToken?: boolean }

function fakeSlack(grants: Record<string, Grant>) {
  const revoked: string[] = [];
  const exchanged: string[] = [];
  const control = { revokeAnswer: { ok: true, revoked: true } as Record<string, unknown> };
  const used = new Set<string>();
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const headers = new Headers(init?.headers);
    if (url === "https://slack.com/api/oauth.v2.access") {
      const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      const code = form.get("code") ?? "";
      exchanged.push(code);
      const basic = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
      if (headers.get("authorization") !== basic || form.get("redirect_uri") !== CALLBACK || used.has(code) || grants[code] === undefined) return json({ ok: false, error: "invalid_code" });
      used.add(code);
      const grant = grants[code];
      if (grant.ok === false) return json({ ok: false, error: "access_denied" });
      const answer = (body: unknown) => grant.status === undefined ? json(body) : new Response(JSON.stringify(body), { status: grant.status });
      return answer({ ok: grant.okFalseWithToken !== true, access_token: tokenOf(code), token_type: grant.tokenType ?? "bot", scope: SLACK_INSTALL_BOT_SCOPES.join(","), bot_user_id: "UBOT0001", app_id: "A0APP",
        team: grant.team ?? null, enterprise: grant.enterprise === true ? { id: "E0GRID", name: "Grid" } : null, is_enterprise_install: grant.enterprise === true,
        authed_user: { id: grant.installer ?? "U0INSTALL" } });
    }
    if (url.startsWith("https://slack.com/api/auth.revoke")) {
      revoked.push((headers.get("authorization") ?? "").replace(/^Bearer /, ""));
      return json(control.revokeAnswer);
    }
    return json({ ok: false, error: "unknown_method" });
  });
  return { fetch, revoked, exchanged, control };
}

/** Secrets Manager's four calls the writer and readers make, by name; a create of an existing name throws ResourceExistsException as AWS does. */
function fakeSecretsManager(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const calls: string[] = [];
  const named = (name: string) => Object.assign(new Error(name), { name });
  const send = vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const kind = command.constructor.name; const input = command.input;
    calls.push(`${kind} ${String(input.Name ?? input.SecretId)}`);
    if (kind === "CreateSecretCommand") { if (store.has(String(input.Name))) throw named("ResourceExistsException"); store.set(String(input.Name), String(input.SecretString)); return {}; }
    if (kind === "PutSecretValueCommand") { if (!store.has(String(input.SecretId))) throw named("ResourceNotFoundException"); store.set(String(input.SecretId), String(input.SecretString)); return {}; }
    if (kind === "GetSecretValueCommand") { const value = store.get(String(input.SecretId)); if (value === undefined) throw named("ResourceNotFoundException"); return { SecretString: value }; }
    throw new Error(`unexpected ${kind}`);
  });
  return { store, calls, client: { send: send as unknown as (command: unknown) => Promise<unknown> } };
}

const secretName = (company: string, team: string) => `agentx/test/slack-workspaces/${company}/${team}`;
const ACME = { id: "T0ACME", name: "Acme" };
const BETA = { id: "T0BETA", name: "Beta" };

function world(grants: Record<string, Grant> = {
  "acme-code": { team: ACME }, "acme-again": { team: ACME }, "acme-b": { team: ACME }, "beta-code": { team: BETA }, "beta-a": { team: BETA },
  "grid-code": { enterprise: true }, "denied-code": { ok: false },
}, options: { marker?: boolean; appClient?: boolean } = {}) {
  const h = companyRouteHarness();
  let now = Date.parse(TIME);
  h.deps.now = () => now;
  const slack = fakeSlack(grants);
  const sm = fakeSecretsManager({ "agentx/test/slack": JSON.stringify({ botToken: tokenOf("install"), clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, signingSecret: "s" }) });
  if (options.marker !== false) h.db.set({ pk: "SLACK_WORKSPACE_BINDING", sk: "BACKFILL" });
  const logs: unknown[] = [];
  let seed = 0;
  // The sign-in Lambda's side, behind the same JSON invoke the broker uses.
  const identity: SlackInstallIdentityDependencies = {
    appClient: async () => options.appClient === false ? { clientId: CLIENT_ID } : JSON.parse(sm.store.get("agentx/test/slack")!) as { clientId: string; clientSecret: string },
    secrets: slackInstallSecretsFromSecretsManager(sm.client, "test"), fetch: slack.fetch,
  };
  const invokes: string[] = [];
  const invoke = async (payload: Uint8Array) => {
    const text = Buffer.from(payload).toString("utf8"); invokes.push(text);
    return { Payload: Buffer.from(JSON.stringify(await handleSlackInstallRequest(identity, JSON.parse(text)))) };
  };
  const wiring: SlackInstallWiring = { slack: slackInstallThroughLambda(invoke), log: (entry) => logs.push(entry), random: () => Buffer.alloc(32, ++seed) };
  h.deps.companies = companyMembershipFromDynamo(h.db, "SignIn");
  h.deps.developer.slackInstall = wiring;
  // The Rovara web app's registered full-access client: only its tokens carry a step-up (developer-routes.ts authenticateCallerWithStepUp).
  h.db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://app.rovara.test/callback"],
    loopback: false, installLevel: true, secretHash: "f".repeat(64), fullAccess: true, webApp: true, createdAt: TIME, updatedAt: TIME, updatedBy: "admin" });
  const sessions = new Map<string, Record<string, unknown>>();
  const as = (personId: string, companyId: string, role: "owner" | "admin" | "member" = "admin", sid = personId === PERSON ? "session" : "session-b", stepUpAt?: number) => {
    h.db.set({ ...membershipKey(personId), entityType: "COMPANY_MEMBERSHIP", personId, companyId, role, joinedAt: TIME });
    h.db.set({ pk: `SESSION#${sid}`, sk: "META", sessionId: sid, developerId: personId, amr: "slack", clientId: "web-app", startedAt: TIME, endsAt: Date.parse(TIME) / 1000 + 86_400 });
    h.db.set({ pk: `DEVELOPER#${personId}`, sk: "META", developerId: personId, provider: "slack", displayName: personId === PERSON ? "Ada Admin" : "Bea Admin", revoked: false });
    const claims: Record<string, unknown> = { ...h.claims, azp: "web-app", sub: personId, sid, ...(stepUpAt === undefined ? {} : { step_up_at: stepUpAt, step_up_amr: "passkey" }) };
    if (stepUpAt === undefined) { delete claims.step_up_at; delete claims.step_up_amr; }
    sessions.set(personId + sid, claims);
    for (const key of Object.keys(h.claims)) delete h.claims[key];
    Object.assign(h.claims, claims);
    return { sub: personId, sid };
  };
  const jwtOf = (claims: Record<string, unknown>) => { const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url"); return `Bearer ${part({ alg: "none" })}.${part(claims)}.sig`; };
  h.deps.developer.verifyAccessToken = async (authorization) => JSON.parse(Buffer.from((authorization ?? "").split(".")[1] ?? "", "base64url").toString()) as Record<string, unknown>;
  as(PERSON_B, B);
  as(PERSON, A);
  const call = async (method: string, path: string, body?: unknown, who?: { sub: string; sid: string }) => {
    const claims = who === undefined ? h.claims : sessions.get(who.sub + who.sid)!;
    const answer = await h.read(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers: { authorization: jwtOf(claims) } });
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Answer, raw: answer.body };
  };
  const start = (who?: { sub: string; sid: string }) => call("POST", "/v1/dev/company/slack/install", { redirectUri: CALLBACK }, who);
  const complete = (body: Record<string, unknown>, who?: { sub: string; sid: string }) => call("POST", "/v1/dev/company/slack/install/complete", body, who);
  const disconnect = (who?: { sub: string; sid: string }) => call("POST", "/v1/dev/company/slack/disconnect", {}, who);
  const read = (who?: { sub: string; sid: string }) => call("GET", "/v1/dev/company/slack", undefined, who);
  const connect = async (code: string, who?: { sub: string; sid: string }) => complete({ state: (await start(who)).body.state, code }, who);
  const tokens = createSlackWorkspaceTokens({ bindings: createSlackWorkspaceBindings({ client: h.db, tableName: "State" }), environment: "test",
    readSecret: async (name) => sm.store.get(name), now: () => now });
  const a = { sub: PERSON, sid: "session" }; const b = { sub: PERSON_B, sid: "session-b" };
  return { ...h, slack, sm, logs, wiring, identity, invokes, as, call, start, complete, disconnect, read, connect, tokens, a, b, tick: (ms: number) => { now += ms; }, nowMs: () => now };
}

const uniform = { code: "FORBIDDEN", message: START_AGAIN };
const workspaceSecrets = (w: ReturnType<typeof world>) => [...w.sm.store.keys()].filter((name) => name.includes("slack-workspaces/")).sort();

describe("start", () => {
  it("an admin gets a single-use state stored only as its hash, and Slack's OAuth v2 address with bot scopes only", async () => {
    const w = world();
    const answer = await w.start();
    expect(answer.status).toBe(200);
    const state = answer.body.state as string;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const url = new URL(answer.body.authorizeUrl as string);
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: CLIENT_ID, scope: SLACK_INSTALL_BOT_SCOPES.join(","), redirect_uri: CALLBACK, state });
    expect(answer.body.expiresAt).toBe(new Date(Date.parse(TIME) + 600_000).toISOString());
    expect(w.db.get(`SLACK_INSTALL_STATE#${createHash("sha256").update(state).digest("hex")}`, "META"))
      .toMatchObject({ companyId: A, personId: PERSON, sessionId: "session", provider: "slack-install", status: "live", redirectUri: CALLBACK });
    expect(JSON.stringify([...w.db.items.values()])).not.toContain(state);
    expect(answer.raw).not.toContain(CLIENT_SECRET);
    expect(answer.body).not.toHaveProperty("signedInWorkspace");
  });
  it("asks for the bot scopes Code's bot already uses plus commands, and no user scope", () => {
    expect(SLACK_INSTALL_BOT_SCOPES).toEqual([...SLACK_BOT_SCOPES, "commands"]);
  });
  it("names the Slack workspace the person signed in with, when their profile records one", async () => {
    const w = world();
    w.db.set({ pk: `DEVELOPER#${PERSON}`, sk: "META", displayName: "Ada", slackTeamId: "T0HOME", slackTeamName: "Home" });
    expect((await w.start()).body.signedInWorkspace).toEqual({ teamId: "T0HOME", teamName: "Home" });
  });
  it("an owner may start; a plain member is refused", async () => {
    const w = world(); w.as(PERSON, A, "owner"); expect((await w.start()).status).toBe(200);
    w.as(PERSON, A, "member"); const refused = await w.start();
    expect(refused.status).toBe(403); expect(refused.body.error).toEqual({ code: "FORBIDDEN", message: SLACK_ADMIN_ONLY });
  });
  it("refuses a callback address that is not https on Cloud's callback path", async () => {
    const w = world();
    for (const redirectUri of ["http://app.rovara.test/api/connect/slack/callback", "https://app.rovara.test/api/connect/slack/callback?x=1", "https://app.rovara.test/other",
      "https://user@app.rovara.test/api/connect/slack/callback", "https://app.rovara.test/api/connect/slack/callback#f", 7]) {
      expect((await w.call("POST", "/v1/dev/company/slack/install", { redirectUri })).status, String(redirectUri)).toBe(400);
    }
    expect((await w.call("POST", "/v1/dev/company/slack/install", { redirectUri: CALLBACK, companyId: B })).status).toBe(400);
  });
  it("says it is not set up while the Slack app's client is not stored", async () => {
    const w = world(undefined, { appClient: false });
    expect((await w.start()).body.error).toEqual({ code: "RUNTIME_UNAVAILABLE", message: SLACK_NOT_SET_UP });
  });
  it("is unknown without the wiring or the company layer", async () => {
    const w = world(); delete w.deps.developer.slackInstall;
    expect((await w.start()).status).toBe(404);
    const v = world(); delete v.deps.companies;
    expect((await v.read()).status).toBe(404);
  });
});

describe("complete", () => {
  it("binds the workspace Slack names to the caller's company, stores the bot token only under it, and audits the person", async () => {
    const w = world();
    w.db.set({ pk: `DEVELOPER#${PERSON}`, sk: "META", displayName: "Ada", slackTeamId: "T0HOME", slackTeamName: "Home" });
    const answer = await w.connect("acme-code");
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ status: "connected", alreadyConnected: false, workspace: { teamId: "T0ACME", teamName: "Acme" },
      signedInWorkspace: { teamId: "T0HOME", teamName: "Home" }, matchesSignIn: false });
    expect(w.db.get("SLACK_TEAM#T0ACME", "BINDING")).toMatchObject({ companyId: A, boundBy: PERSON });
    expect(w.db.get(`ORG#${A}#SLACK_WORKSPACES`, "TEAM#T0ACME")).toMatchObject({ companyId: A, teamId: "T0ACME" });
    expect(w.db.get(companyInstallKey(A).pk, "WORKSPACE")).toMatchObject({ teamId: "T0ACME", teamName: "Acme", status: "connected", connectedBy: PERSON, botUserId: "UBOT0001", installerSlackUserId: "U0INSTALL" });
    expect([...w.db.items.values()].filter((row) => row.entityType === "SLACK_WORKSPACE_AUDIT")).toEqual([expect.objectContaining({ action: "connect", companyId: A, actor: PERSON, teamId: "T0ACME" })]);
    expect(workspaceSecrets(w)).toEqual([secretName(A, "T0ACME")]);
    // The existing reader finds it through the binding, for A only.
    expect(await w.tokens.tokenForCompany(A, "T0ACME")).toBe(tokenOf("acme-code"));
    expect(await w.tokens.tokenForCompany(B, "T0ACME")).toBeUndefined();
    expect(w.logs).toEqual([{ companyId: A, event: "slack.workspace_connected", teamId: "T0ACME", actor: PERSON }]);
    expect(w.slack.revoked).toEqual([]);
  });
  it("answers matchesSignIn true when the person signed in from the same workspace, and nothing when they signed in otherwise", async () => {
    const w = world();
    w.db.set({ pk: `DEVELOPER#${PERSON}`, sk: "META", displayName: "Ada", slackTeamId: "T0ACME" });
    expect((await w.connect("acme-code")).body).toMatchObject({ matchesSignIn: true, signedInWorkspace: { teamId: "T0ACME" } });
    const v = world();
    const answer = await v.connect("acme-code");
    expect(answer.body).not.toHaveProperty("matchesSignIn"); expect(answer.body).not.toHaveProperty("signedInWorkspace");
  });
  it("gives one answer for every state problem, spending nothing at Slack and storing nothing", async () => {
    const w = world();
    const state = (await w.start()).body.state as string;
    const cases: Array<[string, () => Promise<{ status: number; raw: string }>]> = [
      ["unknown", () => w.complete({ state: "A".repeat(43), code: "acme-code" })],
      ["malformed", () => w.complete({ state: "short", code: "acme-code" })],
      ["extra field", () => w.complete({ state, code: "acme-code", teamId: "T0BETA" })],
      ["no code or error", () => w.complete({ state })],
      ["other session", async () => { w.as(PERSON, A, "admin", "other-session"); const r = await w.complete({ state, code: "acme-code" }); w.as(PERSON, A); return r; }],
      ["other person", () => w.complete({ state, code: "acme-code" }, w.b)],
    ];
    for (const [name, run] of cases) {
      const answer = await run();
      expect(answer.status, name).toBe(403);
      expect((JSON.parse(answer.raw) as { error: unknown }).error, name).toEqual(uniform);
    }
    w.as(PERSON, A, "member");
    expect((await w.complete({ state, code: "acme-code" })).body.error).toEqual(uniform);
    expect(w.slack.exchanged).toEqual([]);
    expect(workspaceSecrets(w)).toEqual([]);
    // The state is still live for its own admin (nothing above spent it).
    w.as(PERSON, A);
    expect((await w.complete({ state, code: "acme-code" })).status).toBe(200);
  });
  it("spends a state once and refuses it after ten minutes", async () => {
    const w = world();
    const state = (await w.start()).body.state as string;
    expect((await w.complete({ state, code: "acme-code" })).status).toBe(200);
    expect((await w.complete({ state, code: "acme-again" })).body.error).toEqual(uniform);
    const later = (await w.start()).body.state as string;
    w.tick(600_000);
    expect((await w.complete({ state: later, code: "acme-again" })).body.error).toEqual(uniform);
    expect(w.slack.exchanged).toEqual(["acme-code"]);
  });
  it("a state from company A spent by a person now in company B does nothing", async () => {
    const w = world();
    const state = (await w.start()).body.state as string;
    w.as(PERSON, B);
    expect((await w.complete({ state, code: "beta-code" })).body.error).toEqual(uniform);
    expect(w.db.get("SLACK_TEAM#T0BETA", "BINDING")).toBeUndefined();
  });
  it("Cancel on Slack's page answers cancelled; any other Slack error starts again", async () => {
    const w = world();
    expect((await w.complete({ state: (await w.start()).body.state, error: "access_denied" })).body).toMatchObject({ status: "cancelled" });
    expect((await w.complete({ state: (await w.start()).body.state, error: "invalid_scope" })).body.error).toEqual(uniform);
    expect(w.slack.exchanged).toEqual([]);
  });
  it("a code Slack refuses starts again, storing nothing", async () => {
    const w = world();
    for (const code of ["unknown-code", "denied-code"]) expect((await w.connect(code)).body.error).toEqual(uniform);
    expect(workspaceSecrets(w)).toEqual([]);
    expect(w.db.get("SLACK_TEAM#T0ACME", "BINDING")).toBeUndefined();
  });
  it("refuses a user-token answer and an Enterprise Grid org install; the org token is revoked and nothing is stored", async () => {
    const w = world({ "user-token": { team: ACME, tokenType: "user" }, "grid-code": { enterprise: true }, "grid-team": { team: { id: "E0GRID" } } });
    expect((await w.connect("user-token")).body.error).toEqual(uniform);
    for (const code of ["grid-code", "grid-team"]) {
      const answer = await w.connect(code);
      expect(answer.status).toBe(403); expect(answer.body.error).toEqual({ code: "FORBIDDEN", message: SLACK_ENTERPRISE_REFUSED });
    }
    expect(w.slack.revoked).toEqual([tokenOf("grid-code"), tokenOf("grid-team")]);
    expect(workspaceSecrets(w)).toEqual([]);
    expect([...w.db.items.keys()].some((key) => key.includes("SLACK_TEAM#"))).toBe(false);
  });
});

describe("one workspace per company, one company per workspace (DEC 254l item 4)", () => {
  it("company B cannot bind company A's workspace: a fixed refusal, nothing stored for B, A untouched, and A's bot is not revoked", async () => {
    const w = world();
    expect((await w.connect("acme-code")).status).toBe(200);
    const before = JSON.stringify(w.db.get("SLACK_TEAM#T0ACME", "BINDING"));
    const refused = await w.connect("acme-b", w.b);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toEqual({ code: "SLACK_WORKSPACE_TAKEN", message: SLACK_WORKSPACE_TAKEN });
    expect(JSON.stringify(w.db.get("SLACK_TEAM#T0ACME", "BINDING"))).toBe(before);
    expect(w.db.get(companyInstallKey(B).pk, "WORKSPACE")).toBeUndefined();
    expect(workspaceSecrets(w)).toEqual([secretName(A, "T0ACME")]);
    expect(await w.tokens.tokenForCompany(A, "T0ACME")).toBe(tokenOf("acme-code"));
    // auth.revoke deactivates the workspace's bot user, which is A's (docs.slack.dev/reference/methods/auth.revoke).
    expect(w.slack.revoked).toEqual([]);
    expect(refused.raw).not.toContain(tokenOf("acme-b"));
  });
  it.each(["held before the connect", "bound by A during B's connect (the transaction loses the race)"] as const)("DEC 254s: a workspace another company holds (%s): the new token is discarded (no token-store write, in no log line, console or stdout/stderr output, not in the answer), exact text, no revoke", async (when) => {
    const w = world();
    if (when === "held before the connect") expect((await w.connect("acme-code")).status).toBe(200);
    else {
      // A binds T0ACME just before B's conditional transaction runs, so the transaction fails and the fresh read decides.
      const db = w.deps.documentClient; let raced = false;
      w.deps.documentClient = { send: async (command: unknown) => {
        if (!raced && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") {
          raced = true;
          await createSlackWorkspaceBindings({ client: w.db, tableName: "State" }).bind(A, "T0ACME", "operator");
        }
        return db.send(command);
      } };
    }
    const token = tokenOf("acme-b");
    const callsBefore = w.sm.calls.length; const logsBefore = w.logs.length;
    const printed: string[] = [];
    const text = (args: unknown[]) => args.map((arg) => typeof arg === "string" ? arg : arg instanceof Uint8Array ? Buffer.from(arg).toString("utf8") : JSON.stringify(arg)).join(" ");
    const spies = [
      ...(["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { printed.push(text(args)); })),
      ...([process.stdout, process.stderr] as const).map((stream) => vi.spyOn(stream, "write").mockImplementation(((...args: unknown[]) => { printed.push(text(args.slice(0, 1))); return true; }))),
    ];
    let refused: Awaited<ReturnType<typeof w.connect>>;
    try { refused = await w.connect("acme-b", w.b); } finally { for (const spy of spies) spy.mockRestore(); }
    expect(refused.status).toBe(409);
    expect(refused.body.error).toEqual({ code: "SLACK_WORKSPACE_TAKEN", message: "This Slack workspace is already connected to another company." });
    expect(refused.raw).not.toContain(token);
    // The token store is written only with CreateSecret / PutSecretValue: none at all during the refusal, and the token is in no stored secret.
    expect(w.sm.calls.slice(callsBefore).filter((call) => /^(CreateSecret|PutSecretValue)Command /.test(call))).toEqual([]);
    expect([...w.sm.store.values()].join("\n")).not.toContain(token);
    expect(JSON.stringify([...w.db.items.values()])).not.toContain(token);
    expect(w.db.get(companyInstallKey(B).pk, "WORKSPACE")).toBeUndefined();
    expect(w.logs.slice(logsBefore)).toEqual([{ companyId: B, event: "slack.install_refused", reason: "workspace_taken", teamId: "T0ACME", actor: PERSON_B }]);
    expect(JSON.stringify(w.logs)).not.toContain(token);
    expect(printed.join("\n")).not.toContain(token);
    expect(w.slack.revoked).toEqual([]);
  });
  it("a company that already has a workspace cannot add a second: the just-issued token is revoked and nothing is stored", async () => {
    const w = world();
    expect((await w.connect("acme-code")).status).toBe(200);
    const refused = await w.connect("beta-a");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toEqual({ code: "SLACK_COMPANY_HAS_WORKSPACE", message: SLACK_COMPANY_HAS_WORKSPACE });
    expect(w.slack.revoked).toEqual([tokenOf("beta-a")]);
    expect(workspaceSecrets(w)).toEqual([secretName(A, "T0ACME")]);
    expect(w.db.get("SLACK_TEAM#T0BETA", "BINDING")).toBeUndefined();
    expect(w.db.get(companyInstallKey(A).pk, "WORKSPACE")).toMatchObject({ teamId: "T0ACME" });
  });
  it("an operator-bound workspace counts as the company's one workspace", async () => {
    const w = world();
    await createSlackWorkspaceBindings({ client: w.db, tableName: "State" }).bind(A, "T0ACME", "operator");
    expect((await w.connect("beta-a")).body.error.code).toBe("SLACK_COMPANY_HAS_WORKSPACE");
    expect(w.slack.revoked).toEqual([tokenOf("beta-a")]);
    // The same workspace again is that company's: connected, token stored.
    expect((await w.connect("acme-code")).body).toMatchObject({ status: "connected", alreadyConnected: true });
  });
  it("the same workspace again for the same company replaces that company's token only", async () => {
    const w = world();
    await w.connect("beta-code", w.b);
    expect((await w.connect("acme-code")).status).toBe(200);
    w.tick(60_000);
    const again = await w.connect("acme-again");
    expect(again.body).toMatchObject({ status: "connected", alreadyConnected: true, workspace: { teamId: "T0ACME" } });
    expect(JSON.parse(w.sm.store.get(secretName(A, "T0ACME"))!)).toEqual({ botToken: tokenOf("acme-again") });
    expect(JSON.parse(w.sm.store.get(secretName(B, "T0BETA"))!)).toEqual({ botToken: tokenOf("beta-code") });
    expect(w.db.get("SLACK_TEAM#T0ACME", "BINDING")).toMatchObject({ companyId: A, boundAt: TIME });
    expect(w.slack.revoked).toEqual([]);
  });
  it("two companies racing for one workspace: exactly one wins; the loser stores nothing and nothing is revoked", async () => {
    const w = world();
    const [stateA, stateB] = [(await w.start(w.a)).body.state, (await w.start(w.b)).body.state];
    const answers = await Promise.all([w.complete({ state: stateA, code: "acme-code" }, w.a), w.complete({ state: stateB, code: "acme-b" }, w.b)]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    const winner = answers[0].status === 200 ? A : B;
    expect(w.db.get("SLACK_TEAM#T0ACME", "BINDING")).toMatchObject({ companyId: winner });
    expect(workspaceSecrets(w)).toEqual([secretName(winner, "T0ACME")]);
    expect(w.slack.revoked).toEqual([]);
  });
  it("one company racing two workspaces: exactly one wins; the loser's token is revoked", async () => {
    const w = world();
    const states = [(await w.start()).body.state, (await w.start()).body.state];
    const answers = await Promise.all([w.complete({ state: states[0], code: "acme-code" }), w.complete({ state: states[1], code: "beta-a" })]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    const lost = answers[0].status === 409 ? "acme-code" : "beta-a";
    expect(w.slack.revoked).toEqual([tokenOf(lost)]);
    expect(workspaceSecrets(w)).toHaveLength(1);
  });
  it("before the operator backfill nothing binds (the legacy workspace is the implicit company's)", async () => {
    const w = world(undefined, { marker: false });
    expect((await w.connect("acme-code")).status).toBe(503);
    expect(w.db.get("SLACK_TEAM#T0ACME", "BINDING")).toBeUndefined();
    expect(workspaceSecrets(w)).toEqual([]);
  });
  it("a token-store write that fails answers try again and leaves no token", async () => {
    const w = world();
    w.identity.secrets.putToken = async () => { throw new Error("denied"); };
    expect((await w.connect("acme-code")).status).toBe(503);
    expect(workspaceSecrets(w)).toEqual([]);
  });
});

describe("Slack's removal events", () => {
  const signingSecret = "signing";
  const signed = (body: unknown, now: number) => {
    const raw = JSON.stringify(body); const ts = String(Math.floor(now / 1000));
    return { body: raw, headers: { "x-slack-request-timestamp": ts, "x-slack-signature": `v0=${createHmac("sha256", signingSecret).update(`v0:${ts}:${raw}`).digest("hex")}` } };
  };
  const uninstall = (team: string, eventTime: number) => ({ type: "event_callback", team_id: team, api_app_id: "A0APP", event: { type: "app_uninstalled" }, event_id: "Ev1", event_time: eventTime });

  it("the ingress hands a signed app_uninstalled or bot tokens_revoked to the broker, and nothing unsigned", async () => {
    const now = Date.parse(TIME);
    for (const make of [
      (removed: NonNullable<SlackIngressDependencies["workspaceRemoved"]>) => createSlackIngressHandler({ secrets: async () => ({ signingSecret, botToken: "x" }), workspaceRemoved: removed, now: () => now } as unknown as SlackIngressDependencies),
      (removed: NonNullable<SlackIngressDependencies["workspaceRemoved"]>) => createSlackAdapterFront({ secrets: async () => ({ signingSecret }), isRovaraThread: async () => false, handOff: async () => undefined, workspaceRemoved: removed, now: () => now }),
    ]) {
      const handed: unknown[] = [];
      const handler = make(async (removal) => { handed.push(removal); });
      expect((await handler(signed(uninstall("T0ACME", 1_800_000_000), now) as never)).statusCode).toBe(200);
      expect((await handler(signed({ ...uninstall("T0ACME", 1_800_000_001), event: { type: "tokens_revoked", tokens: { bot: ["UBOT0001"] } } }, now) as never)).statusCode).toBe(200);
      expect((await handler(signed({ ...uninstall("T0ACME", 1), event: { type: "tokens_revoked", tokens: { oauth: ["U1"] } } }, now) as never)).statusCode).toBe(200);
      const forged = signed(uninstall("T0BETA", 1), now);
      expect((await handler({ ...forged, headers: { ...forged.headers, "x-slack-signature": "v0=00" } })).statusCode).toBe(401);
      expect(handed).toEqual([
        { source: "agentx.slack-workspace-removed", teamId: "T0ACME", reason: "app_uninstalled", eventTime: 1_800_000_000 },
        { source: "agentx.slack-workspace-removed", teamId: "T0ACME", reason: "tokens_revoked", eventTime: 1_800_000_001 },
      ]);
      const failing = make(async () => { throw new Error("broker down"); });
      expect((await failing(signed(uninstall("T0ACME", 1_800_000_000), now) as never)).statusCode).toBe(500);
    }
    expect(slackWorkspaceRemovalOf({ ...uninstall("E0GRID", 5) })).toBeUndefined();
  });

  it("an uninstall in B's workspace marks B disconnected and drops B's token; A is untouched", async () => {
    const w = world();
    await w.connect("acme-code"); await w.connect("beta-code", w.b);
    w.tick(60_000);
    const ctx = { documentClient: w.db, tableName: "State", now: w.nowMs, wiring: w.wiring };
    expect(await handleSlackWorkspaceRemoved(ctx, { source: "agentx.slack-workspace-removed", teamId: "T0BETA", reason: "app_uninstalled", eventTime: Math.floor(w.nowMs() / 1000) }))
      .toEqual({ outcome: "disconnected" });
    expect(w.db.get(companyInstallKey(B).pk, "WORKSPACE")).toMatchObject({ status: "disconnected", disconnectedBy: "slack" });
    expect(await w.tokens.tokenForCompany(B, "T0BETA")).toBeUndefined();
    expect(w.db.get("SLACK_TEAM#T0BETA", "BINDING")).toMatchObject({ companyId: B });
    expect(w.db.get(companyInstallKey(A).pk, "WORKSPACE")).toMatchObject({ status: "connected" });
    expect(await w.tokens.tokenForCompany(A, "T0ACME")).toBe(tokenOf("acme-code"));
    expect(w.logs.at(-1)).toEqual({ companyId: B, event: "slack.workspace_removed", teamId: "T0BETA", reason: "app_uninstalled", actor: "slack" });
    expect([...w.db.items.values()].filter((row) => row.entityType === "SLACK_WORKSPACE_AUDIT" && row.actor === "slack")).toEqual([expect.objectContaining({ companyId: B, teamId: "T0BETA" })]);
    // The status read says so; B's read never shows A.
    expect((await w.read(w.b)).body.workspace).toMatchObject({ teamId: "T0BETA", state: "disconnected", disconnectedBy: "slack" });
    // Reconnecting the same workspace is B's again.
    expect((await w.connect("beta-a", w.b)).body).toMatchObject({ status: "connected", alreadyConnected: true });
  });

  it("ignores an unbound workspace and an event older than the latest connect", async () => {
    const w = world();
    const ctx = { documentClient: w.db, tableName: "State", now: w.nowMs, wiring: w.wiring };
    expect(await handleSlackWorkspaceRemoved(ctx, { source: "agentx.slack-workspace-removed", teamId: "T0ACME", reason: "app_uninstalled", eventTime: 1_800_000_000 })).toEqual({ outcome: "ignored" });
    await w.connect("acme-code");
    const stale = Math.floor(Date.parse(TIME) / 1000) - 1;
    expect(await handleSlackWorkspaceRemoved(ctx, { source: "agentx.slack-workspace-removed", teamId: "T0ACME", reason: "tokens_revoked", eventTime: stale })).toEqual({ outcome: "ignored" });
    expect(await w.tokens.tokenForCompany(A, "T0ACME")).toBe(tokenOf("acme-code"));
    expect(w.db.get(companyInstallKey(A).pk, "WORKSPACE")).toMatchObject({ status: "connected" });
  });
});

describe("disconnect", () => {
  const fresh = () => Math.floor(Date.parse(TIME) / 1000);
  it("needs an owner with a fresh step-up", async () => {
    const w = world();
    await w.connect("acme-code");
    expect((await w.disconnect()).body.error).toEqual({ code: "FORBIDDEN", message: SLACK_OWNER_ONLY });
    w.as(PERSON, A, "owner");
    expect((await w.disconnect()).body.error).toEqual({ code: "REAUTH_REQUIRED", message: SLACK_DISCONNECT_STEP_UP });
    w.as(PERSON, A, "owner", "session", fresh() - 3600);
    expect((await w.disconnect()).body.error.code).toBe("REAUTH_REQUIRED");
    expect(w.db.get("SLACK_TEAM#T0ACME", "BINDING")).toBeDefined();
    expect(w.slack.revoked).toEqual([]);
  });
  it("revokes A's token, drops it, unbinds, removes A's channel links and names their projects; B is untouched", async () => {
    const w = world();
    await w.connect("acme-code"); await w.connect("beta-code", w.b);
    for (const [team, channel, project] of [["T0ACME", "C1", "web"], ["T0ACME", "C2", "api"], ["T0ACME", "C3", "web"], ["T0BETA", "C9", "beta-app"]] as const) {
      w.db.set({ pk: `SLACK_BINDING#${team}`, sk: `CHANNEL#${channel}`, teamId: team, channelId: channel, projectName: project, updatedAt: TIME });
    }
    w.as(PERSON, A, "owner", "session", fresh());
    const answer = await w.disconnect();
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ status: "disconnected", workspace: { teamId: "T0ACME", teamName: "Acme" }, projectsLosingChannel: ["api", "web"] });
    expect(w.slack.revoked).toEqual([tokenOf("acme-code")]);
    expect(await w.tokens.tokenForCompany(A, "T0ACME")).toBeUndefined();
    expect(w.db.get("SLACK_TEAM#T0ACME", "BINDING")).toBeUndefined();
    expect(w.db.get(`ORG#${A}#SLACK_WORKSPACES`, "TEAM#T0ACME")).toBeUndefined();
    expect(w.db.get(companyInstallKey(A).pk, "WORKSPACE")).toBeUndefined();
    expect(w.db.get("SLACK_BINDING#T0ACME", "CHANNEL#C1")).toBeUndefined();
    expect(w.db.get("SLACK_BINDING#T0BETA", "CHANNEL#C9")).toBeDefined();
    expect(w.db.get("SLACK_TEAM#T0BETA", "BINDING")).toMatchObject({ companyId: B });
    expect(await w.tokens.tokenForCompany(B, "T0BETA")).toBe(tokenOf("beta-code"));
    expect([...w.db.items.values()].filter((row) => row.entityType === "SLACK_WORKSPACE_AUDIT" && row.action === "disconnect")).toEqual([expect.objectContaining({ companyId: A, actor: PERSON })]);
    expect((await w.read()).body.workspace).toBeNull();
    // Then the workspace may go to another company.
    expect((await w.connect("acme-b", w.b)).body.error.code).toBe("SLACK_COMPANY_HAS_WORKSPACE");
    expect((await w.disconnect()).body.error).toEqual({ code: "NOT_FOUND", message: SLACK_NOT_CONNECTED });
  });
  it("leaves everything bound when the revoke fails, so pressing again finishes", async () => {
    const w = world();
    await w.connect("acme-code");
    w.as(PERSON, A, "owner", "session", fresh());
    const real = w.identity.fetch;
    w.identity.fetch = async () => { throw new Error("offline"); };
    expect((await w.disconnect()).status).toBe(503);
    expect(w.db.get("SLACK_TEAM#T0ACME", "BINDING")).toBeDefined();
    expect(await w.tokens.tokenForCompany(A, "T0ACME")).toBe(tokenOf("acme-code"));
    w.identity.fetch = real;
    expect((await w.disconnect()).status).toBe(200);
  });
});

describe("status read", () => {
  it("any member reads the company's workspace, who connected it and when; never a token", async () => {
    const w = world();
    expect((await w.read()).body.workspace).toBeNull();
    await w.connect("acme-code");
    w.as(PERSON, A, "member");
    const answer = await w.read();
    expect(answer.body.workspace).toEqual({ teamId: "T0ACME", teamName: "Acme", state: "connected", connectedAt: TIME, connectedBy: { kind: "person", personId: PERSON, name: "Ada Admin" } });
    expect(answer.raw).not.toContain("xoxb");
    expect((await w.read(w.b)).body.workspace).toBeNull();
  });
});

describe("leaks", () => {
  it("no answer or log line carries a token, a code, a state or the client secret", async () => {
    const w = world();
    const raws: string[] = [];
    const started = await w.start(); raws.push(started.raw);
    const state = started.body.state as string;
    raws.push((await w.complete({ state, code: "acme-code" })).raw);
    raws.push((await w.connect("acme-b", w.b)).raw, (await w.connect("beta-a")).raw, (await w.connect("grid-code")).raw, (await w.connect("unknown-code")).raw);
    w.as(PERSON, A, "owner", "session", Math.floor(Date.parse(TIME) / 1000));
    raws.push((await w.disconnect()).raw);
    const answersAfterStart = raws.slice(1).join("\n");
    for (const secret of [tokenOf("acme-code"), tokenOf("acme-b"), tokenOf("beta-a"), tokenOf("grid-code"), "acme-code", "acme-b", "unknown-code", CLIENT_SECRET, "xoxb"]) {
      expect(answersAfterStart, secret).not.toContain(secret);
      expect(JSON.stringify(w.logs), secret).not.toContain(secret);
    }
    expect(answersAfterStart).not.toContain(state);
    expect(JSON.stringify(w.logs)).not.toContain(state);
    expect(JSON.stringify([...w.db.items.values()])).not.toContain("xoxb");
  });
});

describe("the sign-in Lambda's slack-install invoke", () => {
  it("refuses malformed requests before calling Slack or the token store", async () => {
    const w = world();
    for (const event of [
      { kind: "slack-install", op: "store", companyId: "org_bad", teamId: "T0ACME", botToken: tokenOf("x") },
      { kind: "slack-install", op: "store", companyId: A, teamId: "E0GRID", botToken: tokenOf("x") },
      { kind: "slack-install", op: "store", companyId: A, teamId: "T0ACME", botToken: "xoxp-user" },
      { kind: "slack-install", op: "drop", companyId: A, teamId: "T0ACME", extra: 1 },
      { kind: "slack-install", op: "exchange", code: "a b", redirectUri: CALLBACK },
      { kind: "slack-install", op: "unknown" },
    ]) expect(await handleSlackInstallRequest(w.identity, event)).toEqual({ ok: false, error: "invalid_request" });
    expect(w.slack.fetch).not.toHaveBeenCalled();
    expect(w.sm.calls.filter((call) => call.includes("slack-workspaces"))).toEqual([]);
  });
  it("exchanges only with a stored client id and secret", async () => {
    const w = world(undefined, { appClient: false });
    expect(await handleSlackInstallRequest(w.identity, { kind: "slack-install", op: "exchange", code: "acme-code", redirectUri: CALLBACK })).toEqual({ ok: false, error: "not_set_up" });
    expect((await w.start()).body.error).toEqual({ code: "RUNTIME_UNAVAILABLE", message: SLACK_NOT_SET_UP });
    expect(w.slack.fetch).not.toHaveBeenCalled();
  });
});

describe("review round 1", () => {
  const fresh = () => Math.floor(Date.parse(TIME) / 1000);
  it("an admin re-adding a second workspace the company already holds (operator-bound) never revokes that workspace's bot", async () => {
    const w = world();
    const operator = createSlackWorkspaceBindings({ client: w.db, tableName: "State" });
    await operator.bind(A, "T0ACME", "operator"); await operator.bind(A, "T0BETA", "operator");
    expect((await w.connect("beta-a")).body.error.code).toBe("SLACK_COMPANY_HAS_WORKSPACE");
    expect(w.slack.revoked).toEqual([]);
    expect(workspaceSecrets(w)).toEqual([]);
  });
  it("a record whose workspace is no longer this company's: disconnect removes only the record, revokes nothing and leaves the other company's links", async () => {
    const w = world();
    await w.connect("acme-code");
    w.db.set({ pk: "SLACK_TEAM#T0ACME", sk: "BINDING", entityType: "SLACK_WORKSPACE_BINDING", teamId: "T0ACME", companyId: B, boundAt: TIME, boundBy: "operator" });
    w.db.set({ pk: "SLACK_BINDING#T0ACME", sk: "CHANNEL#C7", teamId: "T0ACME", channelId: "C7", projectName: "b-app", updatedAt: TIME });
    expect((await w.read()).body.workspace).toBeNull();
    w.as(PERSON, A, "owner", "session", fresh());
    const answer = await w.disconnect();
    expect(answer.body).toMatchObject({ status: "disconnected", projectsLosingChannel: [] });
    expect(w.slack.revoked).toEqual([]);
    expect(w.db.get("SLACK_BINDING#T0ACME", "CHANNEL#C7")).toBeDefined();
    expect(w.db.get("SLACK_TEAM#T0ACME", "BINDING")).toMatchObject({ companyId: B });
    expect(w.db.get(companyInstallKey(A).pk, "WORKSPACE")).toBeUndefined();
  });
  it("a reconnect landing during a disconnect makes the disconnect fail closed; pressing again finishes", async () => {
    const w = world();
    await w.connect("acme-code");
    w.as(PERSON, A, "owner", "session", fresh());
    const secrets = w.identity.secrets;
    const real = (company: string, team: string) => secrets.readToken(company, team);
    w.identity.secrets = { ...secrets, readToken: async (company, team) => {
      const row = w.db.get(companyInstallKey(A).pk, "WORKSPACE")!;
      w.db.set({ ...row, connectedAt: "2026-11-14T12:00:01.000Z" });
      w.identity.secrets = secrets;
      return real(company, team);
    } };
    expect((await w.disconnect()).status).toBe(503);
    expect(w.db.get("SLACK_TEAM#T0ACME", "BINDING")).toMatchObject({ companyId: A });
    expect((await w.disconnect()).status).toBe(200);
    expect(w.db.get("SLACK_TEAM#T0ACME", "BINDING")).toBeUndefined();
  });
  it("disconnect takes no body", async () => {
    const w = world(); await w.connect("acme-code"); w.as(PERSON, A, "owner", "session", fresh());
    expect((await w.call("POST", "/v1/dev/company/slack/disconnect", { companyId: B })).status).toBe(400);
    expect(w.db.get("SLACK_TEAM#T0ACME", "BINDING")).toBeDefined();
  });
  it("a removal for another team bound to the same company, or a repeat, changes nothing more", async () => {
    const w = world();
    await w.connect("acme-code");
    await createSlackWorkspaceBindings({ client: w.db, tableName: "State" }).bind(A, "T0BETA", "operator");
    const ctx = { documentClient: w.db, tableName: "State", now: w.nowMs, wiring: w.wiring };
    const now = Math.floor(w.nowMs() / 1000);
    expect(await handleSlackWorkspaceRemoved(ctx, { source: "agentx.slack-workspace-removed", teamId: "T0BETA", reason: "app_uninstalled", eventTime: now })).toEqual({ outcome: "ignored" });
    expect(await w.tokens.tokenForCompany(A, "T0ACME")).toBe(tokenOf("acme-code"));
    expect(await handleSlackWorkspaceRemoved(ctx, { source: "agentx.slack-workspace-removed", teamId: "T0ACME", reason: "app_uninstalled", eventTime: now })).toEqual({ outcome: "disconnected" });
    expect(await handleSlackWorkspaceRemoved(ctx, { source: "agentx.slack-workspace-removed", teamId: "T0ACME", reason: "tokens_revoked", eventTime: now })).toEqual({ outcome: "ignored" });
    expect([...w.db.items.values()].filter((row) => row.entityType === "SLACK_WORKSPACE_AUDIT" && row.actor === "slack")).toHaveLength(1);
  });
  it("Slack's side refuses an answer that is not ok, not 200, or not a bot grant; the broker refuses a malformed or failed invoke reply", async () => {
    const w = world({ "not-ok": { team: ACME, okFalseWithToken: true }, "http-500": { team: ACME, status: 500 }, "acme-code": { team: ACME } });
    for (const code of ["not-ok", "http-500"]) expect((await w.connect(code)).body.error).toEqual(uniform);
    const failing = slackInstallThroughLambda(async () => ({ FunctionError: "Unhandled", Payload: Buffer.from(JSON.stringify({ ok: true, exchange: { kind: "refused" } })) }));
    await expect(failing.exchange("acme-code", CALLBACK)).rejects.toThrow();
    const extra = slackInstallThroughLambda(async () => ({ Payload: Buffer.from(JSON.stringify({ ok: true, exchange: { kind: "granted", grant: { teamId: "T0ACME", botToken: tokenOf("x"), botUserId: "UBOT0001", installerSlackUserId: "U0INSTALL", companyId: B } } })) }));
    await expect(extra.exchange("acme-code", CALLBACK)).rejects.toThrow();
    w.slack.control.revokeAnswer = { ok: true, revoked: false };
    expect(await handleSlackInstallRequest(w.identity, { kind: "slack-install", op: "revoke", botToken: tokenOf("x") })).toEqual({ ok: true, revoked: false });
    expect(await handleSlackInstallRequest(w.identity, { kind: "slack-install", op: "store", companyId: A, teamId: "T0ACME", botToken: tokenOf("x"), extra: 1 })).toEqual({ ok: false, error: "invalid_request" });
    await expect(w.identity.secrets.putToken(A, "T0ACME", "xoxp-user")).rejects.toThrow();
    await expect(slackInstallSecretsFromSecretsManager(w.sm.client, "test").putToken("org_bad", "T0ACME", tokenOf("x"))).rejects.toThrow();
    expect(workspaceSecrets(w)).toEqual([]);
  });
});

describe("review round 2 (removal races)", () => {
  it("a repeat removal re-drops a token a failed drop left behind, without a second audit row", async () => {
    const w = world();
    await w.connect("acme-code");
    const ctx = { documentClient: w.db, tableName: "State", now: w.nowMs, wiring: w.wiring };
    const event = { source: "agentx.slack-workspace-removed" as const, teamId: "T0ACME", reason: "app_uninstalled" as const, eventTime: Math.floor(w.nowMs() / 1000) };
    expect(await handleSlackWorkspaceRemoved(ctx, event)).toEqual({ outcome: "disconnected" });
    w.sm.store.set(secretName(A, "T0ACME"), JSON.stringify({ botToken: tokenOf("acme-code") }));
    expect(await handleSlackWorkspaceRemoved(ctx, event)).toEqual({ outcome: "ignored" });
    expect(await w.tokens.tokenForCompany(A, "T0ACME")).toBeUndefined();
    expect([...w.db.items.values()].filter((row) => row.entityType === "SLACK_WORKSPACE_AUDIT" && row.actor === "slack")).toHaveLength(1);
  });
  it("a reconnect landing between the mark and the drop keeps its new token", async () => {
    const w = world();
    await w.connect("acme-code");
    const later = "2026-11-14T12:00:05.000Z";
    const racing = { send: async (command: unknown) => {
      const answer = await w.db.send(command as never);
      if ((command as { constructor: { name: string } }).constructor.name === "UpdateCommand") {
        const row = w.db.get(companyInstallKey(A).pk, "WORKSPACE")!;
        w.db.set({ ...row, status: "connected", connectedAt: later });
        w.sm.store.set(secretName(A, "T0ACME"), JSON.stringify({ botToken: tokenOf("acme-again") }));
      }
      return answer;
    } };
    const ctx = { documentClient: racing, tableName: "State", now: w.nowMs, wiring: w.wiring };
    expect(await handleSlackWorkspaceRemoved(ctx, { source: "agentx.slack-workspace-removed", teamId: "T0ACME", reason: "app_uninstalled", eventTime: Math.floor(w.nowMs() / 1000) }))
      .toEqual({ outcome: "ignored" });
    expect(await w.tokens.tokenForCompany(A, "T0ACME")).toBe(tokenOf("acme-again"));
  });
  it("disconnecting an operator-bound workspace fails closed if a person's connect record lands meanwhile", async () => {
    const w = world();
    await createSlackWorkspaceBindings({ client: w.db, tableName: "State" }).bind(A, "T0ACME", "operator");
    w.as(PERSON, A, "owner", "session", Math.floor(Date.parse(TIME) / 1000));
    const secrets = w.identity.secrets;
    w.identity.secrets = { ...secrets, readToken: async (company, team) => {
      w.db.set({ ...companyInstallKey(A), entityType: "SLACK_COMPANY_WORKSPACE", companyId: A, teamId: "T0ACME", status: "connected", connectedAt: TIME, connectedBy: PERSON });
      w.identity.secrets = secrets;
      return secrets.readToken(company, team);
    } };
    expect((await w.disconnect()).status).toBe(503);
    expect(w.db.get("SLACK_TEAM#T0ACME", "BINDING")).toMatchObject({ companyId: A });
  });
});
