// "How we work" for the design review: the project's playbook document, read and written over the document store. It is Cloud's item (`projectPlaybookKey`): one per company and project, a revision
// the writer must have read, and the design review setting beside the default process. Code has one process (the built-in), so only that is kept; a document a hosted install wrote with a project process
// still reads (the process is left as it is on a write), and the setting is the part Code reads and writes here.
//
// What is different from the hosted install's store (the audit ledger, the process layers and the named-people check are Cloud's; the rest is the same):
//   - the audit event goes to the `audit-sink` port, in the same transaction as the write;
//   - naming people as the high-risk approver is refused here unless the caller says who may be named (`namedApproverCandidates`), as in Cloud;
//   - a group is refused (Code has no groups).
import {
  DEFAULT_PROJECT_PLAYBOOK, DESIGN_REVIEW_DEFAULT_SETTING, DESIGN_REVIEW_MODES, DesignReviewSettingSchema, PLAYBOOK_STALE_MESSAGE, PROCESS_UNAVAILABLE_MESSAGE, ProjectPlaybookSchema, agentXError, canonicalJson, designReviewSettingOf,
  projectPlaybookKey, when, type AuditSink, type DesignReviewSetting, type DocumentStore, type OrgId, type ProjectPlaybook, type TransactItem,
} from "@agentx/contracts";
import { checkDesignReviewWrite, lockRevisionCheck, readDesignReviewLock } from "./lock.js";

/** What a refused design review setting says. Field names only; the company's lock values and the project's are never echoed. */
export const DESIGN_REVIEW_LOCKED = "your company has set a stricter rule for design review";
/** A group is refused as the high-risk approver: this install has no groups, and one named would leave every high-risk design with nobody who can approve or skip it. */
export const DESIGN_REVIEW_GROUP_EDITION = "a group can't be the high-risk approver here; name people instead";
export const DESIGN_REVIEW_LOCK_UNREADABLE = "your company's design review rules can't be read right now, so this can't be saved";
/** What a design review setting that fails the strict schema says (the field is named before it; the value never is). */
export const DESIGN_REVIEW_INVALID = "is not a valid design review setting";
export const DESIGN_REVIEW_NAMED_PEOPLE = "name only project maintainers or members who can approve";
/** Naming people is refused when who may approve cannot be worked out right now (the candidates were not given): fail closed, never "anyone". */
export const DESIGN_REVIEW_NAMED_PEOPLE_UNCHECKED = "who can approve can't be checked right now, so people can't be named";

/**
 * What the playbook, the company's lock and policy are read with: the store, and what a company with no policy item has. Cloud: not allowed (design review is on for a company only when its admin allows it). Code: allowed,
 * because its one company is the owner who switched the stage on (`DESIGN_REVIEW_SWITCH`); a policy item a hosted install wrote is still read and held.
 */
export interface ProjectPlaybookReader extends Pick<DocumentStore, "get"> { allowedWhenAbsent?: boolean | undefined }

export interface ProjectPlaybookWriter extends Pick<DocumentStore, "get" | "transact"> {
  now: () => number;
  /** Records `playbook.design_review_changed` in the write's transaction. Absent: nothing is recorded. */
  audit?: AuditSink | undefined;
  /** Who may be NAMED as the high-risk approver in a project (its maintainers and the members whose role can approve). Absent: naming people is refused (fail closed). */
  namedApproverCandidates?: ((orgId: OrgId, project: string) => Promise<readonly string[]>) | undefined;
}

async function readItem(store: ProjectPlaybookReader, orgId: OrgId, project: string): Promise<Record<string, unknown> | undefined> {
  return store.get(projectPlaybookKey(orgId, project));
}

/** Why a stored project design review setting could not be read: fixed words, never the value. */
export const DESIGN_REVIEW_UNREADABLE_REASONS = ["wrong_type", "unknown_mode", "invalid_shape"] as const;
export type DesignReviewUnreadableReason = (typeof DESIGN_REVIEW_UNREADABLE_REASONS)[number];
/** What the item holds for the project's design review setting: nothing, a setting that parses, or something that is there and does not (never the same as nothing). */
export type StoredDesignReview = { kind: "missing" } | { kind: "ok"; setting: DesignReviewSetting } | { kind: "unreadable"; reason: DesignReviewUnreadableReason };

const isPlainMap = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Classifies a stored value that did not parse, by shape only (a fixed word; the value is never kept). */
function unreadableReasonOf(stored: unknown): DesignReviewUnreadableReason {
  if (!isPlainMap(stored)) return "wrong_type";
  const mode = stored["mode"];
  if (mode !== undefined && typeof mode !== "string") return "wrong_type";
  if (typeof mode === "string" && !(DESIGN_REVIEW_MODES as readonly string[]).includes(mode)) return "unknown_mode";
  return "invalid_shape";
}

/** Reads the `designReview` attribute with the one strict schema every writer uses. */
export function readStoredDesignReview(stored: unknown): StoredDesignReview {
  if (stored === undefined) return { kind: "missing" };
  const setting = DesignReviewSettingSchema.safeParse(stored);
  return setting.success ? { kind: "ok", setting: setting.data } : { kind: "unreadable", reason: unreadableReasonOf(stored) };
}

/**
 * The design review setting an item holds, for every read. None stored: none, which is Off. One that parses: itself. One that is there but
 * does not parse: ALSO Off, never Always or Auto, with `designReviewUnreadable` so the page can say so and the log says so. A maintainer choosing again replaces it.
 */
function storedDesignReview(item: Record<string, unknown> | undefined, orgId: OrgId, project: string): { designReview?: DesignReviewSetting; designReviewUnreadable: boolean } {
  const read = readStoredDesignReview(item?.["designReview"]);
  if (read.kind === "ok") return { designReview: read.setting, designReviewUnreadable: false };
  if (read.kind === "unreadable") {
    console.log(JSON.stringify({ component: "broker", event: "design_review.project_setting_unreadable", orgId, project, reason: read.reason }));
    return { designReviewUnreadable: true };
  }
  return { designReviewUnreadable: false };
}

/** A playbook with what its design review setting read as: `designReviewUnreadable` is true only for a stored value that could not be read (which reads as no setting, so Off). */
export interface ProjectPlaybookDetail { playbook: ProjectPlaybook; designReviewUnreadable: boolean }

function lenientPlaybook(item: Record<string, unknown> | undefined, revision: number, orgId: OrgId, project: string): ProjectPlaybookDetail {
  const { designReview, designReviewUnreadable } = storedDesignReview(item, orgId, project);
  return { playbook: { revision, defaultProcess: { kind: "builtin" }, ...(designReview === undefined ? {} : { designReview }) }, designReviewUnreadable };
}

function playbookOf(item: Record<string, unknown> | undefined, orgId: OrgId, project: string): ProjectPlaybookDetail | undefined {
  if (item === undefined) return { playbook: DEFAULT_PROJECT_PLAYBOOK, designReviewUnreadable: false };
  // A document written before the design review stage has no `designReview`: it has no setting, which reads as Off, never as an error.
  const parsed = ProjectPlaybookSchema.safeParse({ revision: item["revision"], defaultProcess: item["defaultProcess"] });
  if (!parsed.success) return undefined;
  const { designReview, designReviewUnreadable } = storedDesignReview(item, orgId, project);
  return { playbook: designReview === undefined ? parsed.data : { ...parsed.data, designReview }, designReviewUnreadable };
}

/** The playbook an item holds (see `readProjectPlaybookDetail` for `lenient`). Pure over the item, so a writer can decide from the very item it pins. */
function detailOfItem(item: Record<string, unknown> | undefined, orgId: OrgId, project: string, options: { lenient?: boolean }): ProjectPlaybookDetail {
  const found = playbookOf(item, orgId, project);
  if (found !== undefined) return found;
  const revision = item?.["revision"];
  if (options.lenient === true && typeof revision === "number" && Number.isInteger(revision) && revision >= 0) return lenientPlaybook(item, revision, orgId, project);
  throw agentXError("PROCESS_UNAVAILABLE", PROCESS_UNAVAILABLE_MESSAGE);
}

/**
 * The project's playbook, read fresh, with whether the stored design review setting could not be read (it then reads as Off). A project with no document has the built-in default. A document that is there but
 * cannot be read is `PROCESS_UNAVAILABLE`, never the built-in; `lenient` (the settings page and the write) still shows and replaces it.
 */
export async function readProjectPlaybookDetail(store: ProjectPlaybookReader, orgId: OrgId, project: string, options: { lenient?: boolean } = {}): Promise<ProjectPlaybookDetail> {
  return detailOfItem(await readItem(store, orgId, project), orgId, project, options);
}

/** The facts of `playbook.design_review_changed`: fixed words and counts. The people named as the approver are never in the event. */
export function designReviewAuditFacts(setting: DesignReviewSetting): { mode: DesignReviewSetting["mode"]; tier: DesignReviewSetting["tier"]; allowSkip: boolean; capCents: number; approverKind: DesignReviewSetting["highRiskApprover"]["kind"]; approverCount: number } {
  const approver = setting.highRiskApprover;
  return { mode: setting.mode, tier: setting.tier, allowSkip: setting.allowSkip, capCents: Math.round(setting.capUsdPerTask * 100), approverKind: approver.kind, approverCount: approver.kind === "people" ? approver.memberIds.length : approver.kind === "group" ? 1 : 0 };
}

/**
 * Saves the project's design review setting under the revision the caller read (`PLAYBOOK_STALE` for another), bumps the revision, keeps the default process as it is, holds the setting to the company's lock (read into
 * the same transaction as a condition, so a lock set meanwhile refuses the write) and records the change on the audit sink in that transaction. The setting is checked with the strict schema first: a value that would
 * read back as unreadable is never stored.
 */
export async function writeDesignReviewSetting(
  deps: ProjectPlaybookWriter, input: { orgId: OrgId; project: string; actorId: string; expectedRevision: number; designReview: DesignReviewSetting },
): Promise<ProjectPlaybook> {
  const { orgId, project } = input;
  const item = await readItem(deps, orgId, project);
  const detail = detailOfItem(item, orgId, project, { lenient: true });
  const current = detail.playbook;
  if (input.expectedRevision !== current.revision) throw agentXError("PLAYBOOK_STALE", PLAYBOOK_STALE_MESSAGE);
  const valid = DesignReviewSettingSchema.safeParse(input.designReview);
  if (!valid.success) throw agentXError("CONFIG_INVALID", `designReview${valid.error.issues[0] === undefined || valid.error.issues[0].path.length === 0 ? "" : `.${valid.error.issues[0].path.join(".")}`}: ${DESIGN_REVIEW_INVALID}`);
  const carried = valid.data;
  const lock = await readDesignReviewLock(deps, orgId);
  const check = checkDesignReviewWrite(carried, lock, false);
  if (!check.ok) {
    if (check.reason === "locked") throw agentXError("CONFIG_INVALID", `${check.fields.join(", ")}: ${DESIGN_REVIEW_LOCKED}`);
    throw agentXError("CONFIG_INVALID", `designReview: ${check.reason === "group_not_available" ? DESIGN_REVIEW_GROUP_EDITION : DESIGN_REVIEW_LOCK_UNREADABLE}`);
  }
  const lockCheck = lockRevisionCheck(orgId, lock);
  const approver = carried.highRiskApprover;
  if (approver.kind === "people") {
    if (deps.namedApproverCandidates === undefined) throw agentXError("CONFIG_INVALID", `designReview: ${DESIGN_REVIEW_NAMED_PEOPLE_UNCHECKED}`);
    const fold = (id: string): string => id.normalize("NFC").trim().toLowerCase();
    const allowed = new Set((await deps.namedApproverCandidates(orgId, project)).map(fold));
    if (approver.memberIds.some((id) => !allowed.has(fold(id)))) throw agentXError("CONFIG_INVALID", `designReview: ${DESIGN_REVIEW_NAMED_PEOPLE}`);
  }
  const applied: ProjectPlaybook = { revision: current.revision + 1, defaultProcess: current.defaultProcess, designReview: carried };
  const at = new Date(deps.now()).toISOString();
  const changed = canonicalJson(current.designReview ?? null) !== canonicalJson(applied.designReview ?? null);
  const auditSteps: readonly TransactItem[] = !changed || deps.audit === undefined ? [] : deps.audit.stage({
    eventId: `playbook.design_review_changed:${orgId}:${project}:${String(applied.revision)}`, companyId: orgId, at, actor: { type: "person", id: input.actorId }, action: "playbook.design_review_changed",
    subject: { type: "project", id: project }, details: { revision: applied.revision, ...designReviewAuditFacts(designReviewSettingOf(applied)) },
  });
  const written = await deps.transact([
    {
      kind: "put",
      item: { ...projectPlaybookKey(orgId, project), entityType: "PROJECT_PLAYBOOK", orgId, ...JSON.parse(JSON.stringify(applied)) as Record<string, never>, updatedAt: at, updatedBy: input.actorId },
      // The revision this writer read, and whether a `designReview` attribute is there as the read found it. The VALUE is not pinned: a stored value that does not round-trip must still be replaceable.
      condition: item === undefined ? when.absent() : when.and(when.eq("revision", current.revision), item["designReview"] === undefined ? when.notExists("designReview") : when.exists("designReview")),
    },
    ...(lockCheck === undefined ? [] : [lockCheck]),
    ...auditSteps,
  ]);
  if (!written.applied) throw agentXError("PLAYBOOK_STALE", PLAYBOOK_STALE_MESSAGE);
  return applied;
}

/**
 * Whether the company's lock refuses the design review setting a playbook file carries, as a sentence (field names only), or undefined when it holds. A READ: the page asks it to say why a file cannot be applied
 * without writing; `syncPlaybookFromFile` does the same check again inside its transaction.
 */
export async function designReviewFileRefusal(store: Pick<DocumentStore, "get">, orgId: OrgId, setting: DesignReviewSetting): Promise<string | undefined> {
  const check = checkDesignReviewWrite(setting, await readDesignReviewLock(store, orgId), false);
  if (check.ok) return undefined;
  return check.reason === "locked" ? `${check.fields.join(", ")}: ${DESIGN_REVIEW_LOCKED}` : `designReview: ${check.reason === "group_not_available" ? DESIGN_REVIEW_GROUP_EDITION : DESIGN_REVIEW_LOCK_UNREADABLE}`;
}

/** What a sync from the repository's playbook file did: nothing (the file is the one already stored), or a new revision of the item. */
export type PlaybookFileSyncResult = { kind: "unchanged"; playbook: ProjectPlaybook } | { kind: "written"; playbook: ProjectPlaybook };

/**
 * Makes the item say what the repository's playbook file says (`core/playbook`): the file's design review setting (none when the file has none, which drops one an earlier file set), and the file's digest beside it so
 * the same file is never written twice. It is the same write as `writeDesignReviewSetting` in everything that keeps a setting safe (the strict schema, the company's lock read into the transaction as a condition, the
 * revision pinned, the audit steps in the same transaction) and the default process is left as it is. A digest equal to the stored one is no change, and an item no file wrote (the hosted install's) is left alone while
 * there is no file. `fileDigest` is the one attribute Code adds; a hosted reader ignores it. Two syncs at once write once.
 */
export async function syncPlaybookFromFile(
  deps: ProjectPlaybookWriter, input: { orgId: OrgId; project: string; actorId: string; designReview: DesignReviewSetting | undefined; fileDigest: string | undefined },
): Promise<PlaybookFileSyncResult> {
  const { orgId, project } = input;
  for (let attempt = 0; ; attempt += 1) {
    const item = await readItem(deps, orgId, project);
    const detail = detailOfItem(item, orgId, project, { lenient: true });
    const current = detail.playbook;
    const storedDigest = typeof item?.["fileDigest"] === "string" ? item["fileDigest"] : undefined;
    if (storedDigest === input.fileDigest) return { kind: "unchanged", playbook: current };
    let carried: DesignReviewSetting | undefined;
    let lockCheck: TransactItem | undefined;
    if (input.designReview !== undefined) {
      const valid = DesignReviewSettingSchema.safeParse(input.designReview);
      if (!valid.success) throw agentXError("CONFIG_INVALID", `designReview${valid.error.issues[0] === undefined || valid.error.issues[0].path.length === 0 ? "" : `.${valid.error.issues[0].path.join(".")}`}: ${DESIGN_REVIEW_INVALID}`);
      carried = valid.data;
      const lock = await readDesignReviewLock(deps, orgId);
      const check = checkDesignReviewWrite(carried, lock, false);
      if (!check.ok) {
        if (check.reason === "locked") throw agentXError("CONFIG_INVALID", `${check.fields.join(", ")}: ${DESIGN_REVIEW_LOCKED}`);
        throw agentXError("CONFIG_INVALID", `designReview: ${check.reason === "group_not_available" ? DESIGN_REVIEW_GROUP_EDITION : DESIGN_REVIEW_LOCK_UNREADABLE}`);
      }
      lockCheck = lockRevisionCheck(orgId, lock);
      // Only maintainers can be the high-risk approver in a file: naming people is a hosted setting (the file reader refuses it first; this is the same fail-closed rule as the settings write).
      if (carried.highRiskApprover.kind === "people") throw agentXError("CONFIG_INVALID", `designReview: ${DESIGN_REVIEW_NAMED_PEOPLE_UNCHECKED}`);
    }
    const applied: ProjectPlaybook = { revision: current.revision + 1, defaultProcess: current.defaultProcess, ...(carried === undefined ? {} : { designReview: carried }) };
    const at = new Date(deps.now()).toISOString();
    const droppedUnreadable = detail.designReviewUnreadable && carried === undefined;
    const designChanged = droppedUnreadable || canonicalJson(current.designReview ?? null) !== canonicalJson(applied.designReview ?? null);
    const actor = { type: "system" as const, id: input.actorId };
    const auditSteps: readonly TransactItem[] = deps.audit === undefined ? [] : [
      ...deps.audit.stage({ eventId: `playbook.file_changed:${orgId}:${project}:${String(applied.revision)}`, companyId: orgId, at, actor, action: "playbook.file_changed", subject: { type: "project", id: project }, details: { revision: applied.revision, filePresent: input.fileDigest !== undefined } }),
      ...(!designChanged ? [] : deps.audit.stage({
        eventId: `playbook.design_review_changed:${orgId}:${project}:${String(applied.revision)}`, companyId: orgId, at, actor, action: "playbook.design_review_changed",
        subject: { type: "project", id: project }, details: { revision: applied.revision, ...designReviewAuditFacts(droppedUnreadable ? { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "never" } : designReviewSettingOf(applied)) },
      })),
    ];
    const written = await deps.transact([
      {
        kind: "put",
        item: { ...projectPlaybookKey(orgId, project), entityType: "PROJECT_PLAYBOOK", orgId, ...JSON.parse(JSON.stringify(applied)) as Record<string, never>, ...(input.fileDigest === undefined ? {} : { fileDigest: input.fileDigest }), updatedAt: at, updatedBy: input.actorId },
        condition: item === undefined ? when.absent() : when.and(when.eq("revision", current.revision), item["designReview"] === undefined ? when.notExists("designReview") : when.exists("designReview")),
      },
      ...(lockCheck === undefined ? [] : [lockCheck]),
      ...auditSteps,
    ]);
    if (written.applied) return { kind: "written", playbook: applied };
    // Another writer moved it first: read it again, and stop when it already says what the file says.
    if (attempt >= 2) throw agentXError("PLAYBOOK_STALE", PLAYBOOK_STALE_MESSAGE);
  }
}

export { DESIGN_REVIEW_DEFAULT_SETTING };
