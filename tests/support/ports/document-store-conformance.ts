// Port lane W0: the conformance suite every document store adapter must pass (DynamoDB, SQLite, the in-memory fake).
//
// An adapter's test file calls `runDocumentStoreConformance(name, harness)`. The harness builds a fresh, empty store for each
// test and says how to wait for an index or the change feed to catch up (a store that is consistent at once passes nothing).
import { describe, expect, it } from "vitest";
import {
  DOCUMENT_STORE_LIMITS,
  DocumentStoreError,
  change,
  companyScoped,
  queryAll,
  queryIndexAll,
  when,
  type Condition,
  type DocumentChange,
  type DocumentStore,
  type IndexDefinition,
  type StoredDocument,
} from "@agentx/contracts";

/** The indexes the suite needs the store to keep. The harness passes them to the adapter when it builds the store. */
export const CONFORMANCE_INDEXES: readonly IndexDefinition[] = [
  { name: "byKind", partitionAttribute: "kind", sortAttribute: "rank", sortType: "number" },
  { name: "byOwner", partitionAttribute: "owner" },
];

export interface DocumentStoreUnderTest {
  store: DocumentStore;
  /** Waits until index reads show every write so far. Absent: indexes are consistent at once. */
  settleIndexes?: () => Promise<void>;
  /** Waits until the change feed has handed every committed change to its consumers. Absent: the suite polls. */
  settleFeed?: () => Promise<void>;
  /** Runs the background sweep of expired documents (only for stores with a `ttlAttribute`), and waits for it. */
  sweepExpired?: () => Promise<void>;
  dispose?: () => Promise<void>;
  /**
   * Only for a store that keeps its data: shuts this store down cleanly and opens a new one over the same data, as a restart of the
   * process does. This store must not be used afterwards. `dispose` on any generation cleans up all of them. Absent: the store
   * keeps nothing across a restart (the in-memory fake), and the restart cases are skipped.
   */
  reopen?: () => Promise<DocumentStoreUnderTest>;
}

export interface DocumentStoreHarness {
  /** A fresh empty store that keeps `CONFORMANCE_INDEXES` (and `ttlAttribute: "expiresAt"` if it supports one). */
  create(): Promise<DocumentStoreUnderTest>;
}

const A = companyScoped("org_aaaaaaaaaaaaaaaaaaaa", "THING#1");
const B = companyScoped("org_bbbbbbbbbbbbbbbbbbbb", "THING#1");

async function withStore<T>(harness: DocumentStoreHarness, body: (under: DocumentStoreUnderTest) => Promise<T>): Promise<T> {
  const under = await harness.create();
  try {
    return await body(under);
  } finally {
    await under.dispose?.();
  }
}

const doc = (pk: string, sk: string, extra: Record<string, StoredDocument[string]> = {}): StoredDocument => ({ pk, sk, ...extra });

async function rejects(promise: Promise<unknown>): Promise<DocumentStoreError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentStoreError);
    expect((error as DocumentStoreError).code).toBe("invalid_request");
    return error as DocumentStoreError;
  }
  throw new Error("expected the call to be refused");
}

export function runDocumentStoreConformance(name: string, harness: DocumentStoreHarness): void {
  describe(`document store conformance: ${name}`, () => {
    describe("get, put and delete", () => {
      it("reads nothing for a key that is not there, and what was put for one that is", () => withStore(harness, async ({ store }) => {
        expect(await store.get({ pk: A, sk: "META" })).toBeUndefined();
        const item = doc(A, "META", { title: "hello", n: 3, flag: true, nothing: null, list: [1, "two", { three: 3 }], nested: { deep: { deeper: "x" } }, text: "naive café \u{1F600}" });
        expect(await store.put({ item })).toEqual({ applied: true });
        expect(await store.get({ pk: A, sk: "META" })).toEqual(item);
      }));

      it("hands out copies: changing a returned document changes nothing stored", () => withStore(harness, async ({ store }) => {
        await store.put({ item: doc(A, "META", { nested: { a: 1 } }) });
        const first = (await store.get({ pk: A, sk: "META" }))!;
        (first.nested as { a: number }).a = 99;
        expect(((await store.get({ pk: A, sk: "META" }))!.nested as { a: number }).a).toBe(1);
      }));

      it("keeps the same sort key under two partitions apart, and company scopes apart", () => withStore(harness, async ({ store }) => {
        await store.put({ item: doc(A, "META", { who: "a" }) });
        await store.put({ item: doc(B, "META", { who: "b" }) });
        expect((await store.get({ pk: A, sk: "META" }))!.who).toBe("a");
        expect((await store.get({ pk: B, sk: "META" }))!.who).toBe("b");
      }));

      it("replaces a document on put and can answer with the old one", () => withStore(harness, async ({ store }) => {
        await store.put({ item: doc(A, "META", { v: 1 }) });
        const result = await store.put({ item: doc(A, "META", { v: 2, only: "new" }), return: "old" });
        expect(result).toEqual({ applied: true, item: doc(A, "META", { v: 1 }) });
        expect(await store.get({ pk: A, sk: "META" })).toEqual(doc(A, "META", { v: 2, only: "new" }));
        expect(await store.put({ item: doc(A, "OTHER"), return: "old" })).toEqual({ applied: true });
      }));

      it("refuses a put whose condition fails and leaves the stored document alone", () => withStore(harness, async ({ store }) => {
        expect((await store.put({ item: doc(A, "META", { v: 1 }), condition: when.absent() })).applied).toBe(true);
        expect(await store.put({ item: doc(A, "META", { v: 2 }), condition: when.absent() })).toEqual({ applied: false, reason: "condition_failed" });
        expect((await store.get({ pk: A, sk: "META" }))!.v).toBe(1);
        expect((await store.put({ item: doc(A, "META", { v: 3 }), condition: when.eq("v", 1) })).applied).toBe(true);
        expect((await store.put({ item: doc(A, "META", { v: 4 }), condition: when.eq("v", 1) })).applied).toBe(false);
      }));

      it("deletes, with and without a condition, and answers with the old document on request", () => withStore(harness, async ({ store }) => {
        await store.put({ item: doc(A, "META", { v: 1 }) });
        expect(await store.delete({ key: { pk: A, sk: "META" }, condition: when.eq("v", 2) })).toEqual({ applied: false, reason: "condition_failed" });
        expect(await store.delete({ key: { pk: A, sk: "META" }, return: "old" })).toEqual({ applied: true, item: doc(A, "META", { v: 1 }) });
        expect(await store.get({ pk: A, sk: "META" })).toBeUndefined();
        expect(await store.delete({ key: { pk: A, sk: "META" } })).toEqual({ applied: true });
        expect(await store.delete({ key: { pk: A, sk: "META" }, condition: when.present() })).toEqual({ applied: false, reason: "condition_failed" });
      }));

      it("reads many documents in the order asked, with undefined for the missing", () => withStore(harness, async ({ store }) => {
        await store.put({ item: doc(A, "1", { n: 1 }) });
        await store.put({ item: doc(A, "3", { n: 3 }) });
        const found = await store.getMany([{ pk: A, sk: "3" }, { pk: A, sk: "2" }, { pk: A, sk: "1" }]);
        expect(found.map((item) => item?.n)).toEqual([3, undefined, 1]);
        await rejects(store.getMany(Array.from({ length: DOCUMENT_STORE_LIMITS.maxGetMany + 1 }, (_, index) => ({ pk: A, sk: String(index) }))));
      }));
    });

    describe("what the port accepts", () => {
      it("refuses bad keys", () => withStore(harness, async ({ store }) => {
        await rejects(store.put({ item: doc("", "x") }));
        await rejects(store.put({ item: doc(A, "") }));
        await rejects(store.put({ item: doc("p".repeat(DOCUMENT_STORE_LIMITS.maxKeyBytes + 1), "x") }));
        await rejects(store.get({ pk: A, sk: "" }));
        expect((await store.put({ item: doc("p".repeat(DOCUMENT_STORE_LIMITS.maxKeyBytes), "s".repeat(DOCUMENT_STORE_LIMITS.maxKeyBytes)) })).applied).toBe(true);
      }));

      it("refuses what is not plain JSON", () => withStore(harness, async ({ store }) => {
        await rejects(store.put({ item: doc(A, "x", { n: Number.NaN }) }));
        await rejects(store.put({ item: doc(A, "x", { n: Number.POSITIVE_INFINITY }) }));
        await rejects(store.put({ item: doc(A, "x", { when: new Date() as unknown as string }) }));
        await rejects(store.put({ item: doc(A, "x", { gone: undefined as unknown as string }) }));
        await rejects(store.put({ item: doc(A, "x", { "": 1 }) }));
        expect(await store.get({ pk: A, sk: "x" })).toBeUndefined();
      }));

      it("refuses numbers outside the range every store holds", () => withStore(harness, async ({ store }) => {
        await rejects(store.put({ item: doc(A, "n1", { n: 1e200 }) }));
        await rejects(store.put({ item: doc(A, "n2", { n: 1e-200 }) }));
        expect((await store.put({ item: doc(A, "n3", { big: 1e125, small: 1e-129, zero: 0, negative: -42.5 }) })).applied).toBe(true);
      }));

      it("refuses a getMany that repeats a key", () => withStore(harness, async ({ store }) => {
        await rejects(store.getMany([{ pk: A, sk: "1" }, { pk: A, sk: "1" }]));
      }));

      it("accepts a large document and refuses one over the limit", () => withStore(harness, async ({ store }) => {
        const big = "x".repeat(300 * 1_024);
        expect((await store.put({ item: doc(A, "big", { big }) })).applied).toBe(true);
        expect((await store.get({ pk: A, sk: "big" }))!.big).toBe(big);
        await rejects(store.put({ item: doc(A, "huge", { huge: "x".repeat(DOCUMENT_STORE_LIMITS.maxDocumentBytes + 1) }) }));
      }));

      it("answers a document under the size cap that the store's own size rules refuse with invalid_request, and stores nothing", () => withStore(harness, async ({ store }) => {
        // About 280 KB as compact JSON, inside the port's cap. A store that measures size its own way (DynamoDB: a list element costs
        // about 3 bytes for a one-digit number) may refuse it; if it does, the refusal is the caller's `invalid_request`, never a fault.
        const dense = Array.from({ length: 140_000 }, () => 5);
        expect(JSON.stringify(doc(A, "dense", { dense })).length).toBeLessThan(DOCUMENT_STORE_LIMITS.maxDocumentBytes);
        try {
          expect((await store.put({ item: doc(A, "dense", { dense }) })).applied).toBe(true);
          expect(((await store.get({ pk: A, sk: "dense" }))!.dense as number[]).length).toBe(dense.length);
        } catch (error) {
          expect(error).toBeInstanceOf(DocumentStoreError);
          expect((error as DocumentStoreError).code).toBe("invalid_request");
          expect(await store.get({ pk: A, sk: "dense" })).toBeUndefined();
        }
      }));

      it("accepts nesting up to the depth limit and refuses deeper", () => withStore(harness, async ({ store }) => {
        const nest = (levels: number): StoredDocument[string] => (levels === 0 ? "leaf" : { next: nest(levels - 1) });
        expect((await store.put({ item: doc(A, "ok", { tree: nest(DOCUMENT_STORE_LIMITS.maxDepth - 2) }) })).applied).toBe(true);
        await rejects(store.put({ item: doc(A, "deep", { tree: nest(DOCUMENT_STORE_LIMITS.maxDepth + 2) }) }));
      }));
    });

    describe("conditions", () => {
      const subject = doc(A, "C", { n: 5, s: "b\u{1F600}", t: "text", z: null, list: [1, 2], map: { a: 1, deep: { b: "x" } }, flag: false });
      // [condition, whether it holds for `subject`]
      const cases: [string, Condition, boolean][] = [
        ["exists on a top-level attribute", when.exists("n"), true],
        ["exists on null", when.exists("z"), true],
        ["exists on a missing attribute", when.exists("missing"), false],
        ["notExists on a missing attribute", when.notExists("missing"), true],
        ["notExists on a present attribute", when.notExists("n"), false],
        ["exists on a nested path", when.exists("map.deep.b"), true],
        ["exists below a non-map", when.exists("t.x"), false],
        ["eq number", when.eq("n", 5), true],
        ["eq wrong number", when.eq("n", 6), false],
        ["eq string vs number is false", when.eq("n", "5"), false],
        ["eq null", when.eq("z", null), true],
        ["eq false", when.eq("flag", false), true],
        ["eq a list", when.eq("list", [1, 2]), true],
        ["eq a list in another order", when.eq("list", [2, 1]), false],
        ["eq a map regardless of key order", when.eq("map", { deep: { b: "x" }, a: 1 }), true],
        ["eq on a missing attribute is false", when.eq("missing", null), false],
        ["not eq on a missing attribute is true", when.not(when.eq("missing", 1)), true],
        ["lt number", when.lt("n", 6), true],
        ["lt equal number", when.lt("n", 5), false],
        ["lte equal number", when.lte("n", 5), true],
        ["gt number", when.gt("n", 4), true],
        ["gte equal number", when.gte("n", 5), true],
        ["lt across types is false", when.lt("n", "6"), false],
        ["gt across types is false", when.gt("t", 1), false],
        ["lt on a missing attribute is false", when.lt("missing", 1), false],
        ["string order by code point (letters)", when.lt("t", "u"), true],
        ["string order by code point (an emoji is above U+FFFF-range text)", when.gt("s", "b￿"), true],
        ["beginsWith", when.beginsWith("t", "te"), true],
        ["beginsWith not a prefix", when.beginsWith("t", "x"), false],
        ["beginsWith on a number is false", when.beginsWith("n", "5"), false],
        ["and of true and true", when.and(when.exists("n"), when.eq("t", "text")), true],
        ["and with one false", when.and(when.exists("n"), when.eq("t", "no")), false],
        ["or with one true", when.or(when.eq("t", "no"), when.eq("n", 5)), true],
        ["or of two false", when.or(when.eq("t", "no"), when.eq("n", 0)), false],
        ["not", when.not(when.eq("n", 5)), false],
        ["the rate-limit pattern: missing counter or below the limit", when.or(when.notExists("count"), when.lt("count", 3)), true],
        ["the item exists", when.present(), true],
        ["the item is absent", when.absent(), false],
      ];
      for (const [label, condition, expected] of cases) {
        it(`${label}: ${expected}`, () => withStore(harness, async ({ store }) => {
          await store.put({ item: subject });
          const result = await store.update({ key: { pk: A, sk: "C" }, ops: [change.set("probe", true)], condition });
          expect(result.applied).toBe(expected);
          expect(((await store.get({ pk: A, sk: "C" }))!).probe === true).toBe(expected);
        }));
      }

      it("treats every path as missing on an item that is not there", () => withStore(harness, async ({ store }) => {
        expect((await store.put({ item: doc(A, "N1"), condition: when.exists("n") })).applied).toBe(false);
        expect((await store.put({ item: doc(A, "N2"), condition: when.not(when.eq("n", 1)) })).applied).toBe(true);
        expect((await store.put({ item: doc(A, "N3"), condition: when.or(when.notExists("count"), when.lt("count", 3)) })).applied).toBe(true);
      }));
    });

    describe("update", () => {
      it("creates a document that is not there, holding its key and the changes", () => withStore(harness, async ({ store }) => {
        expect((await store.update({ key: { pk: A, sk: "U" }, ops: [change.set("a", 1), change.add("count", 2)] })).applied).toBe(true);
        expect(await store.get({ pk: A, sk: "U" })).toEqual(doc(A, "U", { a: 1, count: 2 }));
      }));

      it("does not create a document when the condition says it must exist", () => withStore(harness, async ({ store }) => {
        expect(await store.update({ key: { pk: A, sk: "U" }, ops: [change.set("a", 1)], condition: when.present() })).toEqual({ applied: false, reason: "condition_failed" });
        expect(await store.get({ pk: A, sk: "U" })).toBeUndefined();
      }));

      it("sets, sets nested, sets only when absent, removes and adds", () => withStore(harness, async ({ store }) => {
        await store.put({ item: doc(A, "U", { a: 1, keep: "k", gone: "g", map: { x: 1 }, n: 10 }) });
        await store.update({
          key: { pk: A, sk: "U" },
          ops: [change.set("a", 2), change.set("map.y", "why"), change.setIfAbsent("keep", "ignored"), change.setIfAbsent("fresh", "f"), change.remove("gone"), change.remove("never-was"), change.add("n", -3), change.add("made", 1)],
        });
        expect(await store.get({ pk: A, sk: "U" })).toEqual(doc(A, "U", { a: 2, keep: "k", map: { x: 1, y: "why" }, n: 7, fresh: "f", made: 1 }));
      }));

      it("answers with the new or the old document on request", () => withStore(harness, async ({ store }) => {
        await store.put({ item: doc(A, "U", { n: 1 }) });
        expect(await store.update({ key: { pk: A, sk: "U" }, ops: [change.add("n", 1)], return: "new" })).toEqual({ applied: true, item: doc(A, "U", { n: 2 }) });
        expect(await store.update({ key: { pk: A, sk: "U" }, ops: [change.add("n", 1)], return: "old" })).toEqual({ applied: true, item: doc(A, "U", { n: 2 }) });
        expect((await store.get({ pk: A, sk: "U" }))!.n).toBe(3);
      }));

      it("refuses updates that break the rules and changes nothing", () => withStore(harness, async ({ store }) => {
        await store.put({ item: doc(A, "U", { text: "t", n: 1 }) });
        await rejects(store.update({ key: { pk: A, sk: "U" }, ops: [change.add("text", 1)] }));
        await rejects(store.update({ key: { pk: A, sk: "U" }, ops: [change.set("no.parent", 1)] }));
        await rejects(store.update({ key: { pk: A, sk: "U" }, ops: [change.set("text.inner", 1)] }));
        await rejects(store.update({ key: { pk: A, sk: "U" }, ops: [change.set("pk", "other")] }));
        await rejects(store.update({ key: { pk: A, sk: "U" }, ops: [change.set("sk", "other")] }));
        await rejects(store.update({ key: { pk: A, sk: "U" }, ops: [] }));
        await rejects(store.update({ key: { pk: A, sk: "U" }, ops: [change.set("ok", 1), change.add("n", Number.NaN)] }));
        expect(await store.get({ pk: A, sk: "U" })).toEqual(doc(A, "U", { text: "t", n: 1 }));
      }));

      it("refuses an update whose changes overlap, whatever their order", () => withStore(harness, async ({ store }) => {
        await store.put({ item: doc(A, "U", { a: 1, m: { x: 1 } }) });
        await rejects(store.update({ key: { pk: A, sk: "U" }, ops: [change.set("a", 2), change.setIfAbsent("a", 99)] }));
        await rejects(store.update({ key: { pk: A, sk: "U" }, ops: [change.add("a", 1), change.add("a", 1)] }));
        await rejects(store.update({ key: { pk: A, sk: "U" }, ops: [change.set("m", {}), change.set("m.x", 1)] }));
        await rejects(store.update({ key: { pk: A, sk: "U" }, ops: [change.set("m.x", 1), change.remove("m")] }));
        expect(await store.get({ pk: A, sk: "U" })).toEqual(doc(A, "U", { a: 1, m: { x: 1 } }));
        // Different paths in any order are fine and give the same result.
        await store.update({ key: { pk: A, sk: "U" }, ops: [change.set("m.y", 2), change.set("a", 5)] });
        await store.update({ key: { pk: A, sk: "U" }, ops: [change.set("a", 5), change.set("m.y", 2)] });
        expect(await store.get({ pk: A, sk: "U" })).toEqual(doc(A, "U", { a: 5, m: { x: 1, y: 2 } }));
      }));

      it("refuses a remove through a missing parent, and removes a missing attribute whose parent exists", () => withStore(harness, async ({ store }) => {
        await store.put({ item: doc(A, "U", { a: 1, m: { x: 1 } }) });
        await rejects(store.update({ key: { pk: A, sk: "U" }, ops: [change.remove("no.such.path")] }));
        expect((await store.update({ key: { pk: A, sk: "U" }, ops: [change.remove("m.absent"), change.remove("absent")] })).applied).toBe(true);
        expect(await store.get({ pk: A, sk: "U" })).toEqual(doc(A, "U", { a: 1, m: { x: 1 } }));
      }));

      it("applies one compare-and-set winner out of many racing writers", () => withStore(harness, async ({ store }) => {
        await store.put({ item: doc(A, "U", { revision: 0 }) });
        const results = await Promise.all(Array.from({ length: 12 }, (_, index) => store.update({
          key: { pk: A, sk: "U" }, ops: [change.set("revision", 1), change.set("winner", index)], condition: when.eq("revision", 0),
        })));
        expect(results.filter((result) => result.applied)).toHaveLength(1);
        expect((await store.get({ pk: A, sk: "U" }))!.revision).toBe(1);
      }));

      it("adds atomically under concurrency", () => withStore(harness, async ({ store }) => {
        await Promise.all(Array.from({ length: 25 }, () => store.update({ key: { pk: A, sk: "COUNTER" }, ops: [change.add("count", 1)] })));
        expect((await store.get({ pk: A, sk: "COUNTER" }))!.count).toBe(25);
      }));

      it("lets exactly one of many concurrent creators claim a key", () => withStore(harness, async ({ store }) => {
        const results = await Promise.all(Array.from({ length: 12 }, (_, index) => store.put({ item: doc(A, "CLAIM", { by: index }), condition: when.absent() })));
        expect(results.filter((result) => result.applied)).toHaveLength(1);
      }));
    });

    describe("query", () => {
      async function seed(store: DocumentStore): Promise<void> {
        for (const sk of ["EVENT#001", "EVENT#002", "EVENT#003", "NOTE#001", "NOTE#002", "REV#010", "REV#020"]) await store.put({ item: doc(A, sk, { tag: sk.startsWith("EVENT") ? "e" : "o" }) });
        await store.put({ item: doc(B, "EVENT#001") });
        await store.put({ item: doc(`${A}X`, "EVENT#001") });
      }
      const sks = (items: StoredDocument[]) => items.map((item) => item.sk);

      it("lists a whole partition in sort-key order and only that partition", () => withStore(harness, async ({ store }) => {
        await seed(store);
        expect(sks((await store.query({ pk: A })).items)).toEqual(["EVENT#001", "EVENT#002", "EVENT#003", "NOTE#001", "NOTE#002", "REV#010", "REV#020"]);
        expect((await store.query({ pk: "ORG#none#NOTHING" })).items).toEqual([]);
      }));

      it("selects by sort-key prefix, equality and ranges", () => withStore(harness, async ({ store }) => {
        await seed(store);
        expect(sks((await store.query({ pk: A, sk: { op: "beginsWith", prefix: "EVENT#" } })).items)).toEqual(["EVENT#001", "EVENT#002", "EVENT#003"]);
        expect(sks((await store.query({ pk: A, sk: { op: "eq", value: "NOTE#001" } })).items)).toEqual(["NOTE#001"]);
        expect(sks((await store.query({ pk: A, sk: { op: "between", low: "EVENT#002", high: "NOTE#001" } })).items)).toEqual(["EVENT#002", "EVENT#003", "NOTE#001"]);
        expect(sks((await store.query({ pk: A, sk: { op: "lt", value: "EVENT#002" } })).items)).toEqual(["EVENT#001"]);
        expect(sks((await store.query({ pk: A, sk: { op: "lte", value: "EVENT#002" } })).items)).toEqual(["EVENT#001", "EVENT#002"]);
        expect(sks((await store.query({ pk: A, sk: { op: "gt", value: "NOTE#002" } })).items)).toEqual(["REV#010", "REV#020"]);
        expect(sks((await store.query({ pk: A, sk: { op: "gte", value: "NOTE#002" } })).items)).toEqual(["NOTE#002", "REV#010", "REV#020"]);
      }));

      it("reverses the order on request", () => withStore(harness, async ({ store }) => {
        await seed(store);
        expect(sks((await store.query({ pk: A, sk: { op: "beginsWith", prefix: "EVENT#" }, descending: true })).items)).toEqual(["EVENT#003", "EVENT#002", "EVENT#001"]);
      }));

      it("orders sort keys by Unicode code point", () => withStore(harness, async ({ store }) => {
        const keys = ["a", "b", "～", "\u{1F600}", "é", "Z"];
        for (const sk of keys) await store.put({ item: doc(A, sk) });
        expect(sks((await store.query({ pk: A })).items)).toEqual(["Z", "a", "b", "é", "～", "\u{1F600}"]);
      }));

      it("pages with a cursor until it is absent, with no item twice or missed", () => withStore(harness, async ({ store }) => {
        await seed(store);
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = await store.query(cursor === undefined ? { pk: A, limit: 3 } : { pk: A, limit: 3, cursor });
          expect(page.items.length).toBeLessThanOrEqual(3);
          seen.push(...sks(page.items));
          cursor = page.cursor;
          pages += 1;
        } while (cursor !== undefined && pages < 20);
        expect(seen).toEqual(["EVENT#001", "EVENT#002", "EVENT#003", "NOTE#001", "NOTE#002", "REV#010", "REV#020"]);
        expect(pages).toBeGreaterThanOrEqual(3);
      }));

      it("pages in descending order too", () => withStore(harness, async ({ store }) => {
        await seed(store);
        const all = sks(await queryAll(store, { pk: A, descending: true, limit: 2 }));
        expect(all).toEqual(["REV#020", "REV#010", "NOTE#002", "NOTE#001", "EVENT#003", "EVENT#002", "EVENT#001"]);
      }));

      it("keeps paging when the document the cursor named has been deleted", () => withStore(harness, async ({ store }) => {
        await seed(store);
        const first = await store.query({ pk: A, limit: 2 });
        expect(first.cursor).toBeDefined();
        await store.delete({ key: { pk: A, sk: "EVENT#002" } });
        const rest = sks(await queryAll(store, { pk: A, limit: 2 }));
        expect(rest).not.toContain("EVENT#002");
        const resumed = await store.query({ pk: A, limit: 100, cursor: first.cursor! });
        expect(sks(resumed.items)).toEqual(["EVENT#003", "NOTE#001", "NOTE#002", "REV#010", "REV#020"]);
      }));

      it("filters, and a filtered page may be short while the cursor says there is more", () => withStore(harness, async ({ store }) => {
        await seed(store);
        const all = await queryAll(store, { pk: A, filter: when.eq("tag", "o"), limit: 2 });
        expect(sks(all)).toEqual(["NOTE#001", "NOTE#002", "REV#010", "REV#020"]);
      }));

      it("returns every item of a partition bigger than one page", () => withStore(harness, async ({ store }) => {
        const count = DOCUMENT_STORE_LIMITS.maxPageSize + 150;
        for (let start = 0; start < count; start += 50) {
          await Promise.all(Array.from({ length: Math.min(50, count - start) }, (_, index) => store.put({ item: doc(A, `ROW#${String(start + index).padStart(5, "0")}`) })));
        }
        const all = await queryAll(store, { pk: A });
        expect(all).toHaveLength(count);
        expect(sks(all)).toEqual([...sks(all)].sort());
      }));

      it("refuses a limit outside 1 to the page maximum", () => withStore(harness, async ({ store }) => {
        await rejects(store.query({ pk: A, limit: 0 }));
        await rejects(store.query({ pk: A, limit: DOCUMENT_STORE_LIMITS.maxPageSize + 1 }));
      }));

      it("sees its own writes at once", () => withStore(harness, async ({ store }) => {
        await store.put({ item: doc(A, "EVENT#1") });
        expect((await store.query({ pk: A })).items).toHaveLength(1);
        await store.delete({ key: { pk: A, sk: "EVENT#1" } });
        expect((await store.query({ pk: A })).items).toHaveLength(0);
      }));
    });

    describe("secondary indexes", () => {
      it("lists only documents that hold the index attributes, in sort-attribute order", () => withStore(harness, async ({ store, settleIndexes }) => {
        await store.put({ item: doc(A, "1", { kind: "task", rank: 30 }) });
        await store.put({ item: doc(A, "2", { kind: "task", rank: 10 }) });
        await store.put({ item: doc(A, "3", { kind: "task", rank: 20 }) });
        await store.put({ item: doc(A, "4", { kind: "task" }) });
        await store.put({ item: doc(A, "5", { rank: 1 }) });
        await store.put({ item: doc(A, "6", { kind: "note", rank: 5 }) });
        await store.put({ item: doc(B, "7", { kind: "task", rank: 25 }) });
        await settleIndexes?.();
        const tasks = await queryIndexAll(store, { index: "byKind", partition: "task" });
        expect(tasks.map((item) => [item.pk === A ? "A" : "B", item.sk])).toEqual([["A", "2"], ["A", "3"], ["B", "7"], ["A", "1"]]);
        expect((await queryIndexAll(store, { index: "byKind", partition: "task", descending: true })).map((item) => item.sk)).toEqual(["1", "7", "3", "2"]);
        expect((await queryIndexAll(store, { index: "byKind", partition: "note" })).map((item) => item.sk)).toEqual(["6"]);
        expect(await queryIndexAll(store, { index: "byKind", partition: "none" })).toEqual([]);
      }));

      it("selects a range of the sort attribute", () => withStore(harness, async ({ store, settleIndexes }) => {
        for (const rank of [5, 10, 15, 20, 25]) await store.put({ item: doc(A, `R${rank}`, { kind: "task", rank }) });
        await settleIndexes?.();
        const ranks = async (sort: Parameters<DocumentStore["queryIndex"]>[0]["sort"]) => (await queryIndexAll(store, { index: "byKind", partition: "task", ...(sort === undefined ? {} : { sort }) })).map((item) => item.rank);
        expect(await ranks({ op: "between", low: 10, high: 20 })).toEqual([10, 15, 20]);
        expect(await ranks({ op: "lte", value: 10 })).toEqual([5, 10]);
        expect(await ranks({ op: "lt", value: 10 })).toEqual([5]);
        expect(await ranks({ op: "gt", value: 20 })).toEqual([25]);
        expect(await ranks({ op: "gte", value: 20 })).toEqual([20, 25]);
        expect(await ranks({ op: "eq", value: 15 })).toEqual([15]);
      }));

      it("follows a document as it changes partition or leaves the index", () => withStore(harness, async ({ store, settleIndexes }) => {
        await store.put({ item: doc(A, "1", { kind: "task", rank: 1 }) });
        await settleIndexes?.();
        expect(await queryIndexAll(store, { index: "byKind", partition: "task" })).toHaveLength(1);
        await store.update({ key: { pk: A, sk: "1" }, ops: [change.set("kind", "done")] });
        await settleIndexes?.();
        expect(await queryIndexAll(store, { index: "byKind", partition: "task" })).toHaveLength(0);
        expect(await queryIndexAll(store, { index: "byKind", partition: "done" })).toHaveLength(1);
        await store.update({ key: { pk: A, sk: "1" }, ops: [change.remove("rank")] });
        await settleIndexes?.();
        expect(await queryIndexAll(store, { index: "byKind", partition: "done" })).toHaveLength(0);
        await store.update({ key: { pk: A, sk: "1" }, ops: [change.set("rank", 2)] });
        await store.delete({ key: { pk: A, sk: "1" } });
        await settleIndexes?.();
        expect(await queryIndexAll(store, { index: "byKind", partition: "done" })).toHaveLength(0);
      }));

      it("supports an index with no sort attribute, filters and paging", () => withStore(harness, async ({ store, settleIndexes }) => {
        for (let index = 0; index < 7; index += 1) await store.put({ item: doc(A, `O${index}`, { owner: "dev-1", even: index % 2 === 0 }) });
        await store.put({ item: doc(A, "OTHER", { owner: "dev-2" }) });
        await settleIndexes?.();
        expect(await queryIndexAll(store, { index: "byOwner", partition: "dev-1", limit: 3 })).toHaveLength(7);
        expect(await queryIndexAll(store, { index: "byOwner", partition: "dev-1", filter: when.eq("even", true), limit: 2 })).toHaveLength(4);
      }));

      it("refuses a write whose index attributes have the wrong type or are empty", () => withStore(harness, async ({ store }) => {
        await rejects(store.put({ item: doc(A, "x", { kind: "task", rank: "high" }) }));
        await rejects(store.put({ item: doc(A, "x", { kind: 5 }) }));
        await rejects(store.put({ item: doc(A, "x", { kind: "" }) }));
        await store.put({ item: doc(A, "ok", { kind: "task", rank: 1 }) });
        await rejects(store.update({ key: { pk: A, sk: "ok" }, ops: [change.set("rank", "later")] }));
        await rejects(store.transact([{ kind: "put", item: doc(A, "y", { kind: "task", rank: "no" }) }]));
        expect(await store.get({ pk: A, sk: "x" })).toBeUndefined();
        expect((await store.get({ pk: A, sk: "ok" }))!.rank).toBe(1);
      }));

      it("refuses an index that does not exist, or a sort range on an index without a sort attribute", () => withStore(harness, async ({ store }) => {
        await rejects(store.queryIndex({ index: "nope", partition: "x" }));
        await rejects(store.queryIndex({ index: "byOwner", partition: "x", sort: { op: "eq", value: 1 } }));
      }));
    });

    describe("transactions", () => {
      it("applies every step together", () => withStore(harness, async ({ store }) => {
        await store.put({ item: doc(A, "ONE", { n: 1 }) });
        await store.put({ item: doc(A, "GONE", { n: 1 }) });
        await store.put({ item: doc(A, "WATCHED", { n: 1 }) });
        const result = await store.transact([
          { kind: "put", item: doc(A, "NEW", { n: 1 }), condition: when.absent() },
          { kind: "update", key: { pk: A, sk: "ONE" }, ops: [change.add("n", 1)], condition: when.eq("n", 1) },
          { kind: "delete", key: { pk: A, sk: "GONE" }, condition: when.present() },
          { kind: "check", key: { pk: A, sk: "WATCHED" }, condition: when.present() },
        ]);
        expect(result).toEqual({ applied: true });
        expect(await store.get({ pk: A, sk: "NEW" })).toEqual(doc(A, "NEW", { n: 1 }));
        expect((await store.get({ pk: A, sk: "ONE" }))!.n).toBe(2);
        expect(await store.get({ pk: A, sk: "GONE" })).toBeUndefined();
      }));

      it("applies none when one condition fails, and names the failing step", () => withStore(harness, async ({ store }) => {
        await store.put({ item: doc(A, "ONE", { n: 1 }) });
        await store.put({ item: doc(A, "WATCHED", { n: 1 }) });
        const result = await store.transact([
          { kind: "put", item: doc(A, "NEW", { n: 1 }), condition: when.absent() },
          { kind: "update", key: { pk: A, sk: "ONE" }, ops: [change.add("n", 1)] },
          { kind: "check", key: { pk: A, sk: "WATCHED" }, condition: when.eq("n", 99) },
        ]);
        expect(result.applied).toBe(false);
        if (!result.applied) {
          expect(result.reason).toBe("condition_failed");
          expect(result.failed).toContain(2);
          expect(result.failed.length).toBeGreaterThanOrEqual(1);
        }
        expect(await store.get({ pk: A, sk: "NEW" })).toBeUndefined();
        expect((await store.get({ pk: A, sk: "ONE" }))!.n).toBe(1);
      }));

      it("a check writes nothing", () => withStore(harness, async ({ store }) => {
        await store.put({ item: doc(A, "ONE", { n: 1 }) });
        expect(await store.transact([{ kind: "check", key: { pk: A, sk: "ONE" }, condition: when.eq("n", 1) }, { kind: "put", item: doc(A, "TWO") }])).toEqual({ applied: true });
        expect(await store.get({ pk: A, sk: "ONE" })).toEqual(doc(A, "ONE", { n: 1 }));
      }));

      it("refuses an empty transaction, a repeated key, and one over the step limit", () => withStore(harness, async ({ store }) => {
        await rejects(store.transact([]));
        await rejects(store.transact([{ kind: "put", item: doc(A, "X") }, { kind: "update", key: { pk: A, sk: "X" }, ops: [change.set("a", 1)] }]));
        await rejects(store.transact(Array.from({ length: DOCUMENT_STORE_LIMITS.maxTransactItems + 1 }, (_, index) => ({ kind: "put" as const, item: doc(A, `T${index}`) }))));
        expect(await store.get({ pk: A, sk: "X" })).toBeUndefined();
      }));

      it("accepts the largest transaction", () => withStore(harness, async ({ store }) => {
        const items = Array.from({ length: DOCUMENT_STORE_LIMITS.maxTransactItems }, (_, index) => ({ kind: "put" as const, item: doc(A, `T${String(index).padStart(3, "0")}`) }));
        expect(await store.transact(items)).toEqual({ applied: true });
        expect(await queryAll(store, { pk: A })).toHaveLength(DOCUMENT_STORE_LIMITS.maxTransactItems);
      }));

      it("refuses a transaction that writes more bytes than the limit", () => withStore(harness, async ({ store }) => {
        const piece = "x".repeat(300 * 1_024);
        const steps = Array.from({ length: Math.ceil(DOCUMENT_STORE_LIMITS.maxTransactBytes / piece.length) + 1 }, (_, index) => ({ kind: "put" as const, item: doc(A, `BIG${index}`, { piece }) }));
        await rejects(store.transact(steps));
        expect(await store.get({ pk: A, sk: "BIG0" })).toBeUndefined();
      }));

      it("lets exactly one of many racing transactions win a unique claim", () => withStore(harness, async ({ store }) => {
        const results = await Promise.all(Array.from({ length: 10 }, (_, index) => store.transact([
          { kind: "put", item: doc(A, "CLAIM", { by: index }), condition: when.absent() },
          { kind: "put", item: doc(A, `OWNER#${index}`, { claimed: true }) },
        ])));
        expect(results.filter((result) => result.applied)).toHaveLength(1);
        const owners = await queryAll(store, { pk: A, sk: { op: "beginsWith", prefix: "OWNER#" } });
        expect(owners).toHaveLength(1);
        expect(`OWNER#${(await store.get({ pk: A, sk: "CLAIM" }))!.by as number}`).toBe(owners[0]!.sk);
      }));
    });

    describe("expiry", () => {
      it("removes a document past its time when the sweep runs, and keeps the others", () => withStore(harness, async (under) => {
        const { store } = under;
        if (store.ttlAttribute === undefined || under.sweepExpired === undefined) return; // this store does not expire documents
        const past = Math.floor(Date.now() / 1_000) - 3_600;
        const future = Math.floor(Date.now() / 1_000) + 3_600;
        await store.put({ item: doc(A, "OLD", { [store.ttlAttribute]: past }) });
        await store.put({ item: doc(A, "NEW", { [store.ttlAttribute]: future }) });
        await store.put({ item: doc(A, "FOREVER") });
        await under.sweepExpired();
        expect(await store.get({ pk: A, sk: "OLD" })).toBeUndefined();
        expect(await store.get({ pk: A, sk: "NEW" })).toBeDefined();
        expect(await store.get({ pk: A, sk: "FOREVER" })).toBeDefined();
      }));
    });

    describe("change feed", () => {
      async function collect(under: DocumentStoreUnderTest, wanted: number, consumer = "suite"): Promise<{ changes: DocumentChange[]; done: () => Promise<void> }> {
        const changes: DocumentChange[] = [];
        const subscription = await under.store.changes!.subscribe(consumer, async (batch) => {
          changes.push(...batch);
        });
        return {
          changes,
          async done() {
            await under.settleFeed?.();
            for (let waited = 0; changes.length < wanted && waited < 5_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
            await subscription.stop();
          },
        };
      }

      it("reports inserts, modifications and removals with before and after images", () => withStore(harness, async (under) => {
        if (under.store.changes === undefined) return; // a store may have no feed
        const seen = await collect(under, 3);
        await under.store.put({ item: doc(A, "F", { v: 1 }) });
        await under.store.update({ key: { pk: A, sk: "F" }, ops: [change.set("v", 2)] });
        await under.store.delete({ key: { pk: A, sk: "F" } });
        await seen.done();
        expect(seen.changes.map((entry) => entry.kind)).toEqual(["insert", "modify", "remove"]);
        expect(seen.changes[0]!.after).toEqual(doc(A, "F", { v: 1 }));
        expect(seen.changes[0]!.before).toBeUndefined();
        expect(seen.changes[1]!.before).toEqual(doc(A, "F", { v: 1 }));
        expect(seen.changes[1]!.after).toEqual(doc(A, "F", { v: 2 }));
        expect(seen.changes[2]!.before).toEqual(doc(A, "F", { v: 2 }));
        expect(seen.changes[2]!.after).toBeUndefined();
        const sequences = seen.changes.map((entry) => entry.sequence);
        expect([...sequences].sort()).toEqual(sequences);
      }));

      it("reports nothing for a write whose condition failed", () => withStore(harness, async (under) => {
        if (under.store.changes === undefined) return;
        await under.store.put({ item: doc(A, "F", { v: 1 }) });
        const seen = await collect(under, 1);
        await under.store.put({ item: doc(A, "F", { v: 2 }), condition: when.absent() });
        await under.store.transact([{ kind: "put", item: doc(A, "G") }, { kind: "check", key: { pk: A, sk: "F" }, condition: when.eq("v", 9) }]);
        await under.settleFeed?.();
        await new Promise((resolve) => setTimeout(resolve, 50));
        await seen.done();
        expect(seen.changes).toEqual([]);
      }));

      it("reports every step of a transaction, and not a check", () => withStore(harness, async (under) => {
        if (under.store.changes === undefined) return;
        await under.store.put({ item: doc(A, "F", { v: 1 }) });
        await under.store.put({ item: doc(A, "H") });
        const seen = await collect(under, 2);
        await under.store.transact([
          { kind: "put", item: doc(A, "G") },
          { kind: "update", key: { pk: A, sk: "F" }, ops: [change.add("v", 1)] },
          { kind: "check", key: { pk: A, sk: "H" }, condition: when.present() },
        ]);
        await seen.done();
        expect(seen.changes.map((entry) => `${entry.kind}:${entry.key.sk}`).sort()).toEqual(["insert:G", "modify:F"]);
      }));

      it("delivers again to a consumer whose handler failed", () => withStore(harness, async (under) => {
        if (under.store.changes === undefined) return;
        let attempts = 0;
        const delivered: DocumentChange[] = [];
        const subscription = await under.store.changes.subscribe("flaky", async (batch) => {
          attempts += 1;
          if (attempts === 1) throw new Error("first attempt fails");
          delivered.push(...batch);
        });
        await under.store.put({ item: doc(A, "F") });
        for (let waited = 0; delivered.length === 0 && waited < 10_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
        await subscription.stop();
        expect(attempts).toBeGreaterThanOrEqual(2);
        expect(delivered.map((entry) => entry.kind)).toEqual(["insert"]);
      }));

      const waitFor = async (condition: () => boolean, ms = 15_000): Promise<void> => {
        for (let waited = 0; !condition() && waited < ms; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
        expect(condition()).toBe(true);
      };

      it("starts a consumer at the present: what was committed before its first subscription is not delivered", () => withStore(harness, async (under) => {
        if (under.store.changes === undefined) return;
        await under.store.put({ item: doc(A, "BEFORE") });
        const handled: string[] = [];
        const subscription = await under.store.changes.subscribe("latecomer", async (batch) => void handled.push(...batch.map((entry) => entry.key.sk)));
        await under.store.put({ item: doc(A, "AFTER") });
        await waitFor(() => handled.length > 0);
        await subscription.stop();
        expect(handled).toEqual(["AFTER"]);
      }));

      it("gives up on a batch whose handler keeps failing, reports it to onPoison, and goes on with later changes", () => withStore(harness, async (under) => {
        if (under.store.changes === undefined) return;
        const poisoned: string[][] = [];
        const handled: string[] = [];
        const subscription = await under.store.changes.subscribe("stubborn", async (batch) => {
          if (batch.some((entry) => entry.key.sk === "BAD")) throw new Error("this batch can never be handled");
          handled.push(...batch.map((entry) => entry.key.sk));
        }, { onPoison: (batch) => void poisoned.push(batch.map((entry) => entry.key.sk)) });
        await under.store.put({ item: doc(A, "BAD") });
        await waitFor(() => poisoned.length > 0);
        await under.store.put({ item: doc(A, "GOOD") });
        await waitFor(() => handled.includes("GOOD"));
        await subscription.stop();
        expect(poisoned[0]).toContain("BAD");
        expect(handled).not.toContain("BAD");
      }));

      it("marks the removal of an expired document as expired, and an ordinary delete as a write", () => withStore(harness, async (under) => {
        const { store } = under;
        if (store.changes === undefined || store.ttlAttribute === undefined || under.sweepExpired === undefined) return;
        const seen = await collect(under, 3);
        await store.put({ item: doc(A, "OLD", { [store.ttlAttribute]: Math.floor(Date.now() / 1_000) - 3_600 }) });
        await store.put({ item: doc(A, "GONE") });
        await store.delete({ key: { pk: A, sk: "GONE" } });
        await under.sweepExpired();
        await seen.done();
        const removals = seen.changes.filter((entry) => entry.kind === "remove");
        expect(removals.map((entry) => [entry.key.sk, entry.cause]).sort()).toEqual([["GONE", "write"], ["OLD", "expired"]]);
        expect(seen.changes.filter((entry) => entry.kind === "insert").every((entry) => entry.cause === "write")).toBe(true);
      }));

      describe("across a restart (stores that keep their data)", () => {
        it("resumes a named consumer after the last change it handled, losing none and skipping none", () => withStore(harness, async (first) => {
          if (first.store.changes === undefined || first.reopen === undefined) return;
          const handled: string[] = [];
          const subscription = await first.store.changes.subscribe("durable", async (batch) => void handled.push(...batch.map((entry) => entry.key.sk)));
          await first.store.put({ item: doc(A, "1") });
          await waitFor(() => handled.length === 1);
          await subscription.stop();
          // Committed while no one is subscribed, and then a restart: the consumer still owes these.
          await first.store.put({ item: doc(A, "2") });
          await first.store.update({ key: { pk: A, sk: "2" }, ops: [change.set("v", 2)] });
          await first.store.put({ item: doc(A, "3") });
          const second = await first.reopen();
          try {
            const again: DocumentChange[] = [];
            const resumed = await second.store.changes!.subscribe("durable", async (batch) => void again.push(...batch));
            await waitFor(() => again.length >= 3);
            await second.store.put({ item: doc(A, "4") });
            await waitFor(() => again.some((entry) => entry.key.sk === "4"));
            await resumed.stop();
            // At least once allows a repeat; it never allows a miss, and the change handled before the restart is not owed again.
            expect([...new Set(again.map((entry) => `${entry.kind}:${entry.key.sk}`))]).toEqual(["insert:2", "modify:2", "insert:3", "insert:4"]);
            const sequences = again.map((entry) => entry.sequence);
            expect(sequences).toEqual([...sequences].sort());
          } finally {
            await second.dispose?.();
          }
        }));

        it("starts a name that never subscribed at the present, also after a restart", () => withStore(harness, async (first) => {
          if (first.store.changes === undefined || first.reopen === undefined) return;
          await first.store.changes.subscribe("old-hand", async () => {});
          await first.store.put({ item: doc(A, "EARLY") });
          const second = await first.reopen();
          try {
            await second.store.put({ item: doc(A, "MIDDLE") });
            const handled: string[] = [];
            const fresh = await second.store.changes!.subscribe("newcomer", async (batch) => void handled.push(...batch.map((entry) => entry.key.sk)));
            await second.store.put({ item: doc(A, "LATE") });
            await waitFor(() => handled.length > 0);
            await fresh.stop();
            expect(handled).toEqual(["LATE"]);
          } finally {
            await second.dispose?.();
          }
        }));
      });

      it("gives each named consumer every change", () => withStore(harness, async (under) => {
        if (under.store.changes === undefined) return;
        const one = await collect(under, 1, "one");
        const two = await collect(under, 1, "two");
        await under.store.put({ item: doc(A, "F") });
        await one.done();
        await two.done();
        expect(one.changes).toHaveLength(1);
        expect(two.changes).toHaveLength(1);
      }));
    });
  });
}
