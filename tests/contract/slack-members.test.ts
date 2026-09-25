import { describe, expect, it, vi } from "vitest";
import { createSlackMemberCheck } from "../../packages/broker/src/aws/slack-members.js";

const human = { id: "U0123456789", is_bot: false, deleted: false };

function check(responses: unknown[], now: () => number = () => 0) {
  const fetchFn = vi.fn<typeof fetch>(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return Response.json(next);
  });
  return { fetchFn, lookup: createSlackMemberCheck({ token: async () => "xoxb-test", fetch: fetchFn, now }) };
}

describe("Slack member check", () => {
  it("asks users.info with the bot token and a bounded wait", async () => {
    const { fetchFn, lookup } = check([{ ok: true, user: human }]);
    expect(await lookup("U0123456789")).toEqual({ outcome: "person" });
    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://slack.com/api/users.info?user=U0123456789");
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toEqual({ authorization: "Bearer xoxb-test" });
    expect(fetchFn.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["a bot user", { ...human, is_bot: true }],
    ["a deactivated user", { ...human, deleted: true }],
    ["a profile with no is_bot field", { id: "U0123456789" }],
    ["a string \"false\" for is_bot", { ...human, is_bot: "false" }],
  ])("does not treat %s as a person", async (_name, user) => {
    const { lookup } = check([{ ok: true, user }]);
    expect(await lookup("U0123456789")).toEqual({ outcome: "not_person" });
  });

  it("treats a person who authorized an app (is_app_user) as a person", async () => {
    const { lookup } = check([{ ok: true, user: { ...human, is_app_user: true } }]);
    expect(await lookup("U0123456789")).toEqual({ outcome: "person" });
  });

  it("does not treat Slackbot as a person, although Slack reports is_bot false for it", async () => {
    const { lookup } = check([{ ok: true, user: { id: "USLACKBOT", is_bot: false, deleted: false } }]);
    expect(await lookup("USLACKBOT")).toEqual({ outcome: "not_person" });
  });

  it.each([
    ["a missing scope", [{ ok: false, error: "missing_scope" }], "missing_scope"],
    ["an unknown user", [{ ok: false, error: "user_not_found" }], "user_not_found"],
    ["a profile for another user", [{ ok: true, user: { ...human, id: "U0999999999" } }], "unexpected_response"],
    ["a network failure", [new TypeError("fetch failed")], "request_failed"],
    ["a timeout", [new DOMException("timed out", "TimeoutError")], "timeout"],
    ["a rate limit", [{ ok: false, error: "ratelimited" }], "ratelimited"],
    ["a null response body", [null], "unexpected_response"],
    ["a non-object response body", [5], "unexpected_response"],
  ])("fails closed on %s and asks again next time", async (_name, responses, error) => {
    const { fetchFn, lookup } = check([...responses, { ok: true, user: human }]);
    expect(await lookup("U0123456789")).toEqual({ outcome: "failed", error });
    expect(await lookup("U0123456789")).toEqual({ outcome: "person" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("keeps an answer for an hour", async () => {
    let now = 0;
    const { fetchFn, lookup } = check([{ ok: true, user: human }, { ok: true, user: { ...human, deleted: true } }], () => now);
    await lookup("U0123456789");
    now = 59 * 60 * 1_000;
    expect(await lookup("U0123456789")).toEqual({ outcome: "person" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now = 60 * 60 * 1_000;
    expect(await lookup("U0123456789")).toEqual({ outcome: "not_person" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("caps the cache at 5,000 entries and evicts the oldest once full", async () => {
    const CAP = 5_000;
    const responses: unknown[] = [];
    for (let i = 0; i <= CAP; i++) {
      responses.push({ ok: true, user: { id: `U${i}`, is_bot: false, deleted: false } });
    }
    // A re-fetch for the oldest entry, expected to have been evicted.
    responses.push({ ok: true, user: { id: "U0", is_bot: false, deleted: false } });
    const { fetchFn, lookup } = check(responses);

    for (let i = 0; i <= CAP; i++) {
      await lookup(`U${i}`);
    }
    expect(fetchFn).toHaveBeenCalledTimes(CAP + 1);

    // The entry inserted right after the oldest is still cached: the cache stayed at (not
    // below) the cap, so only the single oldest entry was evicted, not the whole cache.
    expect(await lookup("U1")).toEqual({ outcome: "person" });
    expect(fetchFn).toHaveBeenCalledTimes(CAP + 1);

    // The oldest entry (U0) was evicted to keep the cache at the cap: looking it up again
    // requires a fresh fetch.
    expect(await lookup("U0")).toEqual({ outcome: "person" });
    expect(fetchFn).toHaveBeenCalledTimes(CAP + 2);
  });

  it("never returns the token in a failure", async () => {
    const { lookup } = check([{ ok: false, error: "invalid_auth" }]);
    expect(JSON.stringify(await lookup("U0123456789"))).not.toContain("xoxb");
  });

  it("bounds the whole lookup, including a slow token source, to the 1.5 s deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn<typeof fetch>();
      const lookup = createSlackMemberCheck({
        token: () => new Promise<string>(() => undefined), // never resolves
        fetch: fetchFn,
      });
      const pending = lookup("U0123456789");
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await pending).toEqual({ outcome: "failed", error: "timeout" });
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
