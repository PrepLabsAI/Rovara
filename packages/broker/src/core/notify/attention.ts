// Notifications (lanes L6b and P4; the hosted product's UX2 slice 2 item 5, experience items S-11 and S-12): every event that needs a person reaches them, wherever the task was started. The message goes out
// through the plug-in registry: the `channel` adapters (`ChannelAdapter.deliver(ChannelEvent)`) and the `email` point (`EmailSender.send`), never through a provider's own code. Code's email point sends nothing
// (decision 101), so in Code notices go through the chats; the hosted product plugs its email service into the same point.
//
//   queue    When a session's summary commits a change into a state that asks someone to act (Needs you, Paused: needs more budget, Ready to merge, Failed) or is over (Merged, Closed), `queueAttention` writes one
//            pending row per person to tell: the owner, and the people the summary names as needed. A later change of the same kind for the same person and session replaces the row, so nothing piles up. The
//            person's open pages hear a realtime hint (ids only).
//   deliver  The session sweep calls `deliverAttention`. Each person gets at most one message per target every `NOTIFY_BATCH_MINUTES`: everything pending is batched into it. Their quiet hours hold what is not
//            urgent until they end; a digest time holds it for one list a day (`schedule.ts`). Before anything is sent, each row is checked again: the session still exists, it still stands in the state the row
//            was written for, and the person may still READ it. Rows that fail any check are dropped silently.
//
// A TARGET is a conversation on a channel the person chose (`NotifyTarget`), or their email (`EMAIL_TARGET`) when they chose it and it can be sent (`prefs.ts`). The event id is derived from the batch it carries,
// so a retry of the same batch is the same event and the adapter drops a repeat (the channel protocol: `event.id` is stable across retries); an email is claimed on the rows before it is sent, so it goes at most
// once. That is at most once, not exactly once: when the transport took an email but its answer was lost, or giving a failed claim back fails, that email is not sent again. A message holds the task's title, its
// status sentence (fixed words) and a link supplied by the surface that serves the task page. Chat may also carry the safe captured E2E summary, after recipient checks. Logs carry fixed codes and counts only.
import { createHash } from "node:crypto";
import { applicationNoticeText } from "../e2e/application-notices.js";
import {
  OrgIdSchema, DOCUMENT_STORE_LIMITS, EmailError, INDEX_EXPIRY_ATTRIBUTE, NOTIFY_BATCH_MINUTES, NOTIFY_ITEMS_MAX, UPKEEP_NOTICE_WORDS, agentSessionKey, change, defaultNotifyChannel, effectiveNotify, hideEmailAddresses, isPlainEmailAddress, isRealtimeNotice,
  sessionTaskStatus, taskStatusText, upkeepMonthOf, upkeepSubjectId, upkeepSubjectOf, when,
  type AgentSessionRecord, type ChannelAdapter, type ChannelEvent, type ConversationRef, type DocumentStore, type EmailSender, type OrgId, type RealtimeEntry, type RealtimePublisher, type RegistryView,
  type SessionSummary, type StoredDocument, type UpkeepPauseReason,
} from "@agentx/contracts";
import type { SessionChange } from "../sessions/summary.js";
import { SessionStore } from "../sessions/store.js";
import { upkeepExpiryOf, upkeepNoticeKey } from "../upkeep/keys.js";
import { attentionEmail, type AttentionEmailLinks } from "./email-text.js";
import { NOTIFY_TARGETS_MAX, notifyTargetKey as targetKey, readNotifyPrefs, type NotifyTarget } from "./prefs.js";
import { digestSlotDay, holdOf } from "./schedule.js"; import { projectNoticeRow, putInboxRow } from "./inbox-rows.js";
import { tenantIsCompanys, type ChannelCompanyOf } from "../channel/company.js";
import { repairToldExpiryOf, repairToldKey, setupBrokenSubjectId, setupBrokenSubjectOf } from "../setup-agent/broken-notice.js";
import { setupAdminNoticeWords } from "../setup-agent/recheck-rows.js";

type Log = (entry: Record<string, unknown>) => void;

/**
 * What a person is told about. `setup_broken` (lead 4 U5) is the same kind of project notice: the project's setup stopped working (`queueSetupBroken`); it names a project and a re-check where a task's row names a session.
 * `upkeep_paused` (lead 4 N1) is not about a session: it tells a project's admins that nightly upkeep stopped at its cap (`queueUpkeepPaused`). Its row names a project, a month and a
 * reason where a task's row names a session, and it is delivered by its own checks (the person may still administer the project), never by a session read.
 */
export type AttentionKind = "needs_you" | "paused" | "ready" | "failed" | "done" | "upkeep_paused" | "setup_broken";

/**
 * A notice for the company's admins that is not about a task (owner decision 2026-11-17: one person's tools were served an unusual amount of team knowledge in a day). It rides the same pending queue, so it is batched,
 * held for quiet hours, tried again and told through the same chats and email as a task notice; it has no session, so nothing is read for it and it makes no inbox row. The words are fixed here: no name, no text.
 */
export type AdminNoticeKind = "knowledge_read";
type PendingKind = AttentionKind | AdminNoticeKind;
export const ADMIN_NOTICE_KINDS: readonly AdminNoticeKind[] = ["knowledge_read"];
export const ADMIN_NOTICE_LINE: Readonly<Record<AdminNoticeKind, { title: string; status: string }>> = {
  knowledge_read: { title: "Team knowledge", status: "An AI tool was given an unusual amount of team knowledge today. The audit record has the details." },
};

export const PENDING_PK = "NOTIFY_PENDING";
const PENDING_KEEP_SECONDS = 3 * 86_400;
const SENT_KEEP_SECONDS = 86_400;
/** The most people one message names (the owner and the people needed). */
const RECIPIENTS_MAX = 50;
/** The most people one sweep messages (chosen among those due now, oldest waiting first). */
const PEOPLE_PER_SWEEP_MAX = 40;
const TITLE_MAX = 100;
/** How often one target is tried for one person before it gives up on what is pending, and the wait after the first failure (doubled each time: 5, 10, 20, 40 minutes). */
export const ATTENTION_TARGET_TRIES_MAX = 5;
export const ATTENTION_RETRY_BASE_MS = 5 * 60_000;
export const ATTENTION_SEND_TIMEOUT_MS = 2500;
/** The queue is read in pages, at most this many rows a sweep. */
const PENDING_PAGE = 100;
export const ATTENTION_READ_MAX = 2000;

/** The row of what was last sent to a person (exported for the person erase). */
export const notifySentKey = (orgId: string, developerId: string) => ({ pk: `NOTIFY_SENT#${orgId}`, sk: `DEV#${developerId}` });
const pendingKey = (orgId: string, developerId: string, sessionId: string, kind: PendingKind) => ({ pk: PENDING_PK, sk: `${orgId}#${developerId}#${sessionId}#${kind}` });

/** The kind of message a status calls for, or undefined for a status nobody is told about. */
export function attentionKindOf(summary: Pick<SessionSummary, "status" | "lastRunFailed"> & { display?: unknown }): AttentionKind | undefined {
  switch (sessionTaskStatus(summary).state) {
    case "needs_you": return "needs_you";
    case "paused_budget": return "paused";
    case "ready_to_merge": return "ready";
    case "failed": return "failed";
    case "merged": case "closed": return "done";
    default: return undefined;
  }
}

// ---- queue

/** The session's followers (the hosted product's `FOLLOWER#<person>` rows on the session's partition), at most `RECIPIENTS_MAX`. A row that is not shaped like a person is left out. */
async function followersOf(store: Pick<DocumentStore, "query">, session: AgentSessionRecord): Promise<string[]> {
  const key = agentSessionKey(session.orgId, session.sessionId, "FOLLOWER#");
  const page = await store.query({ pk: key.pk, sk: { op: "beginsWith", prefix: "FOLLOWER#" }, limit: RECIPIENTS_MAX });
  return page.items.flatMap((item) => (/^FOLLOWER#[a-f0-9]{64}$/u.test(item.sk) ? [item.sk.slice("FOLLOWER#".length)] : []));
}

/**
 * The task's People list as the host reads it (web task channel): the co-owners and the commenters, as attention ids (the ids the queue's rows and the inbox use). Absent: only the task's own person, as before.
 * A host that has People says who: nothing here reads a role by itself, and a name on the list is no more than a person to ask again about (delivery and the inbox check each person's live access).
 */
export interface PeopleRecipients { owners: readonly string[]; commenters: readonly string[] }
export type PeopleOf = (session: AgentSessionRecord) => Promise<PeopleRecipients>;

const PERSON = /^[a-f0-9]{64}$/u;
const personIds = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && PERSON.test(id)) : []);

/**
 * Who is told about a change of this kind: the owner and, for a wait or a pause, the people the summary names as needed; the session's followers for a failure and for the end. A closed task tells only its followers
 * (a merged one tells its owner too). People (web task channel): the task's co-owners are told like its owner, and its commenters like its followers (a failure and the end).
 */
export async function attentionRecipients(store: Pick<DocumentStore, "query">, session: AgentSessionRecord, summary: SessionSummary, kind: AttentionKind, people?: PeopleRecipients): Promise<string[]> {
  const owner = session.owner.developerId;
  const named = summary.needsPeople.filter((id) => PERSON.test(id));
  const followers = kind === "failed" || kind === "done" ? await followersOf(store, session) : [];
  const ownerToo = kind !== "done" || sessionTaskStatus(summary).state === "merged";
  const coOwners = ownerToo ? personIds(people?.owners) : [];
  const commenters = kind === "failed" || kind === "done" ? personIds(people?.commenters) : [];
  const told = [...(ownerToo ? [owner] : []), ...coOwners, ...(kind === "needs_you" || kind === "paused" ? named : []), ...followers, ...commenters];
  return [...new Set(told)].slice(0, RECIPIENTS_MAX);
}

/**
 * Tells each person's open pages that what waits for them changed, so they read again. A hint only: the notice carries the session id and the kind, never a title, a person's words or a secret
 * (`attentionNotice`). Never throws (a push is never a reason for the queue to fail).
 */
export function attentionNotice(sessionId: string, kind: AttentionKind): { type: string; sessionId: string; kind: AttentionKind } {
  return { type: "attention.changed", sessionId, kind };
}

async function publishAttentionChanged(realtime: Pick<RealtimePublisher, "publish"> | undefined, companyId: string, people: readonly string[], sessionId: string, kind: AttentionKind): Promise<void> {
  if (realtime === undefined || people.length === 0) return;
  const notice = attentionNotice(sessionId, kind);
  if (!isRealtimeNotice(notice)) return;
  const entries: RealtimeEntry[] = people.map((personId) => ({ audience: { kind: "person", personId }, notice }));
  try { await realtime.publish({ companyId, entries, deadline: Date.now() + 1_000 }); } catch { /* a push never fails the queue */ }
}

/**
 * After a refresh committed: when the session moved into a state someone is told about, one pending row per person. Only task sessions. Never throws: a notification is never a reason for a refresh to fail.
 * Use it as a session change hook.
 */
export async function queueAttention(deps: { store: Pick<DocumentStore, "put" | "query">; now?: () => Date; log?: Log; realtime?: Pick<RealtimePublisher, "publish"> | undefined; peopleOf?: PeopleOf; /** `false`: write only the in-app inbox rows (a host that can message nobody keeps no queue). */ pending?: boolean }, change: SessionChange): Promise<number> {
  try {
    if (change.session.subject.kind !== "task") return 0;
    const kind = attentionKindOf(change.summary);
    if (kind === undefined) return 0;
    // A summary written before the status model has no `display`; its first refresh counts as unchanged, so nobody is told again about work already waiting.
    if ((change.previous as { display?: unknown }).display === undefined) return 0;
    // An ended session is only ever told as done or failed (no ended session is listed as needing anyone).
    if (change.session.endedAt !== undefined && kind !== "done" && kind !== "failed") return 0;
    const before = sessionTaskStatus(change.previous), after = sessionTaskStatus(change.summary);
    if (before.state === after.state && before.reason === after.reason) return 0;
    // The task's People, when the host keeps them: a list that cannot be read tells the others as before (and says so in fixed words), it never holds the queue back.
    let onTask: PeopleRecipients | undefined;
    if (deps.peopleOf !== undefined) {
      try { onTask = await deps.peopleOf(change.session); } catch { (deps.log ?? (() => undefined))({ event: "attention.people_failed", sessionId: change.sessionId }); }
    }
    const people = await attentionRecipients(deps.store, change.session, change.summary, kind, onTask);
    const nowMs = (deps.now ?? (() => new Date()))().getTime();
    for (const developerId of people) {
      if (deps.pending !== false) await deps.store.put({
        item: { ...pendingKey(change.orgId, developerId, change.sessionId, kind), entityType: "NOTIFY_PENDING", orgId: change.orgId, developerId, sessionId: change.sessionId, kind, at: change.at, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + PENDING_KEEP_SECONDS },
      }); if (kind !== "upkeep_paused" && kind !== "setup_broken") await putInboxRow(deps.store, deps.log, { orgId: change.orgId, developerId, sessionId: change.sessionId, kind, at: change.at, nowMs }, INDEX_EXPIRY_ATTRIBUTE);
    }
    await publishAttentionChanged(deps.realtime, change.orgId, people, change.sessionId, kind);
    return people.length;
  } catch (error) {
    (deps.log ?? ((entry) => console.log(JSON.stringify({ component: "broker", ...entry }))))({ event: "attention.queue_failed", sessionId: change.sessionId, error: error instanceof Error ? error.name : "unknown" });
    return 0;
  }
}

/**
 * Lead 4 N1: nightly upkeep stopped at its limit (the gateway refused an upkeep call with `upkeep_paused`, or the limit read says so before one was made). Tells the project's admins ONCE per company, project,
 * month and reason, in fixed words, in the same inbox and chats as every other attention: a marker row (`NOTICE#<month>#<reason>`) is written first and only while absent, so a second pause of the same kind in
 * the month writes nothing, however many nights or workers see it; the winner writes one pending row per person `recipients` names (the project's admins and the company's owners and admins, as the host reads them
 * now). Nobody to tell, or a recipient read that failed, gives the marker back so a later night tries again. Never throws: a notice is never a reason for the night to fail. Answers how many people were queued.
 */
export async function queueUpkeepPaused(
  deps: { store: Pick<DocumentStore, "put" | "delete" | "transact">; now?: () => Date; log?: Log; realtime?: Pick<RealtimePublisher, "publish"> | undefined; recipients(orgId: OrgId, project: string): Promise<readonly string[]> },
  input: { orgId: OrgId; project: string; reason: UpkeepPauseReason; month?: string },
): Promise<{ queued: number; deduped: boolean }> {
  const log = deps.log ?? ((): void => undefined);
  const clock = deps.now ?? (() => new Date());
  try {
    const orgId = OrgIdSchema.parse(input.orgId);
    const nowMs = clock().getTime();
    const month = input.month ?? upkeepMonthOf(nowMs);
    const subjectId = upkeepSubjectId({ project: input.project, month, reason: input.reason });
    const marker = upkeepNoticeKey({ orgId, project: input.project }, month, input.reason);
    const first = await deps.store.put({ item: { ...marker, entityType: "UPKEEP_NOTICE", orgId, project: input.project, month, reason: input.reason, at: new Date(nowMs).toISOString(), ...upkeepExpiryOf(nowMs) }, condition: when.absent() });
    if (!first.applied) return { queued: 0, deduped: true };
    let people: string[];
    try {
      people = [...new Set((await deps.recipients(orgId, input.project)).filter((id) => /^[a-f0-9]{64}$/u.test(id)))].slice(0, RECIPIENTS_MAX);
    } catch (error) {
      await deps.store.delete({ key: marker }).catch(() => undefined);
      log({ event: "upkeep.notice_recipients_failed", error: error instanceof Error ? error.name : "unknown" });
      return { queued: 0, deduped: false };
    }
    if (people.length === 0) { await deps.store.delete({ key: marker }).catch(() => undefined); return { queued: 0, deduped: false }; }
    // All the rows or none, so a partial failure never leaves some admins told and the marker standing over the rest.
    const written = await deps.store.transact(people.flatMap((developerId) => [{
      kind: "put" as const,
      item: { ...pendingKey(orgId, developerId, subjectId, "upkeep_paused"), entityType: "NOTIFY_PENDING", orgId, developerId, sessionId: subjectId, kind: "upkeep_paused", at: new Date(nowMs).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + PENDING_KEEP_SECONDS },
    }, { kind: "put" as const, item: projectNoticeRow({ orgId, developerId, subjectId, kind: "upkeep_paused", at: new Date(nowMs).toISOString(), nowMs }, INDEX_EXPIRY_ATTRIBUTE) }])).catch(() => ({ applied: false as const }));
    if (!written.applied) { await deps.store.delete({ key: marker }).catch(() => undefined); return { queued: 0, deduped: false }; }
    await publishAttentionChanged(deps.realtime, orgId, people, subjectId, "upkeep_paused");
    return { queued: people.length, deduped: false };
  } catch (error) {
    log({ event: "upkeep.notice_failed", error: error instanceof Error ? error.name : "unknown" });
    return { queued: 0, deduped: false };
  }
}

/**
 * Queues one admin notice for each person named (the caller says who the admins are). `noticeId` makes the row: the same notice again (the same day's alert) replaces it, so nothing piles up. Never throws.
 * `pending: false` (a host that can tell nobody) writes nothing. Answers how many rows were written.
 */
export async function queueAdminNotice(deps: { store: Pick<DocumentStore, "put">; now?: () => Date; log?: Log; pending?: boolean }, notice: { orgId: string; developerIds: readonly string[]; noticeId: string; kind: AdminNoticeKind }): Promise<number> {
  if (deps.pending === false || !/^[A-Za-z0-9_-]{1,64}$/u.test(notice.noticeId) || !ADMIN_NOTICE_KINDS.includes(notice.kind)) return 0;
  let written = 0;
  try {
    const nowMs = (deps.now ?? (() => new Date()))().getTime();
    for (const developerId of [...new Set(notice.developerIds)].slice(0, RECIPIENTS_MAX)) {
      await deps.store.put({
        item: { ...pendingKey(notice.orgId, developerId, notice.noticeId, notice.kind), entityType: "NOTIFY_PENDING", orgId: notice.orgId, developerId, sessionId: notice.noticeId, kind: notice.kind, at: new Date(nowMs).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + PENDING_KEEP_SECONDS },
      });
      written += 1;
    }
  } catch (error) {
    deps.log?.({ event: "attention.admin_notice_failed", error: error instanceof Error ? error.name : "unknown" });
  }
  return written;
}

/**
 * Lead 4 U5: the project's setup stopped working (a re-check settled as broken). Tells the project's admins ONCE per company, project and re-check, in fixed words and in the same chats and email as every other
 * attention: a marker row (`REPAIR_TOLD#<re-check key>`) is written first and only while absent, so a second reader of the same break writes nothing, however many tasks or workers see it; the winner writes one pending row
 * per person `recipients` names (the project's admins and the company's owners and admins, as the host reads them now). Nobody to tell, or a recipient read that failed, gives the marker back so a later read tries again. Never
 * throws: a notice is never a reason for a re-check to fail. Answers how many people were queued.
 */
export async function queueSetupBroken(
  deps: { store: Pick<DocumentStore, "get" | "put" | "delete" | "transact">; now?: () => Date; log?: Log; realtime?: Pick<RealtimePublisher, "publish"> | undefined; recipients(orgId: OrgId, project: string): Promise<readonly string[]> },
  input: { orgId: OrgId; project: string; recheckKey: string },
): Promise<{ queued: number; deduped: boolean }> {
  const log = deps.log ?? ((): void => undefined);
  const clock = deps.now ?? (() => new Date());
  try {
    const orgId = OrgIdSchema.parse(input.orgId);
    const nowMs = clock().getTime();
    const subjectId = setupBrokenSubjectId({ project: input.project, recheckKey: input.recheckKey });
    const marker = repairToldKey(orgId, input.project, input.recheckKey);
    // A read first (cheap), so a break read many times costs one write at most.
    if ((await deps.store.get(marker)) !== undefined) return { queued: 0, deduped: true };
    const first = await deps.store.put({ item: { ...marker, entityType: "SETUP_REPAIR_TOLD", orgId, project: input.project, key: input.recheckKey, at: new Date(nowMs).toISOString(), ...repairToldExpiryOf(nowMs) }, condition: when.absent() });
    if (!first.applied) return { queued: 0, deduped: true };
    let people: string[];
    try {
      people = [...new Set((await deps.recipients(orgId, input.project)).filter((id) => /^[a-f0-9]{64}$/u.test(id)))].slice(0, RECIPIENTS_MAX);
    } catch (error) {
      await deps.store.delete({ key: marker }).catch(() => undefined);
      log({ event: "setup_broken.notice_recipients_failed", error: error instanceof Error ? error.name : "unknown" });
      return { queued: 0, deduped: false };
    }
    if (people.length === 0) { await deps.store.delete({ key: marker }).catch(() => undefined); return { queued: 0, deduped: false }; }
    const written = await deps.store.transact(people.flatMap((developerId) => [{
      kind: "put" as const,
      item: { ...pendingKey(orgId, developerId, subjectId, "setup_broken"), entityType: "NOTIFY_PENDING", orgId, developerId, sessionId: subjectId, kind: "setup_broken", at: new Date(nowMs).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + PENDING_KEEP_SECONDS },
    }, { kind: "put" as const, item: projectNoticeRow({ orgId, developerId, subjectId, kind: "setup_broken", at: new Date(nowMs).toISOString(), nowMs }, INDEX_EXPIRY_ATTRIBUTE) }])).catch(() => ({ applied: false as const }));
    if (!written.applied) { await deps.store.delete({ key: marker }).catch(() => undefined); return { queued: 0, deduped: false }; }
    await publishAttentionChanged(deps.realtime, orgId, people, subjectId, "setup_broken");
    return { queued: people.length, deduped: false };
  } catch (error) {
    log({ event: "setup_broken.notice_failed", error: error instanceof Error ? error.name : "unknown" });
    return { queued: 0, deduped: false };
  }
}

// ---- deliver

export interface AttentionDeliveryDependencies {
  /** Captured E2E blocks for the task; read only for a currently allowed chat recipient. */
  e2e?: (session: AgentSessionRecord) => Promise<unknown[] | undefined>;
  store: DocumentStore;
  /** Where the adapters are: `registry.get("channel", id)` for the chats; the `email` point's one sender (Code's default says it cannot send). */
  registry: Pick<RegistryView, "get" | "names">;
  now: () => number;
  /** The address of a session's page, built by the surface that serves it; undefined when there is none (the message then has no link). */
  link?: (session: AgentSessionRecord) => string | undefined;
  /** Fewer places than the cap of one person's targets (the chosen ones and the conversations of starts) to tell in one sweep; it never raises the cap. A test lowers it. */
  maxTargets?: number;
  /** A line added after the list (how to open a task when the surface has no address to link). Fixed words, set by the install. */
  footer?: string;
  /**
   * The conversation a session was started from, and the person who started it (`core/channel/threads.ts`). What that person is told about the session goes to that conversation as well as to their chosen targets: it
   * answers them where they asked, so a channel that may not message first (`proactive` false) is still used for it. Absent: no session has one.
   */
  thread?: (orgId: OrgId, sessionId: string) => Promise<{ conversation: ConversationRef; personId: string } | undefined>;
  /**
   * Owner decision 131: which company a chat tenant belongs to (as the channel sink's `companyOf`). A target whose conversation is in another company's tenant (or
   * nobody's) is never sent to: it counts as unreachable. Absent: one company, whose every tenant is.
   */
  companyOf?: ChannelCompanyOf;
  /**
   * The thread's own "done" line is told by the channel milestones (`core/channel/thread-notices.ts`) while they are on, so the finished-task notice is not sent to the conversation a task was started from as well. It still goes to
   * the places the person chose, and the other notices (needs you, paused, ready, failed) still go to the thread. Absent: the thread is told as before.
   */
  doneToldInThread?: () => boolean;
  /**
   * Whether the plan this session waits on already got its approval card in the conversation the task was started from (`core/channel/thread-notices.ts`). The needs-you reminder is then not sent to THAT conversation again; it still
   * goes to the places the person chose, and every other kind of notice is unchanged. A failure counts as "no card", so the reminder is sent.
   */
  planCarded?: (session: AgentSessionRecord) => Promise<boolean>;
  /**
   * L4-U5: whether the task's setup pause ("I can't build this yet ...") was already told in the conversation the task was started from (`core/channel/thread-notices.ts` `setupPausedPosted`). The needs-you reminder is then not sent to THAT
   * conversation as well (one message for the requester); it still goes to the places the person chose. A failure counts as "not told", so the reminder is sent.
   */
  setupPausedTold?: (session: AgentSessionRecord) => Promise<boolean>;
  /** Whether the person may READ the session now. Default: the session's owner. */
  access?: (orgId: OrgId, developerId: string, session: AgentSessionRecord) => Promise<{ owner: boolean } | undefined>;
  /** The person's own email address (from their sign-in record), or undefined. Absent: nobody has one, and email is never used. */
  address?: (orgId: OrgId, developerId: string) => Promise<string | undefined>;
  /**
   * Whether a pending row is urgent: it breaks through quiet hours and is not held for a digest (owner answer Q20: a high-risk item). Absent, or a failure: not urgent. Called only for a row that would wait.
   */
  urgent?: (orgId: OrgId, row: { developerId: string; sessionId: string; kind: AttentionKind }) => Promise<boolean>;
  /**
   * Whether the person may be told an admin notice now (they are an owner or admin of the company), read at delivery. Absent, or a failure: they may not, and the row goes (fail closed).
   */
  adminNotice?: (orgId: OrgId, developerId: string) => Promise<boolean>;
  /** The links an email carries (change the setting, stop these emails, the list of everything waiting); each only when it is a plain https link. */
  emailLinks?: AttentionEmailLinks | ((orgId: OrgId, developerId: string) => AttentionEmailLinks);
  /**
   * Lead 4 N1: what an `upkeep_paused` row needs. `administers`: whether the person still administers the project now (a project admin, or a company owner or admin), read live before every send; a row whose person no
   * longer does, or any failure to tell, is dropped without a word. `link`: the address of the Spending limits page for the project (a plain https link), or undefined. Absent: no upkeep row is delivered (it is dropped).
   */
  upkeep?: {
    administers(orgId: OrgId, developerId: string, project: string): Promise<boolean>; link?(project: string): string | undefined;
    /**
     * Lead 4 U5: what a `setup_broken` row needs. `setupRead`: the project's open repair card now (the re-check's key, the check's failing step and whether a checked fix waits for approval), or undefined when the setup is no longer
     * broken; read live before every send, so a notice for a break that was fixed meanwhile is dropped without a word. `setupLink`: the setup page's address (a plain https link), or undefined. Absent `setupRead`: no setup row is delivered.
     */
    setupRead?(orgId: OrgId, project: string): Promise<{ key: string; failedStep: string; fixReady: boolean } | undefined>; setupLink?(project: string): string | undefined;
  };
  log?: Log;
}

interface Line { title: string; status: string; link?: string | undefined; kind: PendingKind }

export const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
};

/**
 * The message text: the tasks (title, status sentence, link), then the footer when there is one (how to open the task when no line has a link). Plain text; an adapter formats it for its channel. The text is cut to `maxLength`
 * with the footer kept whole.
 */
export function attentionText(lines: readonly Line[], more: number, maxLength: number, footer?: string): string {
  const count = lines.length + more;
  const upkeepLines = lines.filter((line) => line.kind === "upkeep_paused").length;
  const setupLines = lines.filter((line) => line.kind === "setup_broken").length;
  const projectLines = upkeepLines + setupLines;
  const body = [
    projectLines === 0 ? (count === 1 ? "A task needs your attention in Rovara:" : "These tasks need your attention in Rovara:")
      : upkeepLines === lines.length && more === 0 ? "Nightly upkeep needs your attention in Rovara:"
        : setupLines === lines.length && more === 0 ? "A project's setup needs your attention in Rovara:" : "These items need your attention in Rovara:",
    ...lines.map((line) => `- ${line.title}: ${line.status}${line.link === undefined ? "" : ` ${line.link}`}`),
    ...(more > 0 ? [`- and ${String(more)} more`] : []),
  ].join("\n");
  const tail = footer === undefined || footer === "" ? "" : `\n${footer}`;
  const room = Math.max(1, maxLength - [...tail].length);
  const chars = [...body];
  return `${chars.length <= room ? body : `${chars.slice(0, room - 1).join("")}…`}${tail}`;
}

const doneText = (lines: readonly Line[], maxLength: number, footer?: string): string => attentionText(lines, 0, maxLength, footer).replace(/^A task needs your attention in Rovara:/u, "A task finished in Rovara:").replace(/^These tasks need your attention in Rovara:/u, "These tasks finished in Rovara:");
const noticeText = (lines: readonly Line[], more: number, maxLength: number, footer?: string): string => attentionText(lines, more, maxLength, footer).replace(/^(?:A task needs|These tasks need|Nightly upkeep needs|A project's setup needs|These items need) your attention in Rovara:/u, "A notice from Rovara:");
const digestText = (lines: readonly Line[], more: number, maxLength: number, footer?: string): string => attentionText(lines, more, maxLength, footer).replace(/^(?:A task needs|These tasks need|Nightly upkeep needs|A project's setup needs|These items need) your attention in Rovara:/u, "Your Rovara digest:");

/** The event id of a batch: the same rows to the same target are the same event, so an adapter that is told twice drops the repeat. */
export function batchEventId(orgId: string, developerId: string, target: string, rows: readonly { sk: string; at: string }[]): string {
  const digest = createHash("sha256").update(JSON.stringify([orgId, developerId, target, rows.map((row) => `${row.sk}@${row.at}`).sort()]), "utf8").digest("base64url");
  return `evt_${digest.slice(0, 32)}`;
}

/** The email route's key among a person's targets (a chat target's key always has a `:`). */
export const EMAIL_TARGET = "email";

interface PendingRow { key: { pk: string; sk: string }; orgId: OrgId; developerId: string; sessionId: string; kind: PendingKind; at: string; done: Set<string> }

function pendingRowOf(item: StoredDocument, nowSeconds: number): PendingRow | undefined {
  const { orgId, developerId, sessionId, kind, at, sk } = item;
  if (typeof orgId !== "string" || typeof developerId !== "string" || typeof sessionId !== "string" || typeof at !== "string" || typeof sk !== "string") return undefined;
  if (typeof kind !== "string" || ![...["needs_you", "paused", "ready", "failed", "done", "upkeep_paused", "setup_broken"], ...ADMIN_NOTICE_KINDS].includes(kind) || sk !== `${orgId}#${developerId}#${sessionId}#${kind}`) return undefined;
  // A project notice's or an upkeep row's subject must be its own kind of subject (and a task's row never one): a row that is neither reads as nothing.
  if ((kind === "upkeep_paused") !== (upkeepSubjectOf(sessionId) !== undefined)) return undefined;
  if ((kind === "setup_broken") !== (setupBrokenSubjectOf(sessionId) !== undefined)) return undefined;
  // A row past its expiry is not delivered (the store deletes expired items late).
  const expires = item[INDEX_EXPIRY_ATTRIBUTE];
  if (typeof expires === "number" && expires <= nowSeconds) return undefined;
  const done = new Set(Array.isArray(item["doneTargets"]) ? item["doneTargets"].filter((entry): entry is string => typeof entry === "string") : []);
  // The email is sent at most once: a row claimed for an email (the hosted product's `emailClaimed`, written before the send) or marked sent counts as sent.
  if (item["emailSent"] === true || typeof item["emailClaimed"] === "number") done.add(EMAIL_TARGET);
  return { key: { pk: PENDING_PK, sk }, orgId: orgId, developerId, sessionId, kind: kind as PendingKind, at, done };
}

/** One person's marker: when it last sent anything, per target how many tries failed in a row and when it may try again, and the local day whose digest was last sent. */
interface SentMarker { lastAt: number; failures: Record<string, number>; retryAt: Record<string, number>; /** Every target owed to this person waits for a retry until then; they take no place before it. */ waitUntil?: number | undefined; digestDay?: string | undefined }

function markerOf(item: StoredDocument | undefined): SentMarker {
  const numbers = (value: unknown): Record<string, number> => (typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))) : {});
  const waitUntil = item?.["waitUntil"], digestDay = item?.["digestDay"];
  return {
    lastAt: typeof item?.["lastAt"] === "number" ? item["lastAt"] : 0, failures: numbers(item?.["failures"]), retryAt: numbers(item?.["retryAt"]),
    ...(typeof waitUntil === "number" ? { waitUntil } : {}), ...(typeof digestDay === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(digestDay) ? { digestDay } : {}),
  };
}

/**
 * Claims rows for one email in ONE transaction (all or none), at most `DOCUMENT_STORE_LIMITS.maxTransactItems` rows, oldest first; the rest wait for the next email. A row that changed since it was read (a later
 * change replaced it, or it went) is left out and the others are claimed again, once. Answers the rows claimed (empty when none could be), or throws when the store fails (nothing is claimed then).
 */
async function claimEmailRows<T extends { row: PendingRow }>(store: Pick<DocumentStore, "transact">, owed: readonly T[], nowMs: number): Promise<T[]> {
  let rows = [...owed].sort((a, b) => a.row.at.localeCompare(b.row.at)).slice(0, DOCUMENT_STORE_LIMITS.maxTransactItems);
  for (let round = 0; round < 2 && rows.length > 0; round += 1) {
    const result = await store.transact(rows.map(({ row }) => ({ kind: "update" as const, key: row.key, ops: [change.set("emailClaimed", nowMs)], condition: when.and(when.present(), when.eq("at", row.at)) })));
    if (result.applied) return rows;
    const failed = new Set(result.failed);
    rows = rows.filter((_entry, index) => !failed.has(index));
  }
  return [];
}

/** The email point's one sender, or undefined when none is registered. */
function emailSenderOf(registry: Pick<RegistryView, "get" | "names">): EmailSender | undefined {
  const names = registry.names("email");
  return names.length === 1 ? registry.get("email", names[0]!) : undefined;
}

export interface AttentionBudget { deadlineMs?: number | undefined; companyId?: OrgId; maxItems?: number; scan?: { cursor: string | undefined } }
export interface AttentionOutcome { complete?: boolean; people: number; sent: number; emails: number; dropped: number; failed: number; gaveUp: number; unreachable: number; held: number }

async function withApplicationNoticeSummaries(deps: AttentionDeliveryDependencies, owed: ReadonlyArray<{ row: PendingRow }>, allowedSessions: ReadonlyMap<string, AgentSessionRecord>, text: string, maxLength: number): Promise<string> {
  if (deps.e2e === undefined) return text;
  const summaries: string[] = [];
  for (const sessionId of new Set(owed.map(({ row }) => row.sessionId))) {
    const session = allowedSessions.get(sessionId);
    if (session === undefined) continue;
    const summary = applicationNoticeText(await deps.e2e(session).catch(() => undefined));
    if (summary !== "") summaries.push(summary);
  }
  return summaries.length > 0 ? `${text}\n${summaries.join("\n")}`.slice(0, maxLength) : text;
}

/**
 * The sweep's delivery. The queue is read in pages (at most `ATTENTION_READ_MAX` rows; rows past their expiry are left out). People still inside their batching window are set aside BEFORE the
 * `PEOPLE_PER_SWEEP_MAX` people of this sweep are chosen, and those are taken oldest-waiting first, so nobody's rows are starved by others'. Rows a person's quiet hours or digest hold (`holdOf`) stay
 * queued unless urgent; a person with nothing to send now takes no place. For each person, one event per target lists what is still current and still theirs to read. The targets are their chats
 * and/or email as they chose (`effectiveNotify`: email only when the email point can send and they have an address, else the chats). Each target is sent on its own: a failing one never holds back
 * another; what one target received is marked on the rows, so it is not sent again; a failing target is tried again after a growing wait and gives up after `ATTENTION_TARGET_TRIES_MAX` tries (an email
 * the sender refuses gives up at once). A chat whose adapter cannot message first (`proactive` false) or is not registered is not tried. Rows go once every target has them. Never past `deadlineMs`.
 * Answers counts only.
 */
export async function deliverAttention(deps: AttentionDeliveryDependencies, budget: AttentionBudget = {}): Promise<AttentionOutcome> {
  const log = deps.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry })));
  const outcome: AttentionOutcome = { people: 0, sent: 0, emails: 0, dropped: 0, failed: 0, gaveUp: 0, unreachable: 0, held: 0 };
  const nowMs = deps.now();
  const late = () => budget.deadlineMs !== undefined && deps.now() >= budget.deadlineMs;
  if (budget.companyId !== undefined && !OrgIdSchema.safeParse(budget.companyId).success) throw new Error("the notification company is invalid");
  const maxItems = Math.min(ATTENTION_READ_MAX, budget.maxItems ?? ATTENTION_READ_MAX);
  const byPerson = new Map<string, PendingRow[]>();
  let cursor: string | undefined = budget.scan?.cursor;
  let read = 0;
  do {
    if (late() || read >= maxItems) break;
    const page = await deps.store.query({ pk: PENDING_PK, ...(budget.companyId === undefined ? {} : { sk: { op: "beginsWith" as const, prefix: `${budget.companyId}#` } }), limit: Math.min(PENDING_PAGE, maxItems - read), ...(cursor === undefined ? {} : { cursor }) });
    let finishedPage = true;
    for (const item of page.items) {
      if (read >= maxItems || late()) { finishedPage = false; break; }
      read += 1;
      const row = pendingRowOf(item, Math.floor(nowMs / 1000));
      if (row === undefined || (budget.companyId !== undefined && row.orgId !== budget.companyId)) continue;
      const key = `${row.orgId}#${row.developerId}`;
      byPerson.set(key, [...(byPerson.get(key) ?? []), row]);
    }
    if (finishedPage) { cursor = page.cursor; if (budget.scan !== undefined) budget.scan.cursor = cursor; }
    else break;
  } while (cursor !== undefined && read < maxItems && !late());
  if (budget.companyId !== undefined) outcome.complete = cursor === undefined && read < maxItems && !late();
  if (cursor !== undefined) log({ event: "attention.queue_truncated", read });
  // Who is due now (outside their window, with something their quiet hours and digest let go), oldest-waiting first: only they take this sweep's places.
  const due: Array<{ rows: PendingRow[]; marker: SentMarker; prefs: Awaited<ReturnType<typeof readNotifyPrefs>>; digest: boolean }> = [];
  for (const rows of byPerson.values()) {
    if (late()) break;
    const { orgId, developerId } = rows[0]!;
    const marker = markerOf(await deps.store.get(notifySentKey(orgId, developerId)));
    if (nowMs - marker.lastAt < NOTIFY_BATCH_MINUTES * 60_000) continue;
    // Someone whose every owed target is waiting for a retry is not due either, so they never take a place from someone who can be told now.
    if ((marker.waitUntil ?? 0) > nowMs) continue;
    const prefs = await readNotifyPrefs(deps.store, orgId, developerId);
    const hold = prefs.muted ? "none" : holdOf(prefs, nowMs, marker.digestDay);
    let sendable = rows;
    if (hold !== "none") {
      sendable = [];
      for (const row of rows) {
        const urgent = deps.urgent === undefined || row.kind === "knowledge_read" ? false : await deps.urgent(orgId, { developerId, sessionId: row.sessionId, kind: row.kind }).catch(() => false);
        if (urgent === true) sendable.push(row);
      }
      outcome.held += rows.length - sendable.length;
      if (sendable.length === 0) continue;
    }
    due.push({ rows: [...sendable].sort((a, b) => a.at.localeCompare(b.at)), marker, prefs, digest: hold === "none" && prefs.digestAt !== undefined && !prefs.muted });
  }
  due.sort((a, b) => a.rows[0]!.at.localeCompare(b.rows[0]!.at));
  const sessions = new SessionStore(deps.store);
  const dropRow = (row: PendingRow): Promise<unknown> => deps.store.delete({ key: row.key }).catch(() => undefined);
  const email = emailSenderOf(deps.registry);
  let taken = 0, visitedPeople = 0;
  for (const { rows, marker, prefs, digest } of due) {
    if (late() || taken >= PEOPLE_PER_SWEEP_MAX) break;
    visitedPeople += 1;
    const { orgId, developerId } = rows[0]!;
    const current: Array<{ row: PendingRow; line: Line }> = [];
    const allowedSessions = new Map<string, AgentSessionRecord>();
    const stale: PendingRow[] = [];
    const carded = new Set<string>();
    for (const row of rows) {
      if (row.kind === "upkeep_paused") {
        // Not a session's row: the notice is about a project. Still theirs to read only while they administer it.
        const subject = upkeepSubjectOf(row.sessionId);
        // No upkeep wiring on this host: the row waits (it expires by itself) instead of being dropped over a notice that was written once for the month.
        if (deps.upkeep === undefined) continue;
        const allowed = subject !== undefined && await deps.upkeep.administers(orgId, developerId, subject.project).then((answer) => answer === true, () => false);
        if (!allowed) { stale.push(row); continue; }
        current.push({ row, line: { title: oneLine(subject.project, TITLE_MAX) || "A project", status: UPKEEP_NOTICE_WORDS[subject.reason], link: deps.upkeep.link?.(subject.project), kind: "upkeep_paused" } });
        continue;
      }
      // An admin notice has no session: it is told only to a person who is an admin now (read at delivery; no reader means no one), in its own fixed words.
      if (row.kind === "knowledge_read") {
        const still = deps.adminNotice === undefined ? false : await deps.adminNotice(orgId, developerId).catch(() => false);
        if (!still) { stale.push(row); continue; }
        current.push({ row, line: { ...ADMIN_NOTICE_LINE[row.kind], kind: row.kind } });
        continue;
      }
      if (row.kind === "setup_broken") {
        // Lead 4 U5: a project notice too. Still theirs to read only while they administer the project, and only while the setup it names is STILL broken (the re-check's own key, read now).
        const subject = setupBrokenSubjectOf(row.sessionId);
        if (deps.upkeep?.setupRead === undefined) continue;
        const allowed = subject !== undefined && await deps.upkeep.administers(orgId, developerId, subject.project).then((answer) => answer === true, () => false);
        const open = allowed ? await deps.upkeep.setupRead(orgId, subject.project).catch(() => undefined) : undefined;
        if (!allowed || open === undefined || !open.key.startsWith(subject.prefix)) { stale.push(row); continue; }
        current.push({ row, line: { title: oneLine(subject.project, TITLE_MAX) || "A project", status: oneLine(setupAdminNoticeWords(open.failedStep, open.fixReady), 400), link: deps.upkeep.setupLink?.(subject.project), kind: "setup_broken" } });
        continue;
      }
      const earlier = current.find((entry) => entry.row.sessionId === row.sessionId);
      if (earlier !== undefined) { current.push({ row, line: earlier.line }); continue; }
      const session = await sessions.get(orgId, row.sessionId);
      const access = session === undefined ? undefined : await (deps.access ?? (async (_org, person, found) => (found.owner.developerId === person ? { owner: true } : undefined)))(orgId, developerId, session).catch(() => undefined);
      const kind = session === undefined ? undefined : attentionKindOf(session.summary);
      // Still current (a later change of state supersedes the row), never "needs you" for an ended session, and still theirs to read: anything else is dropped without a word.
      if (session === undefined || access === undefined || kind !== row.kind || (session.endedAt !== undefined && kind !== "done" && kind !== "failed")) { stale.push(row); continue; }
      if (kind === "needs_you" && deps.planCarded !== undefined && await deps.planCarded(session).catch(() => false)) carded.add(row.sessionId);
      else if (kind === "needs_you" && deps.setupPausedTold !== undefined && await deps.setupPausedTold(session).catch(() => false)) carded.add(row.sessionId);
      allowedSessions.set(row.sessionId, session);
      const link = deps.link?.(session);
      current.push({ row, line: { title: oneLine(access.owner ? session.title : hideEmailAddresses(session.title), TITLE_MAX) || "A task", status: oneLine(taskStatusText(sessionTaskStatus(session.summary)), 200), link, kind } });
    }
    for (const row of stale) { await dropRow(row); outcome.dropped += 1; }
    if (current.length === 0) continue;
    // A person who muted notices is told nowhere; the rows go (Home still lists what waits for them).
    if (prefs.muted) { for (const { row } of current) await dropRow(row); continue; }
    // Where each session's change is also told: the conversation it was started from, when this person started it.
    const threadSessions = new Map<string, { target: NotifyTarget; sessions: Set<string> }>();
    if (deps.thread !== undefined) {
      for (const sessionId of new Set(current.filter(({ row }) => row.kind !== "upkeep_paused" && row.kind !== "knowledge_read" && row.kind !== "setup_broken").map(({ row }) => row.sessionId))) {
        const thread = await deps.thread(orgId, sessionId).catch(() => undefined);
        if (thread === undefined || thread.personId !== developerId) continue;
        const target: NotifyTarget = { channel: thread.conversation.channel, conversation: thread.conversation };
        const found = threadSessions.get(targetKey(target)) ?? { target, sessions: new Set<string>() };
        found.sessions.add(sessionId);
        threadSessions.set(targetKey(target), found);
      }
    }
    // Chat or email, as the person chose: email only when the email point can send and they have an address of their own; an email choice that cannot be sent falls back to the chats.
    const chatReachable = prefs.targets.length > 0 || threadSessions.size > 0;
    const rawAddress = email?.capabilities.available === true && deps.address !== undefined ? await deps.address(orgId, developerId).catch(() => undefined) : undefined;
    const address = rawAddress !== undefined && isPlainEmailAddress(rawAddress) ? rawAddress : undefined;
    const goes = effectiveNotify({ channel: prefs.channel ?? defaultNotifyChannel(chatReachable), slackLinked: chatReachable, emailAvailable: address !== undefined, emailUnsubscribed: prefs.emailUnsubscribed });
    const chosen = new Set(goes.slack ? prefs.targets.map((target) => targetKey(target)) : []);
    const wanted: NotifyTarget[] = goes.slack ? [...prefs.targets, ...[...threadSessions.values()].map(({ target }) => target).filter((target) => !chosen.has(targetKey(target)))] : [];
    const targets = wanted.slice(0, Math.min(NOTIFY_TARGETS_MAX * 2, deps.maxTargets ?? Number.POSITIVE_INFINITY));
    if (targets.length < wanted.length) log({ event: "attention.thread_targets_truncated", dropped: wanted.length - targets.length });
    const routes = [...targets.map((target) => targetKey(target)), ...(goes.email ? [EMAIL_TARGET] : [])];
    // A target tells the person about every row when they chose it (email included), and only about the sessions started there when it is the conversation of a start.
    const doneInThread = deps.doneToldInThread?.() === true;
    const appliesTo = (tkey: string, row: PendingRow): boolean => tkey === EMAIL_TARGET || chosen.has(tkey) || (threadSessions.get(tkey)?.sessions.has(row.sessionId) === true && !(doneInThread && row.kind === "done") && !(row.kind === "needs_you" && carded.has(row.sessionId)));
    // Nowhere to be told: not messaged; the rows go.
    if (routes.length === 0) { for (const { row } of current) await dropRow(row); continue; }
    taken += 1;
    let sentSomething = false, attempted = false;
    const next: SentMarker = { lastAt: marker.lastAt, failures: { ...marker.failures }, retryAt: { ...marker.retryAt }, ...(marker.digestDay === undefined ? {} : { digestDay: marker.digestDay }) };
    const setOnRows = async (owed: ReadonlyArray<{ row: PendingRow }>, ops: Parameters<DocumentStore["update"]>[0]["ops"]): Promise<void> => {
      for (const { row } of owed) await deps.store.update({ key: row.key, ops, condition: when.and(when.present(), when.eq("at", row.at)) });
    };
    for (const tkey of routes) {
      if (late()) break;
      let owed = current.filter(({ row }) => appliesTo(tkey, row) && !row.done.has(tkey));
      if (owed.length === 0) continue;
      const target = targets.find((entry) => targetKey(entry) === tkey);
      const adapter: ChannelAdapter | undefined = target === undefined ? undefined : deps.registry.get("channel", target.channel);
      // A channel nobody serves, or one that cannot message first (for a target the person chose; a conversation of a start is a reply), will not succeed by trying again: it is counted as unreachable and marked, never retried.
      const otherCompany = target !== undefined && !(await tenantIsCompanys(deps.companyOf, orgId, target.channel, target.conversation.tenant));
      if (otherCompany) log({ event: "attention.other_company", channel: target.channel });
      if (tkey !== EMAIL_TARGET && (adapter === undefined || otherCompany || (!adapter.capabilities.proactive && chosen.has(tkey)))) {
        outcome.unreachable += 1;
        for (const { row } of owed) row.done.add(tkey);
        continue;
      }
      if ((next.retryAt[tkey] ?? 0) > nowMs) continue;
      attempted = true;
      if (tkey === EMAIL_TARGET) {
        // Claimed before the send, so an email is sent at most once. The claim is one transaction over the rows it covers: either every row is claimed or none is, so a claim that fails part-way never
        // leaves a row marked as emailed that no email carried. A claim that cannot be written sends nothing now (tried again later).
        const claimed = await claimEmailRows(deps.store, owed, nowMs).catch((error: unknown) => { log({ event: "attention.claim_failed", channel: EMAIL_TARGET, error: error instanceof Error ? error.name : "unknown" }); return undefined; });
        if (claimed === undefined || claimed.length === 0) continue;
        owed = claimed;
      }
      const lines = [...new Map(owed.map(({ row, line }) => [row.sessionId, line])).values()];
      const shown = lines.slice(0, NOTIFY_ITEMS_MAX), more = lines.length - shown.length;
      const allFailed = lines.every((line) => line.kind === "failed"), allDone = lines.every((line) => line.kind === "done"), allNotice = lines.every((line) => line.kind === "knowledge_read");
      let ok = false, refused = false;
      if (tkey === EMAIL_TARGET) {
        const mail = attentionEmail(shown, more, digest ? "digest" : allDone ? "done" : allNotice ? "notice" : "attention", typeof deps.emailLinks === "function" ? deps.emailLinks(orgId, developerId) : deps.emailLinks);
        try {
          await email!.send({ companyId: orgId, purpose: "attention", to: address!, subject: mail.subject, text: mail.text, ...(mail.unsubscribeUrl === undefined ? {} : { unsubscribeUrl: mail.unsubscribeUrl }), deadline: Date.now() + ATTENTION_SEND_TIMEOUT_MS }); // the port's deadline is on the real clock, whatever clock the sweep reads
          ok = true;
        } catch (error) {
          refused = error instanceof EmailError && !error.retryable;
          log({ event: "attention.send_failed", channel: EMAIL_TARGET, error: error instanceof EmailError ? error.code : error instanceof Error ? error.name : "unknown" });
        }
      } else {
        const maxLength = adapter!.capabilities.maxTextLength;
        let text = digest ? digestText(shown, more, maxLength, deps.footer) : allDone ? doneText(shown, maxLength, deps.footer) : allNotice ? noticeText(shown, more, maxLength, deps.footer) : attentionText(shown, more, maxLength, deps.footer);
        text = await withApplicationNoticeSummaries(deps, owed, allowedSessions, text, maxLength);
        const base = { version: 1 as const, id: batchEventId(orgId, developerId, tkey, owed.map(({ row }) => ({ sk: row.key.sk, at: row.at }))), channel: target!.channel, conversation: target!.conversation, createdAt: new Date(nowMs).toISOString() };
        const event = (allDone && !digest ? { ...base, type: "done", data: { text } } : allFailed && !digest ? { ...base, type: "error", data: { code: "task_failed", text } } : { ...base, type: "progress", data: { text } }) as ChannelEvent;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([adapter!.deliver(event), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ATTENTION_SEND_TIMEOUT_MS); })]);
          ok = true;
        } catch (error) {
          log({ event: "attention.send_failed", channel: target!.channel, error: error instanceof Error ? error.name : "unknown" });
        } finally {
          clearTimeout(timer);
        }
      }
      const failures = ok ? 0 : (next.failures[tkey] ?? 0) + 1;
      const gaveUp = !ok && (refused || failures >= ATTENTION_TARGET_TRIES_MAX);
      if (ok || gaveUp) {
        for (const { row } of owed) row.done.add(tkey);
        delete next.failures[tkey];
        delete next.retryAt[tkey];
        if (tkey === EMAIL_TARGET) await setOnRows(owed, [change.set("emailSent", true)]).catch((error: unknown) => log({ event: "attention.mark_failed", channel: EMAIL_TARGET, error: error instanceof Error ? error.name : "unknown" }));
      } else if (tkey === EMAIL_TARGET) {
        // Not sent: the claim is given back so the retry sends it. If even that fails it is never sent twice: at most once, logged.
        await deps.store.transact(owed.map(({ row }) => ({ kind: "update" as const, key: row.key, ops: [change.remove("emailClaimed")], condition: when.present() }))).catch((error: unknown) => log({ event: "attention.unclaim_failed", channel: EMAIL_TARGET, error: error instanceof Error ? error.name : "unknown" }));
      }
      if (ok) { sentSomething = true; if (tkey === EMAIL_TARGET) outcome.emails += 1; else outcome.sent += 1; }
      else if (gaveUp) { outcome.gaveUp += 1; log({ event: "attention.target_gave_up", channel: tkey === EMAIL_TARGET ? EMAIL_TARGET : target!.channel }); }
      else { outcome.failed += 1; next.failures[tkey] = failures; next.retryAt[tkey] = nowMs + ATTENTION_RETRY_BASE_MS * 2 ** (failures - 1); }
    }
    if (sentSomething) {
      outcome.people += 1;
      next.lastAt = nowMs;
      if (digest) next.digestDay = digestSlotDay(prefs, nowMs);
    }
    // When every target still owed waits for a retry, the person is not due again before the first of them.
    const waiting = routes.filter((tkey) => current.some(({ row }) => appliesTo(tkey, row) && !row.done.has(tkey))).map((tkey) => next.retryAt[tkey]);
    if (!sentSomething && waiting.length > 0 && waiting.every((at) => at !== undefined && at > nowMs)) next.waitUntil = Math.min(...(waiting as number[]));
    if (!attempted) taken -= 1;
    // What each target received is marked on the rows; an event already sent has a stable id, so a mark that fails is only logged.
    for (const { row } of current) {
      if (routes.every((tkey) => !appliesTo(tkey, row) || row.done.has(tkey))) { await dropRow(row); continue; }
      await deps.store.update({ key: row.key, ops: [change.set("doneTargets", [...row.done])], condition: when.and(when.present(), when.eq("at", row.at)) }).catch((error: unknown) => log({ event: "attention.mark_failed", error: error instanceof Error ? error.name : "unknown" }));
    }
    await deps.store.put({
      item: {
        ...notifySentKey(orgId, developerId), entityType: "NOTIFY_SENT", orgId, developerId, lastAt: next.lastAt, failures: next.failures, retryAt: next.retryAt,
        ...(next.waitUntil === undefined ? {} : { waitUntil: next.waitUntil }), ...(next.digestDay === undefined ? {} : { digestDay: next.digestDay }),
        // The digest day must outlive a day, or tomorrow's slot would be served twice.
        [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + (next.digestDay === undefined ? SENT_KEEP_SECONDS : 3 * SENT_KEEP_SECONDS),
      },
    });
  }
  if (budget.companyId !== undefined) outcome.complete = outcome.complete === true && visitedPeople === due.length && !late();
  if (outcome.people > 0 || outcome.dropped > 0 || outcome.failed > 0) log({ event: "attention.delivered", ...outcome });
  return outcome;
}
