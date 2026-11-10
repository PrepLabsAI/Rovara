// Port lane L11: a GitHub client for a laptop. It signs in with the owner's own token (a personal access token, or the token the GitHub CLI holds) and sits under the same
// GitHub adapters as Cloud's App client (`GitHubCodeHostProvider`, see `provider.ts`).
//
// How it reuses Cloud's request code (decision 54). Cloud's client (`client.ts`, 2.8k lines) reads, writes and merges through GitHub's REST and GraphQL API, and its only App-specific
// part is how it gets a token: it looks up the repository's installation, then mints an installation token with an App JWT. This file runs that same client unchanged and answers
// those App-only requests itself, in `ownerFetch`:
//   - `GET /repos/{o}/{r}/installation` is answered after one read of the repository with the owner's token (a repository the token cannot see is a 404, as for an App that is not installed);
//   - `POST /app/installations/{id}/access_tokens` is answered with the owner's token, after the same check, and with an expiry (see below);
//   - every other `/app...` request is a 404, and no request made with the App JWT ever leaves the process. The JWT is signed with a throwaway key made here, which GitHub has never seen.
// Every other request is passed on to GitHub unchanged, so the redirect refusal, the time limits, the rate-limit mapping and the body bounds of Cloud's code all apply. The owner's token is
// sent to `https://api.github.com` and nowhere else: a request with an Authorization header for any other address is refused here (L7A-4, L7A-5).
//
// What a personal token cannot do, stated rather than hidden:
//   - **No narrow or short-lived credential.** GitHub mints those only for an App. A personal token is one secret with whatever reach its owner gave it, so the clone credential and the push
//     credential are the same token. The credential's `expiresAt` is not GitHub's (a classic token has none): it is the time Rovara stops handing the token out and asks again (at most
//     `PERSONAL_CREDENTIAL_LIFETIME_MS`, and sooner when GitHub says the token itself expires sooner). Use a fine-grained token limited to the repositories you want Rovara to touch.
//   - **No installation.** Each owner gets a stable number derived from its name so the adapter's branch listing, which pins an installation id, keeps working. It is not a GitHub installation id.
//   - **Rovara's replies are the owner's.** GitHub shows a reply posted with a personal token as the owner's. Every reply carries a hidden marker, and a comment counts as Rovara's own
//     only when its author is the token's owner AND it carries the marker (see `personalToken.ownComment` in `client.ts`), so a reply of Rovara's is not read back as a person's feedback.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, generateKeyPairSync } from "node:crypto";
import { agentXError, type OrgId, type SecretValue } from "@agentx/contracts";
import { GitHubAppCredentialProvider, GithubMergeRateLimitError, mergeRateLimitRetryAt, parseGitHubRepository } from "./client.js";
import { GITHUB_CODE_HOST_PROVIDER_METHODS, type GitHubCodeHostProvider } from "./provider.js";

const API_ORIGIN = "https://api.github.com";
/** The most a credential handed to a worker lives (the contract allows an hour; this leaves room for the time a dispatch waits). */
export const PERSONAL_CREDENTIAL_LIFETIME_MS = 50 * 60_000;
/** The hidden marker on every reply Rovara posts with the owner's token. */
export const PERSONAL_REPLY_MARKER = "<!-- rovara-reply -->";
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_REUSE_MS = 60_000;
const ACCOUNT_REUSE_MS = 5 * 60_000;
const PERSONAL_APP_ID = "1";
/** A token is one printable word: it goes into a header, so no space, line break or control character. */
const TOKEN_SHAPE = /^[\x21-\x7e]{1,1024}$/u;
const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
/** GitHub-only requests the App client makes with its JWT (the installation lookups, the App's own pages). */
const APP_PATH = /^\/(?:app(?:\/.*)?|repos\/[^/]+\/[^/]+\/installation|orgs\/[^/]+\/installation|users\/[^/]+\/installation|installation(?:\/.*)?)$/u;

export interface GitHubTokenClientOptions {
  /** The credential reference the client is configured with (a repository registered under another one gets no credential). */
  credentialRef: string;
  /** The owner's token, asked for whenever one is needed (never cached for longer than the caller caches it, so a new sign-in is picked up). */
  getToken(): Promise<SecretValue>;
  /** Asked on every call that names an organization, before anything is sent; throws to refuse. On a laptop it holds the call to the one company (`boundToCompany`). */
  requireBound(orgId: OrgId, repository?: { owner: string; name: string }): Promise<void>;
  /**
   * The addresses of the repositories this company registered (its projects'). A token reaches every repository its owner can, so this list, not the token, says which repositories Rovara may
   * use: any other is refused with GITHUB_NOT_CONNECTED before a request carrying the token is made. Only the registration-time reads (`checkRepository`, `getRepositoryIdentity`: is this
   * repository there, who is it) are exempt, so a repository can be registered at all.
   */
  registeredRepositories(): Promise<readonly string[]> | readonly string[];
  /**
   * Whether a worker may be given a token that reaches every repository its owner can (a classic token or the GitHub CLI's, as opposed to a fine-grained token limited to chosen
   * repositories). Default false: such a token is refused for the worker's clone and push, and every broker-side use of it is unaffected.
   */
  allowBroadTokenForWorker?: boolean;
  /** Told what each token request asked for (names only, never the token): the permission set and the one repository. For logs and for the conformance suite. */
  observeMint?(mint: { permissions: Record<string, string>; repositories: string[] }): void;
  fetchImplementation?: typeof fetch;
  now?: () => number;
}

/** The binding for a laptop: one company, and any other organization is refused. */
export function boundToCompany(companyId: string): GitHubTokenClientOptions["requireBound"] {
  return async (orgId) => {
    if (orgId !== companyId) throw agentXError("GITHUB_NOT_CONNECTED", "GitHub is not connected for this company.");
  };
}

/**
 * Whether a token is limited to repositories its owner chose. A fine-grained personal token (`github_pat_...`) is, and so is an App installation token (`ghs_...`, one hour). Every other
 * kind (a classic token `ghp_...`, the GitHub CLI's `gho_...`) reaches every repository its owner can, whatever its scopes say, so it is `broad`. A token of a shape this code does not
 * know is `broad` too: refusing is the safe answer.
 */
export function githubTokenReach(token: string): "limited" | "broad" {
  return /^(?:github_pat_|ghs_)[A-Za-z0-9_]{8,}$/u.test(token) ? "limited" : "broad";
}

/** What `GET /user` and the token's own headers say: the account it signs in as, the scopes of a classic token, and when the token itself expires. Never the token. */
export interface GitHubTokenAccount {
  status: "ok" | "rejected" | "unavailable";
  httpStatus?: number;
  login?: string;
  scopes?: string[];
  /** Milliseconds since the epoch, when GitHub says the token expires. */
  expiresAt?: number;
}

/** GitHub's `github-authentication-token-expiration` header: `2026-12-01 10:00:00 UTC`. */
export function tokenExpirationOf(response: Response): number | undefined {
  const text = response.headers.get("github-authentication-token-expiration")?.trim();
  if (text === undefined || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?: UTC)?$/u.test(text)) return undefined;
  const parsed = Date.parse(`${text.slice(0, 10)}T${text.slice(11, 19)}Z`);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function ownerHeaders(token: string): Record<string, string> {
  return { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "rovara-code", "x-github-api-version": "2022-11-28" };
}

function accountOf(response: Response, body: unknown): GitHubTokenAccount {
  if (response.status === 401) return { status: "rejected", httpStatus: 401 };
  if (!response.ok) return { status: "unavailable", httpStatus: response.status };
  const login = body !== null && typeof body === "object" && "login" in body && typeof body.login === "string" && /^[A-Za-z0-9-]{1,39}$/u.test(body.login) ? body.login : undefined;
  const scopesHeader = response.headers.get("x-oauth-scopes");
  const expiresAt = tokenExpirationOf(response);
  return {
    status: "ok", httpStatus: response.status, ...(login === undefined ? {} : { login }),
    ...(scopesHeader === null ? {} : { scopes: scopesHeader.split(",").map((scope) => scope.trim()).filter((scope) => scope !== "") }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/** Asks GitHub who the token is (`GET /user`). One request, no redirects, a time limit; the token goes to api.github.com only. */
export async function describeTokenAccount(token: string, fetchImplementation: typeof fetch, timeoutMs = 8_000): Promise<GitHubTokenAccount> {
  if (!TOKEN_SHAPE.test(token)) return { status: "rejected" };
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetchImplementation(`${API_ORIGIN}/user`, { headers: ownerHeaders(token), redirect: "error", signal });
  let body: unknown;
  try { body = response.ok ? await response.json() : undefined; } catch { body = undefined; }
  if (!response.ok) await response.body?.cancel().catch(() => undefined);
  return accountOf(response, body);
}

interface RepositoryProbe {
  canonicalOwner: string;
  ownerId: number;
  ownerType: string;
  /** `permissions.push` of the answer; undefined when GitHub did not say. */
  canPush: boolean | undefined;
  tokenExpiresAt: number | undefined;
  /** The token this answer was read with: the one a mint hands out, so the token handed over is exactly the one that passed the check. */
  token: string;
}

const jsonResponse = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A `Request` carries its own address, method, headers, body, signal and redirect mode: fold them, and any `init`, into one address and one `init`, so the checks see what the call really sends. */
export async function foldRequest(input: string | URL | Request, init?: RequestInit): Promise<{ address: string; init: RequestInit }> {
  if (!(input instanceof Request)) return { address: typeof input === "string" ? input : input.href, init: init ?? {} };
  const method = input.method.toUpperCase();
  return {
    address: input.url,
    init: {
      method: input.method, headers: input.headers, signal: input.signal, redirect: input.redirect,
      ...(method === "GET" || method === "HEAD" ? {} : { body: await input.clone().text() }), ...init,
    },
  };
}

/**
 * Passes a request on to GitHub. One that carries a credential goes to `https://api.github.com` only (anything else is refused, the credential unsent) and never follows a redirect: the one
 * request that asks to handle a redirect itself (`manual`, the job-log lookup) keeps that, every other is forced to `error`.
 */
export async function forwardGuarded(inner: typeof fetch, request: { address: string; init: RequestInit }): Promise<Response> {
  const authorization = new Headers(request.init.headers).get("authorization");
  if (authorization === null) return inner(request.address, request.init);
  if (new URL(request.address).origin !== API_ORIGIN) throw agentXError("RUNTIME_UNAVAILABLE", "the GitHub token is sent to api.github.com only");
  return inner(request.address, { ...request.init, redirect: request.init.redirect === "manual" ? "manual" : "error" });
}

/** Builds the narrow client. Only the methods of `GitHubCodeHostProvider` are on it: the App client's other public methods (agent tokens, webhook history) are not reachable through it. */
export function githubTokenClient(options: GitHubTokenClientOptions): GitHubCodeHostProvider {
  const inner = options.fetchImplementation ?? fetch;
  const now = options.now ?? Date.now;

  // The throwaway key the App client signs its (never sent) JWTs with, made on first use.
  let throwawayKey: string | undefined;
  const privateKey = async (): Promise<string> => {
    throwawayKey ??= generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    return throwawayKey;
  };

  const ownerOf = new Map<number, string>();
  const idOf = new Map<string, number>();
  /** A stable number per owner (not a GitHub installation id): the owner's name, hashed, kept apart from every other owner's. */
  const installationNumber = (owner: string): number => {
    const key = owner.toLowerCase();
    const known = idOf.get(key);
    if (known !== undefined) return known;
    let candidate = (Number.parseInt(createHash("sha256").update(key).digest("hex").slice(0, 6), 16) % 16_000_000) + 1;
    while (ownerOf.has(candidate) && ownerOf.get(candidate) !== key) candidate += 1;
    ownerOf.set(candidate, key);
    idOf.set(key, candidate);
    return candidate;
  };

  const ownerToken = async (): Promise<string> => {
    let secret: SecretValue;
    try {
      secret = await options.getToken();
    } catch (error) {
      // The sign-in sources word their own failures without quoting any file (token-access.ts, model-key-stores.ts).
      throw agentXError("CONFIG_INVALID", error instanceof Error && error.message !== "" ? error.message : "no GitHub sign-in was found; run `gh auth login`, or set GH_TOKEN");
    }
    const token = secret.reveal();
    if (!TOKEN_SHAPE.test(token)) throw agentXError("CONFIG_INVALID", "no GitHub sign-in was found; run `gh auth login`, or set GH_TOKEN");
    return token;
  };

  const probes = new Map<string, { at: number; token: string; result: Promise<RepositoryProbe | undefined> }>();
  /** Reads the repository with the owner's token: undefined when the token cannot see it. A rejected token and a rate limit are errors. */
  const registrationRead = new AsyncLocalStorage<true>();
  const registeredKeys = async (): Promise<Set<string>> => {
    const keys = new Set<string>();
    for (const address of await options.registeredRepositories()) {
      try {
        const parsed = parseGitHubRepository(address);
        keys.add(`${parsed.owner.toLowerCase()}/${parsed.name.toLowerCase()}`);
      } catch { /* a repository on another host is not one of GitHub's */ }
    }
    return keys;
  };
  const probe = async (owner: string, name: string): Promise<RepositoryProbe | undefined> => {
    // Before any request that carries the token: the repository must be one the company registered (or this must be the read that registers it).
    if (registrationRead.getStore() !== true && !(await registeredKeys()).has(`${owner.toLowerCase()}/${name.toLowerCase()}`)) {
      throw agentXError("GITHUB_NOT_CONNECTED", `${owner}/${name} is not one of this company's registered repositories.`);
    }
    const token = await ownerToken();
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    const cached = probes.get(key);
    if (cached !== undefined && cached.token === token && now() - cached.at < PROBE_REUSE_MS) return cached.result;
    const result = (async (): Promise<RepositoryProbe | undefined> => {
      const response = await inner(`${API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
        headers: ownerHeaders(token), redirect: "error", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        throw agentXError("RUNTIME_UNAVAILABLE", "GitHub rejected the token (HTTP 401); run `gh auth login` again, or replace the token");
      }
      const retryAt = mergeRateLimitRetryAt(response, now());
      if (retryAt !== undefined) {
        await response.body?.cancel().catch(() => undefined);
        throw new GithubMergeRateLimitError(retryAt);
      }
      if (response.status === 404 || response.status === 403 || response.status === 451) {
        await response.body?.cancel().catch(() => undefined);
        return undefined;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw agentXError("RUNTIME_UNAVAILABLE", `GitHub repository check failed with HTTP ${response.status}`);
      }
      const body: unknown = await response.json().catch(() => undefined);
      const owner_ = body !== null && typeof body === "object" && "owner" in body && body.owner !== null && typeof body.owner === "object" ? body.owner as Record<string, unknown> : undefined;
      if (typeof owner_?.login !== "string" || owner_.login.toLowerCase() !== owner.toLowerCase()) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid repository response");
      const permissions = (body as { permissions?: unknown }).permissions;
      const push = permissions !== null && typeof permissions === "object" && "push" in permissions && typeof permissions.push === "boolean" ? permissions.push : undefined;
      return {
        canonicalOwner: owner_.login, ownerId: Number.isSafeInteger(owner_.id) && (owner_.id as number) > 0 ? owner_.id as number : 1,
        ownerType: owner_.type === "Organization" ? "Organization" : "User", canPush: push, tokenExpiresAt: tokenExpirationOf(response), token,
      };
    })();
    probes.set(key, { at: now(), token, result });
    result.catch(() => { if (probes.get(key)?.result === result) probes.delete(key); });
    return result;
  };

  /** The App-only requests, answered here. Nothing in this function reaches the network except `probe`, and that carries the owner's token to api.github.com only. */
  const appRequest = async (url: URL, method: string, init: RequestInit | undefined): Promise<Response> => {
    const path = decodeURIComponent(url.pathname);
    const lookup = /^\/repos\/([^/]+)\/([^/]+)\/installation$/u.exec(path);
    if (method === "GET" && lookup !== null) {
      const found = await probe(lookup[1]!, lookup[2]!);
      if (found === undefined) return jsonResponse(404, { message: "Not Found" });
      return jsonResponse(200, { id: installationNumber(found.canonicalOwner), account: { login: found.canonicalOwner, id: found.ownerId, type: found.ownerType } });
    }
    const mint = /^\/app\/installations\/([1-9][0-9]{0,15})\/access_tokens$/u.exec(path);
    if (method === "POST" && mint !== null) {
      let body: { permissions?: unknown; repositories?: unknown };
      try { body = typeof init?.body === "string" ? JSON.parse(init.body) as typeof body : {}; } catch { body = {}; }
      const owner = ownerOf.get(Number(mint[1]));
      const repositories = Array.isArray(body.repositories) ? body.repositories : [];
      const name = repositories.length === 1 && typeof repositories[0] === "string" ? repositories[0] : undefined;
      const permissions = body.permissions !== null && typeof body.permissions === "object" && !Array.isArray(body.permissions) ? body.permissions as Record<string, unknown> : undefined;
      // A token for a whole installation (no one repository) is something only an App has; a personal token is never handed out for "everything".
      if (owner === undefined || name === undefined || permissions === undefined) return jsonResponse(owner === undefined ? 404 : 403, { message: "A personal token is handed out for one repository only." });
      const found = await probe(owner, name);
      if (found === undefined) return jsonResponse(404, { message: "Not Found" });
      if (permissions.contents === "write" && found.canPush === false) return jsonResponse(403, { message: "The token cannot push to this repository." });
      const ceiling = now() + PERSONAL_CREDENTIAL_LIFETIME_MS;
      const expiresAt = Math.min(ceiling, found.tokenExpiresAt ?? ceiling);
      if (!(expiresAt > now())) return jsonResponse(403, { message: "The token has expired." });
      options.observeMint?.({ permissions: Object.fromEntries(Object.entries(permissions).map(([key, value]) => [key, String(value)])), repositories: [name] });
      return jsonResponse(201, { token: found.token, expires_at: new Date(expiresAt).toISOString(), permissions, repository_selection: "selected", repositories: [{ name }] });
    }
    return jsonResponse(404, { message: "Not Found" });
  };

  const ownerFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const folded = await foldRequest(input, init);
    const url = new URL(folded.address);
    const method = (folded.init.method ?? "GET").toUpperCase();
    if (url.origin === API_ORIGIN && APP_PATH.test(decodeURIComponent(url.pathname))) return appRequest(url, method, folded.init);
    // Defence in depth: the App JWT is never forwarded, whatever it was sent to.
    const authorization = new Headers(folded.init.headers).get("authorization");
    if (authorization !== null && JWT_SHAPE.test(authorization.replace(/^Bearer /u, ""))) return jsonResponse(401, { message: "Bad credentials" });
    return forwardGuarded(inner, folded);
  }) as typeof fetch;

  let account: { at: number; token: string; login: string | undefined } | undefined;
  /** The login of the token's owner (cached for a few minutes, per token): how Rovara's own replies are told from other comments. */
  const login = async (): Promise<string | undefined> => {
    const token = await ownerToken();
    if (account !== undefined && account.token === token && now() - account.at < ACCOUNT_REUSE_MS) return account.login;
    const read = await describeTokenAccount(token, inner, PROBE_TIMEOUT_MS);
    // Only an answer that named the login is kept: a failed look is asked again next time, never remembered as "unknown".
    if (read.status !== "ok" || read.login === undefined) return undefined;
    account = { at: now(), token, login: read.login };
    return read.login;
  };

  const client = new GitHubAppCredentialProvider({
    credentialRef: options.credentialRef,
    appId: PERSONAL_APP_ID,
    getPrivateKey: privateKey,
    requireInstallationBound: async (orgId, _installationId, repository) => options.requireBound(orgId, repository),
    fetchImplementation: ownerFetch,
    now,
    personalToken: {
      ownComment: { login, marker: PERSONAL_REPLY_MARKER },
      notReachable: (repository) => `the GitHub token cannot access ${repository.owner}/${repository.name}; sign in as an account that can, or give the token access to that repository`,
    },
  });
  const provider: GitHubCodeHostProvider = client;

  // The narrow surface: the provider's methods and nothing else of the App client's. Each call that names an organization is bound BEFORE anything is sent (the client binds again inside), the
  // registration-time reads may name a repository not yet registered, and a credential for a worker is refused when the token reaches more than the project's repositories.
  const REGISTRATION_READS = new Set<string>(["checkRepository", "getRepositoryIdentity"]);
  const scopeOrgOf = (args: readonly unknown[]): OrgId | undefined => {
    for (const argument of args) {
      if (argument !== null && typeof argument === "object" && !Array.isArray(argument) && typeof (argument as { orgId?: unknown }).orgId === "string") return (argument as { orgId: OrgId }).orgId;
    }
    return undefined;
  };
  const repositoryOf = (args: readonly unknown[]): { owner: string; name: string } | undefined => {
    const first = args[0];
    const address = typeof first === "string" ? first
      : first !== null && typeof first === "object" && typeof (first as { repositoryUrl?: unknown }).repositoryUrl === "string" ? (first as { repositoryUrl: string }).repositoryUrl
      : first !== null && typeof first === "object" && typeof (first as { url?: unknown }).url === "string" ? (first as { url: string }).url : undefined;
    if (address === undefined) return undefined;
    try { return parseGitHubRepository(address); } catch { return undefined; }
  };
  const surface: Record<string, unknown> = {};
  for (const name of [...GITHUB_CODE_HOST_PROVIDER_METHODS, "getPathKindAtCommit", "listPullRequestComments", "postPullRequestComment", "commitFilesToBranch", "findLessonsPullRequest", "deleteLessonsBranch"] as const) {
    const method: unknown = Reflect.get(provider, name);
    if (typeof method !== "function") continue;
    surface[name] = async (...args: unknown[]): Promise<unknown> => {
      const run = async (): Promise<unknown> => {
        const orgId = scopeOrgOf(args);
        if (orgId !== undefined) await options.requireBound(orgId, repositoryOf(args));
        const result: unknown = await Reflect.apply(method as (...input: unknown[]) => unknown, provider, args);
        if (name === "resolveWithExpiry") assertWorkerMayHold(result);
        return result;
      };
      return REGISTRATION_READS.has(name) ? registrationRead.run(true, run) : run();
    };
  }
  /** The worker holds a copy of what `resolveWithExpiry` returns, so a token that reaches every repository its owner can is not handed over unless the owner said so. */
  function assertWorkerMayHold(credential: unknown): void {
    const password = credential !== null && typeof credential === "object" ? (credential as { password?: unknown }).password : undefined;
    if (typeof password !== "string" || options.allowBroadTokenForWorker === true || githubTokenReach(password) === "limited") return;
    throw agentXError("FORBIDDEN", "This GitHub token can reach every repository you can, and a task's worker would hold a copy of it. Make a fine-grained token limited to this project's repositories and use that, or set allowBroadTokenForWorker to true in the Rovara config to accept the risk.");
  }
  return Object.freeze(surface) as unknown as GitHubCodeHostProvider;
}

