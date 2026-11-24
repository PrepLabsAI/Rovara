// Save-time check of a company's package token (PRIVATE-PACKAGES P1b, decision 6 of the Opus plan check and F2 of the A3 review), BEFORE anything is stored:
//   - the SHAPE: GitHub Packages' npm registry takes a CLASSIC personal access token (`ghp_...`); a fine-grained one (`github_pat_...`) is refused with its own sentence;
//   - the SCOPES: one live call to GitHub's API with the token; only the `x-oauth-scopes` header is read (the body is dropped unread, nothing is logged). The token is accepted ONLY when its scopes are
//     `read:packages` (required), with at most the harmless reads `read:org`, `read:user` and `user:email` beside it (owner/Opus review of P1b; GitHub's docs: read:packages alone installs a private repository's packages): a token that can write or delete packages, or reach code (`repo`), could publish into the company's private scope from a package script, so the allowed access is the one that
//     makes the allow-listed host safe. A 401 is "GitHub did not accept this token"; anything else (no answer, a 5xx, a rate limit) is "could not check", and nothing is saved on an unchecked token.
// The probe is injected (a fake GitHub in tests). Nothing here puts the token in an error, a log line or a return value.
import { COMPANY_REGISTRY_WORDS, GITHUB_PACKAGES_ALLOWED_EXTRA_SCOPES, GITHUB_PACKAGES_READ_SCOPE, PRIVATE_REGISTRY_HOSTS, REGISTRY_TOKEN_MAX_LENGTH, REGISTRY_TOKEN_MIN_LENGTH, type PrivateRegistryHost } from "@agentx/contracts";

export type RegistryTokenRefusal = "shape" | "fine_grained" | "scopes_too_broad" | "scopes_missing" | "rejected" | "unchecked";
export type RegistryTokenVerdict = { ok: true } | { ok: false; reason: RegistryTokenRefusal; message: string };

/** What GitHub said: the status and the scopes header (undefined when it sent none). Never the body. */
export interface GithubScopeAnswer { status: number; scopes: string | undefined }
export type GithubScopeProbe = (token: string) => Promise<GithubScopeAnswer>;

export const GITHUB_API_USER_URL = "https://api.github.com/user";
const PROBE_TIMEOUT_MS = 8_000;
const PRINTABLE = /^[\x21-\x7e]+$/u;

const MESSAGES: Record<RegistryTokenRefusal, string> = {
  shape: COMPANY_REGISTRY_WORDS.tokenShape,
  fine_grained: COMPANY_REGISTRY_WORDS.tokenFineGrained,
  scopes_too_broad: COMPANY_REGISTRY_WORDS.scopesTooBroad,
  scopes_missing: COMPANY_REGISTRY_WORDS.scopesMissing,
  rejected: COMPANY_REGISTRY_WORDS.tokenRejected,
  unchecked: COMPANY_REGISTRY_WORDS.unchecked,
};
const refuse = (reason: RegistryTokenRefusal): RegistryTokenVerdict => ({ ok: false, reason, message: MESSAGES[reason] });

/** The shape rule alone (no network): the host's token prefix and the printable, bounded characters of a token. */
export function checkRegistryTokenShape(host: PrivateRegistryHost, token: string): RegistryTokenVerdict {
  if (token.startsWith("github_pat_")) return refuse("fine_grained");
  if (!token.startsWith(PRIVATE_REGISTRY_HOSTS[host].tokenPrefix) || token.length < REGISTRY_TOKEN_MIN_LENGTH || token.length > REGISTRY_TOKEN_MAX_LENGTH || !PRINTABLE.test(token)) return refuse("shape");
  return { ok: true };
}

/** The scopes a header lists, lower-cased, de-duplicated and sorted. */
export function parseOAuthScopes(header: string): string[] {
  return [...new Set(header.split(",").map((scope) => scope.trim().toLowerCase()).filter((scope) => scope !== ""))].sort();
}

/** Shape, then one live call. Resolves to the verdict; never throws and never carries the token. */
export async function checkRegistryToken(input: { host: PrivateRegistryHost; token: string; probe: GithubScopeProbe }): Promise<RegistryTokenVerdict> {
  const shape = checkRegistryTokenShape(input.host, input.token);
  if (!shape.ok) return shape;
  let answer: GithubScopeAnswer;
  try { answer = await input.probe(input.token); } catch { return refuse("unchecked"); }
  if (answer.status === 401) return refuse("rejected");
  if (answer.status !== 200) return refuse("unchecked");
  if (answer.scopes === undefined) return refuse("scopes_missing");
  const scopes = parseOAuthScopes(answer.scopes);
  if (scopes.length === 0) return refuse("scopes_missing");
  const allowedExtra: readonly string[] = GITHUB_PACKAGES_ALLOWED_EXTRA_SCOPES;
  if (scopes.some((scope) => scope !== GITHUB_PACKAGES_READ_SCOPE && !allowedExtra.includes(scope))) return refuse("scopes_too_broad");
  return scopes.includes(GITHUB_PACKAGES_READ_SCOPE) ? { ok: true } : refuse("scopes_missing");
}

/** The real probe: `GET https://api.github.com/user` with the token, headers only. The body is cancelled unread; a redirect is an error; the call is bounded in time. */
export function githubScopeProbe(fetchImpl: typeof fetch = fetch): GithubScopeProbe {
  return async (token) => {
    const response = await fetchImpl(GITHUB_API_USER_URL, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "rovara-package-token-check", "x-github-api-version": "2022-11-28" },
    });
    try { await response.body?.cancel(); } catch { /* the body is never read */ }
    return { status: response.status, scopes: response.headers.get("x-oauth-scopes") ?? undefined };
  };
}
