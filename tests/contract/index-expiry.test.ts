// Spec 025 A6 (Q5): where the State table has no TTL (the legacy deployment), the reconciler deletes
// failure and usage index items older than 30 days.
import { describe, expect, it, vi } from "vitest";
import { expireIndexDays, indexSweepWanted, INDEX_EXPIRY_DELETES_PER_RUN } from "../../packages/broker/src/aws/index-expiry.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = new Date("2026-10-31T06:00:00.000Z");
const item = (prefix: string, day: string, n: number) => ({ pk: `${prefix}${day}`, sk: `${day}T08:00:00.${String(n).padStart(3, "0")}Z#op${n}`, entityType: `${prefix.slice(0, -1)}_INDEX` });

describe("index expiry (A6)", () => {
  it("deletes failure and usage items of days 31 to 45 back, and keeps day 30", async () => {
    const db = new FakeDynamoDb();
    for (const entry of [item("FAILURE#", "2026-09-30", 1), item("USAGE#", "2026-09-30", 2), item("FAILURE#", "2026-10-01", 3), item("FAILURE#", "2026-09-16", 4), item("FAILURE#", "2026-09-15", 5)]) db.set(entry);
    const log = vi.fn();
    expect(await expireIndexDays(db, "state", NOW, log)).toEqual({ deleted: 3 });
    expect(db.find((entry) => String(entry.pk).startsWith("FAILURE#") || String(entry.pk).startsWith("USAGE#")).map((entry) => entry.pk).sort()).toEqual(["FAILURE#2026-09-15", "FAILURE#2026-10-01"]);
    expect(log).toHaveBeenCalledWith({ event: "index_expiry.deleted", deleted: 3 });
  });

  it("stops at 500 deletes a run, so one run stays short, and the next run goes on", async () => {
    const db = new FakeDynamoDb();
    for (let n = 0; n < 520; n += 1) db.set(item("FAILURE#", "2026-09-29", n));
    expect(await expireIndexDays(db, "state", NOW)).toEqual({ deleted: INDEX_EXPIRY_DELETES_PER_RUN });
    expect(await expireIndexDays(db, "state", NOW)).toEqual({ deleted: 20 });
  });

  it("clears the oldest day first under a backlog, so days about to leave the window go first", async () => {
    const db = new FakeDynamoDb();
    for (let n = 0; n < 300; n += 1) {
      db.set(item("FAILURE#", "2026-09-30", n)); // 31 days back
      db.set(item("FAILURE#", "2026-09-16", n)); // 45 days back
    }
    expect(await expireIndexDays(db, "state", NOW)).toEqual({ deleted: INDEX_EXPIRY_DELETES_PER_RUN });
    expect(db.find((entry) => entry.pk === "FAILURE#2026-09-16")).toEqual([]);
    expect(db.find((entry) => entry.pk === "FAILURE#2026-09-30")).toHaveLength(100);
  });

  it("runs only where the State table has no TTL (INDEX_EXPIRY=ttl is set in named environments)", () => {
    expect(indexSweepWanted({})).toBe(true);
    expect(indexSweepWanted({ INDEX_EXPIRY: "ttl" })).toBe(false);
  });

  it("touches nothing else in those partitions' neighbourhood", async () => {
    const db = new FakeDynamoDb();
    db.set({ pk: "SETUP_WATCH", sk: "2026-09-20T00:00:00.000Z#w", entityType: "SETUP_WATCH" });
    await expireIndexDays(db, "state", NOW);
    expect(db.get("SETUP_WATCH", "2026-09-20T00:00:00.000Z#w")).toBeDefined();
  });
});
