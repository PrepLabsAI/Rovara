import { describe, expect, it, vi } from "vitest";
import { bindSlackChannel, unbindSlackChannel } from "../../packages/cli/src/admin/slack.js";

function fakeFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

const input = {
  controlPlaneUrl: "https://agentx.example.test/",
  accessToken: "token",
  teamId: "T0BSHLLUGBD",
  channelId: "C0123456789",
};

describe("administrator Slack channel binding client", () => {
  it("binds a channel to the configured project without naming a revision", async () => {
    const fetchImplementation = fakeFetch(200, { binding: { projectName: "payments" }, latestRevision: 3 });
    await bindSlackChannel({ ...input, projectName: "payments" }, fetchImplementation);
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(url).toBe("https://agentx.example.test/v1/admin/slack/bindings/T0BSHLLUGBD/C0123456789");
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toMatchObject({ authorization: "Bearer token", "content-type": "application/json" });
    expect(JSON.parse(init?.body as string)).toEqual({ projectName: "payments" });
  });

  it("unbinds a channel and surfaces the control plane's error message", async () => {
    const removed = fakeFetch(200, { deleted: true });
    await unbindSlackChannel(input, removed);
    expect(removed.mock.calls[0]?.[1]?.method).toBe("DELETE");

    const denied = fakeFetch(403, { error: { code: "FORBIDDEN", message: "administrator claim is required" } });
    await expect(unbindSlackChannel(input, denied)).rejects.toThrow(/unbinding failed: administrator claim is required/);
  });

  it("surfaces a clean HTTP status when the control plane returns a non-JSON error body", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } }));
    await expect(unbindSlackChannel(input, fetchImplementation)).rejects.toThrow(/unbinding failed: HTTP 502/);
  });

  it("rejects direct-message channels and malformed IDs before calling the control plane", async () => {
    const fetchImplementation = fakeFetch(200, {});
    await expect(unbindSlackChannel({ ...input, channelId: "D0123456789" }, fetchImplementation)).rejects.toThrow();
    await expect(unbindSlackChannel({ ...input, teamId: "team" }, fetchImplementation)).rejects.toThrow();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
