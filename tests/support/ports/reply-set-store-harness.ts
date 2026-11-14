// TE-R1 part A: harnesses that build the reply-set store service (`createReplySetStore`) over the in-memory document store and over SQLite, for the shared conformance suite.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INDEX_EXPIRY_ATTRIBUTE } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { createReplySetStore } from "../../../packages/broker/src/core/test-env/reply-set-store.js";
import { SqliteDocumentStore } from "../../../packages/local-adapters/src/index.js";
import type { ReplySetStoreCreateOptions, ReplySetStoreHarness } from "@agentx/testing/ports/reply-set-store-conformance";

export const memoryReplyStoreHarness: ReplySetStoreHarness = {
  async create(options: ReplySetStoreCreateOptions = {}) {
    const store = new MemoryDocumentStore({ ttlAttribute: INDEX_EXPIRY_ATTRIBUTE });
    return { service: createReplySetStore({ store, ...options }) };
  },
};

export const sqliteReplyStoreHarness: ReplySetStoreHarness = {
  async create(options: ReplySetStoreCreateOptions = {}) {
    const folder = await mkdtemp(join(tmpdir(), "reply-store-"));
    const store = SqliteDocumentStore.open({ path: join(folder, "state.db"), ttlAttribute: INDEX_EXPIRY_ATTRIBUTE, sweepIntervalMs: 0, busyTimeoutMs: 2_000 });
    return {
      service: createReplySetStore({ store, ...options }),
      dispose: async () => {
        await store.close();
        await rm(folder, { recursive: true, force: true });
      },
    };
  },
};
