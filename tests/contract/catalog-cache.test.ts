import { describe, expect, it } from "vitest";
import { CatalogCache } from "../../packages/gateway/src/index.js";

describe("catalog cache", () => {
  it("returns a value until its time-to-live passes", () => {
    let now = 1_000;
    const cache = new CatalogCache<string>({ ttlMs: 600_000, maxEntries: 4, now: () => now });
    cache.set("a", "catalog");
    now += 599_999;
    expect(cache.get("a")).toBe("catalog");
    now += 1;
    expect(cache.get("a")).toBeUndefined();
  });

  it("evicts the oldest entry at capacity and supports deletion", () => {
    const cache = new CatalogCache<number>({ ttlMs: 60_000, maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    cache.delete("b");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });
});
