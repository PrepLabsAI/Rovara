// The weekly lessons summary in the chats (lessons holistic review fix 7): the engine's weekly digest (`digest.ts`), sent once a week per project to each person who decides its lessons, through the
// same channel adapters the attention notices use (`ChannelAdapter.deliver`, to the places the person chose in their notice settings), with two warnings the digest itself does not carry:
//   EXPIRING  lessons waiting for a decision that expire within `EXPIRY_WARN_DAYS` if nobody decides them;
//   FADING    live lessons that fade within `FADE_WARN_DAYS` because they have not helped lately (the 90-day rule, `expiry.ts`).
//
// Rules:
//   - Behind a per-project setting, OFF by default (`readDigestSetting`): a project that never chose it is told nothing. Behind the lessons switch (the caller runs this only for a company it covers) and the
//     project's mode: Off and Collect send nothing.
//   - Who: the directory's live list of the people who decide the project's lessons, read now (an incomplete answer is nobody, retried on a later pass). Each person's digest is built with THEIR identity, so a
//     lesson from a source they cannot see is never named to them (`readVisible`, as the Lessons tab).
//   - Where: only the chat places the person chose, on an adapter that may message first, whose tenant is this company's (`tenantIsCompanys`). Muted people and quiet hours hold it (quiet hours: until a later pass).
//   - At most once per person, project and week: a company-scoped row is claimed before the send; a lost send is not repeated (as an attention email). The event id is stable for the person, project, week and
//     place, so an adapter drops a repeat. An empty week (nothing waiting, live, retired, expiring or fading) sends nothing.
//   - What: counts, lesson titles (as the Lessons tab shows them) and fixed words. No lesson body, no person's name, no source.
//   - Bounded: `DIGEST_PROJECTS_PER_PASS` projects, `DIGEST_PEOPLE_MAX` people per project, `DIGEST_TITLES_MAX` titles per list, one deadline for the pass; whatever is not reached waits for the next pass.
//   - The rows are company-scoped (`LESSON_DIGEST#<project>`): the setting, the week a project was finished, and one `SENT#<person>` row per person (removed by the person erase), each kept a few weeks.
import { createHash } from "node:crypto";
import { companyScoped, type ChannelAdapter, type ChannelEvent, type DocumentStore, type OrgId, type RegistryView } from "@agentx/contracts";
import { tenantIsCompanys, type ChannelCompanyOf } from "../core/channel/company.js";
import { notifyTargetKey, readNotifyPrefs, type NotifyTarget } from "../core/notify/prefs.js";
import { holdOf } from "../core/notify/schedule.js";
import type { AccessCheckPort } from "./access-port.js";
import { buildWeeklyDigest } from "./digest.js";
import { modeAllows, resolveLearning, type LearningSettingsReader } from "./policy.js";
import type { ApproverDirectory } from "./ports.js";
import { readVisible } from "./read-visible.js";
import type { LessonStore } from "./store.js";
import type { Lesson } from "./types.js";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
export const EXPIRY_WARN_DAYS = 2;
export const FADE_WARN_DAYS = 14;
export const DIGEST_PROJECTS_PER_PASS = 50;
export const DIGEST_PEOPLE_MAX = 50;
export const DIGEST_TITLES_MAX = 5;
export const DIGEST_SEND_TIMEOUT_MS = 2_500;
/** How long the week rows are kept (the setting has no expiry). */
const ROW_KEEP_SECONDS = 5 * 7 * 86_400;
const TITLE_CHARS = 80;

/** The week a time falls in (whole weeks since the epoch). */
export const digestWeekOf = (now: number): number => Math.floor(now / WEEK);

/** Whether the project's weekly summary is on. Absent, malformed or unreadable: off. */
export async function readDigestSetting(documents: Pick<DocumentStore, "get">, companyId: OrgId, project: string): Promise<boolean> {
  try {
    const row = await documents.get({ pk: companyScoped(companyId, `LESSON_DIGEST#${project}`), sk: "SETTING" });
    return row?.["entityType"] === "LESSON_DIGEST" && row["on"] === true;
  } catch { return false; }
}

/** Sets the project's weekly summary on or off (the caller audits first). Throws when it could not be saved. */
export async function writeDigestSetting(documents: Pick<DocumentStore, "put">, companyId: OrgId, project: string, on: boolean, now: number): Promise<void> {
  await documents.put({ item: { pk: companyScoped(companyId, `LESSON_DIGEST#${project}`), sk: "SETTING", entityType: "LESSON_DIGEST", on, updatedAt: now } });
}

export interface DigestNoticeDeps {
  companyId: OrgId;
  documents: DocumentStore;
  store: LessonStore;
  directory: ApproverDirectory;
  access: AccessCheckPort;
  settings: LearningSettingsReader;
  /** Where the channel adapters are (`registry.get("channel", id)`). */
  registry: Pick<RegistryView, "get">;
  /** Which company a chat tenant belongs to (owner decision 131); absent: one company, whose every tenant is. */
  companyOf?: ChannelCompanyOf | undefined;
  now: () => number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export interface DigestNoticeOutcome { projects: number; sent: number; held: number; failed: number }

const oneLine = (text: string): string => {
  const flat = text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  const chars = [...flat];
  return chars.length <= TITLE_CHARS ? flat : `${chars.slice(0, TITLE_CHARS - 1).join("")}…`;
};
const titles = (lessons: ReadonlyArray<{ title: string }>): string => {
  const shown = lessons.slice(0, DIGEST_TITLES_MAX).map((lesson) => `"${oneLine(lesson.title)}"`).join(", ");
  return lessons.length > DIGEST_TITLES_MAX ? `${shown} and ${String(lessons.length - DIGEST_TITLES_MAX)} more` : shown;
};

/** What one person is told about one project this week, or undefined when there is nothing to tell. Exported for tests. */
export function digestNoticeText(project: string, input: { waiting: number; wentLive: number; retired: number; expiring: ReadonlyArray<{ title: string }>; fading: ReadonlyArray<{ title: string }> }, maxLength: number): string | undefined {
  if (input.waiting + input.wentLive + input.retired + input.expiring.length + input.fading.length === 0) return undefined;
  const lines = [`Lessons this week in ${oneLine(project)}:`];
  if (input.waiting > 0) lines.push(`- ${String(input.waiting)} waiting for a decision`);
  if (input.wentLive > 0) lines.push(`- ${String(input.wentLive)} went live on trial`);
  if (input.retired > 0) lines.push(`- ${String(input.retired)} retired or expired`);
  if (input.expiring.length > 0) lines.push(`Expiring in the next ${String(EXPIRY_WARN_DAYS)} days unless someone decides: ${titles(input.expiring)}`);
  if (input.fading.length > 0) lines.push(`Fading in the next ${String(FADE_WARN_DAYS)} days because they have not helped lately: ${titles(input.fading)}`);
  const footer = "Open the project's lessons in Rovara to keep, edit or drop them.";
  const body = lines.join("\n");
  const room = maxLength - footer.length - 1;
  return `${[...body].length <= room ? body : `${[...body].slice(0, Math.max(0, room - 1)).join("")}…`}\n${footer}`;
}

const eventId = (companyId: string, project: string, week: number, personId: string, target: string): string =>
  `evt_${createHash("sha256").update(JSON.stringify(["lessons-digest", companyId, project, week, personId, target]), "utf8").digest("base64url").slice(0, 32)}`;

/** One pass: the weekly summary of each project (of those given) that has it on and is due, to each person who decides there. Never throws: a failure is a fixed log line and waits for the next pass. */
export async function sendLessonDigests(deps: DigestNoticeDeps, projects: readonly string[], options: { deadlineAt: number }): Promise<DigestNoticeOutcome> {
  const outcome: DigestNoticeOutcome = { projects: 0, sent: 0, held: 0, failed: 0 };
  const log = (event: string, fields: Record<string, unknown> = {}): void => deps.log?.(`digest.${event}`, fields);
  const { companyId, documents } = deps;
  const ttl = (now: number): Record<string, number> => (documents.ttlAttribute === undefined ? {} : { [documents.ttlAttribute]: Math.floor(now / 1000) + ROW_KEEP_SECONDS });
  const timeLeft = (): boolean => Date.now() < options.deadlineAt;

  for (const project of projects.slice(0, DIGEST_PROJECTS_PER_PASS)) {
    if (!timeLeft()) break;
    try {
      if (!(await readDigestSetting(documents, companyId, project))) continue;
      const resolved = await resolveLearning(deps.settings, companyId, project);
      if (!modeAllows(resolved.mode, "reflect")) continue;
      const now = deps.now();
      const week = digestWeekOf(now);
      const done = await documents.get({ pk: companyScoped(companyId, `LESSON_DIGEST#${project}`), sk: "WEEK" });
      if (typeof done?.["week"] === "number" && done["week"] >= week) continue;
      const group = await deps.directory.eligibility(companyId, project).catch(() => undefined);
      if (group === undefined || !group.complete) { log("eligibility_unavailable"); continue; }
      outcome.projects += 1;
      const key = { workspaceId: companyId, project };
      // The warnings' lessons, read once for the project; each person sees only those they may read.
      const warnable = (await deps.store.list(key, { statuses: ["active", "pending"] })).filter((lesson: Lesson) => lesson.workspaceId === companyId && lesson.project === project
        && (lesson.status === "pending" ? lesson.pendingExpiresAt !== undefined && lesson.pendingExpiresAt > now && lesson.pendingExpiresAt <= now + EXPIRY_WARN_DAYS * DAY
          : lesson.expiresAt > now && lesson.expiresAt <= now + FADE_WARN_DAYS * DAY));
      let pending = false;
      for (const personId of [...new Set(group.eligibleIds)].slice(0, DIGEST_PEOPLE_MAX)) {
        if (!timeLeft()) { pending = true; break; }
        // One person's fault (a record that cannot be read) holds only that person, for a later pass.
        try {
        const sentKey = { pk: companyScoped(companyId, `LESSON_DIGEST#${project}`), sk: `SENT#${personId}` };
        const sent = await documents.get(sentKey);
        if (typeof sent?.["week"] === "number" && sent["week"] >= week) continue;
        const prefs = await readNotifyPrefs(documents, companyId, personId);
        if (!prefs.muted && holdOf(prefs, now, undefined) === "quiet") { pending = true; outcome.held += 1; continue; }
        const places: Array<{ target: NotifyTarget; adapter: ChannelAdapter }> = [];
        for (const target of prefs.muted ? [] : prefs.targets) {
          const adapter = deps.registry.get("channel", target.channel);
          if (adapter === undefined || !adapter.capabilities.proactive) continue;
          if (!(await tenantIsCompanys(deps.companyOf, companyId, target.channel, target.conversation.tenant))) { log("other_company"); continue; }
          places.push({ target, adapter });
        }
        let text: string | undefined;
        if (places.length > 0) {
          const viewer = await deps.directory.identity(companyId, personId);
          const digest = await buildWeeklyDigest(deps.store, key, now, viewer, deps.access);
          const seen = await readVisible({ access: deps.access, key, viewer, lessons: warnable, where: "digest" });
          const maxLength = Math.min(...places.map((place) => place.adapter.capabilities.maxTextLength));
          text = digestNoticeText(project, {
            waiting: digest.waiting.length, wentLive: digest.autoApplied.length, retired: digest.retired.length,
            expiring: seen.filter((lesson) => lesson.status === "pending"), fading: seen.filter((lesson) => lesson.status === "active"),
          }, maxLength);
        }
        // Claimed before the send (at most once a week); a person with nowhere to be told, or nothing to be told, is marked done for the week too.
        const claimed = await documents.put({
          item: { ...sentKey, entityType: "LESSON_DIGEST", week, at: now, ...ttl(now) },
          condition: { op: "or", conditions: [{ op: "notExists", path: ["pk"] }, { op: "lt", path: ["week"], value: week }] },
        });
        if (!claimed.applied || text === undefined) continue;
        for (const { target, adapter } of places) {
          const event = { version: 1, id: eventId(companyId, project, week, personId, notifyTargetKey(target)), type: "progress", channel: target.channel, conversation: target.conversation, createdAt: new Date(now).toISOString(), data: { text } } as ChannelEvent;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([adapter.deliver(event), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("timeout")), DIGEST_SEND_TIMEOUT_MS); timer.unref?.(); })]);
            outcome.sent += 1;
          } catch (error) {
            outcome.failed += 1;
            log("send_failed", { channel: target.channel, error: error instanceof Error ? error.name : "unknown" });
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        }
        } catch (error) {
          pending = true;
          outcome.failed += 1;
          log("person_failed", { error: error instanceof Error ? error.name : "unknown" });
        }
      }
      if (!pending && group.eligibleIds.length <= DIGEST_PEOPLE_MAX) {
        await documents.put({ item: { pk: companyScoped(companyId, `LESSON_DIGEST#${project}`), sk: "WEEK", entityType: "LESSON_DIGEST", week, ...ttl(now) } });
      }
    } catch (error) {
      log("project_failed", { error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return outcome;
}
