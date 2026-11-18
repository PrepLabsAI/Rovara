// The task log in the chat thread (B5, owner decision 254z d): when an answer or a decision is recorded somewhere else (the web page, Linear, Jira, GitHub, the terminal, an AI tool), the thread the task was started from
// gets the same entry as ONE short line, so the people in the thread see "Ana Ruiz answered ... in Linear" without opening anything. What was said in the thread itself is never said back to it: an entry whose origin
// (`surface`) is this thread's own chat is skipped, and the thread's own conversation is not duplicated. Questions, plan summaries, milestones and pull requests are not mirrored (the thread has its own cards and lines for
// those, `thread-notices.ts`).
//
// It is a subscriber of the task log's hook (`core/task-log/hooks.ts`), told after a change is committed. Each line goes through the same two steps as every other thread message (`threadSender`: only a thread that is this
// company's and whose person is served, and a claim row per entry before the send so a repeat of the event is one line), through the chat adapter (whose own limits apply). An entry is told once, by its key and origin.
// The information budget: at most `MIRROR_LINES_MAX` lines for a task, only entries from the last `MIRROR_WINDOW_MS` (an old entry that was never told is not told late), one line each, with the task page one click away.
// Nothing here is a reason for the change to fail: a failed send is logged and tried again at the next change.
import { createHash } from "node:crypto";
import { TASK_LOG_SURFACE_WORDS, type ChannelEvent, type DocumentStore, type OrgId, type RegistryView, type TaskLogEntry, type TaskLogEntryOf } from "@agentx/contracts";
import { taskKey } from "../task-flow/keys.js";
import { taskSessionId } from "../sessions/create.js";
import { inertTicketLine, plainHttpsLink } from "../ticket-updates/text.js";
import { readTaskLog } from "../task-log/store.js";
import type { ChannelCompanyOf, ChannelMemberRule } from "./company.js";
import { readTaskThread } from "./threads.js";
import { threadSender } from "./thread-notices.js";

type Log = (event: string, fields: Record<string, unknown>) => void;

/** The most lines the mirror tells one task's thread (the log holds more answers than a thread should repeat). */
export const MIRROR_LINES_MAX = 20;
/** An entry older than this when the hook tells of it is not mirrored. */
export const MIRROR_WINDOW_MS = 15 * 60_000;
const QUESTION_WORDS_MAX = 100;
const ANSWER_WORDS_MAX = 160;
const PERSON_WORDS_MAX = 60;

export interface LogMirrorDeps {
  store: DocumentStore;
  registry: Pick<RegistryView, "get">;
  now: () => number;
  companyOf?: ChannelCompanyOf | undefined;
  isMember?: ChannelMemberRule | undefined;
  /** The mirror on or off (read at each use); the host ties it to the thread's milestone lines, so a thread that was muted stays quiet. Default on. */
  enabled?: boolean | (() => boolean) | undefined;
  /** The task's page, when the host has an https address for it: the line ends with it (details one click away). */
  taskUrl?: ((taskId: string) => string | undefined) | undefined;
  log?: Log | undefined;
}

type Decision = TaskLogEntryOf<"answer"> | TaskLogEntryOf<"approval">;
const isDecision = (entry: TaskLogEntry): entry is Decision => entry.kind === "answer" || entry.kind === "approval";

const WHAT = { plan: "the plan", requirements: "the requirements", design: "the design", pull_request: "the pull request" } as const;

/** The one line for an entry, made inert for the chat (no mention, no markup, no link but the task page's plain https address). */
export function mirrorLine(entries: readonly TaskLogEntry[], entry: Decision, page: string | undefined): string {
  const by = inertTicketLine(entry.by, PERSON_WORDS_MAX) || "Someone";
  const where = TASK_LOG_SURFACE_WORDS[entry.surface];
  let line: string;
  if (entry.kind === "answer") {
    const question = entries.find((candidate): candidate is TaskLogEntryOf<"question"> => candidate.kind === "question" && candidate.round === entry.round && candidate.questionId === entry.questionId);
    const asked = question === undefined ? "a question" : `"${inertTicketLine(question.text, QUESTION_WORDS_MAX)}"`;
    line = `${by} answered ${asked} ${where}: ${inertTicketLine(entry.text, ANSWER_WORDS_MAX)}`;
  } else {
    const verb = entry.outcome === "approved" ? "approved" : entry.outcome === "rejected" ? "rejected" : "asked for changes to";
    line = `${by} ${verb} ${WHAT[entry.what]} ${where}.`;
  }
  return page === undefined ? line : `${line} ${page}`;
}

const eventIdOf = (orgId: OrgId, sessionId: string, key: string): string => `evt_${createHash("sha256").update(JSON.stringify(["thread-log-line", orgId, sessionId, key]), "utf8").digest("base64url").slice(0, 32)}`;

/** The task log's subscriber for the chat thread: `(taskId) => Promise<void>`, to be given to `TaskLogHooks.subscribe`. */
export function taskLogThreadMirror(deps: LogMirrorDeps): (taskId: string) => Promise<void> {
  const log: Log = deps.log ?? (() => undefined);
  const { reach, send } = threadSender({ store: deps.store, registry: deps.registry, now: deps.now, companyOf: deps.companyOf, isMember: deps.isMember, log });
  const on = (): boolean => (typeof deps.enabled === "function" ? deps.enabled() : deps.enabled !== false);
  return async (taskId) => {
    if (!on()) return;
    const task = await deps.store.get(taskKey(taskId));
    const orgId = (task?.["orgId"] ?? task?.["companyId"]) as OrgId | undefined;
    if (task === undefined || typeof orgId !== "string") return;
    const sessionId = typeof task["sessionId"] === "string" ? task["sessionId"] : taskSessionId(taskId);
    const thread = await readTaskThread(deps.store, orgId, sessionId);
    if (thread === undefined) return;
    const { conversation } = thread;
    const entries = await readTaskLog(deps.store, orgId, taskId);
    // What this chat already says is not said again: an entry given in this chat is skipped before anything is claimed, and the cap counts only entries that could be told.
    const tellable = entries.filter(isDecision).filter((entry) => entry.surface !== conversation.channel).slice(0, MIRROR_LINES_MAX);
    const fresh = tellable.filter((entry) => deps.now() - Date.parse(entry.at) <= MIRROR_WINDOW_MS);
    if (fresh.length === 0) return;
    const adapter = await reach(orgId, thread);
    if (adapter === undefined) return;
    const page = (() => { const link = deps.taskUrl?.(taskId); return link === undefined ? undefined : plainHttpsLink(link); })();
    for (const entry of fresh) {
      const key = `log#${entry.key}#${entry.surface}`;
      const event: ChannelEvent = {
        version: 1, id: eventIdOf(orgId, sessionId, key), channel: conversation.channel, conversation, createdAt: new Date(deps.now()).toISOString(),
        type: "progress", data: { text: mirrorLine(entries, entry, page) },
      };
      try {
        await send(orgId, sessionId, key, () => adapter.deliver(event));
      } catch (error) {
        log("channel_thread.log_line_failed", { channel: conversation.channel, error: error instanceof Error ? error.name : "unknown" });
      }
    }
  };
}
