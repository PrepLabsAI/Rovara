// Convergence lane A2: builds the SQS queue service over the in-memory SQS double. The deployment declares queues (CDK); the harness
// plays the deployment: the first ask for a name (with the options the suite wants) creates that queue and its dead-letter queue in the
// double, and the adapter then reads them back as it would from SQS.
import type { QueueOptions, QueueService } from "@agentx/contracts";
import { SqsQueueService, type SqsQueueDeclaration, type SqsQueueServiceOptions } from "../../../packages/aws-adapters/src/index.js";
import type { QueueHarness, QueueUnderTest } from "./queue-conformance.js";
import { FakeSqs, type FakeSqsQueueSpec } from "./sqs-fake.js";

export const SQS_BASE_URL = "https://sqs.us-west-2.amazonaws.com/000000000000";

export interface SqsWorld {
  fake: FakeSqs;
  /** The adapter over the double. */
  service: SqsQueueService;
  /** Creates the queue (and its dead-letter queue) as a deployment would, unless it exists; returns its declaration. */
  provision(name: string, options?: QueueOptions, spec?: FakeSqsQueueSpec): SqsQueueDeclaration;
  /** `service`, with every queue created on first ask (and made FIFO when `fifo` is set), for the conformance suites. */
  provisioning(fifo: boolean): QueueService;
}

export function sqsWorld(options: { order?: "shuffled" | "oldest-first"; adapter?: Partial<SqsQueueServiceOptions> } = {}): SqsWorld {
  const fake = new FakeSqs(options.order === undefined ? {} : { order: options.order });
  const declared = new Map<string, SqsQueueDeclaration>();
  const service = new SqsQueueService({ client: fake, queues: (name) => declared.get(name), now: () => fake.now, ...options.adapter });
  const provision = (name: string, queueOptions: QueueOptions = {}, spec: FakeSqsQueueSpec = {}): SqsQueueDeclaration => {
    const existing = declared.get(name);
    if (existing !== undefined) return existing;
    const suffix = queueOptions.ordered === true ? ".fifo" : "";
    const url = `${SQS_BASE_URL}/${name}${suffix}`;
    const deadLetterUrl = `${SQS_BASE_URL}/${name}-dead${suffix}`;
    fake.createQueue(deadLetterUrl);
    fake.createQueue(url, {
      ...(queueOptions.visibilityTimeoutSeconds === undefined ? {} : { visibilityTimeout: queueOptions.visibilityTimeoutSeconds }),
      ...(queueOptions.maxReceiveCount === undefined ? {} : { maxReceiveCount: queueOptions.maxReceiveCount, deadLetterUrl }),
      ...spec,
    });
    const declaration = { url, deadLetterUrl };
    declared.set(name, declaration);
    return declaration;
  };
  return {
    fake,
    service,
    provision,
    provisioning(fifo) {
      return {
        async queue(name, queueOptions = {}) {
          const merged: QueueOptions = fifo ? { ...queueOptions, ordered: true } : queueOptions;
          provision(name, merged);
          return service.queue(name, merged);
        },
      };
    },
  };
}

/** The shared queue suite over the SQS adapter, as a standard-queue deployment (`fifo: false`) or a FIFO one. */
export function sqsQueueHarness(fifo: boolean): QueueHarness {
  return {
    async create(): Promise<QueueUnderTest> {
      const world = sqsWorld();
      return { service: world.provisioning(fifo), advance: async (seconds) => world.fake.advance(seconds) };
    },
  };
}
