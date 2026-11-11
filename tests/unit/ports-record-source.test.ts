// The `team-record-source` point (lane K1): the memory sink keeps the sink contract, the scripted source passes the source suite, Code's sink keeps nothing, and the
// sources the audience rule believes are the registered ones.
import { describe, expect, it } from "vitest";
import { MAINTAINERS_GROUP, PLUGIN_POINT_CARDINALITY, PluginRegistryError, audienceForSource, recordDraftRefusal, recordLinks, recordScopeCovers, recordSourceDraftProblem, type RecordDraft } from "@agentx/contracts";
import { createAdapterRegistry, createFakeRecordSource, createMemoryRecordSink, createRefusingRecordSink, knownRecordSources } from "../../packages/broker/src/ports/index.js";
import { CHAT_SAMPLE, runRecordSinkConformance, runRecordSourceConformance, sampleRecordDraft as sampleWith } from "../support/ports/record-source-conformance.js";

const sampleRecordDraft = (extra: Parameters<typeof sampleWith>[1] = {}): RecordDraft => sampleWith(CHAT_SAMPLE, extra);

runRecordSinkConformance("the in-memory sink", {
  async create() {
    const sink = createMemoryRecordSink();
    return {
      sink,
      async read(workspaceId, source, system, id) {
        const row = sink.row(workspaceId, source, system, id);
        return row === undefined ? undefined : { text: row.draft.text, version: row.draft.sourceRef.version, hidden: row.hidden, audience: row.draft.audience, trust: row.draft.trust, links: row.draft.links };
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
      unreadableSettings: async () => createFakeRecordSource({ settingsReadable: async () => { throw new Error("the settings store is down"); }, draftsOf: () => [sampleRecordDraft()] }),
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
    expect([...knownRecordSources(registry)]).toEqual(["rovara"]);
    registry.register("team-record-source", "chat", createFakeRecordSource({ source: "chat" }));
    registry.register("team-record-source", "host-two", createFakeRecordSource({ source: "codehost:two" }));
    const known = knownRecordSources(registry, ["recorder", "Bad Id"]);
    expect([...known].sort()).toEqual(["chat", "codehost:two", "recorder", "rovara"]);
    const declared = sampleRecordDraft().audience;
    expect(audienceForSource({ source: "chat", declared, capturedAt: "2026-11-10T10:00:00.000Z" }, known)).toEqual(declared);
    const unknown = audienceForSource({ source: "wiki", declared: { kind: "project" }, capturedAt: "2026-11-10T10:00:00.000Z" }, known);
    expect(unknown.kind === "restricted" ? unknown.acl.groups : []).toEqual([MAINTAINERS_GROUP]);
  });

  it("refuses two sources claiming one id, and a source claiming a built-in or reserved id", () => {
    const twice = createAdapterRegistry();
    twice.register("team-record-source", "one", createFakeRecordSource({ source: "chat" }));
    twice.register("team-record-source", "two", createFakeRecordSource({ source: "chat" }));
    expect(() => knownRecordSources(twice)).toThrow(PluginRegistryError);
    const reserved = createAdapterRegistry();
    reserved.register("team-record-source", "mine", createFakeRecordSource({ source: "rovara" }));
    expect(() => knownRecordSources(reserved)).toThrow(PluginRegistryError);
    const builtIn = createAdapterRegistry();
    builtIn.register("team-record-source", "mine", createFakeRecordSource({ source: "recorder" }));
    expect(() => knownRecordSources(builtIn, ["recorder"])).toThrow(PluginRegistryError);
  });

  it("a sink refuses only what is not a draft; a source is held to more", () => {
    const base = sampleRecordDraft();
    expect(recordDraftRefusal(base)).toBeUndefined();
    expect(recordDraftRefusal({ ...base, retention: "B" })).toBeUndefined();
    expect(recordDraftRefusal({ ...base, text: "é".repeat(5_000) })).toBe("the text is too long");
    expect(recordDraftRefusal({ ...base, kind: "message" })).toBe("not a record draft");
    expect(recordDraftRefusal({ ...base, extra: true })).toBe("not a record draft");
    expect(recordDraftRefusal({ ...base, links: Array.from({ length: 40 }, () => "not a link") })).toBeUndefined();
    expect(recordSourceDraftProblem({ ...base, retention: "B" })).toBeUndefined();
    expect(recordSourceDraftProblem({ ...base, retention: "A" })).toBe("retention A keeps no text");
    expect(recordSourceDraftProblem({ ...base, pieceTrusts: ["outsider"] })).toBe("the row's trust is higher than one of its parts");
    expect(recordSourceDraftProblem({ ...base, audience: { kind: "restricted", acl: { source: "tracker", scope: "chat:T1/C9", capturedAt: "2026-11-10T10:00:00.000Z", liveCheck: "none" } } })).toBe("the permission snapshot names another source");
  });

  it("keeps the first 20 valid http(s) links of at most 2,048 characters", () => {
    expect(recordLinks(["https://a.test/1", "ftp://a.test", "https://u:p@a.test", `https://a.test/${"x".repeat(2_100)}`, "http://a.test/2"])).toEqual(["https://a.test/1", "http://a.test/2"]);
    expect(recordLinks(Array.from({ length: 25 }, (_, i) => `https://a.test/${String(i)}`))).toHaveLength(20);
  });

  it("the memory sink drops B text from the row, and the distiller gets it only through distillTransient", async () => {
    const sink = createMemoryRecordSink();
    expect((await sink.put(sampleRecordDraft({ id: "b", retention: "B" }))).status).toBe("stored");
    expect(sink.row("org_00000000000000000000", "chat", "T1", "b")?.draft.text).toBeUndefined();
    expect((await sink.distillTransient!(sampleRecordDraft({ id: "b2", retention: "B" }) as RecordDraft & { text: string })).accepted).toBe(true);
    expect((await sink.distillTransient!(sampleRecordDraft({ id: "d", retention: "D" }) as RecordDraft & { text: string })).accepted).toBe(false);
    expect(sink.transient().map((draft) => draft.sourceRef.id)).toEqual(["b2"]);
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
