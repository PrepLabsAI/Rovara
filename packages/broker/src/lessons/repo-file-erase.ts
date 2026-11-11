// The ERASURE SWEEP. When a lesson is erased or withdrawn in Rovara, text of it may be in the customer's repository: in a Rovara pull request still open, or in
// the lessons file on the default branch (a block Rovara merged, or one a person copied). The sweep takes it out, and it is built so that nothing else can stop it:
//   - It reads ONLY the repository's default-branch lessons file, `LessonStore.goneOf` (the durable per-lesson tombstone the deletion itself writes first, one row each, never evicted), the pull request rows (`PrRowStore`: one row
//     per Rovara-made pull request, apart from the publish state) and the code host. It is handed no publish state and never calls it, so a missing, unparseable, full or leased state, a failing `list`, a lost lease or a failing publish
//     pass cannot reach it. One repository's failure never touches another's.
//   - A Rovara pull request that ADDS a gone lesson is CLOSED (closing touches no commit), whatever its branch head is; it stays tracked (its row is kept for 90 days) so one a person reopens is closed again. Its branch is deleted only
//     while it is still at the head Rovara left it at (a delete can lose a person's commit; a close cannot).
//   - A block in the default branch's file that carries a gone lesson's marker is removed by a REMOVAL-ONLY pull request on its own random branch: nothing is adopted, the ref moves without force, the commit's parent is the head the file
//     was read at, the file only shrinks (so no cap applies), and it has its own row. An open one that already covers the blocks is left alone.
//   - Every host write is audited first; a ledger that is down skips the write (it is tried again at the next sweep).
// No model call. Provider-neutral: everything outside lessons code is the `CodeHost` port.
import { randomBytes } from "node:crypto";
import { LESSON_FILE_MAX_BYTES, LESSON_FILE_PATH } from "@agentx/contracts";
import { applyFileChanges, looseItems, normalizeBlockText, parseLessonsFile, textHash } from "./repo-file-format.js";
import { Unconfirmed, freshBranchName, guardTarget, headOf, readOwnPr, verifyRepository, watchRowOf, type RepoFileTarget } from "./repo-file-host.js";
import { requireAudit } from "./policy.js";
import type { LessonAuditSink } from "./ports.js";
import { isProvisional, provisionalNumber, type PrRow, type PrRowStore } from "./repo-file-state.js";
import type { LessonStore, ScopeKey } from "./store.js";

/** What the sweep is handed. Note what is NOT here: no publish state. */
export interface EraseSweepDeps {
  store: Pick<LessonStore, "goneOf" | "textFingerprints" | "goneFingerprintsOf" | "clearGoneFingerprint">;
  rows: PrRowStore;
  audit: LessonAuditSink;
  now(): number;
  randomHex?(): string;
  log?(event: string, fields: Record<string, string | number>): void;
}
/** The sweep's dependencies out of the pass's: only the lesson store's tombstone lookup, the pull request rows, the ledger and the clock. The publish state is left behind on purpose. */
export function sweepDepsOf(deps: { store: Pick<LessonStore, "goneOf" | "textFingerprints" | "goneFingerprintsOf" | "clearGoneFingerprint">; state: PrRowStore; rows?: PrRowStore; audit: LessonAuditSink; now(): number; randomHex?(): string; log?(event: string, fields: Record<string, string | number>): void }): EraseSweepDeps {
  return { store: deps.store, rows: deps.rows ?? deps.state, audit: deps.audit, now: () => deps.now(), randomHex: () => deps.randomHex?.() ?? randomBytes(6).toString("hex"), log: (event, fields) => deps.log?.(event, fields) };
}
/** What one repository's sweep did. `unreachable`: the host would not let Rovara read the repository at all (an uninstalled app, a repository that is gone). `strayBranches`: Rovara branches the host cannot match to a pull request. `unconfirmed`: open pull requests that were NOT closed because the host could not show them or did not say Rovara made them (shown on the status, tried again). */
export interface EraseSweepResult { closed: number; removalOpened: boolean; failures: number; unreachable: boolean; strayBranches: number; unconfirmed: number; /** Fingerprints of the marked copies the file held when it was read; absent when it was not read. */ marks?: string[] }

/** A closed pull request's row is kept this long, so one a person reopens is found and closed again. */
export const CLOSED_ROW_KEEP_MS = 90 * 86_400_000;
/** A row of a pull request never seen closed is dropped after this long (a Rovara pull request open for over a year is stale). */
export const OPEN_ROW_KEEP_MS = 400 * 86_400_000;

const audited = (deps: EraseSweepDeps, key: ScopeKey, action: "lesson.repo_file_pr_opened" | "lesson.repo_file_pr_closed", facts: Record<string, string | number | boolean>): Promise<boolean> =>
  requireAudit(deps.audit, { action, workspaceId: key.workspaceId, project: key.project, facts });

/** A provisional row nobody has completed after this long is stale: its host write never happened or its pull request never appeared. */
const PROVISIONAL_STALE_MS = 24 * 3_600_000;
/** A removal pull request being made by another sweep is left alone this long. */
const IN_FLIGHT_MS = 30 * 60_000;

/** Closes one row's pull request (and takes its branch down only while it is still Rovara's). True when the pull request is closed or was not open. */
async function closeRow(deps: EraseSweepDeps, key: ScopeKey, target: RepoFileTarget, row: PrRow, cause: string): Promise<boolean> {
  const { host, repository, scope } = target;
  if (row.branch === undefined) return true;
  const remember = async (): Promise<void> => { if (row.closedAt === undefined) await deps.rows.putPr(key, { ...row, closedAt: deps.now() }); };
  // READ AND CONFIRM first. A pull request the host cannot show (any failure but a confirmed 404) is not touched: this throws and the next sweep tries again.
  const read = await readOwnPr(target, row.number, row.branch, row.headRevision);
  // The host no longer has it (deleted): nothing to close, and the row must not fail every night for ever.
  if (read.kind === "gone") { await remember(); return true; }
  // Merged or closed by someone else: nothing to close. Remembered as closed (a row that carried a gone lesson is kept, so a reopened one is found again); a merged one's text is the file's, taken out by half two.
  if (read.details.state !== "open") { await remember(); return true; }
  // Open: closed only if Rovara made it. One that someone else made (another branch, another account, another repository behind the address) is never touched; one whose maker the host did not say is tried again.
  if (read.ours === false) { await remember(); return true; }
  if (read.ours === undefined) throw new Unconfirmed();
  if (!await audited(deps, key, "lesson.repo_file_pr_closed", { cause, pullRequest: Number(row.number) || 0 })) return false;
  await host.updateChangeRequest({ repository, id: row.number, url: "" }, { state: "closed" }, scope);
  await deps.rows.putPr(key, { ...row, closedAt: deps.now() });
  // The branch, after the close, and only while it is still the head Rovara left: closing touches no commit, deleting a branch can.
  if (row.headRevision !== undefined && host.deleteBranch !== undefined && await headOf(target, row.branch) === row.headRevision) await host.deleteBranch(repository, row.branch, scope).catch(() => undefined);
  return true;
}

/**
 * Rows written ahead of the host (see `provisionalNumber`): the pull request, if the host has one for the branch, gets its number; the numbered row replaces the provisional one. A branch with no pull request yet keeps its row
 * for a day (the writer may be in the middle of its steps), then it goes. Needs the host's `changeRequestForBranch`; a host without it leaves the row as it is.
 */
async function resolveProvisional(deps: EraseSweepDeps, key: ScopeKey, target: RepoFileTarget, rows: readonly PrRow[], result?: EraseSweepResult): Promise<PrRow[]> {
  const out: PrRow[] = [];
  for (const row of rows) {
    if (!isProvisional(row) || row.branch === undefined) { out.push(row); continue; }
    // A host that cannot say which pull request a branch made leaves the row as it is, and the branch is counted so the status can say so (the port offers no other way to find a pull request from its branch).
    if (target.host.changeRequestForBranch === undefined) { if (result !== undefined) result.strayBranches += 1; out.push(row); continue; }
    const found = await target.host.changeRequestForBranch(target.repository, row.branch, target.scope).then((ref) => ref, () => "failed" as const);
    if (found === "failed") { out.push(row); continue; }
    if (found === undefined) {
      // A branch Rovara wrote but never made a pull request for: once its writer has had time to finish, it is taken down while its head is still the one Rovara left (its text may be an erased lesson's).
      const idle = deps.now() - row.at > IN_FLIGHT_MS;
      if (idle && row.headRevision !== undefined && target.host.deleteBranch !== undefined && await headOf(target, row.branch) === row.headRevision) {
        await target.host.deleteBranch(target.repository, row.branch, target.scope).then(() => deps.rows.delPr(key, row.place, row.number)).catch(() => undefined);
        continue;
      }
      // Stale and the branch is gone: nothing is left to watch. A branch that is still there (its head could not be proven Rovara's) keeps its row for good: a pull request a person opens from it later is found and checked.
      const gone = deps.now() - row.at > PROVISIONAL_STALE_MS && await headOf(target, row.branch).then((head) => head === undefined, () => false);
      if (gone) await deps.rows.delPr(key, row.place, row.number).catch(() => undefined); else out.push(row);
      continue;
    }
    const numbered: PrRow = { ...row, number: found.id };
    try { await deps.rows.putPr(key, numbered); await deps.rows.delPr(key, row.place, row.number); } catch { /* the provisional row stays; resolved again next sweep */ }
    out.push(numbered);
  }
  return out;
}

/** Half one: Rovara pull requests that add a gone lesson are closed. Returns the numbers of the rows that carry a gone lesson (they are kept for good, so a PR reopened years later is still found). */
async function closeErasedAdds(deps: EraseSweepDeps, key: ScopeKey, target: RepoFileTarget, rows: readonly PrRow[], result: EraseSweepResult): Promise<Set<string>> {
  const kept = new Set<string>();
  const adds = rows.filter((row) => row.kind === "adds" && row.ids.length > 0 && !isProvisional(row));
  if (adds.length === 0) return kept;
  const gone = await deps.store.goneOf(key, [...new Set(adds.flatMap((row) => row.ids))]);
  for (const row of adds) {
    if (!row.ids.some((id) => gone.has(id))) continue;
    kept.add(row.number);
    try { if (await closeRow(deps, key, target, row, "erased") && row.closedAt === undefined) result.closed += 1; } catch (error) { result.failures += 1; if (error instanceof Unconfirmed) result.unconfirmed += 1; deps.log?.("lessons_repo_file.erase_close_failed", {}); }
  }
  return kept;
}

/** A removal pull request being made by another sweep is held under a lease row this long. */
const LEASE_MS = 15 * 60_000;
const REMOVAL_LEASE = "lease-removal";

/** Whether an open removal pull request (a row of it) already covers exactly these blocks of this file. */
const coversRow = (row: PrRow, inFile: readonly string[], fileHash: string, now: number): boolean =>
  row.kind === "removal" && row.closedAt === undefined && (isProvisional(row) ? now - row.at < IN_FLIGHT_MS : inFile.every((id) => row.ids.includes(id)) && row.fileHash === fileHash);

/** Releases the marks (of an earlier successful sweep of this repository) that no copy in the file has any more. */
async function releaseMarks(deps: EraseSweepDeps, key: ScopeKey, earlier: readonly string[], present: ReadonlySet<string>): Promise<void> {
  for (const fingerprint of earlier) if (!present.has(fingerprint)) await deps.store.clearGoneFingerprint(key, fingerprint);
}

/** Half two: blocks of gone lessons on the default branch come out through a removal-only pull request; one made stale (its blocks are gone from main, or main's file changed under it) is closed and made again. */
async function removeErasedBlocks(deps: EraseSweepDeps, key: ScopeKey, target: RepoFileTarget, identity: { defaultBranch?: string | undefined }, rows: readonly PrRow[], result: EraseSweepResult): Promise<void> {
  const { host, repository, scope } = target;
  if (host.commitFiles === undefined || host.pathKind === undefined) return;
  if (identity.defaultBranch === undefined) return;
  const defaultBranch = identity.defaultBranch;
  const head = await host.baseBranchHead(repository, defaultBranch, scope);
  const kind = await host.pathKind(repository, LESSON_FILE_PATH, head, scope);
  const earlier = rows.find((row) => row.kind === "watch")?.marks ?? [];
  // A file that is not there holds no copy: the marks this repository's sweeps recorded are released. Any other file that cannot be read says nothing (nothing is released).
  if (kind === "none") { await releaseMarks(deps, key, earlier, new Set()); result.marks = []; return; }
  if (kind !== "file") return;
  const text = await host.fileAtRevision(repository, LESSON_FILE_PATH, head, scope, { maxBytes: LESSON_FILE_MAX_BYTES });
  if (text === undefined) return;
  const parsed = parseLessonsFile(text);
  // Every id in the file, a duplicated one too: a gone lesson's text comes out of every block that carries its id.
  const ids = [...new Set(parsed.blocks.map((block) => block.id))];
  const gone = ids.length === 0 ? new Map() : await deps.store.goneOf(key, ids);
  // A copy of an erased lesson's text whose id line was stripped (a formatter, a deleted comment) is found by the mark read-back put on the text (`LessonStore.markGoneText`): it comes out too. Its "id" in the rows is `txt_<hash>`.
  const loose = looseItems(parsed);
  const looseHashes = [...new Set(loose.map((item) => textHash(normalizeBlockText(item.text))))];
  const copyHashes = [...new Set([...looseHashes, ...parsed.blocks.map((block) => textHash(normalizeBlockText(block.text)))])];
  const fingerprints = copyHashes.length === 0 ? new Map<string, string>() : await deps.store.textFingerprints(key, target.place, copyHashes);
  const marked = fingerprints.size === 0 ? new Set<string>() : await deps.store.goneFingerprintsOf(key, [...fingerprints.values()]);
  const looseGone = looseHashes.filter((hash) => marked.has(fingerprints.get(hash) ?? "-"));
  // The file was read: a mark this repository's earlier sweeps recorded that no copy has any more is released; the ones with a copy stay (and are what the row remembers now).
  const present = new Set(copyHashes.map((hash) => fingerprints.get(hash)!));
  await releaseMarks(deps, key, earlier, present);
  result.marks = [...new Set([...earlier.filter((fp) => present.has(fp)), ...[...marked].filter((fp) => present.has(fp))])]
  const inFile = [...ids.filter((id) => gone.has(id)), ...looseGone.map((hash) => `txt_${hash}`)];
  const fileHash = textHash(text);
  const openRemovals = rows.filter((r) => r.kind === "removal" && r.closedAt === undefined && !isProvisional(r));
  // A removal pull request that no longer matches main is out of date: its blocks are already gone, or main's file changed under it. It is closed (and, if blocks remain, made again below).
  let covered = false;
  for (const row of openRemovals) {
    const matches = inFile.length > 0 && inFile.every((id) => row.ids.includes(id)) && row.fileHash === fileHash;
    // Read and confirm: gone (404) or someone else's pull request is not an open removal pull request of ours; one that cannot be read is taken as open (it only stops a duplicate).
    const read = row.branch === undefined ? { kind: "gone" as const } : await readOwnPr(target, row.number, row.branch, row.headRevision).catch(() => undefined);
    const isOpen = read === undefined || (read.kind === "read" && read.details.state === "open" && read.ours !== false);
    if (matches && isOpen) { covered = true; continue; }
    if (isOpen) { try { await closeRow(deps, key, target, row, "nothing_left"); } catch (error) { result.failures += 1; if (error instanceof Unconfirmed) result.unconfirmed += 1; } }
    else if (row.closedAt === undefined) await deps.rows.putPr(key, { ...row, closedAt: deps.now() }).catch(() => undefined);
  }
  if (inFile.length === 0 || covered) return;
  // Another sweep may be in the middle of making one (its provisional row is younger than half an hour).
  if (rows.some((r) => isProvisional(r) && coversRow(r, inFile, fileHash, deps.now()))) return;
  const next = applyFileChanges(text, { remove: [], removeAll: inFile.filter((id) => !id.startsWith("txt_")), removeLoose: looseGone, replace: [], add: [] });
  if (next === text || host.deleteBranch === undefined) return;
  // ONE SWEEP AT A TIME makes a removal pull request: a lease row is claimed (written only if there is none), and the rows are read again under it, so two sweeps that started together cannot open two. A lease nobody released
  // (the Lambda died) is taken over after 15 minutes.
  const place = target.place;
  const lease: PrRow = { place, kind: "lease", number: REMOVAL_LEASE, ids: [], at: deps.now() };
  let claim = await deps.rows.claimPr(key, lease);
  if (!claim.claimed) {
    if (deps.now() - claim.heldSince < LEASE_MS) return;
    await deps.rows.delPr(key, place, REMOVAL_LEASE);
    claim = await deps.rows.claimPr(key, { ...lease, at: deps.now() });
    if (!claim.claimed) return;
  }
  try {
    const fresh = (await deps.rows.listPrs(key)).rows.filter((r) => r.place === place);
    const known = new Set(rows.map((r) => r.number));
    if (fresh.some((r) => (isProvisional(r) || !known.has(r.number)) && coversRow(r, inFile, fileHash, deps.now()))) return;
    if (!await audited(deps, key, "lesson.repo_file_pr_opened", { removals: inFile.length, edits: 0, adds: 0 })) return;
    const branch = await freshBranchName(deps, target);
    if (branch === undefined) { result.failures += 1; return; }
    // WRITE AHEAD: the repository's watch row and a row keyed by the new branch come BEFORE anything is written to the host. If they cannot be written, nothing is.
    const at = deps.now();
    const provisional: PrRow = { place, kind: "removal", number: provisionalNumber(branch), branch, ids: inFile, at, fileHash };
    await deps.rows.putPr(key, watchRowOf(target, at, rows.find((r) => r.kind === "watch")));
    await deps.rows.putPr(key, provisional);
    const written = await host.commitFiles({ repository, branch, baseBranch: defaultBranch, message: "Rovara: remove erased lessons", fromBase: true, baseRevision: head, files: [{ path: LESSON_FILE_PATH, content: next }], previous: [{ path: LESSON_FILE_PATH, content: text }] }, scope);
    await deps.rows.putPr(key, { ...provisional, headRevision: written.revision }).catch(() => undefined);
    const created = await host.reconcileChangeRequest({
      repository, sourceBranch: branch, targetBranch: defaultBranch, title: `Rovara: remove ${String(inFile.length)} erased ${inFile.length === 1 ? "lesson" : "lessons"}`,
      body: `Rovara removes ${String(inFile.length)} ${inFile.length === 1 ? "lesson" : "lessons"} from \`.rovara/lessons.md\` that ${inFile.length === 1 ? "was" : "were"} deleted in Rovara. Nothing else changes. Nothing changes until a person merges this pull request; the lessons stay in git history.`,
    }, scope);
    result.removalOpened = true;
    // The numbered row replaces the provisional one; if that cannot be done the provisional row stays and the next sweep resolves it by branch.
    try { await deps.rows.putPr(key, { ...provisional, number: created.ref.id, headRevision: written.revision }); await deps.rows.delPr(key, place, provisional.number); } catch { deps.log?.("lessons_repo_file.erase_row_update_failed", {}); }
  } finally {
    await deps.rows.delPr(key, place, REMOVAL_LEASE).catch(() => undefined);
  }
}

/** Options of one repository's sweep. `former`: the project no longer lists the repository (removed, moved host or given a new id): its open Rovara pull requests are closed as well, apart from the removal pull requests this sweep opens. */
export interface SweepOptions { former?: boolean }

/**
 * One repository's erasure sweep. Each half runs on its own: a failure of one is counted and the other still runs. Never throws. The first thing it does is ask the host for the repository: when the host will not say (the app is
 * uninstalled, the repository is gone) the result says `unreachable` and nothing else is tried.
 */
export async function sweepErasures(deps: EraseSweepDeps, key: ScopeKey, rawTarget: RepoFileTarget, options: SweepOptions = {}): Promise<EraseSweepResult> {
  const target = guardTarget(rawTarget);
  const result: EraseSweepResult = { closed: 0, removalOpened: false, failures: 0, unreachable: false, strayBranches: 0, unconfirmed: 0 };
  let rows: PrRow[];
  try { rows = (await deps.rows.listPrs(key)).rows.filter((row) => row.place === target.place); } catch { rows = []; result.failures += 1; deps.log?.("lessons_repo_file.erase_rows_unreadable", {}); }
  // A repository Rovara has never written to (no row of any kind) has nothing of its to take out: no host call.
  if (rows.length === 0) return result;
  // THE FIRST CHECK: the repository at this address must be the one the place pins (its id), or nothing is read from it or written to it.
  const verified = await verifyRepository(target);
  if (!verified.ok) { result.unreachable = true; result.failures += 1; return result; }
  const reachable = verified.identity;
  try { rows = await resolveProvisional(deps, key, target, rows, result); } catch { result.failures += 1; }
  if (options.former === true) {
    try { result.closed += await closeRows(deps, key, target, rows.filter((row) => row.kind !== "removal"), "repository_left", result); } catch { result.failures += 1; }
  }
  let keep = new Set<string>();
  try { keep = await closeErasedAdds(deps, key, target, rows, result); } catch { result.failures += 1; deps.log?.("lessons_repo_file.erase_sweep_failed", {}); }
  try { await removeErasedBlocks(deps, key, target, reachable, rows, result); } catch { result.failures += 1; deps.log?.("lessons_repo_file.erase_removal_failed", {}); }
  // Rows of closed pull requests are kept for 90 days (a reopened one is closed again); one never seen closed goes after 400 days; a row that carried a gone lesson, and every watch row, stay for good (a few bytes each).
  try {
    for (const row of rows) {
      if (row.kind === "watch" || row.branch === undefined || keep.has(row.number) || isProvisional(row)) continue;
      if (deps.now() - (row.closedAt ?? row.at) > (row.closedAt === undefined ? OPEN_ROW_KEEP_MS : CLOSED_ROW_KEEP_MS)) await deps.rows.delPr(key, row.place, row.number);
    }
  } catch { /* bookkeeping only */ }
  return result;
}

/** Closes the open Rovara pull requests among these rows. Returns how many it closed. */
async function closeRows(deps: EraseSweepDeps, key: ScopeKey, target: RepoFileTarget, rows: readonly PrRow[], cause: string, result?: EraseSweepResult): Promise<number> {
  let closed = 0;
  for (const row of rows) {
    if (row.kind === "watch" || row.closedAt !== undefined || isProvisional(row)) continue;
    try { if (await closeRow(deps, key, target, row, cause)) closed += 1; } catch (error) { if (result !== undefined && error instanceof Unconfirmed) result.unconfirmed += 1; /* tried again by the next sweep */ }
  }
  return closed;
}

/** A project is archived: every open Rovara pull request of the repository is closed (nothing is left in the customer's repository that Rovara can still take down). Independent of the publish state, like the sweep. */
export async function closeAllRovaraPrs(deps: EraseSweepDeps, key: ScopeKey, rawTarget: RepoFileTarget): Promise<number> {
  const target = guardTarget(rawTarget);
  // THE FIRST CHECK: the repository at this address is the one the place pins, or nothing is read from it, closed or deleted in it.
  if (!(await verifyRepository(target)).ok) return 0;
  const listed = await deps.rows.listPrs(key).then((l) => l.rows.filter((row) => row.place === target.place), () => [] as PrRow[]);
  const rows = await resolveProvisional(deps, key, target, listed).catch(() => listed);
  return closeRows(deps, key, target, rows, "switched_off");
}
