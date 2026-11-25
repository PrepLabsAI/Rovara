import { createHash, createPublicKey, verify, type JsonWebKey, type KeyObject } from "node:crypto";
import type { InstallRegistry, JwksReader } from "./installs.js";
import { parseTaskClaims, record, TASK_KEY_PURPOSE, TASK_KEY_PURPOSE_MEMBER, TASK_TOKEN_ALGORITHM, TASK_TOKEN_SECONDS, TASK_TOKEN_TYPE, type TaskClaims } from "./model-gateway-token.js";
export * from "./model-gateway-token.js";
export const AUTH_ERROR = { error: { type: "authentication_error", message: "invalid or expired model access" } } as const;
export const JWKS_CACHE_SECONDS = 900;
interface Cache { expiresAt: number; keys: Map<string, KeyObject> | undefined; fetchedAt: number; failedAt: number; pending?: Promise<Map<string, KeyObject>> }
export interface TokenVerifierOptions { registry: InstallRegistry; readJwks: JwksReader; now?: () => number }
export type TaskTokenVerifier = (token: unknown) => Promise<TaskClaims | undefined>;
/** What differs between the signed tokens an install's task key signs: the header `typ`, the claims' shape, and the longest life. */
export interface SignedTokenKind<C extends { iss: string; iat: number; nbf: number; exp: number }> { typ: string; parse(value: unknown): C | undefined; maxSeconds: number }
const TASK_KIND: SignedTokenKind<TaskClaims> = { typ: TASK_TOKEN_TYPE, parse: parseTaskClaims, maxSeconds: TASK_TOKEN_SECONDS };
function importKeys(entries: unknown[]): Map<string, KeyObject> {
  if (!Array.isArray(entries) || entries.length > 32) throw new Error();
  const keys = new Map<string, KeyObject>();
  for (const entry of entries) {
    const j = record(entry);
    if (j?.[TASK_KEY_PURPOSE_MEMBER] !== TASK_KEY_PURPOSE || j.kty !== "RSA" || typeof j.kid !== "string" || typeof j.n !== "string" || typeof j.e !== "string" || (j.alg !== undefined && j.alg !== "RS256") || (j.use !== undefined && j.use !== "sig") || j.d !== undefined) continue;
    const key = createPublicKey({ key: { kty: "RSA", n: j.n, e: j.e } as JsonWebKey, format: "jwk" });
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 || (key.asymmetricKeyDetails?.modulusLength ?? 0) > 8192) continue;
    const kid = createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("base64url").slice(0, 16);
    if (kid !== j.kid || keys.has(kid)) throw new Error(); keys.set(kid, key);
  }
  return keys;
}
/** Cached per trusted install, coalesced fetches. A cache slot is never created for an unknown issuer. */
export function createTaskTokenVerifier(options: TokenVerifierOptions): TaskTokenVerifier { return createSignedTokenVerifier(options, TASK_KIND); }
/**
 * The same check for any token of the install's task key: pinned issuer and key ids, the JWKS cache, RS256 over the exact header
 * and claims, the clock window. A token of one kind never verifies as another (the header `typ` and the claims' exact members differ).
 */
export function createSignedTokenVerifier<C extends { iss: string; iat: number; nbf: number; exp: number }>(options: TokenVerifierOptions, kind: SignedTokenKind<C>): (token: unknown) => Promise<C | undefined> {
  const now = options.now ?? Date.now;
  const caches = new Map<string, Cache>();
  return async (token) => {
    try {
      if (typeof token !== "string" || token.length > 5000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) return undefined;
      const [h, p, s] = token.split(".") as [string, string, string];
      if (h.length + p.length + 1 > 3500) return undefined;
      const header = record(JSON.parse(Buffer.from(h, "base64url").toString()) as unknown);
      if (header?.alg !== TASK_TOKEN_ALGORITHM || header.typ !== kind.typ || typeof header.kid !== "string" || Object.keys(header).length !== 3) return undefined;
      const claims = kind.parse(JSON.parse(Buffer.from(p, "base64url").toString()) as unknown);
      if (claims === undefined) return undefined;
      const seconds = Math.floor(now() / 1000);
      if (claims.exp - claims.iat > kind.maxSeconds || claims.exp <= claims.iat || claims.nbf !== claims.iat - 30 || claims.iat > seconds + 30 || claims.exp <= seconds - 30 || claims.nbf > seconds + 30) return undefined;
      const install = options.registry.find(claims.iss);
      if (install === undefined || !install.taskKids.includes(header.kid)) return undefined;
      const cacheKey = JSON.stringify([install.issuer, install.jwksUrl]);
      let cache = caches.get(cacheKey);
      if (cache === undefined) { cache = { expiresAt: -Infinity, keys: undefined, fetchedAt: -Infinity, failedAt: -Infinity }; caches.set(cacheKey, cache); }
      const cachedKeyValid = cache.keys?.has(header.kid) === true && now() < cache.expiresAt;
      if (!cachedKeyValid && now() - cache.failedAt < 10_000) return undefined;
      if (!cachedKeyValid && (cache.keys === undefined || now() >= cache.expiresAt || now() - cache.fetchedAt >= 60_000 || cache.failedAt >= cache.fetchedAt)) {
        const current = cache;
        current.pending ??= Promise.resolve().then(async () => {
          current.fetchedAt = now();
          try { const keys = importKeys(await options.readJwks(install.jwksUrl)); current.keys = keys; current.expiresAt = now() + JWKS_CACHE_SECONDS * 1000; current.failedAt = -Infinity; return keys; }
          catch { current.failedAt = now(); throw new Error(); }
          finally { delete current.pending; }
        });
        await current.pending;
      }
      const key = cache.keys?.get(header.kid);
      if (key === undefined || !verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"))) return undefined;
      return claims;
    } catch { return undefined; }
  };
}
export async function verifyTaskToken(token: unknown, verifier: TaskTokenVerifier): Promise<TaskClaims | undefined> { return verifier(token); }
