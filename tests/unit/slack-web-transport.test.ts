// Spec 062 FR-042: each package calls the Slack Web API through one module, with the token only in the header.
import { describe, expect, it, vi } from "vitest";
import { slackWebFetch } from "../../packages/core/src/aws/slack-web.js";
import { SlackApiError, createSlackWebClient } from "../../packages/slack-service/src/slack-web.js";

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("the broker's Slack transport", () => {
  it("posts JSON with the token in the header only, and reads with a query", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => answer({ ok: true }));
    await slackWebFetch("chat.postMessage", "xoxb-secret", { body: { channel: "C0123", text: "hi" }, redirect: "error" }, fetchFn);
    await slackWebFetch("users.info", "xoxb-secret", { query: { user: "U0123" } }, fetchFn);
    const [post, get] = fetchFn.mock.calls;
    expect(post).toEqual(["https://slack.com/api/chat.postMessage", {
      method: "POST", redirect: "error",
      headers: { authorization: "Bearer xoxb-secret", "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: "C0123", text: "hi" }),
    }]);
    expect(get).toEqual(["https://slack.com/api/users.info?user=U0123", { headers: { authorization: "Bearer xoxb-secret" } }]);
    expect(JSON.stringify(post?.[0]) + JSON.stringify(get?.[0])).not.toContain("xoxb");
  });
});

describe("the orchestrator service's Slack client", () => {
  it("posts in a thread without unfurling, answers the timestamp, and names Slack's error without the token", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => answer({ ok: true, ts: "1700000000.000100" }));
    const slack = createSlackWebClient({ token: async () => "xoxb-secret", fetch: fetchFn });
    expect(await slack.postMessage("C0123", "1695500000.000001", "hi", { blocks: [{ type: "divider" }] })).toBe("1700000000.000100");
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(JSON.parse(init?.body as string)).toEqual({ channel: "C0123", thread_ts: "1695500000.000001", text: "hi", unfurl_links: false, blocks: [{ type: "divider" }] });

    const failing = createSlackWebClient({ token: async () => "xoxb-secret", fetch: vi.fn<typeof fetch>(async () => answer({ ok: false, error: "channel_not_found" })) });
    const error = await failing.update("C0123", "1.2", "x").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SlackApiError);
    expect(error).toMatchObject({ method: "chat.update", code: "channel_not_found" });
    expect(String(error)).not.toContain("xoxb");
  });
});
