import { describe, expect, it, vi } from "vitest";
import { disableEvalChannel, enableEvalChannel, parseMaxCostUsd, showEvalChannel } from "../../packages/cli/src/admin/eval.js";

const base = { controlPlaneUrl: "https://api.example.com/", accessToken: "token", teamId: "T0BSHLLUGBD", channelId: "C0123456789" };

function fakeFetch(status = 200, body: unknown = { channel: { maxCostUsd: 10 } }) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- typed so the calls' URL and init can be read
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("agentx admin eval (spec 043 FR-002)", () => {
  it("enables a channel with an optional cost ceiling, shows it and disables it", async () => {
    const fetchImplementation = fakeFetch();
    await enableEvalChannel({ ...base, maxCostUsd: 25 }, fetchImplementation as typeof fetch);
    await enableEvalChannel(base, fetchImplementation as typeof fetch);
    await showEvalChannel(base, fetchImplementation as typeof fetch);
    await disableEvalChannel(base, fetchImplementation as typeof fetch);
    const calls = fetchImplementation.mock.calls.map(([url, init]) => [url, init?.method, init?.body]);
    const url = "https://api.example.com/v1/admin/evals/channels/T0BSHLLUGBD/C0123456789";
    expect(calls).toEqual([
      [url, "PUT", "{\"maxCostUsd\":25}"],
      [url, "PUT", "{}"],
      [url, "GET", undefined],
      [url, "DELETE", undefined],
    ]);
    expect(fetchImplementation.mock.calls[0]![1]!.headers).toMatchObject({ authorization: "Bearer token" });
  });

  it("refuses a ceiling outside 1 to 100 before calling, and reports the server's refusal", async () => {
    const fetchImplementation = fakeFetch();
    await expect(enableEvalChannel({ ...base, maxCostUsd: 150 }, fetchImplementation as typeof fetch)).rejects.toThrow();
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(() => parseMaxCostUsd("ten")).toThrow("--max-cost-usd must be a number");
    expect(parseMaxCostUsd("12.5")).toBe(12.5);
    const refusing = fakeFetch(404, { error: { code: "NOT_FOUND", message: "Slack channel binding not found; bind the channel to a project first" } });
    await expect(enableEvalChannel(base, refusing as typeof fetch)).rejects.toThrow("enabling SWE-bench runs failed: Slack channel binding not found");
  });
});
