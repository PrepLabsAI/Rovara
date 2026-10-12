// Sign in with ChatGPT (#341): the task owner's ChatGPT access token, from the control plane through
// the operation's callback capability. The worker never holds the refresh token; it keeps the access
// token in memory until shortly before it expires, and asks once at a time.
import { agentXError } from "@agentx/contracts";

/** Asked for again this long before the token expires, so no request carries one about to lapse. */
export const CHATGPT_TOKEN_MARGIN_MS = 2 * 60_000;

export type ChatGptTokenFetch = () => Promise<unknown>;

/** The token from the control plane's answer; anything else is refused without echoing it. */
export function parseChatGptToken(body: unknown): { accessToken: string; expiresAt: number } {
  const value = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
  const expiresAt = typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : Number.NaN;
  if (typeof value.accessToken !== "string" || value.accessToken.length === 0 || value.accessToken.length > 16_384 || /\s/u.test(value.accessToken) || !Number.isFinite(expiresAt)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "the control plane answered the ChatGPT token request with something unexpected");
  }
  return { accessToken: value.accessToken, expiresAt };
}

/** The current token, fetched when there is none or it is about to expire; concurrent callers share one fetch. */
export function chatGptTokenSource(fetchToken: ChatGptTokenFetch, now: () => number = Date.now): () => Promise<string> {
  let current: { accessToken: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;
  return async () => {
    if (current !== undefined && current.expiresAt - CHATGPT_TOKEN_MARGIN_MS > now()) return current.accessToken;
    pending ??= (async () => {
      try {
        current = parseChatGptToken(await fetchToken());
        return current.accessToken;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
}
