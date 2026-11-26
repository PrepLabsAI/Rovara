import { expect, it } from "vitest";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { handleTaskRoute } from "../../packages/broker/src/core/task-flow/routes.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { intakePortsOf } from "../../packages/broker/src/core/intake/wiring.js";
import { createSessionStartExtras } from "../../packages/broker/src/core-host/app/session-start.js";
const request = () => ({ project: "payments", instructions: "Build it", requestId: newRequestId(), client: "nightly" });
it("a forged origin in the HTTP body creates no task", async () => {
  const h = createHarness({ understandFirst: true }); await h.registerProject();
  const answer = await handleTaskRoute(h.flow, { method: "POST", path: "/v1/dev/tasks", caller: h.owner, body: JSON.stringify({ ...request(), origin: "nightly" }) });
  expect(answer?.status).toBe(400); expect((await h.flow.list(h.owner)).tasks).toHaveLength(0);
});
it.each([undefined])("an invalid internal origin is refused with fixed words (%s)", async origin => {
  const h = createHarness(); await h.registerProject();
  await expect(h.flow.start({ ...h.owner, origin: origin as never }, request())).rejects.toThrow("invalid task origin");
  expect((await h.flow.list(h.owner)).tasks).toHaveLength(0);
});
it("the tracker intake records the intake surface, not the ticket source text", async () => {
  const h = createHarness({ understandFirst: true }); await h.registerProject();
  h.deps.startExtras = createSessionStartExtras(h.deps.companyId);
  const intake = intakePortsOf({ store: h.store, companyId: h.deps.companyId, now: () => h.clock.now, identity: { getPrincipal: async () => h.owner.principal, resolveExternalAccount: async () => h.owner.principal }, access: h.deps.access, flow: h.flow, owner: h.owner.principal, fenceKey: Buffer.alloc(32, 3), milestones: {} as never });
  const answer = await intake.start(h.deps.companyId, developerIdOf(h.owner.principal), { requestId: newRequestId(), project: "payments", source: "nightly", input: { text: "Build it" }, binding: { kind: "tracker_item", system: "tracker", id: "issue-1", url: "https://tracker.example/issue-1" } } as never);
  expect((await h.store.get(taskKey(answer.task.taskId)))?.["origin"]).toBe("tracker");
});

// Checked by the strict test typecheck: new start paths must name their trusted surface.
function missingOriginMustNotCompile(h: ReturnType<typeof createHarness>) {
  // @ts-expect-error task starts require an explicit origin
  void h.flow.start({ principal: h.owner.principal }, request());
}
void missingOriginMustNotCompile;
