// Convergence lane A1: builds the DynamoDB document store over the in-memory DynamoDB double, with its change feed fed the way the
// hosted stream reader feeds it (each committed record handed to `deliver`, in commit order).
import { OUTBOX_PENDING_INDEX, type ChangeSubscription, type DocumentChange, type DocumentChangeFeed, type IndexDefinition } from "@agentx/contracts";
import { DynamoDocumentStore, DynamoStreamChangeFeed, type DynamoDocumentStoreOptions, type DynamoStreamChangeFeedOptions, type DynamoStreamRecord } from "../../../packages/aws-adapters/src/index.js";
import { CONFORMANCE_INDEXES, type DocumentStoreHarness, type DocumentStoreUnderTest } from "./document-store-conformance.js";
import { FakeDynamoDb } from "./dynamodb-fake.js";

/**
 * The change feed as the hosted product runs it: one stream reader per consumer, each a `DynamoStreamChangeFeed` that declares just
 * that consumer. A reader exists from its consumer's subscription until it stops, so a change committed while no reader for a name
 * exists is not owed to that name (the suite's "starts at the present"); every reader is handed each record at commit, in commit order.
 */
class ReadersPerConsumer implements DocumentChangeFeed {
  readonly #readers = new Set<DynamoStreamChangeFeed>();
  #pending: Promise<void> = Promise.resolve();
  constructor(private readonly options: Partial<DynamoStreamChangeFeedOptions>) {}

  hand(record: DynamoStreamRecord): void {
    for (const reader of this.#readers) {
      // A refused batch (a consumer stopped during it) is the mapping's to retry; here the reader is gone with its consumer.
      const delivery = reader.deliver([record]).catch(() => undefined);
      this.#pending = this.#pending.then(() => delivery);
    }
  }

  async settled(): Promise<void> {
    let seen: Promise<void> | undefined;
    while (seen !== this.#pending) {
      seen = this.#pending;
      await seen;
    }
  }

  async subscribe(consumer: string, handler: (changes: readonly DocumentChange[]) => Promise<void>, options?: { onPoison?: (changes: readonly DocumentChange[], error: unknown) => void }): Promise<ChangeSubscription> {
    const reader = new DynamoStreamChangeFeed({ maxAttempts: 4, retryDelayMs: 1, ...this.options, consumers: [consumer] });
    const subscription = await reader.subscribe(consumer, handler, options);
    this.#readers.add(reader);
    return {
      stop: async () => {
        this.#readers.delete(reader);
        await subscription.stop();
      },
    };
  }
}

export interface DynamoWorld {
  fake: FakeDynamoDb;
  store: DynamoDocumentStore;
  /** Waits until every record committed so far has been handed over and handled. */
  settled: () => Promise<void>;
}

export function dynamoWorld(options: { indexes?: readonly IndexDefinition[]; ttlAttribute?: string; feed?: Partial<DynamoStreamChangeFeedOptions>; pageBytes?: number; conflictAttempts?: number; store?: Partial<DynamoDocumentStoreOptions> } = {}): DynamoWorld {
  const indexes = options.indexes ?? [...CONFORMANCE_INDEXES, OUTBOX_PENDING_INDEX];
  const ttlAttribute = options.ttlAttribute ?? "expiresAt";
  const fake = new FakeDynamoDb({ tableName: "State", indexes, ttlAttribute, ...(options.pageBytes === undefined ? {} : { pageBytes: options.pageBytes }) });
  const readers = new ReadersPerConsumer(options.feed ?? {});
  fake.onStream((record) => readers.hand(record));
  const store = new DynamoDocumentStore({ client: fake, tableName: "State", indexes, ttlAttribute, changes: readers, retryBaseMs: 1, ...(options.conflictAttempts === undefined ? {} : { conflictAttempts: options.conflictAttempts }), ...options.store });
  return { fake, store, settled: () => readers.settled() };
}

export function dynamoStoreHarness(): DocumentStoreHarness {
  return {
    async create(): Promise<DocumentStoreUnderTest> {
      // The port's own number range (to 9.99e125): the suite pins it. The default, narrower range for the hosted broker is tested apart.
      const world = dynamoWorld({ store: { cloudReadableNumbers: false } });
      return { store: world.store, settleFeed: world.settled, sweepExpired: async () => void world.fake.sweepExpired() };
    },
  };
}
