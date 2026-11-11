// Lessons in the repo, lane R3 (owner decisions 50, 50a, 50b, 76; LESSONS-REPO-FILE-DESIGN.md rev 2 section 6): read-back. The merged `.rovara/lessons.md` is the team's, so what the team does to it in git is taken into Rovara, ONE WAY
// (file -> Rovara), once per weekly pass, from the file the pass already read on the default branch (no new read, no new loop). It is pure text: NO model call (decision 47), no host, no clock but the one it is given.
//   - A block whose text changed under a known id is the team's CORRECTION: the lesson's text becomes theirs, as a person edit (audited, actor "repository edit": the code host does not say who wrote it and read-back never needs to
//     know, section 6). The lesson stays repository-only for this repository (the text is repository content) and R2's hand-edit hold is released (the fingerprint Rovara remembers for the block becomes the team's). A
//     SUBSTANTIAL rewrite (`isSubstantialRewrite`) also clears harm marks and a pending removal from before it, help counts are kept; a small edit keeps them (decision 76.2).
//   - A known id missing from the file is RETIRED BY THE TEAM (cause "removed_in_repository", audited). R2 never proposes it back. More than max(3, 25%) of the known ids missing in one change is held for a week instead (review M1), and after that week they are retired only when a person confirmed it (owner decision 78); kept ones stay live and R2 proposes them back.
//   - A bullet with no id line is a NEW lesson, PERSON-APPROVED (decision 76.1: whoever can write to the repository is trusted, as with AGENTS.md; the approval is recorded honestly as the repository edit), repository-only for this
//     repository. It is tracked from the moment it is made (its fingerprint goes in `rendered`, review H1), so deleting or rewording it before R2's id-line pull request merges is a normal retire/edit. A text that names a person, asks
//     for a capability change, is empty, or is the text of an ERASED lesson whose id line was stripped (review H2) is NOT taken in; the line's fingerprint and a fixed reason are recorded. Where the company requires an approver group
//     the lesson waits for that group (pending, review required) instead of being active (review M3).
//   - An id that is gone for good in Rovara (erased, withdrawn, purged) is NEVER touched here, whatever the file says: the erasure sweep owns it, independently. A deliberate re-paste of erased text AFTER its block was removed is the
//     team's new lesson (decision 76.3); a stripped id line is told apart from it because Rovara still remembers the block (`rendered`) or already refused that very line (`refused`, kept while the line stays).
//   - Formatters are tolerated: texts are compared in normal form (whitespace, wrapping, bullet marker, CRLF, NFC); a change only in those is not an edit. Ids stripped by a tool that drops HTML comments are re-attached by exact text
//     (nothing is retired). A file that cannot be trusted as read (not valid text, merge-conflict markers, or one that lost EVERY marker while Rovara expects some) is UNREADABLE: nothing at all is changed this pass.
//   - It acts only on what it can prove: a lookup that fails throws and changes nothing further; a lesson changed between the read and the write is a conflict that ends the pass (nothing is half-recorded: every step is repeatable).
import { createHash } from "node:crypto";
import { cleanForLearning, requestsCapabilityChange } from "./guards.js";
import { defaultLessonId, retireLesson } from "./curate.js";
import { firstExpiry, pendingExpiry } from "./expiry.js";
import { emitAudit, requireAudit } from "./policy.js";
import type { LessonAuditSink } from "./ports.js";
import { TEAM_FILE_TEXT } from "./repo-eligibility.js";
import {
  WHOLE_REPOSITORY, bodyHashOf, cleanLessonLine, looseItems, normalizeBlockText, parseLessonsFile, textHash, textPartOfFingerprint, type LooseItem,
} from "./repo-file-format.js";
import { MAX_REFUSED, READ_BACK_HOLD_MS, type ReadBackRefusal } from "./repo-file-state.js";
import { nextVersion, type LessonStore, type ScopeKey } from "./store.js";
import { classifyTier } from "./tier.js";
import { namesAPerson } from "./trial.js";
import { LessonSchema, type Lesson } from "./types.js";

/** The actor of an edit, a retirement or a new lesson read back: the code host does not say who wrote the text. */
export const REPOSITORY_EDIT_ACTOR = "repository edit";
/** The `by` of the approval a read-back gives (not a person's id: it names no one and is never counted as a person to erase). */
const APPROVAL_BY = "system:repository-edit";
/** The cause the ledger records on a retirement the team made by removing the block. */
export const REMOVED_IN_REPOSITORY = "removed_in_repository";
/** New lessons taken in from one file in one pass (the rest wait for the next pass). */
export const MAX_IMPORTS_PER_PASS = 50;
const MAX_TRIES = 3;
/** The most blocks of one id read back (and fingerprinted); a file with more is unreadable. */
export const MAX_BLOCKS_PER_ID = 16;
/** More lessons than this (the larger of three and a quarter of the known ones) missing in one change are held, not retired (review M1). */
const bulkLimit = (known: number): number => Math.max(3, Math.ceil(known * 0.25));
/** A rewrite is substantial when the words of the two texts overlap by less than 80% (and at least three words differ): only then does it clear what the old wording earned (decision 76.2). */
export function isSubstantialRewrite(before: string, after: string): boolean {
  const words = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word !== ""));
  const a = words(before);
  const b = words(after);
  const shared = [...a].filter((word) => b.has(word)).length;
  const union = a.size + b.size - shared;
  return union - shared >= 3 && shared / Math.max(1, union) < 0.8;
}
const INERT = new Set<Lesson["status"]>(["retired", "rejected", "withdrawn"]);
const FINGERPRINT = /^([0-9a-f]{16}):([0-9a-f]{8})$/u;

/** A fault that ends the pass with this problem code (nothing is half-done: the next pass repeats whatever was not finished). */
export class ReadBackFailure extends Error { constructor(readonly problem: "audit_down" | "conflict" | "repository_unreadable") { super(problem); this.name = "ReadBackFailure"; } }

export interface ReadBackDeps {
  store: LessonStore;
  audit: LessonAuditSink;
  now: () => number;
  newId?: () => string;
}

export interface ReadBackInput {
  key: ScopeKey; place: string; repoName: string;
  /** The default branch's file text. */
  fileText: string;
  /** What Rovara remembers: the fingerprints of the blocks it merged, and the lines it already refused. */
  rendered: Readonly<Record<string, string>>; refused: Readonly<Record<string, ReadBackRefusal>>;
  /** Every lesson of the project (any status); lessons of other repositories are ignored. */
  lessons: readonly Lesson[];
  /** Ids gone for good in Rovara (the lesson store's tombstones): never touched. */
  gone: ReadonlySet<string>;
  /** The people the text could name (display names). */
  names: readonly string[];
  /** The company or the project requires an approver group: a lesson written in the repository waits for that group instead of being active (review M3). */
  requireGroup?: boolean;
  /** The fingerprints of marked blocks recorded on the last successful pass (`RepoFileState.seen`). */
  seen?: Readonly<Record<string, readonly string[]>>;
  /** The lessons missing from the file when that many were first held (`RepoFileState.readBackHeld`): which ones (a digest) and when it was first seen. */
  held?: { digest: string; at: number; verdict?: "retire" | "keep"; decidedAt?: number };
}

export interface ReadBackResult {
  /** The file cannot be trusted as read: nothing was changed. */
  unreadable: boolean;
  /** Fingerprints to record for blocks whose wording is now the team's (or that Rovara adopted): id to fingerprint. */
  rendered: Record<string, string>;
  /** The refused lines after this pass (old ones kept, bounded). */
  refused: Record<string, ReadBackRefusal>;
  counts: { edited: number; retired: number; imported: number; refused: number };
  /** A bulk disappearance held for a pass (review M1): how many are missing and which ones (a digest). Absent: nothing is held. */
  /** The fingerprints of every marked block seen in the file on this successful pass, by id (`RepoFileState.seen`). */
  seen: Record<string, string[]>;
  /** How many ids are in more than one block of the file. */
  duplicateIds: number;
  /** Erased lessons whose text is still in the file: their fingerprints are kept so the mark on the text can be cleared when the last copy is gone. */
  pinned: string[];
  held?: { missing: number; digest: string; ids: string[]; /** First seen: the hold lasts READ_BACK_HOLD_MS from here. */ at: number; /** A person's answer for this very set (owner decision 78); `keep`: the lessons stay live and are proposed back. */ verdict?: "retire" | "keep"; decidedAt?: number };
}

const hashOfBody = bodyHashOf;
const hashOfBlock = (text: string): string => textHash(normalizeBlockText(text));

/**
 * The text the file does not make safe: bytes that were not valid text come out as U+FFFD, NUL is never in a text file, and a merge that was committed with its conflict markers (`<<<<<<<` or `>>>>>>>`, outside a code fence; a lone line of equals signs is a heading underline) holds two versions of
 * the file at once.
 */
export function isMalformed(text: string): boolean {
  if (text.includes("\u0000") || text.includes("\ufffd")) return true;
  let fenced = false;
  for (const line of text.split(/\r?\n/u)) {
    if (/^\s*(?:`{3,}|~{3,})/u.test(line)) { fenced = !fenced; continue; }
    if (!fenced && /^(?:<{7}|>{7})(?: |$)/u.test(line)) return true;
  }
  return false;
}

/** The scope a section heading names, the reverse of `sectionOf`: the whole repository, `Languages: a, b`, `path, path` and `path (lang, lang)`. A heading of the team's own is the whole repository. */
export function scopeOfHeading(heading: string, repoName: string): Lesson["scope"] {
  const base: Lesson["scope"] = { repos: [repoName] };
  if (heading === WHOLE_REPOSITORY) return base;
  const PATH = /^[A-Za-z0-9_./*@-]{1,100}$/u;
  const LANG = /^[a-z][a-z0-9+#-]{0,19}$/u;
  const list = (text: string): string[] => text.split(",").map((part) => part.trim());
  const onlyLanguages = /^Languages:\s*(.+)$/u.exec(heading);
  if (onlyLanguages !== null) { const languages = list(onlyLanguages[1]!); return languages.length <= 10 && languages.every((l) => LANG.test(l)) ? { ...base, languages } : base; }
  const withLanguages = /^(.+?) \(([^()]+)\)$/u.exec(heading);
  const pathText = withLanguages === null ? heading : withLanguages[1]!;
  const paths = list(pathText);
  const languages = withLanguages === null ? [] : list(withLanguages[2]!);
  // A path names a file or folder (a slash, a star or a dot): a one-word heading of the team's own ("Testing") is not a path.
  if (paths.length === 0 || paths.length > 20 || !paths.every((p) => PATH.test(p) && /[/*.]/u.test(p) && !p.includes("..")) || languages.length > 10 || !languages.every((l) => LANG.test(l))) return base;
  return { ...base, paths, ...(languages.length === 0 ? {} : { languages }) };
}

/** The part of a fingerprint that stands for the section heading (`repo-file-plan.ts#fingerprintOf`). */
const hashOfHeading = (heading: string): string => createHash("sha256").update(heading).digest("hex").slice(0, 8);

const titleOf = (text: string): string => Array.from(text).slice(0, 80).join("").trim();

type Decision = { ok: true; body: string } | { ok: false; reason: ReadBackRefusal };
/** What a line of the file may become as a lesson's text: cleaned like every lesson text, and refused when it is empty, names a person or asks for a capability change. Pure. */
function admit(text: string, names: readonly string[]): Decision {
  const body = cleanForLearning(cleanLessonLine(text), 600);
  if (body === "") return { ok: false, reason: "empty" };
  if (requestsCapabilityChange(titleOf(body), "", body)) return { ok: false, reason: "capability_request" };
  if (namesAPerson(body, names)) return { ok: false, reason: "names_a_person" };
  return { ok: true, body };
}

/** The sink's failure to take an event that a grant needs is a failure of the pass, before anything is changed for that lesson. */
async function audited(deps: ReadBackDeps, event: Parameters<typeof requireAudit>[1]): Promise<void> {
  if (!await requireAudit(deps.audit, event)) throw new ReadBackFailure("audit_down");
}

/** The lessons that must be in the file: Rovara merged them and they are alive. A lesson that is gone, retired or unknown is not expected (nothing of it is lost if its marker is). */
function expectedIds(input: ReadBackInput, byId: ReadonlyMap<string, Lesson>): string[] {
  return Object.keys(input.rendered).filter((id) => { const lesson = byId.get(id); return lesson !== undefined && !INERT.has(lesson.status) && !input.gone.has(id); });
}

/** A lesson Rovara may take the team's wording into: one it is using, or one that only waits for an approver group with the team's own text. */
const editable = (lesson: Lesson): boolean => lesson.status === "active" || (lesson.status === "pending" && lesson.tierReasons.includes(TEAM_FILE_TEXT));

/** What a lesson written in the repository is: person-approved by the repository edit (decision 76.1), or, where an approver group is required, waiting for that group (pending, review required, no approval). */
function approvalOf(deps: ReadBackDeps, now: number, requireGroup: boolean): Pick<Lesson, "status" | "approvals"> & Partial<Pick<Lesson, "reviewRequired" | "pendingExpiresAt">> {
  if (requireGroup) return { status: "pending", approvals: [], reviewRequired: true, pendingExpiresAt: pendingExpiry(now) };
  return { status: "active", approvals: [{ approvalId: (deps.newId ?? defaultLessonId)(), by: APPROVAL_BY, at: now, mode: "one" }] };
}

async function editLesson(deps: ReadBackDeps, key: ScopeKey, id: string, body: string, requireGroup: boolean): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const fresh = await deps.store.get(key, id);
    if (fresh === undefined || !editable(fresh)) return false;
    // Repeating a finished edit (the state was not saved after it): nothing more to do.
    if (fresh.body === body && fresh.tierReasons.includes(TEAM_FILE_TEXT)) return true;
    const now = deps.now();
    const working: Lesson = { ...fresh, title: titleOf(body), description: "", body };
    // The tier is worked out again on the team's words (an edit can raise a tier, never lower it); the lesson keeps being the team's text (`TEAM_FILE_TEXT`), so R2 never takes the block out for its tier.
    const decision = classifyTier(working, { contradiction: fresh.contradictsWith !== undefined }, { tier: fresh.tier, reasons: fresh.tierReasons.filter((r) => r !== TEAM_FILE_TEXT) });
    if (decision.tier === "never") return false;
    // A person's edit is a new text: the approvals given to the old text do not carry over. The repository edit is the approval, and a trial the lesson was on is over. `reviewRequired` is never cleared here: only a person does that.
    const next: Lesson = {
      ...working, version: nextVersion(fresh, await deps.store.versions(key, id)), tier: decision.tier, tierReasons: [...new Set([...decision.reasons, TEAM_FILE_TEXT])].slice(0, 12),
      ...approvalOf(deps, now, requireGroup), updatedAt: now,
    };
    delete (next as { trial?: Lesson["trial"] }).trial;
    // A lesson that only waited for a group (no group is required any more) goes live on the repository edit; one a person marked for review keeps the mark.
    if (!requireGroup && fresh.status === "pending") { delete (next as { reviewRequired?: boolean }).reviewRequired; delete (next as { pendingExpiresAt?: number }).pendingExpiresAt; }
    await audited(deps, requireGroup
      ? { action: "lesson.pending", workspaceId: key.workspaceId, project: key.project, lessonId: id, actor: REPOSITORY_EDIT_ACTOR, facts: { tier: decision.tier, cause: "repository_edit" } }
      : { action: "lesson.updated", workspaceId: key.workspaceId, project: key.project, lessonId: id, actor: REPOSITORY_EDIT_ACTOR, facts: { tier: decision.tier, fromTier: fresh.tier, cause: "repository_edit" } });
    // A substantial rewrite clears harm marks and a pending removal from before it (help counts are kept). Done BEFORE the new version, so a crash between the two leaves the same decision to repeat (the text still differs).
    if (isSubstantialRewrite(fresh.body, body) && (fresh.counters.harmful > 0 || fresh.retireProposedAt !== undefined)) {
      delete (next as { retireProposedAt?: number }).retireProposedAt;
      await deps.store.mutate(key, id, (l) => ({ ...(l.counters.harmful > 0 ? { counters: { ...l.counters, harmful: 0 } } : {}), ...(l.retireProposedAt === undefined ? {} : { retireProposedAt: undefined as unknown as number }) }));
    }
    const result = await deps.store.commit(key, await deps.store.setVersion(key), [next], now);
    if (result.ok) return true;
  }
  return false;
}

/** Makes the lesson of one bullet the team wrote. Returns its id, or undefined when it could not be written (conflict) or the text is never allowed. */
async function importLesson(deps: ReadBackDeps, input: ReadBackInput, item: LooseItem, body: string): Promise<string | undefined> {
  const { key } = input;
  const now = deps.now();
  const title = titleOf(body);
  const scope = scopeOfHeading(item.heading, input.repoName);
  const stages: Lesson["stages"] = ["UNDERSTAND", "PLAN", "IMPLEMENT"];
  const decision = classifyTier({ type: "convention", stages, scope, citations: [], title, description: "", body, provenance: { minTrust: "member", audience: { kind: "project" } } });
  if (decision.tier === "never") return undefined;
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const lesson: Lesson = LessonSchema.parse({
      id: (deps.newId ?? defaultLessonId)(), version: 1, workspaceId: key.workspaceId, project: key.project, scope, type: "convention", stages, title, description: "", body, citations: [],
      provenance: {
        sourceEvents: [], sourceKinds: [], authors: [], supportTasks: [], sources: [], inputSources: [], measured: false, minTrust: "member", audience: { kind: "project" },
        reflectorRun: "repo_file", model: "none", memberSignal: true, sourceScopes: [input.place], repoOnly: { place: input.place },
      },
      tier: decision.tier, tierReasons: [...new Set([...decision.reasons, TEAM_FILE_TEXT])].slice(0, 12),
      counters: { loaded: 0, helpful: 0, harmful: 0, citationStale: 0 }, staleAt: [], expiresAt: firstExpiry("convention", now, undefined), createdAt: now, updatedAt: now,
      ...approvalOf(deps, now, input.requireGroup === true),
    });
    await audited(deps, lesson.status === "pending"
      ? { action: "lesson.pending", workspaceId: key.workspaceId, project: key.project, lessonId: lesson.id, actor: REPOSITORY_EDIT_ACTOR, facts: { tier: lesson.tier, type: lesson.type, cause: "repository_edit" } }
      : { action: "lesson.activated", workspaceId: key.workspaceId, project: key.project, lessonId: lesson.id, actor: REPOSITORY_EDIT_ACTOR, facts: { tier: lesson.tier, type: lesson.type, approvals: 1, cause: "repository_edit" } });
    const result = await deps.store.commit(key, await deps.store.setVersion(key), [lesson], now);
    if (result.ok) return lesson.id;
  }
  return undefined;
}

/**
 * Reads the team's edits of the merged file back into Rovara (see the header). Never calls a model or a host. Throws `ReadBackFailure` when it could not finish safely; what it finished stays (each step is repeatable, so the next
 * pass completes the rest without doing anything twice).
 */
export async function readBackFile(deps: ReadBackDeps, input: ReadBackInput): Promise<ReadBackResult> {
  const nothing: ReadBackResult = { unreadable: false, rendered: {}, refused: { ...input.refused }, counts: { edited: 0, retired: 0, imported: 0, refused: 0 }, pinned: [], seen: {}, duplicateIds: 0 };
  if (isMalformed(input.fileText)) return { ...nothing, unreadable: true };
  const { key } = input;
  const file = parseLessonsFile(input.fileText);
  // More than sixteen blocks of one id cannot be fingerprinted for erasure within the record's bounds, so such a file is not read at all (it fails loudly, with the status saying what to do) rather than dropping fingerprints.
  const perId = new Map<string, number>();
  for (const block of file.blocks) perId.set(block.id, (perId.get(block.id) ?? 0) + 1);
  if ([...perId.values()].some((count) => count > MAX_BLOCKS_PER_ID)) return { ...nothing, unreadable: true };
  const loose = looseItems(file);
  const looseHashes = new Set(loose.map((item) => hashOfBlock(item.text)));
  const mine = input.lessons.filter((lesson) => lesson.provenance.repoOnly?.place === input.place || input.rendered[lesson.id] !== undefined);
  const byId = new Map(mine.map((lesson) => [lesson.id, lesson]));
  const inFile = new Set(file.blocks.map((block) => block.id));
  /** Whether a lesson's text is still in the file as a bullet: by its own text, or by the line it was made from (the cleaned text can differ from the line). */
  const textStillThere = (lesson: Lesson): boolean => looseHashes.has(hashOfBody(lesson.body)) || looseHashes.has(textPartOfFingerprint(input.rendered[lesson.id]) ?? "-");

  // A file with NO marker left while Rovara expects some is a file a tool stripped (or an emptied one): readable only if every expected lesson's own text is still there as a bullet (the next pull request puts the ids back).
  // Anything else is unreadable: "the team retired everything" is never concluded from a file that lost all its markers.
  const expected = expectedIds(input, byId);
  if (file.blocks.length === 0 && expected.length > 0 && !expected.every((id) => textStillThere(byId.get(id)!))) return { ...nothing, unreadable: true };

  const result = nothing;
  const refuse = (hash: string, reason: ReadBackRefusal): void => {
    if (result.refused[hash] === reason) return;
    delete result.refused[hash];
    result.refused[hash] = reason;
    result.counts.refused += 1;
  };

  // 1. Changed text under a known id: the team's correction.
  for (const block of file.blocks) {
    if (file.duplicates.includes(block.id) || input.gone.has(block.id)) continue;
    const lesson = byId.get(block.id);
    // Only a lesson Rovara is using (or one waiting for its group with the team's text) takes the team's wording in; one that is expired, stale or retired keeps its block exactly as the team wrote it (R2's hold).
    if (lesson === undefined || !editable(lesson)) continue;
    const remembered = input.rendered[block.id];
    const match = remembered === undefined ? null : FINGERPRINT.exec(remembered);
    const baseline = match === null ? hashOfBody(lesson.body) : match[1]!;
    const now = hashOfBlock(block.text);
    if (now === baseline) continue;
    // The heading part stays what Rovara remembered: a block the team only MOVED is not an edit (R2 keeps holding it), and a moved-and-reworded one keeps being a moved one.
    const headingPart = match === null ? undefined : match[2]!;
    const decision = admit(block.text, input.names);
    if (!decision.ok) { refuse(now, decision.reason); continue; }
    if (!await editLesson(deps, key, block.id, decision.body, input.requireGroup === true)) throw new ReadBackFailure("conflict");
    result.rendered[block.id] = `${now}:${headingPart ?? hashOfHeading(block.heading)}`;
    result.counts.edited += 1;
  }

  // 2. A known id the file no longer has: retired by the team. Not when its text is still there as a bullet (a tool stripped the marker), and never a lesson that is gone for good (the erasure sweep's).
  const missing = Object.keys(input.rendered).filter((id) => {
    if (inFile.has(id) || input.gone.has(id)) return false;
    const lesson = byId.get(id);
    return lesson !== undefined && !INERT.has(lesson.status) && !textStillThere(lesson);
  }).sort();
  let retire = true;
  if (missing.length > bulkLimit(expected.length)) {
    // One bad merge or a truncated file must not retire most of the lessons at once: they are held for at least a week BY THE CLOCK, from the first time this same set was seen (a pass that fails or runs again changes nothing).
    // After that the same ones still missing are NOT retired by themselves (owner decision 78): a person is asked, and only a "retire" answer for exactly this set retires them. A file that changed back, or another set missing,
    // starts over.
    const digest = createHash("sha256").update(missing.join("\n")).digest("hex").slice(0, 16);
    const same = input.held?.digest === digest;
    const since = same ? input.held!.at : deps.now();
    const verdict = same ? input.held!.verdict : undefined;
    if (!(same && verdict === "retire" && deps.now() - since >= READ_BACK_HOLD_MS)) {
      retire = false;
      result.held = { missing: missing.length, digest, ids: missing, at: since, ...(verdict === undefined ? {} : { verdict }), ...(same && input.held!.decidedAt !== undefined ? { decidedAt: input.held!.decidedAt } : {}) };
    }
  }
  if (retire) {
    for (const id of missing) {
      await retireLesson({ store: deps.store, now: deps.now, audit: deps.audit }, key, id, REMOVED_IN_REPOSITORY, REPOSITORY_EDIT_ACTOR, "lesson.retired", { cause: REMOVED_IN_REPOSITORY });
      const after = await deps.store.get(key, id);
      if (after !== undefined && !INERT.has(after.status)) throw new ReadBackFailure("conflict");
      result.counts.retired += 1;
    }
  }

  // 3. A bullet with no id: a new lesson the team wrote.
  const alive = input.lessons.filter((lesson) => !INERT.has(lesson.status) && !input.gone.has(lesson.id));
  const aliveTexts = new Set(alive.flatMap((lesson) => [hashOfBody(lesson.body), textPartOfFingerprint(input.rendered[lesson.id])].filter((h): h is string => h !== undefined)));
  // Erased words do not come back through a stripped id line. A bullet is the text of an erased lesson when Rovara still remembers that lesson's block as merged (its marker was in the file at the last pass and is not now), when this very
  // line was refused for it before (kept while the line stays), or when the store's tombstone knows the text and the block's fingerprint is not known. A re-paste after the block was removed has none of these: it is the team's new lesson.
  const goneIds = Object.keys(input.rendered).filter((id) => input.gone.has(id));
  const staleGone = new Set(goneIds.map((id) => textPartOfFingerprint(input.rendered[id])).filter((h): h is string => h !== undefined));
  // The text of an erased lesson that was once in the file is MARKED while any copy is still there, and the mark is cleared when no copy is left, so a re-paste after that is the team's new lesson. A text is marked by its per-project
  // FINGERPRINT (`LessonStore.textFingerprints`: an HMAC, no text, no bare hash), taken from the FILE: every block of a gone id that is in the file, however it got there, with the text it actually has. For a gone id whose block is no
  // longer there (the id line was stripped before anything looked) the fingerprint recorded on an earlier successful pass stands in: on EVERY successful pass the fingerprint of every marked block is recorded (`seen`, replaced when the
  // text changes), so erasure always finds one ready for a block that was ever seen. Every bullet is then judged against the marks, whatever happened to the lesson's record (a purge left no head to read).
  const hashes = new Set<string>([...looseHashes, ...file.blocks.map((block) => hashOfBlock(block.text)), ...[...staleGone]]);
  let fingerprints: Map<string, string>;
  let goneTexts: Set<string>;
  try {
    fingerprints = await deps.store.textFingerprints(key, input.place, [...hashes]);
    const fp = (hash: string): string => fingerprints.get(hash)!;
    const copyFps = new Set([...looseHashes, ...file.blocks.map((block) => hashOfBlock(block.text))].map(fp));
    const known = (id: string): boolean => byId.has(id) || input.rendered[id] !== undefined || input.gone.has(id);
    const blockFps = new Map<string, string[]>();
    for (const block of file.blocks) if (known(block.id)) blockFps.set(block.id, [...(blockFps.get(block.id) ?? []), fp(hashOfBlock(block.text))]);
    const seen: Record<string, string[]> = {};
    // Live lessons: the fingerprint of the block as it is in the file now (replaced when the text changes), else the one recorded before.
    for (const [id, fps] of blockFps) if (!input.gone.has(id)) seen[id] = fps;
    // A live lesson of this repository whose id line is gone but whose text is still a bullet: that bullet's fingerprint. Nothing else is carried over, so `seen` holds only what the file holds now (bounded by the file's own cap).
    for (const lesson of alive) {
      if (!byId.has(lesson.id) || seen[lesson.id] !== undefined) continue;
      const hash = [hashOfBody(lesson.body), textPartOfFingerprint(input.rendered[lesson.id])].find((candidate) => candidate !== undefined && looseHashes.has(candidate));
      if (hash !== undefined) seen[lesson.id] = [fp(hash)];
    }
    // Gone lessons: every block of the id in the file is marked as it is; fingerprints recorded earlier that no copy has any more are cleared (a block reworded in place, a duplicate that was removed); the id is pinned while a copy is there.
    const goneToCheck = new Set([...input.gone].filter((id) => blockFps.has(id) || input.rendered[id] !== undefined || input.seen?.[id] !== undefined));
    for (const id of goneToCheck) {
      const inBlocks = blockFps.get(id) ?? [];
      const earlier = [...(input.seen?.[id] ?? []), ...(textPartOfFingerprint(input.rendered[id]) === undefined || inFile.has(id) ? [] : [fp(textPartOfFingerprint(input.rendered[id])!)])];
      for (const mark of inBlocks) await deps.store.markGoneFingerprint(key, mark);
      let pinnedHere = inBlocks.length > 0;
      for (const mark of new Set(earlier)) {
        if (inBlocks.includes(mark)) continue;
        if (copyFps.has(mark)) { await deps.store.markGoneFingerprint(key, mark); pinnedHere = true; } else await deps.store.clearGoneFingerprint(key, mark);
      }
      const keep = [...new Set([...inBlocks, ...earlier.filter((mark) => copyFps.has(mark))])];
      // Never cut silently: a record of one id that would not fit stops the pass (loudly) instead.
      if (keep.length > MAX_BLOCKS_PER_ID) throw new ReadBackFailure("repository_unreadable");
      if (keep.length > 0) seen[id] = keep;
      if (pinnedHere) {
        if (!result.pinned.includes(id)) result.pinned.push(id);
        // A block of the gone id in the file: its fingerprint pins the id in Rovara's record (the id is not forgotten while the text is there).
        const block = file.blocks.find((candidate) => candidate.id === id);
        if (block !== undefined) { const stamp = `${hashOfBlock(block.text)}:${hashOfHeading(block.heading)}`; if (input.rendered[id] !== stamp) result.rendered[id] = stamp; }
      }
    }
    result.seen = seen;
    const marked = await deps.store.goneFingerprintsOf(key, [...looseHashes].map(fp));
    goneTexts = new Set([...looseHashes].filter((hash) => marked.has(fp(hash))));
  } catch { throw new ReadBackFailure("repository_unreadable"); }
  result.duplicateIds = file.duplicates.length;
  let imports = 0;
  for (const item of loose) {
    const hash = hashOfBlock(item.text);
    if (aliveTexts.has(hash)) continue;
    if (staleGone.has(hash) || input.refused[hash] === "gone_text" || goneTexts.has(hash)) { refuse(hash, "gone_text"); continue; }
    if (input.refused[hash] !== undefined) continue;
    if (imports >= MAX_IMPORTS_PER_PASS) break;
    const decision = admit(item.text, input.names);
    if (!decision.ok) { refuse(hash, decision.reason); continue; }
    // The cleaned text may differ from the line (redaction, markup): a lesson with that text already is the same advice.
    const cleanedHash = hashOfBody(decision.body);
    if (aliveTexts.has(cleanedHash)) continue;
    const id = await importLesson(deps, input, item, decision.body);
    if (id === undefined) throw new ReadBackFailure("conflict");
    // Tracked from now on, like a block Rovara merged: deleting or rewording the bullet before the id-line pull request merges is a retirement or an edit, never a second copy (review H1).
    result.rendered[id] = `${hash}:${hashOfHeading(item.heading)}`;
    aliveTexts.add(hash); aliveTexts.add(cleanedHash);
    imports += 1;
    result.counts.imported += 1;
  }

  // Refusals are kept only while the line is in the file (a line that was taken out and put back is judged again), and bounded.
  const present = new Set([...looseHashes, ...file.blocks.map((block) => hashOfBlock(block.text))]);
  // The refusals of erased text are never the ones dropped to stay within the bound.
  const kept = Object.entries(result.refused).filter(([hash]) => present.has(hash));
  result.refused = Object.fromEntries([...kept.filter(([, reason]) => reason !== "gone_text").slice(-MAX_REFUSED), ...kept.filter(([, reason]) => reason === "gone_text")]);
  // A refusal is told once, in the ledger, fixed words only (best effort: it grants nothing).
  if (result.counts.refused > 0) await emitAudit(deps.audit, { action: "lesson.refused", workspaceId: key.workspaceId, project: key.project, actor: REPOSITORY_EDIT_ACTOR, facts: { reason: "repository_text_not_taken", count: result.counts.refused } });
  return result;
}
