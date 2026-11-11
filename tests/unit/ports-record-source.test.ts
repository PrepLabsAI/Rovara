// The `team-record-source` point (lane K1): the memory sink keeps the sink contract, the scripted source passes the source suite, Code's sink keeps nothing, and the
// sources the audience rule believes are the registered ones.
import { describe, expect, it } from "vitest";
import { MAINTAINERS_GROUP, PLUGIN_POINT_CARDINALITY, audienceForSource, recordDraftRefusal, recordScopeCovers, type RecordDraft } from "@agentx/contracts";
import { createAdapterRegistry, createFakeRecordSource, createMemoryRecordSink, createRefusingRecordSink, knownRecordSources } from "../../packages/broker/src/ports/index.js";
import { runRecordSinkConformance, runRecordSourceConformance, sampleRecordDraft } from "../support/ports/record-source-conformance.js";

runRecordSinkConformance("the in-memory sink", {
  async create() {
    const sink = createMemoryRecordSink();
    return {
      sink,
      async read(workspaceId, source, system, id) {
        const row = sink.row(workspaceId, source, system, id);
        return row === undefined ? undefined : { text: row.draft.text, version: row.draft.sourceRef.version, hidden: row.hidden, audience: row.draft.audience };
      },
    };
  },
});

runRecordSourceConformance("the scripted source", {
  async create() {
    const items: RecordDraft[] = [sampleRecordDraft({ id: "p1" }), sampleRecordDraft({ id: "p2" }), sampleRecordDraft({ id: "p3", workspaceId: "org_11111111111111111111" })];
    return {
      source: createFakeRecordSource({ items, draftsOf: (payload) => (typeof payload === "object" && payload !== null && "message" in payload ? [sampleRecordDraft({ id: String((payload as { message: string }).message) })] : []) }),
      deliveries: [{ message: "m1" }, { message: "m2" }],
      poll: { workspaceId: "org_00000000000000000000", scope: "chat:T1/C9", limit: 10 },
    };
  },
});

describe("the team-record-source point", () => {
  it("holds many sources; Code registers none and its sink keeps nothing", async () => {
    expect(PLUGIN_POINT_CARDINALITY["team-record-source"]).toBe("many");
    const sink = createRefusingRecordSink();
    expect(await sink.put(sampleRecordDraft())).toEqual({ status: "refused", reason: "this install keeps no team record" });
    expect(await sink.tombstone({ workspaceId: "org_00000000000000000000", system: "T1", sourceIds: ["x"], cause: "source_deleted" })).toEqual({ hidden: 0 });
  });

  it("believes the declared audience of a registered source only: any other source's rows go to the maintainers", () => {
    const registry = createAdapterRegistry();
    expect([...knownRecordSources(registry)]).toEqual([]);
    registry.register("team-record-source", "chat", createFakeRecordSource({ source: "chat" }));
    registry.register("team-record-source", "host-two", createFakeRecordSource({ source: "codehost:two" }));
    const known = knownRecordSources(registry, ["rovara", "Bad Id"]);
    expect([...known].sort()).toEqual(["chat", "codehost:two", "rovara"]);
    const declared = sampleRecordDraft().audience;
    expect(audienceForSource({ source: "chat", declared, capturedAt: "2026-11-10T10:00:00.000Z" }, known)).toEqual(declared);
    const unknown = audienceForSource({ source: "wiki", declared: { kind: "project" }, capturedAt: "2026-11-10T10:00:00.000Z" }, known);
    expect(unknown.kind === "restricted" ? unknown.acl.groups : []).toEqual([MAINTAINERS_GROUP]);
  });

  it("refuses a draft the shape cannot say is wrong: text kept under B, an oversized text, a trust above a piece's", () => {
    const base = sampleRecordDraft();
    expect(recordDraftRefusal(base)).toBeUndefined();
    expect(recordDraftRefusal({ ...base, retention: "B" })).toBe("retention A and B keep no text");
    expect(recordDraftRefusal({ ...base, text: "é".repeat(5_000) })).toBe("the text is too long");
    expect(recordDraftRefusal({ ...base, pieceTrusts: ["outsider"] })).toBe("the row's trust is higher than one of its parts");
    expect(recordDraftRefusal({ ...base, kind: "message" })).toBe("not a record draft");
    expect(recordDraftRefusal({ ...base, extra: true })).toBe("not a record draft");
  });

  it("reads a scope as itself and the places under it", () => {
    expect(recordScopeCovers("chat:T1", "chat:T1/C9")).toBe(true);
    expect(recordScopeCovers("chat:T1", "chat:T1")).toBe(true);
    expect(recordScopeCovers("chat:T1", "chat:T10")).toBe(false);
  });

  it("a memory sink that cannot be reached throws, so a source counts the write as failed", async () => {
    const sink = createMemoryRecordSink();
    sink.setDown(true);
    const outcome = await createFakeRecordSource().receive!([sampleRecordDraft()], sink);
    expect(outcome).toMatchObject({ status: "recorded", written: 0, failed: 1 });
  });
});
