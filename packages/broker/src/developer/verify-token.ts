// Spec 025 D17: the broker verifies developer access tokens itself. API Gateway's JWT authorizer
// fetches the issuer's discovery document when it is created, and the issuer is served by the same
// API, so a fresh install could never create it. Every refusal is the same AUTH_REQUIRED, and the
// token is never logged or repeated.
import { agentXError, DEVELOPER_TOKEN_AUDIENCE } from "@agentx/contracts";
import { decodeProtectedHeader, importJWK, jwtVerify, type CryptoKey, type JWTPayload, type KeyObject } from "jose";

type VerifyKey = CryptoKey | KeyObject | Uint8Array;

export interface DeveloperTokenVerifierInput {
  issuer: string;
  /** The sign-in server's public keys (its JWKS `keys`). A throw means they could not be read. */
  keys: () => Promise<unknown[]>;
  now: () => number;
}

/** Seconds of clock skew allowed on exp and nbf. */
const LEEWAY_SECONDS = 30;
/** An unknown kid refetches the keys at most this often, so random kids cannot flood the fetch. */
const REFETCH_MS = 60_000;
const COMPACT_JWT = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/;
const STRING_CLAIMS = ["sub", "sid", "amr", "env"] as const;

const refused = () => agentXError("AUTH_REQUIRED", "this route needs an AgentX developer sign-in; run agentx login <url>");
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "AgentX could not check your sign-in just now; try again in a moment");

async function importKeys(jwks: unknown[]): Promise<Map<string, VerifyKey>> {
  const keys = new Map<string, VerifyKey>();
  for (const entry of jwks) {
    if (typeof entry !== "object" || entry === null) continue;
    const jwk = entry as { kty?: unknown; kid?: unknown; n?: unknown; e?: unknown; alg?: unknown; use?: unknown };
    if (jwk.kty !== "RSA" || typeof jwk.kid !== "string" || typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
    if ((jwk.alg !== undefined && jwk.alg !== "RS256") || (jwk.use !== undefined && jwk.use !== "sig")) continue;
    keys.set(jwk.kid, await importJWK({ kty: "RSA", n: jwk.n, e: jwk.e }, "RS256"));
  }
  return keys;
}

export function developerTokenVerifier(input: DeveloperTokenVerifierInput): (authorization: string | undefined) => Promise<JWTPayload> {
  let cached: Map<string, VerifyKey> | undefined;
  let fetchedAt = Number.NEGATIVE_INFINITY;

  async function load(): Promise<Map<string, VerifyKey>> {
    fetchedAt = input.now();
    let keys: Map<string, VerifyKey>;
    try {
      keys = await importKeys(await input.keys());
    } catch {
      throw unavailable();
    }
    cached = keys;
    return keys;
  }

  async function keyFor(kid: string): Promise<VerifyKey | undefined> {
    const keys = cached ?? await load();
    const key = keys.get(kid);
    if (key !== undefined || input.now() - fetchedAt < REFETCH_MS) return key;
    return (await load()).get(kid);
  }

  return async (authorization) => {
    const token = COMPACT_JWT.exec(authorization ?? "")?.[1];
    if (token === undefined) throw refused();
    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      throw refused();
    }
    if (header.alg !== "RS256" || typeof header.kid !== "string" || header.crit !== undefined) throw refused();
    const key = await keyFor(header.kid);
    if (key === undefined) throw refused();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, key, {
        algorithms: ["RS256"],
        issuer: input.issuer,
        audience: DEVELOPER_TOKEN_AUDIENCE,
        clockTolerance: LEEWAY_SECONDS,
        currentDate: new Date(input.now()),
        requiredClaims: ["exp", "nbf"],
      }));
    } catch {
      throw refused();
    }
    if (STRING_CLAIMS.some((claim) => typeof payload[claim] !== "string" || payload[claim] === "")) throw refused();
    return payload;
  };
}
