// The developer's AgentX tokens on this computer: used as long as they are valid, refreshed once,
// under a lock file, when they are not (R19). A failed refresh deletes tokens only when the server
// says the sign-in has ended (R18).
import { mkdir, open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { AGENTX_CLI_CLIENT_ID, DeveloperTokenResponseSchema, agentXError } from "@agentx/contracts";
import type { StoredTokens, TokenStore } from "../token-store.js";
import { developerTokenKey, resolveDeveloperEnvironment, type DeveloperEnvironment } from "./config.js";

export interface DeveloperSessionDeps { home: string; tokenStore: TokenStore; fetch: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; lockWaitMs?: number }

/** Refresh this long before the access token expires, so a call never carries one about to lapse. */
const EARLY_MS = 60_000;
/** A lock file older than this was left by a process that crashed mid-refresh. */
const STALE_LOCK_MS = 30_000;
const LOCK_POLL_MS = 50;

/** Cuts a server-sent reason to 300 characters and hides anything shaped like an AgentX secret. */
export function serverReason(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.replace(/agx[rc]_[A-Za-z0-9_-]+/g, "[hidden]").slice(0, 300) : fallback;
}

/** Runs work while holding ~/.agentx/locks/developer-<env>.lock, so two local processes never refresh at once. */
async function withRefreshLock<T>(deps: DeveloperSessionDeps, env: string, work: () => Promise<T>): Promise<T> {
  const dir = join(deps.home, ".agentx", "locks");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `developer-${env}.lock`);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + (deps.lockWaitMs ?? 15_000);
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(path).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (age > STALE_LOCK_MS) {
        await rm(path, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw agentXError("RUNTIME_UNAVAILABLE", `another agentx process is refreshing your sign-in to ${env}; try again in a moment`);
      await sleep(LOCK_POLL_MS);
    }
  }
  try {
    return await work();
  } finally {
    await rm(path, { force: true });
  }
}

/** A valid access token for the environment named, or the default one; refreshes when needed. */
export async function developerAccessToken(deps: DeveloperSessionDeps, env: string | undefined): Promise<{ env: string; entry: DeveloperEnvironment; accessToken: string }> {
  const now = deps.now ?? Date.now;
  const resolved = await resolveDeveloperEnvironment(deps.home, env);
  const key = developerTokenKey(resolved.entry.issuer);
  const signIn = `run npx @charterarc/agentx login ${resolved.entry.url}`;
  const fresh = (tokens: StoredTokens): boolean => tokens.expiresAt - EARLY_MS > now();

  const stored = await deps.tokenStore.get(key);
  if (stored === undefined) throw agentXError("AUTH_REQUIRED", `this computer is not signed in to AgentX environment ${resolved.env}; ${signIn}`);
  if (fresh(stored)) return { ...resolved, accessToken: stored.accessToken };

  return withRefreshLock(deps, resolved.env, async () => {
    // Another process may have refreshed while this one waited for the lock: use its tokens.
    const current = await deps.tokenStore.get(key);
    if (current !== undefined && fresh(current)) return { ...resolved, accessToken: current.accessToken };
    if (current?.refreshToken === undefined) throw agentXError("AUTH_REQUIRED", `your AgentX sign-in for ${resolved.env} has ended; ${signIn}`);
    let response: Response;
    try {
      response = await deps.fetch(resolved.entry.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: AGENTX_CLI_CLIENT_ID, refresh_token: current.refreshToken }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw agentXError("RUNTIME_UNAVAILABLE", `could not reach AgentX at ${resolved.entry.url}; check your connection and try again`);
    }
    const body: unknown = await response.json().catch(() => ({}));
    const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const reason = serverReason(fields.error_description, "no reason given");
    if (response.status === 400 && fields.error === "invalid_grant") {
      await deps.tokenStore.delete(key);
      throw agentXError("AUTH_REQUIRED", `your AgentX sign-in for ${resolved.env} has ended (${reason}); ${signIn}`);
    }
    if (response.status === 503) throw agentXError("RUNTIME_UNAVAILABLE", serverReason(fields.error_description, "AgentX could not refresh your sign-in just now; try again in a moment"));
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `AgentX could not refresh your sign-in (HTTP ${response.status}); try again`);
    const parsed = DeveloperTokenResponseSchema.safeParse(body);
    if (!parsed.success) throw agentXError("RUNTIME_UNAVAILABLE", "AgentX answered the refresh with something unexpected; try again");
    await deps.tokenStore.set(key, { accessToken: parsed.data.access_token, refreshToken: parsed.data.refresh_token, expiresAt: now() + parsed.data.expires_in * 1000 });
    return { ...resolved, accessToken: parsed.data.access_token };
  });
}
