// The lesson store. `LessonStore` is the interface; `InMemoryLessonStore` is the stand-in the tests and the first wiring use.
// A durable implementation (the document store's, or a host's own) must give the same guarantees:
//   - a commit is one conditional write: it applies only if the project's lesson-set version is the one the caller read, and every lesson's version
//     is exactly the previous version plus one; otherwise nothing changes ("conflict") and the caller re-reads (ACE: delta updates applied by code);
//   - every lesson version is kept, and every set version records which lesson versions it held, so a rollback restores a past set;
//   - counters and expiry bookkeeping change in place (`mutate`) without a new version.
// Every key carries the workspace and the project, so one workspace's call can never read or change another's lessons.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { applyWriteFence, planRollback, withUsageOf, type FenceView } from "./store-rules.js";
import { LessonSchema, normId, normSource, type Lesson, type LessonStatus, type VOLATILE_FIELDS } from "./types.js";
import type { LessonStage } from "@agentx/contracts";

export interface ScopeKey { workspaceId: string; project: string }
export type CommitResult = { ok: true; setVersion: number; /** Lessons a rollback brought back; each comes back needing a person. */ restored?: string[] } | { ok: false; reason: "conflict" | "erased" | "fenced" };

/**
 * A durable record of a multi-step deletion (forget, withdraw, purge). It is written BEFORE the first step and marked finished only after the last, and each
 * step is idempotent, so a retry or a sweeper resumes the ORIGINAL intent: it never switches it (for example from keep to withdraw), and nothing is orphaned.
 */
export interface DeletionIntent {
  id: string; lessonId: string; kind: "forget" | "withdraw" | "purge"; cause: string; deleted: string[]; erased?: string;
  /** Decided once, before any write: scrub only, kept on code alone (back to a person), withdrawn, or hard-deleted. */
  outcome: "scrub" | "downgrade" | "withdraw" | "purge";
  /** Whether the lesson was in the current set when the intent was made (decides commit versus in-place rewrite). */
  inSet: boolean;
  done: string[]; finished: boolean; at: number;
}

export interface LoadManifestEntry {
  id: string; version: number; score: number; why: "scope" | "similar" | "path";
  citation: "unchecked" | "valid" | "moved" | "stale_dropped" | "unchecked_dropped" | "none";
  /** The tasks the lesson was learned from, as they were when it was loaded (`lessonTaskRefs`). The task's own lessons inherit these even if the lesson is later edited, scrubbed or gone. Absent on older records. */
  taskIds?: string[];
}
export interface LoadManifest {
  taskId: string; workspaceId: string; project: string; stage: LessonStage; round: number; setVersion: number;
  memory: "live" | "off" | "snapshot"; /** The frozen snapshot a replay copy was given (memory "snapshot"). Such a manifest is an eval load: the live counters never see it. */ snapshotId?: string; at: number; lessons: LoadManifestEntry[]; bytes: number;
}
export interface PendingOutcome { key: string; workspaceId: string; project: string; lessonId: string; taskId: string; dueAt: number }
/** A source paused by spike detection: its lessons are collected but held until a maintainer resumes the source. */
export interface ProjectFlags { pausedSources?: Record<string, { at: number; reason: string }>; volumeAlertedAt?: number }
export interface SetSnapshot { setVersion: number; at: number; members: Array<{ id: string; version: number }> }

export interface LessonStore {
  get(key: ScopeKey, id: string): Promise<Lesson | undefined>;
  list(key: ScopeKey, filter?: { statuses?: readonly LessonStatus[] }): Promise<Lesson[]>;
  /**
   * One page of `list`, for the nightly passes (lessons connect): the set's members in id order, `limit` of them from the first id after `after`, filtered by status. `next` is the last id looked at, and is
   * absent when the set has no more. A page can hold fewer lessons than `limit` (members of other statuses are looked at and skipped), so a caller goes on while `next` is there.
   */
  listPage(key: ScopeKey, filter: { statuses?: readonly LessonStatus[]; after?: string; limit: number }): Promise<{ lessons: Lesson[]; next?: string }>;
  /** Every stored head, including lessons that a rollback dropped from the current set: deletion and erasure walk these, not only the set. */
  listAllHeads(key: ScopeKey): Promise<Lesson[]>;
  /** A lesson's head whether or not it is in the current set. */
  getHead(key: ScopeKey, id: string): Promise<Lesson | undefined>;
  setVersion(key: ScopeKey): Promise<number>;
  versions(key: ScopeKey, id: string): Promise<Lesson[]>;
  snapshots(key: ScopeKey): Promise<SetSnapshot[]>;
  /**
   * Writes new versions in one conditional step. `fence` is the opaque set of commit conditions a decision rested on (who may approve, read from the membership records); they commit
   * WITH the write, so a person removed since the read stops it ("fenced"). A store that cannot honour a fence refuses the write: it never ignores one.
   */
  commit(key: ScopeKey, expectedSetVersion: number, writes: readonly Lesson[], at: number, fence?: readonly unknown[]): Promise<CommitResult>;
  /** Restores the lessons of an earlier set version as a new set version. */
  rollback(key: ScopeKey, targetSetVersion: number, expectedSetVersion: number, at: number): Promise<CommitResult>;
  /** Changes the volatile fields of a lesson in place; `fn` returns the new values (or undefined for no change). */
  mutate(key: ScopeKey, id: string, fn: (lesson: Lesson) => Partial<Pick<Lesson, (typeof VOLATILE_FIELDS)[number]>> | undefined): Promise<Lesson | undefined>;
  putManifest(manifest: LoadManifest): Promise<boolean>;
  manifests(key: ScopeKey, taskId: string): Promise<LoadManifest[]>;
  updateManifest(manifest: LoadManifest): Promise<void>;
  /** True the first time a key is seen, false after; makes counters idempotent. */
  markOnce(key: ScopeKey, name: string): Promise<boolean>;
  /** True when the key was already used by `markOnce` (reads only; never takes the key). */
  seenOnce(key: ScopeKey, name: string): Promise<boolean>;
  addPending(entry: PendingOutcome): Promise<void>;
  /** True when a pending outcome (a queued helpful mark) names the lesson, due or not. */
  hasPending(key: ScopeKey, lessonId: string): Promise<boolean>;
  duePending(key: ScopeKey, now: number, limit: number): Promise<PendingOutcome[]>;
  removePending(key: ScopeKey, pendingKey: string): Promise<void>;
  flags(key: ScopeKey): Promise<ProjectFlags>;
  setFlags(key: ScopeKey, flags: ProjectFlags): Promise<void>;
  /**
   * Rewrites the head AND every stored version of a lesson in place (no new version), for deletion and erasure: old versions must not keep what was deleted.
   * `fn` returns the scrubbed lesson; a rollback can then never bring a deleted id back.
   */
  scrub(key: ScopeKey, id: string, fn: (lesson: Lesson) => Lesson): Promise<void>;
  /** Marks a lesson as gone for good: a rollback never restores a withdrawn lesson, and skips a purged one. */
  markGone(key: ScopeKey, id: string, mode: "withdrawn" | "purged"): Promise<void>;
  /**
   * Which of these ids are gone for good (withdrawn or purged): the durable per-lesson tombstone the erasure itself writes first, one row each, never evicted. A batched read (in chunks); throws when it cannot read, so a caller never
   * takes "could not look" for "not gone". The lessons file pass decides "this block must come out" from this, not from any list of its own.
   */
  goneOf(key: ScopeKey, ids: readonly string[]): Promise<Map<string, "withdrawn" | "purged">>;
  /**
   * Lessons in the repo: the FINGERPRINT of a text in one repository's lessons file: an HMAC (32 hex) of the text's comparison hash (`bodyHashOf`) and the repository's place, under a secret of the PROJECT (made on first
   * use, kept in the project's partition, wiped with it). It holds no text and no bare hash, and cannot be worked out without the secret. Read-back records the fingerprint of every marked block on every successful pass (while the
   * lesson is live), so that erasure finds a fingerprint ready, and marks the fingerprint of an erased lesson's text while a copy is in the file (`markGoneFingerprint`).
   */
  textFingerprints(key: ScopeKey, place: string, hashes: readonly string[]): Promise<Map<string, string>>;
  /** Marks a fingerprint: the text of a GONE lesson that is still in a repository's file. Read-back refuses a bullet with a marked fingerprint (a formatter or a deleted comment stripped its id line: erased words do not come back as a new lesson) and the erasure sweep takes it out of the file. Idempotent. */
  markGoneFingerprint(key: ScopeKey, fingerprint: string): Promise<void>;
  /** Which of these fingerprints are marked. A batched read; throws when it cannot read (never "not marked" for "could not look"). */
  goneFingerprintsOf(key: ScopeKey, fingerprints: readonly string[]): Promise<Set<string>>;
  /** Removes a mark: the erased text is out of the file, so a person who writes the same words again is the team's new lesson. Idempotent. */
  clearGoneFingerprint(key: ScopeKey, fingerprint: string): Promise<void>;
  /** Hard delete: the head, every version and every load-manifest reference. The id is remembered as purged so a rollback cannot bring it back. */
  purge(key: ScopeKey, id: string): Promise<void>;
  /** Forgets a source's counters and its pause (erasure of a person, deletion of a channel). */
  forgetSource(key: ScopeKey, source: string): Promise<void>;
  /**
   * The fence of a deletion or an erasure, written BEFORE anything is removed: a person is erased, or record ids are deleted. A commit that carries an erased
   * person or a deleted id is refused (a writer that read before the scrub cannot put them back). A durable store does this with a conditional write on the
   * project's fence item.
   */
  fence(key: ScopeKey, fence: { people?: readonly string[]; ids?: readonly string[]; /** An erased person's SOURCE ids (a Slack or GitHub user id): they may sit in a lesson's audience snapshot, and no commit may carry them. */ sourceIds?: readonly string[] }): Promise<void>;
  /**
   * A random reference for a person, the same each time, for keys that must not be derived from who they are (the "one mark per person per lesson" key of Helpful / Wrong here). Erasure
   * deletes the link (`forgetMarkRef`), so the rows made with the reference name nobody. Undefined for a person who is erased: they can make no new mark.
   */
  markRef(key: ScopeKey, person: string): Promise<string | undefined>;
  /** Deletes the link between a person and their reference. */
  forgetMarkRef(key: ScopeKey, person: string): Promise<void>;
  /** Remembers that the person behind `ref` (from `markRef`) caused one harmful mark on the lesson through a correction they made, so erasing the person can take it back (`takeBackHarm`). Idempotent. */
  noteHarm(key: ScopeKey, ref: string, lessonId: string): Promise<void>;
  /**
   * Erasure: hands each lesson whose harmful mark this person's corrections caused to `apply` (with the person's random reference, for an idempotency key), and forgets it only after `apply` returned (a crash between the two leaves it for the retry, never loses it). The reference is
   * read without being made; a person who never made one has none. Returns the lessons handed over. Call before `forgetMarkRef`.
   */
  takeBackHarm(key: ScopeKey, person: string, apply: (lessonId: string, ref: string) => Promise<void>): Promise<string[]>;
  /** Whether a person is fenced (erased). Ids are compared case-insensitively. */
  isErased(key: ScopeKey, person: string): Promise<boolean>;
  putIntent(key: ScopeKey, intent: DeletionIntent): Promise<void>;
  getIntent(key: ScopeKey, id: string): Promise<DeletionIntent | undefined>;
  listIntents(key: ScopeKey, filter?: { finished?: boolean }): Promise<DeletionIntent[]>;
  /** One candidate from a source (for the source's own baseline). */
  recordSourceEvent(key: ScopeKey, event: { at: number; source: string }): Promise<void>;
  /** Candidates per day from one source, newest day first (index 0 is the last 24 hours). */
  sourceDays(key: ScopeKey, source: string, days: number, now: number): Promise<number[]>;
}

const DAY = 86_400_000;
const scopeId = (k: ScopeKey): string => `${k.workspaceId}\u0001${k.project}`;
const clone = <T>(value: T): T => structuredClone(value);

interface ProjectState {
  heads: Map<string, Lesson>; versions: Map<string, Lesson[]>; members: Map<string, number>; sets: SetSnapshot[];
  manifests: Map<string, LoadManifest>; once: Set<string>; pending: Map<string, PendingOutcome>; flags: ProjectFlags;
  sourceEvents: Array<{ at: number; source: string }>;
  gone: Map<string, "withdrawn" | "purged">; goneTexts: Set<string>; textSecret?: Buffer;
  erased: Set<string>; markRefs: Map<string, string>; harms: Map<string, Set<string>>; erasedSources: Set<string>; deletedIds: Set<string>; intents: Map<string, DeletionIntent>;
}

export class InMemoryLessonStore implements LessonStore {
  private readonly state = new Map<string, ProjectState>();
  /** `fenceCheck` stands in for the table's condition evaluation in tests: it gets the fence's conditions and says whether they still hold. Without one, a fenced commit is refused. */
  constructor(private readonly options: { fenceCheck?: (conditions: readonly unknown[]) => boolean } = {}) {}

  private of(key: ScopeKey): ProjectState {
    const id = scopeId(key);
    let value = this.state.get(id);
    if (value === undefined) {
      value = { heads: new Map(), versions: new Map(), members: new Map(), sets: [{ setVersion: 0, at: 0, members: [] }], manifests: new Map(), once: new Set(), pending: new Map(), flags: {}, sourceEvents: [], gone: new Map(), goneTexts: new Set(), markRefs: new Map(), harms: new Map(), erased: new Set(), erasedSources: new Set(), deletedIds: new Set(), intents: new Map() };
      this.state.set(id, value);
    }
    return value;
  }

  private fenceView(s: ProjectState): FenceView {
    return { personErased: (p) => s.erased.has(normId(p)), idDeleted: (id) => s.deletedIds.has(id), sourceErased: (id) => s.erasedSources.has(id) };
  }

  async get(key: ScopeKey, id: string): Promise<Lesson | undefined> {
    const s = this.of(key);
    const head = s.members.has(id) ? s.heads.get(id) : undefined;
    return head === undefined ? undefined : clone(head);
  }

  async list(key: ScopeKey, filter?: { statuses?: readonly LessonStatus[] }): Promise<Lesson[]> {
    const s = this.of(key);
    const out: Lesson[] = [];
    for (const id of [...s.members.keys()].sort()) {
      const head = s.heads.get(id);
      if (head !== undefined && (filter?.statuses === undefined || filter.statuses.includes(head.status))) out.push(clone(head));
    }
    return out;
  }

  async listPage(key: ScopeKey, filter: { statuses?: readonly LessonStatus[]; after?: string; limit: number }): Promise<{ lessons: Lesson[]; next?: string }> {
    const s = this.of(key);
    const ids = [...s.members.keys()].sort().filter((id) => filter.after === undefined || id > filter.after);
    const page = ids.slice(0, Math.max(1, filter.limit));
    const lessons: Lesson[] = [];
    for (const id of page) {
      const head = s.heads.get(id);
      if (head !== undefined && (filter.statuses === undefined || filter.statuses.includes(head.status))) lessons.push(clone(head));
    }
    return { lessons, ...(ids.length > page.length ? { next: page[page.length - 1]! } : {}) };
  }
  async listAllHeads(key: ScopeKey): Promise<Lesson[]> { const s = this.of(key); return [...s.heads.keys()].sort().map((id) => clone(s.heads.get(id)!)); }
  async getHead(key: ScopeKey, id: string): Promise<Lesson | undefined> { const h = this.of(key).heads.get(id); return h === undefined ? undefined : clone(h); }

  async setVersion(key: ScopeKey): Promise<number> { return this.of(key).sets.at(-1)!.setVersion; }
  async versions(key: ScopeKey, id: string): Promise<Lesson[]> { return clone(this.of(key).versions.get(id) ?? []); }
  async snapshots(key: ScopeKey): Promise<SetSnapshot[]> { return clone(this.of(key).sets); }

  async commit(key: ScopeKey, expectedSetVersion: number, writes: readonly Lesson[], at: number, conditions?: readonly unknown[]): Promise<CommitResult> {
    const s = this.of(key);
    if (s.sets.at(-1)!.setVersion !== expectedSetVersion) return { ok: false, reason: "conflict" };
    if (conditions !== undefined && conditions.length > 0 && this.options.fenceCheck?.(conditions) !== true) return { ok: false, reason: "fenced" };
    const staged: Lesson[] = [];
    const fence = this.fenceView(s);
    for (const raw of writes) {
      const parsed = LessonSchema.parse(raw);
      if (parsed.workspaceId !== key.workspaceId || parsed.project !== key.project) throw new Error("lesson is outside the scope it is written to");
      const existing = s.versions.get(parsed.id)?.at(-1);
      if (parsed.version !== (existing?.version ?? 0) + 1) return { ok: false, reason: "conflict" };
      if (staged.some((x) => x.id === parsed.id)) throw new Error("one commit writes a lesson once");
      // The fence: nothing that names an erased person or a deleted record may be written back, whatever the writer read earlier.
      if (s.gone.get(parsed.id) === "purged") return { ok: false, reason: "erased" };
      const lesson = applyWriteFence(parsed, fence);
      if (lesson === "erased") return { ok: false, reason: "erased" };
      staged.push(lesson);
    }
    const members = new Map(s.members);
    for (const lesson of staged) {
      // The version item keeps the content as written. The head keeps the usage bookkeeping of the previous head: a counter changed while the writer
      // was deciding is never overwritten by what the writer read earlier.
      const versions = s.versions.get(lesson.id) ?? [];
      versions.push(clone(lesson));
      s.versions.set(lesson.id, versions);
      s.heads.set(lesson.id, withUsageOf(lesson, s.heads.get(lesson.id)));
      members.set(lesson.id, lesson.version);
    }
    s.members = members;
    const setVersion = expectedSetVersion + 1;
    s.sets.push({ setVersion, at, members: [...members.entries()].map(([id, version]) => ({ id, version })).sort((a, b) => a.id.localeCompare(b.id)) });
    return { ok: true, setVersion };
  }

  async rollback(key: ScopeKey, targetSetVersion: number, expectedSetVersion: number, at: number): Promise<CommitResult> {
    const s = this.of(key);
    if (s.sets.at(-1)!.setVersion !== expectedSetVersion) return { ok: false, reason: "conflict" };
    const target = s.sets.find((x) => x.setVersion === targetSetVersion);
    if (target === undefined || targetSetVersion >= expectedSetVersion) return { ok: false, reason: "conflict" };
    const plan = planRollback(target.members, {
      gone: (id) => s.gone.get(id), head: (id) => s.heads.get(id), content: (id, version) => s.versions.get(id)?.find((v) => v.version === version),
      openIntent: (id) => [...s.intents.values()].some((i) => !i.finished && i.lessonId === id), fence: this.fenceView(s),
    }, at);
    if (!plan.ok) return { ok: false, reason: "conflict" };
    for (const [id, restored] of plan.restoredHeads) s.heads.set(id, restored);
    const members = plan.members;
    const restoredIds = plan.restored;
    s.members = members;
    const setVersion = expectedSetVersion + 1;
    s.sets.push({ setVersion, at, members: [...members.entries()].map(([id, version]) => ({ id, version })).sort((a, b) => a.id.localeCompare(b.id)) });
    return { ok: true, setVersion, restored: restoredIds };
  }

  async mutate(key: ScopeKey, id: string, fn: (lesson: Lesson) => Partial<Pick<Lesson, (typeof VOLATILE_FIELDS)[number]>> | undefined): Promise<Lesson | undefined> {
    const s = this.of(key);
    const head = s.members.has(id) ? s.heads.get(id) : undefined;
    if (head === undefined) return undefined;
    const patch = fn(clone(head));
    if (patch !== undefined) {
      const next = LessonSchema.parse({ ...head, ...clone(patch) });
      s.heads.set(id, next);
    }
    return clone(s.heads.get(id)!);
  }

  async scrub(key: ScopeKey, id: string, fn: (lesson: Lesson) => Lesson): Promise<void> {
    const s = this.of(key);
    const head = s.heads.get(id);
    if (head !== undefined) s.heads.set(id, LessonSchema.parse(fn(clone(head))));
    s.versions.set(id, (s.versions.get(id) ?? []).map((v) => LessonSchema.parse({ ...fn(clone(v)), version: v.version })));
  }
  async markGone(key: ScopeKey, id: string, mode: "withdrawn" | "purged"): Promise<void> { this.of(key).gone.set(id, mode); }
  private textSecretOf(key: ScopeKey): Buffer { const s = this.of(key); return (s.textSecret ??= randomBytes(32)); }
  async textFingerprints(key: ScopeKey, place: string, hashes: readonly string[]): Promise<Map<string, string>> {
    const secret = this.textSecretOf(key);
    return new Map([...new Set(hashes)].map((hash) => [hash, createHmac("sha256", secret).update(`${place}\u0000${hash}`).digest("hex").slice(0, 32)] as const));
  }
  async markGoneFingerprint(key: ScopeKey, fingerprint: string): Promise<void> { this.of(key).goneTexts.add(fingerprint); }
  async goneFingerprintsOf(key: ScopeKey, fingerprints: readonly string[]): Promise<Set<string>> { const known = this.of(key).goneTexts; return new Set(fingerprints.filter((fp) => known.has(fp))); }
  async clearGoneFingerprint(key: ScopeKey, fingerprint: string): Promise<void> { this.of(key).goneTexts.delete(fingerprint); }
  async goneOf(key: ScopeKey, ids: readonly string[]): Promise<Map<string, "withdrawn" | "purged">> {
    const gone = this.of(key).gone;
    return new Map(ids.flatMap((id) => { const mode = gone.get(id); return mode === undefined ? [] : [[id, mode] as const]; }));
  }
  async purge(key: ScopeKey, id: string): Promise<void> {
    const s = this.of(key);
    s.heads.delete(id);
    s.versions.delete(id);
    s.members.delete(id);
    s.gone.set(id, "purged");
    for (const [name, manifest] of s.manifests) {
      if (manifest.lessons.some((e) => e.id === id)) s.manifests.set(name, { ...manifest, lessons: manifest.lessons.filter((e) => e.id !== id) });
    }
    for (const name of [...s.once]) if (name.includes(`:${id}`) || name.includes(`${id}:`)) s.once.delete(name);
    for (const [name, entry] of s.pending) if (entry.lessonId === id) s.pending.delete(name);
  }
  async forgetSource(key: ScopeKey, source: string): Promise<void> {
    const s = this.of(key);
    const wanted = normSource(source);
    s.sourceEvents = s.sourceEvents.filter((e) => normSource(e.source) !== wanted);
    // Every spelling of the key goes: a pause stored as `member:Mallory` is forgotten when `mallory` is erased.
    const paused = s.flags.pausedSources;
    if (paused !== undefined && Object.keys(paused).some((name) => normSource(name) === wanted)) {
      s.flags = { ...s.flags, pausedSources: Object.fromEntries(Object.entries(paused).filter(([name]) => normSource(name) !== wanted)) };
    }
  }
  async fence(key: ScopeKey, fence: { people?: readonly string[]; ids?: readonly string[]; sourceIds?: readonly string[] }): Promise<void> {
    const s = this.of(key);
    for (const id of fence.sourceIds ?? []) s.erasedSources.add(id);
    for (const p of fence.people ?? []) s.erased.add(normId(p));
    for (const id of fence.ids ?? []) s.deletedIds.add(id);
  }
  async isErased(key: ScopeKey, person: string): Promise<boolean> { return this.of(key).erased.has(normId(person)); }
  async markRef(key: ScopeKey, person: string): Promise<string | undefined> {
    const s = this.of(key), who = normId(person);
    if (s.erased.has(who)) return undefined;
    let ref = s.markRefs.get(who);
    if (ref === undefined) { ref = randomUUID().replaceAll("-", "").slice(0, 24);s.markRefs.set(who, ref); }
    return ref;
  }
  async forgetMarkRef(key: ScopeKey, person: string): Promise<void> { this.of(key).markRefs.delete(normId(person)); }
  async noteHarm(key: ScopeKey, ref: string, lessonId: string): Promise<void> {
    const s = this.of(key);
    (s.harms.get(ref) ?? s.harms.set(ref, new Set()).get(ref)!).add(lessonId);
  }
  async takeBackHarm(key: ScopeKey, person: string, apply: (lessonId: string, ref: string) => Promise<void>): Promise<string[]> {
    const s = this.of(key), ref = s.markRefs.get(normId(person));
    if (ref === undefined) return [];
    const ids = [...(s.harms.get(ref) ?? [])];
    for (const id of ids) { await apply(id, ref); s.harms.get(ref)?.delete(id); }
    return ids;
  }
  async putIntent(key: ScopeKey, intent: DeletionIntent): Promise<void> { this.of(key).intents.set(intent.id, clone(intent)); }
  async getIntent(key: ScopeKey, id: string): Promise<DeletionIntent | undefined> { const i = this.of(key).intents.get(id); return i === undefined ? undefined : clone(i); }
  async listIntents(key: ScopeKey, filter?: { finished?: boolean }): Promise<DeletionIntent[]> {
    return [...this.of(key).intents.values()].filter((i) => filter?.finished === undefined || i.finished === filter.finished).map(clone).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  }
  async putManifest(manifest: LoadManifest): Promise<boolean> {
    const s = this.of(manifest);
    const id = `${manifest.taskId}#${manifest.stage}#${manifest.round}`;
    if (s.manifests.has(id)) return false;
    s.manifests.set(id, clone(manifest));
    return true;
  }
  async manifests(key: ScopeKey, taskId: string): Promise<LoadManifest[]> {
    return [...this.of(key).manifests.values()].filter((m) => m.taskId === taskId).map(clone).sort((a, b) => a.at - b.at);
  }
  async updateManifest(manifest: LoadManifest): Promise<void> {
    const s = this.of(manifest);
    const id = `${manifest.taskId}#${manifest.stage}#${manifest.round}`;
    if (s.manifests.has(id)) s.manifests.set(id, clone(manifest));
  }
  /** For tests: the names of the idempotency keys written so far. */
  onceNames(key: ScopeKey): string[] { return [...this.of(key).once]; }
  async markOnce(key: ScopeKey, name: string): Promise<boolean> {
    const s = this.of(key);
    if (s.once.has(name)) return false;
    s.once.add(name);
    return true;
  }
  async seenOnce(key: ScopeKey, name: string): Promise<boolean> { return this.of(key).once.has(name); }
  async hasPending(key: ScopeKey, lessonId: string): Promise<boolean> { return [...this.of(key).pending.values()].some((p) => p.lessonId === lessonId); }
  async addPending(entry: PendingOutcome): Promise<void> { this.of(entry).pending.set(entry.key, clone(entry)); }
  async duePending(key: ScopeKey, now: number, limit: number): Promise<PendingOutcome[]> {
    return [...this.of(key).pending.values()].filter((p) => p.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt || a.key.localeCompare(b.key)).slice(0, limit).map(clone);
  }
  async removePending(key: ScopeKey, pendingKey: string): Promise<void> { this.of(key).pending.delete(pendingKey); }
  async flags(key: ScopeKey): Promise<ProjectFlags> { return clone(this.of(key).flags); }
  async setFlags(key: ScopeKey, flags: ProjectFlags): Promise<void> { this.of(key).flags = clone(flags); }
  async recordSourceEvent(key: ScopeKey, event: { at: number; source: string }): Promise<void> { this.of(key).sourceEvents.push({ at: event.at, source: normSource(event.source) }); }
  async sourceDays(key: ScopeKey, source: string, days: number, now: number): Promise<number[]> {
    const counts = new Array<number>(days).fill(0);
    const wanted = normSource(source);
    for (const e of this.of(key).sourceEvents) {
      if (normSource(e.source) !== wanted) continue;
      const age = Math.floor((now - e.at) / DAY);
      if (age >= 0 && age < days) counts[age]! += 1;
    }
    return counts;
  }
}

/** The next version of a lesson, for a commit: the head's version plus one. */
export const nextVersion = (head: Lesson | undefined, versions: readonly Lesson[]): number => Math.max(head?.version ?? 0, versions.at(-1)?.version ?? 0) + 1;
