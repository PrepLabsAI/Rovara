// The rules of the lesson store that do not depend on where the lessons are kept. Every store (`InMemoryLessonStore`, the document store's and a host's own) calls these,
// so the fence, the usage bookkeeping and the rollback rules cannot drift apart. Pure: data in, data out.
import { LESSON_APPROVAL_TTL_DAYS } from "@agentx/contracts";
import { scrubLesson, stripAudienceIds } from "./scrub.js";
import { LessonSchema, normId, peopleOf, recordIdsOf, type Lesson } from "./types.js";

const DAY = 86_400_000;
/** Statuses a write may carry under the fence: each one takes the lesson out of use (never into it). */
export const NARROWING_STATUSES: ReadonlySet<Lesson["status"]> = new Set(["retired", "rejected", "withdrawn", "expired", "stale"]);
/** Bookkeeping about use: carried from the head into every new version, so a commit never rewinds a counter. */
export const USAGE_FIELDS = ["counters", "staleAt", "lastValidatedAt", "lastHelpfulAt"] as const;

/** What the fence says, asked only about what a lesson names. A durable store answers from the fence items it read; the in-memory store from its sets. */
export interface FenceView {
  /** Whether the person (any spelling) is erased. */
  personErased(person: string): boolean;
  /** Whether the record row or fact id is deleted. */
  idDeleted(id: string): boolean;
  /** Whether the source id (a Slack or GitHub user id) belongs to an erased person. */
  sourceErased(id: string): boolean;
}

/**
 * A lesson as the fence lets it be written: an erased person's source ids never ride in the audience snapshot (they are taken out, the lesson stays); a lesson that names an erased
 * person or a deleted record is refused ("erased"), unless the write only NARROWS it (retire, reject, withdraw: the kill switches; expire and stale: a lesson leaving use), which is
 * never refused, and what it carries from a stale read is scrubbed against the fence.
 */
export function applyWriteFence(raw: Lesson, fence: FenceView): Lesson | "erased" {
  let lesson = raw;
  const principals = lesson.provenance.audience.kind === "restricted" ? lesson.provenance.audience.acl.principals ?? [] : [];
  const erasedSources = new Set(principals.filter((id) => fence.sourceErased(id)));
  if (erasedSources.size > 0) lesson = stripAudienceIds(lesson, erasedSources);
  const people = new Set(peopleOf(lesson).filter((p) => fence.personErased(p)).map(normId));
  const deleted = new Set(recordIdsOf(lesson).filter((id) => fence.idDeleted(id)));
  if (people.size === 0 && deleted.size === 0) return lesson;
  if (!NARROWING_STATUSES.has(lesson.status)) return "erased";
  return LessonSchema.parse(scrubLesson(lesson, deleted, people));
}

/** The lesson with the usage bookkeeping of the previous head (a counter changed while the writer was deciding is never overwritten by what the writer read earlier). */
export function withUsageOf(lesson: Lesson, previous: Lesson | undefined): Lesson {
  if (previous === undefined) return structuredClone(lesson);
  const head = structuredClone(lesson);
  for (const field of USAGE_FIELDS) (head as Record<string, unknown>)[field] = structuredClone((previous as Record<string, unknown>)[field]);
  return head;
}

/** What a rollback reads of the store, asked only about the lessons of the target set. */
export interface RollbackView {
  gone(id: string): "withdrawn" | "purged" | undefined;
  head(id: string): Lesson | undefined;
  /** The content of a stored version, or undefined when it is not stored. */
  content(id: string, version: number): Lesson | undefined;
  /** Whether a deletion of the lesson is still open. */
  openIntent(id: string): boolean;
  fence: FenceView;
}
export type RollbackPlan = { ok: false } | { ok: true; members: Map<string, number>; restoredHeads: Map<string, Lesson>; restored: string[] };

/**
 * The lessons a rollback to `target` brings back, and what each one comes back as. A withdrawn lesson stays withdrawn and a purged one stays gone; a retired or rejected one stays so;
 * content that names an erased person or a deleted row is not brought back, and a lesson with a deletion still open is left alone. A restored lesson always comes back pending and needing
 * a person (automatic approval is dropped, a tier only rises, counters and expiry are not rewound). `ok: false`: a stored version is missing, so nothing is changed.
 */
export function planRollback(target: ReadonlyArray<{ id: string; version: number }>, view: RollbackView, at: number): RollbackPlan {
  const members = new Map<string, number>();
  const restoredHeads = new Map<string, Lesson>();
  const restoredIds: string[] = [];
  for (const m of target) {
    const fate = view.gone(m.id);
    if (fate === "purged") continue;
    const head = view.head(m.id);
    if (fate === "withdrawn") { if (head !== undefined) members.set(m.id, head.version); continue; }
    if (head !== undefined && (head.status === "retired" || head.status === "rejected")) { members.set(m.id, head.version); continue; }
    const content = view.content(m.id, m.version);
    if (content === undefined) return { ok: false };
    const fenced = peopleOf(content).some((p) => view.fence.personErased(p)) || recordIdsOf(content).some((id) => view.fence.idDeleted(id));
    if (head !== undefined && (view.openIntent(m.id) || fenced)) { members.set(m.id, head.version); continue; }
    const principals = content.provenance.audience.kind === "restricted" ? content.provenance.audience.acl.principals ?? [] : [];
    const erasedSources = new Set(principals.filter((id) => view.fence.sourceErased(id)));
    const restored = erasedSources.size > 0 ? stripAudienceIds(structuredClone(content), erasedSources) : structuredClone(content);
    // Counters and expiry are bookkeeping about use, not content: a rollback does not rewind them.
    if (head !== undefined) for (const field of [...USAGE_FIELDS, "expiresAt"]) (restored as Record<string, unknown>)[field] = structuredClone((head as Record<string, unknown>)[field]);
    // A rollback never restores approval. Automatic approval is dropped and the lesson comes back needing a person; without a person's approval it is pending, so it is not loaded until
    // the normal tier check and approval have run again. A tier can only rise: the restored tier is the higher of the old version's and the head's, with the reasons of both, and a
    // contradiction stays flagged.
    if (head !== undefined) {
      restored.tier = Math.max(restored.tier, head.tier) as Lesson["tier"];
      restored.tierReasons = [...new Set([...restored.tierReasons, ...head.tierReasons])].slice(0, 12);
      if (head.contradictsWith !== undefined) restored.contradictsWith = head.contradictsWith;
      if (head.possibleDuplicateOf !== undefined) restored.possibleDuplicateOf = head.possibleDuplicateOf;
      if (head.repoTwins !== undefined) restored.repoTwins = head.repoTwins;
      // Approval given for a lower tier does not carry to a higher one.
      if (restored.tier > content.tier) restored.approvals = [];
    }
    restored.approvals = restored.approvals.filter((a) => a.mode !== "auto" && a.mode !== "trial");
    // A restored lesson is no longer on trial: it comes back for a person (the trial record and its approval went with the live version).
    delete (restored as { trial?: unknown }).trial;
    restored.reviewRequired = true;
    // It always comes back pending. A person's earlier approval is kept as a record, but it counts only after it is re-checked against who may approve NOW and the current policy
    // (rollbackLessonSet does that); until then nothing is live.
    if (restored.status === "active" || restored.status === "stale") { restored.status = "pending"; restored.pendingExpiresAt = at + LESSON_APPROVAL_TTL_DAYS * DAY; }
    restoredHeads.set(m.id, restored);
    members.set(m.id, m.version);
    restoredIds.push(m.id);
  }
  return { ok: true, members, restoredHeads, restored: restoredIds };
}
