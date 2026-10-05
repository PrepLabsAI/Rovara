import { describe, expect, it, vi } from "vitest";
import { createTaskPlanCanvas } from "../../packages/broker/src/aws/slack-web.js";

const CHANNEL = "C12345678";

describe("task plan Slack Canvas", () => {
  it("creates a task detail Canvas, shares it read-only to the channel, then resolves its link", async () => {
    const calls: Array<{ url: string; method: string; body?: string; authorization: string }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: init.body } : {}), authorization: new Headers(init?.headers).get("authorization") ?? "" });
      if (url.endsWith("/canvases.create")) return Response.json({ ok: true, canvas_id: "F12345678" });
      if (url.endsWith("/canvases.access.set")) return Response.json({ ok: true });
      if (url.startsWith("https://slack.com/api/files.info?")) return Response.json({ ok: true, file: { permalink: "https://acme.slack.com/docs/T123/F12345678" } });
      return Response.json({ ok: false, error: "unexpected_method" });
    });

    await expect(createTaskPlanCanvas("xoxb-test", {
      channel: CHANNEL, taskId: "task-123", title: "Password reset", version: 2, markdown: "# What will change\nAdd password reset.",
    }, fetcher)).resolves.toEqual({ canvasId: "F12345678", permalink: "https://acme.slack.com/docs/T123/F12345678" });

    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST", "GET"]);
    expect(JSON.parse(calls[0]!.body ?? "")).toMatchObject({
      title: "Plan: Password reset (v2)",
      document_content: { type: "markdown", markdown: "# What will change\nAdd password reset." },
    });
    expect(JSON.parse(calls[1]!.body ?? "")).toMatchObject({ canvas_id: "F12345678", access_level: "read", channel_ids: [CHANNEL] });
    expect(calls[2]!.url).toContain("file=F12345678");
    expect(calls.every((call) => call.authorization === "Bearer xoxb-test")).toBe(true);
  });

  it("refuses a non-Slack permalink rather than placing it in a workflow message", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/canvases.create")) return Response.json({ ok: true, canvas_id: "F12345678" });
      if (url.endsWith("/canvases.access.set")) return Response.json({ ok: true });
      return Response.json({ ok: true, file: { permalink: "https://attacker.example/plan" } });
    });
    await expect(createTaskPlanCanvas("xoxb-test", { channel: CHANNEL, taskId: "task-123", title: "Plan", version: 1, markdown: "# Plan" }, fetcher))
      .rejects.toThrow("Slack files.info returned an invalid Canvas link");
  });
});
