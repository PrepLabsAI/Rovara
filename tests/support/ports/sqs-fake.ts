// Convergence lane A2: an in-memory Amazon SQS that speaks the wire protocol of the commands the SQS queue adapter sends.
//
// It is a test double of SQS, not of the port: it takes the SDK's command objects (queue URL, message attributes, receipt handles)
// and answers as SQS documents, so the conformance suite checks the adapter's translation rather than a shortcut. What it models:
//  - Standard queues: at least once, no order (delivery order is shuffled unless `order: "oldest-first"`), no deduplication id (SQS refuses
//    one), per-message delay up to 900 seconds, a redrive policy that moves a message to the dead-letter queue when a receive finds it
//    already received `maxReceiveCount` times.
//  - FIFO queues (URL ends in `.fifo`): a message group id and a deduplication id are required, per-message delay is refused, a repeat of
//    a deduplication id inside 5 minutes is accepted and dropped (the first message's id comes back; with `deduplicationScope: "messageGroup"` only a repeat in the same group), a group with a message in flight
//    is not delivered, and one ReceiveMessage may return several messages of one group, in order (as SQS does).
//  - A message is its body plus its attributes, at most `MaximumMessageSize` bytes (names, the type name and values count); at most 10
//    attributes; body and attribute values in SQS's character set; no empty body or attribute value.
//  - Receipt handles: each receive issues a new handle. Delete and ChangeMessageVisibility with a handle that was never issued fail with
//    ReceiptHandleIsInvalid; with the current handle they work (ChangeMessageVisibility on a message not in flight fails with
//    MessageNotInflight); with an earlier handle of a message since received again they answer success and change nothing, as SQS may.
//  - Receive: `VisibilityTimeout` overrides the queue's, `MaxNumberOfMessages` is 1 to 10, system attributes and message attributes come
//    back only when asked for.
// Faults can be injected per operation. The clock is the test's (`advance`).
import { randomUUID } from "node:crypto";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  MessageNotInflight,
  QueueDoesNotExist,
  ReceiptHandleIsInvalid,
  ReceiveMessageCommand,
  SQSServiceException,
  SendMessageCommand,
  type GetQueueAttributesCommand,
  type Message,
  type MessageAttributeValue,
} from "@aws-sdk/client-sqs";
import type { SqsCommand, SqsSender } from "../../../packages/aws-adapters/src/index.js";

export interface FakeSqsQueueSpec {
  visibilityTimeout?: number;
  /** Move a message to `deadLetterUrl` when a receive finds it already received this many times. */
  maxReceiveCount?: number;
  deadLetterUrl?: string;
  maximumMessageSize?: number;
  /** FIFO only. `messageGroup` limits duplicate suppression to one message group (SQS's DeduplicationScope); default `queue`. */
  deduplicationScope?: "queue" | "messageGroup";
}

interface Stored {
  seq: number;
  messageId: string;
  body: string;
  attributes: Record<string, MessageAttributeValue>;
  groupId?: string;
  sentAt: number;
  visibleAt: number;
  receiveCount: number;
  handle?: string;
}

interface FakeQueue {
  url: string;
  fifo: boolean;
  spec: Required<Pick<FakeSqsQueueSpec, "visibilityTimeout" | "maximumMessageSize">> & FakeSqsQueueSpec;
  messages: Stored[];
  issued: Set<string>;
  dedupe: Map<string, { messageId: string; at: number }>;
}

const invalid = (message: string): SQSServiceException => new SQSServiceException({ name: "InvalidParameterValue", $fault: "client", $metadata: {}, message });
const utf8 = (text: string): number => Buffer.byteLength(text, "utf8");
// eslint-disable-next-line no-control-regex -- the set is SQS's own: tab, line feed, carriage return and the printable ranges
const BODY_CHARACTERS = /^[\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]+$/u;
const ID_CHARACTERS = /^[A-Za-z0-9!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]{1,128}$/;
const nameOf = (url: string): string => url.slice(url.lastIndexOf("/") + 1);

export interface SqsRequest {
  operation: "SendMessage" | "ReceiveMessage" | "DeleteMessage" | "ChangeMessageVisibility" | "GetQueueAttributes";
  input: Record<string, unknown>;
}

export class FakeSqs implements SqsSender {
  /** Milliseconds since the epoch. */
  now = Date.parse("2026-11-11T10:00:00.000Z");
  readonly requests: SqsRequest[] = [];
  readonly #queues = new Map<string, FakeQueue>();
  readonly #faults: { operation: SqsRequest["operation"]; error: unknown; times: number }[] = [];
  #sequence = 0;
  #shuffleState = 12_345;

  constructor(private readonly options: { order?: "shuffled" | "oldest-first" } = {}) {}

  advance(seconds: number): void {
    this.now += seconds * 1_000;
  }

  createQueue(url: string, spec: FakeSqsQueueSpec = {}): void {
    if (this.#queues.has(url)) throw new Error(`queue ${url} exists`);
    this.#queues.set(url, { url, fifo: url.endsWith(".fifo"), spec: { visibilityTimeout: 30, maximumMessageSize: 262_144, ...spec }, messages: [], issued: new Set(), dedupe: new Map() });
  }

  has(url: string): boolean {
    return this.#queues.has(url);
  }

  /** The next `times` calls of `operation` fail with `error`. */
  fail(operation: SqsRequest["operation"], error: unknown, times = 1): void {
    this.#faults.push({ operation, error, times });
  }

  /** What is stored on the queue now (visible, in flight and delayed). */
  stored(url: string): { messageId: string; body: string; attributes: Record<string, string>; groupId?: string; receiveCount: number }[] {
    return this.#queue(url).messages.map((message) => ({
      messageId: message.messageId, body: message.body, receiveCount: message.receiveCount,
      attributes: Object.fromEntries(Object.entries(message.attributes).map(([name, value]) => [name, value.StringValue ?? ""])),
      ...(message.groupId === undefined ? {} : { groupId: message.groupId }),
    }));
  }

  /** Puts a message on a queue as another producer would (any body, no checks). */
  plant(url: string, body: string, attributes: Record<string, MessageAttributeValue> = {}): string {
    const queue = this.#queue(url);
    const messageId = randomUUID();
    queue.messages.push({ seq: this.#sequence += 1, messageId, body, attributes, sentAt: this.now, visibleAt: this.now, receiveCount: 0 });
    return messageId;
  }

  async send(command: SqsCommand): Promise<unknown> {
    const call = this.#call(command);
    this.requests.push(call);
    const fault = this.#faults.find((entry) => entry.operation === call.operation && entry.times > 0);
    if (fault !== undefined) {
      fault.times -= 1;
      throw fault.error;
    }
    if (command instanceof SendMessageCommand) return this.#sendMessage(command.input);
    if (command instanceof ReceiveMessageCommand) return this.#receive(command.input);
    if (command instanceof DeleteMessageCommand) return this.#delete(command.input);
    if (command instanceof ChangeMessageVisibilityCommand) return this.#changeVisibility(command.input);
    return this.#attributes(command.input);
  }

  #call(command: SqsCommand): SqsRequest {
    const operation = command instanceof SendMessageCommand ? "SendMessage"
      : command instanceof ReceiveMessageCommand ? "ReceiveMessage"
        : command instanceof DeleteMessageCommand ? "DeleteMessage"
          : command instanceof ChangeMessageVisibilityCommand ? "ChangeMessageVisibility" : "GetQueueAttributes";
    return { operation, input: structuredClone(command.input) as unknown as Record<string, unknown> };
  }

  #queue(url: string | undefined): FakeQueue {
    const queue = url === undefined ? undefined : this.#queues.get(url);
    if (queue === undefined) throw new QueueDoesNotExist({ message: "The specified queue does not exist.", $metadata: {} });
    return queue;
  }

  #attributes(input: GetQueueAttributesCommand["input"]): { Attributes: Record<string, string> } {
    const queue = this.#queue(input.QueueUrl);
    const all = input.AttributeNames?.includes("All") === true;
    const wanted = new Set<string>(input.AttributeNames ?? []);
    const arn = `arn:aws:sqs:us-west-2:000000000000:${nameOf(queue.url)}`;
    const available: Record<string, string> = {
      QueueArn: arn,
      VisibilityTimeout: String(queue.spec.visibilityTimeout),
      MaximumMessageSize: String(queue.spec.maximumMessageSize),
      DelaySeconds: "0",
      ...(queue.fifo ? { FifoQueue: "true", DeduplicationScope: queue.spec.deduplicationScope ?? "queue" } : {}),
    };
    if (queue.spec.maxReceiveCount !== undefined && queue.spec.deadLetterUrl !== undefined) {
      available.RedrivePolicy = JSON.stringify({ deadLetterTargetArn: `arn:aws:sqs:us-west-2:000000000000:${nameOf(queue.spec.deadLetterUrl)}`, maxReceiveCount: queue.spec.maxReceiveCount });
    }
    return { Attributes: Object.fromEntries(Object.entries(available).filter(([name]) => all || wanted.has(name))) };
  }

  #sendMessage(input: SendMessageCommand["input"]): { MessageId: string; MD5OfMessageBody: string } {
    const queue = this.#queue(input.QueueUrl);
    const body = input.MessageBody ?? "";
    if (body === "") throw invalid("The request must contain the parameter MessageBody.");
    if (!BODY_CHARACTERS.test(body)) throw new SQSServiceException({ name: "InvalidMessageContents", $fault: "client", $metadata: {}, message: "Invalid characters found in the message body." });
    const attributes = input.MessageAttributes ?? {};
    if (Object.keys(attributes).length > 10) throw invalid("Number of message attributes exceeds the allowed maximum of 10.");
    let size = utf8(body);
    for (const [name, value] of Object.entries(attributes)) {
      if (!/^[A-Za-z0-9_.-]{1,256}$/.test(name) || name.startsWith(".") || name.endsWith(".") || name.includes("..") || /^(aws|amazon)\./i.test(name)) throw new SQSServiceException({ name: "InvalidAttributeName", $fault: "client", $metadata: {}, message: `Invalid message attribute name ${name}` });
      if (value.DataType === undefined || !/^(String|Number|Binary)(\.[A-Za-z0-9_.-]+)?$/.test(value.DataType)) throw invalid("Message attribute data type is invalid.");
      if (value.DataType.startsWith("String") && (value.StringValue === undefined || value.StringValue === "" || !BODY_CHARACTERS.test(value.StringValue))) throw invalid(`Message attribute ${name} has an empty or invalid value.`);
      size += utf8(name) + utf8(value.DataType) + utf8(value.StringValue ?? "");
    }
    if (size > queue.spec.maximumMessageSize) throw invalid(`One or more parameters are invalid. Reason: Message must be shorter than ${queue.spec.maximumMessageSize} bytes.`);
    const delay = input.DelaySeconds ?? 0;
    if (!Number.isInteger(delay) || delay < 0 || delay > 900) throw invalid("Value for parameter DelaySeconds is invalid. Reason: DelaySeconds must be >= 0 and <= 900.");
    const messageId = randomUUID();
    if (queue.fifo) {
      if (delay !== 0) throw invalid("Value 5 for parameter DelaySeconds is invalid. Reason: The request include parameter that is not valid for this queue type.");
      if (input.MessageGroupId === undefined) throw new SQSServiceException({ name: "MissingParameter", $fault: "client", $metadata: {}, message: "The request must contain the parameter MessageGroupId." });
      if (!ID_CHARACTERS.test(input.MessageGroupId)) throw invalid("MessageGroupId is invalid.");
      if (input.MessageDeduplicationId === undefined) throw invalid("The queue should either have ContentBasedDeduplication enabled or MessageDeduplicationId provided explicitly");
      if (!ID_CHARACTERS.test(input.MessageDeduplicationId)) throw invalid("MessageDeduplicationId is invalid.");
      for (const [key, entry] of queue.dedupe) if (this.now - entry.at >= 300_000) queue.dedupe.delete(key);
      // With the scope on the message group, the same deduplication id in another group is another message.
      const dedupeKey = queue.spec.deduplicationScope === "messageGroup" ? `${input.MessageGroupId}\u0000${input.MessageDeduplicationId}` : input.MessageDeduplicationId;
      const seen = queue.dedupe.get(dedupeKey);
      if (seen !== undefined) return { MessageId: seen.messageId, MD5OfMessageBody: "" };
      queue.dedupe.set(dedupeKey, { messageId, at: this.now });
    } else {
      if (input.MessageDeduplicationId !== undefined || input.MessageGroupId !== undefined) throw invalid("The request include parameter that is not valid for this queue type.");
    }
    queue.messages.push({
      seq: this.#sequence += 1, messageId, body, attributes: structuredClone(attributes),
      ...(input.MessageGroupId === undefined ? {} : { groupId: input.MessageGroupId }),
      sentAt: this.now, visibleAt: this.now + delay * 1_000, receiveCount: 0,
    });
    return { MessageId: messageId, MD5OfMessageBody: "" };
  }

  #inFlight(message: Stored): boolean {
    return message.handle !== undefined && message.visibleAt > this.now;
  }

  #receive(input: ReceiveMessageCommand["input"]): { Messages?: Message[] } {
    const queue = this.#queue(input.QueueUrl);
    const max = input.MaxNumberOfMessages ?? 1;
    if (!Number.isInteger(max) || max < 1 || max > 10) throw invalid("Value for parameter MaxNumberOfMessages is invalid. Reason: Must be between 1 and 10, if provided.");
    const hide = input.VisibilityTimeout ?? queue.spec.visibilityTimeout;
    if (!Number.isInteger(hide) || hide < 0 || hide > 43_200) throw invalid("Value for parameter VisibilityTimeout is invalid.");
    const wait = input.WaitTimeSeconds ?? 0;
    if (!Number.isInteger(wait) || wait < 0 || wait > 20) throw invalid("Value for parameter WaitTimeSeconds is invalid. Reason: Must be >= 0 and <= 20, if provided.");
    const blocked = new Set<string>();
    if (queue.fifo) for (const message of queue.messages) if (message.groupId !== undefined && this.#inFlight(message)) blocked.add(message.groupId);
    let candidates = queue.messages.filter((message) => message.visibleAt <= this.now && !this.#inFlight(message)).sort((a, b) => a.seq - b.seq);
    if (!queue.fifo && (this.options.order ?? "shuffled") === "shuffled") candidates = this.#shuffle(candidates);
    const delivered: Message[] = [];
    for (const message of candidates) {
      if (delivered.length >= max) break;
      if (queue.fifo && message.groupId !== undefined && blocked.has(message.groupId)) continue;
      const limit = queue.spec.maxReceiveCount;
      if (limit !== undefined && message.receiveCount >= limit) {
        // The redrive policy: the message is moved on instead of being delivered again.
        queue.messages.splice(queue.messages.indexOf(message), 1);
        const dead = this.#queue(queue.spec.deadLetterUrl);
        const moved: Stored = { ...message, seq: this.#sequence += 1, visibleAt: this.now };
        delete moved.handle;
        dead.messages.push(moved);
        continue;
      }
      message.receiveCount += 1;
      message.handle = `handle-${randomUUID()}`;
      message.visibleAt = this.now + hide * 1_000;
      queue.issued.add(message.handle);
      const systemAttributes: Record<string, string> = {};
      const asked = new Set(input.MessageSystemAttributeNames ?? []);
      const askedAll = asked.has("All");
      if (askedAll || asked.has("ApproximateReceiveCount")) systemAttributes.ApproximateReceiveCount = String(message.receiveCount);
      if (askedAll || asked.has("SentTimestamp")) systemAttributes.SentTimestamp = String(message.sentAt);
      if ((askedAll || asked.has("MessageGroupId")) && message.groupId !== undefined) systemAttributes.MessageGroupId = message.groupId;
      const wantsAttributes = input.MessageAttributeNames?.some((name) => name === "All" || name === ".*") === true;
      delivered.push({
        MessageId: message.messageId,
        ReceiptHandle: message.handle,
        Body: message.body,
        ...(Object.keys(systemAttributes).length === 0 ? {} : { Attributes: systemAttributes }),
        ...(wantsAttributes && Object.keys(message.attributes).length > 0 ? { MessageAttributes: structuredClone(message.attributes) } : {}),
      });
    }
    return delivered.length === 0 ? {} : { Messages: delivered };
  }

  #shuffle<T>(items: T[]): T[] {
    const out = [...items];
    for (let index = out.length - 1; index > 0; index -= 1) {
      this.#shuffleState = (this.#shuffleState * 1_103_515_245 + 12_345) % 2_147_483_648;
      const pick = this.#shuffleState % (index + 1);
      [out[index], out[pick]] = [out[pick]!, out[index]!];
    }
    return out;
  }

  #byHandle(queue: FakeQueue, handle: string | undefined): Stored | "stale" {
    if (handle === undefined || !queue.issued.has(handle)) throw new ReceiptHandleIsInvalid({ message: "The input receipt handle is invalid.", $metadata: {} });
    return queue.messages.find((message) => message.handle === handle) ?? "stale";
  }

  #delete(input: DeleteMessageCommand["input"]): Record<string, never> {
    const queue = this.#queue(input.QueueUrl);
    const message = this.#byHandle(queue, input.ReceiptHandle);
    if (message !== "stale") queue.messages.splice(queue.messages.indexOf(message), 1);
    return {};
  }

  #changeVisibility(input: ChangeMessageVisibilityCommand["input"]): Record<string, never> {
    const queue = this.#queue(input.QueueUrl);
    const timeout = input.VisibilityTimeout;
    if (timeout === undefined || !Number.isInteger(timeout) || timeout < 0 || timeout > 43_200) throw invalid("Value for parameter VisibilityTimeout is invalid.");
    const message = this.#byHandle(queue, input.ReceiptHandle);
    if (message === "stale") return {};
    if (!this.#inFlight(message)) throw new MessageNotInflight({ message: "Message is not in flight.", $metadata: {} });
    message.visibleAt = this.now + timeout * 1_000;
    return {};
  }
}
