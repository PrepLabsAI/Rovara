import { expect, it } from "vitest";
import { createTaskTokenDescriber } from "../../packages/broker/src/core/model-gateway/describer.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { operationKey, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { type TaskTokenOperation } from "../../packages/broker/src/core/model-gateway/token.js";
async function world() {
  const h = createHarness(); await h.registerProject();
  const started = await h.flow.start(h.owner, { project: "payments", instructions: "Build it", requestId: newRequestId() });
  const workspace = (await h.store.get(workspaceKey(started.task.workspaceId)))!;
  const scope: TaskTokenOperation = { workspaceId: started.task.workspaceId, operationId: workspace["activeOperationId"] as string, fence: 1 };
  const key = operationKey(scope.workspaceId, scope.operationId);
  const original = (await h.store.get(key))!;
  await h.store.put({ item: { ...original, kind: "task", status: "RUNNING", programStepId: "build", requester: { personId: "a".repeat(64), provider: "test" }, dispatch: { kind: "task", payload: {} } } });
  h.deps.modelAccess = { route: async () => ({ alias: "claude-sonnet-4-5", api: "anthropic-messages", catalog: "claude-sonnet-4-5" }) };
  const tk = taskKey(started.task.taskId); const task = (await h.store.get(tk))!;
  await h.store.put({ item: { ...task, origin: "nightly" } });
  return { h, scope, key, tk, describe: createTaskTokenDescriber(h.deps) };
}
it("describes trusted records, never the task's client or session default payer", async () => {
  const w = await world();
  expect(await w.describe.describe(w.scope)).toEqual({ companyId: w.h.deps.companyId, project: "payments", taskId: w.tk.pk.slice("DEVTASK#".length), step: "build", person: "a".repeat(64), payer: { kind: "project", project: "payments" }, origin: "nightly", models: ["claude-sonnet-4-5"] });
});
it("uses the stored model choice and omits a non-developer person", async () => {
  const w = await world(); const op = (await w.h.store.get(w.key))!;
  await w.h.store.put({ item: { ...op, requester: { personId: "local-owner", provider: "local" }, modelChoice: { route: { alias: "chosen-model", api: "openai-responses", catalog: "chosen-model" } } } });
  w.h.deps.modelAccess = { route: async () => { throw new Error("fallback must not be read"); } };
  const answer = await w.describe.describe(w.scope); expect(answer?.models).toEqual(["chosen-model"]); expect(answer).not.toHaveProperty("person");
});
it.each([undefined, "app", "cli", "mcp", "slack", "linear", "chain", "event", "schedule", "unrecognized"])("refuses unavailable payer facts for %s without a guessed payer", async origin => {
  const w = await world(); const task = (await w.h.store.get(w.tk))!;
  const copy = { ...task }; delete copy["origin"];
  await w.h.store.put({ item: { ...copy, ...(origin === undefined ? {} : { origin }), client: "nightly" } });
  await expect(w.describe.describe(w.scope)).rejects.toThrow("could not work out who pays for this task");
});
it.each([{ designReview: {} }, { kind: "prepare" }, { modelChoice: { route: { alias: "bad model" } } }, { modelChoice: { route: { alias: "bad model", api: "openai-responses", catalog: "test" } } }, { workflowMode: "unknown" }, { programStepId: "Bad" }, { dispatch: { kind: "task", payload: { workflowSecondReviewer: {} } } }])("refuses unsupported model descriptions as a whole", async patch => {
  const w = await world(); const op = (await w.h.store.get(w.key))!; await w.h.store.put({ item: { ...op, ...patch } });
  expect(await w.describe.describe(w.scope)).toBeUndefined();
});
