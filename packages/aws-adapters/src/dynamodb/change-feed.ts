// Convergence lane A1: the document store's change feed over the table's DynamoDB stream, read by an existing stream reader.
//
// The State table's stream already has two readers (the per-shard maximum), so this feed adds no reader and polls nothing: the host's
// stream-reader entry point (a Lambda handler on an existing event source mapping) hands each batch of stream records to `deliver`,
// and the feed passes the changes to every consumer subscribed in that process. What the port asks of a feed maps onto the reader:
//  - At least once, in commit order for one key: the event source mapping delivers a shard's records in order and keeps the
//    checkpoint, so a crashed or timed-out batch comes again (the durable checkpoint per name is the mapping's, set up in the deployment).
//  - Starts at the present: the mapping's starting position is LATEST; a consumer subscribed in this process sees the batches handed
//    over after it subscribed.
//  - Bounded retries, then `onPoison`: a throwing handler is called again with the same changes up to `maxAttempts` times, then
//    `onPoison` is told and the batch counts as handled for that consumer, so one bad batch cannot hold a shard for ever. `deliver`
//    itself therefore resolves once every consumer has handled or given up on the batch, and the mapping moves on.
//  - `cause: "expired"`: DynamoDB marks a time-to-live removal with the service principal as the record's user identity.
// Consumer names are declared when the feed is built (as the readers are declared in the deployment); subscribing to another name is
// refused. A record that cannot be read as a document (a set or bytes, decision 60) is reported to `onUnreadable` and left out.
import { DocumentStoreError, type ChangeSubscription, type DocumentChange, type DocumentChangeFeed, type DocumentKey, type StoredDocument } from "@agentx/contracts";
import { fromWireItem, type WireItem } from "./attribute-values.js";

/** One record of a DynamoDB stream, as a Lambda event source mapping (or the streams API) hands it over. */
export interface DynamoStreamRecord {
  eventID?: string;
  /** INSERT, MODIFY or REMOVE. */
  eventName?: string;
  dynamodb?: {
    Keys?: WireItem;
    NewImage?: WireItem;
    OldImage?: WireItem;
    SequenceNumber?: string;
    ApproximateCreationDateTime?: number | Date;
  };
  userIdentity?: { type?: string; principalId?: string };
}

/** DynamoDB's sequence numbers are decimal text of growing length; padded, they sort as text in the order they sort as numbers. */
export const SEQUENCE_WIDTH = 40;

/** A stream record as a port change. Throws for a record without the parts a NEW_AND_OLD_IMAGES stream always carries. */
export function changeOfRecord(record: DynamoStreamRecord): DocumentChange {
  const kind = record.eventName === "INSERT" ? "insert" : record.eventName === "MODIFY" ? "modify" : record.eventName === "REMOVE" ? "remove" : undefined;
  if (kind === undefined) throw new DocumentStoreError("unavailable", `a stream record has an unknown event name`);
  const data = record.dynamodb;
  const sequence = data?.SequenceNumber;
  if (sequence === undefined || !/^\d{1,40}$/.test(sequence)) throw new DocumentStoreError("unavailable", "a stream record has no sequence number");
  const keys = data?.Keys;
  if (keys?.pk?.S === undefined || keys.sk?.S === undefined) throw new DocumentStoreError("unavailable", "a stream record has no text pk and sk");
  const key: DocumentKey = { pk: keys.pk.S, sk: keys.sk.S };
  const before: StoredDocument | undefined = data?.OldImage === undefined ? undefined : fromWireItem(data.OldImage);
  const after: StoredDocument | undefined = data?.NewImage === undefined ? undefined : fromWireItem(data.NewImage);
  if (kind !== "insert" && before === undefined) throw new DocumentStoreError("unavailable", "a stream record has no old image (the stream must be NEW_AND_OLD_IMAGES)");
  if (kind !== "remove" && after === undefined) throw new DocumentStoreError("unavailable", "a stream record has no new image (the stream must be NEW_AND_OLD_IMAGES)");
  const expired = kind === "remove" && record.userIdentity?.type === "Service" && record.userIdentity.principalId === "dynamodb.amazonaws.com";
  return {
    sequence: sequence.padStart(SEQUENCE_WIDTH, "0"),
    kind,
    cause: expired ? "expired" : "write",
    key,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  };
}

export interface DynamoStreamChangeFeedOptions {
  /** The consumer names this process may subscribe. */
  consumers: readonly string[];
  /** Calls of a handler for one batch before the feed gives up on it. Default 3. */
  maxAttempts?: number;
  /** Wait before calling a failed handler again; doubles each time. Default 100 ms. */
  retryDelayMs?: number;
  /** Told about a record that is not a readable document; it is left out of the batch. */
  onUnreadable?: (record: DynamoStreamRecord, error: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

interface Subscriber {
  handler: (changes: readonly DocumentChange[]) => Promise<void>;
  onPoison?: (changes: readonly DocumentChange[], error: unknown) => void;
  stopped: boolean;
  running?: Promise<void>;
}

export class DynamoStreamChangeFeed implements DocumentChangeFeed {
  readonly #consumers: ReadonlySet<string>;
  readonly #subscribers = new Map<string, Subscriber>();
  readonly #maxAttempts: number;
  readonly #retryDelayMs: number;
  readonly #onUnreadable: ((record: DynamoStreamRecord, error: unknown) => void) | undefined;
  readonly #sleep: (ms: number) => Promise<void>;
  /** Batches are handed over one at a time, so one consumer never sees two batches at once nor out of order. */
  #tail: Promise<void> = Promise.resolve();

  constructor(options: DynamoStreamChangeFeedOptions) {
    if (options.consumers.length === 0) throw new DocumentStoreError("invalid_request", "a change feed declares at least one consumer");
    this.#consumers = new Set(options.consumers);
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.#retryDelayMs = Math.max(0, options.retryDelayMs ?? 100);
    this.#onUnreadable = options.onUnreadable;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async subscribe(
    consumer: string,
    handler: (changes: readonly DocumentChange[]) => Promise<void>,
    options: { onPoison?: (changes: readonly DocumentChange[], error: unknown) => void } = {},
  ): Promise<ChangeSubscription> {
    if (!this.#consumers.has(consumer)) throw new DocumentStoreError("invalid_request", `the consumer ${JSON.stringify(consumer).slice(0, 60)} is not declared for this stream reader`);
    if (this.#subscribers.has(consumer)) throw new DocumentStoreError("invalid_request", `the consumer ${JSON.stringify(consumer).slice(0, 60)} is already subscribed`);
    const subscriber: Subscriber = { handler, stopped: false, ...(options.onPoison === undefined ? {} : { onPoison: options.onPoison }) };
    this.#subscribers.set(consumer, subscriber);
    return {
      stop: async () => {
        subscriber.stopped = true;
        if (this.#subscribers.get(consumer) === subscriber) this.#subscribers.delete(consumer);
        await subscriber.running;
      },
    };
  }

  /**
   * The stream reader's entry: hand it a batch of stream records (a Lambda event's `Records`). Resolves when every consumer subscribed
   * now has handled the batch or given up on it; rejects only if a record cannot be read and no `onUnreadable` is given, so the
   * mapping retries (and, past its own limit, sends the batch to its failure destination).
   */
  deliver(records: readonly DynamoStreamRecord[]): Promise<void> {
    // The consumers are those subscribed when the batch is handed over: one that subscribes later starts after it.
    const subscribers = [...this.#subscribers.values()];
    const run = this.#tail.then(() => this.#deliver(records, subscribers));
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #deliver(records: readonly DynamoStreamRecord[], subscribers: readonly Subscriber[]): Promise<void> {
    const changes: DocumentChange[] = [];
    for (const record of records) {
      try {
        changes.push(changeOfRecord(record));
      } catch (error) {
        if (this.#onUnreadable === undefined) throw error;
        this.#onUnreadable(record, error);
      }
    }
    if (changes.length === 0) return;
    const batch = Object.freeze(changes);
    await Promise.all(subscribers.map((subscriber) => {
      const running = this.#handOver(subscriber, batch);
      subscriber.running = running;
      return running;
    }));
  }

  async #handOver(subscriber: Subscriber, batch: readonly DocumentChange[]): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      if (subscriber.stopped) return;
      try {
        // Each consumer gets its own copies, so one cannot change what another sees.
        await subscriber.handler(structuredClone(batch));
        return;
      } catch (error) {
        lastError = error;
        if (attempt < this.#maxAttempts) await this.#sleep(this.#retryDelayMs * 2 ** (attempt - 1));
      }
    }
    if (subscriber.stopped) return;
    try {
      subscriber.onPoison?.(batch, lastError);
    } catch {
      // A failing poison report must not hold the shard either.
    }
  }
}
