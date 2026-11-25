import { createHash } from "node:crypto";

/**
 * What a log line says about a sign-in session instead of its id. A session id is a bearer credential for a browser
 * sign-in (the cookie value is the id), so it never goes into a log. This is the first 12 hex characters of its SHA-256:
 * stable, so lines about one session still join up, and not reversible.
 */
export function sessionLogId(sessionId: string): string {
  return createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, 12);
}
