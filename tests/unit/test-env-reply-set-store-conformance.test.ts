// TE-R1 part A: the Code reply-set store service passes the shared conformance suite and the two-company kit, over the in-memory store and over SQLite (the laptop's store).
import { runReplySetStoreConformance } from "@agentx/testing/ports/reply-set-store-conformance";
import { memoryReplyStoreHarness, sqliteReplyStoreHarness } from "../support/ports/reply-set-store-harness.js";

runReplySetStoreConformance("code service over the in-memory document store", memoryReplyStoreHarness);
runReplySetStoreConformance("code service over SQLite", sqliteReplyStoreHarness);
