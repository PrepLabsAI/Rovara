// Port lane W0: the in-memory document store passes the shared conformance suite, and the pure rules behave as written.
import { describe, expect, it } from "vitest";
import { OUTBOX_PENDING_INDEX, applyUpdateOps, change, compareText, companyOfKey, companyScoped, deepEqual, evaluateCondition, when, type StoredDocument } from "@agentx/contracts";
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

  it("applies update steps in order and does not touch the input", () => {
    const original: StoredDocument = { pk: "p", sk: "s", n: 1 };
    const next = applyUpdateOps(original, original, [change.add("n", 2), change.set("m.x", 1)].slice(0, 1));
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
