// Port lane L3: the SQLite document store passes the shared document-store conformance suite unchanged, plus what is specific to a file on disk.
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentStoreError, change, queryAll, queryIndexAll, when, type DocumentChange, type IndexDefinition } from "@agentx/contracts";
import { SqliteDatabase, SqliteDocumentStore, prefixEnd } from "../../packages/local-adapters/src/index.js";
import { runDocumentStoreConformance } from "../support/ports/document-store-conformance.js";
import { FAST_FEED, sqliteStoreHarness } from "../support/ports/sqlite-harness.js";

runDocumentStoreConformance("sqlite (WAL, FULL sync)", sqliteStoreHarness());
runDocumentStoreConformance("sqlite (WAL, NORMAL sync)", sqliteStoreHarness({ synchronous: "NORMAL" }));

const folders: string[] = [];
const stores: SqliteDocumentStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function folder(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "local-store-"));
  folders.push(path);
  return path;
}
function open(path: string, options: Partial<Parameters<typeof SqliteDocumentStore.open>[0]> = {}): SqliteDocumentStore {
  const store = SqliteDocumentStore.open({ path, sweepIntervalMs: 0, changeFeed: FAST_FEED, busyTimeoutMs: 200, ...options });
  stores.push(store);
  return store;
}

const PK = "ORG#org_aaaaaaaaaaaaaaaaaaaa#THING#1";

describe("the SQLite store: keys and text", () => {
  it("refuses keys SQLite would change or cut: an unpaired surrogate and a NUL", async () => {
    const store = open(join(await folder(), "s.db"));
    for (const bad of ["a\ud800b", "a\u0000b", "\udc00"]) {
      await expect(store.put({ item: { pk: bad, sk: "x" } })).rejects.toMatchObject({ code: "invalid_request" });
      await expect(store.get({ pk: PK, sk: bad })).rejects.toMatchObject({ code: "invalid_request" });
      await expect(store.query({ pk: PK, sk: { op: "beginsWith", prefix: bad } })).rejects.toMatchObject({ code: "invalid_request" });
      await expect(store.transact([{ kind: "put", item: { pk: PK, sk: bad } }])).rejects.toMatchObject({ code: "invalid_request" });
    }
    // The same characters inside a document body are fine: the body is JSON text, which escapes both.
    const body = { pk: PK, sk: "ok", text: "a\ud800b\u0000c", nested: { "k\u0000": "v\udc00" } };
    await store.put({ item: body });
    expect(await store.get({ pk: PK, sk: "ok" })).toEqual(body);
  });

  it("keeps a lone surrogate or NUL out of an index key as well", async () => {
    const store = open(join(await folder(), "s.db"), { indexes: [{ name: "byOwner", partitionAttribute: "owner" }] });
    await expect(store.put({ item: { pk: PK, sk: "x", owner: "o\u0000" } })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(store.queryIndex({ index: "byOwner", partition: "o\ud800" })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("finds a prefix at the edge of the code point range, with a bound that counts bytes the way UTF-8 does", async () => {
    const store = open(join(await folder(), "s.db"));
    const high = "\u{10FFFF}";
    for (const sk of ["a", "a\u{FFFF}", "a\u{10000}", `a${high}`, `a${high}x`, "b", "퟿x", "x"]) await store.put({ item: { pk: PK, sk } });
    const found = async (prefix: string) => (await queryAll(store, { pk: PK, sk: { op: "beginsWith", prefix } })).map((item) => item.sk);
    expect(await found("a")).toEqual(["a", "a\u{FFFF}", "a\u{10000}", `a${high}`, `a${high}x`]);
    expect(await found(`a${high}`)).toEqual([`a${high}`, `a${high}x`]);
    expect(await found("퟿")).toEqual(["퟿x"]);
    expect(prefixEnd("a퟿")).toBe("a");
    expect(prefixEnd(high)).toBeUndefined();
    expect(prefixEnd(`a${high}`)).toBe("b");
  });
});

describe("the SQLite store: a file that outlives the process", () => {
  it("keeps documents, and the 0600 mode of the file", async () => {
    const path = join(await folder(), "deep", "state.db");
    const first = open(path);
    await first.put({ item: { pk: PK, sk: "A", n: 1, nested: { a: [1, 2] } } });
    await first.transact([{ kind: "put", item: { pk: PK, sk: "B" } }, { kind: "update", key: { pk: PK, sk: "A" }, ops: [change.add("n", 4)] }]);
    await first.close();
    const second = open(path);
    expect(await second.get({ pk: PK, sk: "A" })).toEqual({ pk: PK, sk: "A", n: 5, nested: { a: [1, 2] } });
    expect(await second.get({ pk: PK, sk: "B" })).toBeDefined();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
  });

  it("refuses a closed store with an error a caller can retry on elsewhere", async () => {
    const store = open(join(await folder(), "s.db"));
    await store.close();
    await expect(store.get({ pk: PK, sk: "A" })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("builds a new index from the documents already stored, and drops an index that is gone, when the store is opened again", async () => {
    const path = join(await folder(), "s.db");
    const first = open(path);
    await first.put({ item: { pk: PK, sk: "1", owner: "ann", rank: 2 } });
    await first.put({ item: { pk: PK, sk: "2", owner: "ann", rank: 1 } });
    await first.put({ item: { pk: PK, sk: "3", owner: "bob" } });
    await first.close();
    const indexes: IndexDefinition[] = [{ name: "byOwner", partitionAttribute: "owner", sortAttribute: "rank", sortType: "number" }];
    const second = open(path, { indexes, migrate: true });
    expect((await queryIndexAll(second, { index: "byOwner", partition: "ann" })).map((item) => item.sk)).toEqual(["2", "1"]);
    expect(await queryIndexAll(second, { index: "byOwner", partition: "bob" })).toEqual([]);
    await second.put({ item: { pk: PK, sk: "3", owner: "ann", rank: 0 } });
    await second.close();
    // The same index with another sort type is rebuilt; documents that do not fit it are left out rather than failing the open.
    const third = open(path, { indexes: [{ name: "byOwner", partitionAttribute: "owner", sortAttribute: "owner" }], migrate: true });
    expect((await queryIndexAll(third, { index: "byOwner", partition: "ann" })).map((item) => item.sk)).toEqual(["1", "2", "3"]);
    await third.close();
    const fourth = open(path, { migrate: true });
    await expect(fourth.queryIndex({ index: "byOwner", partition: "ann" })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("builds the time-to-live table when the attribute is first named, and sweeps what is past", async () => {
    const path = join(await folder(), "s.db");
    let now = 1_000;
    const first = open(path);
    await first.put({ item: { pk: PK, sk: "OLD", expiresAt: 500 } });
    await first.put({ item: { pk: PK, sk: "SOON", expiresAt: 1_500 } });
    await first.close();
    const second = open(path, { ttlAttribute: "expiresAt", nowSeconds: () => now, migrate: true });
    expect(second.sweepExpired()).toBe(1);
    expect(await second.get({ pk: PK, sk: "OLD" })).toBeUndefined();
    // A document renewed after it was listed is not swept.
    await second.update({ key: { pk: PK, sk: "SOON" }, ops: [change.set("expiresAt", 9_000)] });
    now = 2_000;
    expect(second.sweepExpired()).toBe(0);
    now = 9_000;
    expect(second.sweepExpired()).toBe(1);
  });

  it("sweeps a backlog in pages, and a dotted attribute name is one attribute name", async () => {
    const store = open(join(await folder(), "s.db"), { ttlAttribute: "ttl.at", nowSeconds: () => 1_000 });
    for (let index = 0; index < 250; index += 1) await store.put({ item: { pk: PK, sk: `E${String(index).padStart(3, "0")}`, "ttl.at": 10 } });
    await store.put({ item: { pk: PK, sk: "KEEP", "ttl.at": 5_000 } });
    const seen: DocumentChange[] = [];
    await store.changes!.subscribe("c", async (batch) => void seen.push(...batch));
    expect(store.sweepExpired()).toBe(250);
    await store.settled();
    expect(seen).toHaveLength(250);
    expect(seen.every((entry) => entry.cause === "expired" && entry.kind === "remove")).toBe(true);
    expect(await store.get({ pk: PK, sk: "KEEP" })).toBeDefined();
    expect(store.sweepExpired()).toBe(0);
  });

  it("sweeps by itself on a timer", async () => {
    const store = open(join(await folder(), "s.db"), { ttlAttribute: "expiresAt", sweepIntervalMs: 10 });
    await store.put({ item: { pk: PK, sk: "OLD", expiresAt: 1 } });
    for (let waited = 0; (await store.get({ pk: PK, sk: "OLD" })) !== undefined && waited < 5_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await store.get({ pk: PK, sk: "OLD" })).toBeUndefined();
  });

  it("refuses a file written by a newer schema", async () => {
    const path = join(await folder(), "s.db");
    const first = open(path);
    await first.close();
    const raw = new SqliteDatabase({ path });
    raw.run("UPDATE rv_doc_meta SET value = '99' WHERE key = 'schema'");
    raw.close();
    expect(() => SqliteDocumentStore.open({ path })).toThrow(/newer version/);
  });
});

describe("the SQLite store: one layout for every connection", () => {
  const byOwner: IndexDefinition[] = [{ name: "byOwner", partitionAttribute: "owner" }];

  it("refuses to open a file with other indexes or another expiry attribute unless asked to migrate", async () => {
    const path = join(await folder(), "s.db");
    const indexed = open(path, { indexes: byOwner, ttlAttribute: "expiresAt" });
    await indexed.put({ item: { pk: PK, sk: "1", owner: "ann" } });
    expect(() => SqliteDocumentStore.open({ path })).toThrow(/migrate: true/);
    expect(() => SqliteDocumentStore.open({ path, indexes: byOwner })).toThrow(/migrate: true/);
    // The refused opens changed nothing: the indexed store goes on, and a matching open is fine.
    expect((await indexed.put({ item: { pk: PK, sk: "2", owner: "ann" } })).applied).toBe(true);
    const same = open(path, { indexes: [...byOwner], ttlAttribute: "expiresAt" });
    expect((await queryIndexAll(same, { index: "byOwner", partition: "ann" })).map((item) => item.sk)).toEqual(["1", "2"]);
  });

  it("makes a connection that was open on the old layout refuse to write after a migration, instead of corrupting an index", async () => {
    const path = join(await folder(), "s.db");
    const old = open(path, { indexes: byOwner });
    await old.put({ item: { pk: PK, sk: "1", owner: "ann" } });
    const migrated = open(path, { migrate: true });
    await expect(old.put({ item: { pk: PK, sk: "2", owner: "bob" } })).rejects.toMatchObject({ code: "unavailable" });
    await expect(old.queryIndex({ index: "byOwner", partition: "ann" })).rejects.toMatchObject({ code: "unavailable" });
    expect(await migrated.get({ pk: PK, sk: "2" })).toBeUndefined();
    await old.close();
    // Reopened with the new layout it works again.
    const again = open(path, { migrate: true });
    expect((await again.put({ item: { pk: PK, sk: "2", owner: "bob" } })).applied).toBe(true);
  });
});

describe("the SQLite store: two connections to one file", () => {
  it("delivers the changes of a connection that runs no feed of its own, to a consumer registered on another", async () => {
    const path = join(await folder(), "s.db");
    const subscriber = open(path);
    const quiet = open(path, { changeFeed: false });
    const seen: DocumentChange[] = [];
    await subscriber.changes!.subscribe("relay", async (batch) => void seen.push(...batch));
    await subscriber.put({ item: { pk: PK, sk: "via-subscriber" } });
    await quiet.put({ item: { pk: PK, sk: "via-quiet" } });
    await quiet.transact([{ kind: "put", item: { pk: PK, sk: "via-quiet-2" } }]);
    for (let waited = 0; seen.length < 3 && waited < 5_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen.map((entry) => entry.key.sk)).toEqual(["via-subscriber", "via-quiet", "via-quiet-2"]);
  });

  it("lets exactly one of many racing creators win across two connections", async () => {
    const path = join(await folder(), "s.db");
    const one = open(path);
    const two = open(path);
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? one : two).put({ item: { pk: PK, sk: "CLAIM", by: index }, condition: when.absent() })));
    expect(results.filter((result) => result.applied)).toHaveLength(1);
  });

  it("adds atomically across two connections", async () => {
    const path = join(await folder(), "s.db");
    const one = open(path);
    const two = open(path);
    await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? one : two).update({ key: { pk: PK, sk: "N" }, ops: [change.add("n", 1)] })));
    expect((await one.get({ pk: PK, sk: "N" }))!.n).toBe(40);
  });

  it("answers `conflict` for a write that waited out the busy timeout, and `throttled` never blocks a read", async () => {
    const path = join(await folder(), "s.db");
    const store = open(path, { busyTimeoutMs: 50 });
    await store.put({ item: { pk: PK, sk: "A", v: 1 } });
    const holder = new SqliteDatabase({ path });
    holder.exec("BEGIN IMMEDIATE");
    try {
      const started = Date.now();
      await expect(store.put({ item: { pk: PK, sk: "A", v: 2 } })).rejects.toSatisfy((error: unknown) => error instanceof DocumentStoreError && error.code === "conflict" && error.retryable);
      expect(Date.now() - started).toBeGreaterThanOrEqual(40);
      // WAL: a reader is not blocked by the writer.
      expect((await store.get({ pk: PK, sk: "A" }))!.v).toBe(1);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect((await store.put({ item: { pk: PK, sk: "A", v: 3 } })).applied).toBe(true);
  });

  it("delivers the changes another connection commits", async () => {
    const path = join(await folder(), "s.db");
    const reader = open(path);
    const writer = open(path);
    const seen: DocumentChange[] = [];
    await reader.changes!.subscribe("watch", async (batch) => void seen.push(...batch));
    await writer.put({ item: { pk: PK, sk: "FROM-WRITER" } });
    for (let waited = 0; seen.length === 0 && waited < 5_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen.map((entry) => entry.key.sk)).toEqual(["FROM-WRITER"]);
  });
});

describe("the SQLite store: the change log", () => {
  it("keeps nothing in the log until a consumer exists, and trims what every consumer has handled", async () => {
    const path = join(await folder(), "s.db");
    const store = open(path);
    await store.put({ item: { pk: PK, sk: "1" } });
    const raw = new SqliteDatabase({ path });
    expect(raw.get("SELECT COUNT(*) AS n FROM rv_doc_change")!.n).toBe(0);
    const seen: DocumentChange[] = [];
    const subscription = await store.changes!.subscribe("c", async (batch) => void seen.push(...batch));
    for (let index = 0; index < 5; index += 1) await store.put({ item: { pk: PK, sk: `K${index}` } });
    await store.settled();
    expect(seen).toHaveLength(5);
    expect(raw.get("SELECT COUNT(*) AS n FROM rv_doc_change")!.n).toBe(0);
    await subscription.stop();
    await store.put({ item: { pk: PK, sk: "WHILE-AWAY" } });
    expect(raw.get("SELECT COUNT(*) AS n FROM rv_doc_change")!.n).toBe(1);
    // Retiring the consumer lets the log go.
    expect(store.removeConsumer("c")).toBe(true);
    expect(raw.get("SELECT COUNT(*) AS n FROM rv_doc_change")!.n).toBe(0);
    raw.close();
  });

  it("stops a consumer that another connection retired, and lets the name be taken again after stop() finishes", async () => {
    const path = join(await folder(), "s.db");
    const store = open(path);
    const other = open(path);
    const first = await store.changes!.subscribe("c", async () => {});
    await first.stop();
    const again = await store.changes!.subscribe("c", async () => {});
    await again.stop();
    // Retired from elsewhere while subscribed here: the consumer stops reading and the failure is counted.
    await store.changes!.subscribe("gone", async () => {});
    expect(other.removeConsumer("gone")).toBe(true);
    await store.put({ item: { pk: PK, sk: "x" } });
    for (let waited = 0; (store.changes as unknown as { readFailures: number }).readFailures === 0 && waited < 5_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    expect((store.changes as unknown as { readFailures: number }).readFailures).toBeGreaterThan(0);
    await expect(store.changes!.subscribe("gone", async () => {})).resolves.toBeDefined();
  });

  it("refuses a second subscription under one name, and works with the feed off", async () => {
    const store = open(join(await folder(), "s.db"));
    await store.changes!.subscribe("same", async () => {});
    await expect(store.changes!.subscribe("same", async () => {})).rejects.toMatchObject({ code: "invalid_request" });
    const off = open(join(await folder(), "off.db"), { changeFeed: false });
    expect(off.changes).toBeUndefined();
    await off.put({ item: { pk: PK, sk: "1" } });
  });

  it("writes the change in the transaction of the write: a refused transaction leaves no log", async () => {
    const path = join(await folder(), "s.db");
    const store = open(path);
    await store.changes!.subscribe("c", async () => {});
    const raw = new SqliteDatabase({ path });
    await store.put({ item: { pk: PK, sk: "1" } });
    await store.settled();
    const result = await store.transact([{ kind: "put", item: { pk: PK, sk: "2" } }, { kind: "check", key: { pk: PK, sk: "1" }, condition: when.eq("nope", 1) }]);
    expect(result.applied).toBe(false);
    await expect(store.transact([{ kind: "put", item: { pk: PK, sk: "3" } }, { kind: "update", key: { pk: PK, sk: "1" }, ops: [change.set("a.b", 1)] }])).rejects.toMatchObject({ code: "invalid_request" });
    expect(raw.get("SELECT COUNT(*) AS n FROM rv_doc_change")!.n).toBe(0);
    expect(await store.get({ pk: PK, sk: "3" })).toBeUndefined();
    raw.close();
  });
});

describe("the SQLite connection", () => {
  it("rolls back everything a transaction wrote when its body throws after the first write, and joins a nested one", async () => {
    const path = join(await folder(), "raw.db");
    const db = new SqliteDatabase({ path });
    db.exec("CREATE TABLE t (a TEXT PRIMARY KEY, b TEXT)");
    expect(() => db.write(() => {
      db.run("INSERT INTO t VALUES ('one', 'x')");
      db.write(() => db.run("INSERT INTO t VALUES ('two', 'y')"));
      db.run("INSERT INTO t VALUES ('one', 'duplicate')");
    })).toThrow();
    expect(db.all("SELECT * FROM t")).toEqual([]);
    expect(db.write(() => db.run("INSERT INTO t VALUES ('three', 'z')"))).toBe(1);
    expect(db.all("SELECT a FROM t").map((row) => row.a)).toEqual(["three"]);
    db.close();
    expect(() => db.run("SELECT 1")).toThrow(/closed/);
  });
});

describe("the SQLite store: closing from inside a handler, and an older file", () => {
  it("lets a handler stop its own subscription and close the store without waiting for itself", async () => {
    const store = open(join(await folder(), "s.db"));
    let calls = 0;
    const subscription = await store.changes!.subscribe("self", async () => {
      calls += 1;
      await subscription.stop();
      await store.close();
    });
    await store.put({ item: { pk: PK, sk: "1" } });
    for (let waited = 0; calls === 0 && waited < 5_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(1);
  });

  it("opens a file whose layout has no generation yet (written before generations existed)", async () => {
    const path = join(await folder(), "s.db");
    await open(path).close();
    const raw = new SqliteDatabase({ path });
    raw.run("DELETE FROM rv_doc_meta WHERE key = 'generation'");
    raw.close();
    const store = open(path);
    expect((await store.put({ item: { pk: PK, sk: "1" } })).applied).toBe(true);
  });
});
