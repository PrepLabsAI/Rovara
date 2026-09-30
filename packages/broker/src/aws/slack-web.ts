// Spec 025 FR-034: the one Slack Web API call the notifier makes. The token goes only in the
// Authorization header; an error carries Slack's error code (lowercase letters and _) or the HTTP
// status, never the token or the request body.
export class SlackPostError extends Error {
  constructor(readonly slackError: string) {
    super(`Slack chat.postMessage failed: ${slackError}`);
    this.name = "SlackPostError";
  }
}

/** Errors from a request that may have reached Slack: it failed before or while Slack answered. */
const unanswered = new WeakSet<object>();

/**
 * 25c note 3: whether a failed post may still have landed. Yes for a request that failed before
 * Slack's answer was read (an abort, a timeout, a lost connection), and for a 2xx or 5xx answer
 * with no readable result. No for Slack's own error code, a 4xx, or anything thrown before the
 * request (such as loading the bot token).
 */
export function postMayHaveLanded(error: unknown): boolean {
  if (error instanceof SlackPostError) return /^http_[25]\d\d$/.test(error.slackError);
  return typeof error === "object" && error !== null && unanswered.has(error);
}

export async function chatPostMessage(
  botToken: string,
  input: { channel: string; threadTs?: string | undefined; text: string },
  fetchImplementation: typeof fetch = fetch,
): Promise<{ ts: string }> {
  const response = await fetchImplementation("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: input.channel, text: input.text, unfurl_links: false, unfurl_media: false, ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }) }),
    signal: AbortSignal.timeout(10_000),
  }).catch((error: unknown) => {
    if (typeof error === "object" && error !== null) unanswered.add(error);
    throw error;
  });
  let result: Record<string, unknown> = {};
  try {
    result = await response.json() as Record<string, unknown>;
  } catch {
    // An unreadable answer is reported by its HTTP status below.
  }
  if (!response.ok || result.ok !== true || typeof result.ts !== "string") {
    const code = typeof result.error === "string" && /^[a-z_]{1,64}$/.test(result.error) ? result.error : `http_${response.status}`;
    throw new SlackPostError(code);
  }
  return { ts: result.ts };
}
