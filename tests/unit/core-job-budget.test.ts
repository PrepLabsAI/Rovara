import { expect, it, vi } from "vitest";
import { boundedCorePass } from "../../packages/broker/src/aws/core-job-pass.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";

it("shares one total time and item allowance across awaited store calls", async () => {
  const store = new MemoryDocumentStore();
  let at = 0;
  const reads = vi.spyOn(store, "get");
  const pass = boundedCorePass(store, () => at, async (limited) => {
    await limited.get({ pk: "ONE", sk: "META" });
    at = 101;
    await limited.put({ item: { pk: "ONE", sk: "META" } });
    return { complete: true };
  });
  expect(await pass.pass({ budgetMs: 100 })).toEqual({ complete: false, reason: "budget" });
  expect(reads).toHaveBeenCalledTimes(1);
  expect(await store.get({ pk: "ONE", sk: "META" })).toBeUndefined();
});

it("joins an in-flight call before returning and permits no late write", async () => {
  const store = new MemoryDocumentStore();
  let at = 0, finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  vi.spyOn(store, "get").mockImplementation(async () => { await gate; return undefined; });
  const write = vi.spyOn(store, "put");
  const pass = boundedCorePass(store, () => at, async (limited) => {
    await limited.get({ pk: "ONE", sk: "META" });
    await limited.put({ item: { pk: "ONE", sk: "META" } });
    return { complete: true };
  });
  const pending = pass.pass({ budgetMs: 100 });
  at = 101;
  finish();
  expect(await pending).toEqual({ complete: false, reason: "budget" });
  expect(write).not.toHaveBeenCalled();
});

it("caps total store operations on a frozen clock and sanitizes unexpected failures", async () => {
  const store = new MemoryDocumentStore();
  const pass = boundedCorePass(store, () => 0, async (limited) => {
    for (let n = 0; n < 10_000; n++) await limited.get({ pk: "ONE", sk: "META" });
    return { complete: true };
  });
  expect(await pass.pass({ budgetMs: 1000 })).toEqual({ complete: false, reason: "budget" });
  const bad = boundedCorePass(store, () => 0, async () => { throw new Error("private-canary"); });
  await expect(bad.pass({ budgetMs: 1000 })).rejects.toThrow(new Error("the core job could not finish"));
});

it.each([0, -1, NaN, Infinity, "100"])("starts no work for invalid budget %s", async (budgetMs) => {
  const work = vi.fn(async () => ({}));
  const pass = boundedCorePass(new MemoryDocumentStore(), () => 0, work);
  expect(await pass.pass({ budgetMs: budgetMs as number })).toEqual({ complete: false, reason: "budget" });
  expect(work).not.toHaveBeenCalled();
});

it("caps an oversized caller allowance to the service maximum", async () => {
  let at = 0;
  const pass = boundedCorePass(new MemoryDocumentStore(), () => at, async (store) => {
    at = 20_001;
    await store.get({ pk: "ONE", sk: "META" });
    return { complete: true };
  });
  expect(await pass.pass({ budgetMs: 1_000_000 })).toEqual({ complete: false, reason: "budget" });
});

it("caps total returned bytes across reads", async () => {
  const store = new MemoryDocumentStore();
  await store.put({ item: { pk: "ONE", sk: "META", value: "a".repeat(300_000) } });
  const pass = boundedCorePass(store, () => 0, async (limited) => {
    for (let n = 0; n < 20; n++) await limited.get({ pk: "ONE", sk: "META" });
    return { complete: true };
  });
  expect(await pass.pass({ budgetMs: 1000 })).toEqual({ complete: false, reason: "budget" });
});

it("caps total returned items across pages, even when byte sizes are small", async () => {
  const store = new MemoryDocumentStore();
  vi.spyOn(store, "query").mockResolvedValue({ items: Array.from({ length: 100 }, (_, n) => ({ pk: "ONE", sk: String(n) })) });
  const pass = boundedCorePass(store, () => 0, async (limited) => {
    for (let n = 0; n < 20; n++) await limited.query({ pk: "ONE", limit: 100 });
    return { complete: true };
  });
  expect(await pass.pass({ budgetMs: 1000 })).toEqual({ complete: false, reason: "budget" });
});

it("drops untrusted error causes as well as their messages", async () => {
  const pass = boundedCorePass(new MemoryDocumentStore(), () => 0, async () => { throw new Error("private-canary", { cause: "private-cause" }); });
  const error: unknown = await pass.pass({ budgetMs: 100 }).catch((error: unknown) => error);
  expect(error).toMatchObject({ message: "the core job could not finish" });
  expect(error).not.toHaveProperty("cause");
});

it("finishes at the stated operation and returned-item limits", async () => {
  const store = new MemoryDocumentStore();
  const read = vi.spyOn(store, "get");
  const operations = boundedCorePass(store, () => 0, async (limited) => {
    for (let n = 0; n < 512; n++) await limited.get({ pk: "ONE", sk: "META" });
    return { complete: true };
  });
  expect(await operations.pass({ budgetMs: 20_000 })).toEqual({ complete: true });
  expect(read).toHaveBeenCalledTimes(512);
  vi.spyOn(store, "query").mockResolvedValue({ items: Array.from({ length: 100 }, (_, n) => ({ pk: "ONE", sk: String(n) })) });
  const items = boundedCorePass(store, () => 0, async (limited) => {
    for (let n = 0; n < 10; n++) await limited.query({ pk: "ONE", limit: 100 });
    return { complete: true };
  });
  expect(await items.pass({ budgetMs: 20_000 })).toEqual({ complete: true });
});

it("finishes at the stated total byte limit", async () => {
  const store = new MemoryDocumentStore();
  const overhead = Buffer.byteLength(JSON.stringify({ pk: "ONE", sk: "META", payload: "" }));
  let reads = 0;
  vi.spyOn(store, "get").mockImplementation(async () => ({ pk: "ONE", sk: "META", payload: "a".repeat(++reads <= 13 ? 300_000 : 4 * 1024 * 1024 - 13 * (300_000 + overhead) - overhead) }));
  const pass = boundedCorePass(store, () => 0, async (limited) => {
    for (let n = 0; n < 14; n++) await limited.get({ pk: "ONE", sk: "META" });
    return { complete: true };
  });
  expect(await pass.pass({ budgetMs: 20_000 })).toEqual({ complete: true });
});
