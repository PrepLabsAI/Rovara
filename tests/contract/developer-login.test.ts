import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { developerTokenKey, readDeveloperConfig } from "../../packages/cli/src/developer/config.js";
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
  it("reads the configuration, runs PKCE with a loopback on any port, stores the tokens and the environment", async () => {
    const dir = await home();
    const store = new InMemoryTokenStore();
    const fetchImpl = server();
    let authorize: URL | undefined;
    const result = await developerLogin({
      url: `${URL_}/`, allowLoopback: false, browser: true, home: dir, tokenStore: store, fetch: fetchImpl, write: () => undefined,
      openBrowser: async (link) => { authorize = new URL(link); await browser({ code: "agxc_code" })(link); },
    });
    expect(result.env).toBe("staging");
    expect(Object.fromEntries(authorize?.searchParams ?? [])).toMatchObject({ response_type: "code", client_id: "agentx-cli", code_challenge_method: "S256" });
    expect(authorize?.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*\/callback$/);
    const tokenCall = fetchImpl.mock.calls.find(([input]) => urlOf(input).endsWith("/token"));
    const tokenForm = formOf(tokenCall?.[1]);
    expect(tokenForm.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(tokenForm.get("redirect_uri")).toBe(authorize?.searchParams.get("redirect_uri"));
    expect(tokenForm.get("code")).toBe("agxc_code");
    expect(await store.get(developerTokenKey(ISSUER))).toMatchObject({ accessToken: "access.jwt.value", refreshToken: REFRESH });
    expect(await readDeveloperConfig(dir)).toEqual({ default: "staging", environments: { staging: { url: URL_, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` } } });
    expect((await stat(join(dir, ".agentx", "developer.yaml"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, ".agentx", "developer.yaml"), "utf8")).not.toContain(REFRESH);
  });

  it("closes the loopback listener once the sign-in finishes", async () => {
    let redirect = "";
    await developerLogin({
      url: URL_, allowLoopback: false, browser: true, home: await home(), tokenStore: new InMemoryTokenStore(), fetch: server(), write: () => undefined,
      openBrowser: async (link) => { redirect = new URL(link).searchParams.get("redirect_uri") ?? ""; await browser({ code: "agxc_code" })(link); },
    });
    await expect(fetch(redirect)).rejects.toThrow();
  });

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

  it("does not take an error callback with the wrong state as the server's answer", async () => {
    const result = developerLogin({
      url: URL_, allowLoopback: false, browser: true, home: await home(), tokenStore: new InMemoryTokenStore(), fetch: server(), write: () => undefined, timeoutMs: 60_000,
      openBrowser: async (link) => {
        const forged = new URL(new URL(link).searchParams.get("redirect_uri") ?? "");
        forged.searchParams.set("state", "not-the-state");
        forged.searchParams.set("error", "access_denied");
        forged.searchParams.set("error_description", "forged reason");
        await fetch(forged);
      },
    });
    await expect(result).rejects.toThrow("AUTH_REQUIRED: OIDC callback state or code is invalid");
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
    ["a newer major API version", configuration({ apiVersion: "2.0" }), /upgrade: npx @charterarc\/agentx@latest login/],
    ["no enabled method", configuration({ methods: { slack: false, oidc: null } }), /no developer sign-in method is enabled.*agentx signin enable/],
  ])("refuses %s before opening a browser (R20)", async (_name, config, message) => {
    const openBrowser = vi.fn<(url: string) => Promise<void>>();
    await expect(developerLogin({ url: URL_, allowLoopback: false, browser: true, home: await home(), tokenStore: new InMemoryTokenStore(), fetch: server({ configuration: config }), write: () => undefined, openBrowser })).rejects.toThrow(message);
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("refuses a plain http URL outside --allow-loopback", async () => {
    await expect(developerLogin({ url: "http://abc123.example.test", allowLoopback: false, browser: true, home: await home(), tokenStore: new InMemoryTokenStore(), fetch: server(), write: () => undefined })).rejects.toThrow(/must use https/);
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

  it("never prints or stores the refresh token outside the token store", async () => {
    const lines: string[] = [];
    const dir = await home();
    await developerLogin({ url: URL_, allowLoopback: false, browser: true, home: dir, tokenStore: new InMemoryTokenStore(), fetch: server(), write: (line) => lines.push(line), openBrowser: browser({ code: "agxc_code" }) });
    expect(lines.join("\n")).not.toContain(REFRESH);
    expect(lines.join("\n")).not.toContain("access.jwt.value");
    expect(lines.join("\n")).not.toContain("agxc_code");
  });
});
