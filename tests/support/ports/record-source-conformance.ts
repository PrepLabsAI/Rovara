// The conformance suites of the `team-record-source` point:
//   - `runRecordSinkConformance`: the sink contract (`RecordSink` in contracts) that makes arrival order, repeats and deletes safe. The in-memory sink and the hosted
//     record's sink (over a test table, never the real one) run it.
//   - `runRecordSourceConformance`: what every source adapter's writes must be. The scripted fake and each hosted source tap (fed recorded deliveries) run it.
import { describe, expect, it } from "vitest";
import {
  RecordSourceIdSchema, recordDraftRefusal, recordIdempotencyKey,
  type Audience, type RecordDraft, type RecordIngestOutcome, type RecordPollRequest, type RecordSink, type TeamRecordSource,
} from "@agentx/contracts";

const COMPANY = "org_00000000000000000000";
const OTHER = "org_11111111111111111111";
const AT = "2026-11-10T10:00:00.000Z";
const LATER = "2026-11-10T11:00:00.000Z";

/** A draft for the suites: a member's message in a chat place, visible to the place's members. */
export function sampleRecordDraft(extra: Partial<RecordDraft> & { id?: string; version?: string; scope?: string } = {}): RecordDraft {
  const { id = "C9/1700000000.0001", version = "v1", scope = "chat:T1/C9", ...rest } = extra;
  const audience: Audience = { kind: "restricted", acl: { source: "chat", scope, principals: ["U1", "U2"], capturedAt: AT, liveCheck: "none" } };
  return {
    workspaceId: COMPANY, project: "web", source: "chat",
    sourceRef: { system: "T1", id, version },
    kind: "chat.message", occurredAt: AT, actor: { sourceId: "U1", trust: "member" }, trust: "member", audience,
    text: "The deploy needs the cache warmed first.", links: [], retention: "D", scope, ...rest,
  };
}

// ---- the sink

/** How the harness reads back what a sink keeps. */
export interface StoredRecordView {
  text?: string | undefined;
  version: string;
  hidden: boolean;
  audience: Audience;
}

export interface RecordSinkUnderTest {
  sink: RecordSink;
  /** The item's current row (the newest version), or undefined when none was stored. */
  read: (workspaceId: string, source: string, system: string, id: string) => Promise<StoredRecordView | undefined>;
  /** For a sink that queues every call (answers `queued`): applies what is queued. */
  settle?: () => Promise<void>;
  dispose?: () => Promise<void>;
}

export interface RecordSinkHarness {
  create(): Promise<RecordSinkUnderTest>;
}

export function runRecordSinkConformance(name: string, harness: RecordSinkHarness): void {
  async function withSink<T>(body: (under: RecordSinkUnderTest & { put: (draft: RecordDraft) => Promise<RecordIngestOutcome> }) => Promise<T>): Promise<T> {
    const under = await harness.create();
    const put = async (draft: RecordDraft) => { const outcome = await under.sink.put(draft); await under.settle?.(); return outcome; };
    try { return await body({ ...under, put }); } finally { await under.dispose?.(); }
  }
  const stored = (outcome: RecordIngestOutcome) => expect(["stored", "queued"]).toContain(outcome.status);
  const repeated = (outcome: RecordIngestOutcome) => expect(["duplicate", "queued"]).toContain(outcome.status);

  describe(`record sink conformance: ${name}`, () => {
    it("stores a draft once: the same item and version again is a repeat", () => withSink(async ({ put, read }) => {
      stored(await put(sampleRecordDraft()));
      repeated(await put(sampleRecordDraft()));
      expect(await read(COMPANY, "chat", "T1", "C9/1700000000.0001")).toMatchObject({ version: "v1", hidden: false, text: "The deploy needs the cache warmed first." });
    }));

    it("replaces an item's text with a newer version, and never with an older one that arrives late", () => withSink(async ({ put, read }) => {
      stored(await put(sampleRecordDraft()));
      stored(await put(sampleRecordDraft({ version: "v2", text: "Edited: warm the cache.", sourceRef: { system: "T1", id: "C9/1700000000.0001", version: "v2", versionAt: LATER } })));
      repeated(await put(sampleRecordDraft({ version: "v0", text: "An old version.", sourceRef: { system: "T1", id: "C9/1700000000.0001", version: "v0", versionAt: "2026-11-10T09:00:00.000Z" } })));
      expect(await read(COMPANY, "chat", "T1", "C9/1700000000.0001")).toMatchObject({ version: "v2", text: "Edited: warm the cache." });
    }));

    it("keeps a delete that arrives before its put: the late put is refused", () => withSink(async ({ sink, put, read, settle }) => {
      await sink.tombstone({ workspaceId: COMPANY, system: "T1", sourceIds: ["C9/1700000000.0001"], cause: "source_deleted" });
      await settle?.();
      const late = await put(sampleRecordDraft());
      expect(["refused", "queued"]).toContain(late.status);
      const row = await read(COMPANY, "chat", "T1", "C9/1700000000.0001");
      expect(row === undefined || row.hidden).toBe(true);
    }));

    it("hides a stored item at once on a delete, and refuses a newer version of it afterwards", () => withSink(async ({ sink, put, read, settle }) => {
      stored(await put(sampleRecordDraft()));
      const { hidden } = await sink.tombstone({ workspaceId: COMPANY, system: "T1", sourceIds: ["C9/1700000000.0001"], cause: "source_deleted" });
      await settle?.();
      expect(hidden).toBeLessThanOrEqual(1);
      expect((await read(COMPANY, "chat", "T1", "C9/1700000000.0001"))?.hidden ?? true).toBe(true);
      const after = await put(sampleRecordDraft({ version: "v2", sourceRef: { system: "T1", id: "C9/1700000000.0001", version: "v2", versionAt: LATER } }));
      expect(["refused", "queued"]).toContain(after.status);
      expect((await read(COMPANY, "chat", "T1", "C9/1700000000.0001"))?.hidden ?? true).toBe(true);
    }));

    it("deletes a place and the places under it, not a place whose name only starts the same", () => withSink(async ({ sink, put, read, settle }) => {
      stored(await put(sampleRecordDraft({ id: "a", scope: "chat:T1/C9" })));
      stored(await put(sampleRecordDraft({ id: "b", scope: "chat:T1/C9/thread" })));
      stored(await put(sampleRecordDraft({ id: "c", scope: "chat:T1/C90" })));
      await sink.tombstone({ workspaceId: COMPANY, system: "T1", scope: "chat:T1/C9", cause: "source_deleted" });
      await settle?.();
      expect((await read(COMPANY, "chat", "T1", "a"))?.hidden).toBe(true);
      expect((await read(COMPANY, "chat", "T1", "b"))?.hidden).toBe(true);
      expect((await read(COMPANY, "chat", "T1", "c"))?.hidden).toBe(false);
      // A deleted place does not refuse a NEW item under it (only an excluded place does).
      stored(await put(sampleRecordDraft({ id: "d", scope: "chat:T1/C9" })));
    }));

    it("refuses new items under an excluded place", () => withSink(async ({ sink, put, settle }) => {
      await sink.tombstone({ workspaceId: COMPANY, system: "T1", scope: "chat:T1/C7", cause: "excluded" });
      await settle?.();
      const outcome = await put(sampleRecordDraft({ id: "e", scope: "chat:T1/C7" }));
      expect(["refused", "queued"]).toContain(outcome.status);
    }));

    it("keeps a per-editor change row apart: it replaces nothing and is replaced by nothing", () => withSink(async ({ put, read }) => {
      stored(await put(sampleRecordDraft()));
      stored(await put(sampleRecordDraft({ version: "e1", text: "My own edit.", sourceRef: { system: "T1", id: "C9/1700000000.0001", version: "e1", versionAt: LATER, order: 1_700_000_000_500 } })));
      expect(await read(COMPANY, "chat", "T1", "C9/1700000000.0001")).toMatchObject({ version: "v1", text: "The deploy needs the cache warmed first." });
    }));

    it("refuses a draft that breaks the rules: text kept under retention A, a snapshot naming another source, a row trusted above its author", () => withSink(async ({ put }) => {
      const base = sampleRecordDraft();
      const bad: RecordDraft[] = [
        { ...base, retention: "A" },
        { ...base, audience: { kind: "restricted", acl: { source: "tracker", scope: "chat:T1/C9", capturedAt: AT, liveCheck: "none" } } },
        { ...base, trust: "rovara", actor: { sourceId: "U1", trust: "outsider" } },
        { ...base, source: "Not A Source" },
      ];
      for (const draft of bad) expect((await put(draft)).status).toMatch(/^(refused|queued)$/u);
    }));

    it("changes a private place's members and moves a place to a new audience", () => withSink(async ({ sink, put, read, settle }) => {
      stored(await put(sampleRecordDraft()));
      await sink.changePrincipals({ workspaceId: COMPANY, scope: "chat:T1/C9", add: ["U3"], remove: ["U2"], at: LATER });
      await settle?.();
      const changed = await read(COMPANY, "chat", "T1", "C9/1700000000.0001");
      expect(changed?.audience.kind === "restricted" ? [...(changed.audience.acl.principals ?? [])].sort() : []).toEqual(["U1", "U3"]);
      await sink.replaceScopeAudience({ workspaceId: COMPANY, scope: "chat:T1/C9", audience: { kind: "project" }, at: LATER });
      await settle?.();
      expect((await read(COMPANY, "chat", "T1", "C9/1700000000.0001"))?.audience).toEqual({ kind: "project" });
    }));

    it("keeps companies apart: a delete in one company leaves the same item in another", () => withSink(async ({ sink, put, read, settle }) => {
      stored(await put(sampleRecordDraft()));
      stored(await put(sampleRecordDraft({ workspaceId: OTHER })));
      await sink.tombstone({ workspaceId: OTHER, system: "T1", sourceIds: ["C9/1700000000.0001"], cause: "person_erased" });
      await settle?.();
      expect((await read(COMPANY, "chat", "T1", "C9/1700000000.0001"))?.hidden).toBe(false);
      expect((await read(OTHER, "chat", "T1", "C9/1700000000.0001"))?.hidden ?? true).toBe(true);
    }));
  });
}

// ---- a source

/** A sink that records every call (and can fail on cue), for the source suite. */
export function createRecordingSink(): RecordSink & { drafts: RecordDraft[]; failing: boolean } {
  const drafts: RecordDraft[] = [];
  const keys = new Set<string>();
  const sink = {
    drafts,
    failing: false,
    async put(draft: RecordDraft): Promise<RecordIngestOutcome> {
      if (sink.failing) throw new Error("the record could not be reached");
      drafts.push(structuredClone(draft));
      const refusal = recordDraftRefusal(draft);
      if (refusal !== undefined) return { status: "refused", reason: refusal };
      const key = recordIdempotencyKey(draft);
      if (keys.has(key)) return { status: "duplicate" };
      keys.add(key);
      return { status: "stored" };
    },
    async tombstone() { if (sink.failing) throw new Error("the record could not be reached"); return { hidden: 0 }; },
    async changePrincipals() { if (sink.failing) throw new Error("the record could not be reached"); },
    async replaceScopeAudience() { if (sink.failing) throw new Error("the record could not be reached"); },
  };
  return sink;
}

export interface RecordSourceUnderTest {
  source: TeamRecordSource;
  /** Deliveries the source records something from (already verified, as the host's route hands them). Needed when it can `receive`. */
  deliveries?: readonly unknown[];
  /** A poll that reads at least one item. Needed when it can `poll`. */
  poll?: Omit<RecordPollRequest, "deadline">;
  dispose?: () => Promise<void>;
}

export interface RecordSourceHarness {
  create(): Promise<RecordSourceUnderTest>;
}

export function runRecordSourceConformance(name: string, harness: RecordSourceHarness): void {
  async function withSource<T>(body: (under: RecordSourceUnderTest) => Promise<T>): Promise<T> {
    const under = await harness.create();
    try { return await body(under); } finally { await under.dispose?.(); }
  }
  /** Every draft a source writes: a well-formed draft of its own source, in a retention it says it honours, with a permission snapshot of its own source. */
  const checkDrafts = (source: TeamRecordSource, drafts: readonly RecordDraft[]) => {
    expect(drafts.length).toBeGreaterThan(0);
    for (const draft of drafts) {
      expect(recordDraftRefusal(draft), JSON.stringify(draft.sourceRef)).toBeUndefined();
      expect(draft.source).toBe(source.source);
      expect(source.capabilities.retentions).toContain(draft.retention);
      if (draft.audience.kind === "restricted") expect(draft.audience.acl.source).toBe(source.source);
    }
  };

  describe(`record source conformance: ${name}`, () => {
    it("names itself with a source id and says only what it can do", () => withSource(async ({ source, deliveries, poll }) => {
      expect(RecordSourceIdSchema.safeParse(source.source).success).toBe(true);
      expect(source.capabilities.retentions.length).toBeGreaterThan(0);
      expect(source.capabilities.delivery.includes("push")).toBe(source.receive !== undefined);
      expect(source.capabilities.delivery.includes("poll")).toBe(source.poll !== undefined);
      expect(source.capabilities.existence).toBe(source.exists !== undefined);
      if (source.receive !== undefined) expect(deliveries?.length ?? 0).toBeGreaterThan(0);
      if (source.poll !== undefined) expect(poll).toBeDefined();
    }));

    it("turns each delivery into well-formed drafts of its own source, and the same delivery again into the same writes", () => withSource(async ({ source, deliveries }) => {
      if (source.receive === undefined) return;
      const first = createRecordingSink();
      const second = createRecordingSink();
      for (const delivery of deliveries ?? []) {
        const outcome = await source.receive(delivery, first);
        expect(outcome.status).toBe("recorded");
        expect(outcome.failed).toBe(0);
        await source.receive(delivery, second);
      }
      checkDrafts(source, first.drafts);
      expect(second.drafts.map(recordIdempotencyKey)).toEqual(first.drafts.map(recordIdempotencyKey));
    }));

    it("never counts a write the sink could not take as written (the host delivers again)", () => withSource(async ({ source, deliveries }) => {
      if (source.receive === undefined) return;
      const sink = createRecordingSink();
      sink.failing = true;
      const outcome = await source.receive(deliveries![0], sink).catch(() => undefined);
      if (outcome !== undefined) {
        expect(outcome.written).toBe(0);
        expect(outcome.failed).toBeGreaterThan(0);
      }
    }));

    it("ignores a delivery it does not record, writing nothing", () => withSource(async ({ source }) => {
      if (source.receive === undefined) return;
      const sink = createRecordingSink();
      const outcome = await source.receive({ unrelated: true }, sink).catch(() => undefined);
      expect(sink.drafts).toHaveLength(0);
      if (outcome !== undefined) expect(outcome.written).toBe(0);
    }));

    it("polls well-formed drafts of the asked company, and keeps its cursor when a write failed", () => withSource(async ({ source, poll }) => {
      if (source.poll === undefined || poll === undefined) return;
      const sink = createRecordingSink();
      const outcome = await source.poll({ ...poll, deadline: Date.now() + 30_000 }, sink);
      checkDrafts(source, sink.drafts);
      for (const draft of sink.drafts) expect(draft.workspaceId).toBe(poll.workspaceId);
      expect(outcome.failed).toBe(0);
      const failing = createRecordingSink();
      failing.failing = true;
      const failed = await source.poll({ ...poll, deadline: Date.now() + 30_000 }, failing).catch(() => undefined);
      if (failed !== undefined) {
        expect(failed.written).toBe(0);
        expect(failed.cursor === undefined || failed.cursor === poll.cursor).toBe(true);
      }
    }));

    it("answers whether items exist for every id asked, never inventing ids", () => withSource(async ({ source }) => {
      if (source.exists === undefined) return;
      const answer = await source.exists({ workspaceId: COMPANY, system: "T1", nativeIds: ["one", "two"] });
      for (const [id, state] of answer) {
        expect(["one", "two"]).toContain(id);
        expect(["exists", "missing", "forbidden", "unknown"]).toContain(state);
      }
    }));
  });
}
