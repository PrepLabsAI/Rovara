// What happens to lessons when the record rows they came from are deleted at the source, or when a person is erased. This is the
// learning lane's side of the record core's lesson-deletion port (the deletion port), over the lesson store. The shape matches that port (with an
// optional cause and erased-person argument added at the end) without importing it, so the lanes stay independent until they are merged.
//
// Ordinary source deletion (cause "sources_deleted"):
//   - `forgetSources` removes the deleted ids from `provenance.sourceEvents` and the record citations of the head AND of every old version, so a rollback can
//     never bring a deleted id back. A lesson with some sources left stays as it is.
//   - A lesson whose sources are ALL gone is withdrawn, unless a valid code citation alone supports it. Then it is kept, but sent back to a person
//     (`reviewRequired`; a lesson that was only auto-applied goes back to pending), because the corroboration it was applied on is gone.
//   - `withdraw` sets status `withdrawn`, strips every record source from every version, removes the vector, and tombstones the lesson so a rollback never
//     restores it. It is audited.
// Person erasure (cause "person_erased"; privacy wins over reproducibility, as for snapshots in): every lesson the person wrote, or that rests ONLY on
// their rows, is hard-deleted whatever its code citations say (head, all versions, vector, load-manifest references). Lessons others also support lose the
// person's id and rows from every version and are kept.
import { reverseHarm } from "./counters.js";
import { emitAudit } from "./policy.js";
import type { LessonAuditSink, LessonVectors } from "./ports.js";
import { pendingExpiry } from "./expiry.js";
import { randomUUID } from "node:crypto";
import { nextVersion, type DeletionIntent, type LessonStore, type ScopeKey } from "./store.js";
import { ERASED_MARK, idIn, peopleOf, recordIdsOf, sameId, type Lesson, type LessonCitation } from "./types.js";
import { scrubLesson, stripAudienceIds } from "./scrub.js";
import { notifyLessonGone } from "./repo-file-hook.js";
export { ERASED_MARK, scrubLesson };

export type DeletionCause = "sources_deleted" | "source_deleted" | "person_erased";
export interface ErasedPerson { developerId: string }
export interface LessonForDeletion {
  id: string; version: number; status: string; citations: readonly LessonCitation[]; provenance: { sourceEvents: readonly string[] };
  counters: { citationStale: number }; lastValidatedAt?: string | undefined;
}
export interface LessonDeletionPort {
  affected(orgId: string, project: string, deleted: ReadonlySet<string>, erased?: ErasedPerson): Promise<LessonForDeletion[]>;
  withdraw(orgId: string, project: string, lessonId: string, cause: string): Promise<void>;
  forgetSources(orgId: string, project: string, lessonId: string, deleted: ReadonlySet<string>, cause?: DeletionCause, erased?: ErasedPerson): Promise<void>;
  /** Finishes every deletion that was started and not finished (a retry, or a sweeper): the original intent is resumed, never switched. Returns how many it finished. */
  resumePending(orgId: string, project: string): Promise<number>;
  /**
   * the same, for a sweeper. EVERY unfinished intent is tried (one that fails never stops the ones after it); nothing is thrown, the counts are returned. `resumePending` tries them all too, and then
   * throws the first failure, because an erase must not report done while an intent is not.
   */
  resumeAll(orgId: string, project: string): Promise<{ finished: number; failed: number }>;
  /** The whole erasure of one person in one project: purge what they wrote or alone support, scrub them from the rest. Returns what was purged and scrubbed. */
  erasePerson(orgId: string, project: string, erased: ErasedPerson, deleted: ReadonlySet<string>): Promise<{ purged: string[]; scrubbed: string[] }>;
  /** Removes an erased person's source ids from the audience snapshot of every version of every lesson of the project (the id must not outlive the erase anywhere). */
  scrubAudienceIds(orgId: string, project: string, ids: readonly string[]): Promise<void>;
}

const DONE: ReadonlySet<string> = new Set(["withdrawn", "retired", "rejected"]);
const MAX_TRIES = 3;

const recordIds = recordIdsOf;
const mentions = (l: Lesson, dev: string): boolean => idIn(peopleOf(l), dev);

/** A lesson with everything ever stored for it: the head and every version. Deletion and erasure judge the whole history, never only the current version. */
export interface LessonHistory { head: Lesson; all: Lesson[]; inSet: boolean }

/** A valid code citation alone supports the lesson: it has one, was validated against code, no check found it stale, and it is live. */
export function supportedByCode(lesson: Pick<Lesson, "citations" | "lastValidatedAt" | "counters" | "status">): boolean {
  return lesson.citations.some((c) => c.kind === "code") && lesson.lastValidatedAt !== undefined && lesson.counters.citationStale === 0 && lesson.status === "active";
}


export interface DeletionDeps { store: LessonStore; vectors: LessonVectors; audit: LessonAuditSink; now: () => number; newId?: () => string }

export function lessonDeletionPort(deps: DeletionDeps): LessonDeletionPort {
  const key = (orgId: string, project: string): ScopeKey => ({ workspaceId: orgId, project });
  const everyVersion = (k: ScopeKey, id: string, fn: (l: Lesson) => Lesson) => deps.store.scrub(k, id, fn);
  const stripAllRecords = (l: Lesson): Lesson => scrubLesson(l, new Set(recordIds(l)));

  /** The one walk over history: every stored head of the project, with all its versions, whether or not a rollback dropped it from the current set. */
  async function histories(k: ScopeKey): Promise<LessonHistory[]> {
    const out: LessonHistory[] = [];
    for (const head of await deps.store.listAllHeads(k)) out.push({ head, all: [head, ...(await deps.store.versions(k, head.id))], inSet: (await deps.store.get(k, head.id)) !== undefined });
    return out;
  }
  async function historyOf(k: ScopeKey, id: string): Promise<LessonHistory | undefined> {
    const head = await deps.store.getHead(k, id);
    return head === undefined ? undefined : { head, all: [head, ...(await deps.store.versions(k, id))], inSet: (await deps.store.get(k, id)) !== undefined };
  }
  const namesDeleted = (h: LessonHistory, deleted: ReadonlySet<string>) => h.all.some((l) => recordIds(l).some((id) => deleted.has(id)));
  /** Whether the erased person is what the lesson rests on: they wrote any version, every source it ever had is gone, or they are the only person it ever names. */
  function restsOnPerson(h: LessonHistory, deleted: ReadonlySet<string>, dev: string | undefined): boolean {
    const everSources = new Set(h.all.flatMap((l) => l.provenance.sourceEvents));
    const allGone = everSources.size > 0 && [...everSources].every((id) => deleted.has(id));
    if (dev === undefined) return allGone;
    const people = new Set(h.all.flatMap(peopleOf));
    // A writer of the evidence, of the text (an editor), or of any words the model read for it (readFrom): either way the lesson came from them and is hard-deleted.
    const wrote = h.all.some((l) => idIn(l.provenance.authors, dev) || idIn(l.provenance.editors ?? [], dev) || idIn(l.provenance.readFrom ?? [], dev));
    return wrote || allGone || (people.size > 0 && [...people].every((p) => sameId(p, dev)));
  }

  // ---- the durable intent: written first, then idempotent steps, finished only when every step is done ----
  const STEPS: Record<DeletionIntent["outcome"], (inSet: boolean) => string[]> = {
    scrub: (inSet) => (inSet ? ["commit", "versions"] : ["versions"]),
    downgrade: (inSet) => (inSet ? ["commit", "versions"] : ["versions"]),
    withdraw: (inSet) => (inSet ? ["commit", "versions", "tombstone", "vector"] : ["versions", "tombstone", "vector"]),
    purge: () => ["vector", "rows"],
  };
  /** The one rewrite of a lesson for an intent. Pure and idempotent, so the head commit and the in-place rewrite of every version agree. */
  function rewrite(intent: DeletionIntent, l: Lesson): Lesson {
    const deleted = new Set(intent.deleted);
    if (intent.outcome === "withdraw") return { ...stripAllRecords(l), status: "withdrawn" };
    const scrubbed = scrubLesson(l, deleted, intent.erased);
    return intent.outcome === "downgrade" ? backToPerson(scrubbed, deps.now()) : scrubbed;
  }
  async function perform(k: ScopeKey, intent: DeletionIntent, step: string): Promise<void> {
    const { workspaceId: orgId, project } = k;
    if (step === "vector") { await deps.vectors.remove(orgId, project, intent.lessonId); return; }
    if (step === "rows") { await deps.store.purge(k, intent.lessonId); return; }
    if (step === "tombstone") { await deps.store.markGone(k, intent.lessonId, "withdrawn"); return; }
    if (step === "versions") { await everyVersion(k, intent.lessonId, (l) => rewrite(intent, l)); return; }
    // "commit": one conditional write that carries the scrub AND the decision (status, review mark) together.
    for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
      const fresh = await deps.store.get(k, intent.lessonId);
      if (fresh === undefined) return;
      const next = rewrite(intent, fresh);
      if (JSON.stringify(next) === JSON.stringify(fresh)) return;
      const setVersion = await deps.store.setVersion(k);
      if ((await deps.store.commit(k, setVersion, [{ ...next, version: nextVersion(fresh, await deps.store.versions(k, intent.lessonId)), updatedAt: deps.now() }], deps.now())).ok) return;
    }
    throw new Error("deletion step not committed");
  }
  async function execute(k: ScopeKey, intent: DeletionIntent): Promise<void> {
    for (const step of STEPS[intent.outcome](intent.inSet)) {
      if (intent.done.includes(step)) continue;
      await perform(k, intent, step);
      intent.done.push(step);
      await deps.store.putIntent(k, intent);
    }
    intent.finished = true;
    await deps.store.putIntent(k, intent);
    // A lesson that is only an add in Rovara's open lessons pull request comes out of it at once.
    if (intent.outcome === "withdraw" || intent.outcome === "purge") await notifyLessonGone(k, intent.lessonId);
    if (intent.outcome === "withdraw" || intent.outcome === "purge") {
      await emitAudit(deps.audit, { action: "lesson.withdrawn", workspaceId: k.workspaceId, project: k.project, lessonId: intent.lessonId, facts: { cause: intent.cause, ...(intent.outcome === "purge" ? { purged: true } : {}) } });
    }
  }
  /** Starts an intent: the fence first (so a stale writer cannot put anything back), then the record, then the steps. */
  async function start(k: ScopeKey, partial: Omit<DeletionIntent, "id" | "done" | "finished" | "at">): Promise<void> {
    // A deletion that was started and not finished is finished first, as it was decided.
    for (const open of await deps.store.listIntents(k, { finished: false })) if (open.lessonId === partial.lessonId) await execute(k, open);
    await deps.store.fence(k, { ...(partial.erased === undefined ? {} : { people: [partial.erased] }), ids: partial.deleted });
    const intent: DeletionIntent = { ...partial, id: (deps.newId ?? randomUUID)(), done: [], finished: false, at: deps.now() };
    await deps.store.putIntent(k, intent);
    await execute(k, intent);
  }

  async function purge(orgId: string, project: string, lessonId: string, cause: string, erased?: string, deleted: readonly string[] = []): Promise<void> {
    const k = key(orgId, project);
    await start(k, { lessonId, kind: "purge", cause, deleted: [...deleted], ...(erased === undefined ? {} : { erased }), outcome: "purge", inSet: false });
  }

  async function withdraw(orgId: string, project: string, lessonId: string, cause: string): Promise<void> {
    if (cause === "person_erased") return purge(orgId, project, lessonId, cause);
    const k = key(orgId, project);
    const h = await historyOf(k, lessonId);
    if (h === undefined) return;
    if (h.head.status === "withdrawn" && !h.all.some((l) => recordIds(l).length > 0)) {
      // Already withdrawn and clean: only the idempotent cleanup, with no new intent and no second audit record.
      await deps.store.markGone(k, lessonId, "withdrawn");
      await deps.vectors.remove(orgId, project, lessonId);
      return;
    }
    await start(k, { lessonId, kind: "withdraw", cause, deleted: [...new Set(h.all.flatMap(recordIds))], outcome: "withdraw", inSet: h.inSet });
  }

  async function forgetSources(orgId: string, project: string, lessonId: string, deleted: ReadonlySet<string>, cause: DeletionCause = "sources_deleted", erased?: ErasedPerson): Promise<void> {
    const k = key(orgId, project);
    // Finish anything left half-done for this lesson, as it was decided, before looking at it again.
    for (const open of await deps.store.listIntents(k, { finished: false })) if (open.lessonId === lessonId) await execute(k, open);
    const h = await historyOf(k, lessonId);
    if (h === undefined) return;
    const dev = erased?.developerId;
    if (cause === "person_erased") {
      if (!namesDeleted(h, deleted) && (dev === undefined || !h.all.some((l) => mentions(l, dev)))) return;
      if (restsOnPerson(h, deleted, dev)) return purge(orgId, project, lessonId, cause, dev, [...deleted]);
      await start(k, { lessonId, kind: "forget", cause, deleted: [...deleted], ...(dev === undefined ? {} : { erased: dev }), outcome: "scrub", inSet: h.inSet });
      return;
    }
    if (!namesDeleted(h, deleted)) return;
    // The decision is made ONCE, here, before any write, and is stored with the intent: a retry never decides again from a half-written lesson.
    const lesson = h.head;
    let outcome: DeletionIntent["outcome"] = "scrub";
    if (!DONE.has(lesson.status)) {
      const hadSources = h.all.some((l) => l.provenance.sourceEvents.length > 0);
      const empty = hadSources && scrubLesson(lesson, deleted).provenance.sourceEvents.length === 0;
      if (empty) outcome = supportedByCode(lesson) ? "downgrade" : "withdraw";
    }
    await start(k, { lessonId, kind: "forget", cause, deleted: [...deleted], outcome, inSet: h.inSet });
  }

  /** Tries every unfinished intent of the scope, in order; a failure is counted and the first one kept (the intent's own error). */
  async function resumeScope(orgId: string, project: string): Promise<{ finished: number; failed: number; firstFailure: unknown }> {
    const k = key(orgId, project);
    let finished = 0, failed = 0, firstFailure: unknown;
    for (const intent of await deps.store.listIntents(k, { finished: false })) {
      try { await execute(k, intent); finished += 1; } catch (error) { if (failed === 0) firstFailure = error; failed += 1; }
    }
    return { finished, failed, firstFailure };
  }

  return {
    async affected(orgId, project, deleted, erased) {
      const out: LessonForDeletion[] = [];
      for (const h of await histories(key(orgId, project))) {
        if (!namesDeleted(h, deleted) && !(erased !== undefined && h.all.some((l) => mentions(l, erased.developerId)))) continue;
        const l = h.head;
        out.push({
          id: l.id, version: l.version, status: l.status, citations: l.citations, provenance: { sourceEvents: l.provenance.sourceEvents }, counters: { citationStale: l.counters.citationStale },
          ...(l.lastValidatedAt === undefined ? {} : { lastValidatedAt: new Date(l.lastValidatedAt).toISOString() }),
        });
      }
      return out;
    },
    withdraw,
    forgetSources,
    async scrubAudienceIds(orgId, project, ids) {
      const k = key(orgId, project);
      const gone = new Set(ids);
      // The ids are fenced FIRST: from now on no commit (a stale reader's, a rollback's) can carry them back into a snapshot.
      await deps.store.fence(k, { sourceIds: ids });
      for (const h of await histories(k)) await everyVersion(k, h.head.id, (l) => stripAudienceIds(l, gone));
    },
    async resumeAll(orgId, project) {
      const { finished, failed } = await resumeScope(orgId, project);
      return { finished, failed };
    },
    async resumePending(orgId, project) {
      const { finished, failed, firstFailure } = await resumeScope(orgId, project);
      if (failed > 0) throw firstFailure;
      return finished;
    },
    async erasePerson(orgId, project, erased, deleted) {
      const k = key(orgId, project);
      // The fence goes up first: from now on no write that names this person or these rows can be committed, however stale its read.
      await deps.store.fence(k, { people: [erased.developerId], ids: [...deleted] });
      await this.resumePending(orgId, project);
      const purged: string[] = [];
      const scrubbed: string[] = [];
      for (const h of await histories(k)) {
        const touches = namesDeleted(h, deleted) || h.all.some((l) => mentions(l, erased.developerId));
        if (!touches) continue;
        if (restsOnPerson(h, deleted, erased.developerId)) { await purge(orgId, project, h.head.id, "person_erased", erased.developerId, [...deleted]); purged.push(h.head.id); continue; }
        await start(k, { lessonId: h.head.id, kind: "forget", cause: "person_erased", deleted: [...deleted], erased: erased.developerId, outcome: "scrub", inSet: h.inSet });
        scrubbed.push(h.head.id);
      }
      await deps.store.forgetSource(k, `member:${erased.developerId}`);
      // The harmful marks that this person's own corrections (a pull request comment, a note, a send-back) caused are taken back: a correction whose author is erased is no longer evidence against a lesson.
      await deps.store.takeBackHarm(k, erased.developerId, async (lessonId, ref) => {
        // The decrement is made once per (person, lesson) however often the erasure is retried: a crash between this and the row's deletion cannot take a second mark off. (A crash between the key and the decrement leaves
        // the lesson one mark higher than it should be: the safe side.) What the lesson was made into is read from its state, so it is checked every time.
        if (await deps.store.markOnce(k, `harm-undone:${ref}:${lessonId}`)) await deps.store.mutate(k, lessonId, (l) => ({ counters: { ...l.counters, harmful: Math.max(0, l.counters.harmful - 1) } }));
        await reverseHarm({ store: deps.store, audit: deps.audit, now: deps.now }, k, lessonId);
      });
      // The link from the person to the reference their Helpful / Wrong here marks were made with: those marks stay as counts and name nobody.
      await deps.store.forgetMarkRef(k, erased.developerId);
      return { purged, scrubbed };
    },
  };
}

/** A code-supported lesson whose record sources are gone: it needs a person again. A lesson that was only auto-applied goes back to pending with its approval cleared. */
function backToPerson(l: Lesson, now: number): Lesson {
  const personApproved = l.approvals.some((a) => a.mode !== "auto" && a.mode !== "trial");
  const back: Lesson = { ...l, reviewRequired: true, ...(personApproved || l.status !== "active" ? {} : { status: "pending" as const, approvals: [], pendingExpiresAt: pendingExpiry(now) }) };
  // The trial approval is gone, so the trial record goes with it: a lesson a person approves next is not "on trial" (one thumbs-down would retire it, and it could become publishable).
  if (back.status === "pending" || personApproved) delete (back as { trial?: Lesson["trial"] }).trial;
  return back;
}
