import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Dynamo } from "./dynamo.js";
import { whole } from "./model-gateway-token.js";
import { validSnapshot, type PriceSnapshot, type PriceSnapshotStore } from "./price-snapshot.js";

/**
 * The last good price snapshot in the prices table. A snapshot is several megabytes of JSON, past DynamoDB's 400 KB item limit,
 * so it is stored gzipped in 300 KB chunks under one head:
 *
 *   PRICES / HEAD            { version, slot, chunks, sha256 }   the one current snapshot
 *   PRICES / SLOT#<s>#<i>    { version, data }                    chunk i of the snapshot in slot s (0 or 1)
 *
 * A save writes the chunks into the slot the head does not point at, then moves the head with a condition on the version it
 * read (two writers cannot both win; PriceRefresher's expectedVersion). The two slots are reused, so nothing is ever deleted
 * (the price job's role has no DeleteItem). A reader checks every chunk's version and the whole snapshot's SHA-256 against
 * the head, so a half-written or overwritten slot is refused (SnapshotPriceSource then keeps the prices it has).
 */
export const PRICES_PARTITION = "PRICES";
export const PRICE_CHUNK_BYTES = 300_000;
export const MAX_PRICE_CHUNKS = 64;
export const MAX_SNAPSHOT_JSON_BYTES = 128 * 1024 * 1024;

export class DynamoPriceSnapshotStore implements PriceSnapshotStore {
  constructor(private readonly db: Dynamo, private readonly table: string) {}

  async #head(): Promise<{ version: number; slot: 0 | 1; chunks: number; sha256: string } | undefined> {
    const head = await this.db.get(this.table, { pk: PRICES_PARTITION, sk: "HEAD" });
    if (head === undefined) return undefined;
    if (!whole(head.version) || head.version < 1 || (head.slot !== 0 && head.slot !== 1) || !whole(head.chunks) || head.chunks < 1 || head.chunks > MAX_PRICE_CHUNKS || typeof head.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(head.sha256)) throw new Error("prices unavailable");
    return { version: head.version, slot: head.slot, chunks: head.chunks, sha256: head.sha256 };
  }

  async load(): Promise<PriceSnapshot | undefined> {
    const head = await this.#head();
    if (head === undefined) return undefined;
    const parts = await Promise.all(Array.from({ length: head.chunks }, (_, i) => this.db.get(this.table, { pk: PRICES_PARTITION, sk: `SLOT#${String(head.slot)}#${String(i)}` })));
    const bytes: Buffer[] = [];
    for (const part of parts) {
      if (part === undefined || part.version !== head.version || !(part.data instanceof Uint8Array)) throw new Error("prices unavailable");
      bytes.push(Buffer.from(part.data));
    }
    const packed = Buffer.concat(bytes);
    if (createHash("sha256").update(packed).digest("hex") !== head.sha256) throw new Error("prices unavailable");
    let value: unknown;
    try { value = JSON.parse(gunzipSync(packed, { maxOutputLength: MAX_SNAPSHOT_JSON_BYTES }).toString("utf8")) as unknown; } catch { throw new Error("prices unavailable"); }
    if (!validSnapshot(value) || value.version !== head.version) throw new Error("prices unavailable");
    return value;
  }

  async save(snapshot: PriceSnapshot, expectedVersion: number): Promise<boolean> {
    if (!validSnapshot(snapshot) || !whole(expectedVersion) || snapshot.version !== expectedVersion + 1) return false;
    const head = await this.#head();
    if ((head?.version ?? 0) !== expectedVersion) return false;
    const packed = gzipSync(Buffer.from(JSON.stringify(snapshot)));
    const chunks = Math.ceil(packed.byteLength / PRICE_CHUNK_BYTES);
    if (chunks < 1 || chunks > MAX_PRICE_CHUNKS) return false;
    const slot: 0 | 1 = head === undefined ? 0 : head.slot === 0 ? 1 : 0;
    for (let i = 0; i < chunks; i++) {
      await this.db.put(this.table, { pk: PRICES_PARTITION, sk: `SLOT#${String(slot)}#${String(i)}`, version: snapshot.version, data: new Uint8Array(packed.subarray(i * PRICE_CHUNK_BYTES, (i + 1) * PRICE_CHUNK_BYTES)) });
    }
    const sha256 = createHash("sha256").update(packed).digest("hex");
    return this.db.update(this.table, { pk: PRICES_PARTITION, sk: "HEAD" },
      (e) => `SET ${e.name("version")} = ${e.value(snapshot.version)}, ${e.name("slot")} = ${e.value(slot)}, ${e.name("chunks")} = ${e.value(chunks)}, ${e.name("sha256")} = ${e.value(sha256)}`,
      (e) => expectedVersion === 0 ? `attribute_not_exists(${e.name("pk")})` : `${e.name("version")} = ${e.value(expectedVersion)}`);
  }
}
