// The `team-record-source` point: an in-memory record sink that keeps the sink contract (for the conformance suite and for testing a source), a scripted source
// for tests, Code's local sink (there is no team record on a Code install: every write is refused), and the list of known sources the audience rule reads.
import {
  RecordSourceIdSchema, recordDraftRefusal, recordIdempotencyKey, recordScopeCovers,
  type AdapterRegistry, type Audience, type RecordDraft, type RecordExistence, type RecordIngestOutcome, type RecordPollOutcome, type RecordPollRequest,
  type RecordReceiveOutcome, type RecordSink, type RecordTombstoneCause, type RecordWriteCounts, type TeamRecordSource, type TeamRecordSourceCapabilities,
} from "@agentx/contracts";

/** A stored row as the memory sink shows it. */
export interface MemoryRecordRow {
  draft: RecordDraft;
  hidden: boolean;
  /** Set on a hidden row: why. */
  cause?: RecordTombstoneCause;
}

export interface MemoryRecordSink extends RecordSink {
  /** The item's current row (the newest version; change rows are not items), hidden or not. */
  row(workspaceId: string, source: string, system: string, id: string): MemoryRecordRow | undefined;
  /** The rows a reader may see in one company: item heads and change rows that are not hidden. */
  visible(workspaceId: string): RecordDraft[];
  /** The seeded member list of a place, if `ensureAccessSeed` seeded one. */
  accessSeed(workspaceId: string, scope: string): Audience | undefined;
  /** Tests: every call throws while down (a record that cannot be reached). */
  setDown(down: boolean): void;
}

const at = (draft: RecordDraft): string => draft.sourceRef.versionAt ?? draft.occurredAt;
const scopeOf = (draft: RecordDraft): string | undefined => draft.scope ?? (draft.audience.kind === "restricted" ? draft.audience.acl.scope : undefined);
const PRINCIPALS_MAX = 500;

export function createMemoryRecordSink(): MemoryRecordSink {
  const heads = new Map<string, MemoryRecordRow>();
  const changes = new Map<string, MemoryRecordRow>();
  const seen = new Set<string>();
  const sticky = new Set<string>();
  const excluded: Array<{ workspaceId: string; scope: string }> = [];
  const seeds = new Map<string, Audience>();
  let down = false;
  const itemKey = (workspaceId: string, source: string, system: string, id: string): string => JSON.stringify([workspaceId, source, system, id]);
  const stickyKey = (workspaceId: string, system: string, id: string): string => JSON.stringify([workspaceId, system, id]);
  const check = (): void => { if (down) throw new Error("the record could not be reached"); };
  const allRows = (): MemoryRecordRow[] => [...heads.values(), ...changes.values()];

  return {
    async put(input) {
      check();
      const refusal = recordDraftRefusal(input);
      if (refusal !== undefined) return { status: "refused", reason: refusal };
      const draft = structuredClone(input);
      const key = recordIdempotencyKey(draft);
      if (seen.has(key)) return { status: "duplicate" };
      if (sticky.has(stickyKey(draft.workspaceId, draft.sourceRef.system, draft.sourceRef.id))) return { status: "refused", reason: "the item was deleted at its source" };
      const scope = scopeOf(draft);
      if (scope !== undefined && excluded.some((entry) => entry.workspaceId === draft.workspaceId && recordScopeCovers(entry.scope, scope))) return { status: "refused", reason: "the place is excluded" };
      if (draft.sourceRef.order !== undefined) {
        seen.add(key);
        changes.set(key, { draft, hidden: false });
        return { status: "stored" };
      }
      const item = itemKey(draft.workspaceId, draft.source, draft.sourceRef.system, draft.sourceRef.id);
      const head = heads.get(item);
      if (head !== undefined) {
        const newer = at(draft) > at(head.draft) || (at(draft) === at(head.draft) && draft.sourceRef.version > head.draft.sourceRef.version);
        if (!newer) { seen.add(key); return { status: "duplicate" }; }
      }
      seen.add(key);
      heads.set(item, { draft, hidden: false });
      return { status: "stored" };
    },
    async tombstone(input) {
      check();
      let hidden = 0;
      const ids = input.sourceIds === undefined ? undefined : new Set(input.sourceIds);
      if (ids === undefined && input.scope === undefined) return { hidden: 0 };
      for (const id of ids ?? []) sticky.add(stickyKey(input.workspaceId, input.system, id));
      for (const row of allRows()) {
        const { draft } = row;
        if (draft.workspaceId !== input.workspaceId || draft.sourceRef.system !== input.system) continue;
        const scope = scopeOf(draft);
        const matches = ids !== undefined ? ids.has(draft.sourceRef.id) : scope !== undefined && recordScopeCovers(input.scope!, scope);
        if (!matches) continue;
        sticky.add(stickyKey(draft.workspaceId, draft.sourceRef.system, draft.sourceRef.id));
        if (!row.hidden) { row.hidden = true; row.cause = input.cause; hidden += 1; }
      }
      if (ids === undefined && input.scope !== undefined && input.cause === "excluded") excluded.push({ workspaceId: input.workspaceId, scope: input.scope });
      return { hidden };
    },
    async changePrincipals(input) {
      check();
      const add = input.add ?? [];
      const remove = new Set(input.remove ?? []);
      for (const row of allRows()) {
        const { audience } = row.draft;
        if (row.draft.workspaceId !== input.workspaceId || audience.kind !== "restricted" || audience.acl.scope !== input.scope || audience.acl.capturedAt > input.at) continue;
        const principals = [...new Set([...(audience.acl.principals ?? []).filter((id) => !remove.has(id)), ...add.filter((id) => !remove.has(id))])].slice(0, PRINCIPALS_MAX);
        row.draft.audience = { kind: "restricted", acl: { ...audience.acl, principals, capturedAt: input.at } };
      }
    },
    async replaceScopeAudience(input) {
      check();
      for (const row of allRows()) {
        const scope = scopeOf(row.draft);
        if (row.draft.workspaceId !== input.workspaceId || scope === undefined || !recordScopeCovers(input.scope, scope)) continue;
        row.draft.audience = structuredClone(input.audience);
      }
    },
    async ensureAccessSeed(input) {
      check();
      const key = JSON.stringify([input.workspaceId, input.scope]);
      if (seeds.has(key)) return;
      const read = await input.read();
      if (read !== undefined) seeds.set(key, structuredClone(read));
    },
    row(workspaceId, source, system, id) {
      const row = heads.get(itemKey(workspaceId, source, system, id));
      return row === undefined ? undefined : structuredClone(row);
    },
    visible: (workspaceId) => allRows().filter((row) => !row.hidden && row.draft.workspaceId === workspaceId).map((row) => structuredClone(row.draft)),
    accessSeed: (workspaceId, scope) => {
      const seed = seeds.get(JSON.stringify([workspaceId, scope]));
      return seed === undefined ? undefined : structuredClone(seed);
    },
    setDown(value) { down = value; },
  };
}

/** Code's sink: a Code install keeps no team record (decision 41), so every write is refused and nothing is hidden. A source registered on a Code install records nothing. */
export function createRefusingRecordSink(): RecordSink {
  const refused: RecordIngestOutcome = { status: "refused", reason: "this install keeps no team record" };
  return {
    async put() { return refused; },
    async tombstone() { return { hidden: 0 }; },
    async changePrincipals() { /* nothing is kept */ },
    async replaceScopeAudience() { /* nothing is kept */ },
  };
}

/** Adds one sink answer to the counts. */
export function countRecordOutcome(counts: RecordWriteCounts, outcome: RecordIngestOutcome): void {
  if (outcome.status === "stored" || outcome.status === "queued") counts.written += 1;
  else if (outcome.status === "duplicate") counts.duplicates += 1;
  else counts.refused += 1;
}

const zero = (): RecordWriteCounts => ({ written: 0, duplicates: 0, refused: 0, failed: 0 });

/** Writes drafts one by one, counting; a write the sink throws on is `failed` (the caller redelivers). */
async function writeAll(sink: RecordSink, drafts: readonly RecordDraft[]): Promise<RecordWriteCounts> {
  const counts = zero();
  for (const draft of drafts) {
    try { countRecordOutcome(counts, await sink.put(draft)); } catch { counts.failed += 1; }
  }
  return counts;
}

export interface FakeRecordSourceOptions {
  source?: string;
  capabilities?: Partial<TeamRecordSourceCapabilities>;
  /** What a delivery becomes: the drafts it records (none: ignored). Default: the payload itself when it is an array of drafts. */
  draftsOf?: (payload: unknown) => readonly RecordDraft[];
  /** The items a poll reads, oldest first; the cursor is the index of the next one. */
  items?: readonly RecordDraft[];
  /** What `exists` answers by native id (absent: `unknown`). */
  existence?: Readonly<Record<string, RecordExistence>>;
}

/** A scripted source for tests: deliveries and polls become the drafts it was given, written to the sink it is handed. */
export function createFakeRecordSource(options: FakeRecordSourceOptions = {}): TeamRecordSource {
  const source = options.source ?? "chat";
  const items = options.items ?? [];
  const draftsOf = options.draftsOf ?? ((payload: unknown) => (Array.isArray(payload) ? payload as RecordDraft[] : []));
  return {
    source,
    capabilities: { delivery: ["push", "poll"], existence: true, acl: "place", retentions: ["A", "B", "C", "D"], ...options.capabilities },
    async receive(payload, sink): Promise<RecordReceiveOutcome> {
      const drafts = draftsOf(payload);
      if (drafts.length === 0) return { status: "ignored", reason: "nothing_to_record", ...zero() };
      return { status: "recorded", ...(await writeAll(sink, drafts)) };
    },
    async poll(request: RecordPollRequest, sink): Promise<RecordPollOutcome> {
      const start = request.cursor === undefined ? 0 : Number.parseInt(request.cursor, 10);
      const from = Number.isInteger(start) && start >= 0 ? start : 0;
      const page = items.slice(from, from + Math.max(0, request.limit)).filter((draft) => draft.workspaceId === request.workspaceId);
      const counts = await writeAll(sink, page);
      const next = from + Math.min(Math.max(0, request.limit), Math.max(0, items.length - from));
      return { ...counts, ...(counts.failed > 0 ? {} : { cursor: String(next) }), done: next >= items.length };
    },
    async exists(request) {
      return new Map(request.nativeIds.map((id) => [id, options.existence?.[id] ?? "unknown"] as const));
    },
  };
}

/** The `source` ids of the registered `team-record-source` adapters, plus the recorders built in: the sources `audienceForSource` believes. A malformed id is left out. */
export function knownRecordSources(registry: Pick<AdapterRegistry, "names" | "require">, builtIn: Iterable<string> = []): Set<string> {
  const known = new Set<string>();
  for (const id of builtIn) if (RecordSourceIdSchema.safeParse(id).success) known.add(id);
  for (const name of registry.names("team-record-source")) {
    const { source } = registry.require("team-record-source", name);
    if (RecordSourceIdSchema.safeParse(source).success) known.add(source);
  }
  return known;
}
