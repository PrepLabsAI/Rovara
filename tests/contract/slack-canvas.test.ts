import { describe, expect, it, vi } from "vitest";
import { createTaskPlanCanvas, deleteTaskPlanCanvas } from "../../packages/broker/src/aws/slack-web.js";

const CHANNEL = "C12345678";

describe("task plan Slack Canvas", () => {

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
