import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { developerTokenKey, readDeveloperConfig } from "../../packages/cli/src/developer/config.js";
import { createCallbackListener } from "../../packages/cli/src/auth.js";
import { whoamiText } from "../../packages/cli/src/developer/commands.js";
import { developerLogin } from "../../packages/cli/src/developer/login.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const URL_ = "https://abc123.execute-api.us-east-1.amazonaws.com";
const ISSUER = `${URL_}/v1/auth`;
const REFRESH = `agxr_${"r".repeat(43)}`;
const configuration = (overrides: Record<string, unknown> = {}) => ({
  env: "staging", apiVersion: "1.0", issuer: ISSUER, authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: `${ISSUER}/token`,
  revocationEndpoint: `${ISSUER}/revoke`, clientId: "agentx-cli", methods: { slack: true, oidc: null }, ...overrides,
});

const urlOf = (input: string | URL | Request) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
const formOf = (init: RequestInit | undefined) => new URLSearchParams(typeof init?.body === "string" ? init.body : "");

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const home = async () => { const dir = await mkdtemp(join(tmpdir(), "agentx-dev-login-")); dirs.push(dir); return dir; };

function server(options: { configuration?: Record<string, unknown>; token?: (body: URLSearchParams) => Response } = {}) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = urlOf(input);
    if (url === `${URL_}/v1/auth/.well-known/agentx-configuration`) return Response.json(options.configuration ?? configuration());
    if (url === `${ISSUER}/token`) {
      const body = formOf(init);
      return options.token?.(body) ?? Response.json({ access_token: "access.jwt.value", token_type: "Bearer", expires_in: 3600, refresh_token: REFRESH });
    }
    throw new Error(`unexpected ${url}`);
  });
}

/** The browser: follow the authorize URL to the loopback with a code, or with an error. */
const browser = (answer: Record<string, string>) => async (authorizationUrl: string) => {
  const authorize = new URL(authorizationUrl);
  const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
  callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
  for (const [key, value] of Object.entries(answer)) callback.searchParams.set(key, value);
  await fetch(callback);
};

describe("agentx login <url> (FR-011)", () => {

  it("stops at once with the server's reason when the sign-in is refused (Review Focus 1)", async () => {
    const dir = await home();
    const started = Date.now();
    let redirect = "";
    await expect(developerLogin({
      url: URL_, allowLoopback: false, browser: true, home: dir, tokenStore: new InMemoryTokenStore(), fetch: server(), write: () => undefined, timeoutMs: 60_000,
      openBrowser: async (link) => {
        redirect = new URL(link).searchParams.get("redirect_uri") ?? "";
        await browser({ error: "access_denied", error_description: "you signed in to Slack workspace T0OTHER1, but this AgentX serves T0TEAM1\u0007" })(link);
      },
    })).rejects.toThrow("AUTH_REQUIRED: sign-in refused: you signed in to Slack workspace T0OTHER1, but this AgentX serves T0TEAM1");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await readDeveloperConfig(dir)).toEqual({ environments: {} });
    await expect(fetch(redirect)).rejects.toThrow();
  });

  it("says a Slack outage is temporary", async () => {
    await expect(developerLogin({
      url: URL_, allowLoopback: false, browser: true, home: await home(), tokenStore: new InMemoryTokenStore(), fetch: server(), write: () => undefined,
      openBrowser: browser({ error: "temporarily_unavailable", error_description: "Slack could not be reached; run agentx login again in a minute" }),
    })).rejects.toThrow(/^RUNTIME_UNAVAILABLE: sign-in could not finish: Slack could not be reached/);
  });

  it("answers 400 to a callback with the wrong state and keeps waiting for the real one (fix 1)", async () => {
    const statuses: number[] = [];
    const result = await developerLogin({
      url: URL_, allowLoopback: false, browser: true, home: await home(), tokenStore: new InMemoryTokenStore(), fetch: server(), write: () => undefined, timeoutMs: 60_000,
      openBrowser: async (link) => {
        for (const answer of [{ error: "access_denied", error_description: "forged reason" }, { code: "agxc_forged" }]) {
          const forged = new URL(new URL(link).searchParams.get("redirect_uri") ?? "");
          forged.searchParams.set("state", "not-the-state");
          for (const [key, value] of Object.entries(answer)) forged.searchParams.set(key, value);
          statuses.push((await fetch(forged)).status);
        }
        await browser({ code: "agxc_code" })(link);
      },
    });
    expect(statuses).toEqual([400, 400]);
    expect(result.env).toBe("staging");
  });

  it("keeps the admin listener's messages", async () => {
    const listener = await createCallbackListener("state", 20, 0);
    await expect(listener.code).rejects.toThrow("AUTH_REQUIRED: OIDC login timed out");
    listener.close();
    const second = await createCallbackListener("state", 60_000, 0);
    const callback = new URL(second.redirectUri);
    callback.searchParams.set("state", "state");
    await fetch(callback);
    await expect(second.code).rejects.toThrow("AUTH_REQUIRED: OIDC callback state or code is invalid");
    second.close();
  });

  it("prints the link and waits on the loopback with --no-browser", async () => {
    const lines: string[] = [];
    const login = developerLogin({ url: URL_, allowLoopback: false, browser: false, home: await home(), tokenStore: new InMemoryTokenStore(), fetch: server(), write: (line) => lines.push(line) });
    await vi.waitFor(() => { expect(lines.some((line) => line.includes(`${ISSUER}/authorize?`))).toBe(true); });
    const link = /https:\/\/\S+/.exec(lines.find((line) => line.includes(`${ISSUER}/authorize?`)) ?? "")?.[0] ?? "";
    await browser({ code: "agxc_code" })(link);
    await expect(login).resolves.toMatchObject({ env: "staging" });
  });

  it.each([
    ["an endpoint on another origin", configuration({ tokenEndpoint: "https://evil.example.test/token" }), /must be on https:\/\/abc123/],
    ["a newer major API version", configuration({ apiVersion: "2.0" }), /upgrade: npx @preplabsai\/rovara-code@latest login/],
    ["no enabled method", configuration({ methods: { slack: false, oidc: null } }), /^CONFIG_INVALID: no developer sign-in method is on in this AgentX: Slack, GitHub and your company sign-in are all off; ask your Rovara admin to turn one on$/],
    ["every method listed but off, GitHub included", configuration({ methods: { slack: false, oidc: null, github: null } }), /no developer sign-in method is on in this AgentX/],
  ])("refuses %s before opening a browser (R20)", async (_name, config, message) => {
    const openBrowser = vi.fn<(url: string) => Promise<void>>();
    await expect(developerLogin({ url: URL_, allowLoopback: false, browser: true, home: await home(), tokenStore: new InMemoryTokenStore(), fetch: server({ configuration: config }), write: () => undefined, openBrowser })).rejects.toThrow(message);
    expect(openBrowser).not.toHaveBeenCalled();
  });

  // CLI-LOGIN-GITHUB: the CLI proceeds to the browser step when ANY usable method is on; the sign-in page (or the server, with one method) picks which.
  it.each([
    ["GitHub only (a GitHub-only install)", { slack: false, oidc: null, github: { displayName: "GitHub" } }],
    ["Slack only", { slack: true, oidc: null }],
    ["company sign-in (OIDC) only", { slack: false, oidc: { displayName: "Acme SSO" } }],
    ["Slack, company sign-in and GitHub all on", { slack: true, oidc: { displayName: "Acme SSO" }, github: { displayName: "GitHub" } }],
  ])("proceeds to the browser step and signs in when %s is on", async (_name, methods) => {
    const dir = await home();
    const links: string[] = [];
    const result = await developerLogin({
      url: URL_, allowLoopback: false, browser: true, home: dir, tokenStore: new InMemoryTokenStore(), fetch: server({ configuration: configuration({ methods }) }), write: () => undefined, timeoutMs: 60_000,
      openBrowser: async (link) => { links.push(link); await browser({ code: "agxc_code" })(link); },
    });
    expect(result.env).toBe("staging");
    expect(links).toHaveLength(1);
    const authorize = new URL(links[0] ?? "");
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${ISSUER}/authorize`);
    // The flow is unchanged and names no method: the server's method page (or its only method) decides.
    expect(authorize.searchParams.get("method")).toBeNull();
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(Object.keys((await readDeveloperConfig(dir)).environments)).toEqual(["staging"]);
  });

  it.each([["github", "GitHub"], ["slack", "Slack"], ["oidc", "your company sign-in"]])("whoami after a %s sign-in names the method as %s", (provider, words) => {
    const text = whoamiText({ env: "staging", url: URL_, projects: { developer: { id: "a".repeat(64), name: "Maya Chen", provider }, projects: [], notices: [] } });
    expect(text).toContain(`as Maya Chen, with ${words}.`);
  });

  it("keeps the 300 second wait for the browser sign-in", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      const lines: string[] = [];
      const login = developerLogin({ url: URL_, allowLoopback: false, browser: false, home: await home(), tokenStore: new InMemoryTokenStore(), fetch: server({ configuration: configuration({ methods: { slack: false, oidc: null, github: { displayName: "GitHub" } } }) }), write: (line) => lines.push(line) });
      await vi.waitFor(() => { expect(lines.some((line) => line.includes("/authorize?"))).toBe(true); });
      expect(spy.mock.calls.some(([, ms]) => ms === 300_000)).toBe(true);
      const link = /https:\/\/\S+/.exec(lines.find((line) => line.includes("/authorize?")) ?? "")?.[0] ?? "";
      await browser({ code: "agxc_code" })(link);
      await login;
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a plain http URL outside --allow-loopback", async () => {
    await expect(developerLogin({ url: "http://abc123.example.test", allowLoopback: false, browser: true, home: await home(), tokenStore: new InMemoryTokenStore(), fetch: server(), write: () => undefined })).rejects.toThrow(/must use https/);
  });

  it.each(["http://127.0.0.1:4010"])("allows %s with --allow-loopback (fix 7)", async (url) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({}, { status: 404 }));
    await expect(developerLogin({ url, allowLoopback: true, browser: true, home: await home(), tokenStore: new InMemoryTokenStore(), fetch: fetchImpl, write: () => undefined })).rejects.toThrow(/does not look like an AgentX environment/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });


  it("names the server's reason when the code exchange fails, and stores nothing", async () => {
    const dir = await home();
    const store = new InMemoryTokenStore();
    await expect(developerLogin({
      url: URL_, allowLoopback: false, browser: true, home: dir, tokenStore: store, write: () => undefined, openBrowser: browser({ code: "agxc_code" }),
      fetch: server({ token: () => Response.json({ error: "invalid_grant", error_description: "this sign-in link was already used; run agentx login again" }, { status: 400 }) }),
    })).rejects.toThrow("AUTH_REQUIRED: sign-in failed: this sign-in link was already used; run agentx login again");
    expect(await store.get(developerTokenKey(ISSUER))).toBeUndefined();
    expect(await readDeveloperConfig(dir)).toEqual({ environments: {} });
  });

});

