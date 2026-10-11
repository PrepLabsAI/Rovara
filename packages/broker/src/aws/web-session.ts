// The pieces AgentX's signed-in browser pages share: the review session cookie, private no-store headers, HTML
// escaping and the sign-in redirect. The read-only task page uses them.

export const SESSION_COOKIE = "__Host-agentx_review_session";
export const CSRF_COOKIE = "__Host-agentx_review_csrf";
export const SESSION_MAX_AGE_SECONDS = 15 * 60;

export const PRIVATE_HEADERS: Record<string, string> = {
  "cache-control": "private, no-store, max-age=0",
  pragma: "no-cache",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; style-src 'nonce-{nonce}'; script-src 'nonce-{nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

export interface WebResponse { statusCode: number; headers: Record<string, string>; body: string }

/** A private response: HTML for a string body, JSON otherwise; `{nonce}` in the policy becomes this page's nonce. */
export function safeResponse(statusCode: number, body: unknown, nonce = ""): WebResponse {
  return {
    statusCode,
    headers: {
      ...PRIVATE_HEADERS,
      "content-type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
      "content-security-policy": PRIVATE_HEADERS["content-security-policy"]!.replaceAll("{nonce}", nonce),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
export const safeText = (value: unknown, fallback = ""): string =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : fallback;
/** Text made safe for an HTML element or a quoted attribute; anything that is not a string, number or boolean is empty. */
export function escapeHtml(value: unknown): string {
  return safeText(value).replace(/[&<>"']/g, (character) => entities[character] ?? character);
}

/** A GitHub link only when it is plain https on github.com with no credentials in it. */
export function canonicalGithubUrl(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  try {
    const url = new URL(input);
    return url.protocol === "https:" && url.hostname === "github.com" && url.username === "" && url.password === "" ? url.toString() : undefined;
  } catch { return undefined; }
}

export function parseCookie(headers: Record<string, string | undefined>, name: string): string | undefined {
  for (const part of (headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

/** Browser sign-in, then back to this same-origin page. */
export function signInLocation(returnPath: string): string {
  return `/v1/auth/browser/authorize?return_to=${encodeURIComponent(returnPath)}`;
}

/** Session callback response helper. The ID is a random, revocable DeveloperIdentity session ID. */
export function reviewSessionCookie(sessionId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error("invalid review session ID");
  return `${SESSION_COOKIE}=${sessionId}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

export function reviewSessionCookieName(): string { return SESSION_COOKIE; }
