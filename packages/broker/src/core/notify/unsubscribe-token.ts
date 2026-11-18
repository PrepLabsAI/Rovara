// The signed link of an attention email that stops these emails (web task channel C8). The token names one company and one person and is signed with a key derived from the install's callback signing key,
// for this purpose alone; it is a proof of which person the email was sent to, nothing more. Acting on it still takes that person's own sign-in (core-host/inbox-routes.ts).
import { createHmac, timingSafeEqual } from "node:crypto";

/** How long a signed unsubscribe link stays good. */
export const UNSUBSCRIBE_LINK_DAYS = 90;

/** The key that signs unsubscribe links: derived from the callback signing key, for this purpose alone. */
export const unsubscribeKeyOf = (callbackSigningKey: string | Buffer): Buffer => createHmac("sha256", callbackSigningKey).update("attention-email-unsubscribe-v1").digest();

const sign = (key: Buffer, body: string): string => createHmac("sha256", key).update(body).digest("base64url");

/** A link token for one person in one company: `v1.<body>.<signature>`, the body being the company, the person and the expiry. */
export function mintUnsubscribeToken(key: Buffer, input: { orgId: string; developerId: string; nowMs: number }): string {
  const body = Buffer.from(JSON.stringify([input.orgId, input.developerId, input.nowMs + UNSUBSCRIBE_LINK_DAYS * 86_400_000]), "utf8").toString("base64url");
  return `v1.${body}.${sign(key, `v1.${body}`)}`;
}

/** The company and person a token names, or undefined for anything that is not a token this install signed (wrong shape, wrong signature, expired). */
export function verifyUnsubscribeToken(key: Buffer, token: unknown, nowMs: number): { orgId: string; developerId: string } | undefined {
  if (typeof token !== "string" || token.length > 600) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return undefined;
  const expected = Buffer.from(sign(key, `v1.${parts[1]!}`));
  const given = Buffer.from(parts[2]!);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  try {
    const value = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(value) || value.length !== 3 || typeof value[0] !== "string" || typeof value[1] !== "string" || typeof value[2] !== "number") return undefined;
    if (!/^org_[0-9a-z]{20}$/u.test(value[0]) || !/^[a-f0-9]{64}$/u.test(value[1]) || !(value[2] > nowMs)) return undefined;
    return { orgId: value[0], developerId: value[1] };
  } catch {
    return undefined;
  }
}

