import { describe, expect, it, vi } from "vitest";
import { createTaskPlanCanvas, deleteTaskPlanCanvas } from "../../packages/broker/src/aws/slack-web.js";

const CHANNEL = "C12345678";

describe("task plan Slack Canvas", () => {
  it("creates a task detail Canvas, shares it read-only to the channel, then resolves its link", async () => {
    const calls: Array<{ url: string; method: string; body?: string; authorization: string }> = [];
    const fetcher = vi.fn(async (input: unknown, init?: RequestInit) => {
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
    const fetcher = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/canvases.create")) return Response.json({ ok: true, canvas_id: "F12345678" });
      if (url.endsWith("/canvases.access.set")) return Response.json({ ok: true });
      return Response.json({ ok: true, file: { permalink: "https://attacker.example/plan" } });
    });
    await expect(createTaskPlanCanvas("xoxb-test", { channel: CHANNEL, taskId: "task-123", title: "Plan", version: 1, markdown: "# Plan" }, fetcher))
      .rejects.toThrow("Slack files.info returned an invalid Canvas link");
  });

  it("persists the exact Canvas ID immediately after Slack creates it", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url.split("/").at(-1) ?? "");
      if (url.endsWith("/canvases.create")) return Response.json({ ok: true, canvas_id: "F12345678" });
      if (url.endsWith("/canvases.access.set")) return Response.json({ ok: true });
      return Response.json({ ok: true, file: { permalink: "https://acme.slack.com/docs/T123/F12345678" } });
    });
    const saved: string[] = [];
    await createTaskPlanCanvas("xoxb-test", { channel: CHANNEL, taskId: "task-123", title: "Plan", version: 1, markdown: "# Plan" }, fetcher,
      async (canvasId) => { saved.push(canvasId); });
    expect(saved).toEqual(["F12345678"]);
    expect(calls).toEqual(["canvases.create", "canvases.access.set", "files.info?file=F12345678"]);
  });

  it("deletes only a validated exact Canvas ID and treats canvas_not_found as ambiguous", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    let error: string | undefined;
    const fetcher = vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      return Response.json(error === undefined ? { ok: true } : { ok: false, error });
    });
    await expect(deleteTaskPlanCanvas("xoxb-test", "F12345678", fetcher)).resolves.toBe("deleted");
    expect(JSON.parse(calls[0]!.body ?? "")).toEqual({ canvas_id: "F12345678" });
    error = "canvas_not_found";
    await expect(deleteTaskPlanCanvas("xoxb-test", "F12345678", fetcher)).resolves.toBe("unknown");
    error = "missing_scope";
    await expect(deleteTaskPlanCanvas("xoxb-test", "F12345678", fetcher)).rejects.toMatchObject({ slackError: "missing_scope" });
    const callCount = calls.length;
    await expect(deleteTaskPlanCanvas("xoxb-test", "not-a-canvas", fetcher)).rejects.toThrow();
    expect(calls).toHaveLength(callCount);
  });
});
