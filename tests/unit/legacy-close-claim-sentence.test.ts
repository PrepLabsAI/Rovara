import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { AgentXError, change, workspaceSessionKey } from "@agentx/contracts";
import { createHarness } from "../support/task-flow-harness.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";

// The Cloud close dialog matches this exact sentence; changing it breaks Cloud's retained-refusal handling. Change both together.
it("the retained WORKSPACE_BUSY refusal pins its exact sentence, code and HTTP 409", async () => {
  const h = createHarness(); await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "legacy close retention sentence" });
  const sk = workspaceSessionKey(task.workspaceId), wk = workspaceKey(h.deps.companyId, task.workspaceId);
  await h.store.put({ item: { ...sk, state: "READY" } });
  await h.store.update({ key: sk, ops: [change.set("closeRetention", { schemaVersion: 1 })] });
  await h.store.update({ key: wk, ops: [change.set("status", "READY"), change.set("activeOperationId", null)] });

  const error = await h.flow.close(h.owner, task.taskId).then(
    () => { throw new Error("expected the retained workspace refusal"); },
    (caught: unknown) => caught,
  );

  const sentence = `This workspace is retained. Review the Close preview at /v1/dev/tasks/${task.taskId}/close before closing it.`;
  expect(error).toBeInstanceOf(AgentXError);
  expect((error as AgentXError).code).toBe("WORKSPACE_BUSY");
  expect((error as AgentXError).statusCode).toBe(409);
  expect((error as AgentXError).message).toBe(`WORKSPACE_BUSY: ${sentence}`);
});
