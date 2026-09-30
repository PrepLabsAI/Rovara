// Spec 025 FR-034, E13: the Slack Web API calls the notifier makes. The token goes only in the
// Authorization header; an error carries Slack's error code (lowercase letters and _) or the HTTP
// status, never the token or the request body.
export class SlackPostError extends Error {
  constructor(readonly slackError: string, method = "chat.postMessage") {
    super(`Slack ${method} failed: ${slackError}`);
    this.name = "SlackPostError";
  }
}

/** One Web API call; `complete` says whether a successful answer has what the caller needs. */
async function callSlack(method: string, botToken: string, body: Record<string, unknown>, fetchImplementation: typeof fetch, complete: (result: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown>> {
  const response = await fetchImplementation(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  let result: Record<string, unknown> = {};
  try {
    result = await response.json() as Record<string, unknown>;
  } catch {
    // An unreadable answer is reported by its HTTP status below.
  }
  if (!response.ok || result.ok !== true || !complete(result)) {
    const code = typeof result.error === "string" && /^[a-z_]{1,64}$/.test(result.error) ? result.error : `http_${response.status}`;
    throw new SlackPostError(code, method);
  }
  return result;
}

export async function chatPostMessage(
  botToken: string,
  input: { channel: string; threadTs?: string | undefined; text: string; blocks?: unknown[] | undefined },
  fetchImplementation: typeof fetch = fetch,
): Promise<{ ts: string; channel?: string }> {
  const result = await callSlack("chat.postMessage", botToken, {
    channel: input.channel, text: input.text, unfurl_links: false, unfurl_media: false,
    ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
    ...(input.blocks === undefined ? {} : { blocks: input.blocks }),
  }, fetchImplementation, (answer) => typeof answer.ts === "string");
  // A post to a user ID lands in the bot's direct message with them, whose ID Slack answers (E13).
  return { ts: result.ts as string, ...(typeof result.channel === "string" ? { channel: result.channel } : {}) };
}

/** Spec 025 E13: edits a message the bot posted. Errors carry Slack's code only, as chatPostMessage's do. */
export async function chatUpdate(
  botToken: string,
  input: { channel: string; ts: string; text: string; blocks: unknown[] },
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  await callSlack("chat.update", botToken, { channel: input.channel, ts: input.ts, text: input.text, blocks: input.blocks }, fetchImplementation);
}
