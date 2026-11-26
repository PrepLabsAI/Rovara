// L4-U5d: a later message in a Slack thread whose task the core owns (`CoreTaskEntry.threadInput`, core-host/chat-thread-input.ts). The old thread-note path (`recordSlackThreadNote`) reads the workflow's records and refuses a core
// task, so the later mention got "couldn't save this reply". This reaches the core's own input instead, as the Slack person's linked Rovara person, and the rule is the core's alone (the web's: the person's live company, the thread's
// workspace that company's, the task's owner); a refusal is a fixed polite answer and writes nothing. The workflow's thread checks are not added: they read records a core task does not have.
// `undefined`: not the core's, and the broker runs exactly what it ran before.
import { SLACK_CHANNEL, type SharedTaskRecord, type SlackThread } from "@agentx/contracts";
import { isCoreTask, type CoreEntryCaller, type CoreTaskEntry, type EngineStateTable } from "./engine-boundary.js";
import type { ThreadInputNotice } from "./slack-thread-input-words.js";

/** The broker's answer to the ingress for a reply in a core task's thread: the outcome the ingress already reads, and the notice (a code, never words) it says back. */
export interface CoreThreadNoteAnswer {
  outcome: "captured" | "duplicate" | "refused" | "small_talk";
  notice?: ThreadInputNotice;
  /** The task is the core's and the core answered: the ingress says the notice's words and never sends the reply on as a question to the old task reader. Absent on a refusal the old path gives too (an install the core does not serve). */
  core?: true;
}

const refused = (notice: ThreadInputNotice): CoreThreadNoteAnswer => ({ outcome: "refused", notice, core: true });

export interface CoreThreadNoteInput {
  /** The thread's guard row (`SHARED_TASK`), which the caller has read and checked is this task's, open, and a workflow thread. */
  shared: Pick<SharedTaskRecord, "taskId"> & { companyId?: unknown };
  thread: SlackThread;
  userId: string;
  messageTs: string;
  text: string;
  mention: boolean;
  smallTalk: boolean;
  /** The company the thread's Slack workspace belongs to (the broker's own answer). Throws, or answers nothing, when it belongs to none. */
  companyOf: () => Promise<string | undefined>;
  /** The Slack person's linked Rovara person (throws for one who is not linked). */
  caller: () => Promise<{ developerId: string; sessionId: string; name: string }>;
}

export async function coreThreadNote(table: EngineStateTable, entry: CoreTaskEntry | undefined, input: CoreThreadNoteInput): Promise<CoreThreadNoteAnswer | undefined> {
  if (!await isCoreTask(table, input.shared.taskId)) return undefined;
  // An install whose core entry takes no thread input refuses exactly as the old path always refused a core task's reply (the same answer, nothing written).
  if (entry?.threadInput === undefined) return { outcome: "refused" };
  let company: string | undefined;
  try { company = await input.companyOf(); } catch { company = undefined; }
  // The guard row names the company whose core start wrote it (L4-U5c). A row of another company, or one that names none, is never this company's thread.
  if (company === undefined || input.shared.companyId !== company) return refused("not_allowed");
  let caller: CoreEntryCaller;
  try {
    const linked = await input.caller();
    caller = { developerId: linked.developerId, sessionId: linked.sessionId, name: linked.name };
  } catch { return refused("not_allowed"); }
  const result = await entry.threadInput(caller, {
    taskId: input.shared.taskId,
    conversation: { channel: SLACK_CHANNEL, tenant: input.thread.teamId, space: input.thread.channelId, thread: input.thread.threadTs },
    actor: { channel: SLACK_CHANNEL, tenant: input.thread.teamId, userId: input.userId },
    messageId: input.messageTs, text: input.text, mention: input.mention, smallTalk: input.smallTalk,
  });
  return { outcome: result.outcome, ...("notice" in result ? { notice: result.notice } : {}), core: true };
}
