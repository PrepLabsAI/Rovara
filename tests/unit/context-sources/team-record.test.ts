import { describe, expect, it } from "vitest";
import { boundedSink, droppingSink, emptySearch, withoutLiveFacts, type ContextItemSeen } from "../../../packages/core/src/context-sources/team-record.js";

const item = (over: Partial<ContextItemSeen> = {}): ContextItemSeen => ({
  orgId: "org1", projectId: "proj", taskId: "task1", stage: "PLAN", sourceId: "sim", system: "sim", itemRef: "P1", title: "T", permissionSnapshot: null, fetchedAt: "2026-11-01T10:00:00Z", contentDigest: "a".repeat(64), standing: "outsider", ...over,
});
const never = () => new Promise<void>(() => undefined);

describe("the stand-ins until the Team record lands", () => {
  it("drop events and answer no hits, so this lane ships without it", async () => {
    await expect(droppingSink.seen(item())).resolves.toBeUndefined();
    await expect(emptySearch.search({ orgId: "o", projectId: "p", query: "q", asAgentForTask: "t", limit: 20 })).resolves.toEqual([]);
  });
});

describe("the bounded sink", () => {
  it("returns at once, hands items to the record in order, one org at a time", async () => {
    const seen: string[] = [];
    const sink = boundedSink({ seen: async (entry) => { seen.push(entry.itemRef); } });
    await sink.seen(item({ itemRef: "A" }));
    await sink.seen(item({ itemRef: "B" }));
    await sink.idle();
    expect(seen).toEqual(["A", "B"]);
    expect(sink.pending("org1")).toBe(0);
  });
  it("never waits for a record that never answers", async () => {
    const sink = boundedSink({ seen: never });
    await expect(Promise.race([sink.seen(item()), new Promise((resolve) => setTimeout(() => resolve("blocked"), 200))])).resolves.toBeUndefined();
  });
  it("drops and counts what does not fit, per org, and tells the counter", async () => {
    const drops: Array<[string, string, number]> = [];
    const sink = boundedSink({ seen: never }, { maxPerOrg: 3, onDrop: (org, reason, total) => drops.push([org, reason, total]) });
    for (let index = 0; index < 8; index += 1) await sink.seen(item({ itemRef: `P${index}` }));
    // one is being handed over and never returns; three wait; the rest are dropped
    expect(sink.pending("org1")).toBe(3);
    expect(sink.dropped("org1")).toBe(4);
    expect(drops.at(-1)).toEqual(["org1", "queue_full", 4]);
    // another org is not held up by the first
    await sink.seen(item({ orgId: "org2" }));
    expect(sink.dropped("org2")).toBe(0);
  });
  it("counts a record that fails and goes on to the next item", async () => {
    const seen: string[] = [];
    const drops: string[] = [];
    const sink = boundedSink({ seen: async (entry) => { if (entry.itemRef === "A") throw new Error("down"); seen.push(entry.itemRef); } }, { onDrop: (_org, reason) => drops.push(reason) });
    await sink.seen(item({ itemRef: "A" }));
    await sink.seen(item({ itemRef: "B" }));
    await sink.idle();
    expect(seen).toEqual(["B"]);
    expect(drops).toEqual(["record_failed"]);
  });
  it("survives a counter that throws", async () => {
    const sink = boundedSink({ seen: never }, { maxPerOrg: 1, onDrop: () => { throw new Error("metric down"); } });
    await sink.seen(item());
    await sink.seen(item());
    await expect(sink.seen(item())).resolves.toBeUndefined();
  });
});

describe("live facts are never sent", () => {
  it("removes the named keys at any depth, in any case", () => {
    expect(withoutLiveFacts({ key: "P1", Status: "Open", fields: { assignee: "a", title: "t", nested: [{ priority: 1, body: "b" }] } }, ["status", "assignee", "priority"]))
      .toEqual({ key: "P1", fields: { title: "t", nested: [{ body: "b" }] } });
    expect(withoutLiveFacts({ a: 1 }, [])).toEqual({ a: 1 });
  });
});
