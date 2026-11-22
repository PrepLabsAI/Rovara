import { expect, it } from "vitest";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";

it("parks delivery before allocating a machine or issuing worker authority", async () => {
  const h = createHarness();
  await h.registerProject();
  let allowed = false;
  Object.assign(h.deps, { deliveryAccess: async () => allowed ? "ALLOWED" : "PARKED" });
  await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename a setting" });
  expect(await h.flow.dispatchOnce()).toMatchObject({ delivered: 0, dropped: 1 });
  expect(h.grants).toEqual([]);
  allowed = true;
  h.clock.advance(300);
  expect(await h.flow.dispatchOnce()).toMatchObject({ received: 0 });
});

it("rechecks live authority at the handover after a machine becomes ready", async () => {
  const h = createHarness({ machines: { startingChecks: 0 } });
  await h.registerProject();
  let checks = 0;
  h.deps.deliveryAccess = async () => ++checks === 1 ? "ALLOWED" : "PARKED";
  await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename a setting" });
  expect(await h.flow.dispatchOnce()).toMatchObject({ delivered: 0, dropped: 1 });
  expect(h.grants).toEqual([]);
});
