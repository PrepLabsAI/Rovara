import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import type { TaskTokenClaims } from "@agentx/contracts";
import type { TokenSigner, PublicSigningJwk } from "../../packages/broker/src/developer/tokens.js";

export const vector = JSON.parse(readFileSync(new URL("../../contracts/shared/model-gateway-token.v1.json", import.meta.url), "utf8")) as { testVector: { claims: TaskTokenClaims }; claims: Array<{ name: string; required: boolean }> };
export const claimVector = () => structuredClone(vector.testVector.claims);
export const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
export function signingWorld() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const kid = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("base64url").slice(0, 16);
  const published: PublicSigningJwk = { kty: "RSA", n: jwk.n!, e: jwk.e!, alg: "RS256", use: "sig", kid };
  let signs = 0;
  const signer: TokenSigner = { publicJwk: async () => published, sign: async input => { signs++; return sign("RSA-SHA256", input, privateKey); } };
  const signed = async (claims: unknown, header: unknown = { alg: "RS256", typ: "rovara-task+jwt", kid }) => {
    const input = `${b64(header)}.${b64(claims)}`;
    return `${input}.${(await signer.sign(Buffer.from(input))).toString("base64url")}`;
  };
  // A separate reference verifier: protocol literals and the shared JSON, not the mint's helpers.
  const reference = (token: string, now = 1800000000): TaskTokenClaims | undefined => {
    try {
      const parts = token.split("."); if (parts.length !== 3) return undefined;
      const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString()) as Record<string, unknown>;
      if (Object.keys(header).sort().join() !== "alg,kid,typ" || header.alg !== "RS256" || header.typ !== "rovara-task+jwt" || header.kid !== kid) return undefined;
      const c = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as TaskTokenClaims;
      if (c.iss !== "https://install-a.example/v1/auth" || c.aud !== "rovara-model-gateway") return undefined;
      if (Object.keys(c).some(k => !vector.claims.some(f => f.name === k)) || vector.claims.some(f => f.required && !(f.name in c))) return undefined;
      if (![c.iat, c.nbf, c.exp].every(Number.isSafeInteger) || c.exp - c.iat > 900 || c.exp <= c.iat || c.exp < now - 30 || c.nbf > now + 30) return undefined;
      if (typeof c.cid !== "string" || !/^org_[0-9a-z]{20}$/u.test(c.cid) || !Array.isArray(c.mdl) || c.mdl.length < 1 || c.mdl.length > 16) return undefined;
      const input = `${parts[0]}.${parts[1]}`;
      if (Buffer.byteLength(input) > 3500 || !verify("RSA-SHA256", Buffer.from(input), publicKey, Buffer.from(parts[2]!, "base64url"))) return undefined;
      return c;
    } catch { return undefined; }
  };
  return { signer, signed, reference, published, signs: () => signs };
}
