import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { GetSecretValueCommand, PutSecretValueCommand, TagResourceCommand } from "@aws-sdk/client-secrets-manager";
import { describe, expect, it, vi } from "vitest";
import { authorizeCredential, secretsManagerAuthorizeSecrets, type AuthorizeSecrets } from "../../packages/cli/src/admin/authorize.js";
import { tokenStoreKey } from "../../packages/cli/src/auth.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const SECRET = "agentx/connectors/asana-bot";
const CLIENT = { clientId: "1210000000000001", clientSecret: "client-secret-value-0123456789" };
const REFRESH = "refresh-token-from-sign-in";
const ACCESS = "access-token-from-sign-in";
const CODE = "authorization-code-value";
const CONTROL_PLANE = "https://agentx.example.test";

function secretsWith(value: string | undefined): AuthorizeSecrets & { writes: Array<[string, string]>; tags: string[] } {
  const store = {
    writes: [] as Array<[string, string]>,
    tags: [] as string[],
    read: vi.fn(async () => value),
    write: vi.fn(async (name: string, next: string) => { store.writes.push([name, next]); }),
    tag: vi.fn(async (name: string) => { store.tags.push(name); }),
  };
  return store;
}

/** The vendor's token endpoint and the control plane, behind one fetch. */
function vendorAndControlPlane(options: { tokenStatus?: number; tokenBody?: Record<string, unknown> } = {}) {
  const exchanges: Array<Record<string, string>> = [];
  const registrations: unknown[] = [];
  const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
    const href = url instanceof URL ? url.href : typeof url === "string" ? url : url.url;
    if (href === "https://app.asana.com/-/oauth_token") {
      expect(init).toMatchObject({ method: "POST", redirect: "error" });
      exchanges.push(Object.fromEntries(new URLSearchParams(init?.body as string)));
      return Response.json(options.tokenBody ?? { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, token_type: "bearer" }, { status: options.tokenStatus ?? 200 });
    }
    if (href === `${CONTROL_PLANE}/v1/admin/credentials`) {
      registrations.push(JSON.parse(init?.body as string));
      return Response.json({ credential: { ref: "asana-bot", type: "oauth-refresh-token", builtIn: false, tokenCached: false }, replaced: false }, { status: 201 });
    }
    throw new Error(`unexpected fetch ${href}`);
  });
  return { fetchImplementation, exchanges, registrations };
}

/** Plays the browser: reads the authorize URL, then calls the local listener with the given query. */
function browser(query: (authorize: URL) => Record<string, string>[]) {
  let port = 0;
  const seen: URL[] = [];
  const answers: number[] = [];
  return {
    seen, answers,
    onListening: (bound: number) => { port = bound; },
    openBrowser: async (url: string) => {
      const authorize = new URL(url);
      seen.push(authorize);
      for (const params of query(authorize)) {
        const response = await fetch(`http://127.0.0.1:${port}/callback?${new URLSearchParams(params).toString()}`);
        answers.push(response.status);
        await response.text();
      }
    },
  };
}

const base = (secrets: AuthorizeSecrets, fetchImplementation: typeof fetch, play: ReturnType<typeof browser>) => ({
  controlPlaneUrl: CONTROL_PLANE, accessToken: "admin-token", ref: "asana-bot", secretName: SECRET, provider: "asana",
  secrets, fetchImplementation, openBrowser: play.openBrowser, onListening: play.onListening, listenPort: 0, showUrl: () => undefined,
});

describe("agentx admin credential authorize", () => {
  it("signs in with PKCE S256 and a state, stores the refresh token beside the client, tags the secret and registers it", async () => {
    const secrets = secretsWith(JSON.stringify(CLIENT));
    const { fetchImplementation, exchanges, registrations } = vendorAndControlPlane();
    const play = browser((authorize) => [{ code: CODE, state: authorize.searchParams.get("state")! }]);
    const result = await authorizeCredential(base(secrets, fetchImplementation, play));

    const authorize = play.seen[0]!;
    expect(`${authorize.origin}${authorize.pathname}`).toBe("https://app.asana.com/-/oauth_authorize");
    expect(Object.fromEntries(authorize.searchParams)).toEqual({
      response_type: "code", client_id: CLIENT.clientId, redirect_uri: "http://localhost:8765/callback",
      state: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/) as unknown, code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
      code_challenge_method: "S256", resource: "https://mcp.asana.com/v2/mcp",
    });
    expect(exchanges).toHaveLength(1);
    const exchange = exchanges[0]!;
    expect(exchange).toMatchObject({ grant_type: "authorization_code", code: CODE, redirect_uri: "http://localhost:8765/callback", client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret });
    expect(createHash("sha256").update(exchange.code_verifier!).digest("base64url")).toBe(authorize.searchParams.get("code_challenge"));
    expect(secrets.writes).toEqual([[SECRET, JSON.stringify({ ...CLIENT, refreshToken: REFRESH })]]);
    expect(secrets.tags).toEqual([SECRET]);
    expect(registrations).toEqual([{ ref: "asana-bot", type: "oauth-refresh-token", secretName: SECRET }]);
    expect(JSON.stringify(result)).not.toMatch(new RegExp(`${REFRESH}|${ACCESS}|${CODE}|${CLIENT.clientSecret}`));
  });

  it("ignores a redirect with the wrong state, then accepts the right one", async () => {
    const secrets = secretsWith(JSON.stringify(CLIENT));
    const { fetchImplementation, exchanges } = vendorAndControlPlane();
    const play = browser((authorize) => [
      { code: "attacker-code", state: "not-the-state" },
      { code: "attacker-code" },
      { code: CODE, state: authorize.searchParams.get("state")! },
    ]);
    await authorizeCredential(base(secrets, fetchImplementation, play));
    expect(play.answers).toEqual([400, 400, 200]);
    expect(exchanges.map((entry) => entry.code)).toEqual([CODE]);
  });

  it("stops without storing anything when the sign-in is refused", async () => {
    const secrets = secretsWith(JSON.stringify(CLIENT));
    const { fetchImplementation, exchanges, registrations } = vendorAndControlPlane();
    const play = browser((authorize) => [{ error: "access_denied", state: authorize.searchParams.get("state")! }]);
    await expect(authorizeCredential(base(secrets, fetchImplementation, play))).rejects.toMatchObject({ code: "AUTH_REQUIRED", message: expect.stringContaining("refused or cancelled (access_denied); nothing was stored") as unknown });
    expect([exchanges, secrets.writes, registrations]).toEqual([[], [], []]);
  });

  it("times out when no sign-in arrives", async () => {
    const secrets = secretsWith(JSON.stringify(CLIENT));
    const { fetchImplementation } = vendorAndControlPlane();
    const play = browser(() => []);
    await expect(authorizeCredential({ ...base(secrets, fetchImplementation, play), timeoutMilliseconds: 50 })).rejects.toMatchObject({ code: "AUTH_REQUIRED", message: expect.stringContaining("no sign-in arrived") as unknown });
    expect(secrets.writes).toEqual([]);
  });

  it("reports a refused code exchange by its OAuth error code only, and stores nothing", async () => {
    const secrets = secretsWith(JSON.stringify(CLIENT));
    const { fetchImplementation, registrations } = vendorAndControlPlane({ tokenStatus: 400, tokenBody: { error: "invalid_grant", error_description: `bad code ${CODE}` } });
    const play = browser((authorize) => [{ code: CODE, state: authorize.searchParams.get("state")! }]);
    const failure = await authorizeCredential(base(secrets, fetchImplementation, play)).catch((error: unknown) => error) as Error;
    expect(failure.message).toContain("the token endpoint refused the sign-in with HTTP 400 (invalid_grant); nothing was stored");
    expect(failure.message).not.toContain(CODE);
    expect([secrets.writes, registrations]).toEqual([[], []]);
  });

  it("refuses a sign-in that returns no refresh token", async () => {
    const secrets = secretsWith(JSON.stringify(CLIENT));
    const { fetchImplementation } = vendorAndControlPlane({ tokenBody: { access_token: ACCESS, expires_in: 3600 } });
    const play = browser((authorize) => [{ code: CODE, state: authorize.searchParams.get("state")! }]);
    await expect(authorizeCredential(base(secrets, fetchImplementation, play))).rejects.toThrow("returned no refresh token");
    expect(secrets.writes).toEqual([]);
  });

  it("checks the provider and the secret before opening a browser", async () => {
    const { fetchImplementation } = vendorAndControlPlane();
    const play = browser(() => []);
    await expect(authorizeCredential({ ...base(secretsWith(JSON.stringify(CLIENT)), fetchImplementation, play), provider: "linear" }))
      .rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("no browser sign-in for provider linear; known providers: asana") as unknown });
    await expect(authorizeCredential(base(secretsWith(undefined), fetchImplementation, play)))
      .rejects.toMatchObject({ message: expect.stringContaining(`secret ${SECRET} was not found; create it as JSON {"clientId": "...", "clientSecret": "..."} first`) as unknown });
    const leaky = secretsWith(JSON.stringify({ apiKey: "leaky-secret-value" }));
    const malformed = await authorizeCredential(base(leaky, fetchImplementation, play)).catch((error: unknown) => error) as Error;
    expect(malformed.message).toContain(`secret ${SECRET} must be JSON`);
    expect(malformed.message).not.toContain("leaky-secret-value");
    await expect(authorizeCredential({ ...base(secretsWith(JSON.stringify(CLIENT)), fetchImplementation, play), secretName: "prod/asana" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(play.seen).toEqual([]);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("reads, writes and tags the secret through Secrets Manager", async () => {
    const send = vi.fn(async (command: unknown) => (command instanceof GetSecretValueCommand ? { SecretString: "{}" } : {}));
    const secrets = secretsManagerAuthorizeSecrets({ send } as never);
    expect(await secrets.read(SECRET)).toBe("{}");
    await secrets.write(SECRET, "value");
    await secrets.tag(SECRET);
    const [read, write, tag] = send.mock.calls.map(([command]) => command as { input: unknown });
    expect(read).toBeInstanceOf(GetSecretValueCommand);
    expect(write).toBeInstanceOf(PutSecretValueCommand);
    expect(write!.input).toEqual({ SecretId: SECRET, SecretString: "value" });
    expect(tag).toBeInstanceOf(TagResourceCommand);
    expect(tag!.input).toEqual({ SecretId: SECRET, Tags: [{ Key: "agentx-writable", Value: "refresh-token" }] });
    const missing = secretsManagerAuthorizeSecrets({ send: vi.fn(async () => { throw Object.assign(new Error("nope"), { name: "ResourceNotFoundException" }); }) } as never);
    expect(await missing.read(SECRET)).toBeUndefined();
  });

  it("runs from the command line, printing the sign-in URL and the result but never a token, the code or the client secret", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentx-authorize-"));
    const deploymentFile = join(directory, "deployment.yaml");
    await writeFile(deploymentFile, `controlPlaneUrl: ${CONTROL_PLANE}\nauth:\n  issuer: https://identity.example.test\n  clientId: cli\n  audience: agentx\n`);
    const tokenStore = new InMemoryTokenStore();
    await tokenStore.set(tokenStoreKey({ issuer: "https://identity.example.test", clientId: "cli", audience: "agentx" }), { accessToken: "admin-token", expiresAt: Date.now() + 3_600_000 });
    const secrets = secretsWith(JSON.stringify(CLIENT));
    const { fetchImplementation, registrations } = vendorAndControlPlane();
    const play = browser((authorize) => [{ code: CODE, state: authorize.searchParams.get("state")! }]);
    let stdout = "";
    let stderr = "";
    const exitCode = await executeCli(
      ["--deployment-file", deploymentFile, "admin", "credential", "authorize", "--ref", "asana-bot", "--secret", SECRET, "--provider", "asana"],
      {
        fetchImplementation, tokenStore,
        stdout: { write: (text: string) => { stdout += text; } }, stderr: { write: (text: string) => { stderr += text; } },
        authorize: { secrets, openBrowser: play.openBrowser, listenPort: 0, onListening: play.onListening },
      },
    );
    expect(exitCode).toBe(0);
    expect(registrations).toHaveLength(1);
    expect(stderr).toContain("https://app.asana.com/-/oauth_authorize?");
    expect(stderr).toContain(`Stored the refresh token in ${SECRET} and registered asana-bot as oauth-refresh-token.`);
    expect(JSON.parse(stdout)).toMatchObject({ credential: { ref: "asana-bot", type: "oauth-refresh-token" } });
    expect(`${stdout}${stderr}`).not.toMatch(new RegExp(`${REFRESH}|${ACCESS}|${CODE}|${CLIENT.clientSecret}`));
  });

  it("accepts exactly one valid callback, then closes the listener", async () => {
    const secrets = secretsWith(JSON.stringify(CLIENT));
    const { fetchImplementation, exchanges } = vendorAndControlPlane();
    const play = browser((authorize) => [
      { code: CODE, state: authorize.searchParams.get("state")! },
      { code: "second-code", state: authorize.searchParams.get("state")! },
    ]);
    let port = 0;
    await authorizeCredential({ ...base(secrets, fetchImplementation, play), onListening: (bound: number) => { port = bound; play.onListening(bound); } });
    expect(play.answers).toEqual([200, 410]);
    expect(exchanges.map((entry) => entry.code)).toEqual([CODE]);
    await expect(fetch(`http://127.0.0.1:${port}/callback`)).rejects.toThrow();
  });

  it("closes the listener after a refused sign-in and after a timeout", async () => {
    for (const [answers, timeoutMilliseconds] of [[(state: string) => [{ error: "access_denied", state }], 5_000], [() => [], 50]] as const) {
      const { fetchImplementation } = vendorAndControlPlane();
      const play = browser((authorize) => answers(authorize.searchParams.get("state")!));
      let port = 0;
      await expect(authorizeCredential({
        ...base(secretsWith(JSON.stringify(CLIENT)), fetchImplementation, play), timeoutMilliseconds,
        onListening: (bound: number) => { port = bound; play.onListening(bound); },
      })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      await expect(fetch(`http://127.0.0.1:${port}/callback`)).rejects.toThrow();
    }
  });

  it("listens on the loopback interface only", async () => {
    const external = Object.values(networkInterfaces()).flat().find((entry) => entry && entry.family === "IPv4" && !entry.internal);
    const { fetchImplementation } = vendorAndControlPlane();
    let reachedExternally: boolean | undefined;
    const play = browser((authorize) => [{ code: CODE, state: authorize.searchParams.get("state")! }]);
    let port = 0;
    await authorizeCredential({
      ...base(secretsWith(JSON.stringify(CLIENT)), fetchImplementation, play),
      onListening: (bound: number) => { port = bound; play.onListening(bound); },
      openBrowser: async (url: string) => {
        if (external) reachedExternally = await fetch(`http://${external.address}:${port}/callback`).then(() => true, () => false);
        await play.openBrowser(url);
      },
    });
    if (external) expect(reachedExternally).toBe(false);
    expect(play.answers).toEqual([200]);
  });

  it("reports a failed secret write or tag by the error's class name only", async () => {
    for (const failing of ["write", "tag"] as const) {
      const secrets = secretsWith(JSON.stringify(CLIENT));
      const denied = async (): Promise<never> => { throw Object.assign(new Error(`denied while handling ${REFRESH}`), { name: "AccessDeniedException" }); };
      if (failing === "write") secrets.write = denied; else secrets.tag = denied;
      const { fetchImplementation, registrations } = vendorAndControlPlane();
      const play = browser((authorize) => [{ code: CODE, state: authorize.searchParams.get("state")! }]);
      const failure = await authorizeCredential(base(secrets, fetchImplementation, play)).catch((error: unknown) => error) as Error & { code?: string };
      expect(failure.code).toBe("CONFIG_INVALID");
      expect(failure.message).toContain("(AccessDeniedException)");
      expect(failure.message).toContain(SECRET);
      expect(failure.message).not.toContain(REFRESH);
      expect(registrations).toEqual([]);
    }
  });

  it("reports an unreachable token endpoint by the error's class name only", async () => {
    const secrets = secretsWith(JSON.stringify(CLIENT));
    const fetchImplementation = vi.fn<typeof fetch>(async () => { throw Object.assign(new Error(`socket closed after ${CODE}`), { name: "TypeError" }); });
    const play = browser((authorize) => [{ code: CODE, state: authorize.searchParams.get("state")! }]);
    const failure = await authorizeCredential(base(secrets, fetchImplementation, play)).catch((error: unknown) => error) as Error & { code?: string };
    expect(failure).toMatchObject({ code: "AUTH_REQUIRED" });
    expect(failure.message).toContain("could not reach the token endpoint (TypeError); nothing was stored");
    expect(failure.message).not.toContain(CODE);
    expect(secrets.writes).toEqual([]);
  });

  it("prints only the OAuth error code when the command line's code exchange is refused", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentx-authorize-"));
    const deploymentFile = join(directory, "deployment.yaml");
    await writeFile(deploymentFile, `controlPlaneUrl: ${CONTROL_PLANE}\nauth:\n  issuer: https://identity.example.test\n  clientId: cli\n  audience: agentx\n`);
    const tokenStore = new InMemoryTokenStore();
    await tokenStore.set(tokenStoreKey({ issuer: "https://identity.example.test", clientId: "cli", audience: "agentx" }), { accessToken: "admin-token", expiresAt: Date.now() + 3_600_000 });
    const { fetchImplementation } = vendorAndControlPlane({ tokenStatus: 400, tokenBody: { error: "invalid_grant", error_description: `bad code ${CODE} for ${CLIENT.clientSecret}` } });
    const play = browser((authorize) => [{ code: CODE, state: authorize.searchParams.get("state")! }]);
    let output = "";
    const exitCode = await executeCli(
      ["--deployment-file", deploymentFile, "admin", "credential", "authorize", "--ref", "asana-bot", "--secret", SECRET, "--provider", "asana"],
      {
        fetchImplementation, tokenStore,
        stdout: { write: (text: string) => { output += text; } }, stderr: { write: (text: string) => { output += text; } },
        authorize: { secrets: secretsWith(JSON.stringify(CLIENT)), openBrowser: play.openBrowser, listenPort: 0, onListening: play.onListening },
      },
    );
    expect(exitCode).toBe(3);
    expect(output).toContain("(invalid_grant); nothing was stored");
    expect(output).not.toMatch(new RegExp(`${REFRESH}|${ACCESS}|${CODE}|${CLIENT.clientSecret}|bad code`));
  });
});
