// Sign in with ChatGPT from the CLI (#339): `chatgpt connect` catches OpenAI's callback on this
// computer (or takes a pasted address) and hands it to the control plane, which does the exchange.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHATGPT_CALLBACK_URL } from "@agentx/contracts";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const URL_ = "https://abc123.execute-api.us-east-1.amazonaws.com";
const ISSUER = `${URL_}/v1/auth`;
const entry = { url: URL_, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` };
const STATE = "state-from-the-control-plane";
const AUTHORIZE = `https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&state=${STATE}&redirect_uri=${encodeURIComponent(CHATGPT_CALLBACK_URL)}`;
const CONNECTED = { connected: true, status: "connected", email: "maya@acme.com", connectedAt: "2026-10-11T12:00:00.000Z", models: ["gpt-6.1-sol", "gpt-5.5"] };

const urlOf = (input: string | URL | Request) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

/** A port nothing listens on, for the callback (the real one, 1455, may be busy on this computer). */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  return port;
}

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => { resolve(); }))));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function signedIn(options: {
  /** What the browser does with OpenAI's page: the query it comes back to the callback with, in order. */
  browser?: (port: number) => Array<Record<string, string>>;
  paste?: string;
  interactive?: boolean;
  finish?: () => Response;
  view?: () => Response;
} = {}) {
  const home = await mkdtemp(join(tmpdir(), "rovara-chatgpt-cli-"));
  dirs.push(home);
  await saveDeveloperEnvironment(home, "staging", entry);
  const tokenStore = new InMemoryTokenStore();
  await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "access", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
  const port = await freePort();
  const out: string[] = [];
  const err: string[] = [];
  const finished: unknown[] = [];
  const answers: number[] = [];
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    const url = urlOf(input);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access");
    const method = init?.method ?? "GET";
    if (url === `${URL_}/v1/dev/chatgpt/connection` && method === "POST") {
      return Response.json({ authorizeUrl: AUTHORIZE, expiresAt: new Date(Date.now() + 600_000).toISOString(), requestId: "r" });
    }
    if (url === `${URL_}/v1/dev/chatgpt/connection/finish` && method === "POST") {
      finished.push(JSON.parse(typeof init?.body === "string" ? init.body : "null"));
      return options.finish?.() ?? Response.json({ ...CONNECTED, requestId: "r" });
    }
    if (url === `${URL_}/v1/dev/chatgpt/connection` && method === "GET") return options.view?.() ?? Response.json({ ...CONNECTED, requestId: "r" });
    if (url === `${URL_}/v1/dev/chatgpt/connection` && method === "DELETE") return Response.json({ connected: false, requestId: "r" });
    throw new Error(`unexpected ${method} ${url}`);
  });
  // The browser: OpenAI's page sends it back to the callback, as the person's choices make it.
  const openBrowser = vi.fn(async (url: string) => {
    expect(url).toBe(AUTHORIZE);
    for (const query of options.browser?.(port) ?? []) {
      const response = await fetch(`http://127.0.0.1:${port}/auth/callback?${new URLSearchParams(query).toString()}`);
      answers.push(response.status);
    }
  });
  const run = (argv: string[]) => executeCli(argv, {
    fetchImplementation, tokenStore, environments: { home },
    stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) },
    stdin: Readable.from(options.paste === undefined ? [] : [`${options.paste}\n`]),
    chatgpt: { port, openBrowser, isInteractive: () => options.interactive ?? false },
  });
  return { home, port, out, err, finished, answers, run, fetchImplementation, openBrowser };
}

/** Every file under the home, so a test can check nothing token-bearing was written there. */
async function filesUnder(dir: string): Promise<string> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const texts = await Promise.all(entries.filter((file) => file.isFile()).map((file) => readFile(join(file.parentPath, file.name), "utf8")));
  return texts.join("\n");
}

describe("rovara chatgpt connect (#339)", () => {
  it("catches OpenAI's callback on this computer and hands code, state and client ID to the control plane", async () => {
    const h = await signedIn({ browser: () => [{ code: "the-code", scope: "x", state: STATE, client_id: "oaiapp_issued" }] });
    expect(await h.run(["chatgpt", "connect"])).toBe(0);
    expect(h.finished).toEqual([{ code: "the-code", state: STATE, clientId: "oaiapp_issued" }]);
    expect(h.answers).toEqual([200]);
    expect(h.out.join("")).toBe([
      "Connected your ChatGPT plan (maya@acme.com) to AgentX environment staging.",
      "Models your plan offers: gpt-6.1-sol, gpt-5.5.",
      "",
    ].join("\n"));
    // The CLI never exchanges the code itself: only the control plane was called.
    expect(h.fetchImplementation.mock.calls.every(([input]) => urlOf(input).startsWith(`${URL_}/v1/dev/chatgpt/`))).toBe(true);
    // Nothing token-bearing on this computer, and the code is not printed.
    expect(await filesUnder(h.home)).not.toMatch(/the-code|oaiapp_issued/);
    expect(h.err.join("")).not.toContain("the-code");
  });

  it("refuses a callback with another state and keeps waiting for this sign-in's own", async () => {
    const h = await signedIn({
      browser: () => [
        { code: "planted", state: "another-state", client_id: "oaiapp_planted" },
        { error: "access_denied", state: "another-state" },
        { code: "the-code", state: STATE, client_id: "oaiapp_issued" },
      ],
    });
    expect(await h.run(["chatgpt", "connect"])).toBe(0);
    expect(h.answers).toEqual([400, 400, 200]);
    expect(h.finished).toEqual([{ code: "the-code", state: STATE, clientId: "oaiapp_issued" }]);
  });

  it("says the sign-in was declined, and finishes nothing, when the person presses Cancel on OpenAI's page", async () => {
    const h = await signedIn({ browser: () => [{ error: "access_denied", error_description: "user said no <script>", state: STATE }] });
    expect(await h.run(["chatgpt", "connect"])).not.toBe(0);
    expect(h.err.join("")).toContain("ChatGPT was not connected: the sign-in was declined on OpenAI's page");
    expect(h.err.join("")).not.toContain("script");
    expect(h.finished).toEqual([]);
  });

  it("falls back to a pasted address when the callback's port is taken (the Codex CLI may hold it)", async () => {
    const pasted = `${CHATGPT_CALLBACK_URL}?code=the-code&state=${STATE}&client_id=oaiapp_issued`;
    const h = await signedIn({ paste: pasted, interactive: true });
    const busy = createServer();
    servers.push(busy);
    await new Promise<void>((resolve) => busy.listen(h.port, "127.0.0.1", resolve));
    expect(await h.run(["chatgpt", "connect", "--no-browser"])).toBe(0);
    expect(h.openBrowser).not.toHaveBeenCalled();
    expect(h.err.join("")).toContain(`Open this link in a browser to connect ChatGPT: ${AUTHORIZE}`);
    expect(h.err.join("")).toContain("is in use, so after you press Allow the browser will show an error page");
    expect(h.finished).toEqual([{ callbackUrl: pasted }]);
    expect(h.out.join("")).toContain("Connected your ChatGPT plan (maya@acme.com)");
  });

  it("says the port is in use when it is taken and nobody is there to paste", async () => {
    const h = await signedIn();
    const busy = createServer();
    servers.push(busy);
    await new Promise<void>((resolve) => busy.listen(h.port, "127.0.0.1", resolve));
    expect(await h.run(["chatgpt", "connect"])).not.toBe(0);
    expect(h.err.join("")).toContain("is in use (the Codex CLI may be signing in); close it and run npx @preplabsai/rovara-code chatgpt connect again");
    expect(h.openBrowser).not.toHaveBeenCalled();
  });

  it("shows the control plane's reason when it refuses the finish, such as a plan Rovara cannot use", async () => {
    const h = await signedIn({
      browser: () => [{ code: "the-code", state: STATE, client_id: "oaiapp_issued" }],
      finish: () => Response.json({ error: { code: "FORBIDDEN", message: "this ChatGPT account cannot be used by Rovara; Sign in with ChatGPT needs a ChatGPT Plus or Pro plan" } }, { status: 403 }),
    });
    expect(await h.run(["chatgpt", "connect"])).not.toBe(0);
    expect(h.err.join("")).toContain("this ChatGPT account cannot be used by Rovara; Sign in with ChatGPT needs a ChatGPT Plus or Pro plan");
  });
});

describe("rovara chatgpt status and disconnect (#339)", () => {
  it("status shows the connection, and says how to connect when there is none", async () => {
    const h = await signedIn();
    expect(await h.run(["chatgpt", "status"])).toBe(0);
    expect(h.out.join("")).toBe([
      "Your ChatGPT plan (maya@acme.com) is connected to AgentX environment staging since 2026-10-11T12:00:00.000Z.",
      "Models your plan offers: gpt-6.1-sol, gpt-5.5.",
      "",
    ].join("\n"));
    const none = await signedIn({ view: () => Response.json({ connected: false }) });
    expect(await none.run(["chatgpt", "status"])).toBe(0);
    expect(none.out.join("")).toBe("ChatGPT is not connected to AgentX environment staging. Connect it with npx @preplabsai/rovara-code chatgpt connect.\n");
  });

  it("status says a revoked connection needs connecting again", async () => {
    const h = await signedIn({ view: () => Response.json({ ...CONNECTED, status: "revoked" }) });
    expect(await h.run(["chatgpt", "status"])).toBe(0);
    expect(h.out.join("")).toContain("The connection no longer works (it was revoked at OpenAI, or expired); connect again with npx @preplabsai/rovara-code chatgpt connect.");
  });

  it("status --json prints the connection", async () => {
    const h = await signedIn();
    expect(await h.run(["--json", "chatgpt", "status"])).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual({ ok: true, data: { env: "staging", url: URL_, ...CONNECTED, requestId: "r" } });
  });

  it("says when the deployment has no Sign in with ChatGPT", async () => {
    const h = await signedIn({ view: () => Response.json({ error: { code: "NOT_FOUND", message: "Sign in with ChatGPT is not set up in this deployment" } }, { status: 404 }) });
    expect(await h.run(["chatgpt", "status"])).not.toBe(0);
    expect(h.err.join("")).toContain("Sign in with ChatGPT is not set up in this deployment");
  });

  it("disconnect removes the connection", async () => {
    const h = await signedIn();
    expect(await h.run(["chatgpt", "disconnect"])).toBe(0);
    expect(h.out.join("")).toBe("Disconnected ChatGPT from AgentX environment staging. You can also remove Rovara from your ChatGPT account's connected apps.\n");
    expect(h.fetchImplementation.mock.calls.map(([input, init]) => `${init?.method ?? "GET"} ${urlOf(input)}`)).toEqual([`DELETE ${URL_}/v1/dev/chatgpt/connection`]);
  });
});
