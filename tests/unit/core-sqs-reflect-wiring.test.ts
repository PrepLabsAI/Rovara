// L4-SQS (journey audit B3c and B18, 2026-11-18): the code half. What must hold, with an IAM fence (the role's real grants) in front of an SQS double:
//   B3c  the lessons reflection queue's declared name resolves on a hosted broker (its URLs are derived from the environment's name and declared in the registry's queue settings), the queue is
//        opened, sent to, received from, extended and acknowledged with exactly the broker's grants, and the dead-letter queue is touched by GetQueueAttributes alone;
//   B18  the dispatcher never reaches the core dispatch queue through the SQS adapter: its flow's outbox does not relay (it would need the dead letters' attributes and a send, which its role
//        does not have, and it would burn the staged row's attempts), the broker relays what the dispatcher staged, and a whole dispatch passes under the dispatcher's real grants.
import { describe, expect, it } from "vitest";
import { LESSONS_REFLECT_MAX_RECEIVES, LESSONS_REFLECT_QUEUE, LESSONS_REFLECT_VISIBILITY_SECONDS, OUTBOX_PENDING_INDEX, coreDispatchDeadLetterName, coreDispatchQueueName, coreLessonsReflectDeadLetterName, coreLessonsReflectQueueName, type QueueService } from "@agentx/contracts";
import { createSqsQueueServiceFromSettings } from "../../packages/aws-adapters/src/index.js";
import { hydrateBrokerEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { brokerCoreDispatchQueue } from "../../packages/broker/src/aws/core-engine-root.js";
import { dispatcherFlowDeps } from "../../packages/broker/src/aws/worker-machines/dispatcher-core.js";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import { queueReflectQueue, queueReflectVisibility, reflectQueueOf } from "../../packages/broker/src/lessons/reflect-queue.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createTransactionalOutbox } from "../../packages/broker/src/ports/transactional-outbox.js";
import { CORE_BROKER_QUEUE_ACTIONS, CORE_BROKER_REFLECT_DEAD_LETTER_ACTIONS, CORE_BROKER_REFLECT_QUEUE_ACTIONS, CORE_DISPATCHER_QUEUE_ACTIONS } from "../../infra/lib/core-engine.js";
import { FakeSqs } from "../support/ports/sqs-fake.js";
import { SqsIamFence, type QueueGrants } from "../support/ports/sqs-iam-fence.js";
import { COMPANY_A } from "../support/session-machines-world.js";

const ENVIRONMENT = "staging";
const ACCOUNT = "111122223333";
const REGION = "us-west-2";

/** A named broker's derived variables, built by the broker's own code from the environment's name (what a deployed broker has). */
function brokerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { AGENTX_ENV: ENVIRONMENT, AGENTX_ACCOUNT_ID: ACCOUNT, AWS_REGION: REGION, AGENTX_NAMES: "" };
  hydrateBrokerEnvironment(env);
  return env;
}
const urlOf = (name: string): string => `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/${name}`;

/** The queues as the infrastructure declares them (infra/lib/core-engine.ts), in the SQS double. */
function provision(): FakeSqs {
  const fake = new FakeSqs({ order: "oldest-first" });
  fake.createQueue(urlOf(coreDispatchDeadLetterName(ENVIRONMENT)));
  fake.createQueue(urlOf(coreDispatchQueueName(ENVIRONMENT)), { visibilityTimeout: 120, maxReceiveCount: 21, deadLetterUrl: urlOf(coreDispatchDeadLetterName(ENVIRONMENT)) });
  fake.createQueue(urlOf(coreLessonsReflectDeadLetterName(ENVIRONMENT)));
  fake.createQueue(urlOf(coreLessonsReflectQueueName(ENVIRONMENT)), { visibilityTimeout: LESSONS_REFLECT_VISIBILITY_SECONDS, maxReceiveCount: LESSONS_REFLECT_MAX_RECEIVES, deadLetterUrl: urlOf(coreLessonsReflectDeadLetterName(ENVIRONMENT)) });
  return fake;
}

/** The grants of the stack's two functions, from the infrastructure's own constants. */
const BROKER_GRANTS: QueueGrants = {
  [coreDispatchQueueName(ENVIRONMENT)]: CORE_BROKER_QUEUE_ACTIONS, [coreDispatchDeadLetterName(ENVIRONMENT)]: CORE_BROKER_QUEUE_ACTIONS,
  [coreLessonsReflectQueueName(ENVIRONMENT)]: CORE_BROKER_REFLECT_QUEUE_ACTIONS, [coreLessonsReflectDeadLetterName(ENVIRONMENT)]: CORE_BROKER_REFLECT_DEAD_LETTER_ACTIONS,
};
const DISPATCHER_GRANTS: QueueGrants = { [coreDispatchQueueName(ENVIRONMENT)]: CORE_DISPATCHER_QUEUE_ACTIONS };

const brokerQueues = (fence: SqsIamFence, settings = brokerCoreDispatchQueue(brokerEnvironment()).settings): QueueService => createSqsQueueServiceFromSettings(settings, fence.sender);

describe("the lessons reflection queue on a hosted broker (B3c)", () => {

  it("the declared queue name resolves: the reflect helpers open it with the options the queue has (and a queue left undeclared is refused by name, as before)", async () => {
    const fence = new SqsIamFence(BROKER_GRANTS, provision());
    const queue = await reflectQueueOf(brokerQueues(fence));
    expect(queue.name).toBe(LESSONS_REFLECT_QUEUE);
    // The positive control: with no declaration (the state before this lane) the same call throws the audit's error.
    const settings = brokerCoreDispatchQueue({ ...brokerEnvironment(), CORE_LESSONS_REFLECT_QUEUE_URL: undefined, CORE_LESSONS_REFLECT_DEAD_LETTER_URL: undefined }).settings;
    expect(Object.keys((settings as { queues: object }).queues)).toEqual(["task-dispatch"]);
    await expect(reflectQueueOf(brokerQueues(new SqsIamFence(BROKER_GRANTS, provision()), settings))).rejects.toThrow(/no SQS queue is declared as "lessons-reflect"/u);
  });

  it("refuses a queue declared with other options than the code asks for (the infrastructure's visibility timeout and redrive limit are the code's)", async () => {
    for (const spec of [
      { visibilityTimeout: 30, maxReceiveCount: LESSONS_REFLECT_MAX_RECEIVES },
      { visibilityTimeout: LESSONS_REFLECT_VISIBILITY_SECONDS, maxReceiveCount: 6 },
    ]) {
      const fake = new FakeSqs();
      fake.createQueue(urlOf(coreDispatchDeadLetterName(ENVIRONMENT)));
      fake.createQueue(urlOf(coreDispatchQueueName(ENVIRONMENT)), { visibilityTimeout: 120, maxReceiveCount: 21, deadLetterUrl: urlOf(coreDispatchDeadLetterName(ENVIRONMENT)) });
      fake.createQueue(urlOf(coreLessonsReflectDeadLetterName(ENVIRONMENT)));
      fake.createQueue(urlOf(coreLessonsReflectQueueName(ENVIRONMENT)), { ...spec, deadLetterUrl: urlOf(coreLessonsReflectDeadLetterName(ENVIRONMENT)) });
      await expect(reflectQueueOf(brokerQueues(new SqsIamFence(BROKER_GRANTS, fake)))).rejects.toThrow(/declared with different options/u);
    }
  });

  it("the broker sends, receives, extends and acknowledges a reflection with its grants alone, touches the dead letters by GetQueueAttributes only, and is never denied", async () => {
    const fake = provision();
    const fence = new SqsIamFence(BROKER_GRANTS, fake);
    const queue = await reflectQueueOf(brokerQueues(fence));
    const sender = queueReflectQueue(queue);
    await sender.send({ orgId: COMPANY_A, taskId: "task-1", outcome: "merged", requestId: "req-1" });
    await sender.send({ orgId: COMPANY_A, taskId: "task-2", outcome: "sent_back", requestId: "task-2:sent_back:1", round: 1 });
    const [first] = await queue.receive({ maxMessages: 1, visibilityTimeoutSeconds: 600 });
    expect(first).toBeDefined();
    await queueReflectVisibility(queue).delay(first!.receiptHandle, 60);
    const [second] = await queue.receive({ maxMessages: 1, visibilityTimeoutSeconds: 600 });
    expect(await queue.ack(second!.receiptHandle)).toBe(true);
    expect(fence.denied).toEqual([]);
    const reflectCalls = fence.allowed.filter((call) => call.queue === coreLessonsReflectQueueName(ENVIRONMENT)).map((call) => call.action);
    expect(new Set(reflectCalls)).toEqual(new Set(CORE_BROKER_REFLECT_QUEUE_ACTIONS));
    expect(fence.allowed.filter((call) => call.queue === coreLessonsReflectDeadLetterName(ENVIRONMENT))).toEqual([{ action: "sqs:GetQueueAttributes", queue: coreLessonsReflectDeadLetterName(ENVIRONMENT) }]);
    expect(fake.stored(urlOf(coreLessonsReflectQueueName(ENVIRONMENT))).length).toBeGreaterThan(0);
  });

  it("a reflection queue URL that is not an SQS queue URL, or one given without the other, refuses the broker by the same words as the dispatch queue's", () => {
    const env = brokerEnvironment();
    const words = /^the broker needs valid core dispatch queue URLs$/u;
    expect(() => brokerCoreDispatchQueue({ ...env, CORE_LESSONS_REFLECT_QUEUE_URL: "not a url" })).toThrow(words);
    expect(() => brokerCoreDispatchQueue({ ...env, CORE_LESSONS_REFLECT_DEAD_LETTER_URL: undefined })).toThrow(words);
    expect(() => brokerCoreDispatchQueue({ ...env, CORE_LESSONS_REFLECT_DEAD_LETTER_URL: `${env.CORE_LESSONS_REFLECT_DEAD_LETTER_URL}.fifo` })).toThrow(words);
  });
});

describe("the dispatcher and the SQS adapter (B18)", () => {
  const stage = async (store: MemoryDocumentStore, outbox: TaskFlowDeps["outbox"], id: string): Promise<void> => {
    expect((await store.transact([outbox.stage({ id, companyId: COMPANY_A, queue: "task-dispatch", body: { v: 1, companyId: COMPANY_A, workspaceId: "w", operationId: id } })])).applied).toBe(true);
  };
  const rowOf = async (store: MemoryDocumentStore, id: string) => {
    const pending = await store.queryIndex({ index: OUTBOX_PENDING_INDEX.name, partition: `PENDING#${COMPANY_A}`, limit: 10 });
    return pending.items.find((item) => item.id === id);
  };
  const world = () => {
    const store = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES });
    const fake = provision();
    const dispatcher = new SqsIamFence(DISPATCHER_GRANTS, fake);
    const broker = new SqsIamFence(BROKER_GRANTS, fake);
    const registryQueuesOf = (fence: SqsIamFence): QueueService => brokerQueues(fence);
    return { store, fake, dispatcher, broker, registryQueuesOf };
  };

  it("positive control (the audit's finding, narrowed): a relay over the registry's SQS service on the dispatcher's role is denied, and burns one of the row's attempts", async () => {
    const w = world();
    const outbox = createTransactionalOutbox({ store: w.store, queues: w.registryQueuesOf(w.dispatcher) });
    await stage(w.store, outbox, "op-1");
    const report = await outbox.relay({ companyId: COMPANY_A, ids: ["op-1"] });
    expect(report).toEqual({ delivered: 0, failed: 1, dead: 0 });
    // GetQueueAttributes on the dead letters (the adapter's open) is what the dispatcher's role cannot do.
    expect(w.dispatcher.denied).toContainEqual({ action: "sqs:GetQueueAttributes", queue: coreDispatchDeadLetterName(ENVIRONMENT) });
    expect((await rowOf(w.store, "op-1"))!.attempts).toBe(1);
  });

  it("the dispatcher's flow deps never relay: no SQS call at all, the staged row is untouched (still pending, no attempt burned), and the broker relays it", async () => {
    const w = world();
    const base = { companyId: COMPANY_A, store: w.store, queues: {} as QueueService, outbox: createTransactionalOutbox({ store: w.store, queues: w.registryQueuesOf(w.dispatcher) }) } as unknown as TaskFlowDeps;
    const batch = { queue: async () => { throw new Error("the batch is not asked here"); } } as QueueService;
    const deps = dispatcherFlowDeps(base, batch);
    // Everything else is the flow's own, and the dispatch queue is the batch.
    expect(deps.store).toBe(base.store);
    expect(deps.companyId).toBe(COMPANY_A);
    expect(deps.queues).toBe(batch);
    await stage(w.store, deps.outbox, "op-2");
    expect(await deps.outbox.relay({ companyId: COMPANY_A, ids: ["op-2"] })).toEqual({ delivered: 0, failed: 0, dead: 0 });
    expect(await deps.outbox.relay({ companyId: COMPANY_A })).toEqual({ delivered: 0, failed: 0, dead: 0 });
    expect(w.dispatcher.allowed).toEqual([]);
    expect(w.dispatcher.denied).toEqual([]);
    expect(w.fake.requests).toEqual([]);
    expect((await rowOf(w.store, "op-2"))).toMatchObject({ status: "PENDING", attempts: 0 });
    // The broker (which holds the send grant) relays it, as its stream and one-minute backstop do.
    const broker = createTransactionalOutbox({ store: w.store, queues: w.registryQueuesOf(w.broker) });
    expect(await broker.relay({ companyId: COMPANY_A })).toEqual({ delivered: 1, failed: 0, dead: 0 });
    expect(w.broker.denied).toEqual([]);
    expect(await rowOf(w.store, "op-2")).toBeUndefined();
    expect(w.fake.stored(urlOf(coreDispatchQueueName(ENVIRONMENT)))).toHaveLength(1);
  });

  it("the dispatcher's grants stay what they were: receive, delete, change visibility and attributes on the core dispatch queue only (never a send, never the dead letters)", async () => {
    expect([...CORE_DISPATCHER_QUEUE_ACTIONS].sort()).toEqual(["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ReceiveMessage"]);
    // No double behind the fence: an allowed call answers {} (the call's own effect is not the point here).
    const w = { dispatcher: new SqsIamFence(DISPATCHER_GRANTS) };
    const { SendMessageCommand, GetQueueAttributesCommand, ChangeMessageVisibilityCommand } = await import("@aws-sdk/client-sqs");
    await expect(w.dispatcher.sender.send(new ChangeMessageVisibilityCommand({ QueueUrl: urlOf(coreDispatchQueueName(ENVIRONMENT)), ReceiptHandle: "h", VisibilityTimeout: 5 }))).resolves.toBeDefined();
    await expect(w.dispatcher.sender.send(new SendMessageCommand({ QueueUrl: urlOf(coreDispatchQueueName(ENVIRONMENT)), MessageBody: "{}" }))).rejects.toMatchObject({ name: "AccessDeniedException" });
    await expect(w.dispatcher.sender.send(new GetQueueAttributesCommand({ QueueUrl: urlOf(coreDispatchDeadLetterName(ENVIRONMENT)), AttributeNames: ["QueueArn"] }))).rejects.toMatchObject({ name: "AccessDeniedException" });
  });
});
