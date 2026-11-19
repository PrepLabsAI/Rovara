// The words of a ticket thread (design B3), drawn from the task log: the ROOT comment Rovara edits in place (the state, the plan's summary, the decisions, the pull request, the link to the task page) and the
// REPLIES (each one a short block that notifies someone, so each is budgeted). Pure: the same log gives the same words, so an edit that changes nothing is detected by comparing them.
//
// What is drawn depends on the level (`TICKET_UPDATE_LEVELS`), and the level is checked here, on every entry, by its kind: `decisions` draws questions only with their answers, answers and approvals, the status and the pull
// request; `plan_decisions` adds the plan's summary lines and risk; `full` adds the replies for a question, for the plan ready and for the pull request. `status_only` has no thread (`handler.ts`). Entries that
// were recorded before the project chose its level (`since`) are not drawn: the choice applies to what happens after it.
//
// Everything written here is already redacted when the log was written and is made inert again for the ticket (no mention, no markup, no link but a plain https address Rovara vouches for), one bounded block.
import { TASK_LOG_SURFACE_WORDS, type TaskLogEntry, type TaskLogEntryOf, type TicketUpdateLevel } from "@agentx/contracts";
import { inertTicketLine, inertTicketTitle, plainHttpsLink } from "./text.js";

export const ROOT_MAX_CHARS = 6_000;
export const REPLY_MAX_CHARS = 1_500;
export const THREAD_DECISIONS_SHOWN = 20;
const LINE = 500;

/** The kinds that carry what people said or what the plan says: they need the project's choice (and are dropped before it). */
const CONTENT_KINDS: ReadonlySet<TaskLogEntry["kind"]> = new Set(["question", "answer", "approval", "plan_summary"]);

/** The entries a level may draw, and none from before the project chose it. A status and a pull request (what `status_only` already says) are always drawn; the rest need the level and a time at or after `since`. */
export function visibleEntries(level: TicketUpdateLevel, entries: readonly TaskLogEntry[], since: string | undefined): TaskLogEntry[] {
  if (level === "status_only") return entries.filter((entry) => entry.kind === "status" || entry.kind === "pr");
  return entries.filter((entry) => {
    if (!CONTENT_KINDS.has(entry.kind)) return true;
    if (entry.kind === "plan_summary" && level === "decisions") return false;
    return since === undefined || entry.at >= since;
  });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
/** "Nov 17 14:10 UTC". */
export function whenWords(at: string): string {
  const date = new Date(at);
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${MONTHS[date.getUTCMonth()]!} ${String(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())} UTC`;
}

const MOMENT_STATE = { started: "Working on it", plan_ready: "Waiting for plan approval", pr_opened: "Pull request open, waiting for review", merged: "Merged", closed: "Closed" } as const;
const OUTCOME_WORDS = { approved: "approved", changes_requested: "changes requested", rejected: "rejected" } as const;
const WHAT_WORDS = { plan: "Plan", requirements: "Requirements", design: "Design", pull_request: "Pull request" } as const;

const of = <Kind extends TaskLogEntry["kind"]>(entries: readonly TaskLogEntry[], kind: Kind): Array<TaskLogEntryOf<Kind>> => entries.filter((entry): entry is TaskLogEntryOf<Kind> => entry.kind === kind);
const person = (name: string): string => inertTicketLine(name, 80);
const where = (surface: keyof typeof TASK_LOG_SURFACE_WORDS): string => TASK_LOG_SURFACE_WORDS[surface];

/** The questions that no answer was given to, in the newest round that has any. */
export function openQuestions(entries: readonly TaskLogEntry[]): Array<TaskLogEntryOf<"question">> {
  const answered = new Set(of(entries, "answer").map((entry) => `${String(entry.round)}:${entry.questionId}`));
  const open = of(entries, "question").filter((entry) => !answered.has(`${String(entry.round)}:${entry.questionId}`));
  const newest = Math.max(-1, ...open.map((entry) => entry.round));
  return open.filter((entry) => entry.round === newest);
}

/** Where the task stands, from the log: the newest event that says (a milestone, a question waiting, an answer, a decision). */
function stateOf(entries: readonly TaskLogEntry[]): { words: string; at: string } {
  const open = openQuestions(entries);
  let state: { words: string; at: string } = { words: "Working on it", at: entries[0]?.at ?? new Date(0).toISOString() };
  for (const entry of entries) {
    if (entry.kind === "status") state = { words: MOMENT_STATE[entry.moment], at: entry.at };
    else if (entry.kind === "question" && open.some((candidate) => candidate.key === entry.key)) state = { words: "Waiting for an answer", at: entry.at };
    else if (entry.kind === "answer" && open.length === 0) state = { words: "Working on it", at: entry.at };
    else if (entry.kind === "approval" && entry.what !== "pull_request") state = { words: entry.outcome === "approved" ? "Approved, working on it" : entry.outcome === "changes_requested" ? "Revising after the requested changes" : "Rejected", at: entry.at };
  }
  return state;
}

function questionOfAnswer(entries: readonly TaskLogEntry[], answer: TaskLogEntryOf<"answer">): string {
  const question = of(entries, "question").find((candidate) => candidate.round === answer.round && candidate.questionId === answer.questionId);
  return question === undefined ? "A question" : inertTicketLine(question.text, LINE);
}

const decisionLine = (entries: readonly TaskLogEntry[], entry: TaskLogEntryOf<"answer"> | TaskLogEntryOf<"approval">): string => entry.kind === "answer"
  ? `${questionOfAnswer(entries, entry)}: ${inertTicketLine(entry.text, LINE)}. ${person(entry.by)}, ${where(entry.surface)}, ${whenWords(entry.at)}.`
  : `${WHAT_WORDS[entry.what]} ${OUTCOME_WORDS[entry.outcome]}. ${person(entry.by)}, ${where(entry.surface)}, ${whenWords(entry.at)}.`;

const bounded = (lines: readonly string[], max: number): string => {
  const text = lines.join("\n");
  return [...text].length <= max ? text : `${[...text].slice(0, max - 1).join("").trimEnd()}…`;
};

export interface RootInput { title: string; level: TicketUpdateLevel; entries: readonly TaskLogEntry[]; taskUrl?: string | undefined }

/** The root comment: what the ticket reads first. */
export function renderRoot(input: RootInput): string {
  const { entries } = input;
  const state = stateOf(entries);
  const lines = [`Rovara: "${inertTicketTitle(input.title)}"`, `State: ${state.words} (since ${whenWords(state.at)})`];
  const plan = of(entries, "plan_summary").at(-1);
  if (plan !== undefined && input.level !== "decisions") {
    lines.push(`Plan: ${inertTicketLine(plan.needed, 300)}`, ...plan.lines.map((line, at) => `${String(at + 1)}. ${inertTicketLine(line, 200)}`));
    lines.push(`Risk: ${plan.risk}.`);
  }
  const decisions = entries.filter((entry): entry is TaskLogEntryOf<"answer"> | TaskLogEntryOf<"approval"> => entry.kind === "answer" || entry.kind === "approval");
  if (decisions.length > 0) {
    lines.push("Decisions:");
    const shown = decisions.slice(-THREAD_DECISIONS_SHOWN);
    if (shown.length < decisions.length) lines.push(`- ${String(decisions.length - shown.length)} earlier decisions are on the Rovara page.`);
    lines.push(...shown.map((entry) => `- ${decisionLine(entries, entry)}`));
  }
  const open = openQuestions(entries);
  if (open.length > 0 && input.level === "full") lines.push("Open questions:", ...open.map((entry, at) => `${String(at + 1)}. ${inertTicketLine(entry.text, LINE)}`));
  const links = of(entries, "pr").flatMap((entry) => entry.urls.flatMap((url) => plainHttpsLink(url) ?? []));
  for (const link of [...new Set(links)].slice(0, 5)) lines.push(`Pull request: ${link}`);
  const detail = input.taskUrl === undefined ? undefined : plainHttpsLink(input.taskUrl);
  if (detail !== undefined) lines.push(`Full detail: ${detail}`);
  return bounded(lines, ROOT_MAX_CHARS);
}

export interface ReplyDraft {
  /** The claim's name: once per event, so a delivery again is not a second reply. */
  key: string;
  /** A question or a plan ready: these may use the 5 of 20 replies that nothing else may take. */
  reserved: boolean;
  at: string;
  text: string;
}

/**
 * The replies the log calls for at this level, oldest first. `decisions` and up: one "Decision recorded" for each set of answers and for each approval. `full`: the open questions of a round, the plan ready (only while it
 * is the newest state), and the pull request. A reply for a question that has been answered, or a plan that has moved on, is not drawn (it would only be noise).
 */
export function renderReplies(input: { title: string; level: TicketUpdateLevel; entries: readonly TaskLogEntry[]; taskUrl?: string | undefined }): ReplyDraft[] {
  const { entries } = input;
  const detail = input.taskUrl === undefined ? undefined : plainHttpsLink(input.taskUrl);
  const page = detail === undefined ? "on the Rovara page" : `on the Rovara page: ${detail}`;
  const replies: ReplyDraft[] = [];
  const rounds = [...new Set(of(entries, "answer").map((entry) => entry.round))];
  for (const round of rounds) {
    const set = of(entries, "answer").filter((entry) => entry.round === round);
    replies.push({ key: `answers:r${String(round)}`, reserved: false, at: set[0]!.at, text: bounded([`Decision recorded${set.length > 1 ? "s" : ""}:`, ...set.map((entry) => decisionLine(entries, entry))], REPLY_MAX_CHARS) });
  }
  for (const entry of of(entries, "approval")) replies.push({ key: entry.key, reserved: false, at: entry.at, text: `Decision recorded: ${decisionLine(entries, entry)}` });
  if (input.level === "full") {
    const open = openQuestions(entries);
    if (open.length > 0) {
      replies.push({ key: `questions:r${String(open[0]!.round)}`, reserved: true, at: open[0]!.at, text: bounded([`Rovara needs an answer${open.length > 1 ? "s" : ""}:`, ...open.map((entry, at) => `${String(at + 1)}. ${inertTicketLine(entry.text, LINE)}`), `Answer ${page}`], REPLY_MAX_CHARS) });
    }
    const status = of(entries, "status");
    const newest = status.at(-1);
    if (newest?.moment === "plan_ready") {
      const plan = of(entries, "plan_summary").at(-1);
      const settled = of(entries, "approval").some((entry) => entry.at >= newest.at && entry.what !== "pull_request");
      if (!settled) replies.push({ key: newest.key, reserved: true, at: newest.at, text: `Plan ready for review: "${inertTicketTitle(input.title)}".${plan === undefined ? "" : ` Risk: ${plan.risk}.`} Approve or ask for changes ${page}` });
    }
    for (const entry of of(entries, "pr")) {
      const links = [...new Set(entry.urls.flatMap((url) => plainHttpsLink(url) ?? []))];
      if (links.length > 0) replies.push({ key: entry.key, reserved: false, at: entry.at, text: bounded(["Pull request opened:", ...links.map((link) => `Pull request: ${link}`)], REPLY_MAX_CHARS) });
    }
  }
  return replies.sort((a, b) => (a.at === b.at ? (a.key < b.key ? -1 : 1) : a.at < b.at ? -1 : 1));
}
