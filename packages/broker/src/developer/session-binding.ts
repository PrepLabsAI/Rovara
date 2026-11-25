// packages/broker/src/developer/session-binding.ts
// What a short-lived state row (an install, connect or link state, a sign-in link) keeps to remember WHICH sign-in session started it. The session id is the browser's login cookie, so the
// row never holds it: it holds this digest, and the spend compares the presenting caller's digest. The digest is full length (it is compared, unlike the 12-hex log id) and domain-separated
// (so it is neither the log id's prefix nor any other sha256 of the id). A row written before this existed has no digest (its field is named differently), so it never matches: the flow
// answers its existing "start again" / expired words once.
import { createHash, timingSafeEqual } from "node:crypto";

/** The digest a row stores for a sign-in session: sha256 of a fixed label and the id, as 64 lowercase hex. */
export function sessionBindingOf(sessionId: string): string {
  return createHash("sha256").update(`rovara:session-binding:v1:${sessionId}`, "utf8").digest("hex");
}

/** The stored digest field: exactly the shape `sessionBindingOf` writes. */
export const SESSION_BINDING_PATTERN = /^[a-f0-9]{64}$/;

/** Whether a stored digest is the presenting session's, in constant time. Anything that is not a 64-hex digest (a missing field, an old raw id) is no match. */
export function sameSessionBinding(stored: unknown, presenting: string): boolean {
  if (typeof stored !== "string" || !SESSION_BINDING_PATTERN.test(stored) || !SESSION_BINDING_PATTERN.test(presenting)) return false;
  return timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(presenting, "hex"));
}
