// Script tokens (UX5b): what a token looks like, how one is made and how it is checked. A token is `rvst_<company id body>_<token id body>_<secret>`: the two ids say where its record is
// (so a token is looked up in its own company only), the secret is 32 random bytes (base64url). Only the SHA-256 of the whole token is stored; the secret's 256 bits make a slow hash
// unnecessary. The token is compared in constant time and never logged, stored or echoed.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { OrgIdSchema, SCRIPT_TOKEN_PREFIX, ScriptTokenIdSchema, type OrgId } from "@rovara-code/contracts";

const TOKEN = /^rvst_([0-9a-z]{20})_([0-9a-z]{20})_([A-Za-z0-9_-]{43})$/u;
/** The longest Authorization header value looked at: anything longer is not a script token. */
const HEADER_MAX = 200;

export interface ParsedScriptToken { orgId: OrgId; tokenId: string; token: string }

/** A new token for a token id in a company: the token (shown once) and its hash (stored). */
export function mintScriptToken(orgId: OrgId, tokenId: string, random: (size: number) => Buffer = randomBytes): { token: string; hash: string } {
  const token = `${SCRIPT_TOKEN_PREFIX}${orgId.slice(4)}_${tokenId.slice(4)}_${random(32).toString("base64url")}`;
  if (!TOKEN.test(token)) throw new Error("a minted script token has the wrong shape");
  return { token, hash: hashScriptToken(token) };
}

export const hashScriptToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

/** Whether an Authorization header carries a script token at all (`Bearer rvst_…`). Says nothing about whether the token is good. */
export function isScriptTokenHeader(authorization: string | undefined): boolean {
  return typeof authorization === "string" && authorization.startsWith(`Bearer ${SCRIPT_TOKEN_PREFIX}`);
}

/** The token in an Authorization header, or undefined when the header is not a well-formed script token. */
export function parseScriptTokenHeader(authorization: string | undefined): ParsedScriptToken | undefined {
  if (!isScriptTokenHeader(authorization) || authorization!.length > HEADER_MAX) return undefined;
  const token = authorization!.slice("Bearer ".length);
  const match = TOKEN.exec(token);
  if (match === null) return undefined;
  const orgId = OrgIdSchema.safeParse(`org_${match[1]!}`);
  const tokenId = ScriptTokenIdSchema.safeParse(`stk_${match[2]!}`);
  if (!orgId.success || !tokenId.success) return undefined;
  return { orgId: orgId.data, tokenId: tokenId.data, token };
}

/** Whether a token matches a stored hash, in constant time. A stored value that is not a SHA-256 hex never matches. */
export function scriptTokenMatches(token: string, storedHash: unknown): boolean {
  if (typeof storedHash !== "string" || !/^[0-9a-f]{64}$/u.test(storedHash)) return false;
  return timingSafeEqual(Buffer.from(hashScriptToken(token), "hex"), Buffer.from(storedHash, "hex"));
}

/** What the settings screen shows of a token: the prefix and the first eight characters of its id, which are not secret. */
export const scriptTokenHint = (tokenId: string): string => `${SCRIPT_TOKEN_PREFIX}…${tokenId.slice(4, 12)}`;

