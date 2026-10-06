import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { developerTokenKey, readDeveloperConfig, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
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
const formOf = (init: RequestInit | undefined) => new URLSearchParams(typeof init?.body === "string" ? init.body : "");

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
  const run = (argv: string[]) => executeCli(argv, { fetchImplementation, tokenStore, environments: { home }, stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } });
  return { home, tokenStore, out, err, run, fetchImplementation };
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

  it("whoami without a sign-in says how to sign in", async () => {
    const h = await signedIn();
    expect(await h.run(["--env", "other", "whoami"])).toBe(3);
    expect(h.err.join("")).toContain("this computer is not signed in to AgentX environment other; run npx @preplabsai/rovara-code login <your AgentX URL>");
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

  it("logout revokes the session at the server and removes the tokens and the environment", async () => {
    const h = await signedIn();
    expect(await h.run(["logout"])).toBe(0);
    const revoke = h.fetchImplementation.mock.calls.find(([input]) => urlOf(input) === `${ISSUER}/revoke`);
    expect(revoke?.[1]?.method).toBe("POST");
    expect(Object.fromEntries(formOf(revoke?.[1]))).toEqual({ token: REFRESH, client_id: "agentx-cli" });
    expect(await h.tokenStore.get(developerTokenKey(ISSUER))).toBeUndefined();
    expect(await readDeveloperConfig(h.home)).toEqual({ environments: {} });
    expect(h.out.join("")).toBe("Signed out of AgentX environment staging.\n");
    expect(h.out.join("") + h.err.join("")).not.toContain(REFRESH);
  });

  it("logout of the default environment moves the default to a remaining one (#221)", async () => {
    const h = await signedIn();
    const other = { url: "https://other.example.test", issuer: "https://other.example.test/v1/auth", tokenEndpoint: "https://other.example.test/v1/auth/token", revocationEndpoint: "https://other.example.test/v1/auth/revoke" };
    await saveDeveloperEnvironment(h.home, "other", other);
    await saveDeveloperEnvironment(h.home, "staging", entry);
    expect(await h.run(["logout"])).toBe(0);
    expect(await readDeveloperConfig(h.home)).toEqual({ default: "other", environments: { other } });
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
    expect(h.err.join("")).toContain("this computer is not signed in to AgentX environment other; run npx @preplabsai/rovara-code login <your AgentX URL>; for the admin login, run agentx logout --admin");
  });

  it("logout --json reports whether the server revoked the session", async () => {
    const h = await signedIn({ revoke: () => Promise.resolve(Response.json({}, { status: 500 })) });
    expect(await h.run(["--json", "logout"])).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual({ ok: true, data: { env: "staging", revoked: false, problem: "not_confirmed" } });
  });

  it("logout --json names an unreachable server", async () => {
    const h = await signedIn({ revoke: () => Promise.reject(new TypeError("fetch failed")) });
    expect(await h.run(["--json", "logout"])).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual({ ok: true, data: { env: "staging", revoked: false, problem: "unreachable" } });
  });

  it("whoami strips terminal escapes from the developer's name (fix 3)", async () => {
    const h = await signedIn({ name: "Maya\u001b[2J Chen" });
    expect(await h.run(["whoami"])).toBe(0);
    expect(h.out.join("")).toContain("as Maya[2J Chen, with Slack");
  });

  it("login refuses a URL together with --admin", async () => {
    const h = await signedIn();
    expect(await h.run(["login", URL_, "--admin"])).toBe(2);
    expect(h.err.join("")).toContain("use either agentx login <url> (developer sign-in) or agentx login --admin, not both");
  });
});
