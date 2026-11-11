// What Rovara remembers about ONE repository's `.rovara/lessons.md`, and the store that keeps it.
//
// One small item per project and repository. It holds ids, fingerprints, counts, branch names and times: never a lesson's text, a person or a host's words.
//   - `rendered`: for each lesson id Rovara proposed and a person merged, the fingerprint of the text and section Rovara put in the file. It is how a hand edit is told from Rovara's own text (a block that no longer matches is
//     the team's: Rovara leaves it as written and holds that lesson's edits, until read-back takes the team's text in).
//   - `declined`: ids the team removed from the file. Never proposed back.
//   - `open`: the one open Rovara pull request (its branch, number, head, what it proposes), `pending`: a branch Rovara decided on and may have made but has not recorded a pull request for, `closing`: pull requests
//     and branches Rovara still has to close and delete.
//   - `unmerged`: weekly pull requests in a row nobody merged (3 pauses additions and edits).
//   - `lease`: the per-repository lease, so two passes never run at once.
// Every write is conditional on the revision that was read (`put`), so a lost race is a plain "someone else wrote" and never an overwrite.
import { z } from "zod";
import { LESSON_FILE_PROBLEMS, LESSON_FILE_UNMERGED_LIMIT, type LessonFileProblem } from "@agentx/contracts";
import type { ScopeKey } from "./store.js";

export const MAX_RENDERED = 400;
export const MAX_DECLINED = 400;
/** The most lesson ids one pull request can carry (adds and edits; at most the file's 300 lessons plus the ones it adds). */
export const MAX_CARRIED = 700;
/** Pull requests handed over, and closings waiting. These are bookkeeping, not erasure: an erasure close is its own durable row. Over the cap the state FAILS LOUDLY (`StateFull`), it never drops an entry. */
export const MAX_THEIRS = 20;
const Id = z.string().regex(/^[A-Za-z0-9_-]{4,64}$/u);
const Branch = z.string().regex(/^rovara\/lessons-[0-9a-f]{12}$/u);

/** Why a line the team wrote in the file was not taken in as a lesson (or an edit of one): fixed codes. `names_a_person` is the check every lesson text passes before it goes in a repository's file. */
export const READ_BACK_REFUSALS = ["names_a_person", "capability_request", "empty", "not_allowed", "gone_text"] as const;
export type ReadBackRefusal = (typeof READ_BACK_REFUSALS)[number];
/** How long a bulk disappearance from the file is held before a person is asked to confirm retiring the missing lessons (by the clock, from the first time it was seen). */
export const READ_BACK_HOLD_MS = 7 * 86_400_000;
/** The most refused lines kept on one repository's record. */
export const MAX_REFUSED = 100;

export const OpenPrSchema = z.object({
  branch: Branch, number: z.string().min(1).max(40), url: z.string().max(2_048),
  /** The branch head Rovara left it at: a different head later means a person pushed to it, and it is theirs. */
  headRevision: z.string().min(7).max(64),
  baseRevision: z.string().min(7).max(64),
  digest: z.string().max(64), openedAt: z.number(),
  removals: z.number().int().min(0), edits: z.number().int().min(0), adds: z.number().int().min(0),
  /** What a merge of this pull request puts in the file: id to fingerprint for adds and edits, and the ids removed. */
  added: z.record(Id, z.string().max(40)), edited: z.record(Id, z.string().max(40)), removed: z.array(Id).max(MAX_RENDERED),
  pointer: z.boolean(),
}).strict();
export type OpenPr = z.infer<typeof OpenPrSchema>;

/**
 * A pull request or branch Rovara still has to close or delete (NOT for an erasure: those are `EraseClose` rows, one per pull request, never in this list). `headRevision` is the head Rovara left the branch at: the pull request is
 * closed and the branch deleted only while the branch is STILL there, read again right before the delete; a head that moved is a person's, and the pull request is then tracked in `theirs`; a head that cannot be read is not known to
 * be Rovara's, so nothing is touched (retried `attempts` times, then handed over, never dropped).
 */
export const ClosingSchema = z.object({
  branch: Branch, number: z.string().min(1).max(40).optional(), cause: z.enum(["replaced", "nothing_left", "switched_off", "merged", "closed_by_team", "lessons_off"]),
  headRevision: z.string().min(7).max(64).optional(), attempts: z.number().int().min(0).max(10).optional(),
  /** The lessons the pull request carried (adds and edits): kept when the entry cannot be finished because a person pushed, so a later erasure still finds the pull request. */
  ids: z.array(Id).max(MAX_CARRIED).optional(),
  /** The pull request is already closed; only the branch is left. */
  closed: z.boolean().optional(),
}).strict();
export type Closing = z.infer<typeof ClosingSchema>;

/**
 * One durable row per Rovara-made pull request (and one `watch` row per repository Rovara has written to), kept in its own items APART from the repository's publish state. The erasure sweep (`repo-file-erase.ts`) works from
 * these rows alone: it never reads the state, so no bookkeeping fault can reach it. A row holds the lesson ids the pull request carries (adds and edits; for a removal pull request, the ids it removes), the branch and the head Rovara
 * left it at (the branch is deleted only while it is still there: closing a pull request touches no commit, deleting a branch can), and `closedAt` once the sweep closed it. Ids and numbers only: no text, no person.
 */
export const PrRowSchema = z.object({
  place: z.string().min(3).max(300), kind: z.enum(["adds", "removal", "watch", "lease"]), number: z.string().min(1).max(40), branch: Branch.optional(), headRevision: z.string().min(7).max(64).optional(),
  ids: z.array(Id).max(MAX_CARRIED), at: z.number(), closedAt: z.number().optional(),
  /**
   * A WATCH row remembers who the repository is as of when it was written (the project's name for it and its address; the host kind is the place's prefix), so the sweep can still reach a repository that has since left the project,
   * moved host or been given a new id, for as long as the installation allows. The same row says when the repository could not be reached (once, and how many deleted lessons were waiting), when the sweep last tried, and how many
   * Rovara branches it could not match to a pull request.
   */
  repoUrl: z.string().min(1).max(500).optional(), repoName: z.string().min(1).max(200).optional(),
  unreachableAt: z.number().optional(), unreachableLessons: z.number().int().min(0).optional(), triedAt: z.number().optional(), strayBranches: z.number().int().min(0).optional(),
  /** How many open Rovara pull requests the last sweep did NOT close because the host could not show them or did not say Rovara made them. */
  unconfirmedCloses: z.number().int().min(0).optional(),
  /**
   * A WATCH row remembers the fingerprints (`LessonStore.textFingerprints`; no text) of the marked copies of erased texts the last successful sweep found in the repository's file. A mark is released only when a later successful
   * sweep of the same repository finds no copy left, however the repository stands with the project (a repository that left it keeps its marks, so its stripped copies still come out).
   */
  marks: z.array(z.string().regex(/^[0-9a-f]{32}$/u)).max(1_500).optional(),
  /** A removal pull request: the fingerprint of the default branch's file it was made from. A different file now means it is out of date (closed and made again). */
  fileHash: z.string().max(40).optional(),
}).strict();
export type PrRow = z.infer<typeof PrRowSchema>;
/**
 * WRITE AHEAD. A row keyed by the BRANCH name is written before anything is written to the host (the number is not known yet: `~` and the branch's 12 hex digits stand in for it); the numbered row replaces it once the pull request
 * exists. A crash or a failed write between any two steps therefore leaves a row the erasure sweep can find (it looks the pull request up by branch on the host), and a failed row write means no host write was made.
 */
export const provisionalNumber = (branch: string): string => `~${branch.slice(-12)}`;
export const isProvisional = (row: Pick<PrRow, "number">): boolean => row.number.startsWith("~");
/** The rows of the erasure sweep. Separate from `RepoFileStore`'s state methods on purpose: the sweep is handed only this. */
export interface PrRowStore {
  /** Every row of the project that parses, and how many did not (one bad row never hides the others). Throws only when the table cannot be read at all. */
  listPrs(key: ScopeKey): Promise<{ rows: PrRow[]; unreadable: number }>;
  /** Records (or re-records) one row. Idempotent. Throws when it cannot write: the caller does not go on as if it had. */
  putPr(key: ScopeKey, row: PrRow): Promise<void>;
  delPr(key: ScopeKey, place: string, number: string): Promise<void>;
  /** Writes the row only if no row with that place and number exists (a lease: one sweep at a time makes a removal pull request). Says since when the other one has held it. Never listed by `listPrs`. */
  claimPr(key: ScopeKey, row: PrRow): Promise<{ claimed: true } | { claimed: false; heldSince: number }>;
}

export const RepoFileStateSchema = z.object({
  place: z.string().min(3).max(300),
  /** The project's name for the repository. */
  name: z.string().min(1).max(200),
  enabled: z.boolean(),
  /** The agent files the person ticked for the pointer; absent: the ones Rovara finds. */
  pointers: z.array(z.enum(["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"])).max(3).optional(),
  pointerProposed: z.boolean(), pointerDeclined: z.boolean(),
  /** The file has been seen on the default branch (or one of Rovara's pull requests merged): a missing file after that is a deletion by the team. */
  fileSeen: z.boolean(),
  /** The team deleted the file: nothing is proposed until someone resumes. */
  fileDeleted: z.boolean(),
  rendered: z.record(Id, z.string().max(40)),
  declined: z.array(Id).max(MAX_DECLINED),
  held: z.array(Id).max(MAX_RENDERED),
  unmerged: z.number().int().min(0),
  /** Closings the last pass did NOT make because the pull request could not be read or confirmed as Rovara's (they wait; shown on the status). */
  closesHeld: z.number().int().min(0).optional(),
  lastPassAt: z.number().optional(),
  open: OpenPrSchema.optional(),
  /** A branch Rovara decided on before it wrote, with the heads Rovara put on it (the base it was made at, and its own commit once written): it is deleted only while it is at one of them. */
  pending: z.object({ branch: Branch, at: z.number(), baseRevision: z.string().min(7).max(64).optional(), headRevision: z.string().min(7).max(64).optional(), attempts: z.number().int().min(0).max(10).optional() }).strict().optional(),
  /** Rovara pull requests a person pushed to (GitHub's "Update branch" counts): they are the team's now and are never touched again, except to be closed by an erasure. While one is open only removals are proposed. */
  theirs: z.array(z.object({ branch: Branch, number: z.string().min(1).max(40), url: z.string().max(2_048), ids: z.array(Id).max(MAX_CARRIED) }).strict()).max(MAX_THEIRS).default([]),
  closing: z.array(ClosingSchema).max(MAX_THEIRS),
  problem: z.enum(LESSON_FILE_PROBLEMS).optional(),
  /** A pointer was proposed and a later pass found no agent file that names the lessons file. */
  pointerMissing: z.boolean(),
  lease: z.object({ holder: z.string().min(1).max(100), until: z.number() }).strict().optional(),
  /**
   * Read-back: what the last pass took in from the team's own edits of the file, as counts (no text, no person): lessons whose wording became the team's, lessons the team removed, new lessons the team wrote. Shown in the
   * status ("file changed on main, read back as N corrections / M retired"). Replaced by the next pass that reads something back.
   */
  readBack: z.object({ at: z.number(), edited: z.number().int().min(0), retired: z.number().int().min(0), imported: z.number().int().min(0) }).strict().optional(),
  /**
   * Read-back: lessons Rovara knew in the file that a change took out, more than a few at once, so none was retired yet. `digest` names exactly which ones. They are held READ_BACK_HOLD_MS; after
   * that, with the SAME ones still missing, nothing is retired by itself: a person (the company owner, or someone who can approve lessons) is asked, and `verdict` is their answer: `retire` (the next pass retires them) or `keep` (they stay
   * live and the next weekly pull request proposes their blocks back). If the file changed (another set missing, or the lessons restored) the hold starts over. Count, fingerprint, an answer and times only: no person, no text. `at` is when it was FIRST seen:
   * the hold lasts READ_BACK_HOLD_MS from then, however many passes (or failed passes) come between. `decidedAt` is when the answer was recorded.
   */
  readBackHeld: z.object({ missing: z.number().int().min(1), digest: z.string().regex(/^[0-9a-f]{16}$/u), at: z.number(), verdict: z.enum(["retire", "keep"]).optional(), decidedAt: z.number().optional() }).strict().optional(),
  /**
   * Read-back: for each Rovara-marked block seen in the file on the last successful pass, the per-project FINGERPRINT (an HMAC under the project's secret, `LessonStore.textFingerprints`; no text, no bare hash) of its text, one per
   * block of that id. Replaced when the text changes, so that when a lesson is erased a fingerprint is already there for the block whatever happens to the file next. Kept while the lesson is live, or gone with a copy still in the file;
   * dropped after that.
   */
  seen: z.record(Id, z.array(z.string().regex(/^[0-9a-f]{32}$/u)).min(1).max(16)).optional(),
  /** How many ids appear in more than one block of the file on the last successful pass (Rovara reads neither block back and leaves them as written). */
  duplicateIds: z.number().int().min(0).optional(),
  /** Lines of the file read-back did not take in as lessons, by a fingerprint of the line's text (never the text) and a fixed reason: it keeps the pass from recording the same line every week. Newest last, bounded. */
  refused: z.record(z.string().regex(/^[0-9a-f]{16}$/u), z.enum(READ_BACK_REFUSALS)).optional(),
  revision: z.number().int().min(0),
}).strict();
export type RepoFileState = z.infer<typeof RepoFileStateSchema>;

export const newRepoFileState = (place: string, name: string): RepoFileState => ({
  place, name, enabled: false, pointerProposed: false, pointerDeclined: false, fileSeen: false, fileDeleted: false, rendered: {}, declined: [], held: [], unmerged: 0, closing: [], theirs: [], pointerMissing: false, revision: 0,
});

export interface RepoFileStore extends PrRowStore {
  /** The repositories of the project that have a readable state. An item that does not parse is skipped (and reported through the store's `onUnreadable`), never allowed to hide the others. */
  list(key: ScopeKey): Promise<RepoFileState[]>;
  /** The state, or undefined when there is none. An item that exists and does not parse THROWS `StateUnreadable` (never "absent"). */
  get(key: ScopeKey, place: string): Promise<RepoFileState | undefined>;
  /** Writes the state if the stored revision is `expected` (0: nothing stored yet). Returns the saved copy (revision + 1), or undefined when somebody else wrote first. Throws when the store cannot be reached. */
  put(key: ScopeKey, state: RepoFileState, expected: number): Promise<RepoFileState | undefined>;
}

/** A state that cannot be written as it is (over a cap, or a field that no longer fits its schema): the pass skips the repository and records it, never storing a state it would later read as absent. */
export class StateFull extends Error { constructor(readonly detail = "") { super("the repository's record is full"); } }
/** An item that exists and does not parse is NOT an absent state: reading it throws. */
export class StateUnreadable extends Error { constructor() { super("the repository's record cannot be read"); } }
/** Size of one state item the store accepts (a hosted document store's item limit is 400 KB). */
export const MAX_STATE_BYTES = 300_000;

/** The state as it would be stored, or `StateFull` when it does not fit its schema or the item size. */
export function checkedState(state: RepoFileState): RepoFileState {
  const parsed = RepoFileStateSchema.safeParse(state);
  if (!parsed.success || JSON.stringify(state).length > MAX_STATE_BYTES) throw new StateFull(parsed.success ? "size" : JSON.stringify(parsed.error.issues).slice(0, 300));
  return parsed.data;
}

/** Parses a stored item; undefined when it is not a state this build knows (it is then left alone). */
export function parseRepoFileState(value: unknown): RepoFileState | undefined {
  const parsed = RepoFileStateSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export class InMemoryRepoFileStore implements RepoFileStore {
  readonly items = new Map<string, RepoFileState>();
  /** Fail the next writes (a test of a store that is down). */
  failPuts = false;
  readonly prs = new Map<string, PrRow>();
  failPrWrites = false;
  async listPrs(key: ScopeKey): Promise<{ rows: PrRow[]; unreadable: number }> { return { rows: [...this.prs.entries()].filter(([k]) => k.startsWith(`${key.workspaceId}\u0000${key.project}\u0000`)).map(([, v]) => structuredClone(v)).filter((row) => row.kind !== "lease"), unreadable: 0 }; }
  async putPr(key: ScopeKey, row: PrRow): Promise<void> {
    if (this.failPrWrites) throw new Error("store down");
    this.prs.set(`${key.workspaceId}\u0000${key.project}\u0000${row.place}\u0000${row.number}`, PrRowSchema.parse(row));
  }
  async delPr(key: ScopeKey, place: string, number: string): Promise<void> { this.prs.delete(`${key.workspaceId}\u0000${key.project}\u0000${place}\u0000${number}`); }
  async claimPr(key: ScopeKey, row: PrRow): Promise<{ claimed: true } | { claimed: false; heldSince: number }> {
    if (this.failPrWrites) throw new Error("store down");
    const id = `${key.workspaceId}\u0000${key.project}\u0000${row.place}\u0000${row.number}`;
    const held = this.prs.get(id);
    if (held !== undefined) return { claimed: false, heldSince: held.at };
    this.prs.set(id, PrRowSchema.parse(row));
    return { claimed: true };
  }
  private keyOf(key: ScopeKey, place: string): string { return `${key.workspaceId}\u0000${key.project}\u0000${place}`; }
  async list(key: ScopeKey): Promise<RepoFileState[]> {
    return [...this.items.entries()].filter(([k]) => k.startsWith(`${key.workspaceId}\u0000${key.project}\u0000`)).map(([, v]) => structuredClone(v)).sort((a, b) => a.place.localeCompare(b.place));
  }
  async get(key: ScopeKey, place: string): Promise<RepoFileState | undefined> {
    const found = this.items.get(this.keyOf(key, place));
    return found === undefined ? undefined : structuredClone(found);
  }
  async put(key: ScopeKey, state: RepoFileState, expected: number): Promise<RepoFileState | undefined> {
    if (this.failPuts) throw new Error("store down");
    const current = this.items.get(this.keyOf(key, state.place));
    if ((current?.revision ?? 0) !== expected) return undefined;
    const saved = { ...structuredClone(checkedState(state)), revision: expected + 1 };
    this.items.set(this.keyOf(key, state.place), saved);
    return structuredClone(saved);
  }
}

/** Whether new lessons and edits are paused: this many weekly pull requests in a row went unmerged. */
export const additionsPaused = (state: Pick<RepoFileState, "unmerged">): boolean => state.unmerged >= LESSON_FILE_UNMERGED_LIMIT;

/** The ids a map or list holds, bounded (the oldest go first). */
export function boundedAppend(list: readonly string[], more: readonly string[], max: number): string[] {
  const out = [...new Set([...list, ...more])];
  return out.length > max ? out.slice(out.length - max) : out;
}

export type { LessonFileProblem };

/** Adds to a bookkeeping list that has a cap: over it the state FAILS LOUDLY (`StateFull`) instead of dropping an entry. */
export function appended<T>(list: readonly T[], entry: T, max = MAX_THEIRS): T[] {
  if (list.length >= max) throw new StateFull();
  return [...list, entry];
}

/**
 * Adds to a capped bookkeeping list WITHOUT stopping the pass: when the list is full the entry is not added and the state's row says `state_unreadable` (loud, and the next pass tries again). Bookkeeping is never allowed to block
 * the work that matters (removals, and the erasure sweep, which does not use this state at all).
 */
export function appendOrMark<K extends "closing" | "theirs">(state: RepoFileState, field: K, entry: RepoFileState[K][number]): Pick<RepoFileState, K> & { problem?: "state_unreadable" } {
  const list: unknown[] = state[field];
  if (list.length >= MAX_THEIRS) return { [field]: list, problem: "state_unreadable" } as unknown as Pick<RepoFileState, K> & { problem: "state_unreadable" };
  return { [field]: [...list, entry] } as unknown as Pick<RepoFileState, K>;
}
