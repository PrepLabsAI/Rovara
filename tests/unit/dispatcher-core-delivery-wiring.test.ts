import { afterEach, expect, it, vi } from "vitest";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { WORKER_POST_TIMEOUT_MS, companyScoped } from "@agentx/contracts";
import type * as DispatcherCoreModule from "../../packages/broker/src/aws/worker-machines/dispatcher-core.js";
import type { DispatcherCoreInputs } from "../../packages/broker/src/aws/worker-machines/dispatcher-core.js";
import { readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { readOperation } from "../../packages/broker/src/core/task-flow/results.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { COMPANY_A } from "../support/session-machines-world.js";

const captured = vi.hoisted(() => ({ inputs: undefined as DispatcherCoreInputs | undefined }));
// Observe the private hosted builder without replacing its delivery policy or the host it builds.
vi.mock("../../packages/broker/src/aws/worker-machines/dispatcher-core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof DispatcherCoreModule>();
  return { ...actual, createDispatcherCoreHost: (inputs: DispatcherCoreInputs) => {
    captured.inputs = inputs;
    return actual.createDispatcherCoreHost(inputs);
  } };
});
// A synthetic signing input keeps this test entirely offline; no secret is read.
vi.mock("../../packages/broker/src/aws/callback-signing-key.js", () => ({ loadCallbackSigningKey: async () => "k".repeat(48) }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// M4/M4b: replacing the dispatcher's real deliveryAccess wiring with ALLOWED
// must lose the durable, company-scoped pause asserted here.
it("parks ownerless PEOPLE work through the deployed dispatcher's delivery wiring", async () => {
  const queueArn = "arn:aws:sqs:us-west-2:111122223333:core-dispatch";
  for (const [name, value] of Object.entries({
    CORE_DISPATCH_QUEUE_ARN: queueArn,
    CORE_DISPATCH_QUEUE_URL: "https://sqs.us-west-2.amazonaws.com/111122223333/core-dispatch",
    CORE_DISPATCH_DEAD_LETTER_URL: "https://sqs.us-west-2.amazonaws.com/111122223333/core-dead",
    STATE_TABLE_NAME: "state", ARTIFACT_BUCKET_NAME: "artifacts", AWS_REGION: "us-west-2",
    EC2_WORKER_SUBNETS: "us-west-2a=subnet-0aaaaaaaaaaaaaaaa", EC2_WORKER_LAUNCH_TEMPLATE_ID: "lt-0123456789abcdef0",
  })) vi.stubEnv(name, value);
  vi.stubEnv("TASK_PERSON_PROOF_FUNCTION_ARN", undefined);
  const db = new FakeDynamoDb();
  vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation((command) => db.send(command as never) as never);
  const { handler } = await import("../../packages/broker/src/aws/dispatcher.js");
  // An unrecognised record reaches the real lazy host builder without dispatching work.
  await handler({ Records: [{ messageId: "builder", receiptHandle: "builder", body: "{}", eventSourceARN: queueArn }] });
  expect(captured.inputs?.deliveryAccess).toBeTypeOf("function");
  // Pin the actual hosted POST to the shared timing used by dispatch freshness.
  // A fetch stub keeps this boundary proof offline; the real post builder runs.
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
  const timeout = vi.spyOn(AbortSignal, "timeout");
  try {
    expect(await captured.inputs!.machines.post("http://127.0.0.1:8080/invocations", { authorization: "synthetic", body: "{}" })).toEqual({ status: 202, body: "{}" });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(WORKER_POST_TIMEOUT_MS);
    expect(fetch.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  } finally { fetch.mockRestore(); timeout.mockRestore(); }

  const deliveryAccess = captured.inputs!.deliveryAccess!;
  for (const withPeople of [false, true]) {
    const h = createHarness({ companyId: COMPANY_A });
    await h.registerProject();
    const { task } = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename a setting" });
    const workspace = (await readWorkspace(h.deps, task.workspaceId))!;
    const operationId = workspace.activeOperationId!;
    const operation = (await readOperation(h.deps, task.workspaceId, operationId))!;
    const outboxPk = companyScoped(COMPANY_A, `OUTBOX#${operationId}`);
    for (const key of [
      { pk: workspace.pk, sk: "META" }, { pk: workspace.pk, sk: "DEVELOPER_TASK" },
      { pk: workspace.pk, sk: operation.sk }, { pk: `DEVTASK#${task.taskId}`, sk: "META" }, { pk: outboxPk, sk: "OUTBOX" },
    ]) db.set((await h.store.get(key))!);
    if (withPeople) db.set({ pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 3, orphaned: true, people: [] });
    expect(await deliveryAccess(h.deps, operation, workspace)).toBe(withPeople ? "PARKED" : "ALLOWED");
    expect(db.get(outboxPk, "OUTBOX")).toMatchObject({ companyId: COMPANY_A, status: withPeople ? "WAITING_FOR_TASK_ACCESS" : "QUEUED", body: { operationId, workspaceId: task.workspaceId, companyId: COMPANY_A } });
    if (withPeople) {
      expect(db.get(`DEVTASK#${task.taskId}`, `TASK_ACCESS_PAUSE#${operationId}`)).toMatchObject({ reason: "OWNERLESS", operationId, peopleRevision: 3 });
      expect(db.get(`OUTBOX#${operationId}`, "TASK_ACCESS_PAUSE")).toMatchObject({ reason: "OWNERLESS", operationId });
      expect(db.get(`OUTBOX#${operationId}`, "OUTBOX")).toBeUndefined();
    }
  }
});
