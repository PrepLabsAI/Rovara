// Port lane L9a: the conformance suite every `object-storage` adapter must pass (provisional, owner decision 58): the document-store adapter,
// the folder adapter, and later Cloud's S3 adapter.
import { describe, expect, it } from "vitest";
import { ObjectConflictError, ObjectKeyError, ObjectMetaError, ObjectTooBigError, type ObjectMeta, type ObjectStorage } from "@agentx/contracts";

export interface ObjectStorageUnderTest {
  store: ObjectStorage;
  /** A size `put` must refuse with `ObjectTooBigError`, or undefined for a store with no practical limit. */
  tooBigBytes?: number;
  /** The largest size the store must accept (the test stores that many bytes). Default 64 KiB. */
  fitsBytes?: number;
  /** Makes an object of this retention class expire (moves the clock past its keep time). Absent: the store does not expire. */
  expire?: (retention: string) => Promise<void>;
  dispose?: () => Promise<void>;
}
export interface ObjectStorageHarness {
  create(): Promise<ObjectStorageUnderTest>;
}

const META: ObjectMeta = { contentType: "text/plain", metadata: { kind: "log_txt" }, retention: "evidence-std" };
const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text));
const text = (value: Uint8Array | undefined): string | undefined => (value === undefined ? undefined : Buffer.from(value).toString());

export function runObjectStorageConformance(name: string, harness: ObjectStorageHarness): void {
  async function withStore<T>(body: (under: ObjectStorageUnderTest) => Promise<T>): Promise<T> {
    const under = await harness.create();
    try {
      return await body(under);
    } finally {
      await under.dispose?.();
    }
  }

  describe(`object storage conformance: ${name}`, () => {
    it("keeps an object and gives back every byte of it, with its size and metadata", () => withStore(async ({ store }) => {
      const everyByte = new Uint8Array(256).map((_, index) => index);
      await store.put("private/owner-1/ws-1/evidence/t-1/abc", everyByte, META);
      const back = await store.get("private/owner-1/ws-1/evidence/t-1/abc", 1_000);
      expect(Buffer.from(back!).equals(Buffer.from(everyByte))).toBe(true);
      expect(await store.stat("private/owner-1/ws-1/evidence/t-1/abc")).toEqual({ bytes: 256, metadata: { kind: "log_txt" } });
    }));

    it("keeps an empty object", () => withStore(async ({ store }) => {
      await store.put("empty", new Uint8Array(0), META);
      expect((await store.get("empty", 10))?.byteLength).toBe(0);
      expect((await store.stat("empty"))?.bytes).toBe(0);
    }));

    it("never replaces an object unless the put asks to: a second put on a taken key is a conflict and changes nothing", () => withStore(async ({ store }) => {
      await store.put("k", bytes("first"), { ...META, metadata: { a: "1" } });
      await expect(store.put("k", bytes("second and longer"), { ...META, metadata: { b: "2" } })).rejects.toBeInstanceOf(ObjectConflictError);
      await expect(store.put("k", bytes("third"), { ...META, metadata: { b: "2" } }, {})).rejects.toBeInstanceOf(ObjectConflictError);
      expect(text(await store.get("k", 100))).toBe("first");
      expect(await store.stat("k")).toEqual({ bytes: 5, metadata: { a: "1" } });
      // The same bytes again are a conflict too: a caller that retries a write says so with overwrite.
      await expect(store.put("k", bytes("first"), META)).rejects.toBeInstanceOf(ObjectConflictError);
      // A key that was deleted is free again.
      await store.delete("k");
      await store.put("k", bytes("fresh"), META);
      expect(text(await store.get("k", 100))).toBe("fresh");
    }));

    it("lets exactly one of several writers racing for a new key win, and the object is that writer's whole", () => withStore(async ({ store }) => {
      const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => store.put("raced", new Uint8Array(10_000).fill(index + 1), META)));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      for (const result of results) if (result.status === "rejected") expect(result.reason).toBeInstanceOf(ObjectConflictError);
      const back = (await store.get("raced", 100_000)) as Uint8Array;
      expect(back.byteLength).toBe(10_000);
      expect(new Set(back).size).toBe(1);
    }));

    it("replaces an object at the same key whole when the put says overwrite", () => withStore(async ({ store }) => {
      await store.put("k", bytes("first and longer"), { ...META, metadata: { a: "1" } });
      await store.put("k", bytes("second"), { ...META, metadata: { b: "2" } }, { overwrite: true });
      expect(text(await store.get("k", 100))).toBe("second");
      expect(await store.stat("k")).toEqual({ bytes: 6, metadata: { b: "2" } });
    }));

    it("answers undefined for no object, and never cuts an object that is bigger than the cap", () => withStore(async ({ store }) => {
      expect(await store.get("missing", 100)).toBeUndefined();
      expect(await store.stat("missing")).toBeUndefined();
      await store.put("k", bytes("0123456789"), META);
      expect(await store.get("k", 9)).toBeUndefined();
      expect(text(await store.get("k", 10))).toBe("0123456789");
    }));

    it("refuses an object it cannot hold, and keeps the old one", () => withStore(async ({ store, tooBigBytes, fitsBytes }) => {
      const fits = fitsBytes ?? 65_536;
      await store.put("fits", new Uint8Array(fits).fill(7), META);
      expect((await store.get("fits", fits))?.byteLength).toBe(fits);
      if (tooBigBytes === undefined) return;
      await store.put("big", bytes("old"), META);
      await expect(store.put("big", new Uint8Array(tooBigBytes), META)).rejects.toBeInstanceOf(ObjectTooBigError);
      expect(text(await store.get("big", 100))).toBe("old");
    }));

    it("deletes an object, and deleting what is not there is not an error", () => withStore(async ({ store }) => {
      await store.put("k", bytes("x"), META);
      await store.delete("k");
      await store.delete("k");
      await store.delete("never/was");
      expect(await store.get("k", 10)).toBeUndefined();
      expect(await store.stat("k")).toBeUndefined();
    }));

    it("keeps keys that differ only in case apart, and a key beside the same key used as a folder", () => withStore(async ({ store }) => {
      await store.put("Abc", bytes("upper"), META);
      await store.put("abc", bytes("lower"), META);
      await store.put("abc/def", bytes("inside"), META);
      expect(text(await store.get("Abc", 10))).toBe("upper");
      expect(text(await store.get("abc", 10))).toBe("lower");
      expect(text(await store.get("abc/def", 10))).toBe("inside");
      await store.delete("abc");
      expect(text(await store.get("abc/def", 10))).toBe("inside");
      expect(text(await store.get("Abc", 10))).toBe("upper");
    }));

    it("deletes by prefix: a plain text prefix, nothing else, and reports that none is left", () => withStore(async ({ store }) => {
      for (const key of ["a/b/1", "a/b/2", "a/b/c/3", "a/bc", "a/x", "z/b/1", "A/b/1"]) await store.put(key, bytes(key), META);
      expect(await store.deletePrefix("a/b/")).toBe(true);
      expect(await store.get("a/b/1", 10)).toBeUndefined();
      expect(await store.get("a/b/2", 10)).toBeUndefined();
      expect(await store.get("a/b/c/3", 10)).toBeUndefined();
      expect(text(await store.get("a/bc", 10))).toBe("a/bc");
      expect(text(await store.get("a/x", 10))).toBe("a/x");
      expect(text(await store.get("z/b/1", 10))).toBe("z/b/1");
      expect(text(await store.get("A/b/1", 10))).toBe("A/b/1");
      // Without the slash the prefix is just text: it takes `a/bc` too.
      expect(await store.deletePrefix("a/b")).toBe(true);
      expect(await store.get("a/bc", 10)).toBeUndefined();
      expect(text(await store.get("a/x", 10))).toBe("a/x");
      expect(await store.deletePrefix("nothing/here/")).toBe(true);
    }));

    it("refuses an empty prefix, which would wipe the store", () => withStore(async ({ store }) => {
      await store.put("k", bytes("x"), META);
      await expect(store.deletePrefix("")).rejects.toBeInstanceOf(ObjectKeyError);
      expect(text(await store.get("k", 10))).toBe("x");
    }));

    it("refuses a key that could name a place outside the store, or that other adapters cannot keep", () => withStore(async ({ store }) => {
      const bad = ["", "/abs", "a//b", "a/", "../x", "a/../b", "a/./b", ".", "..", "a\\b", "a\u0000b", "a b", "a/b?c", "é", "x".repeat(129), `${"a/".repeat(600)}z`, "a/%2e%2e/b"];
      for (const key of bad) {
        await expect(store.put(key, bytes("x"), META), JSON.stringify(key)).rejects.toBeInstanceOf(ObjectKeyError);
        await expect(store.get(key, 10), JSON.stringify(key)).rejects.toBeInstanceOf(ObjectKeyError);
        await expect(store.stat(key), JSON.stringify(key)).rejects.toBeInstanceOf(ObjectKeyError);
        await expect(store.delete(key), JSON.stringify(key)).rejects.toBeInstanceOf(ObjectKeyError);
      }
      await expect(store.deletePrefix("../")).rejects.toBeInstanceOf(ObjectKeyError);
      await expect(store.deletePrefix("a/../b")).rejects.toBeInstanceOf(ObjectKeyError);
    }));

    it("refuses metadata that is too large to keep with the object", () => withStore(async ({ store }) => {
      await expect(store.put("k", bytes("x"), { ...META, metadata: { big: "x".repeat(5_000) } })).rejects.toBeInstanceOf(ObjectMetaError);
      expect(await store.get("k", 10)).toBeUndefined();
    }));

    it("keeps metadata of exactly 2 KB (names and values) and refuses one byte more, the limit every adapter shares (S3's own)", () => withStore(async ({ store }) => {
      const fits = { m: "x".repeat(2_047) };
      await store.put("fits", bytes("x"), { ...META, metadata: fits });
      expect((await store.stat("fits"))?.metadata).toEqual(fits);
      await expect(store.put("over", bytes("x"), { ...META, metadata: { m: "x".repeat(2_048) } })).rejects.toBeInstanceOf(ObjectMetaError);
      expect(await store.get("over", 10)).toBeUndefined();
    }));

    it("keeps a part of 128 characters, the longest id the evidence erase accepts", () => withStore(async ({ store }) => {
      const key = `private/${"a1".repeat(64)}/${"b".repeat(128)}/evidence/t/${"0".repeat(64)}`;
      await store.put(key, bytes("long"), META);
      expect(text(await store.get(key, 10))).toBe("long");
      expect(await store.deletePrefix(`private/${"a1".repeat(64)}/`)).toBe(true);
      expect(await store.get(key, 10)).toBeUndefined();
    }));

    it("keeps a punctuated key as itself", () => withStore(async ({ store }) => {
      const key = "private/Owner.1/ws=2/evidence/t_3/sha256:ab+cd,e@f~g-h";
      await store.put(key, bytes("ok"), META);
      expect(text(await store.get(key, 10))).toBe("ok");
      expect(await store.deletePrefix("private/Owner.1/")).toBe(true);
      expect(await store.get(key, 10)).toBeUndefined();
    }));

    it("lets two writers replace the same key at once and leaves one whole object", () => withStore(async ({ store }) => {
      const a = new Uint8Array(20_000).fill(1);
      const b = new Uint8Array(30_000).fill(2);
      const again = { overwrite: true } as const;
      await Promise.all([store.put("race", a, META, again), store.put("race", b, META, again), store.put("race", a, META, again), store.put("race", b, META, again)]);
      const back = await store.get("race", 100_000);
      expect(back).toBeDefined();
      const whole = back as Uint8Array;
      expect([20_000, 30_000]).toContain(whole.byteLength);
      expect(new Set(whole).size).toBe(1);
      expect((await store.stat("race"))?.bytes).toBe(whole.byteLength);
    }));

    it("expires an object of a class with a keep time, and keeps one of an unknown class", () => withStore(async ({ store, expire }) => {
      if (expire === undefined) return;
      await store.put("short", bytes("x"), { ...META, retention: "evidence-std" });
      await store.put("forever", bytes("y"), { ...META, retention: "no-such-class" });
      await expire("evidence-std");
      expect(await store.get("short", 10)).toBeUndefined();
      expect(await store.stat("short")).toBeUndefined();
      expect(text(await store.get("forever", 10))).toBe("y");
      // An expired object does not hold its key.
      await store.put("short", bytes("again"), { ...META, retention: "no-such-class" });
      expect(text(await store.get("short", 10))).toBe("again");
    }));
  });
}
