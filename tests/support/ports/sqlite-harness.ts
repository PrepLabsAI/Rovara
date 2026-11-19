// Port lane L3: harnesses that build the SQLite adapters for the shared conformance suites. Each store gets its own folder, removed at dispose.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTBOX_PENDING_INDEX } from "@agentx/contracts";
import { SqliteDocumentStore } from "../../../packages/local-adapters/src/index.js";
import { CONFORMANCE_INDEXES, type DocumentStoreHarness, type DocumentStoreUnderTest } from "./document-store-conformance.js";

export const FAST_FEED = { pollMs: 20, retryDelayMs: 2, maxAttempts: 8, batchSize: 100 } as const;

export function sqliteStoreHarness(extra: { synchronous?: "FULL" | "NORMAL" } = {}): DocumentStoreHarness {
  return {
    async create() {
      const folder = await mkdtemp(join(tmpdir(), "local-store-"));
      const path = join(folder, "state.db");
      const stores: SqliteDocumentStore[] = [];
      const open = (): DocumentStoreUnderTest => {
        const store = SqliteDocumentStore.open({ path, indexes: [...CONFORMANCE_INDEXES, OUTBOX_PENDING_INDEX], ttlAttribute: "expiresAt", sweepIntervalMs: 0, changeFeed: FAST_FEED, busyTimeoutMs: 2_000, ...extra });
        stores.push(store);
        return {
          store,
          settleFeed: () => store.settled(),
          sweepExpired: async () => void store.sweepExpired(),
          dispose: async () => {
            for (const each of stores) await each.close();
            await rm(folder, { recursive: true, force: true });
          },
          reopen: async () => {
            await store.close();
            return open();
          },
        };
      };
      return open();
    },
  };
}
