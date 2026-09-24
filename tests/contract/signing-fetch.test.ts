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
});
