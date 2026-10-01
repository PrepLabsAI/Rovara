// Issue 157: a resumed turn reads the remembered task's final response the way agentx_task_result does.
import { describe, expect, it } from "vitest";
import { createThreadApi } from "../../packages/slack-service/src/thread-api.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const operationId = "55555555-5555-4555-8555-555555555555";

function operation(status: string, error?: string) {
  return {
    id: operationId, workspaceId, kind: "task", requestId: "44444444-4444-4444-8444-444444444444", payloadHash: "a".repeat(64),
    status, fence: 1, createdAt: "2026-09-29T19:30:00.000Z", updatedAt: "2026-09-29T20:15:00.000Z", ...(error === undefined ? {} : { error }),
  };
}

function api(status: string, error?: string) {
  const paths: string[] = [];
  const signedFetch: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    paths.push(url.pathname);
    const body = url.pathname.endsWith("/events")
      ? { events: [{ sequence: 1, type: "message_end", timestamp: "2026-09-29T20:15:00.000Z", payload: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Pushed the fix." }] } } }] }
      : { operation: operation(status, error) };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { paths, threadApi: createThreadApi({ controlPlaneUrl: "https://agentx.example.test", signedFetch }) };
}

describe("the thread client's task result", () => {
  it("returns the finished task's status and last assistant response", async () => {
    const { paths, threadApi } = api("SUCCEEDED");
    expect(await threadApi.taskResult!(workspaceId, operationId)).toEqual({ status: "SUCCEEDED", response: "Pushed the fix." });
    expect(paths).toContain(`/v1/workspaces/${workspaceId}/operations/${operationId}`);
  });

  it("returns a failed task's error", async () => {
    const { threadApi } = api("FAILED", "the loop guard stopped the task");
    expect(await threadApi.taskResult!(workspaceId, operationId)).toEqual({ status: "FAILED", response: "Pushed the fix.", error: "the loop guard stopped the task" });
  });

  it("stops waiting when its signal is aborted", async () => {
    const { threadApi } = api("RUNNING");
    const controller = new AbortController();
    const waiting = threadApi.taskResult!(workspaceId, operationId, controller.signal);
    controller.abort(new Error("handed off"));
    await expect(waiting).rejects.toThrow("handed off");
  });
});
