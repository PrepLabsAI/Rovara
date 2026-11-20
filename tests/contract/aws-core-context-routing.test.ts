import { beforeAll, expect, it, vi } from "vitest";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { call, loadSlackBroker } from "../support/slack-broker.js";

beforeAll(async () => { await loadSlackBroker(); });
it("hands GET catalog, packet and POST calls to the core before developer authentication", async () => {
  const callback = vi.fn(async () => ({ statusCode: 403, headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "REFUSED", text: "this operation cannot use context tools" }) }));
  const harness = await createDeveloperTaskBroker({ register: false, brokerExtra: { core: { callback, handleEvent: async () => undefined } } });
  for (const [method, path] of [["GET", "/v1/internal/context-tools"], ["GET", "/v1/internal/design-review/packet?slot=r1-critic"], ["POST", "/v1/internal/context-tools/call"], ["POST", "/v1/internal/mcp"]]) {
    callback.mockClear();
    const result = await call(harness.handler, { method: method!, path: path!, headers: {} });
    expect(result).toEqual({ status: 403, body: { status: "REFUSED", text: "this operation cannot use context tools" } });
    expect(callback).toHaveBeenCalledOnce();
  }
  callback.mockClear();
  await call(harness.handler, { method: "GET", path: "/v1/internal/workspaces/unknown/operations/unknown/result", headers: {} });
  expect(callback).not.toHaveBeenCalled();
});
