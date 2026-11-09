// Notifications (lane L6b, inventory B10; the hosted product's UX2 slice 2 item 5): every event that needs a person reaches them, wherever the task was started. Channel only: the message goes out through
// the plug-in registry's channel adapters (Pratik's `ChannelAdapter.deliver(ChannelEvent)`), never through a provider's own code. The hosted product's email and Slack direct messages are two channels of
// the same kind; here they are adapters, and email is an adapter someone writes.
//
//   queue    When a session's summary commits a change into a state that asks someone to act (Needs you, Paused: needs more budget, Ready to merge, Failed) or is over (Merged, Closed), `queueAttention` writes one
//            pending row per person to tell: the owner, and the people the summary names as needed. A later change of the same kind for the same person and session replaces the row, so nothing piles up.
//   deliver  The session sweep calls `deliverAttention`. Each person gets at most one message per target every `NOTIFY_BATCH_MINUTES`: everything pending is batched into it. Before anything is sent, each row is
//            checked again: the session still exists, it still stands in the state the row was written for, and the person may still READ it. Rows that fail any check are dropped silently.
//
// A TARGET is a conversation on a channel the person chose (`NotifyTarget`). The event id is derived from the batch it carries, so a retry of the same batch is the same event and the adapter drops a repeat
// (the channel protocol: `event.id` is stable across retries). A message holds the task's title, its status sentence (fixed words) and a link supplied by the surface that serves the task page. Never task content
// beyond that, never a secret. Logs carry fixed codes and counts only.
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ConversationRefSchema, INDEX_EXPIRY_ATTRIBUTE, NOTIFY_BATCH_MINUTES, NOTIFY_ITEMS_MAX, change, conversationSubject, hideEmailAddresses, sessionTaskStatus, taskStatusText, when,
  type AgentSessionRecord, type ChannelAdapter, type ChannelEvent, type DocumentStore, type OrgId, type RegistryView, type SessionSummary, type StoredDocument,
} from "@agentx/contracts";
import type { SessionChange } from "../sessions/summary.js";
import { SessionStore } from "../sessions/store.js";

type Log = (entry: Record<string, unknown>) => void;

/** What a person is told about. */
export type AttentionKind = "needs_you" | "paused" | "ready" | "failed" | "done";

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
export const NOTIFY_TARGETS_MAX = 5;

/** Where a person is told: a conversation on a channel an adapter serves. */
export const NotifyTargetSchema = z.object({ channel: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/u), conversation: ConversationRefSchema }).strict()
  .refine((target) => target.conversation.channel === target.channel, { message: "the conversation is on another channel", path: ["conversation"] });
export type NotifyTarget = z.infer<typeof NotifyTargetSchema>;
export const NotifyPrefsBodySchema = z.object({ targets: z.array(NotifyTargetSchema).max(NOTIFY_TARGETS_MAX), muted: z.boolean().optional() }).strict();

export const prefsKey = (orgId: string, developerId: string) => ({ pk: `NOTIFY_PREFS#${orgId}`, sk: `DEV#${developerId}` });
const sentKey = (orgId: string, developerId: string) => ({ pk: `NOTIFY_SENT#${orgId}`, sk: `DEV#${developerId}` });
const pendingKey = (orgId: string, developerId: string, sessionId: string, kind: AttentionKind) => ({ pk: PENDING_PK, sk: `${orgId}#${developerId}#${sessionId}#${kind}` });

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

// ---- preferences

export interface NotifyPrefs { targets: NotifyTarget[]; muted: boolean }

const targetKey = (target: NotifyTarget): string => `${target.channel}:${conversationSubject(target.conversation)}`;

export async function readNotifyPrefs(store: Pick<DocumentStore, "get">, orgId: string, developerId: string): Promise<NotifyPrefs> {
  const item = await store.get(prefsKey(orgId, developerId));
  if (item === undefined || item["orgId"] !== orgId) return { targets: [], muted: false };
  const parsed = z.array(NotifyTargetSchema).max(NOTIFY_TARGETS_MAX).safeParse(item["targets"] ?? []);
  return { targets: parsed.success ? parsed.data : [], muted: item["muted"] === true };
}

/** Sets where a person is told. The row's other attributes (the hosted product's channel choice) are left as they are. A body the schema refuses is an error. */
export async function writeNotifyPrefs(deps: { store: Pick<DocumentStore, "update">; now: () => Date }, orgId: OrgId, developerId: string, body: unknown): Promise<NotifyPrefs> {
  const parsed = NotifyPrefsBodySchema.parse(body);
  const unique = [...new Map(parsed.targets.map((target) => [targetKey(target), target] as const)).values()];
  await deps.store.update({
    key: prefsKey(orgId, developerId),
    ops: [change.setIfAbsent("entityType", "NOTIFY_PREFS"), change.set("orgId", orgId), change.set("developerId", developerId), change.set("targets", JSON.parse(JSON.stringify(unique)) as never), change.set("muted", parsed.muted === true), change.set("updatedAt", deps.now().toISOString())],
  });
  return { targets: unique, muted: parsed.muted === true };
}

// ---- queue

/** Who is told about a change of this kind: the owner and, for a wait or a pause, the people the summary names as needed. A closed task tells only its owner when it merged. */
export function attentionRecipients(session: AgentSessionRecord, summary: SessionSummary, kind: AttentionKind): string[] {
  const owner = session.owner.developerId;
  const named = summary.needsPeople.filter((id) => /^[a-f0-9]{64}$/u.test(id));
  const ownerToo = kind !== "done" || sessionTaskStatus(summary).state === "merged";
  const people = [...(ownerToo ? [owner] : []), ...(kind === "needs_you" || kind === "paused" ? named : [])];
  return [...new Set(people)].slice(0, RECIPIENTS_MAX);
}

/**
 * After a refresh committed: when the session moved into a state someone is told about, one pending row per person. Only task sessions. Never throws: a notification is never a reason for a refresh to fail.
 * Use it as a session change hook.
 */
export async function queueAttention(deps: { store: Pick<DocumentStore, "put">; now?: () => Date; log?: Log }, change: SessionChange): Promise<number> {
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
    const people = attentionRecipients(change.session, change.summary, kind);
    const nowMs = (deps.now ?? (() => new Date()))().getTime();
    for (const developerId of people) {
      await deps.store.put({
        item: { ...pendingKey(change.orgId, developerId, change.sessionId, kind), entityType: "NOTIFY_PENDING", orgId: change.orgId, developerId, sessionId: change.sessionId, kind, at: change.at, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + PENDING_KEEP_SECONDS },
      });
    }
    return people.length;
  } catch (error) {
    (deps.log ?? ((entry) => console.log(JSON.stringify({ component: "broker", ...entry }))))({ event: "attention.queue_failed", sessionId: change.sessionId, error: error instanceof Error ? error.name : "unknown" });
    return 0;
  }
}

// ---- deliver

export interface AttentionDeliveryDependencies {
  store: DocumentStore;
  /** Where the channel adapters are: `registry.get("channel", id)`. */
  registry: Pick<RegistryView, "get">;
  now: () => number;
  /** The address of a session's page, built by the surface that serves it; undefined when there is none (the message then has no link). */
  link?: (session: AgentSessionRecord) => string | undefined;
  /** Whether the person may READ the session now. Default: the session's owner. */
  access?: (orgId: OrgId, developerId: string, session: AgentSessionRecord) => Promise<{ owner: boolean } | undefined>;
  log?: Log;
}

interface Line { title: string; status: string; link?: string | undefined; kind: AttentionKind }

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
};

/** The message text: the tasks (title, status sentence, link). Plain text; an adapter formats it for its channel. */
export function attentionText(lines: readonly Line[], more: number, maxLength: number): string {
  const count = lines.length + more;
  const body = [
    count === 1 ? "A task needs your attention in Rovara:" : "These tasks need your attention in Rovara:",
    ...lines.map((line) => `- ${line.title}: ${line.status}${line.link === undefined ? "" : ` ${line.link}`}`),
    ...(more > 0 ? [`- and ${String(more)} more`] : []),
  ].join("\n");
  const chars = [...body];
  return chars.length <= maxLength ? body : `${chars.slice(0, maxLength - 1).join("")}…`;
}

const doneText = (lines: readonly Line[], maxLength: number): string => attentionText(lines, 0, maxLength).replace(/^A task needs your attention in Rovara:/u, "A task finished in Rovara:").replace(/^These tasks need your attention in Rovara:/u, "These tasks finished in Rovara:");

/** The event id of a batch: the same rows to the same target are the same event, so an adapter that is told twice drops the repeat. */
export function batchEventId(orgId: string, developerId: string, target: string, rows: readonly { sk: string; at: string }[]): string {
  const digest = createHash("sha256").update(JSON.stringify([orgId, developerId, target, rows.map((row) => `${row.sk}@${row.at}`).sort()]), "utf8").digest("base64url");
  return `evt_${digest.slice(0, 32)}`;
}

interface PendingRow { key: { pk: string; sk: string }; orgId: OrgId; developerId: string; sessionId: string; kind: AttentionKind; at: string; done: Set<string> }

function pendingRowOf(item: StoredDocument, nowSeconds: number): PendingRow | undefined {
  const { orgId, developerId, sessionId, kind, at, sk } = item;
  if (typeof orgId !== "string" || typeof developerId !== "string" || typeof sessionId !== "string" || typeof at !== "string" || typeof sk !== "string") return undefined;
  if (typeof kind !== "string" || !["needs_you", "paused", "ready", "failed", "done"].includes(kind) || sk !== `${orgId}#${developerId}#${sessionId}#${kind}`) return undefined;
  // A row past its expiry is not delivered (the store deletes expired items late).
  const expires = item[INDEX_EXPIRY_ATTRIBUTE];
  if (typeof expires === "number" && expires <= nowSeconds) return undefined;
  const done = new Set(Array.isArray(item["doneTargets"]) ? item["doneTargets"].filter((entry): entry is string => typeof entry === "string") : []);
  return { key: { pk: PENDING_PK, sk }, orgId: orgId, developerId, sessionId, kind: kind as AttentionKind, at, done };
}

/** One person's marker: when it last sent anything, and per target how many tries failed in a row and when it may try again. */
interface SentMarker { lastAt: number; failures: Record<string, number>; retryAt: Record<string, number>; /** Every target owed to this person waits for a retry until then; they take no place before it. */ waitUntil?: number | undefined }

function markerOf(item: StoredDocument | undefined): SentMarker {
  const numbers = (value: unknown): Record<string, number> => (typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))) : {});
  const waitUntil = item?.["waitUntil"];
  return { lastAt: typeof item?.["lastAt"] === "number" ? item["lastAt"] : 0, failures: numbers(item?.["failures"]), retryAt: numbers(item?.["retryAt"]), ...(typeof waitUntil === "number" ? { waitUntil } : {}) };
}

export interface AttentionBudget { deadlineMs?: number | undefined }
export interface AttentionOutcome { people: number; sent: number; dropped: number; failed: number; gaveUp: number; unreachable: number }

/**
 * The sweep's delivery. The queue is read in pages (at most `ATTENTION_READ_MAX` rows; rows past their expiry are left out). People still inside their batching window are set aside BEFORE the
 * `PEOPLE_PER_SWEEP_MAX` people of this sweep are chosen, and those are taken oldest-waiting first, so nobody's rows are starved by others'. For each person, one event per chosen target lists what is still
 * current and still theirs to read. Each target is sent on its own: a failing one never holds back another; what one target received is marked on the rows, so it is not sent again; a failing target is tried
 * again after a growing wait and gives up after `ATTENTION_TARGET_TRIES_MAX` tries. A target whose adapter cannot message first (`proactive` false) or is not registered is not tried. Rows go once every chosen
 * target has them. Never past `deadlineMs`. Answers counts only.
 */
export async function deliverAttention(deps: AttentionDeliveryDependencies, budget: AttentionBudget = {}): Promise<AttentionOutcome> {
  const log = deps.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry })));
  const outcome: AttentionOutcome = { people: 0, sent: 0, dropped: 0, failed: 0, gaveUp: 0, unreachable: 0 };
  const nowMs = deps.now();
  const late = () => budget.deadlineMs !== undefined && deps.now() >= budget.deadlineMs;
  const byPerson = new Map<string, PendingRow[]>();
  let cursor: string | undefined;
  let read = 0;
  do {
    const page = await deps.store.query({ pk: PENDING_PK, limit: PENDING_PAGE, ...(cursor === undefined ? {} : { cursor }) });
    for (const item of page.items) {
      read += 1;
      const row = pendingRowOf(item, Math.floor(nowMs / 1000));
      if (row === undefined) continue;
      const key = `${row.orgId}#${row.developerId}`;
      byPerson.set(key, [...(byPerson.get(key) ?? []), row]);
    }
    cursor = page.cursor;
  } while (cursor !== undefined && read < ATTENTION_READ_MAX && !late());
  if (cursor !== undefined) log({ event: "attention.queue_truncated", read });
  // Who is due now (outside their window), oldest-waiting first: only they take this sweep's places.
  const due: Array<{ rows: PendingRow[]; marker: SentMarker }> = [];
  for (const rows of byPerson.values()) {
    if (late()) break;
    const { orgId, developerId } = rows[0]!;
    const marker = markerOf(await deps.store.get(sentKey(orgId, developerId)));
    if (nowMs - marker.lastAt < NOTIFY_BATCH_MINUTES * 60_000) continue;
    // Someone whose every owed target is waiting for a retry is not due either, so they never take a place from someone who can be told now.
    if ((marker.waitUntil ?? 0) > nowMs) continue;
    due.push({ rows: [...rows].sort((a, b) => a.at.localeCompare(b.at)), marker });
  }
  due.sort((a, b) => a.rows[0]!.at.localeCompare(b.rows[0]!.at));
  const sessions = new SessionStore(deps.store);
  const dropRow = (row: PendingRow): Promise<unknown> => deps.store.delete({ key: row.key }).catch(() => undefined);
  let taken = 0;
  for (const { rows, marker } of due) {
    if (late() || taken >= PEOPLE_PER_SWEEP_MAX) break;
    const { orgId, developerId } = rows[0]!;
    const current: Array<{ row: PendingRow; line: Line }> = [];
    const stale: PendingRow[] = [];
    for (const row of rows) {
      const earlier = current.find((entry) => entry.row.sessionId === row.sessionId);
      if (earlier !== undefined) { current.push({ row, line: earlier.line }); continue; }
      const session = await sessions.get(orgId, row.sessionId);
      const access = session === undefined ? undefined : await (deps.access ?? (async (_org, person, found) => (found.owner.developerId === person ? { owner: true } : undefined)))(orgId, developerId, session).catch(() => undefined);
      const kind = session === undefined ? undefined : attentionKindOf(session.summary);
      // Still current (a later change of state supersedes the row), never "needs you" for an ended session, and still theirs to read: anything else is dropped without a word.
      if (session === undefined || access === undefined || kind !== row.kind || (session.endedAt !== undefined && kind !== "done" && kind !== "failed")) { stale.push(row); continue; }
      const link = deps.link?.(session);
      current.push({ row, line: { title: oneLine(access.owner ? session.title : hideEmailAddresses(session.title), TITLE_MAX) || "A task", status: oneLine(taskStatusText(sessionTaskStatus(session.summary)), 200), link, kind } });
    }
    for (const row of stale) { await dropRow(row); outcome.dropped += 1; }
    if (current.length === 0) continue;
    const prefs = await readNotifyPrefs(deps.store, orgId, developerId);
    // A person who muted notices, or has nowhere to be told, is not messaged; the rows go (Home still lists what waits for them).
    if (prefs.muted || prefs.targets.length === 0) { for (const { row } of current) await dropRow(row); continue; }
    taken += 1;
    let sentSomething = false, attempted = false;
    const next: SentMarker = { lastAt: marker.lastAt, failures: { ...marker.failures }, retryAt: { ...marker.retryAt } };
    for (const target of prefs.targets) {
      const tkey = targetKey(target);
      const owed = current.filter(({ row }) => !row.done.has(tkey));
      if (owed.length === 0) continue;
      const adapter: ChannelAdapter | undefined = deps.registry.get("channel", target.channel);
      // A channel nobody serves, or one that cannot message first, will not succeed by trying again: it is counted as unreachable and marked, never retried.
      if (adapter === undefined || !adapter.capabilities.proactive) {
        outcome.unreachable += 1;
        for (const { row } of owed) row.done.add(tkey);
        continue;
      }
      if ((next.retryAt[tkey] ?? 0) > nowMs) continue;
      attempted = true;
      const lines = [...new Map(owed.map(({ row, line }) => [row.sessionId, line])).values()];
      const shown = lines.slice(0, NOTIFY_ITEMS_MAX), more = lines.length - shown.length;
      const allFailed = lines.every((line) => line.kind === "failed"), allDone = lines.every((line) => line.kind === "done");
      const text = allDone ? doneText(shown, adapter.capabilities.maxTextLength) : attentionText(shown, more, adapter.capabilities.maxTextLength);
      const base = { version: 1 as const, id: batchEventId(orgId, developerId, tkey, owed.map(({ row }) => ({ sk: row.key.sk, at: row.at }))), channel: target.channel, conversation: target.conversation, createdAt: new Date(nowMs).toISOString() };
      const event = (allDone ? { ...base, type: "done", data: { text } } : allFailed ? { ...base, type: "error", data: { code: "task_failed", text } } : { ...base, type: "progress", data: { text } }) as ChannelEvent;
      let ok = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([adapter.deliver(event), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ATTENTION_SEND_TIMEOUT_MS); })]);
        ok = true;
      } catch (error) {
        log({ event: "attention.send_failed", channel: target.channel, error: error instanceof Error ? error.name : "unknown" });
      } finally {
        clearTimeout(timer);
      }
      const failures = ok ? 0 : (next.failures[tkey] ?? 0) + 1;
      const gaveUp = !ok && failures >= ATTENTION_TARGET_TRIES_MAX;
      if (ok || gaveUp) {
        for (const { row } of owed) row.done.add(tkey);
        delete next.failures[tkey];
        delete next.retryAt[tkey];
      }
      if (ok) { sentSomething = true; outcome.sent += 1; }
      else if (gaveUp) { outcome.gaveUp += 1; log({ event: "attention.target_gave_up", channel: target.channel }); }
      else { outcome.failed += 1; next.failures[tkey] = failures; next.retryAt[tkey] = nowMs + ATTENTION_RETRY_BASE_MS * 2 ** (failures - 1); }
    }
    if (sentSomething) { outcome.people += 1; next.lastAt = nowMs; }
    // When every target still owed waits for a retry, the person is not due again before the first of them.
    const waiting = prefs.targets.filter((target) => current.some(({ row }) => !row.done.has(targetKey(target)))).map((target) => next.retryAt[targetKey(target)]);
    if (!sentSomething && waiting.length > 0 && waiting.every((at) => at !== undefined && at > nowMs)) next.waitUntil = Math.min(...(waiting as number[]));
    if (!attempted) taken -= 1;
    // What each target received is marked on the rows; an event already sent has a stable id, so a mark that fails is only logged.
    for (const { row } of current) {
      if (prefs.targets.every((target) => row.done.has(targetKey(target)))) { await dropRow(row); continue; }
      await deps.store.update({ key: row.key, ops: [change.set("doneTargets", [...row.done])], condition: when.and(when.present(), when.eq("at", row.at)) }).catch((error: unknown) => log({ event: "attention.mark_failed", error: error instanceof Error ? error.name : "unknown" }));
    }
    await deps.store.put({
      item: {
        ...sentKey(orgId, developerId), entityType: "NOTIFY_SENT", orgId, developerId, lastAt: next.lastAt, failures: next.failures, retryAt: next.retryAt,
        ...(next.waitUntil === undefined ? {} : { waitUntil: next.waitUntil }), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + SENT_KEEP_SECONDS,
      },
    });
  }
  if (outcome.people > 0 || outcome.dropped > 0 || outcome.failed > 0) log({ event: "attention.delivered", ...outcome });
  return outcome;
}
