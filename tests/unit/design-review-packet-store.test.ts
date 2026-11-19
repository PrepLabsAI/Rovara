// Design review stage: the stored packet of a reviewer slot (packet-store.ts). The route serves these bytes and never rebuilds a packet, so the store must keep them exactly, keep them per org
// and operation, refuse to change them once written, refuse a damaged copy, and let them expire.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { INDEX_EXPIRY_ATTRIBUTE, PacketDeliverySchema, packetDigestOf, queryAll, type DocumentStore, type OrgId } from "@agentx/contracts";
import { buildReviewerPacket, type PacketReaders } from "../../packages/broker/src/core/design-review/packet.js";
import { SLOT_PACKET_TTL_SECONDS, designReviewPartition, packetTextOf, putSlotPackets, readSlotPacket, removeSlotPackets } from "../../packages/broker/src/core/design-review/packet-store.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const OPERATION = "11111111-1111-4111-8111-111111111111";
const readers: PacketReaders = { readRepoFile: async () => undefined, readMetaFile: async () => undefined, fetchMcpItem: async () => ({ ok: false }) };

async function packet(designText = "## §3 Proposed design\nR1: add the endpoint.\n") {
  return buildReviewerPacket({ role: "critic", design: { ref: "design.md", revision: "r1", text: designText }, requirements: { ref: "requirements.md", revision: "r1", text: "R1: an endpoint." }, baseCommits: {}, sources: [] }, readers);
}
const OTHER_OPERATION = "22222222-2222-4222-8222-222222222222";
/** Every item the store holds for the two operations these tests use (the memory store has no scan). */
const all = async (db: DocumentStore) => [...await queryAll(db, { pk: designReviewPartition(ORG, OPERATION) }), ...await queryAll(db, { pk: designReviewPartition(ORG, OTHER_OPERATION) })];

describe("the stored packet of a slot", () => {
  it("keeps the delivery text exactly, and the stored text hashes to the packet's own digest", async () => {
    const db = new MemoryDocumentStore();
    const built = await packet();
    await putSlotPackets(db, { orgId: ORG, operationId: OPERATION, round: 1, packets: [{ keySlot: "slot-critic", packet: built }], nowMs: 1_000_000 });
    const stored = await readSlotPacket(db, ORG, OPERATION, 1, "slot-critic");
    expect(stored?.text).toBe(packetTextOf(built));
    expect(packetDigestOf(PacketDeliverySchema.parse(JSON.parse(stored!.text)))).toBe(built.packetDigest);
    // Only the delivery fields: nothing of the builder's bookkeeping.
    expect(Object.keys(JSON.parse(stored!.text) as object).sort()).toEqual(["documents", "role", "rolePrompt"]);
  });

  it("is keyed by org and operation: another org, another operation and another slot read nothing", async () => {
    const db = new MemoryDocumentStore();
    await putSlotPackets(db, { orgId: ORG, operationId: OPERATION, round: 1, packets: [{ keySlot: "slot-critic", packet: await packet() }], nowMs: 0 });
    expect(await readSlotPacket(db, OTHER_ORG, OPERATION, 1, "slot-critic")).toBeUndefined();
    expect(await readSlotPacket(db, ORG, OTHER_OPERATION, 1, "slot-critic")).toBeUndefined();
    expect(await readSlotPacket(db, ORG, OPERATION, 1, "slot-other")).toBeUndefined();
    expect(await readSlotPacket(db, ORG, OPERATION, 1, "../../x")).toBeUndefined();
  });

  it("keeps a packet far larger than one table item (incompressible text over several chunks) and reads it back identically", async () => {
    const db = new MemoryDocumentStore();
    const big = randomBytes(250_000).toString("base64");
    const built = await packet(`## §3 Proposed design\n${big}\n`);
    await putSlotPackets(db, { orgId: ORG, operationId: OPERATION, round: 1, packets: [{ keySlot: "slot-critic", packet: built }], nowMs: 0 });
    const pieces = (await all(db)).filter((item) => item.pk === designReviewPartition(ORG, OPERATION) && String(item.sk).includes("#C"));
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((item) => Buffer.byteLength(String(item["chunk"] as string), "utf8") <= 250_000)).toBe(true);
    expect((await readSlotPacket(db, ORG, OPERATION, 1, "slot-critic"))?.text).toBe(packetTextOf(built));
  });

  it("gives every item an expiry (the table's TTL) a day out", async () => {
    const db = new MemoryDocumentStore();
    await putSlotPackets(db, { orgId: ORG, operationId: OPERATION, round: 1, packets: [{ keySlot: "slot-critic", packet: await packet() }], nowMs: 5_000_000 });
    const items = (await all(db)).filter((item) => item.pk === designReviewPartition(ORG, OPERATION));
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const item of items) expect(item[INDEX_EXPIRY_ATTRIBUTE]).toBe(5_000 + SLOT_PACKET_TTL_SECONDS);
  });

  it("never changes a stored packet: the same text again is fine, a different one is refused and the first stays", async () => {
    const db = new MemoryDocumentStore();
    const first = await packet();
    await putSlotPackets(db, { orgId: ORG, operationId: OPERATION, round: 1, packets: [{ keySlot: "slot-critic", packet: first }], nowMs: 0 });
    await putSlotPackets(db, { orgId: ORG, operationId: OPERATION, round: 1, packets: [{ keySlot: "slot-critic", packet: first }], nowMs: 10 });
    await expect(putSlotPackets(db, { orgId: ORG, operationId: OPERATION, round: 1, packets: [{ keySlot: "slot-critic", packet: await packet("## §3 Another design\n") }], nowMs: 20 })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect((await readSlotPacket(db, ORG, OPERATION, 1, "slot-critic"))?.text).toBe(packetTextOf(first));
  });

  it("refuses a damaged copy: a missing chunk, a changed chunk, or a head for another operation", async () => {
    const db = new MemoryDocumentStore();
    await putSlotPackets(db, { orgId: ORG, operationId: OPERATION, round: 1, packets: [{ keySlot: "slot-critic", packet: await packet() }], nowMs: 0 });
    const chunk = (await all(db)).filter((item) => String(item.sk).includes("#C00"))[0]!;
    await db.put({ item: { ...chunk, chunk: `${(chunk["chunk"] as string).slice(0, -8)}AAAAAAAA` } });
    expect(await readSlotPacket(db, ORG, OPERATION, 1, "slot-critic")).toBeUndefined();
    await db.delete({ key: { pk: String(chunk.pk), sk: String(chunk.sk) } });
    expect(await readSlotPacket(db, ORG, OPERATION, 1, "slot-critic")).toBeUndefined();
  });

  it("leaves the builder's bookkeeping out of the stored text, refuses a packet the contract refuses and a slot that is not valid, and writes nothing", async () => {
    const db = new MemoryDocumentStore();
    const built = await packet();
    const noisy = { ...built, omitted: [{ ref: "x", reason: "not_found" }], estimatedInputTokens: 99, rolePrompt: { ...built.rolePrompt, digest: "d" }, documents: built.documents.map((document) => ({ ...document, transcript: "secret" })) };
    expect(packetTextOf(noisy as never)).toBe(packetTextOf(built));
    expect(packetTextOf(built)).not.toContain("secret");
    expect(() => packetTextOf({ ...built, documents: built.documents.slice(0, 1) })).toThrow();
    await expect(putSlotPackets(db, { orgId: ORG, operationId: OPERATION, round: 1, packets: [{ keySlot: "Bad Slot", packet: built }], nowMs: 0 })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(putSlotPackets(db, { orgId: ORG, operationId: OPERATION, round: 1, packets: [{ keySlot: "a", packet: built }, { keySlot: "a", packet: built }], nowMs: 0 })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await all(db)).toEqual([]);
  });

  it("removes every packet of an operation and nothing else", async () => {
    const db = new MemoryDocumentStore();
    const built = await packet();
    await putSlotPackets(db, { orgId: ORG, operationId: OPERATION, round: 1, packets: [{ keySlot: "slot-a", packet: built }, { keySlot: "slot-b", packet: built }], nowMs: 0 });
    await putSlotPackets(db, { orgId: ORG, operationId: OTHER_OPERATION, round: 1, packets: [{ keySlot: "slot-a", packet: built }], nowMs: 0 });
    expect(await removeSlotPackets(db, ORG, OPERATION)).toBeGreaterThanOrEqual(4);
    expect(await readSlotPacket(db, ORG, OPERATION, 1, "slot-a")).toBeUndefined();
    expect(await readSlotPacket(db, ORG, OTHER_OPERATION, 1, "slot-a")).toBeDefined();
  });

  it("keys a packet by its round: a second round on one operation id stores its own packet and never meets the first round's", async () => {
    const db = new MemoryDocumentStore();
    const first = await packet();
    const second = await packet("## §3 Round two design\n");
    await putSlotPackets(db, { orgId: ORG, operationId: OPERATION, round: 1, packets: [{ keySlot: "slot-critic", packet: first }], nowMs: 0 });
    // Without the round in the key this second put would be refused as "a different packet is already stored".
    await putSlotPackets(db, { orgId: ORG, operationId: OPERATION, round: 2, packets: [{ keySlot: "slot-critic", packet: second }], nowMs: 10 });
    expect((await readSlotPacket(db, ORG, OPERATION, 1, "slot-critic"))?.text).toBe(packetTextOf(first));
    expect((await readSlotPacket(db, ORG, OPERATION, 2, "slot-critic"))?.text).toBe(packetTextOf(second));
    expect(await readSlotPacket(db, ORG, OPERATION, 3, "slot-critic")).toBeUndefined();
    await expect(putSlotPackets(db, { orgId: ORG, operationId: OPERATION, round: 0, packets: [{ keySlot: "slot-critic", packet: first }], nowMs: 0 })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
