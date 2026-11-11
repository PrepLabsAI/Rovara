// The stores behind context sources, on the document store port: the counters a stage's allowance rests on, the revision rule of a project's sources, and the events of a host.
import { describe, expect, it } from "vitest";
import { INDEX_EXPIRY_ATTRIBUTE, change, orgScoped, type McpControllerEvent, type OrgId } from "@agentx/contracts";
import { documentContextSourceStore } from "../../packages/broker/src/context-sources/store.js";
import { SOURCE_FAILURE_LIMIT, STAGE_TOTAL_CALLS, documentUsageStore } from "../../packages/broker/src/context-sources/usage.js";
import { documentControllerEventStore, drainControllerEvents } from "../../packages/broker/src/context-sources/controller-events.js";
import { documentMcpServerStore, summariseProbe } from "../../packages/broker/src/context-sources/mcp-servers.js";
import { memoryStore } from "../support/connection-fakes.js";
import { NOW, ORG, SEARCH_TOOL, source } from "./context-sources/fixtures.js";

const OTHER = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;

describe("the usage of a stage", () => {
  const usage = () => documentUsageStore({ store: memoryStore(), now: () => NOW });
  const key = { orgId: ORG, operationId: "op1", sourceId: "sim" };

  it("lets parallel calls take only what the source's allowance leaves, and says which allowance ran out", async () => {
    const counters = usage();
    const answers = await Promise.all(Array.from({ length: 6 }, () => counters.reserveCall({ ...key, callsPerStage: 4 })));
    expect(answers.filter((answer) => answer.ok)).toHaveLength(4);
    expect(answers.filter((answer) => !answer.ok)).toEqual([{ ok: false, reason: "calls" }, { ok: false, reason: "calls" }]);
  });

  it("holds the stage's total across sources, and turns a source off for the rest of the stage after its failures", async () => {
    const counters = usage();
    for (let call = 0; call < STAGE_TOTAL_CALLS; call += 1) expect((await counters.reserveCall({ ...key, sourceId: `s${String(call % 5)}`, callsPerStage: 25 })).ok).toBe(true);
    expect(await counters.reserveCall({ ...key, sourceId: "s0", callsPerStage: 25 })).toEqual({ ok: false, reason: "total" });
    const failing = usage();
    for (let failure = 1; failure <= SOURCE_FAILURE_LIMIT; failure += 1) expect(await failing.recordFailure(key)).toBe(failure);
    expect(await failing.reserveCall({ ...key, callsPerStage: 25 })).toEqual({ ok: false, reason: "failures" });
    expect((await failing.reserveCall({ ...key, sourceId: "other", callsPerStage: 25 })).ok).toBe(true);
  });

  it("counts bytes per source and keeps one operation and one company apart from another", async () => {
    const counters = usage();
    await counters.addBytes({ ...key, bytes: 100 });
    await counters.addBytes({ ...key, bytes: 50 });
    expect(await counters.bytesUsed(key)).toBe(150);
    expect(await counters.bytesUsed({ ...key, operationId: "op2" })).toBe(0);
    expect(await counters.bytesUsed({ ...key, orgId: OTHER })).toBe(0);
  });

  it("gives every counter row an expiry, so a stage leaves nothing behind", async () => {
    const db = memoryStore();
    await documentUsageStore({ store: db, now: () => NOW }).reserveCall({ ...key, callsPerStage: 1 });
    expect((await db.get({ pk: orgScoped(ORG, "CTXUSE#op1"), sk: "USE" }))![INDEX_EXPIRY_ATTRIBUTE]).toBe(Math.floor(NOW / 1_000) + 3 * 24 * 60 * 60);
  });
});

describe("a project's sources", () => {
  const change0 = (over: Record<string, unknown> = {}) => ({
    changeId: "c1", orgId: ORG, project: "proj", kind: "set" as const, sourceId: "sim", source: source(), proposedBy: "dev1", proposedAt: "2026-11-01T10:00:00Z", baseRevision: 0, secondAdminReasons: [], status: "pending" as const, ...over,
  });

  it("applies a change only on the revision it was made against, once, and answers stale for a second writer", async () => {
    const sources = documentContextSourceStore({ store: memoryStore(), now: () => NOW });
    await sources.putChange(change0());
    await sources.putChange(change0({ changeId: "c2", sourceId: "other", source: source({ sourceId: "other", label: "Other" }) }));
    const next = { revision: 1, sources: [source()] };
    expect(await sources.apply({ change: change0(), next, decidedBy: "dev1", decidedAt: "2026-11-01T11:00:00Z" })).toBe("applied");
    expect((await sources.readDocument(ORG, "proj")).revision).toBe(1);
    // The second change was made against revision 0 too: it is stale now, and so is a repeat of the first.
    expect(await sources.apply({ change: change0({ changeId: "c2" }), next: { revision: 1, sources: [source({ sourceId: "other", label: "Other" })] }, decidedBy: "dev1", decidedAt: "x" })).toBe("stale");
    expect(await sources.apply({ change: change0(), next, decidedBy: "dev1", decidedAt: "x" })).toBe("stale");
    expect((await sources.listPending(ORG, "proj")).map((entry) => entry.changeId)).toEqual(["c2"]);
  });

  it("turns a change down once, serves another company nothing, and serves no source from a document that no longer parses", async () => {
    const db = memoryStore();
    const sources = documentContextSourceStore({ store: db, now: () => NOW });
    await sources.putChange(change0());
    expect(await sources.reject({ change: change0(), decidedBy: "dev1", decidedAt: "x" })).toBe("rejected");
    expect(await sources.reject({ change: change0(), decidedBy: "dev1", decidedAt: "x" })).toBe("stale");
    expect(await sources.getChange(OTHER, "proj", "c1")).toBeUndefined();
    await db.put({ item: { pk: orgScoped(ORG, "CTXSRC#proj"), sk: "DOC", revision: 3, sources: [{ not: "a source" }] } });
    expect(await sources.readDocument(ORG, "proj")).toEqual({ revision: 3, sources: [] });
    await expect(sources.putChange(change0())).rejects.toThrow(/already exists/u);
  });
});

describe("a document with a stage that never reads sources", () => {
  it("serves no source from a document that names the stage that writes the code, whatever else it holds", async () => {
    const db = memoryStore();
    const sources = documentContextSourceStore({ store: db, now: () => NOW });
    await db.put({ item: { pk: orgScoped(ORG, "CTXSRC#proj"), sk: "DOC", revision: 2, sources: [{ ...source(), stages: ["IMPLEMENT", "PLAN"] }] as never } });
    expect(await sources.readDocument(ORG, "proj")).toEqual({ revision: 2, sources: [] });
  });
});

describe("what a host tells the install", () => {
  const event = (over: { approved?: string } = {}): McpControllerEvent => ({ type: "changed_needs_review", serverId: "mcpwiki000001", at: "2026-11-01T10:00:00Z", approved: over.approved ?? "a".repeat(64), observed: "b".repeat(64) });
  const started = (): McpControllerEvent => ({ type: "task_started", serverId: "mcpwiki000001", at: "2026-11-01T09:30:00Z", trigger: "warm" });

  async function world() {
    const db = memoryStore();
    const servers = documentMcpServerStore({ store: db });
    const probe = summariseProbe([SEARCH_TOOL], NOW);
    await servers.create(ORG, { serverId: "mcpwiki000001", label: "Wiki", status: "approved", transport: { kind: "http", address: "https://wiki.corp.example/mcp" }, probe: { ...probe, toolsHash: "a".repeat(64) }, requestedBy: "dev1", requestedAt: "2026-11-01T09:00:00Z" });
    const put = async (sk: string, value: McpControllerEvent) => db.put({ item: { pk: orgScoped(ORG, "MCPEVT"), sk, ...(value as unknown as Record<string, never>) } });
    return { db, servers, events: documentControllerEventStore({ store: db }), put };
  }

  it("records each event once, in order, and pauses a server only while it still carries the approved hash", async () => {
    const w = await world();
    await w.put("EVT#1", started());
    await w.put("EVT#2", event());
    const recorded: string[] = [];
    const deps = { events: w.events, servers: w.servers, audit: async (_org: OrgId, sk: string) => { recorded.push(sk); }, now: () => NOW };
    expect(await drainControllerEvents(deps, ORG)).toBe(2);
    expect(recorded).toEqual(["EVT#1", "EVT#2"]);
    expect((await w.servers.get(ORG, "mcpwiki000001"))!.status).toBe("changed_needs_review");
    expect(await drainControllerEvents(deps, ORG)).toBe(0);
  });

  it("leaves a server alone when the hash it was paused for is not the one it carries, and never reads another company's events", async () => {
    const w = await world();
    await w.put("EVT#1", event({ approved: "c".repeat(64) }));
    expect(await drainControllerEvents({ events: w.events, servers: w.servers, audit: undefined, now: () => NOW }, ORG)).toBe(1);
    expect((await w.servers.get(ORG, "mcpwiki000001"))!.status).toBe("approved");
    expect(await w.events.unaudited(OTHER, 10)).toEqual([]);
  });

  it("does not read an item that is not an event of the schema, and stops at the first event it cannot record so the trail stays in order", async () => {
    const w = await world();
    await w.db.put({ item: { pk: orgScoped(ORG, "MCPEVT"), sk: "EVT#0", type: "made_up" } });
    await w.put("EVT#1", started());
    await w.put("EVT#2", started());
    let calls = 0;
    const flaky = async () => { calls += 1; if (calls === 2) throw new Error("trail down"); };
    expect(await drainControllerEvents({ events: w.events, servers: w.servers, audit: flaky, now: () => NOW }, ORG)).toBe(1);
    expect((await w.events.unaudited(ORG, 10)).map((entry) => entry.sk)).toEqual(["EVT#2"]);
    await w.db.update({ key: { pk: orgScoped(ORG, "MCPEVT"), sk: "EVT#2" }, ops: [change.set("audited", true)] });
    expect(await w.events.unaudited(ORG, 10)).toEqual([]);
  });
});
