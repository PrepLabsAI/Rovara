import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { developerTokenKey, readDeveloperConfig, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { developerAccessToken } from "../../packages/cli/src/developer/session.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const URL_ = "https://abc123.execute-api.us-east-1.amazonaws.com";
const ISSUER = `${URL_}/v1/auth`;
const entry = { url: URL_, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` };
const T0 = Date.parse("2026-09-27T12:00:00.000Z");
const r = (c: string) => `agxr_${c.repeat(43)}`;
const formOf = (init: RequestInit | undefined) => new URLSearchParams(typeof init?.body === "string" ? init.body : "");

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function setup(tokens: { accessToken: string; refreshToken?: string; expiresAt: number }) {
  const home = await mkdtemp(join(tmpdir(), "agentx-dev-session-"));
  dirs.push(home);
  await saveDeveloperEnvironment(home, "staging", entry);
  const tokenStore = new InMemoryTokenStore();
  await tokenStore.set(developerTokenKey(ISSUER), tokens);
  return { home, tokenStore };
}

describe("developer access tokens on this machine", () => {
  it("uses a token that is still valid for more than a minute, without calling the server", async () => {
    const { home, tokenStore } = await setup({ accessToken: "valid", refreshToken: r("a"), expiresAt: T0 + 120_000 });
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await developerAccessToken({ home, tokenStore, fetch: fetchImpl, now: () => T0 }, undefined)).toMatchObject({ env: "staging", accessToken: "valid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes silently and stores the rotated refresh token (US4 scenario 4)", async () => {
    const { home, tokenStore } = await setup({ accessToken: "old", refreshToken: r("a"), expiresAt: T0 + 30_000 });
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const form = formOf(init);
      expect(form.get("refresh_token")).toBe(r("a"));
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("client_id")).toBe("agentx-cli");
      return Response.json({ access_token: "new", token_type: "Bearer", expires_in: 3600, refresh_token: r("b") });
    });
    expect((await developerAccessToken({ home, tokenStore, fetch: fetchImpl, now: () => T0 }, "staging")).accessToken).toBe("new");
    expect(await tokenStore.get(developerTokenKey(ISSUER))).toEqual({ accessToken: "new", refreshToken: r("b"), expiresAt: T0 + 3_600_000 });
  });

  it("serializes concurrent refreshes so the server never sees the same refresh token twice (Review Focus 2, R19)", async () => {
    const { home, tokenStore } = await setup({ accessToken: "old", refreshToken: r("a"), expiresAt: T0 - 1 });
    const seen: string[] = [];
    let issued = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const token = formOf(init).get("refresh_token") ?? "";
      seen.push(token);
      await new Promise((resolve) => setTimeout(resolve, 50));
      issued += 1;
      return Response.json({ access_token: `new-${issued}`, token_type: "Bearer", expires_in: 3600, refresh_token: r(String.fromCharCode(97 + issued)) });
    });
    const deps = { home, tokenStore, fetch: fetchImpl, now: () => T0 };
    const results = await Promise.all([developerAccessToken(deps, "staging"), developerAccessToken(deps, "staging"), developerAccessToken(deps, "staging")]);
    expect(seen).toEqual([r("a")]);
    expect(new Set(results.map((result) => result.accessToken))).toEqual(new Set(["new-1"]));
  });

  it("releases the lock file after a refresh, and after a failed one", async () => {
    const { home, tokenStore } = await setup({ accessToken: "old", refreshToken: r("a"), expiresAt: T0 - 1 });
    const lock = join(home, ".agentx", "locks", "developer-staging.lock");
    const failing = vi.fn<typeof fetch>(async () => { throw new TypeError("fetch failed"); });
    await expect(developerAccessToken({ home, tokenStore, fetch: failing, now: () => T0 }, "staging")).rejects.toThrow(/RUNTIME_UNAVAILABLE/);
    await expect(writeFile(lock, "", { flag: "wx" })).resolves.toBeUndefined();
    await rm(lock);
  });

  it("gives up with a clear message when another process holds the lock too long", async () => {
    const { home, tokenStore } = await setup({ accessToken: "old", refreshToken: r("a"), expiresAt: T0 - 1 });
    await mkdir(join(home, ".agentx", "locks"), { recursive: true });
    await writeFile(join(home, ".agentx", "locks", "developer-staging.lock"), "12345");
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(developerAccessToken({ home, tokenStore, fetch: fetchImpl, now: () => T0, lockWaitMs: 100 }, "staging")).rejects.toThrow("RUNTIME_UNAVAILABLE: another agentx process is refreshing your sign-in to staging; try again in a moment");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("leaves a lock that another process took over in place (fix 6)", async () => {
    const { home, tokenStore } = await setup({ accessToken: "old", refreshToken: r("a"), expiresAt: T0 - 1 });
    const lock = join(home, ".agentx", "locks", "developer-staging.lock");
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      // Another process judged this lock stale and took it over while the refresh ran.
      await writeFile(lock, "other-process");
      return Response.json({ access_token: "new", token_type: "Bearer", expires_in: 3600, refresh_token: r("b") });
    });
    expect((await developerAccessToken({ home, tokenStore, fetch: fetchImpl, now: () => T0 }, "staging")).accessToken).toBe("new");
    expect(await readFile(lock, "utf8")).toBe("other-process");
  });

  it("strips terminal escapes and hides planted tokens in the token endpoint's reason (fix 3)", async () => {
    const { home, tokenStore } = await setup({ accessToken: "old", refreshToken: r("a"), expiresAt: T0 - 1 });
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ error: "temporarily_unavailable", error_description: `try\u001b]0;pwned\u0007 later ${r("z")}` }, { status: 503 }));
    await expect(developerAccessToken({ home, tokenStore, fetch: fetchImpl, now: () => T0 }, "staging")).rejects.toThrow("RUNTIME_UNAVAILABLE: try]0;pwned later [hidden]");
  });

  it("takes over a lock file left by a crashed process after 30 seconds", async () => {
    const { home, tokenStore } = await setup({ accessToken: "old", refreshToken: r("a"), expiresAt: T0 - 1 });
    await mkdir(join(home, ".agentx", "locks"), { recursive: true });
    const lock = join(home, ".agentx", "locks", "developer-staging.lock");
    await writeFile(lock, "99999");
    await utimes(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ access_token: "new", token_type: "Bearer", expires_in: 3600, refresh_token: r("b") }));
    expect((await developerAccessToken({ home, tokenStore, fetch: fetchImpl, now: () => T0 }, "staging")).accessToken).toBe("new");
  });

  it("deletes the tokens and names the exact login command when the sign-in has ended (US4 scenario 5)", async () => {
    const { home, tokenStore } = await setup({ accessToken: "old", refreshToken: r("a"), expiresAt: T0 - 1 });
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ error: "invalid_grant", error_description: "your AgentX sign-in has ended; run agentx login again" }, { status: 400 }));
    await expect(developerAccessToken({ home, tokenStore, fetch: fetchImpl, now: () => T0 }, "staging")).rejects.toThrow(`AUTH_REQUIRED: your AgentX sign-in for staging has ended (your AgentX sign-in has ended; run agentx login again); run npx @preplabs/rovara-code login ${URL_}`);
    expect(await tokenStore.get(developerTokenKey(ISSUER))).toBeUndefined();
  });

  it("keeps the tokens when the server says Slack is unavailable (Review Focus 3)", async () => {
    const { home, tokenStore } = await setup({ accessToken: "old", refreshToken: r("a"), expiresAt: T0 - 1 });
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ error: "temporarily_unavailable", error_description: "Slack could not be reached to check your account; your sign-in is kept, try again in a few minutes" }, { status: 503 }));
    await expect(developerAccessToken({ home, tokenStore, fetch: fetchImpl, now: () => T0 }, "staging")).rejects.toThrow(/^RUNTIME_UNAVAILABLE: Slack could not be reached/);
    expect(await tokenStore.get(developerTokenKey(ISSUER))).toMatchObject({ refreshToken: r("a") });
  });

  it("keeps the tokens when the control plane cannot be reached", async () => {
    const { home, tokenStore } = await setup({ accessToken: "old", refreshToken: r("a"), expiresAt: T0 - 1 });
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new TypeError("fetch failed"); });
    await expect(developerAccessToken({ home, tokenStore, fetch: fetchImpl, now: () => T0 }, "staging")).rejects.toThrow(/^RUNTIME_UNAVAILABLE: could not reach AgentX at https:\/\/abc123/);
    expect(await tokenStore.get(developerTokenKey(ISSUER))).toMatchObject({ refreshToken: r("a") });
  });

  it("never puts the refresh token in an error message", async () => {
    const { home, tokenStore } = await setup({ accessToken: "old", refreshToken: r("a"), expiresAt: T0 - 1 });
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ error: "invalid_grant", error_description: `token ${r("a")} was reused` }, { status: 400 }));
    const failure = await developerAccessToken({ home, tokenStore, fetch: fetchImpl, now: () => T0 }, "staging").then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(r("a"));
  });

  it("says how to sign in when this machine never signed in to the environment", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentx-dev-session-"));
    dirs.push(home);
    await expect(developerAccessToken({ home, tokenStore: new InMemoryTokenStore(), fetch: vi.fn<typeof fetch>(), now: () => T0 }, "staging")).rejects.toThrow("AUTH_REQUIRED: this computer is not signed in to AgentX environment staging; run npx @preplabs/rovara-code login <your AgentX URL>");
    expect(await readDeveloperConfig(home)).toEqual({ environments: {} });
  });
  it("refreshes a still-valid token when asked to force it (an access token AgentX refused)", async () => {
    const { home, tokenStore } = await setup({ accessToken: "refused", refreshToken: r("a"), expiresAt: T0 + 120_000 });
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ access_token: "new", token_type: "Bearer", expires_in: 3600, refresh_token: r("b") }));
    expect((await developerAccessToken({ home, tokenStore, fetch: fetchImpl, now: () => T0 }, "staging", { force: true })).accessToken).toBe("new");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await tokenStore.get(developerTokenKey(ISSUER))).toEqual({ accessToken: "new", refreshToken: r("b"), expiresAt: T0 + 3_600_000 });
  });

  it("uses the token another process refreshed while a forced refresh waited for the lock", async () => {
    const { home, tokenStore } = await setup({ accessToken: "refused", refreshToken: r("a"), expiresAt: T0 + 120_000 });
    const newer = { accessToken: "newer", refreshToken: r("c"), expiresAt: T0 + 3_600_000 };
    vi.spyOn(tokenStore, "get").mockResolvedValueOnce({ accessToken: "refused", refreshToken: r("a"), expiresAt: T0 + 120_000 }).mockResolvedValueOnce(newer);
    const fetchImpl = vi.fn<typeof fetch>();
    expect((await developerAccessToken({ home, tokenStore, fetch: fetchImpl, now: () => T0 }, "staging", { force: true })).accessToken).toBe("newer");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
