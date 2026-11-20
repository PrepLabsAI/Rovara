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

it.each([0, -1, NaN, Infinity, "100"])("starts no work for invalid budget %s", async (budgetMs) => {
  const work = vi.fn(async () => ({}));
  const pass = boundedCorePass(new MemoryDocumentStore(), () => 0, work);
  expect(await pass.pass({ budgetMs: budgetMs as number })).toEqual({ complete: false, reason: "budget" });
  expect(work).not.toHaveBeenCalled();
});
