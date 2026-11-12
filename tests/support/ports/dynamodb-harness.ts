// Convergence lane A1: builds the DynamoDB document store over the in-memory DynamoDB double, with its change feed fed the way the
// hosted stream reader feeds it (each committed record handed to `deliver`, in commit order).
import { OUTBOX_PENDING_INDEX, type IndexDefinition } from "@agentx/contracts";
import { DynamoDocumentStore, DynamoStreamChangeFeed, type DynamoStreamChangeFeedOptions } from "../../../packages/aws-adapters/src/index.js";
import { CONFORMANCE_INDEXES, type DocumentStoreHarness, type DocumentStoreUnderTest } from "./document-store-conformance.js";
import { FakeDynamoDb } from "./dynamodb-fake.js";

/** The consumer names the conformance suite subscribes (a stream reader declares its consumers). */
export const CONFORMANCE_CONSUMERS = ["suite", "flaky", "latecomer", "stubborn", "one", "two", "durable", "old-hand", "newcomer"] as const;

export interface DynamoWorld {
  fake: FakeDynamoDb;
  store: DynamoDocumentStore;
  feed: DynamoStreamChangeFeed;
  /** Waits until every record committed so far has been handed over and handled. */
  settled: () => Promise<void>;
}

export function dynamoWorld(options: { indexes?: readonly IndexDefinition[]; ttlAttribute?: string; feed?: Partial<DynamoStreamChangeFeedOptions>; pageBytes?: number; conflictAttempts?: number } = {}): DynamoWorld {
  const indexes = options.indexes ?? [...CONFORMANCE_INDEXES, OUTBOX_PENDING_INDEX];
  const ttlAttribute = options.ttlAttribute ?? "expiresAt";
  const fake = new FakeDynamoDb({ tableName: "State", indexes, ttlAttribute, ...(options.pageBytes === undefined ? {} : { pageBytes: options.pageBytes }) });
  const feed = new DynamoStreamChangeFeed({ consumers: CONFORMANCE_CONSUMERS, maxAttempts: 4, retryDelayMs: 1, ...options.feed });
  let pending: Promise<void> = Promise.resolve();
  fake.onStream((record) => {
    const delivery = feed.deliver([record]).catch(() => undefined);
    pending = pending.then(() => delivery);
  });
  const store = new DynamoDocumentStore({ client: fake, tableName: "State", indexes, ttlAttribute, changes: feed, retryBaseMs: 1, ...(options.conflictAttempts === undefined ? {} : { conflictAttempts: options.conflictAttempts }) });
  return {
    fake,
    store,
    feed,
    settled: async () => {
      let seen: Promise<void> | undefined;
      while (seen !== pending) {
        seen = pending;
        await seen;
      }
    },
  };
}

export function dynamoStoreHarness(): DocumentStoreHarness {
  return {
    async create(): Promise<DocumentStoreUnderTest> {
      const world = dynamoWorld();
      return { store: world.store, settleFeed: world.settled, sweepExpired: async () => void world.fake.sweepExpired() };
    },
  };
}
