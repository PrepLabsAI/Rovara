// `rovara doctor`'s Sign in with ChatGPT checks (#343): the control plane's GET /v1/admin/chatgpt,
// the connection index it counts, and the checks doctor prints from it.
import { describe, expect, it, vi } from "vitest";
import type { ChatGptHealth } from "../../packages/contracts/src/index.js";
import { chatGptConnections, type ChatGptSealer } from "../../packages/broker/src/chatgpt/connections.js";
import { CHATGPT_TOKEN_URL } from "../../packages/broker/src/chatgpt/oauth.js";
import { chatGptChecks, readChatGptHealth, type ChatGptHealthRead } from "../../packages/cli/src/doctor/chatgpt.js";
import type { DoctorContext } from "../../packages/cli/src/doctor/checks.js";
import { adminCall, createAdminBroker } from "../support/admin-broker.js";

const SEALER: ChatGptSealer = { seal: async (plaintext) => `sealed:${plaintext}`, open: async (sealed) => sealed.slice("sealed:".length) };

/** OpenAI as the control plane sees it: tokens and models for a connection; `down` hosts do not answer at all. */
function openAi(down: { auth?: boolean; api?: boolean } = {}) {
  return (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.startsWith("https://auth.openai.com")) {
      if (down.auth === true) throw new TypeError("fetch failed");
      if (url === CHATGPT_TOKEN_URL) return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "openid chatgpt.tokens.use.direct" });
      return new Response("<html>", { status: 200 });
    }
    if (url.startsWith("https://api.openai.com")) {
      if (down.api === true) throw new TypeError("fetch failed");
      return Response.json({ models: [{ slug: "gpt-6.1-sol" }] });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
}

async function controlPlane(options: { down?: { auth?: boolean; api?: boolean }; enabled?: boolean; chatgpt?: boolean } = {}) {
  const { db, handler } = await createAdminBroker(options.chatgpt === false ? {} : {
    chatgpt: (fake) => chatGptConnections({ documentClient: fake, tableName: "state", sealer: SEALER, fetch: openAi(options.down), now: () => Date.now(), hostId: "urn:uuid:00000000-0000-4000-8000-000000000000" }),
  });
  if (options.enabled !== false) db.set({ pk: "SETTINGS", sk: "CHATGPT", entityType: "SETTING", enabled: true, preferredModel: "gpt-5.5" });
  const connections = chatGptConnections({ documentClient: db, tableName: "state", sealer: SEALER, fetch: openAi(), now: () => Date.now(), hostId: "urn:uuid:00000000-0000-4000-8000-000000000000" });
  const connect = async (developerId: string) => {
    const state = new URL((await connections.start(developerId)).authorizeUrl).searchParams.get("state") ?? "";
    await connections.finish(developerId, { code: "c", state, clientId: "oaiapp_x" });
  };
  const health = () => adminCall(handler, { method: "GET", path: "/v1/admin/chatgpt" });
  return { db, handler, connections, connect, health };
}

describe("GET /v1/admin/chatgpt (#343)", () => {
  it("answers the settings, the people connected (not revoked), and that OpenAI is reachable, with no person named", async () => {
    const h = await controlPlane();
    for (const developerId of ["dev-1", "dev-2", "dev-3"]) await h.connect(developerId);
    await h.connections.markStatus("dev-2", "revoked");
    await h.connections.markStatus("dev-3", "limit-reached");
    await h.connections.disconnect("dev-1");
    await h.connect("dev-4");
    const answer = await h.health();
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ enabled: true, preferredModel: "gpt-5.5", connected: 2, connectedComplete: true, reachable: { auth: true, api: true } });
    expect(JSON.stringify(answer.body)).not.toMatch(/dev-\d|access-1|refresh-1/);
  });

  it("says when the control plane cannot reach OpenAI", async () => {
    const h = await controlPlane({ down: { api: true } });
    expect((await h.health()).body).toMatchObject({ reachable: { auth: true, api: false } });
  });

  it("is for administrators only, and says when the deployment has no Sign in with ChatGPT", async () => {
    const h = await controlPlane();
    expect(await adminCall(h.handler, { method: "GET", path: "/v1/admin/chatgpt", admin: false })).toMatchObject({ status: 403 });
    const none = await controlPlane({ chatgpt: false });
    expect(await none.health()).toMatchObject({ status: 404, body: { error: { message: "Sign in with ChatGPT is not set up in this deployment" } } });
  });
});

const health = (overrides: Partial<ChatGptHealth> = {}): ChatGptHealthRead => ({
  kind: "health", health: { enabled: true, preferredModel: "gpt-6.1-sol", connected: 3, connectedComplete: true, reachable: { auth: true, api: true }, ...overrides },
});
const context = (read: (() => Promise<ChatGptHealthRead>) | undefined) => ({ env: "staging", services: { ...(read === undefined ? {} : { chatgpt: read }) } }) as unknown as DoctorContext;
const lines = async (read: ChatGptHealthRead) => (await chatGptChecks(context(async () => read))).map(({ name, status, detail, fix }) => ({ name, status, detail, ...(fix === undefined ? {} : { fix }) }));

describe("rovara doctor's Sign in with ChatGPT checks (#343)", () => {
  it("shows the switch, the connections and OpenAI's reachability", async () => {
    expect(await lines(health())).toEqual([
      { name: "Sign in with ChatGPT", status: "ok", detail: "on; tasks prefer gpt-6.1-sol where a person's plan allows it" },
      { name: "connections", status: "ok", detail: "3 people have connected a ChatGPT plan" },
      { name: "reach auth.openai.com", status: "ok", detail: "the control plane reaches it" },
      { name: "reach api.openai.com", status: "ok", detail: "the control plane reaches it" },
    ]);
    expect((await lines(health({ connected: 1 })))[1]?.detail).toBe("1 person has connected a ChatGPT plan");
    expect((await lines(health({ connected: 500, connectedComplete: false })))[1]?.detail).toBe("500 or more people have connected a ChatGPT plan");
  });

  it("fails an unreachable host while the switch is on, and only warns while it is off", async () => {
    const on = await lines(health({ reachable: { auth: false, api: true } }));
    expect(on[2]).toMatchObject({ status: "fail", detail: "the control plane could not reach auth.openai.com over HTTPS", fix: expect.stringContaining("outbound internet access") as unknown });
    const off = await lines(health({ enabled: false, reachable: { auth: true, api: false } }));
    expect(off[0]).toMatchObject({ status: "ok", detail: "off; turn it on with npx @preplabsai/rovara-code --env staging config set models.chatgpt.enabled true" });
    expect(off[3]).toMatchObject({ status: "warn" });
  });

  it("skips, saying how to sign in, without an admin sign-in, and skips where the deployment has none", async () => {
    expect(await lines({ kind: "signed-out" })).toEqual([{ name: "Sign in with ChatGPT", status: "skip", detail: "not checked: this computer has no working admin sign-in for staging", fix: "run npx @preplabsai/rovara-code --env staging login --admin, then run agentx doctor again" }]);
    expect(await lines({ kind: "not-set-up" })).toEqual([{ name: "Sign in with ChatGPT", status: "skip", detail: "not set up in this deployment" }]);
    expect((await chatGptChecks(context(undefined)))[0]).toMatchObject({ status: "skip" });
  });

  it("reads the control plane's answer with the admin sign-in", async () => {
    const session = { controlPlaneUrl: "https://abc123.execute-api.us-east-1.amazonaws.com/", accessToken: "admin-token" };
    const answering = (response: Response) => vi.fn<typeof fetch>(async () => response);
    const ok = answering(Response.json(health().kind === "health" ? (health() as { health: ChatGptHealth }).health : {}));
    expect(await readChatGptHealth(ok, session)).toMatchObject({ kind: "health", health: { connected: 3 } });
    expect(ok).toHaveBeenCalledWith("https://abc123.execute-api.us-east-1.amazonaws.com/v1/admin/chatgpt", expect.objectContaining({ headers: { authorization: "Bearer admin-token" } }));
    expect(await readChatGptHealth(answering(new Response("{}", { status: 404 })), session)).toEqual({ kind: "not-set-up" });
    expect(await readChatGptHealth(answering(new Response("{}", { status: 403 })), session)).toEqual({ kind: "signed-out" });
    expect(await readChatGptHealth(vi.fn<typeof fetch>(), undefined)).toEqual({ kind: "signed-out" });
    await expect(readChatGptHealth(answering(Response.json({ odd: true })), session)).rejects.toThrow("the control plane answered with something unexpected");
  });
});
