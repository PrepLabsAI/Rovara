import { expect, it } from "vitest";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { createOwnerRoutes } from "../../packages/broker/src/local/app/routes.js";

it("local task details carry the configured cap and never invent an absent or unreadable cap", async () => {
 const h = createHarness(); await h.registerProject();
 const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Health endpoint" });
 for (const [roundCap, maximum] of [[async () => ({ limitUsd: 12.345678, spentUsd: undefined }), 12_345_678], [undefined, undefined], [async () => { throw new Error("unreadable"); }, undefined]] as const) {
  const routes = createOwnerRoutes({ flow: h.flow, blobs: {} as never, openPage: async () => undefined, version: "test", ...(roundCap === undefined ? {} : { roundCap }) });
  const response = await routes({ method: "GET", path: `/v1/dev/tasks/${started.task.taskId}`, headers: {} }, h.owner);
  expect(response?.statusCode).toBe(200);
  expect((JSON.parse(response!.body) as { task: unknown }).task).toMatchObject({ money: { stop: { taskMaximumMicros: maximum === undefined ? { state: "unavailable" } : { state: "available", value: maximum } } } });
 }
});
