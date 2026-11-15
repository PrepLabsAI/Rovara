import { expect, it } from "vitest";
import { ROVARA_CODE_AGENT_ID } from "@agentx/contracts";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { handleTaskRoute } from "../../packages/broker/src/core/task-flow/routes.js";
import { createOwnerRoutes } from "../../packages/broker/src/local/app/routes.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { createTaskFlowRunStarter } from "../../packages/broker/src/local/app/automation.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createLocalChat } from "../../packages/broker/src/local/app/chat.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { intakePortsOf } from "../../packages/broker/src/core/intake/wiring.js";
import { createSessionStartExtras } from "../../packages/broker/src/local/app/session-start.js";
import { createLocalSetupAgent } from "../../packages/broker/src/local/app/setup-agent.js";
const request = () => ({ project: "payments", instructions: "Build it", requestId: newRequestId(), client: "nightly" });
it("a direct engine start ignores the request client when recording origin", async () => {
  const h = createHarness(); await h.registerProject();
  const result = await h.flow.start(h.owner, request());
  expect((await h.store.get(taskKey(result.task.taskId)))?.["origin"]).toBe("app");
});
it("the core developer route records its own surface, ignoring client text", async () => {
  const h = createHarness({ understandFirst: true }); await h.registerProject();
  const answer = await handleTaskRoute(h.flow, { method: "POST", path: "/v1/dev/tasks", caller: h.owner, body: JSON.stringify(request()) });
  const id = (answer?.body as { task: { taskId: string } }).task.taskId;
  expect((await h.store.get(taskKey(id)))?.["origin"]).toBe("app");
});
it.each([false, true])("the local API records a fixed surface for script credential=%s", async script => {
  const h = createHarness({ understandFirst: true }); await h.registerProject();
  const caller = { ...h.owner, ...(script ? { scriptToken: { tokenId: "test", name: "nightly", permissions: ["start"] as const, projects: ["payments"] } } : {}) };
  const handler = createOwnerRoutes({ flow: h.flow, blobs: createDocumentObjectStorage(h.store, { companyId: h.deps.companyId }), version: "test", openPage: async () => {} });
  const answer = await handler({ method: "POST", path: "/v1/dev/tasks", headers: {}, body: JSON.stringify(request()) }, caller);
  const id = (JSON.parse(answer!.body) as { task: { taskId: string } }).task.taskId;
  expect((await h.store.get(taskKey(id)))?.["origin"]).toBe("app");
});
it("a forged origin in the HTTP body creates no task", async () => {
  const h = createHarness({ understandFirst: true }); await h.registerProject();
  const answer = await handleTaskRoute(h.flow, { method: "POST", path: "/v1/dev/tasks", caller: h.owner, body: JSON.stringify({ ...request(), origin: "nightly" }) });
  expect(answer?.status).toBe(400); expect((await h.flow.list(h.owner)).tasks).toHaveLength(0);
});
it.each(["untrusted-marker", null, 3])("an invalid internal origin is refused with fixed words (%s)", async origin => {
  const h = createHarness(); await h.registerProject();
  await expect(h.flow.start({ ...h.owner, origin: origin as never }, request())).rejects.toThrow("invalid task origin");
  expect((await h.flow.list(h.owner)).tasks).toHaveLength(0);
});
it.each(["event", "schedule", "chain", "nightly", "automatic"] as const)("the server automation seam records %s", async origin => {
  const h = createHarness({ understandFirst: true }); await h.registerProject();
  const starter = createTaskFlowRunStarter({ flow: h.flow, owner: h.owner.principal });
  const result = await starter.start({ origin, requestId: newRequestId(), project: "payments", agent: { agentId: ROVARA_CODE_AGENT_ID }, input: { text: "Build it" }, limits: { maxMinutes: 20 } });
  expect((await h.store.get(taskKey(result.taskId)))?.["origin"]).toBe(origin);
});

it.each(["slack", "examplechat"])("the registered %s chat surface records its origin", async channel => {
  const h = createHarness({ understandFirst: true }); await h.registerProject();
  const chat = createLocalChat({ registry: { get: () => undefined, names: () => [] }, store: h.store, companyId: h.deps.companyId, owner: h.owner.principal, now: () => h.clock.now, flow: h.flow, gate: { decide: async () => ({ status: "refused", reason: "invalid" }) } as never });
  await chat.work(channel).message({ orgId: h.deps.companyId, projectName: "payments", personId: developerIdOf(h.owner.principal), message: { version: 2, channel, eventId: "event-1", text: "Build it", receivedAt: new Date(h.clock.now).toISOString(), actor: { channel, tenant: "T12345678", userId: "U12345678" }, conversation: { channel, tenant: "T12345678", space: "C12345678", thread: "1800000000.000001" } } });
  const task = (await h.flow.list(h.owner)).tasks[0]!;
  expect((await h.store.get(taskKey(task.taskId)))?.["origin"]).toBe(channel === "slack" ? "slack" : "app");
});
it("the tracker intake records the intake surface, not the ticket source text", async () => {
  const h = createHarness({ understandFirst: true }); await h.registerProject();
  h.deps.startExtras = createSessionStartExtras(h.deps.companyId);
  const intake = intakePortsOf({ store: h.store, companyId: h.deps.companyId, now: () => h.clock.now, identity: { getPrincipal: async () => h.owner.principal, resolveExternalAccount: async () => h.owner.principal }, access: h.deps.access, flow: h.flow, owner: h.owner.principal, fenceKey: Buffer.alloc(32, 3), milestones: {} as never });
  const answer = await intake.start(h.deps.companyId, developerIdOf(h.owner.principal), { requestId: newRequestId(), project: "payments", source: "nightly", input: { text: "Build it" }, binding: { kind: "tracker_item", system: "tracker", id: "issue-1", url: "https://tracker.example/issue-1" } } as never);
  expect((await h.store.get(taskKey(answer.task.taskId)))?.["origin"]).toBe("tracker");
});

it("the setup-agent route writes app origin on its new task", async () => {
  const h = createHarness(); await h.registerProject();
  const setup = createLocalSetupAgent({ flow: h.deps, registry: {} as never, gate: {} as never, owner: h.owner.principal, companyId: h.deps.companyId, now: () => h.clock.now, enabled: true, modelAccessConfigured: async () => true });
  const answer = await setup.routes({ method: "POST", path: "/v1/app/projects/payments/setup-agent", headers: {}, body: JSON.stringify({ requestId: newRequestId() }) }, h.owner);
  expect(answer?.statusCode).toBe(202); const taskId = (JSON.parse(answer!.body) as { taskId: string }).taskId;
  expect((await h.store.get(taskKey(taskId)))?.["origin"]).toBe("app");
});
