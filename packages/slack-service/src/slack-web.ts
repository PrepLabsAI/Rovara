/**
 * Spec 062 FR-042: every Slack Web API call the orchestrator service makes. The token goes only in the Authorization
 * header; an error names the method and Slack's error code or the HTTP status, never the token or the request body.
 */
export class SlackApiError extends Error {
  constructor(readonly method: string, readonly code: string) {
    super(`Slack ${method} failed: ${code}`);
  }
}

export interface SlackWebClient {
  /** Posts in a thread, or with no thread a new message in the channel; answers the message's timestamp. */
  postMessage(channel: string, threadTs: string | undefined, text: string, options?: { blocks?: unknown[]; signal?: AbortSignal }): Promise<string | undefined>;
  /** A message only `user` sees, in the thread. */
  postEphemeral(channel: string, threadTs: string, user: string, text: string): Promise<void>;
  /** Edits the bot's own message. */
  update(channel: string, ts: string, text: string): Promise<void>;
  /** Removes the bot's own message. */
  delete(channel: string, ts: string): Promise<void>;
  /** A member's profile, for their display name; needs the optional users:read scope. */
  userInfo(userId: string, signal: AbortSignal): Promise<{ name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } | undefined>;
}

export function createSlackWebClient(options: { token: () => Promise<string>; fetch?: typeof fetch }): SlackWebClient {
  const fetchFn = options.fetch ?? fetch;
  const post = async (method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ ts?: string }> => {
    const response = await fetchFn(`https://slack.com/api/${method}`, {
      method: "POST",
      ...(signal === undefined ? {} : { signal }),
      headers: { authorization: `Bearer ${await options.token()}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    const result = await response.json() as { ok?: boolean; error?: string; ts?: string };
    if (!response.ok || result.ok !== true) throw new SlackApiError(method, result.error ?? `HTTP ${response.status}`);
    return result;
  };
  return {
    async postMessage(channel, threadTs, text, extra = {}) {
      const result = await post("chat.postMessage", {
        channel, ...(threadTs === undefined ? {} : { thread_ts: threadTs }), text, unfurl_links: false, ...(extra.blocks === undefined ? {} : { blocks: extra.blocks }),
      }, extra.signal);
      return result.ts;
    },
    async postEphemeral(channel, threadTs, user, text) {
      await post("chat.postEphemeral", { channel, thread_ts: threadTs, user, text }, AbortSignal.timeout(10_000));
    },
    // An edit that Slack does not answer is given up, never left waiting.
    async update(channel, ts, text) {
      await post("chat.update", { channel, ts, text }, AbortSignal.timeout(10_000));
    },
    async delete(channel, ts) {
      await post("chat.delete", { channel, ts });
    },
    async userInfo(userId, signal) {
      const response = await fetchFn(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
        headers: { authorization: `Bearer ${await options.token()}` },
        signal,
      });
      const body = await response.json() as { ok?: boolean; user?: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } };
      return body.ok === true ? body.user : undefined;
    },
  };
}
