import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoPriceSnapshotStore, PRICE_CHUNK_BYTES } from "../../packages/model-gateway/src/dynamo-prices.js";
import type { PriceSnapshot } from "../../packages/model-gateway/src/price-snapshot.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const PRICES = "gw-prices";
function store() {
  const wire = new WireDynamo([PRICES]);
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
  return { wire, store: new DynamoPriceSnapshotStore(db, PRICES) };
}
/** Random model names compress badly, so this snapshot spans several 350 KB chunks. */
function snapshot(version: number, entries: number): PriceSnapshot {
  return { version, sources: { litellm: { fetchedAt: 1_800_000_000_000, count: entries, entries: Array.from({ length: entries }, () => ({ provider: "openai" as const, model: `m-${randomBytes(24).toString("hex")}`, kind: "chat" as const, inputMicrosPerMTok: 1 + Math.floor(Math.random() * 1000), outputMicrosPerMTok: 2_000_000 })) } } };
}

describe("DynamoPriceSnapshotStore", () => {
  it("saves a multi-chunk snapshot and loads exactly it back, writing only the prices table and deleting nothing", async () => {
    const { wire, store: prices } = store();
    expect(await prices.load()).toBeUndefined();
    const first = snapshot(1, 19_000);
    expect(await prices.save(first, 0)).toBe(true);
    const chunks = wire.items(PRICES).filter((item) => String(item.sk).startsWith("SLOT#0#"));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect((chunk.data as Uint8Array).byteLength).toBeLessThanOrEqual(PRICE_CHUNK_BYTES);
    expect(await prices.load()).toEqual(first);
    expect(new Set(wire.calls.map((c) => c.table))).toEqual(new Set([PRICES]));
    expect(wire.calls.map((c) => c.operation).filter((op) => !["GetItem", "PutItem", "UpdateItem"].includes(op))).toEqual([]);
  });

  it("moves the head only from the version it read (a second writer loses) and alternates slots", async () => {
    const { wire, store: prices } = store();
    expect(await prices.save(snapshot(1, 10), 0)).toBe(true);
    expect(await prices.save(snapshot(2, 10), 0)).toBe(false);
    expect(await prices.save(snapshot(3, 10), 1)).toBe(false);
    const second = snapshot(2, 20);
    expect(await prices.save(second, 1)).toBe(true);
    expect(wire.items(PRICES).find((item) => item.sk === "HEAD")).toMatchObject({ version: 2, slot: 1 });
    expect(await prices.load()).toEqual(second);
    const third = snapshot(3, 5);
    expect(await prices.save(third, 2)).toBe(true);
    expect(wire.items(PRICES).find((item) => item.sk === "HEAD")).toMatchObject({ version: 3, slot: 0 });
    expect(await prices.load()).toEqual(third);
    expect(await prices.save({ version: 4, sources: { bogus: {} } } as unknown as PriceSnapshot, 3)).toBe(false);
  });

  it("refuses a slot overwritten or cut short under the head (version or hash mismatch)", async () => {
    const { wire, store: prices } = store();
    expect(await prices.save(snapshot(1, 50), 0)).toBe(true);
    const chunk = wire.items(PRICES).find((item) => item.sk === "SLOT#0#0")!;
    await new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }), transport: wire.transport })
      .put(PRICES, { pk: "PRICES", sk: "SLOT#0#0", version: 1, data: new Uint8Array(Buffer.concat([Buffer.from(chunk.data as Uint8Array), Buffer.from("x")])) });
    await expect(prices.load()).rejects.toThrow("prices unavailable");
    await new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }), transport: wire.transport })
      .put(PRICES, { pk: "PRICES", sk: "SLOT#0#0", version: 7, data: chunk.data as Uint8Array });
    await expect(prices.load()).rejects.toThrow("prices unavailable");
  });

  it("refuses a whole, valid snapshot of the same version that is not the one the head names (a lost writer's chunk)", async () => {
    const { wire, store: prices } = store();
    expect(await prices.save(snapshot(1, 3), 0)).toBe(true);
    const other = store();
    expect(await other.store.save(snapshot(1, 4), 0)).toBe(true);
    const foreign = other.wire.items(PRICES).find((item) => item.sk === "SLOT#0#0")!;
    await new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }), transport: wire.transport })
      .put(PRICES, { pk: "PRICES", sk: "SLOT#0#0", version: 1, data: foreign.data as Uint8Array });
    await expect(prices.load()).rejects.toThrow("prices unavailable");
  });
});
