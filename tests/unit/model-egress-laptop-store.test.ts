// TE-F1c: the laptop's product-key store and local meter. Apart from `local/model-proxy/credentials.ts` and the Rovara-agent key store `keys.json` (DECISIONS 157): its own file, its own words.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureKey } from "../../packages/testing/src/ports/model-egress-fixtures.js";
import { createProductKeyStore, PRODUCT_KEYS_FILE_NAME } from "../../packages/broker/src/local/model-egress/key-store.js";
import { createLocalMeter, DEFAULT_MONTH_CAP_MICROS, DEFAULT_TASK_CAP_MICROS } from "../../packages/broker/src/local/model-egress/meter.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "k-")); });
afterEach(() => { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); });
const KEY = fixtureKey("laptop-store");

describe("the product key store", () => {
  it("keeps a key in its own owner-only file, apart from keys.json, and reads it back per owner and source", async () => {
    const store = createProductKeyStore({ directory: dir });
    await store.set("owner-a", "src-1", { rowId: "gemini", key: KEY });
    await store.set("owner-b", "src-1", { rowId: "gemini", key: `${KEY}-b` });
    expect(statSync(join(dir, PRODUCT_KEYS_FILE_NAME)).mode & 0o777).toBe(0o600);
    expect(PRODUCT_KEYS_FILE_NAME).not.toBe("keys.json");
    expect((await store.get("owner-a", "src-1"))?.key).toBe(KEY);
    expect((await store.get("owner-b", "src-1"))?.key).toBe(`${KEY}-b`);
    expect(await store.get("owner-a", "src-2")).toBeUndefined();
    expect(await store.get("nobody", "src-1")).toBeUndefined();
    // a second store over the same folder sees it (it is on disk)
    expect((await createProductKeyStore({ directory: dir }).get("owner-a", "src-1"))?.key).toBe(KEY);
  });
  it("lists sources without their keys, and removes one", async () => {
    const store = createProductKeyStore({ directory: dir });
    await store.set("o", "s1", { rowId: "openai", key: KEY });
    const listed = await store.list("o");
    expect(listed).toEqual([{ sourceId: "s1", rowId: "openai" }]);
    expect(JSON.stringify(listed)).not.toContain(KEY);
    expect(await store.remove("o", "s1")).toBe(true);
    expect(await store.get("o", "s1")).toBeUndefined();
    expect(await store.remove("o", "s1")).toBe(false);
  });
  it("refuses a key the core cannot place, in fixed words that never repeat it", async () => {
    const store = createProductKeyStore({ directory: dir });
    for (const key of ["", "tiny-key", `${KEY}\nx-injected: 1`, "a".repeat(5000)]) {
      const failure = await store.set("o", "s", { rowId: "openai", key }).then(() => undefined, (error: unknown) => error);
      expect(failure, JSON.stringify(key.slice(0, 10))).toBeInstanceOf(Error);
      expect(String((failure as Error).message).includes(key) && key.length > 0).toBe(false);
    }
    await expect(store.set("o", "bad id!", { rowId: "openai", key: KEY })).rejects.toThrow();
    await expect(store.set("o", "s", { rowId: "Bad Row", key: KEY })).rejects.toThrow();
  });
  it("refuses to read a file that other users can read, or that is a link, without printing it", async () => {
    const store = createProductKeyStore({ directory: dir });
    await store.set("o", "s", { rowId: "openai", key: KEY });
    chmodSync(join(dir, PRODUCT_KEYS_FILE_NAME), 0o644);
    const failure = await store.get("o", "s").then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).not.toContain(KEY);
    const other = mkdtempSync(join(tmpdir(), "k-"));
    try {
      mkdirSync(join(other, "x"));
      writeFileSync(join(other, "real.json"), "{}");
      symlinkSync(join(other, "real.json"), join(other, "x", PRODUCT_KEYS_FILE_NAME));
      await expect(createProductKeyStore({ directory: join(other, "x") }).get("o", "s")).rejects.toThrow();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
  it("treats prototype-looking ids as plain data", async () => {
    const store = createProductKeyStore({ directory: dir });
    await store.set("__proto__", "constructor", { rowId: "openai", key: KEY });
    expect((await store.get("__proto__", "constructor"))?.key).toBe(KEY);
    expect(await store.get("other", "toString")).toBeUndefined();
    expect(({} as Record<string, unknown>).key).toBeUndefined();
  });
});

describe("the local meter", () => {
  const clock = { now: Date.UTC(2026, 10, 13, 10) };
  const make = () => createLocalMeter({ directory: dir, now: () => clock.now });
  it("has the design's default caps: $2 a task, $50 a month", async () => {
    expect(DEFAULT_TASK_CAP_MICROS).toBe(2_000_000);
    expect(DEFAULT_MONTH_CAP_MICROS).toBe(50_000_000);
    expect(await make().caps("o")).toEqual({ taskCapMicros: 2_000_000, monthCapMicros: 50_000_000 });
  });
  it("reserves, then settles to the real cost; the spend is kept in a file (0600) across restarts", async () => {
    const meter = make();
    const held = await meter.reserve({ owner: "o", task: "t1", estimateMicros: 500_000 });
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    expect((await meter.taskSpent("o", "t1"))).toBe(500_000);
    expect(await meter.settle(held.handle, 120_000)).toEqual({ overrun: false });
    expect(await meter.taskSpent("o", "t1")).toBe(120_000);
    expect(await make().taskSpent("o", "t1")).toBe(120_000);
    expect(statSync(join(dir, "model-meter.json")).mode & 0o777).toBe(0o600);
  });
  it("refuses a reservation that would pass the task cap or the month cap, naming the cap, and reserves nothing", async () => {
    const meter = make();
    await meter.setCaps("o", { taskCapMicros: 1_000_000, monthCapMicros: 1_500_000 });
    const a = await meter.reserve({ owner: "o", task: "t1", estimateMicros: 900_000 });
    expect(a.ok).toBe(true);
    expect(await meter.reserve({ owner: "o", task: "t1", estimateMicros: 200_000 })).toEqual({ ok: false, reason: "task_cap", capMicros: 1_000_000 });
    expect(await meter.taskSpent("o", "t1")).toBe(900_000);
    // another task: the task cap is per task, the month cap is the owner's
    expect((await meter.reserve({ owner: "o", task: "t2", estimateMicros: 500_000 })).ok).toBe(true);
    expect(await meter.reserve({ owner: "o", task: "t3", estimateMicros: 200_000 })).toEqual({ ok: false, reason: "month_cap", capMicros: 1_500_000 });
  });
  it("one call may overrun the cap; after it the task takes no more", async () => {
    const meter = make();
    await meter.setCaps("o", { taskCapMicros: 1_000_000 });
    const held = await meter.reserve({ owner: "o", task: "t", estimateMicros: 900_000 });
    if (!held.ok) throw new Error("expected a reservation");
    expect(await meter.settle(held.handle, 1_300_000)).toEqual({ overrun: true });
    expect(await meter.reserve({ owner: "o", task: "t", estimateMicros: 1 })).toEqual({ ok: false, reason: "overrun", capMicros: 1_000_000 });
    // a call that costs more than its estimate but leaves the spend under the cap does not block
    const second = await meter.reserve({ owner: "o", task: "u", estimateMicros: 100_000 });
    if (!second.ok) throw new Error("expected a reservation");
    expect(await meter.settle(second.handle, 400_000)).toEqual({ overrun: false });
    expect((await meter.reserve({ owner: "o", task: "u", estimateMicros: 1 })).ok).toBe(true);
  });
  it("keeps owners apart and resets the month on the 1st (UTC)", async () => {
    const meter = make();
    const a = await meter.reserve({ owner: "a", task: "t", estimateMicros: 1_000 });
    expect(a.ok).toBe(true);
    expect(await meter.spentFor("b")).toBe(0);
    expect(await meter.spentFor("a")).toBe(1_000);
    await meter.setCaps("a", { monthCapMicros: 1_500 });
    expect(await meter.reserve({ owner: "a", task: "t2", estimateMicros: 1_000 })).toMatchObject({ ok: false, reason: "month_cap" });
    clock.now = Date.UTC(2026, 11, 1, 0, 0, 1);
    expect((await meter.reserve({ owner: "a", task: "t2", estimateMicros: 1_000 })).ok).toBe(true);
    clock.now = Date.UTC(2026, 10, 13, 10);
  });
  it("a reservation that was never settled (a crash) stays counted: the meter errs high", async () => {
    const first = make();
    await first.reserve({ owner: "o", task: "t", estimateMicros: 700_000 });
    expect(await make().taskSpent("o", "t")).toBe(700_000);
  });
  it("refuses a file that is not its own shape, and a non-whole estimate", async () => {
    writeFileSync(join(dir, "model-meter.json"), "{\"version\":9}", { mode: 0o600 });
    await expect(make().taskSpent("o", "t")).rejects.toThrow();
    rmSync(join(dir, "model-meter.json"));
    await expect(make().reserve({ owner: "o", task: "t", estimateMicros: 1.5 })).rejects.toThrow();
    await expect(make().reserve({ owner: "o", task: "t", estimateMicros: -1 })).rejects.toThrow();
  });
  it("serialises concurrent reservations: two that cannot both fit never both succeed", async () => {
    const meter = make();
    await meter.setCaps("o", { taskCapMicros: 1_000 });
    const results = await Promise.all(Array.from({ length: 5 }, () => meter.reserve({ owner: "o", task: "t", estimateMicros: 400 })));
    expect(results.filter((result) => result.ok)).toHaveLength(2);
    void readFileSync;
  });
});
