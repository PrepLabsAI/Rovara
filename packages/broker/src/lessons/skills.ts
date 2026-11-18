// Rovara skills (L4-AK3, owner decision 2026-11-17): a procedure the team proved, kept as versioned rows in Rovara's own store (one partition per company and project: `SKILL#<project>`), made from a proven procedure lesson
// by CODE (no model call), approved by TWO different people, and served to a step beside the meta repo's skills (`worker/src/knowledge/skills.ts`). Text only: it grants nothing.
//
// The rows (all under the company's partition; nothing here reads another company's or project's):
//   head#<name>          one per skill: the newest version, the version that is live (if any), the lessons it was made from, retired or not
//   v#<name>#<version>   append-only, never changed except by adding approvals: the text, its digest, who approved it. A task keeps the version it was sent (it is sent the text and the digest)
//   set                  the live skills as `name -> version`, so a reader that can only `get` (the dispatcher) finds them with one read
// Rules:
//   - a draft is made only from an ACTIVE procedure lesson that is PROVEN (`provenProcedure`), project-wide in audience, by a person who may decide lessons for the project; the lesson's words are used as they are;
//   - every edit is a NEW version with no approvals (the live version stays live until the new one has two); a version needs `ROVARA_SKILL_APPROVERS_REQUIRED` DIFFERENT eligible people (the same person twice is one);
//     approvals are given for one version and apply only if it is still the newest (a person approves the text they read);
//   - the text is at most 32 KB (the meta repo's limit); over 8 KB the person is told "this is long, consider splitting" (nothing is refused for it); a pre-run line (!`cmd`) or an `allowed-tools` line is refused;
//   - every change is audited BEFORE it is made (no record, no change); the audit holds the skill's name and version and counts, never its text;
//   - when a skill goes live the lessons it came from are retired ("became a skill"), so they are not loaded again.
import { createHash } from "node:crypto";
import {
  ROVARA_SKILL_APPROVERS_REQUIRED, ROVARA_SKILL_DESCRIPTION_MAX, ROVARA_SKILL_LONG_NOTE, ROVARA_SKILL_LONG_NOTE_BYTES, ROVARA_SKILL_NAME, ROVARA_SKILL_PROVEN, ROVARA_SKILL_TEXT_MAX_BYTES, ROVARA_SKILLS_PAYLOAD_BYTES_MAX,
  ROVARA_SKILLS_PER_STEP_MAX, change, cleanLessonText, companyScoped, queryAll, when, type DocumentStore, type JsonValue, type RovaraSkillFile, type StoredDocument, type TransactItem,
} from "@agentx/contracts";
import { retireLesson } from "./curate.js";
import { hasStaleCitation } from "./load.js";
import { requireAudit } from "./policy.js";
import type { LessonAuditSink, ApproverDirectory } from "./ports.js";
import { readVisible } from "./read-visible.js";
import type { AccessCheckPort } from "./access-port.js";
import type { LessonStore, ScopeKey } from "./store.js";
import { independentSources } from "./value.js";
import { countLessonUses } from "./use-count.js";
import { idIn, sameId, type Lesson } from "./types.js";

const DAY_MS = 86_400_000;

export interface SkillDeps {
  documents: DocumentStore; lessons: LessonStore; directory: ApproverDirectory; audit: LessonAuditSink; access: AccessCheckPort; now: () => number;
  /** Where a retired lesson's vector is dropped (`retireLesson`). */
  vectors?: Parameters<typeof retireLesson>[0]["vectors"];
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

// ---- keys and rows

const headKey = (companyId: string, project: string, name: string) => ({ pk: companyScoped(companyId, `SKILL#${project}`), sk: `head#${name}` });
const versionKey = (companyId: string, project: string, name: string, version: number) => ({ pk: companyScoped(companyId, `SKILL#${project}`), sk: `v#${name}#${String(version).padStart(6, "0")}` });
const setKey = (companyId: string, project: string) => ({ pk: companyScoped(companyId, `SKILL#${project}`), sk: "set" });

export interface SkillHead { name: string; currentVersion: number; activeVersion?: number; retired: boolean; fromLessons: string[]; createdBy: string; createdAt: number; updatedAt: number }
export interface SkillVersion { name: string; version: number; description: string; content: string; digest: string; bytes: number; approvals: Array<{ by: string; at: number }>; createdBy: string; createdAt: number; activatedAt?: number }

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const str = (value: unknown, max = 64_000): string | undefined => (typeof value === "string" && value.length <= max ? value : undefined);
const int = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined);

/** A head row read back, or undefined when it is not shaped like one (never guessed). */
function headOf(row: StoredDocument | undefined): SkillHead | undefined {
  if (row === undefined || row["entityType"] !== "SKILL_HEAD") return undefined;
  const name = str(row["name"], 64);
  const currentVersion = int(row["currentVersion"]);
  const createdBy = str(row["createdBy"], 100);
  const createdAt = int(row["createdAt"]);
  const updatedAt = int(row["updatedAt"]);
  const from = row["fromLessons"];
  if (name === undefined || !ROVARA_SKILL_NAME.test(name) || currentVersion === undefined || currentVersion < 1 || createdBy === undefined || createdAt === undefined || updatedAt === undefined || !Array.isArray(from) || from.some((id) => typeof id !== "string")) return undefined;
  const active = row["activeVersion"] === undefined ? undefined : int(row["activeVersion"]);
  if (row["activeVersion"] !== undefined && (active === undefined || active < 1)) return undefined;
  return { name, currentVersion, ...(active === undefined ? {} : { activeVersion: active }), retired: row["retired"] === true, fromLessons: from as string[], createdBy, createdAt, updatedAt };
}

function versionOf(row: StoredDocument | undefined): SkillVersion | undefined {
  if (row === undefined || row["entityType"] !== "SKILL_VERSION") return undefined;
  const name = str(row["name"], 64);
  const version = int(row["version"]);
  const description = str(row["description"], 400);
  const content = str(row["content"], ROVARA_SKILL_TEXT_MAX_BYTES * 2);
  const digest = str(row["digest"], 64);
  const bytes = int(row["bytes"]);
  const createdBy = str(row["createdBy"], 100);
  const createdAt = int(row["createdAt"]);
  const approvals = row["approvals"];
  if (name === undefined || version === undefined || version < 1 || description === undefined || content === undefined || digest === undefined || !/^[a-f0-9]{64}$/u.test(digest) || bytes === undefined || createdBy === undefined || createdAt === undefined) return undefined;
  if (!Array.isArray(approvals) || approvals.length > 10) return undefined;
  const parsed: Array<{ by: string; at: number }> = [];
  for (const entry of approvals) {
    const by = entry !== null && typeof entry === "object" && !Array.isArray(entry) ? str((entry as Record<string, JsonValue>)["by"], 100) : undefined;
    const at = entry !== null && typeof entry === "object" && !Array.isArray(entry) ? int((entry as Record<string, JsonValue>)["at"]) : undefined;
    if (by === undefined || at === undefined) return undefined;
    parsed.push({ by, at });
  }
  const activatedAt = row["activatedAt"] === undefined ? undefined : int(row["activatedAt"]);
  return { name, version, description, content, digest, bytes, approvals: parsed, createdBy, createdAt, ...(activatedAt === undefined ? {} : { activatedAt }) };
}

const headRow = (companyId: string, project: string, head: SkillHead): StoredDocument => ({
  ...headKey(companyId, project, head.name), entityType: "SKILL_HEAD", name: head.name, currentVersion: head.currentVersion, ...(head.activeVersion === undefined ? {} : { activeVersion: head.activeVersion }),
  ...(head.retired ? { retired: true } : {}), fromLessons: head.fromLessons, createdBy: head.createdBy, createdAt: head.createdAt, updatedAt: head.updatedAt,
});
const versionRow = (companyId: string, project: string, v: SkillVersion): StoredDocument => ({
  ...versionKey(companyId, project, v.name, v.version), entityType: "SKILL_VERSION", name: v.name, version: v.version, description: v.description, content: v.content, digest: v.digest, bytes: v.bytes,
  approvals: v.approvals, createdBy: v.createdBy, createdAt: v.createdAt, ...(v.activatedAt === undefined ? {} : { activatedAt: v.activatedAt }),
});

// ---- the text

/** The pre-run syntax and the tool grant a skill may never hold (the worker removes both again when it loads one). */
const EXECUTION = /!`[^`\n]*`|^[ \t]*allowed-tools[ \t]*:/imu;
export interface SkillForm { name: string; description: string; when: string; steps: readonly string[]; doneWhen?: string | undefined; why?: string | undefined }
export const SKILL_STEPS_MAX = 12;
/** The longest one step, and one of the other paragraphs, may be (characters). Generous on purpose: the size rule that decides is the whole text's (`checkSkillText`). */
export const SKILL_STEP_CHARS_MAX = 4_000;
export const SKILL_NOTE_CHARS_MAX = 2_000;

/** A skill's SKILL.md, made by code from the form: the front matter (name and description), when to use it, the numbered steps, how to know it is done and why this order. Never a tool list. */
export function renderSkill(form: SkillForm): string {
  const line = (text: string, max: number): string => cleanLessonText(text, max).replace(/\s*\n\s*/gu, " ");
  const steps = form.steps.map((step) => line(step, SKILL_STEP_CHARS_MAX)).filter((step) => step !== "");
  return [
    "---", `name: ${form.name}`, `description: ${line(form.description, ROVARA_SKILL_DESCRIPTION_MAX)}`, "---", "",
    "## When to use", line(form.when, SKILL_NOTE_CHARS_MAX), "",
    "## Steps", ...steps.map((step, index) => `${String(index + 1)}. ${step}`), "",
    ...(form.doneWhen === undefined || line(form.doneWhen, SKILL_NOTE_CHARS_MAX) === "" ? [] : ["## Done when", line(form.doneWhen, SKILL_NOTE_CHARS_MAX), ""]),
    ...(form.why === undefined || line(form.why, SKILL_NOTE_CHARS_MAX) === "" ? [] : ["## Why this order", line(form.why, SKILL_NOTE_CHARS_MAX), ""]),
  ].join("\n");
}

/** The slug a lesson's title makes (lowercase letters, digits and single hyphens, at most 48 characters), or "skill" when nothing is left. */
export function slugOf(title: string): string {
  const slug = cleanLessonText(title, 200).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48).replace(/-+$/u, "");
  return slug === "" ? "skill" : slug;
}

/**
 * The numbered steps of a lesson's body, with its "When ...:" lead taken out. Steps are found as numbers 1, 2, 3 ... in order, either one to a line (`1. ...`, `2) ...`) or in one paragraph (`1. do a 2. do b`); numbers that
 * do not run 1, 2, 3 in order are not steps. A body with no numbered steps is ONE step (its own words), never rewritten or invented.
 */
export function stepsOfBody(body: string): { when: string; steps: string[] } {
  const text = body.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trim()).filter((line) => line !== "").join("\n");
  const lead = /^When\s+(.{1,300}?):\s*([\s\S]*)$/isu.exec(text);
  const when = lead === null ? "" : lead[1]!.trim();
  const rest = (lead === null ? text : lead[2]!).trim();
  const markers = [...rest.matchAll(/(?:^|\s)\(?(\d{1,2})[.)]\s+/gu)];
  // The markers that count run 1, 2, 3 ... from the first one found: a stray "5. " in a sentence does not start a step.
  const counted: Array<{ index: number; length: number }> = [];
  for (const marker of markers) if (Number(marker[1]) === counted.length + 1) counted.push({ index: marker.index, length: marker[0].length });
  if (counted.length > 0 && counted[0] !== undefined) {
    const steps = counted.map((marker, position) => rest.slice(marker.index + marker.length, counted[position + 1]?.index ?? rest.length).replace(/\s*\n\s*/gu, " ").trim()).filter((step) => step !== "");
    if (steps.length > 0) return { when, steps: steps.slice(0, SKILL_STEPS_MAX) };
  }
  const single = rest.replace(/\s*\n\s*/gu, " ").trim();
  return { when, steps: single === "" ? [] : [single] };
}

/** What the text of a skill comes to: refused (too large or holds an execution line), or kept with a gentle note when it is long. */
export type SkillTextCheck = { ok: true; bytes: number; note?: typeof ROVARA_SKILL_LONG_NOTE } | { ok: false; code: "too_large" | "execution_line" | "empty" };
export function checkSkillText(content: string): SkillTextCheck {
  const bytes = Buffer.byteLength(content, "utf8");
  if (content.trim() === "") return { ok: false, code: "empty" };
  if (bytes > ROVARA_SKILL_TEXT_MAX_BYTES) return { ok: false, code: "too_large" };
  if (EXECUTION.test(content)) return { ok: false, code: "execution_line" };
  return { ok: true, bytes, ...(bytes > ROVARA_SKILL_LONG_NOTE_BYTES ? { note: ROVARA_SKILL_LONG_NOTE } : {}) };
}

// ---- proof

export interface ProvenInput { lesson: Lesson; tasks: number | undefined; now: number }
/**
 * A procedure lesson that has proved itself (design 6.3, start values `ROVARA_SKILL_PROVEN`): live and approved by a person (not on trial), used in at least 10 tasks (counted, never guessed: an uncounted lesson is not
 * proven), at least 30 days old, never marked wrong, no retire asked for, every citation still good, and two independent people behind it (or one person and a measured result). Pure.
 */
export function provenProcedure(input: ProvenInput): boolean {
  const { lesson, tasks, now } = input;
  if (lesson.type !== "procedure" || lesson.status !== "active" || lesson.trial !== undefined || lesson.reviewRequired === true) return false;
  if (lesson.approvals.length === 0 || lesson.provenance.audience.kind !== "project" || hasStaleCitation(lesson)) return false;
  if (lesson.counters.harmful > 0 || lesson.counters.citationStale > 0 || lesson.retireProposedAt !== undefined || lesson.possibleDuplicateOf !== undefined || lesson.contradictsWith !== undefined) return false;
  if (tasks === undefined || tasks < ROVARA_SKILL_PROVEN.tasks || now - lesson.createdAt < ROVARA_SKILL_PROVEN.days * DAY_MS) return false;
  return independentSources(lesson.provenance) >= 2 || (independentSources(lesson.provenance) >= 1 && lesson.provenance.measured);
}

export interface SkillOffer { lessonId: string; title: string; tasks: number; days: number }
/** The "Make this a skill?" cards: the project's proven procedure lessons that no skill was made from. Counts only the active procedure lessons given (so one count call is bounded), at most `max` offers. */
export async function skillOffers(deps: Pick<SkillDeps, "documents" | "lessons" | "now">, key: ScopeKey, options: { max?: number } = {}): Promise<SkillOffer[]> {
  const max = options.max ?? 20;
  const active = (await deps.lessons.list(key, { statuses: ["active"] })).filter((lesson) => lesson.type === "procedure" && lesson.trial === undefined && lesson.expiresAt > deps.now());
  if (active.length === 0) return [];
  const used = new Set((await queryAll(deps.documents, { pk: companyScoped(key.workspaceId, `SKILL#${key.project}`), sk: { op: "beginsWith", prefix: "head#" } })).flatMap((row) => headOf(row)?.fromLessons ?? []));
  const open = active.filter((lesson) => !used.has(lesson.id)).slice(0, 50);
  if (open.length === 0) return [];
  const counts = await countLessonUses(deps.documents, { companyId: key.workspaceId, project: key.project, lessonIds: open.map((lesson) => lesson.id), now: deps.now() });
  return open.flatMap((lesson) => {
    const count = counts.counts.get(lesson.id);
    return provenProcedure({ lesson, tasks: count?.tasks, now: deps.now() }) ? [{ lessonId: lesson.id, title: lesson.title, tasks: count!.tasks, days: Math.floor((deps.now() - lesson.createdAt) / DAY_MS) }] : [];
  }).slice(0, max);
}

// ---- who may act

type Fail<C extends string> = { ok: false; code: C };
const eligible = async (deps: SkillDeps, key: ScopeKey, person: string): Promise<boolean | undefined> => {
  const group = await deps.directory.eligibility(key.workspaceId, key.project, { approverId: person }).catch(() => undefined);
  if (group === undefined || !group.complete) return undefined;
  return idIn(group.eligibleIds, person);
};

export type DraftResult =
  | { ok: true; name: string; version: 1; note?: typeof ROVARA_SKILL_LONG_NOTE }
  | Fail<"not_found" | "not_proven" | "not_eligible" | "eligibility_unavailable" | "already_a_skill" | "audit_unavailable" | "unreadable" | "not_project_wide" | "bad_name" | SkillTextFailure>;
type SkillTextFailure = Extract<SkillTextCheck, { ok: false }>["code"] | "too_many_steps";

/**
 * A skill's first draft, from a proven procedure lesson, by a person who may decide lessons for the project (the "Make this a skill?" card's button). Words are the lesson's own; nothing is invented and no model is asked.
 * `name` (a slug) is optional; left out, it is made from the lesson's title (and a short suffix when that name is taken).
 */
export async function draftSkillFromLesson(deps: SkillDeps, key: ScopeKey, input: { lessonId: string; by: string; name?: string | undefined }): Promise<DraftResult> {
  const who = await eligible(deps, key, input.by);
  if (who === undefined) return { ok: false, code: "eligibility_unavailable" };
  if (!who) return { ok: false, code: "not_eligible" };
  let lesson: Lesson | undefined;
  let tasks: number | undefined;
  try {
    lesson = await deps.lessons.get(key, input.lessonId);
    if (lesson === undefined) return { ok: false, code: "not_found" };
    const counted = await countLessonUses(deps.documents, { companyId: key.workspaceId, project: key.project, lessonIds: [lesson.id], now: deps.now() });
    tasks = counted.counts.get(lesson.id)?.tasks;
    // The lesson is read as for NOBODY in particular (what the whole project may read): a lesson from a private place or a task kept private does not become a project's skill.
    const visible = await readVisible({ access: deps.access, key, viewer: undefined, lessons: [lesson], where: "skills", ...(deps.log === undefined ? {} : { log: deps.log }) });
    if (visible.length === 0) return { ok: false, code: "not_project_wide" };
  } catch { return { ok: false, code: "unreadable" }; }
  if (!provenProcedure({ lesson, tasks, now: deps.now() })) return { ok: false, code: "not_proven" };
  let existing: StoredDocument[];
  try { existing = await queryAll(deps.documents, { pk: companyScoped(key.workspaceId, `SKILL#${key.project}`), sk: { op: "beginsWith", prefix: "head#" } }); } catch { return { ok: false, code: "unreadable" }; }
  const heads = existing.flatMap((row) => { const head = headOf(row); return head === undefined ? [] : [head]; });
  if (heads.some((head) => head.fromLessons.includes(lesson.id) && !head.retired)) return { ok: false, code: "already_a_skill" };
  const taken = new Set(heads.map((head) => head.name));
  const wanted = input.name === undefined ? slugOf(lesson.title) : input.name;
  if (!ROVARA_SKILL_NAME.test(wanted)) return { ok: false, code: "bad_name" };
  // A name the person chose that is taken is refused; a name made from the title that is taken gets a short suffix from the lesson's id.
  const suffix = lesson.id.replace(/[^a-z0-9]/giu, "").toLowerCase();
  const candidates = input.name === undefined ? [wanted, ...[4, 8].map((length) => `${wanted.slice(0, 56)}-${suffix.slice(0, length)}`)] : [wanted];
  const name = candidates.find((candidate) => !taken.has(candidate));
  if (name === undefined) return { ok: false, code: "bad_name" };
  const { when: lead, steps } = stepsOfBody(lesson.body);
  const form: SkillForm = { name, description: lesson.description === "" ? lesson.title : `${lesson.title}. ${lesson.description}`, when: lead === "" ? "the change this lesson is about" : lead, steps, why: lesson.description === "" ? undefined : lesson.description };
  return createSkill(deps, key, { name, form, fromLessons: [lesson.id], by: input.by });
}

async function createSkill(deps: SkillDeps, key: ScopeKey, input: { name: string; form: SkillForm; fromLessons: string[]; by: string }): Promise<DraftResult> {
  const content = renderSkill(input.form);
  const checked = checkSkillText(content);
  if (!checked.ok) return { ok: false, code: checked.code };
  if (input.form.steps.length === 0) return { ok: false, code: "empty" };
  if (input.form.steps.length > SKILL_STEPS_MAX) return { ok: false, code: "too_many_steps" };
  const now = deps.now();
  if (!await requireAudit(deps.audit, { action: "lesson.skill_drafted", workspaceId: key.workspaceId, project: key.project, actor: input.by, facts: { skill: input.name, version: 1 } })) return { ok: false, code: "audit_unavailable" };
  const head: SkillHead = { name: input.name, currentVersion: 1, retired: false, fromLessons: input.fromLessons, createdBy: input.by, createdAt: now, updatedAt: now };
  const version: SkillVersion = { name: input.name, version: 1, description: cleanLessonText(input.form.description, ROVARA_SKILL_DESCRIPTION_MAX).replace(/\s*\n\s*/gu, " "), content, digest: sha256(content), bytes: checked.bytes, approvals: [], createdBy: input.by, createdAt: now };
  try {
    const written = await deps.documents.transact([
      { kind: "put", item: headRow(key.workspaceId, key.project, head), condition: when.absent() },
      { kind: "put", item: versionRow(key.workspaceId, key.project, version), condition: when.absent() },
    ]);
    if (!written.applied) return { ok: false, code: "bad_name" };
  } catch { return { ok: false, code: "unreadable" }; }
  return { ok: true, name: input.name, version: 1, ...(checked.note === undefined ? {} : { note: checked.note }) };
}

export type EditResult = { ok: true; version: number; note?: typeof ROVARA_SKILL_LONG_NOTE } | Fail<"not_found" | "not_eligible" | "eligibility_unavailable" | "conflict" | "audit_unavailable" | "unreadable" | "retired" | SkillTextFailure>;
/** A person's edit of a skill: a NEW version from the form, with no approvals. `expectedVersion` is the newest version the person read (an edit of an older one is a conflict). The live version stays live until the new one has its approvals. */
export async function editSkill(deps: SkillDeps, key: ScopeKey, input: { name: string; by: string; expectedVersion: number; form: Omit<SkillForm, "name"> }): Promise<EditResult> {
  if (!ROVARA_SKILL_NAME.test(input.name)) return { ok: false, code: "not_found" };
  const who = await eligible(deps, key, input.by);
  if (who === undefined) return { ok: false, code: "eligibility_unavailable" };
  if (!who) return { ok: false, code: "not_eligible" };
  let head: SkillHead | undefined;
  try { head = headOf(await deps.documents.get(headKey(key.workspaceId, key.project, input.name))); } catch { return { ok: false, code: "unreadable" }; }
  if (head === undefined) return { ok: false, code: "not_found" };
  if (head.retired) return { ok: false, code: "retired" };
  if (head.currentVersion !== input.expectedVersion) return { ok: false, code: "conflict" };
  const content = renderSkill({ ...input.form, name: input.name });
  const checked = checkSkillText(content);
  if (!checked.ok) return { ok: false, code: checked.code };
  if (input.form.steps.length === 0) return { ok: false, code: "empty" };
  if (input.form.steps.length > SKILL_STEPS_MAX) return { ok: false, code: "too_many_steps" };
  const next = head.currentVersion + 1;
  if (!await requireAudit(deps.audit, { action: "lesson.skill_edited", workspaceId: key.workspaceId, project: key.project, actor: input.by, facts: { skill: input.name, version: next } })) return { ok: false, code: "audit_unavailable" };
  const now = deps.now();
  const version: SkillVersion = { name: input.name, version: next, description: cleanLessonText(input.form.description, ROVARA_SKILL_DESCRIPTION_MAX).replace(/\s*\n\s*/gu, " "), content, digest: sha256(content), bytes: checked.bytes, approvals: [], createdBy: input.by, createdAt: now };
  try {
    const written = await deps.documents.transact([
      { kind: "put", item: versionRow(key.workspaceId, key.project, version), condition: when.absent() },
      { kind: "update", key: headKey(key.workspaceId, key.project, input.name), ops: [change.set("currentVersion", next), change.set("updatedAt", now)], condition: when.and(when.eq("currentVersion", head.currentVersion), when.notExists("retired")) },
    ]);
    if (!written.applied) return { ok: false, code: "conflict" };
  } catch { return { ok: false, code: "unreadable" }; }
  return { ok: true, version: next, ...(checked.note === undefined ? {} : { note: checked.note }) };
}

export type ApproveSkillResult = { ok: true; approvals: number; live: boolean } | Fail<"not_found" | "not_eligible" | "eligibility_unavailable" | "not_newest" | "already_live" | "already_approved" | "audit_unavailable" | "conflict" | "unreadable" | "retired">;
/**
 * One person's approval of one version of a skill. The version must be the newest (a person approves the text they read) and the person must be eligible NOW. A second approval by the same person changes nothing
 * (`already_approved`). The approval that makes `ROVARA_SKILL_APPROVERS_REQUIRED` different people takes the version live in the same transaction (the skill's live pointer and the `set` row), and the lessons it came
 * from are retired after it. Each approval is audited before it is written.
 */
export async function approveSkill(deps: SkillDeps, key: ScopeKey, input: { name: string; version: number; by: string }): Promise<ApproveSkillResult> {
  if (!ROVARA_SKILL_NAME.test(input.name)) return { ok: false, code: "not_found" };
  const who = await eligible(deps, key, input.by);
  if (who === undefined) return { ok: false, code: "eligibility_unavailable" };
  if (!who) return { ok: false, code: "not_eligible" };
  let head: SkillHead | undefined;
  let version: SkillVersion | undefined;
  try {
    head = headOf(await deps.documents.get(headKey(key.workspaceId, key.project, input.name)));
    version = versionOf(await deps.documents.get(versionKey(key.workspaceId, key.project, input.name, input.version)));
  } catch { return { ok: false, code: "unreadable" }; }
  if (head === undefined || version === undefined) return { ok: false, code: "not_found" };
  if (head.retired) return { ok: false, code: "retired" };
  if (head.currentVersion !== input.version) return { ok: false, code: "not_newest" };
  if (head.activeVersion === input.version) return { ok: false, code: "already_live" };
  if (version.approvals.some((entry) => sameId(entry.by, input.by))) return { ok: false, code: "already_approved" };
  // An approval counts only while its giver may still decide (as for a lesson's): one who has left the project, lost the role or been erased is not one of the two.
  const group = await deps.directory.eligibility(key.workspaceId, key.project, { approverId: input.by }).catch(() => undefined);
  if (group === undefined || !group.complete) return { ok: false, code: "eligibility_unavailable" };
  const approvals = [...version.approvals.filter((entry) => idIn(group.eligibleIds, entry.by)), { by: input.by, at: deps.now() }];
  const live = approvals.length >= ROVARA_SKILL_APPROVERS_REQUIRED;
  if (!await requireAudit(deps.audit, { action: "lesson.skill_approved", workspaceId: key.workspaceId, project: key.project, actor: input.by, facts: { skill: input.name, version: input.version, approvals: approvals.length } })) return { ok: false, code: "audit_unavailable" };
  if (live && !await requireAudit(deps.audit, { action: "lesson.skill_activated", workspaceId: key.workspaceId, project: key.project, actor: input.by, facts: { skill: input.name, version: input.version, approvals: approvals.length } })) return { ok: false, code: "audit_unavailable" };
  const now = deps.now();
  const headStillNewest = when.and(when.eq("currentVersion", input.version), when.notExists("retired"));
  const approvalStep: TransactItem = { kind: "update", key: versionKey(key.workspaceId, key.project, input.name, input.version), ops: [change.set("approvals", approvals), ...(live ? [change.set("activatedAt", now)] : [])], condition: when.eq("approvals", version.approvals) };
  try {
    // Not live yet: the approval is written only while the version is still the newest. Live: the same transaction moves the skill's live pointer and the `set` row (created first if it is not there; a lost race on that
    // create still leaves the row there).
    if (live) await deps.documents.put({ item: { ...setKey(key.workspaceId, key.project), entityType: "SKILL_SET", members: {}, updatedAt: now }, condition: when.absent() });
    const written = await deps.documents.transact(live
      ? [approvalStep, { kind: "update", key: headKey(key.workspaceId, key.project, input.name), ops: [change.set("activeVersion", input.version), change.set("updatedAt", now)], condition: headStillNewest }, { kind: "update", key: setKey(key.workspaceId, key.project), ops: [change.set(["members", input.name], input.version), change.set("updatedAt", now)] }]
      : [approvalStep, { kind: "check", key: headKey(key.workspaceId, key.project, input.name), condition: headStillNewest }]);
    if (!written.applied) return { ok: false, code: "conflict" };
  } catch { return { ok: false, code: "unreadable" }; }
  if (live) {
    // The lessons it came from leave the load set ("became a skill"): best effort, and a lesson that stays is a repeat, never a gap.
    for (const id of head.fromLessons) {
      try { await retireLesson({ now: deps.now, audit: deps.audit, store: deps.lessons, ...(deps.vectors === undefined ? {} : { vectors: deps.vectors }) }, key, id, "became_skill", input.by); } catch { deps.log?.("skills.source_lesson_retire_failed", {}); }
    }
  }
  return { ok: true, approvals: approvals.length, live };
}

export type RetireSkillResult = { ok: true } | Fail<"not_found" | "not_eligible" | "eligibility_unavailable" | "audit_unavailable" | "unreadable" | "conflict">;
/** A person who may decide lessons retires a skill: it leaves the live set at once (the next step is sent without it) and its versions stay as they were. */
export async function retireSkill(deps: SkillDeps, key: ScopeKey, input: { name: string; by: string }): Promise<RetireSkillResult> {
  if (!ROVARA_SKILL_NAME.test(input.name)) return { ok: false, code: "not_found" };
  const who = await eligible(deps, key, input.by);
  if (who === undefined) return { ok: false, code: "eligibility_unavailable" };
  if (!who) return { ok: false, code: "not_eligible" };
  let head: SkillHead | undefined;
  try { head = headOf(await deps.documents.get(headKey(key.workspaceId, key.project, input.name))); } catch { return { ok: false, code: "unreadable" }; }
  if (head === undefined) return { ok: false, code: "not_found" };
  if (!await requireAudit(deps.audit, { action: "lesson.skill_retired", workspaceId: key.workspaceId, project: key.project, actor: input.by, facts: { skill: input.name, version: head.activeVersion ?? head.currentVersion } })) return { ok: false, code: "audit_unavailable" };
  const now = deps.now();
  try {
    // The live set's member is removed whether or not this read saw the skill live: a second approval that went live between the read and this write would otherwise leave a retired skill in use. The `set` row is made
    // first when it is not there (the update needs its parent map).
    await deps.documents.put({ item: { ...setKey(key.workspaceId, key.project), entityType: "SKILL_SET", members: {}, updatedAt: now }, condition: when.absent() });
    const written = await deps.documents.transact([
      { kind: "update", key: headKey(key.workspaceId, key.project, input.name), ops: [change.set("retired", true), change.set("updatedAt", now)] },
      { kind: "update", key: setKey(key.workspaceId, key.project), ops: [change.remove(["members", input.name]), change.set("updatedAt", now)] },
    ]);
    if (!written.applied) return { ok: false, code: "conflict" };
  } catch { return { ok: false, code: "unreadable" }; }
  return { ok: true };
}

// ---- reading

export interface SkillSummary { name: string; description: string; currentVersion: number; activeVersion?: number; approvals: number; approvers: string[]; retired: boolean; bytes: number; note?: typeof ROVARA_SKILL_LONG_NOTE }
/** The project's skills for a person who decides: the newest version of each, how many have approved it and who (ids), and the long-skill note. Never another project's or company's. */
export async function listSkills(deps: Pick<SkillDeps, "documents">, key: ScopeKey): Promise<SkillSummary[]> {
  const rows = await queryAll(deps.documents, { pk: companyScoped(key.workspaceId, `SKILL#${key.project}`), sk: { op: "beginsWith", prefix: "head#" } });
  const out: SkillSummary[] = [];
  for (const row of rows) {
    const head = headOf(row);
    if (head === undefined) continue;
    const version = versionOf(await deps.documents.get(versionKey(key.workspaceId, key.project, head.name, head.currentVersion)));
    if (version === undefined) continue;
    out.push({ name: head.name, description: version.description, currentVersion: head.currentVersion, ...(head.activeVersion === undefined ? {} : { activeVersion: head.activeVersion }), approvals: version.approvals.length, approvers: version.approvals.map((entry) => entry.by), retired: head.retired, bytes: version.bytes, ...(version.bytes > ROVARA_SKILL_LONG_NOTE_BYTES ? { note: ROVARA_SKILL_LONG_NOTE } : {}) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface LiveSkills { skills: RovaraSkillFile[]; /** Skills that were live but could not be sent (unreadable, or a text that does not match its digest, or past the step's limits): they are named by count only. */ left: number }
/**
 * The skills a step may be sent: the project's LIVE skills (the `set` row, read with `get` only), each read at its live version, its digest checked against its text, ranked (a skill whose lesson scope paths match a
 * file in play first, then the rest by name) and cut at `ROVARA_SKILLS_PER_STEP_MAX` skills and `ROVARA_SKILLS_PAYLOAD_BYTES_MAX` bytes: a skill past either is not sent at all (never half a skill). Reads only this company's
 * and project's partition. A fault anywhere is "none": a step never waits on a skill.
 */
export async function liveSkillsForStep(store: Pick<DocumentStore, "get">, key: ScopeKey, options: { appliesTo?: ((name: string) => number) | undefined } = {}): Promise<LiveSkills> {
  const set = await store.get(setKey(key.workspaceId, key.project));
  if (set === undefined || set["entityType"] !== "SKILL_SET" || set["members"] === null || typeof set["members"] !== "object" || Array.isArray(set["members"])) return { skills: [], left: 0 };
  const members = Object.entries(set["members"] as Record<string, JsonValue>).filter((entry): entry is [string, number] => ROVARA_SKILL_NAME.test(entry[0]) && typeof entry[1] === "number" && Number.isInteger(entry[1]) && entry[1] >= 1).slice(0, 64);
  const found: RovaraSkillFile[] = [];
  let left = 0;
  for (const [name, versionNumber] of members.sort((a, b) => (options.appliesTo?.(b[0]) ?? 0) - (options.appliesTo?.(a[0]) ?? 0) || a[0].localeCompare(b[0]))) {
    // The head must still say this version is live and not retired (the `set` row alone could be left behind by a race): a skill the head does not vouch for is not sent.
    const head = headOf(await store.get(headKey(key.workspaceId, key.project, name)));
    if (head === undefined || head.retired || head.activeVersion !== versionNumber) { left += 1; continue; }
    const version = versionOf(await store.get(versionKey(key.workspaceId, key.project, name, versionNumber)));
    if (version === undefined || version.name !== name || version.version !== versionNumber || sha256(version.content) !== version.digest || version.approvals.length < ROVARA_SKILL_APPROVERS_REQUIRED || !checkSkillText(version.content).ok) { left += 1; continue; }
    found.push({ name, description: version.description, version: version.version, digest: version.digest, content: version.content });
  }
  const skills: RovaraSkillFile[] = [];
  let bytes = 0;
  for (const skill of found) {
    const size = Buffer.byteLength(skill.content, "utf8");
    if (skills.length >= ROVARA_SKILLS_PER_STEP_MAX || bytes + size > ROVARA_SKILLS_PAYLOAD_BYTES_MAX) { left += 1; continue; }
    skills.push(skill);
    bytes += size;
  }
  return { skills, left };
}
