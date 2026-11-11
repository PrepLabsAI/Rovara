// The chat tool's web API, as far as the channel adapter needs it: who the bot is, post a message, post one only a person sees, and open a socket connection. Every call goes to the tool's own host over https with a
// token read when the call is made (so a rotation takes effect at once). An error names the tool's error code and nothing else: never a token, never the text that was sent.
const API = "https://slack.com/api/";
const TIMEOUT_MS = 10_000;

/** A call the tool refused or could not answer. `code` is the tool's own error code (`channel_not_found`, `ratelimited`, `http_500`) or a fixed word. */
export class SlackApiError extends Error {
  constructor(readonly code: string, readonly retryAfterSeconds?: number) {
    super(`slack: ${code}`);
    this.name = "SlackApiError";
  }
}

export interface SlackWebOptions {
  /** The bot token, read on each call. */
  botToken: () => Promise<string>;
  /** The app-level token for the socket connection, read on each connect. Absent: no socket (the adapter only sends). */
  appToken?: (() => Promise<string>) | undefined;
  fetch?: typeof fetch | undefined;
}

export interface SlackPost {
  channel: string;
  threadTs?: string | undefined;
  text: string;
  blocks?: readonly unknown[] | undefined;
}

export interface SlackWeb {
  authTest(): Promise<{ teamId: string; botUserId: string }>;
  postMessage(post: SlackPost): Promise<{ ts: string }>;
  postEphemeral(post: SlackPost & { user: string }): Promise<void>;
  /** The address of a socket connection for the app-level token. */
  openConnection(): Promise<string>;
}

export const BOT_TOKEN_SHAPE = /^xoxb-[A-Za-z0-9-]{10,200}$/u;
export const APP_TOKEN_SHAPE = /^xapp-[A-Za-z0-9-]{10,300}$/u;

export function slackWeb(options: SlackWebOptions): SlackWeb {
  const request = options.fetch ?? fetch;

  async function call(method: string, token: string, body: Record<string, unknown>, form = false): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await request(`${API}${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8" },
        body: form ? new URLSearchParams(Object.entries(body).map(([key, value]): [string, string] => [key, String(value)])).toString() : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      });
    } catch {
      throw new SlackApiError("unreachable");
    }
    if (response.status === 429) {
      const wait = Number(response.headers.get("retry-after"));
      throw new SlackApiError("ratelimited", Number.isFinite(wait) && wait > 0 ? Math.min(wait, 3_600) : undefined);
    }
    if (!response.ok) throw new SlackApiError(`http_${String(response.status)}`);
    const value: unknown = await response.json().catch(() => undefined);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SlackApiError("bad_answer");
    const answer = value as Record<string, unknown>;
    if (answer["ok"] !== true) throw new SlackApiError(typeof answer["error"] === "string" && /^[a-z0-9_]{1,64}$/u.test(answer["error"]) ? answer["error"] : "refused");
    return answer;
  }

  const bot = async (): Promise<string> => {
    const token = await options.botToken();
    if (!BOT_TOKEN_SHAPE.test(token)) throw new SlackApiError("bad_bot_token");
    return token;
  };
  const postBody = (post: SlackPost): Record<string, unknown> => ({
    channel: post.channel, text: post.text, ...(post.blocks === undefined ? {} : { blocks: post.blocks }), ...(post.threadTs === undefined ? {} : { thread_ts: post.threadTs }),
    // No previews of what a task title or a link says, and no mention is ever made by a name in the text.
    unfurl_links: false, unfurl_media: false, link_names: false, parse: "none",
  });

  return {
    async authTest() {
      const answer = await call("auth.test", await bot(), {});
      const teamId = answer["team_id"], botUserId = answer["user_id"];
      if (typeof teamId !== "string" || typeof botUserId !== "string") throw new SlackApiError("bad_answer");
      return { teamId, botUserId };
    },
    async postMessage(post) {
      const answer = await call("chat.postMessage", await bot(), postBody(post));
      const ts = answer["ts"];
      if (typeof ts !== "string") throw new SlackApiError("bad_answer");
      return { ts };
    },
    async postEphemeral(post) {
      await call("chat.postEphemeral", await bot(), { ...postBody(post), user: post.user });
    },
    async openConnection() {
      if (options.appToken === undefined) throw new SlackApiError("no_app_token");
      const token = await options.appToken();
      if (!APP_TOKEN_SHAPE.test(token)) throw new SlackApiError("bad_app_token");
      const url = (await call("apps.connections.open", token, {}, true))["url"];
      // The tool's own socket host only: an address that is not wss, or names another host, is not followed.
      if (typeof url !== "string" || !/^wss:\/\/[a-z0-9.-]+\.slack\.com\//u.test(url) || url.length > 2_048) throw new SlackApiError("bad_answer");
      return url;
    },
  };
}
