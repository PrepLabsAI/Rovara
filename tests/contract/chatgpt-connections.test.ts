// Sign in with ChatGPT (#338): OpenAI's side of a connection, each developer's connection in the
// control plane, and its developer routes. OpenAI is a fake that answers as the spike of 2026-10-11
// found the real service does. Nothing here reaches AWS or OpenAI.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentXError, CHATGPT_CALLBACK_URL } from "@agentx/contracts";
import { ACCESS_TOKEN_MARGIN_MS, chatGptConnections, type ChatGptSealer } from "../../packages/broker/src/chatgpt/connections.js";
import { chatGptAuthorization, chatGptHostId, chatGptModels, parseChatGptCallback, CHATGPT_TOKEN_URL } from "../../packages/broker/src/chatgpt/oauth.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { createAdminBroker } from "../support/admin-broker.js";
import { localSigner } from "../support/developer-fakes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const HOST = chatGptHostId("arn:aws:kms:us-east-1:123456789012:key/test");
const ALLOWED = ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.5"];

/** Marks what it sealed and refuses to open a value under another developer or field. */
const SEALER: ChatGptSealer = {
  seal: async (plain, context) => `sealed[${context.developerId}/${context.field}]:${plain}`,
  open: async (sealed, context) => {
    const prefix = `sealed[${context.developerId}/${context.field}]:`;
    if (!sealed.startsWith(prefix)) throw Object.assign(new Error("context mismatch"), { name: "InvalidCiphertextException" });
    return sealed.slice(prefix.length);
  },
};

const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.y`;

/** OpenAI's token endpoint and model list, as the spike found them: refresh rotates the token. */
function fakeOpenAi(options: { models?: number; scope?: string } = {}) {
  let issued = 0;
  const valid = new Set<string>();
  const calls: Array<Record<string, string>> = [];
  const tokens = () => {
    issued += 1;
    const refresh = `refresh-${issued}`;
    valid.add(refresh);
    return { access_token: `access-${issued}`, refresh_token: refresh, expires_in: 3600, id_token: idToken("alice@acme.com"), scope: options.scope ?? "openid email chatgpt.tokens.use.direct" };
  };
  const fetchImplementation = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    if (target === CHATGPT_TOKEN_URL) {
      const fields = Object.fromEntries(new URLSearchParams(typeof init?.body === "string" ? init.body : ""));
      calls.push(fields);
      if (fields.grant_type === "authorization_code") {
        if (fields.code === "refused-code") return new Response(JSON.stringify({ error: "invalid_grant", error_description: "code secret abc" }), { status: 400 });
        return new Response(JSON.stringify(tokens()), { status: 200 });
      }
      if (!valid.has(fields.refresh_token ?? "")) return new Response(JSON.stringify({ error: "invalid_grant", error_description: "refresh token secret abc" }), { status: 400 });
      valid.delete(fields.refresh_token ?? "");
      return new Response(JSON.stringify(tokens()), { status: 200 });
    }
    if (target === "https://api.openai.com/v1/models") {
      if (options.models !== undefined) return new Response("{}", { status: options.models });
      return new Response(JSON.stringify({ models: ALLOWED.map((slug) => ({ slug, display_name: slug })) }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchImplementation, calls, revokeAll: () => valid.clear() };
}

function harness(openAi = fakeOpenAi()) {
  let clock = 1_790_000_000_000;
  const db = new FakeDynamoDb();
  const connections = chatGptConnections({ documentClient: db, tableName: "state", sealer: SEALER, fetch: openAi.fetch, now: () => clock, hostId: HOST, sleep: async () => { clock += 500; } });
  /** What the browser ends on after Allow, for the state of `authorizeUrl`. */
  const callbackFor = (authorizeUrl: string, code = "the-code") => `${CHATGPT_CALLBACK_URL}?code=${code}&scope=x&state=${new URL(authorizeUrl).searchParams.get("state") ?? ""}&client_id=oaiapp_issued`;
  return { db, connections, openAi, callbackFor, advance: (ms: number) => { clock += ms; } };
}

describe("OpenAI's side of Sign in with ChatGPT", () => {
  it("asks for the dynamic client, the local callback, Rovara's name and the plan scope, with PKCE", () => {
    const { url, state, verifier } = chatGptAuthorization(HOST);
    const query = Object.fromEntries(new URL(url).searchParams);
    expect(query).toMatchObject({
      client_id: "dynamic_agent_client", agent_name_hint: "Rovara", ext_agent_host_id: HOST, response_type: "code",
      redirect_uri: "http://127.0.0.1:1455/auth/callback", resource: "https://api.openai.com/v1", state, code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    });
    expect(query.scope?.split(" ")).toContain("chatgpt.tokens.use.direct");
  });

  it("names the install with a stable UUID that OpenAI accepts", () => {
    expect(HOST).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(chatGptHostId("arn:aws:kms:us-east-1:123456789012:key/test")).toBe(HOST);
    expect(chatGptHostId("another install")).not.toBe(HOST);
  });

  it("reads the code, state and issued client ID from the address the browser ended on, and refuses anything else", () => {
    expect(parseChatGptCallback(`${CHATGPT_CALLBACK_URL}?code=c&scope=s&state=st&client_id=oaiapp_1`)).toEqual({ code: "c", state: "st", clientId: "oaiapp_1" });
    expect(() => parseChatGptCallback("not an address")).toThrow("copy the whole address that starts with http://127.0.0.1:1455/");
    expect(() => parseChatGptCallback("https://evil.example.com/auth/callback?code=c&state=s&client_id=x")).toThrow("http://127.0.0.1:1455/auth/callback");
    expect(() => parseChatGptCallback(`${CHATGPT_CALLBACK_URL}?error=access_denied&state=s`)).toThrow("ChatGPT did not connect (access_denied)");
    expect(() => parseChatGptCallback(`${CHATGPT_CALLBACK_URL}?error=<script>&state=s`)).toThrow(/^CONFIG_INVALID: ChatGPT did not connect$/);
    expect(() => parseChatGptCallback(`${CHATGPT_CALLBACK_URL}?state=s&client_id=x`)).toThrow("that address has no sign-in code");
  });

  it("reads the allowed models from OpenAI's Codex-style list, and calls a refusal not eligible", async () => {
    expect(await chatGptModels({ fetch: fakeOpenAi().fetch, access: "a" })).toEqual(ALLOWED);
    await expect(chatGptModels({ fetch: fakeOpenAi({ models: 403 }).fetch, access: "a" })).rejects.toThrow("needs a ChatGPT Plus or Pro plan");
  });
});

describe("a developer's ChatGPT connection", () => {
  it("connects from the pasted address: exchanges the code, checks the plan, and keeps only sealed tokens", async () => {
    const { db, connections, openAi, callbackFor } = harness();
    const started = await connections.start("dev-alice");
    const view = await connections.finish("dev-alice", { callbackUrl: callbackFor(started.authorizeUrl) });
    expect(view).toEqual({ connected: true, status: "connected", email: "alice@acme.com", connectedAt: expect.any(String) as unknown, models: ALLOWED });
    // The code was exchanged with the verifier only the control plane held, for the client OpenAI issued.
    const exchange = openAi.calls.find((call) => call.grant_type === "authorization_code");
    expect(exchange).toMatchObject({ code: "the-code", client_id: "oaiapp_issued", redirect_uri: CHATGPT_CALLBACK_URL });
    expect(createHash("sha256").update(exchange?.code_verifier ?? "").digest("base64url")).toBe(new URL(started.authorizeUrl).searchParams.get("code_challenge"));
    const record = db.get("CHATGPT#dev-alice", "CONNECTION");
    expect(record).toMatchObject({ clientId: "oaiapp_issued", sealedRefresh: "sealed[dev-alice/refresh]:refresh-1", sealedAccess: "sealed[dev-alice/access]:access-1" });
    expect(JSON.stringify(record)).not.toMatch(/"(refresh|access)-1"/);
    expect(db.get("CHATGPT#dev-alice", "PENDING")).toBeUndefined();
  });

  it("finishes from the CLI's own callback values too", async () => {
    const { connections } = harness();
    const started = await connections.start("dev-alice");
    const state = new URL(started.authorizeUrl).searchParams.get("state") ?? "";
    expect(await connections.finish("dev-alice", { code: "c", state, clientId: "oaiapp_cli" })).toMatchObject({ connected: true });
  });

  it("finishes only the newest start, once, by the developer who started it, before it expires", async () => {
    const { connections, callbackFor, advance } = harness();
    const first = await connections.start("dev-alice");
    const second = await connections.start("dev-alice");
    await expect(connections.finish("dev-alice", { callbackUrl: callbackFor(first.authorizeUrl) })).rejects.toThrow("a newer one replaced it");
    await expect(connections.finish("dev-bob", { callbackUrl: callbackFor(second.authorizeUrl) })).rejects.toThrow("this sign-in was not started by you");
    await connections.finish("dev-alice", { callbackUrl: callbackFor(second.authorizeUrl) });
    await expect(connections.finish("dev-alice", { callbackUrl: callbackFor(second.authorizeUrl) })).rejects.toThrow("not started by you, or a newer one replaced it");
    const late = await connections.start("dev-alice");
    advance(11 * 60_000);
    await expect(connections.finish("dev-alice", { callbackUrl: callbackFor(late.authorizeUrl) })).rejects.toThrow("this sign-in has expired");
  });

  it("keeps nothing when the plan is not eligible", async () => {
    const { db, connections, callbackFor } = harness(fakeOpenAi({ models: 403 }));
    const started = await connections.start("dev-alice");
    await expect(connections.finish("dev-alice", { callbackUrl: callbackFor(started.authorizeUrl) })).rejects.toThrow("needs a ChatGPT Plus or Pro plan");
    expect(db.get("CHATGPT#dev-alice", "CONNECTION")).toBeUndefined();
    expect(await connections.view("dev-alice")).toEqual({ connected: false });
  });

  it("refuses a grant without the plan scope", async () => {
    const { connections, callbackFor } = harness(fakeOpenAi({ scope: "openid email" }));
    const started = await connections.start("dev-alice");
    await expect(connections.finish("dev-alice", { callbackUrl: callbackFor(started.authorizeUrl) })).rejects.toThrow("did not grant Rovara the use of your plan");
  });

  it("hands a task its owner's access token, refreshing it near expiry and always keeping the rotated refresh token", async () => {
    const { db, connections, openAi, callbackFor, advance } = harness();
    await connections.finish("dev-alice", { callbackUrl: callbackFor((await connections.start("dev-alice")).authorizeUrl) });
    expect(await connections.accessToken("dev-alice")).toMatchObject({ access: "access-1", models: ALLOWED });
    advance(60 * 60_000 - ACCESS_TOKEN_MARGIN_MS + 1);
    expect((await connections.accessToken("dev-alice")).access).toBe("access-2");
    expect(db.get("CHATGPT#dev-alice", "CONNECTION")).toMatchObject({ sealedRefresh: "sealed[dev-alice/refresh]:refresh-2", version: 2 });
    expect(openAi.calls.filter((call) => call.grant_type === "refresh_token").map((call) => call.client_id)).toEqual(["oaiapp_issued"]);
  });

  it("refreshes once when two tasks need a new token at the same moment", async () => {
    const { connections, openAi, callbackFor, advance } = harness();
    await connections.finish("dev-alice", { callbackUrl: callbackFor((await connections.start("dev-alice")).authorizeUrl) });
    advance(60 * 60_000);
    const [one, two] = await Promise.all([connections.accessToken("dev-alice"), connections.accessToken("dev-alice")]);
    expect(one.access).toBe(two.access);
    expect(openAi.calls.filter((call) => call.grant_type === "refresh_token")).toHaveLength(1);
  });

  it("marks the connection revoked when OpenAI refuses the refresh, and never echoes OpenAI's description", async () => {
    const { connections, openAi, callbackFor, advance } = harness();
    await connections.finish("dev-alice", { callbackUrl: callbackFor((await connections.start("dev-alice")).authorizeUrl) });
    openAi.revokeAll();
    advance(60 * 60_000);
    const refused = await connections.accessToken("dev-alice").then(() => undefined, (error: unknown) => error as Error);
    expect(refused?.message).toBe("AUTH_REQUIRED: the ChatGPT connection was revoked or expired; connect ChatGPT again");
    expect(refused?.message).not.toContain("secret abc");
    expect(await connections.view("dev-alice")).toMatchObject({ connected: false, status: "revoked" });
  });

  it("disconnects: the stored tokens are deleted, and no task gets a token any more", async () => {
    const { db, connections, callbackFor } = harness();
    await connections.finish("dev-alice", { callbackUrl: callbackFor((await connections.start("dev-alice")).authorizeUrl) });
    expect(await connections.disconnect("dev-alice")).toEqual({ connected: false });
    expect(db.get("CHATGPT#dev-alice", "CONNECTION")).toBeUndefined();
    await expect(connections.accessToken("dev-alice")).rejects.toThrow("has not connected ChatGPT");
  });

  it("records what a task found: the plan's limit, or a changed model list", async () => {
    const { connections, callbackFor } = harness();
    await connections.finish("dev-alice", { callbackUrl: callbackFor((await connections.start("dev-alice")).authorizeUrl) });
    await connections.markStatus("dev-alice", "limit-reached", ["gpt-5.5"]);
    expect(await connections.view("dev-alice")).toMatchObject({ connected: true, status: "limit-reached", models: ["gpt-5.5"] });
    await connections.markStatus("dev-bob", "limit-reached");
    expect(await connections.view("dev-bob")).toEqual({ connected: false });
  });
});

describe("the developer routes for a ChatGPT connection", () => {
  const ISSUER = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth";
  const T0 = Date.parse("2026-10-11T12:00:00.000Z");
  const signer = localSigner();
  const developerId = "d".repeat(64);
  const bearer = async (sub: string) => {
    const jwt = { iss: ISSUER, aud: "agentx-developer", sub, amr: "slack", env: "staging", sid: `s-${sub.slice(0, 4)}`, iat: T0 / 1000, nbf: T0 / 1000, exp: T0 / 1000 + 3600 };
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: (await signer.publicJwk()).kid })).toString("base64url");
    const input = `${header}.${Buffer.from(JSON.stringify(jwt)).toString("base64url")}`;
    return `Bearer ${input}.${(await signer.sign(Buffer.from(input))).toString("base64url")}`;
  };

  async function broker(options: { chatgpt?: boolean } = {}) {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    const openAi = fakeOpenAi();
    const { db, handler } = await createAdminBroker({
      developer: {
        issuer: ISSUER, env: "staging", methods: { slack: true, oidc: false }, slackTeamId: "T0TEAM1", signInTableName: "signin",
        channelMembers: async () => ({ ok: true as const, memberOf: [] }),
        verifyAccessToken: developerTokenVerifier({ issuer: ISSUER, keys: async () => [await signer.publicJwk()], now: () => Date.now() }),
      },
      ...(options.chatgpt === false ? {} : {
        chatgpt: (table) => chatGptConnections({ documentClient: table, tableName: "state", sealer: SEALER, fetch: openAi.fetch, now: () => Date.now(), hostId: HOST }),
      }),
    });
    for (const id of [developerId, "e".repeat(64)]) {
      db.set({ pk: `SESSION#s-${id.slice(0, 4)}`, sk: "META", sessionId: `s-${id.slice(0, 4)}`, developerId: id, amr: "slack", startedAt: new Date(T0).toISOString(), endsAt: T0 / 1000 + 604_800 });
      db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "slack", issuer: "https://slack.com", subject: id, displayName: "Dev", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    }
    const call = async (method: string, as: string, body?: unknown) => {
      const response = await handler({
        rawPath: "/v1/dev/chatgpt/connection" + (body === undefined || method !== "POST" || !("callbackUrl" in (body as object)) ? "" : "/finish"),
        headers: { authorization: await bearer(as) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        requestContext: { requestId: "r", http: { method } },
      });
      // Every answer carries the request's ID; the assertions are about the rest.
      const rest = JSON.parse(response.body) as Record<string, unknown>;
      delete rest.requestId;
      return { status: response.statusCode, body: rest };
    };
    return { db, call };
  }
  afterEach(() => { vi.useRealTimers(); });

  it("starts, finishes and shows the caller's own connection, and never answers a token", async () => {
    const { call } = await broker();
    expect(await call("GET", developerId)).toEqual({ status: 200, body: { connected: false } });
    const started = await call("POST", developerId);
    expect(started.status).toBe(200);
    const authorizeUrl = String(started.body.authorizeUrl);
    expect(new URL(authorizeUrl).searchParams.get("agent_name_hint")).toBe("Rovara");
    const callbackUrl = `${CHATGPT_CALLBACK_URL}?code=c&state=${new URL(authorizeUrl).searchParams.get("state") ?? ""}&client_id=oaiapp_issued`;
    const finished = await call("POST", developerId, { callbackUrl });
    expect(finished).toMatchObject({ status: 200, body: { connected: true, email: "alice@acme.com", models: ALLOWED } });
    const shown = await call("GET", developerId);
    expect(JSON.stringify(shown.body)).not.toMatch(/access-|refresh-|sealed/);
    // Another developer sees only their own (none).
    expect((await call("GET", "e".repeat(64))).body).toEqual({ connected: false });
    expect(await call("DELETE", developerId)).toEqual({ status: 200, body: { connected: false } });
  });

  it("answers NOT_FOUND where the deployment has no connection key", async () => {
    const { call } = await broker({ chatgpt: false });
    const response = await call("GET", developerId);
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).toContain("Sign in with ChatGPT is not set up in this deployment");
  });
});

describe("a code OpenAI refuses", () => {
  it("is a 400 to start again, not a 401 that would read as the Rovara sign-in ending, and keeps nothing", async () => {
    const { db, connections, callbackFor } = harness();
    const { authorizeUrl } = await connections.start("dev-1");
    const refused = await connections.finish("dev-1", { callbackUrl: callbackFor(authorizeUrl, "refused-code") }).catch((error: unknown) => error as AgentXError);
    expect(refused).toBeInstanceOf(AgentXError);
    expect(refused.statusCode).toBe(400);
    expect(refused.message).toBe("CONFIG_INVALID: ChatGPT sign-in failed (invalid_grant); start connecting ChatGPT again");
    expect(db.get("CHATGPT#dev-1", "CONNECTION")).toBeUndefined();
  });
});
