// Lead 4 L4-SRC-TK: ticket comments as a (weak) lessons source. At the end of a task that a TICKET started (intake's strict rule, never a ticket someone linked by hand), the comments on that one ticket are read ONCE through the
// tracker plug-in and the few that read as a project member's correction become `ticket_comment` spans. Nothing is watched live and nothing else in the tracker is read. This file is the pure filter: every comment is kept
// out unless ALL of these hold, each one a separate check (and a separate test and mutant):
//   1. it was CREATED after the task started and at or before it ended, and was not edited after it ended (`inWindow`): words written before the task are the ticket's own brief, words after the end are not part of this task;
//   2. its author is a real person's account: not a bot or an automation account, not a service-desk customer, not Rovara's own comment (`isRovareComment`: an account marked as automation by the adapter, or one of Rovara's own
//      fixed openings; a laptop's key is the owner's own account, so Rovara's echo must be told apart by its words), and the account has a stable id;
//   3. that account maps to a person of this company (the identity port, by the tracker's own account id, never by a name or an email) who is on the project's roster NOW and is not erased (`standingOf`);
//   4. its words read as a correction: the same no-AI filter the review comments use (`correction-filter.ts`: praise, nits and bare questions are not).
// The span is the person's words, cleaned (secrets redacted, hidden characters removed, at most 500 characters). Only the lesson's own short text and a record id (`ticket:<tracker>:<ticket>:<comment id>`, no text) are ever
// stored. The span's kind is weak (`weak-source.ts`): a lesson that rests on it alone waits for a second sighting and is always approved by a person.
// Audience note: the span is the project's (strict origin means intake started this task from a ticket in the project's own team pick, checked then; a ticket moved to another team since is not re-checked: accepted, the lesson still
// needs a person's approval and its source shows as a ticket). One total limit per call: at most `MAX_ROWS` comments are looked at (more: none is used), at most `MAX_AUTHORS` accounts are looked up, at most `MAX_SPANS` spans are returned (the newest).
import { isTrackerAccountId } from "./ticket-ids.js";
import { looksLikeCorrection } from "./correction-filter.js";
import { cleanForLearning } from "./guards.js";
import type { EvidenceSpan } from "./reflect-input.js";
import type { LessonStore, ProjectFlags, ScopeKey } from "./store.js";
import { normSource, type TrustClass } from "./types.js";

/** One read reaches at most this many comments (five pages of 100): a bigger list is not read at all, never cut. */
export const MAX_ROWS = 500;
export const MAX_AUTHORS = 20;
export const MAX_SPANS = 10;
export const TICKET_COMMENT_CHARS = 500;
/** The pause key (`kind:<span kind>`) a person's Pause of the ticket source is stored under, the same shape as every other source's. */
export const TICKET_PAUSE_KEY = "kind:ticket_comment";
/** The trackers the ticket source reads (the flood guard names the source `<tracker>:<project>`). */
const TICKET_TRACKERS: readonly string[] = ["linear", "jira"];

/** One comment as the tracker plug-in reported it, reduced to what the filter reads. */
export interface TicketCommentRow {
  id: string;
  /** The tracker's own stable id of the author's account. Absent: nobody can be named. */
  accountId?: string | undefined;
  /** The adapter says the account is an automation account, a customer, or Rovara's own. */
  isBot: boolean;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface TicketCommentsInput {
  /** The tracker (`linear`, `jira`) and the ticket's own id (`ENG-12`) as intake recorded them. */
  tracker: string;
  ticket: string;
  /** The Rovara project (the source key's name). */
  project: string;
  /** The task's own start, and its end (ms since the epoch). */
  startedAt: number;
  endedAt: number;
  rows: readonly TicketCommentRow[];
  /** The person of a company this tracker account is, by the identity port; undefined for any account it cannot place. The id is the lessons' developer id. */
  personOf(accountId: string): Promise<string | undefined>;
  /** The person's standing in the project NOW: `member` (on the roster), `outsider`, or undefined (erased, or not readable). */
  standingOf(personId: string): Promise<TrustClass | undefined>;
}

/** The openings of what Rovara itself writes on a ticket (the status line, the thread's root, its replies). A laptop writes with the owner's own account, so these are told apart by their words. A person who begins with the same words is left out too: leaving a comment out costs nothing. */
const ROVARA_OPENINGS: readonly RegExp[] = [
  /^\s*Rovara(?:'s)?\b/u, /^\s*Decision(?:s)? recorded\b/u, /^\s*Plan ready for review\b/u, /^\s*Pull request opened:/u,
];
/** Whether a comment is Rovara's own (see the top of the file). */
export const isRovareComment = (body: string): boolean => ROVARA_OPENINGS.some((pattern) => pattern.test(body));

const time = (value: string): number => Date.parse(value);

/** Created after the task started and at or before it ended, and not changed after it ended. A time that cannot be read is outside the window (fail closed). */
export function inWindow(row: Pick<TicketCommentRow, "createdAt" | "updatedAt">, startedAt: number, endedAt: number): boolean {
  const created = time(row.createdAt);
  const updated = time(row.updatedAt);
  if (!Number.isFinite(created) || !Number.isFinite(updated) || !Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return false;
  return created > startedAt && created <= endedAt && updated <= endedAt;
}

/** The record id of a comment: names the ticket and the comment and holds no text. One line of at most 100 characters. */
export const ticketEventId = (tracker: string, ticket: string, commentId: string): string => `ticket:${tracker}:${ticket}:${commentId}`.slice(0, 100);

/** The source key of the project's ticket source: `linear:<project>`, `jira:<project>` (a non-person source: spike detection counts it and a flood holds it). */
export const ticketSourceKey = (tracker: string, project: string): string => `${tracker}:${project}`.slice(0, 100);

/** The spans of the comments that pass every check above, newest `MAX_SPANS`. Never throws for a comment it cannot use: that comment is left out. A lookup that throws is the caller's (the caller treats it as no spans). */
export async function ticketCommentSpans(input: TicketCommentsInput): Promise<EvidenceSpan[]> {
  // More rows than one read can reach is not a whole answer: nothing is used (never the oldest part of it).
  if (input.rows.length > MAX_ROWS) return [];
  const people = new Map<string, { person: string; trust: TrustClass } | null>();
  const kept: Array<{ at: number; span: EvidenceSpan }> = [];
  for (const row of input.rows) {
    if (row.isBot || row.accountId === undefined || !isTrackerAccountId(row.accountId)) continue;
    const body = row.body.trim();
    if (body === "" || isRovareComment(body)) continue;
    if (!inWindow(row, input.startedAt, input.endedAt)) continue;
    if (!looksLikeCorrection(body)) continue;
    let who = people.get(row.accountId);
    if (who === undefined) {
      if (people.size >= MAX_AUTHORS) continue;
      const person = await input.personOf(row.accountId);
      const trust = person === undefined ? undefined : await input.standingOf(person);
      who = person === undefined || trust !== "member" ? null : { person, trust };
      people.set(row.accountId, who);
    }
    if (who === null) continue;
    const text = cleanForLearning(body, TICKET_COMMENT_CHARS);
    if (text === "") continue;
    kept.push({
      at: time(row.createdAt),
      span: {
        kind: "ticket_comment", text, trust: who.trust, authorId: who.person, eventId: ticketEventId(input.tracker, input.ticket, row.id), sourceKey: ticketSourceKey(input.tracker, input.project),
        audience: { kind: "project" },
      },
    });
  }
  return kept.sort((a, b) => a.at - b.at || (a.span.eventId ?? "").localeCompare(b.span.eventId ?? "")).slice(-MAX_SPANS).map((entry) => entry.span);
}

/**
 * Whether the project's ticket source is paused: read live, and it FAILS CLOSED (a store that cannot be read means "do not read"). The source is paused under ANY of its names: `kind:ticket_comment` (a person's Pause of the kind,
 * the same shape as every other source's) and `<tracker>:<project>` (the source key the flood guard pauses when the source spikes: `ticketSourceKey`, for each tracker this reads). Whoever set it: a wider stop is the safe
 * side. A paused source is not read at all (no tracker call, nothing gathered).
 */
export async function ticketSourcePaused(store: Pick<LessonStore, "flags">, key: ScopeKey): Promise<boolean> {
  let flags: ProjectFlags;
  try { flags = await store.flags(key); } catch { return true; }
  const names = new Set([TICKET_PAUSE_KEY, ...TICKET_TRACKERS.map((tracker) => ticketSourceKey(tracker, key.project))].map(normSource));
  return Object.keys(flags.pausedSources ?? {}).some((name) => names.has(normSource(name)));
}
