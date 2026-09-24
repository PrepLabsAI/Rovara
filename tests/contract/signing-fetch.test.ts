import { describe, expect, it, vi } from "vitest";
import { createSignedServiceFetch } from "../../packages/slack-service/src/signing-fetch.js";

const thread = { teamId: "T0123456789", channelId: "C0123456789", threadTs: "1695500000.000001" };
const credentials = { accessKeyId: "test-key", secretAccessKey: "test-secret" };

describe("signed service fetch", () => {
  it("sends the requester's display name percent-encoded and signed, and omits it when unknown", async () => {
    const baseFetch = vi.fn<typeof fetch>(async () => Response.json({}));
    await createSignedServiceFetch({ region: "us-east-1", credentials, thread, userId: "U0123456789", userName: "Zoë Ó\nBrien", baseFetch })("https://agentx.example.test/v1/threads/workspace", { method: "POST", body: "{}" });
    const sent = new Headers(baseFetch.mock.calls[0]?.[1]?.headers);
    expect(sent.get("x-agentx-slack-user-name")).toBe(encodeURIComponent("Zoë Ó Brien"));
    expect(sent.get("authorization")).toContain("x-agentx-slack-user-name");
    await createSignedServiceFetch({ region: "us-east-1", credentials, thread, userId: "U0123456789", baseFetch })("https://agentx.example.test/v1/threads/workspace", { method: "POST", body: "{}" });
    expect(new Headers(baseFetch.mock.calls[1]?.[1]?.headers).has("x-agentx-slack-user-name")).toBe(false);
  });

  it("truncates a display name by characters, never splitting an emoji", async () => {
    const baseFetch = vi.fn<typeof fetch>(async () => Response.json({}));
    const response = await createSignedServiceFetch({ region: "us-east-1", credentials, thread, userId: "U0123456789", userName: "a".repeat(79) + "😀x", baseFetch })("https://agentx.example.test/v1/threads/workspace", { method: "POST", body: "{}" });
    expect(response.ok).toBe(true);
    expect(decodeURIComponent(new Headers(baseFetch.mock.calls[0]?.[1]?.headers).get("x-agentx-slack-user-name")!)).toBe("a".repeat(79) + "😀");
  });

  it("keeps an emoji ZWJ sequence intact while still removing bidi and zero-width format characters", async () => {
    const baseFetch = vi.fn<typeof fetch>(async () => Response.json({}));
    const send = (userName: string) => createSignedServiceFetch({ region: "us-east-1", credentials, thread, userId: "U0123456789", userName, baseFetch })("https://agentx.example.test/v1/threads/workspace", { method: "POST", body: "{}" });
    const sent = () => decodeURIComponent(new Headers(baseFetch.mock.lastCall?.[1]?.headers).get("x-agentx-slack-user-name")!);
    await send("\u{1F468}\u200D\u{1F469}\u200D\u{1F467} Family");
    expect(sent()).toBe("\u{1F468}\u200D\u{1F469}\u200D\u{1F467} Family");
    await send("a\u200Bb\u200Ec\u200Fd\u202Ae\u202Ef\u2066g\u2069h\uFEFFi");
    expect(sent()).toBe("a b c d e f g h i");
  });

  it("removes the Arabic letter mark and the invisible operators but keeps the zero-width non-joiner", async () => {
    const baseFetch = vi.fn<typeof fetch>(async () => Response.json({}));
    await createSignedServiceFetch({ region: "us-east-1", credentials, thread, userId: "U0123456789", userName: "a\u061Cb\u2060c\u2061d\u2064e\u200Cf", baseFetch })("https://agentx.example.test/v1/threads/workspace", { method: "POST", body: "{}" });
    expect(decodeURIComponent(new Headers(baseFetch.mock.lastCall?.[1]?.headers).get("x-agentx-slack-user-name")!)).toBe("a b c d e\u200Cf");
  });

  it("omits the display name instead of failing when it cannot be encoded", async () => {
    const baseFetch = vi.fn<typeof fetch>(async () => Response.json({}));
    const response = await createSignedServiceFetch({ region: "us-east-1", credentials, thread, userId: "U0123456789", userName: "bad\uD800name", baseFetch })("https://agentx.example.test/v1/threads/workspace", { method: "POST", body: "{}" });
    expect(response.ok).toBe(true);
    expect(new Headers(baseFetch.mock.calls[0]?.[1]?.headers).has("x-agentx-slack-user-name")).toBe(false);
  });
});
