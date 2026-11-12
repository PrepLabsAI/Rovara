// Convergence lane A2: the Queue port on Amazon SQS.
//
// What is fixed where the queue is declared (in the deployment, never by this adapter): the queue's URL, whether it is a FIFO queue (the
// name ends in `.fifo`), its visibility timeout, its redrive policy (`maxReceiveCount` and the dead-letter queue) and its maximum
// message size. `QueueService.queue(name, options)` reads them back (GetQueueAttributes) once per queue and refuses options that
// differ, so a config can never claim a policy the queue does not have. The adapter creates and changes no queue.
//
// Two modes, one class. A standard queue is the weakest the core must work with: at least once, no order, no duplicate suppression.
// A FIFO queue adds order within a message group and a 5 minute duplicate window. The capabilities say which one a queue is:
//   standard: ordered false, dedupe false, maxDelaySeconds 900, detectsStaleHandle false, deadLettersById false.
//   FIFO:     ordered true,  dedupe true,  maxDelaySeconds 0 (SQS refuses a per-message delay on FIFO), the rest as above.
//
// Where SQS differs from the port, and what this adapter does about it (each pinned by a test):
//  - A message is its body plus its attributes, at most 256 KiB together; the port caps the body alone. An enqueue over the SQS total
//    is refused here, before the send, so a refusal never depends on which attributes travel along.
//  - SQS takes at most 10 message attributes. One is kept for the dead-letter marker, so a message carries at most 9 of its own.
//  - SQS allows a narrow set of characters in a body and in attribute values. The body is compact JSON with U+FFFE and U+FFFF escaped;
//    an attribute value outside the set is refused.
//  - SQS cannot say "this is a duplicate". On a FIFO queue a repeat inside the window is accepted and silently dropped, so `duplicate:
//    true` is reported only when this process sent the same id inside the window; another process's repeat is dropped just the same
//    and reported `false`. Nothing in the core depends on the flag: a consumer is idempotent on its operation (the dispatch consumer claims it conditionally and drops an ended or running one).
//  - A FIFO ReceiveMessage can return several messages of one group at once. The port says one at a time, so an ordered queue is
//    received one message per request (extra messages would burn a receive of the dead-letter budget for nothing).
//  - A receipt handle that SQS no longer knows is refused by SQS only some of the time, so a stale `ack` may answer true.
//  - SQS cannot dead-letter, list or redrive a message by id. `deadLetter` sends the message to the declared dead-letter queue and then
//    deletes it; the by-id calls scan a bounded number of the dead-letter queue's messages (see below). A message SQS itself moves
//    after `maxReceiveCount` keeps its id; one moved by `deadLetter` has a new SQS id and carries the original in a marker attribute.
//  - `deadLetter` needs the message's body, which a receipt handle does not hold: this process remembers what it delivered (bounded),
//    and a handle it did not deliver answers false.
//  - Long polling waits at most 20 seconds per request (SQS's limit); a longer `waitSeconds` is cut to that, which `receive` allows
//    ("up to").
import { createHash, randomUUID } from "node:crypto";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type ChangeMessageVisibilityCommandOutput,
  type DeleteMessageCommandOutput,
  type GetQueueAttributesCommandOutput,
  type Message,
  type MessageAttributeValue,
  type ReceiveMessageCommandOutput,
  type SendMessageCommandOutput,
} from "@aws-sdk/client-sqs";
import {
  QUEUE_LIMITS,
  type DeadLetter,
  type EnqueueResult,
  type JsonValue,
  type Queue,
  type QueueCapabilities,
  type QueueMessageInput,
  type QueueOptions,
  type QueueService,
  type ReceiveOptions,
  type ReceivedMessage,
} from "@agentx/contracts";

/** The commands this adapter sends. */
export type SqsCommand = SendMessageCommand | ReceiveMessageCommand | DeleteMessageCommand | ChangeMessageVisibilityCommand | GetQueueAttributesCommand;

/** What the adapter needs of a client: an `SQSClient` fits, and so does a test double. */
export interface SqsSender {
  send(command: SqsCommand): Promise<unknown>;
}

/** SQS (or the network) failed, as opposed to a caller's mistake. The message names the call and SQS's error name, never its text. */
export class SqsQueueError extends Error {
  readonly retryable: boolean;
  constructor(message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SqsQueueError";
    this.retryable = options.retryable ?? true;
  }
}

/** SQS's limits, as it documents them. */
export const SQS_LIMITS = {
  /** A message's body and attributes together, in UTF-8 bytes (names, the type name `String` and values count). */
  maxMessageBytes: 256 * 1_024,
  /** Message attributes per message. */
  maxAttributes: 10,
  /** Longest long-poll wait of one request. */
  maxWaitSeconds: 20,
  /** Longest per-message delay on a standard queue. */
  maxDelaySeconds: 900,
  /** Longest message group id and deduplication id. */
  maxIdLength: 128,
} as const;

/** Attributes a message may carry of its own: SQS's ten, less the one kept for the dead-letter marker. */
export const MAX_MESSAGE_ATTRIBUTES = SQS_LIMITS.maxAttributes - 1;

/** The message attribute that records why and when `deadLetter` moved a message, and which message it was. */
export const DEAD_LETTER_ATTRIBUTE = "rovaraDeadLetter";

/** A queue the config declares: its URL, and the URL of its dead-letter queue if it has one. */
export interface SqsQueueDeclaration {
  url: string;
  deadLetterUrl?: string;
}

export interface SqsQueueServiceOptions {
  client: SqsSender;
  /** The queues by the name the core asks for. A function may answer for names it makes up (tests). */
  queues: Readonly<Record<string, SqsQueueDeclaration>> | ((name: string) => SqsQueueDeclaration | undefined);
  /** Milliseconds since the epoch. Default: the real clock. */
  now?: () => number;
  /** Told about a message whose body is not JSON. It is not delivered; SQS counts the receive toward the dead-letter budget. */
  onMalformed?: (event: { queue: string; messageId: string }) => void;
  /** Messages `deadLetter` can still find by receipt handle. Default 1000. */
  deliveredMemory?: number;
  /** Messages a by-id dead-letter call looks at before it gives up. Default 100. */
  deadLetterScanLimit?: number;
}

// eslint-disable-next-line no-control-regex -- the set is SQS's own: tab, line feed, carriage return and the printable ranges
const SQS_TEXT = /^[\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]*$/u;
const ATTRIBUTE_NAME = /^[A-Za-z0-9_.-]{1,256}$/;
const ID_TEXT = /^[A-Za-z0-9!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]{1,128}$/;
const QUEUE_NAME = /^[A-Za-z0-9._-]{1,80}$/;
const QUEUE_URL = /^https?:\/\/[^\s/]+\/(?:[^\s/]+\/)*[A-Za-z0-9_-]{1,80}(?:\.fifo)?$/;
const DEDUPE_WINDOW_MS = QUEUE_LIMITS.dedupeWindowSeconds * 1_000;
const DEDUPE_MEMORY = 10_000;
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

function errorName(error: unknown): string {
  if (typeof error === "object" && error !== null && typeof (error as { name?: unknown }).name === "string") return (error as { name: string }).name;
  return "";
}

/** SQS's own words for "that handle means nothing now". */
function isStaleHandleError(error: unknown): boolean {
  const name = errorName(error);
  if (name === "ReceiptHandleIsInvalid" || name === "MessageNotInflight") return true;
  return name === "InvalidParameterValue" && /receipt ?handle/i.test(error instanceof Error ? error.message : "");
}

function failure(error: unknown, operation: string): never {
  if (error instanceof SqsQueueError) throw error;
  const name = errorName(error);
  const permanent = new Set(["InvalidParameterValue", "InvalidAttributeName", "InvalidAttributeValue", "InvalidMessageContents", "QueueDoesNotExist", "AWS.SimpleQueueService.NonExistentQueue", "AccessDeniedException", "UnsupportedOperation"]);
  throw new SqsQueueError(`SQS ${operation} failed: ${name === "" ? "unknown error" : name}`, { retryable: !permanent.has(name), cause: error });
}

function plainText(value: unknown, what: string): string {
  if (typeof value !== "string" || !SQS_TEXT.test(value)) throw new Error(`${what} must be text SQS accepts (no control characters, no unpaired surrogate, no U+FFFE or U+FFFF)`);
  return value;
}

function wholeSeconds(value: unknown, what: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) throw new Error(`${what} is a whole number of seconds from 0 to ${max}`);
  return value;
}

/** The message body as SQS holds it: compact JSON, with the two characters SQS refuses written as escapes (the same JSON value). */
export function encodeBody(body: JsonValue): string {
  const json = JSON.stringify(body);
  if (json === undefined) throw new Error("a message body must be JSON");
  return json.replace(/[￾￿]/g, (character) => `\\u${character.charCodeAt(0).toString(16)}`);
}

/** The attributes as SQS message attributes, each checked against SQS's rules. */
function encodeAttributes(attributes: Record<string, string> | undefined, limit: number): Record<string, MessageAttributeValue> {
  const entries = Object.entries(attributes ?? {});
  if (entries.length > limit) throw new Error(`a message carries at most ${limit} attributes on SQS`);
  const encoded: Record<string, MessageAttributeValue> = {};
  for (const [name, value] of entries) {
    if (!ATTRIBUTE_NAME.test(name) || name.startsWith(".") || name.endsWith(".") || name.includes("..") || /^(aws|amazon)\./i.test(name)) throw new Error(`attribute name ${JSON.stringify(name.slice(0, 40))} is not one SQS accepts`);
    if (name === DEAD_LETTER_ATTRIBUTE) throw new Error(`attribute name ${DEAD_LETTER_ATTRIBUTE} is reserved`);
    if (typeof value !== "string" || value === "") throw new Error(`attribute ${name} must be non-empty text`);
    plainText(value, `attribute ${name}`);
    encoded[name] = { DataType: "String", StringValue: value };
  }
  return encoded;
}

function messageBytes(body: string, attributes: Record<string, MessageAttributeValue>): number {
  let total = bytes(body);
  for (const [name, value] of Object.entries(attributes)) total += bytes(name) + bytes(value.DataType ?? "String") + bytes(value.StringValue ?? "");
  return total;
}

/**
 * The group of a message that names none. With a dedupe id the group is named after it, so two sends of one id land in one group and SQS
 * drops the second whichever DeduplicationScope the queue has; with none it is a group of its own (no order owed to any other message).
 */
const SOLO_GROUP_PREFIX = "rovara-solo-";
const soloGroup = (key: string | undefined): string => `${SOLO_GROUP_PREFIX}${key ?? randomUUID()}`;

/** SQS wants its own text for a deduplication id: 128 characters of a narrow set. The port's ids are free text, so a hash stands in. */
const dedupeKey = (dedupeId: string): string => createHash("sha256").update(dedupeId, "utf8").digest("hex");

interface QueueFacts {
  fifo: boolean;
  visibilityTimeoutSeconds: number;
  maxReceiveCount?: number;
  deadLetterArn?: string;
  /** FIFO only: whether SQS suppresses a repeat across the whole queue, or only within one message group (DeduplicationScope). */
  dedupeScope: "queue" | "messageGroup";
  maxMessageBytes: number;
}

function parseFacts(url: string, attributes: Record<string, string> | undefined): QueueFacts {
  if (attributes === undefined) throw new SqsQueueError("SQS GetQueueAttributes returned no attributes");
  const fifo = attributes.FifoQueue === "true";
  if (fifo !== url.endsWith(".fifo")) throw new SqsQueueError("the queue URL and the queue's FifoQueue attribute disagree", { retryable: false });
  const visibility = Number(attributes.VisibilityTimeout);
  const size = Number(attributes.MaximumMessageSize);
  if (!Number.isInteger(visibility) || !Number.isInteger(size)) throw new SqsQueueError("SQS GetQueueAttributes returned no visibility timeout or maximum message size");
  const facts: QueueFacts = { fifo, visibilityTimeoutSeconds: visibility, dedupeScope: fifo && attributes.DeduplicationScope === "messageGroup" ? "messageGroup" : "queue", maxMessageBytes: Math.min(size, SQS_LIMITS.maxMessageBytes) };
  if (attributes.RedrivePolicy !== undefined) {
    let policy: unknown;
    try {
      policy = JSON.parse(attributes.RedrivePolicy);
    } catch {
      throw new SqsQueueError("the queue's redrive policy is not JSON", { retryable: false });
    }
    const { maxReceiveCount, deadLetterTargetArn } = (policy ?? {}) as { maxReceiveCount?: unknown; deadLetterTargetArn?: unknown };
    const count = Number(maxReceiveCount);
    if (!Number.isInteger(count) || count < 1 || typeof deadLetterTargetArn !== "string") throw new SqsQueueError("the queue's redrive policy has no maxReceiveCount and target", { retryable: false });
    facts.maxReceiveCount = count;
    facts.deadLetterArn = deadLetterTargetArn;
  }
  return facts;
}

function checkOptions(options: QueueOptions): void {
  const { visibilityTimeoutSeconds, maxReceiveCount, ordered } = options;
  if (visibilityTimeoutSeconds !== undefined) wholeSeconds(visibilityTimeoutSeconds, "visibilityTimeoutSeconds", QUEUE_LIMITS.maxSeconds);
  if (maxReceiveCount !== undefined && (!Number.isInteger(maxReceiveCount) || maxReceiveCount < 1)) throw new Error("maxReceiveCount is a whole number of at least 1");
  if (ordered !== undefined && typeof ordered !== "boolean") throw new Error("ordered is true or false");
}

export class SqsQueueService implements QueueService {
  readonly #client: SqsSender;
  readonly #resolve: (name: string) => SqsQueueDeclaration | undefined;
  readonly #now: () => number;
  readonly #onMalformed: (event: { queue: string; messageId: string }) => void;
  readonly #deliveredMemory: number;
  readonly #scanLimit: number;
  readonly #queues = new Map<string, Promise<{ queue: SqsQueue; facts: QueueFacts }>>();

  constructor(options: SqsQueueServiceOptions) {
    this.#client = options.client;
    const declared = options.queues;
    this.#resolve = typeof declared === "function" ? declared : (name) => (Object.hasOwn(declared, name) ? declared[name] : undefined);
    this.#now = options.now ?? Date.now;
    this.#onMalformed = options.onMalformed ?? (() => undefined);
    this.#deliveredMemory = options.deliveredMemory ?? 1_000;
    this.#scanLimit = options.deadLetterScanLimit ?? 100;
  }

  async queue(name: string, options: QueueOptions = {}): Promise<Queue> {
    if (typeof name !== "string" || !QUEUE_NAME.test(name)) throw new Error("a queue name is 1 to 80 letters, digits, dots, hyphens or underscores");
    checkOptions(options);
    let pending = this.#queues.get(name);
    if (pending === undefined) {
      const declaration = this.#resolve(name);
      if (declaration === undefined) throw new Error(`no SQS queue is declared as ${JSON.stringify(name)}`);
      pending = this.#open(name, declaration);
      this.#queues.set(name, pending);
      // A failed first read is not remembered: the next ask reads again.
      pending.catch(() => this.#queues.delete(name));
    }
    const { queue, facts } = await pending;
    const wrong = (options.visibilityTimeoutSeconds !== undefined && options.visibilityTimeoutSeconds !== facts.visibilityTimeoutSeconds)
      || (options.maxReceiveCount !== undefined && options.maxReceiveCount !== facts.maxReceiveCount)
      || (options.ordered !== undefined && options.ordered !== facts.fifo);
    // Options belong to where the queue is declared (the deployment), not to whoever asks first.
    if (wrong) throw new Error("that queue is declared with different options");
    return queue;
  }

  async #open(name: string, declaration: SqsQueueDeclaration): Promise<{ queue: SqsQueue; facts: QueueFacts }> {
    const url = declaration.url;
    if (!QUEUE_URL.test(url)) throw new Error(`the URL declared for queue ${JSON.stringify(name)} is not an SQS queue URL`);
    const deadLetterUrl = declaration.deadLetterUrl;
    if (deadLetterUrl !== undefined && (!QUEUE_URL.test(deadLetterUrl) || deadLetterUrl.endsWith(".fifo") !== url.endsWith(".fifo"))) {
      throw new Error(`the dead-letter URL declared for queue ${JSON.stringify(name)} is not an SQS queue URL of the same kind`);
    }
    const facts = parseFacts(url, await this.#attributes(url, ["All"], "GetQueueAttributes"));
    if (deadLetterUrl !== undefined) {
      // The dead-letter queue is read back whether or not the queue has a redrive policy: `deadLetter` and the by-id calls send to and read
      // from this URL, so it must be a queue that exists, of the queue's kind, and (when there is a policy) the one the policy names.
      const dead = await this.#attributes(deadLetterUrl, ["QueueArn", "FifoQueue"], "GetQueueAttributes (dead letters)");
      if (dead?.QueueArn === undefined || (dead.FifoQueue === "true") !== facts.fifo) throw new Error(`the dead-letter URL declared for queue ${JSON.stringify(name)} is not a queue of the same kind`);
      if (facts.deadLetterArn !== undefined && dead.QueueArn !== facts.deadLetterArn) throw new Error(`the dead-letter URL declared for queue ${JSON.stringify(name)} is not the queue its redrive policy names`);
    }
    const capabilities: QueueCapabilities = {
      ordered: facts.fifo,
      // With the deduplication scope on the message group, SQS drops a repeat only inside one group, so a repeat in another group is kept:
      // the queue's duplicate suppression cannot be promised across groups (a message with no group of its own is still held to one, below).
      dedupe: facts.fifo && facts.dedupeScope === "queue",
      maxDelaySeconds: facts.fifo ? 0 : SQS_LIMITS.maxDelaySeconds,
      detectsStaleHandle: false,
      deadLettersById: false,
    };
    const queue = new SqsQueue({
      name, url, ...(deadLetterUrl === undefined ? {} : { deadLetterUrl }), facts, capabilities,
      client: this.#client, now: this.#now, onMalformed: this.#onMalformed, deliveredMemory: this.#deliveredMemory, scanLimit: this.#scanLimit,
    });
    return { queue, facts };
  }

  async #attributes(url: string, names: ("All" | "QueueArn" | "FifoQueue")[], operation: string): Promise<Record<string, string> | undefined> {
    try {
      const out = (await this.#client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: names }))) as GetQueueAttributesCommandOutput;
      return out.Attributes;
    } catch (error) {
      return failure(error, operation);
    }
  }
}

interface Delivered {
  messageId: string;
  body: string;
  attributes: Record<string, MessageAttributeValue>;
  groupId?: string;
  receiveCount: number;
  enqueuedAt: number;
}

interface SqsQueueSettings {
  name: string;
  url: string;
  deadLetterUrl?: string;
  facts: QueueFacts;
  capabilities: QueueCapabilities;
  client: SqsSender;
  now: () => number;
  onMalformed: (event: { queue: string; messageId: string }) => void;
  deliveredMemory: number;
  scanLimit: number;
}

class SqsQueue implements Queue {
  readonly name: string;
  readonly capabilities: QueueCapabilities;
  readonly #s: SqsQueueSettings;
  /** What this process delivered, by receipt handle, so `deadLetter` can carry the message along (a handle holds nothing). */
  readonly #delivered = new Map<string, Delivered>();
  /** Duplicate ids this process sent inside the window, for the `duplicate` flag (SQS does not say). */
  readonly #sent = new Map<string, { messageId: string; at: number }>();

  constructor(settings: SqsQueueSettings) {
    this.#s = settings;
    this.name = settings.name;
    this.capabilities = settings.capabilities;
  }

  async enqueue(input: QueueMessageInput): Promise<EnqueueResult> {
    const s = this.#s;
    const body = encodeBody(input.body);
    if (bytes(body) > QUEUE_LIMITS.maxBodyBytes) throw new Error(`a message body is at most ${QUEUE_LIMITS.maxBodyBytes} bytes`);
    const delay = input.delaySeconds === undefined ? 0 : wholeSeconds(input.delaySeconds, "delaySeconds", this.capabilities.maxDelaySeconds);
    const attributes = encodeAttributes(input.attributes, MAX_MESSAGE_ATTRIBUTES);
    const total = messageBytes(body, attributes);
    if (total > s.facts.maxMessageBytes) throw new Error(`a message and its attributes are at most ${s.facts.maxMessageBytes} bytes on this queue (this one is ${total})`);
    const dedupeId = input.dedupeId === undefined ? undefined : plainText(input.dedupeId, "dedupeId");
    const groupId = input.groupId === undefined ? undefined : plainText(input.groupId, "groupId");
    if (groupId !== undefined && s.facts.fifo && !ID_TEXT.test(groupId)) throw new Error("groupId is 1 to 128 letters, digits and punctuation (no spaces) on an ordered queue");

    const now = s.now();
    const key = dedupeId === undefined ? undefined : dedupeKey(dedupeId);
    let seen: { messageId: string; at: number } | undefined;
    if (this.capabilities.dedupe && key !== undefined) {
      this.#prune(now);
      const earlier = this.#sent.get(key);
      // `#prune` has dropped every id older than the window.
      if (earlier !== undefined) seen = earlier;
    }
    let out: SendMessageCommandOutput;
    try {
      out = (await s.client.send(new SendMessageCommand({
        QueueUrl: s.url,
        MessageBody: body,
        ...(Object.keys(attributes).length === 0 ? {} : { MessageAttributes: attributes }),
        ...(s.facts.fifo
          // FIFO wants a group and a deduplication id on every message. A message with no group gets a solo group (named after its dedupe
          // id when it has one); one with no dedupe id gets a fresh id (nothing is suppressed).
          ? { MessageGroupId: groupId ?? soloGroup(key), MessageDeduplicationId: key ?? randomUUID() }
          : delay === 0 ? {} : { DelaySeconds: delay }),
      }))) as SendMessageCommandOutput;
    } catch (error) {
      return failure(error, "SendMessage");
    }
    if (out.MessageId === undefined) throw new SqsQueueError("SQS SendMessage returned no message id");
    if (seen !== undefined) return { messageId: seen.messageId, duplicate: true };
    if (this.capabilities.dedupe && key !== undefined) this.#sent.set(key, { messageId: out.MessageId, at: now });
    return { messageId: out.MessageId, duplicate: false };
  }

  async receive(options: ReceiveOptions = {}): Promise<ReceivedMessage[]> {
    const s = this.#s;
    const max = options.maxMessages ?? 1;
    if (!Number.isInteger(max) || max < 1 || max > QUEUE_LIMITS.maxReceive) throw new Error(`maxMessages is 1 to ${QUEUE_LIMITS.maxReceive}`);
    const hideFor = options.visibilityTimeoutSeconds === undefined ? undefined : wholeSeconds(options.visibilityTimeoutSeconds, "visibilityTimeoutSeconds", QUEUE_LIMITS.maxSeconds);
    const wait = Math.min(wholeSeconds(options.waitSeconds ?? 0, "waitSeconds", QUEUE_LIMITS.maxSeconds), SQS_LIMITS.maxWaitSeconds);
    const received: ReceivedMessage[] = [];
    // An ordered queue is read one message per request: a FIFO request may hand over several messages of one group together, which the
    // port forbids, and the extra ones could not be put back without costing each a receive.
    const perRequest = s.facts.fifo ? 1 : max;
    for (let request = 0; received.length < max; request += 1) {
      const messages = await this.#request(Math.min(perRequest, max - received.length), hideFor, request === 0 ? wait : 0);
      if (messages.length === 0) break;
      received.push(...messages);
      if (!s.facts.fifo) break;
    }
    return received;
  }

  async ack(receiptHandle: string): Promise<boolean> {
    const handle = this.#handle(receiptHandle);
    try {
      await this.#s.client.send(new DeleteMessageCommand({ QueueUrl: this.#s.url, ReceiptHandle: handle })) as DeleteMessageCommandOutput;
    } catch (error) {
      if (isStaleHandleError(error)) {
        this.#delivered.delete(handle);
        return false;
      }
      return failure(error, "DeleteMessage");
    }
    this.#delivered.delete(handle);
    return true;
  }

  async changeVisibility(receiptHandle: string, seconds: number): Promise<boolean> {
    const handle = this.#handle(receiptHandle);
    const timeout = wholeSeconds(seconds, "seconds", QUEUE_LIMITS.maxSeconds);
    try {
      await this.#s.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.#s.url, ReceiptHandle: handle, VisibilityTimeout: timeout })) as ChangeMessageVisibilityCommandOutput;
      return true;
    } catch (error) {
      if (isStaleHandleError(error)) return false;
      return failure(error, "ChangeMessageVisibility");
    }
  }

  async deadLetter(receiptHandle: string, reason: string): Promise<boolean> {
    const s = this.#s;
    const handle = this.#handle(receiptHandle);
    plainText(reason, "the reason");
    if (reason === "") throw new Error("the reason is not empty");
    if (s.deadLetterUrl === undefined) throw new Error(`queue ${JSON.stringify(this.name)} declares no dead-letter queue`);
    const held = this.#delivered.get(handle);
    // A delivery this process did not make cannot be carried to the dead letters (the handle holds no body): it stays, and comes back.
    if (held === undefined) return false;
    const marker = JSON.stringify({ reason, at: new Date(s.now()).toISOString(), messageId: held.messageId, receiveCount: held.receiveCount, enqueuedAt: new Date(held.enqueuedAt).toISOString() });
    const withMarker = { ...held.attributes, [DEAD_LETTER_ATTRIBUTE]: { DataType: "String", StringValue: marker } };
    // Send first, then delete: a crash between the two leaves the message on both queues (at least once), never on neither. A marker that
    // would push the message over SQS's size is left off rather than lose the message.
    const attributes = messageBytes(held.body, withMarker) <= s.facts.maxMessageBytes ? withMarker : held.attributes;
    try {
      await s.client.send(new SendMessageCommand({
        QueueUrl: s.deadLetterUrl,
        MessageBody: held.body,
        ...(Object.keys(attributes).length === 0 ? {} : { MessageAttributes: attributes }),
        ...(s.facts.fifo ? { MessageGroupId: held.groupId ?? soloGroup(dedupeKey(`dead:${held.messageId}`)), MessageDeduplicationId: dedupeKey(`dead:${held.messageId}`) } : {}),
      }));
    } catch (error) {
      return failure(error, "SendMessage (dead letters)");
    }
    return this.ack(handle);
  }

  async listDeadLetters(options: { limit?: number; cursor?: string } = {}): Promise<{ items: DeadLetter[]; cursor?: string }> {
    const limit = options.limit ?? QUEUE_LIMITS.maxReceive;
    if (!Number.isInteger(limit) || limit < 1 || limit > QUEUE_LIMITS.maxReceive) throw new Error(`limit is 1 to ${QUEUE_LIMITS.maxReceive}: SQS shows a dead-letter queue only through receive, one batch at a time`);
    if (options.cursor !== undefined) throw new Error("SQS cannot page a dead-letter queue: there is no cursor");
    const url = this.#deadLetterUrl();
    // A look, not a take: the messages are hidden for no time at all. It is a sample (SQS may answer from some of its servers), not a census.
    const seen = new Map<string, DeadLetter>();
    for (const message of await this.#receiveFrom(url, limit, 0, 1)) {
      const entry = this.#deadLetterOf(message);
      if (entry !== undefined && !seen.has(entry.messageId)) seen.set(entry.messageId, entry);
    }
    return { items: [...seen.values()] };
  }

  async redrive(messageId: string): Promise<boolean> {
    const s = this.#s;
    const found = await this.#findDeadLetter(plainText(messageId, "the message id"));
    if (found === undefined) return false;
    const { message } = found;
    // The scan hid the message for a minute; if that has run out another reader may hold or have removed it, and sending now would duplicate it.
    if (!(await this.#hold(this.#deadLetterUrl(), message.ReceiptHandle))) return false;
    const attributes = { ...message.MessageAttributes };
    delete attributes[DEAD_LETTER_ATTRIBUTE];
    const groupId = message.Attributes?.MessageGroupId;
    try {
      await s.client.send(new SendMessageCommand({
        QueueUrl: s.url,
        MessageBody: message.Body ?? "",
        ...(Object.keys(attributes).length === 0 ? {} : { MessageAttributes: attributes }),
        ...(s.facts.fifo ? { MessageGroupId: groupId !== undefined && !groupId.startsWith(SOLO_GROUP_PREFIX) ? groupId : soloGroup(undefined), MessageDeduplicationId: randomUUID() } : {}),
      }));
    } catch (error) {
      return failure(error, "SendMessage (redrive)");
    }
    return this.#deleteFrom(this.#deadLetterUrl(), message.ReceiptHandle);
  }

  async discardDeadLetter(messageId: string): Promise<boolean> {
    const found = await this.#findDeadLetter(plainText(messageId, "the message id"));
    if (found === undefined) return false;
    return this.#deleteFrom(this.#deadLetterUrl(), found.message.ReceiptHandle);
  }

  // ---- internals ----

  #handle(receiptHandle: string): string {
    if (typeof receiptHandle !== "string" || receiptHandle === "" || receiptHandle.length > 1_024) throw new Error("the receipt handle is non-empty text of at most 1024 characters");
    return receiptHandle;
  }

  #deadLetterUrl(): string {
    if (this.#s.deadLetterUrl === undefined) throw new Error(`queue ${JSON.stringify(this.name)} declares no dead-letter queue`);
    return this.#s.deadLetterUrl;
  }

  #prune(now: number): void {
    for (const [key, entry] of this.#sent) if (now - entry.at >= DEDUPE_WINDOW_MS) this.#sent.delete(key);
    // A burst of distinct ids cannot grow the memory without bound: the oldest go first (a Map keeps insertion order).
    for (const key of this.#sent.keys()) {
      if (this.#sent.size <= DEDUPE_MEMORY) break;
      this.#sent.delete(key);
    }
  }

  async #request(count: number, hideFor: number | undefined, wait: number): Promise<ReceivedMessage[]> {
    const s = this.#s;
    const messages = await this.#receiveFrom(s.url, count, hideFor, wait);
    const out: ReceivedMessage[] = [];
    for (const message of messages) {
      let body: JsonValue;
      try {
        body = JSON.parse(message.Body ?? "") as JsonValue;
      } catch {
        // Not ours to deliver. It becomes visible again when its timeout ends and each receive counts toward the redrive budget, so a
        // poison message from another producer ends in the dead letters instead of blocking a consumer.
        s.onMalformed({ queue: this.name, messageId: message.MessageId ?? "" });
        continue;
      }
      if (message.ReceiptHandle === undefined || message.MessageId === undefined) throw new SqsQueueError("SQS ReceiveMessage returned a message without an id or handle");
      const attributes = this.#plainAttributes(message);
      const groupId = message.Attributes?.MessageGroupId;
      const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
      const enqueuedAt = Number(message.Attributes?.SentTimestamp ?? s.now());
      this.#remember(message.ReceiptHandle, {
        messageId: message.MessageId, body: message.Body ?? "", attributes: { ...message.MessageAttributes },
        ...(groupId === undefined || groupId.startsWith(SOLO_GROUP_PREFIX) ? {} : { groupId }), receiveCount, enqueuedAt,
      });
      out.push({
        messageId: message.MessageId,
        receiptHandle: message.ReceiptHandle,
        body,
        attributes,
        receiveCount: Number.isInteger(receiveCount) && receiveCount >= 1 ? receiveCount : 1,
        enqueuedAt: new Date(Number.isFinite(enqueuedAt) ? enqueuedAt : s.now()).toISOString(),
        ...(groupId === undefined || groupId.startsWith(SOLO_GROUP_PREFIX) ? {} : { groupId }),
      });
    }
    return out;
  }

  async #receiveFrom(url: string, count: number, hideFor: number | undefined, wait: number): Promise<Message[]> {
    try {
      const out = (await this.#s.client.send(new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: count,
        MessageAttributeNames: ["All"],
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "SentTimestamp", "MessageGroupId"],
        ...(hideFor === undefined ? {} : { VisibilityTimeout: hideFor }),
        ...(wait === 0 ? {} : { WaitTimeSeconds: wait }),
      }))) as ReceiveMessageCommandOutput;
      return out.Messages ?? [];
    } catch (error) {
      return failure(error, "ReceiveMessage");
    }
  }

  #plainAttributes(message: Message): Record<string, string> {
    const attributes: Record<string, string> = {};
    for (const [name, value] of Object.entries(message.MessageAttributes ?? {})) {
      if (name !== DEAD_LETTER_ATTRIBUTE && value.DataType === "String" && value.StringValue !== undefined) attributes[name] = value.StringValue;
    }
    return attributes;
  }

  #remember(handle: string, entry: Delivered): void {
    this.#delivered.set(handle, entry);
    for (const key of this.#delivered.keys()) {
      if (this.#delivered.size <= this.#s.deliveredMemory) break;
      this.#delivered.delete(key);
    }
  }

  #deadLetterOf(message: Message): DeadLetter | undefined {
    let body: JsonValue;
    try {
      body = JSON.parse(message.Body ?? "") as JsonValue;
    } catch {
      return undefined;
    }
    let marker: { reason?: unknown; at?: unknown; messageId?: unknown; receiveCount?: unknown } = {};
    const raw = message.MessageAttributes?.[DEAD_LETTER_ATTRIBUTE]?.StringValue;
    if (raw !== undefined) {
      try {
        marker = JSON.parse(raw) as typeof marker;
      } catch {
        marker = {};
      }
    }
    const receiveCount = typeof marker.receiveCount === "number" ? marker.receiveCount : Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    const at = typeof marker.at === "string" ? marker.at : new Date(Number(message.Attributes?.SentTimestamp ?? this.#s.now())).toISOString();
    return {
      messageId: typeof marker.messageId === "string" ? marker.messageId : message.MessageId ?? "",
      body,
      attributes: this.#plainAttributes(message),
      receiveCount: Number.isInteger(receiveCount) && receiveCount >= 1 ? receiveCount : 1,
      deadLetteredAt: at,
      reason: typeof marker.reason === "string" ? marker.reason : "max_receives",
    };
  }

  /**
   * Looks through the dead-letter queue for one message by the id the core knows it by. SQS has no lookup, so this takes messages in
   * batches (hidden for a minute), keeps the ones that do not match hidden until the scan ends so that no batch brings one it has already
   * looked at, then puts them all back. It stops when it finds the one, when a batch brings nothing new, or at the scan limit. A message
   * not found in that many is reported missing: with a very large dead-letter queue use SQS's own redrive.
   */
  async #findDeadLetter(messageId: string): Promise<{ message: Message; entry: DeadLetter } | undefined> {
    const url = this.#deadLetterUrl();
    const seen = new Set<string>();
    const others: string[] = [];
    try {
      while (seen.size < this.#s.scanLimit) {
        const batch = await this.#receiveFrom(url, QUEUE_LIMITS.maxReceive, 60, 1);
        let fresh = 0;
        let found: { message: Message; entry: DeadLetter } | undefined;
        for (const message of batch) {
          const entry = this.#deadLetterOf(message);
          if (message.MessageId !== undefined && !seen.has(message.MessageId)) {
            seen.add(message.MessageId);
            fresh += 1;
          }
          if (found === undefined && entry !== undefined && (entry.messageId === messageId || message.MessageId === messageId)) found = { message, entry };
          else if (message.ReceiptHandle !== undefined) others.push(message.ReceiptHandle);
        }
        if (found !== undefined) return found;
        if (fresh === 0) return undefined;
      }
      return undefined;
    } finally {
      for (const handle of others) await this.#release(url, handle);
    }
  }

  /** Hides a message found by the scan for another minute. False when SQS no longer knows the handle (another reader took or removed it). */
  async #hold(url: string, receiptHandle: string | undefined): Promise<boolean> {
    if (receiptHandle === undefined) return false;
    try {
      await this.#s.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: receiptHandle, VisibilityTimeout: 60 }));
      return true;
    } catch (error) {
      if (isStaleHandleError(error)) return false;
      return failure(error, "ChangeMessageVisibility (dead letters)");
    }
  }

  async #release(url: string, receiptHandle: string): Promise<void> {
    try {
      await this.#s.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: receiptHandle, VisibilityTimeout: 0 }));
    } catch (error) {
      // It comes back by itself when its minute ends.
      if (!isStaleHandleError(error)) failure(error, "ChangeMessageVisibility (dead letters)");
    }
  }

  async #deleteFrom(url: string, receiptHandle: string | undefined): Promise<boolean> {
    if (receiptHandle === undefined) return false;
    try {
      await this.#s.client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: receiptHandle }));
      return true;
    } catch (error) {
      if (isStaleHandleError(error)) return false;
      return failure(error, "DeleteMessage (dead letters)");
    }
  }
}
