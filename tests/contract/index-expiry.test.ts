// Spec 025 A6 (Q5): where the State table has no TTL (the legacy deployment), the reconciler deletes
// failure and usage index items older than 30 days.
import { describe, expect, it } from "vitest";
import { expireIndexDays, indexSweepWanted, INDEX_EXPIRY_DELETES_PER_RUN } from "../../packages/broker/src/aws/index-expiry.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = new Date("2026-10-31T06:00:00.000Z");
const item = (prefix: string, day: string, n: number) => ({ pk: `${prefix}${day}`, sk: `${day}T08:00:00.${String(n).padStart(3, "0")}Z#op${n}`, entityType: `${prefix.slice(0, -1)}_INDEX` });

describe("index expiry (A6)", () => {

  it("stops at 500 deletes a run, so one run stays short, and the next run goes on", async () => {
    const db = new FakeDynamoDb();
    for (let n = 0; n < 520; n += 1) db.set(item("FAILURE#", "2026-09-29", n));
    expect(await expireIndexDays(db, "state", NOW)).toEqual({ deleted: INDEX_EXPIRY_DELETES_PER_RUN });
    expect(await expireIndexDays(db, "state", NOW)).toEqual({ deleted: 20 });
  });

  it("runs only where the State table has no TTL (INDEX_EXPIRY=ttl is set in named environments)", () => {
    expect(indexSweepWanted({})).toBe(true);
    expect(indexSweepWanted({ INDEX_EXPIRY: "ttl" })).toBe(false);
  });

});
