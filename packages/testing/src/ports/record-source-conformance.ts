// The conformance suites of the `team-record-source` point:
//   - `runRecordSinkConformance`: the sink contract (`RecordSink` in contracts) that makes arrival order, repeats and deletes safe. The in-memory sink and the hosted
//     record's sink (over a test table, never the real one) run it.
//   - `runRecordSourceConformance`: what every source adapter's writes must be. The scripted fake and each hosted source tap (fed recorded deliveries) run it.
import { describe, expect, it } from "vitest";
import {
  RecordSourceIdSchema, recordDraftRefusal, recordIdempotencyKey, recordSourceDraftProblem,
  type Audience, type RecordDraft, type RecordIngestOutcome, type RecordPollRequest, type RecordSink, type TeamRecordSource,
} from "@agentx/contracts";

const COMPANY = "org_00000000000000000000";
const OTHER = "org_11111111111111111111";
const AT = "2026-11-10T10:00:00.000Z";
const LATER = "2026-11-10T11:00:00.000Z";

/**
 * What the suites record with: a source, a row kind and a source instance the sink under test accepts, and how a place is named. Code's fakes use `chat`; a hosted sink
 * names one of its own sources (and its `setup` writes that source's settings for each place, so the sink records there).
 */
export interface RecordSample {
  source: string;
  kind: string;
  system: string;
  /** The place for a path: `place("C9")` and the place under it, `place("C9/thread")`. Two paths that only start the same (`C9`, `C90`) must give sibling places. */
  place: (path: string) => string;
}

export const CHAT_SAMPLE: RecordSample = { source: "chat", kind: "chat.message", system: "T1", place: (path) => `chat:T1/${path}` };

/** A draft for the suites: a member's message in a place, visible to the place's members. `place` is a path for `sample.place`. */
export function sampleRecordDraft(sample: RecordSample = CHAT_SAMPLE, extra: Partial<RecordDraft> & { id?: string; version?: string; place?: string } = {}): RecordDraft {
  const { id = "C9/1700000000.0001", version = "v1", place = "C9", ...rest } = extra;
  const scope = sample.place(place);
  const audience: Audience = { kind: "restricted", acl: { source: sample.source, scope, principals: ["U1", "U2"], capturedAt: AT, liveCheck: "none" } };
  return {
    workspaceId: COMPANY, project: "web", source: sample.source,
    sourceRef: { system: sample.system, id, version },
    kind: sample.kind, occurredAt: AT, actor: { sourceId: "U1", trust: "member" }, trust: "member", audience,
    text: "The deploy needs the cache warmed first.", links: [], retention: "D", scope, ...rest,
  };
}

// ---- the sink

/** How the harness reads back what a sink keeps. `trust` and `links` are checked when the harness gives them. */
export interface StoredRecordView {
  text?: string | undefined;
  version: string;
  hidden: boolean;
  audience: Audience;
  trust?: string;
  links?: readonly string[];
}

export interface RecordSinkUnderTest {
  sink: RecordSink;
  /** What to record with. Absent: `CHAT_SAMPLE`. */
  sample?: RecordSample;
  /** Called once for each company and place before the first write there (a hosted sink writes its source's settings: on, retention D, the project). */
  setup?: (workspaceId: string, scope: string) => Promise<void>;
  /** The item's current row (the newest version), or undefined when none was stored. */
  read: (workspaceId: string, source: string, system: string, id: string) => Promise<StoredRecordView | undefined>;
  /** For a sink that queues every call (answers `queued`): applies what is queued. */
  settle?: () => Promise<void>;
  dispose?: () => Promise<void>;
}

export interface RecordSinkHarness {
  create(): Promise<RecordSinkUnderTest>;
}

interface SinkContext extends RecordSinkUnderTest {
  sample: RecordSample;
  put: (draft: RecordDraft) => Promise<RecordIngestOutcome>;
  draft: (extra?: Parameters<typeof sampleRecordDraft>[1]) => RecordDraft;
  row: (id: string, workspaceId?: string) => Promise<StoredRecordView | undefined>;
  tombstone: (input: Parameters<RecordSink["tombstone"]>[0]) => Promise<{ hidden: number }>;
}

export function runRecordSinkConformance(name: string, harness: RecordSinkHarness): void {
  async function withSink<T>(body: (context: SinkContext) => Promise<T>): Promise<T> {
    const under = await harness.create();
    const sample = under.sample ?? CHAT_SAMPLE;
    const ready = new Set<string>();
    const prepare = async (draft: RecordDraft) => {
      const scope = draft.audience.kind === "restricted" ? draft.audience.acl.scope : draft.scope;
      const key = JSON.stringify([draft.workspaceId, scope]);
      if (scope !== undefined && !ready.has(key)) { ready.add(key); await under.setup?.(draft.workspaceId, scope); }
    };
    const context: SinkContext = {
      ...under, sample,
      async put(draft) { await prepare(draft); const outcome = await under.sink.put(draft); await under.settle?.(); return outcome; },
      draft: (extra = {}) => sampleRecordDraft(sample, extra),
      row: (id, workspaceId = COMPANY) => under.read(workspaceId, sample.source, sample.system, id),
      async tombstone(input) { const result = await under.sink.tombstone(input); await under.settle?.(); return result; },
    };
    try { return await body(context); } finally { await under.dispose?.(); }
  }
  const stored = (outcome: RecordIngestOutcome) => expect(["stored", "queued"]).toContain(outcome.status);
  const repeated = (outcome: RecordIngestOutcome) => expect(["duplicate", "queued"]).toContain(outcome.status);
  const notStored = (outcome: RecordIngestOutcome) => expect(["refused", "queued"]).toContain(outcome.status);
  const gone = (row: StoredRecordView | undefined) => expect(row === undefined || row.hidden).toBe(true);

  describe(`record sink conformance: ${name}`, () => {
    it("stores a draft once: the same item and version again is a repeat", () => withSink(async ({ put, draft, row }) => {
      stored(await put(draft()));
      repeated(await put(draft()));
      const kept = await row("C9/1700000000.0001");
      expect(kept).toMatchObject({ version: "v1", hidden: false });
      expect(kept?.text).toContain("cache warmed first");
    }));

    it("replaces an item's text with a newer version, and never with an older one that arrives late", () => withSink(async ({ put, draft, row, sample }) => {
      stored(await put(draft()));
      stored(await put(draft({ version: "v2", text: "Edited: warm the cache.", sourceRef: { system: sample.system, id: "C9/1700000000.0001", version: "v2", versionAt: LATER } })));
      repeated(await put(draft({ version: "v0", text: "An old version.", sourceRef: { system: sample.system, id: "C9/1700000000.0001", version: "v0", versionAt: "2026-11-10T09:00:00.000Z" } })));
      const kept = await row("C9/1700000000.0001");
      expect(kept?.version).toBe("v2");
      expect(kept?.text).toContain("Edited: warm the cache.");
    }));

    it("keeps a delete that arrives before its put: the late put is refused", () => withSink(async ({ put, draft, row, tombstone, sample }) => {
      await tombstone({ workspaceId: COMPANY, system: sample.system, sourceIds: ["C9/1700000000.0001"], cause: "source_deleted" });
      notStored(await put(draft()));
      gone(await row("C9/1700000000.0001"));
    }));

    it("hides a stored item at once on a delete, and refuses a newer version of it afterwards", () => withSink(async ({ put, draft, row, tombstone, sample }) => {
      stored(await put(draft()));
      const { hidden } = await tombstone({ workspaceId: COMPANY, system: sample.system, sourceIds: ["C9/1700000000.0001"], cause: "source_deleted" });
      expect(hidden).toBeLessThanOrEqual(1);
      gone(await row("C9/1700000000.0001"));
      notStored(await put(draft({ version: "v2", sourceRef: { system: sample.system, id: "C9/1700000000.0001", version: "v2", versionAt: LATER } })));
      gone(await row("C9/1700000000.0001"));
    }));

    it("deletes a place and the places under it, not a sibling whose name only starts the same, and closes it: nothing new is stored there", () => withSink(async ({ put, draft, row, tombstone, sample }) => {
      stored(await put(draft({ id: "a", place: "C9" })));
      stored(await put(draft({ id: "b", place: "C9/thread" })));
      stored(await put(draft({ id: "c", place: "C90" })));
      await tombstone({ workspaceId: COMPANY, system: sample.system, scope: sample.place("C9"), cause: "source_deleted" });
      gone(await row("a"));
      gone(await row("b"));
      expect((await row("c"))?.hidden).toBe(false);
      notStored(await put(draft({ id: "d", place: "C9" })));
      notStored(await put(draft({ id: "e", place: "C9/thread" })));
      gone(await row("d"));
      stored(await put(draft({ id: "f", place: "C90" })));
    }));

    it("closes an excluded place too", () => withSink(async ({ put, draft, row, tombstone, sample }) => {
      await tombstone({ workspaceId: COMPANY, system: sample.system, scope: sample.place("C7"), cause: "excluded" });
      notStored(await put(draft({ id: "e", place: "C7" })));
      gone(await row("e"));
    }));

    it("keeps a per-editor change row apart: it replaces nothing and is replaced by nothing", () => withSink(async ({ put, draft, row, sample }) => {
      stored(await put(draft()));
      stored(await put(draft({ version: "e1", text: "My own edit.", sourceRef: { system: sample.system, id: "C9/1700000000.0001", version: "e1", versionAt: LATER, order: 1_700_000_000_500 } })));
      const kept = await row("C9/1700000000.0001");
      expect(kept?.version).toBe("v1");
      expect(kept?.text).toContain("cache warmed first");
    }));

    it("refuses what is not a draft", () => withSink(async ({ put, draft }) => {
      for (const bad of [{ ...draft(), source: "Not A Source" }, { ...draft(), kind: "message" }, { ...draft(), occurredAt: "yesterday" }]) notStored(await put(bad));
    }));

    it("keeps no text under retention A or B", () => withSink(async ({ put, draft, row }) => {
      for (const [id, retention] of [["ra", "A"], ["rb", "B"]] as const) {
        const outcome = await put(draft({ id, retention }));
        expect(["stored", "queued", "refused"]).toContain(outcome.status);
        expect((await row(id))?.text).toBeUndefined();
      }
    }));

    it("never stores a row trusted above its author, and trims links instead of refusing", () => withSink(async ({ put, draft, row }) => {
      const links = ["https://example.test/1", "javascript:alert(1)", `https://example.test/${"x".repeat(2_100)}`, ...Array.from({ length: 30 }, (_, i) => `https://example.test/p${String(i)}`)];
      const outcome = await put(draft({ id: "t1", trust: "member", actor: { sourceId: "U9", trust: "outsider" }, links }));
      if (outcome.status === "refused") return;
      const kept = await row("t1");
      if (kept?.trust !== undefined) expect(kept.trust).toBe("outsider");
      if (kept?.links !== undefined) {
        expect(kept.links.length).toBeLessThanOrEqual(20);
        expect(kept.links).not.toContain("javascript:alert(1)");
        for (const link of kept.links) expect(link.length).toBeLessThanOrEqual(2_048);
      }
    }));

    it("hands B text to the distiller only where a stored row could go", () => withSink(async ({ sink, put, draft, tombstone, sample }) => {
      if (sink.distillTransient === undefined) return;
      stored(await put(draft({ id: "open-place", place: "C5" })));
      const open = draft({ id: "b1", place: "C5", retention: "B" }) as RecordDraft & { text: string };
      expect((await sink.distillTransient(open)).accepted).toBe(true);
      await tombstone({ workspaceId: COMPANY, system: sample.system, scope: sample.place("C5"), cause: "source_deleted" });
      expect((await sink.distillTransient({ ...open, sourceRef: { ...open.sourceRef, id: "b2" } })).accepted).toBe(false);
    }));

    it("changes a private place's members, keeps a removal against a late older event, and moves a place to a new audience", () => withSink(async ({ sink, put, draft, row, settle }) => {
      stored(await put(draft()));
      const principals = async () => {
        const kept = await row("C9/1700000000.0001");
        return kept?.audience.kind === "restricted" ? [...(kept.audience.acl.principals ?? [])].sort() : [];
      };
      await sink.changePrincipals({ workspaceId: COMPANY, scope: draft().scope!, add: ["U3"], remove: ["U2"], at: LATER });
      await settle?.();
      expect(await principals()).toEqual(["U1", "U3"]);
      // An add of U2 made BEFORE the removal, delivered after it, does not bring U2 back.
      await sink.changePrincipals({ workspaceId: COMPANY, scope: draft().scope!, add: ["U2"], at: "2026-11-10T10:30:00.000Z" });
      await settle?.();
      expect(await principals()).not.toContain("U2");
      await sink.replaceScopeAudience({ workspaceId: COMPANY, scope: draft().scope!, audience: { kind: "project" }, at: "2026-11-10T12:00:00.000Z" });
      await settle?.();
      expect((await row("C9/1700000000.0001"))?.audience).toEqual({ kind: "project" });
    }));

    it("keeps companies apart: a delete in one company leaves the same item in another", () => withSink(async ({ put, draft, row, tombstone, sample }) => {
      stored(await put(draft()));
      stored(await put(draft({ workspaceId: OTHER })));
      await tombstone({ workspaceId: OTHER, system: sample.system, sourceIds: ["C9/1700000000.0001"], cause: "person_erased" });
      expect((await row("C9/1700000000.0001"))?.hidden).toBe(false);
      gone(await row("C9/1700000000.0001", OTHER));
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
  /** Optional: the same source made with settings it cannot read (a store that is down). It must record nothing. */
  unreadableSettings?: () => Promise<TeamRecordSource>;
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
      expect(recordSourceDraftProblem(draft), JSON.stringify(draft.sourceRef)).toBeUndefined();
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

    it("records nothing when its own settings cannot be read (fail closed)", () => withSource(async ({ deliveries, unreadableSettings }) => {
      if (unreadableSettings === undefined) return;
      const blind = await unreadableSettings();
      const sink = createRecordingSink();
      for (const delivery of deliveries ?? []) {
        const outcome = await blind.receive?.(delivery, sink).catch(() => undefined);
        if (outcome !== undefined) expect(outcome.written).toBe(0);
      }
      expect(sink.drafts).toHaveLength(0);
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
