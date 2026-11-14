// Port lane W0: the in-memory document store passes the shared conformance suite, and the pure rules behave as written.
import { describe, expect, it } from "vitest";
import { DocumentStoreError, OUTBOX_PENDING_INDEX, applyUpdateOps, change, compareText, companyOfKey, companyScoped, deepEqual, evaluateCondition, when, type StoredDocument } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { CONFORMANCE_INDEXES, runDocumentStoreConformance } from "../support/ports/document-store-conformance.js";

runDocumentStoreConformance("in-memory fake", {
  async create() {
    const store = new MemoryDocumentStore({ indexes: [...CONFORMANCE_INDEXES, OUTBOX_PENDING_INDEX], ttlAttribute: "expiresAt" });
    return { store, settleFeed: () => store.settled(), sweepExpired: async () => void store.sweepExpired() };
  },
});

describe("document store rules", () => {
  it("orders text by code point, not by UTF-16 unit", () => {
    expect(compareText("～", "\u{1F600}")).toBeLessThan(0);
    expect(["\u{1F600}", "b", "a"].sort(compareText)).toEqual(["a", "b", "\u{1F600}"]);
    expect(compareText("a", "a")).toBe(0);
    expect(compareText("a", "ab")).toBeLessThan(0);
  });

  it("compares documents deeply", () => {
    expect(deepEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
  });

  it("evaluates a condition on an absent item as every path missing", () => {
    expect(evaluateCondition(undefined, when.absent())).toBe(true);
    expect(evaluateCondition(undefined, when.present())).toBe(false);
    expect(evaluateCondition(undefined, when.not(when.eq("a", 1)))).toBe(true);
  });

  it("applies an update without touching the input", () => {
    const original: StoredDocument = { pk: "p", sk: "s", n: 1 };
    const next = applyUpdateOps(original, original, [change.add("n", 2)]);
    expect(next.n).toBe(3);
    expect(original.n).toBe(1);
    expect(() => applyUpdateOps(original, original, [change.set("m.x", 1)])).toThrow(/parent/);
  });

  it("scopes keys to a company and reads the company back", () => {
    const pk = companyScoped("org_abc", "TASK#1");
    expect(pk).toBe("ORG#org_abc#TASK#1");
    expect(companyOfKey(pk)).toBe("org_abc");
    expect(companyOfKey("CHANNEL_ADAPTERS")).toBeUndefined();
    expect(() => companyScoped("org#bad", "x")).toThrow();
  });
});

describe("the in-memory store as a test double", () => {
  it("fails the next calls on request, as a throttled store does", async () => {
    const store = new MemoryDocumentStore();
    store.injectFault(new DocumentStoreError("throttled", "slow down"), 2);
    await expect(store.put({ item: { pk: "p", sk: "s" } })).rejects.toMatchObject({ code: "throttled", retryable: true });
    await expect(store.get({ pk: "p", sk: "s" })).rejects.toMatchObject({ code: "throttled" });
    expect((await store.put({ item: { pk: "p", sk: "s" } })).applied).toBe(true);
  });

  it("marks a removal by the sweep as expired, and any other as a write", async () => {
    let now = 1_000;
    const store = new MemoryDocumentStore({ ttlAttribute: "expiresAt", nowSeconds: () => now });
    const causes: string[] = [];
    await store.changes!.subscribe("c", async (batch) => void causes.push(...batch.map((change) => `${change.kind}:${change.cause}`)));
    await store.put({ item: { pk: "p", sk: "a", expiresAt: 1_500 } });
    await store.put({ item: { pk: "p", sk: "b" } });
    await store.delete({ key: { pk: "p", sk: "b" } });
    now = 2_000;
    store.sweepExpired();
    await store.settled();
    expect(causes).toEqual(["insert:write", "insert:write", "remove:write", "remove:expired"]);
  });

  it("calls onPoison and counts a batch the consumer never handled, then goes on", async () => {
    const store = new MemoryDocumentStore();
    const poisoned: number[] = [];
    await store.changes!.subscribe("bad", async () => { throw new Error("always"); }, { onPoison: (batch) => void poisoned.push(batch.length) });
    await store.put({ item: { pk: "p", sk: "a" } });
    await store.settled();
    for (let waited = 0; store.droppedBatches === 0 && waited < 2_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.droppedBatches).toBe(1);
    expect(poisoned).toEqual([1]);
  });
});
