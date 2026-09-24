import { describe, expect, it, vi } from "vitest";
import { createSlackUserNames } from "../../packages/slack-service/src/user-names.js";

describe("Slack display-name lookup", () => {
  it("bounds the lookup, keeps names for an hour and retries failures after five minutes", async () => {
    let now = 0;
    let ok = false;
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(ok ? { ok: true, user: { profile: { display_name: "Pratik" } } } : { ok: false, error: "missing_scope" }));
    const lookup = createSlackUserNames({ token: async () => "xoxb-test", fetch: fetchFn, now: () => now });
    expect(await lookup("U1")).toBeUndefined();
    expect(fetchFn.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    ok = true;
    now = 4 * 60 * 1_000;
    expect(await lookup("U1")).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now = 5 * 60 * 1_000 + 1;
    expect(await lookup("U1")).toBe("Pratik");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    now += 59 * 60 * 1_000;
    expect(await lookup("U1")).toBe("Pratik");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    now += 2 * 60 * 1_000;
    await lookup("U1");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("returns undefined when the lookup throws or times out", async () => {
    const lookup = createSlackUserNames({ token: async () => "xoxb-test", fetch: async () => { throw new DOMException("timed out", "TimeoutError"); } });
    expect(await lookup("U1")).toBeUndefined();
  });
});
