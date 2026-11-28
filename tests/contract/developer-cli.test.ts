import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { developerConfigPath, developerTokenKey, readDeveloperConfig, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const URL_ = "https://abc123.execute-api.us-east-1.amazonaws.com";
const ISSUER = `${URL_}/v1/auth`;
const REFRESH = `agxr_${"a".repeat(43)}`;
const entry = { url: URL_, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` };
const projects = {
  developer: { id: "a".repeat(64), name: "Maya Chen", provider: "slack", slackUserId: "U0MAYA001" },
  projects: [
    { name: "payments-api", latestRevision: 7, access: "channel", channels: [{ channelId: "C0PAY0001" }] },
    { name: "solo", latestRevision: 1, access: "granted", channels: [] },
  ],
  notices: [],
};

const urlOf = (input: string | URL | Request) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function signedIn(options: { revoke?: () => Promise<Response>; name?: string; projects?: () => Response } = {}) {
  const home = await mkdtemp(join(tmpdir(), "agentx-dev-cli-"));
  dirs.push(home);
  await saveDeveloperEnvironment(home, "staging", entry);
  const tokenStore = new InMemoryTokenStore();
  await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "access", refreshToken: REFRESH, expiresAt: Date.now() + 3_600_000 });
  const out: string[] = [];
  const err: string[] = [];
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    const url = urlOf(input);
    if (url === `${URL_}/v1/dev/projects`) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access");
      if (options.projects !== undefined) return options.projects();
      return Response.json(options.name === undefined ? projects : { ...projects, developer: { ...projects.developer, name: options.name } });
    }
    if (url === `${ISSUER}/revoke`) return options.revoke?.() ?? Response.json({});
    throw new Error(`unexpected ${url}`);
  });
  const runAsTyped = (argv: string[]) => executeCli(argv, { fetchImplementation, tokenStore, environments: { home }, stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } });
  // Issue #1611: the sign-in is to staging and the default stays production, so name staging unless the test names one.
  const run = (argv: string[]) => runAsTyped(argv.includes("--env") ? argv : ["--env", "staging", ...argv]);
  return { home, tokenStore, out, err, run, runAsTyped, fetchImplementation };
}

describe("agentx whoami and logout (FR-011)", () => {
  it("whoami shows the name, method, Slack link and projects with how each is allowed (US4 scenario 1)", async () => {
    const h = await signedIn();
    expect(await h.run(["whoami"])).toBe(0);
    expect(h.out.join("")).toBe([
      `Signed in to AgentX environment staging (${URL_}) as Maya Chen, with Slack (U0MAYA001).`,
      "Projects you can use:",
      "  payments-api  (you are in its Slack channel C0PAY0001)",
      "  solo  (an admin granted you access)",
      "",
    ].join("\n"));
  });

  it("whoami --json prints the projects response", async () => {
    const h = await signedIn();
    expect(await h.run(["--json", "whoami"])).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual({ ok: true, data: { env: "staging", url: URL_, ...projects } });
  });

  it("whoami gives the server's reason when AgentX refuses the sign-in, made safe, with the login hint", async () => {
    const refused = (message: unknown) => () => Response.json({ error: { code: "AUTH_REQUIRED", message } }, { status: 401 });
    const h = await signedIn({ projects: refused("your sign-in ended when Slack was turned off\u001b[2J; sign in again with agentx login <url>") });
    expect(await h.run(["whoami"])).toBe(3);
    expect(h.err.join("")).toContain(`your AgentX sign-in for staging has ended (your sign-in ended when Slack was turned off[2J); run npx @preplabsai/rovara-code login ${URL_}`);
    // No reason, or one that is not text: the generic line, still with the hint.
    const bare = await signedIn({ projects: () => new Response("", { status: 401 }) });
    expect(await bare.run(["whoami"])).toBe(3);
    expect(bare.err.join("")).toContain(`your AgentX sign-in for staging has ended; run npx @preplabsai/rovara-code login ${URL_}`);
    const odd = await signedIn({ projects: refused(7) });
    expect(await odd.run(["whoami"])).toBe(3);
    expect(odd.err.join("")).toContain(`your AgentX sign-in for staging has ended; run npx @preplabsai/rovara-code login ${URL_}`);
  });

  it("logout removes only that environment's sign-in, and names no default (#221, #1611)", async () => {
    const h = await signedIn();
    const other = { url: "https://other.example.test", issuer: "https://other.example.test/v1/auth", tokenEndpoint: "https://other.example.test/v1/auth/token", revocationEndpoint: "https://other.example.test/v1/auth/revoke" };
    await saveDeveloperEnvironment(h.home, "other", other);
    await saveDeveloperEnvironment(h.home, "staging", entry);
    expect(await h.run(["logout"])).toBe(0);
    expect(await readDeveloperConfig(h.home)).toEqual({ environments: { other } });
  });

  it("without --env, whoami uses production, not the environment signed in to last, and says how to reach that one (#1611)", async () => {
    const h = await signedIn();
    expect(await h.runAsTyped(["whoami"])).toBe(3);
    expect(h.err.join("")).toContain("this computer is not signed in to AgentX environment production; it is signed in to staging: add --env staging, or run npx @preplabsai/rovara-code login <your AgentX URL>");
    expect(h.fetchImplementation).not.toHaveBeenCalled();
  });

  it("without --env, whoami uses production even when another environment was signed in to after it (#1611)", async () => {
    const h = await signedIn();
    const production = { url: "https://prod.example.test", issuer: "https://prod.example.test/v1/auth", tokenEndpoint: "https://prod.example.test/v1/auth/token", revocationEndpoint: "https://prod.example.test/v1/auth/revoke" };
    await saveDeveloperEnvironment(h.home, "production", production);
    await saveDeveloperEnvironment(h.home, "staging", entry);
    await h.tokenStore.set(developerTokenKey(production.issuer), { accessToken: "prod-access", refreshToken: REFRESH, expiresAt: Date.now() + 3_600_000 });
    h.fetchImplementation.mockImplementation(async (input) => {
      expect(urlOf(input)).toBe("https://prod.example.test/v1/dev/projects");
      return Response.json(projects);
    });
    expect(await h.runAsTyped(["whoami"])).toBe(0);
    expect(h.out.join("")).toContain("Signed in to AgentX environment production (https://prod.example.test)");
  });

  it("reads a developer.yaml an older CLI wrote with a default, and ignores that default (#1611)", async () => {
    const h = await signedIn();
    await writeFile(developerConfigPath(h.home), YAML.stringify({ schemaVersion: 1, default: "staging", environments: { staging: entry } }));
    expect(await readDeveloperConfig(h.home)).toEqual({ environments: { staging: entry } });
    expect(await h.runAsTyped(["whoami"])).toBe(3);
    expect(h.err.join("")).toContain("not signed in to AgentX environment production; it is signed in to staging");
  });

  it("logout still removes the local tokens when the server cannot be reached, and says the server session may stay", async () => {
    const h = await signedIn({ revoke: () => Promise.reject(new TypeError("fetch failed")) });
    expect(await h.run(["logout"])).toBe(0);
    expect(await h.tokenStore.get(developerTokenKey(ISSUER))).toBeUndefined();
    expect(await readDeveloperConfig(h.home)).toEqual({ environments: {} });
    expect(h.out.join("")).toContain("Signed out of AgentX environment staging on this computer");
    expect(h.out.join("")).toContain("the server session may stay until it expires");
  });

  it("logout says the server did not confirm when revoke answers an error, with its reason (fix 5)", async () => {
    const h = await signedIn({ revoke: () => Promise.resolve(Response.json({ error: "temporarily_unavailable", error_description: "AgentX could not finish this just now\u001b[2J" }, { status: 503 })) });
    expect(await h.run(["logout"])).toBe(0);
    expect(await h.tokenStore.get(developerTokenKey(ISSUER))).toBeUndefined();
    expect(h.out.join("")).toBe("Signed out of AgentX environment staging on this computer. AgentX did not confirm it ended the sign-in there (AgentX could not finish this just now[2J), so the server session may stay until it expires.\n");
  });

  it("logout without a developer sign-in names the admin logout too", async () => {
    const h = await signedIn();
    expect(await h.run(["--env", "other", "logout"])).toBe(3);
    expect(h.err.join("")).toContain("this computer is not signed in to AgentX environment other; it is signed in to staging: add --env staging, or run npx @preplabsai/rovara-code login <your AgentX URL>; for the admin login, run agentx logout --admin");
  });

  it("logout --json reports whether the server revoked the session", async () => {
    const h = await signedIn({ revoke: () => Promise.resolve(Response.json({}, { status: 500 })) });
    expect(await h.run(["--json", "logout"])).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual({ ok: true, data: { env: "staging", revoked: false, problem: "not_confirmed" } });
  });

  it("login refuses a URL together with --admin", async () => {
    const h = await signedIn();
    expect(await h.run(["login", URL_, "--admin"])).toBe(2);
    expect(h.err.join("")).toContain("use either agentx login <url> (developer sign-in) or agentx login --admin, not both");
  });
});

describe("agentx login <url> and the default environment (#1611)", () => {
  async function login(env: string) {
    const home = await mkdtemp(join(tmpdir(), "agentx-dev-cli-login-"));
    dirs.push(home);
    const out: string[] = [];
    const err: string[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = urlOf(input);
      if (url === `${ISSUER}/.well-known/agentx-configuration`) {
        return Response.json({ env, apiVersion: "1.0", issuer: ISSUER, authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke`, clientId: "agentx-cli", methods: { slack: true, oidc: null } });
      }
      if (url === `${ISSUER}/token`) return Response.json({ access_token: "access", token_type: "Bearer", expires_in: 3600, refresh_token: REFRESH });
      if (url === `${URL_}/v1/dev/projects`) return Response.json(projects);
      throw new Error(`unexpected ${url}`);
    });
    const run = executeCli(["login", URL_, "--no-browser"], { fetchImplementation, tokenStore: new InMemoryTokenStore(), environments: { home }, stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } });
    // The browser: follow the printed link back to the loopback with a code.
    await vi.waitFor(() => { expect(err.join("")).toContain(`${ISSUER}/authorize?`); });
    const authorize = new URL(/https:\/\/\S+authorize\?\S+/.exec(err.join(""))?.[0] ?? "");
    const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    callback.searchParams.set("code", "agxc_code");
    await fetch(callback);
    expect(await run).toBe(0);
    return { home, out: out.join(""), err: err.join("") };
  }

  it("signing in to another environment keeps production the default, and says how to use the other one", async () => {
    const h = await login("staging");
    expect(h.out).toContain("Signed in to AgentX environment staging");
    expect(h.err).toContain("Commands without --env still use production; add --env staging to use staging.\n");
    expect(await readFile(developerConfigPath(h.home), "utf8")).not.toMatch(/^default:/m);
  });

  it("signing in to production says nothing about the default", async () => {
    const h = await login("production");
    expect(h.out).toContain("Signed in to AgentX environment production");
    expect(h.err).not.toContain("Commands without --env");
  });
});
