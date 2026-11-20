import { IMPLICIT_COMPANY_ID as T1_COMPANY } from "@agentx/contracts";
import { expect, it } from "vitest";
import { ROVARA_CODE_AGENT_ID, type Payer, type WorkOrigin } from "@agentx/contracts";
import { createTaskTokenDescriber } from "../../packages/broker/src/core/model-gateway/describer.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { operationKey, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { type TaskTokenOperation } from "../../packages/broker/src/core/model-gateway/token.js";
async function world() {
  const h = createHarness(); await h.registerProject();
  const started = await h.flow.start(h.owner, { project: "payments", instructions: "Build it", requestId: newRequestId() });
  const workspace = (await h.store.get(workspaceKey(T1_COMPANY, started.task.workspaceId)))!;
  const scope: TaskTokenOperation = { workspaceId: started.task.workspaceId, operationId: workspace["activeOperationId"] as string, fence: 1 };
  const key = operationKey(T1_COMPANY, scope.workspaceId, scope.operationId);
  const original = (await h.store.get(key))!;
  await h.store.put({ item: { ...original, kind: "task", status: "RUNNING", programStepId: "build", requester: { personId: "a".repeat(64), provider: "test" }, dispatch: { kind: "task", payload: {} } } });
  h.deps.modelAccess = { route: async () => ({ alias: "claude-sonnet-4-5", api: "anthropic-messages", catalog: "claude-sonnet-4-5" }) };
  const tk = taskKey(started.task.taskId); const task = (await h.store.get(tk))!;
  await h.store.put({ item: { ...task, origin: "nightly" } });
  return { h, scope, key, tk, describe: createTaskTokenDescriber(h.deps) };
}
it.each([null])("refuses unavailable payer facts for %s without a guessed payer", async origin => {
  const w = await world(); const task = (await w.h.store.get(w.tk))!;
  const copy = { ...task }; delete copy["origin"];
  await w.h.store.put({ item: { ...copy, ...(origin === undefined ? {} : { origin }), client: "nightly" } });
  await expect(w.describe.describe(w.scope)).rejects.toThrow("could not work out who pays for this task");
});
it.each([{ modelChoice: { route: { alias: "bad model" } } }, { workflowMode: "unknown" }, { programStepId: "Bad" }, { dispatch: { kind: "task", payload: { workflowSecondReviewer: {} } } }])("refuses unsupported model descriptions as a whole", async patch => {
  const w = await world(); const op = (await w.h.store.get(w.key))!; await w.h.store.put({ item: { ...op, ...patch } });
  expect(await w.describe.describe(w.scope)).toBeUndefined();
});

const payerCases: Array<[WorkOrigin, Payer]> = [
  ["app", { kind: "member", developerId: "a".repeat(64) }],
  ["cli", { kind: "member", developerId: "a".repeat(64) }],
  ["mcp", { kind: "member", developerId: "a".repeat(64) }],
  ["slack", { kind: "member", developerId: "a".repeat(64) }],
  ["jira", { kind: "member", developerId: "a".repeat(64) }],
  ["github_issue", { kind: "member", developerId: "a".repeat(64) }],
  ["tracker", { kind: "member", developerId: "a".repeat(64) }],
  ["event", { kind: "agent", agentId: ROVARA_CODE_AGENT_ID }],
  ["schedule", { kind: "agent", agentId: ROVARA_CODE_AGENT_ID }],
  ["test_run", { kind: "project", project: "payments" }],
  ["nightly", { kind: "project", project: "payments" }],
  ["automatic", { kind: "project", project: "payments" }],
];
it.each(payerCases)("resolves %s with no project payer setting to its exact payer", async (origin, payer) => {
  const w = await world(); const task = (await w.h.store.get(w.tk))!;
  await w.h.store.put({ item: { ...task, origin, client: "untrusted-payer-marker", ...(origin === "nightly" ? { purpose: "wiki_build" } : {}) } });
  expect(await w.describe.describe(w.scope)).toMatchObject({ origin, payer });
});

it("resolves an old record from the checked requester without inferring or persisting an origin", async () => {
  const w = await world(); const task = { ...(await w.h.store.get(w.tk))! };
  delete task["origin"];
  await w.h.store.put({ item: { ...task, client: "nightly", payer: { kind: "project", project: "payments" } } });
  const before = await w.h.store.get(w.tk);
  const answer = await w.describe.describe(w.scope);
  expect(answer).toMatchObject({ person: "a".repeat(64), payer: { kind: "member", developerId: "a".repeat(64) } });
  expect(answer).not.toHaveProperty("origin");
  expect(await w.h.store.get(w.tk)).toEqual(before);
});
it.each([undefined])("refuses an old record without a checked member requester (%j)", async requester => {
  const w = await world(); const task = { ...(await w.h.store.get(w.tk))! };
  delete task["origin"];
  await w.h.store.put({ item: task });
  const op = { ...(await w.h.store.get(w.key))! }; delete op["requester"];
  await w.h.store.put({ item: { ...op, ...(requester === undefined ? {} : { requester }) } });
  await expect(w.describe.describe(w.scope)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN", message: "CALLBACK_FORBIDDEN: could not work out who pays for this task" });
});
