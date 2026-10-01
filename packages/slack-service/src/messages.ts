import { redactAndCap, slackThreadUrl, type SlackThread, type SlackWorkspaceLimit } from "@agentx/contracts";
import { escapeText } from "./slack-format.js";

// Thread notices follow the reply formatting (spec 014 FR-022): the static texts below contain no
// Slack control characters, so they post exactly as written; every interpolated value goes through
// escapeText, so a value such as "<!here>" is shown and never notifies anyone.

export const NEW_WORKSPACE_MESSAGE = "Setting up a new workspace for this thread. The first request takes a few minutes.";
export const STILL_PREPARING_MESSAGE = "This thread's workspace is still being set up. I'll start as soon as it's ready.";

export const PREPARATION_SLOW_MESSAGE = "This thread's workspace is taking longer than expected to set up. " +
  "It continues in the background; mention me again in this thread in a few minutes.";

export const WORKSPACE_UNCONFIRMED_MESSAGE =
  "AgentX could not confirm this thread's workspace setup. Mention me again in this thread in a few minutes.";

/** #154: how much of the setup error the thread is shown. */
export const PREPARATION_FAILURE_REASON_MAX = 300;
const COMMAND_FAILURE = /^(?:setup step|readiness check) \d+ \(/;

/**
 * The thread's setup failure notice. With the worker's error (#154), it adds the reason, redacted
 * and capped, and asks an administrator to fix a failed setup or readiness command. A failed
 * preparation gives its workspace's slot back at once (#213), so the notice says so, and a new
 * message in the thread prepares the workspace again, charged afresh.
 */
export function preparationFailedMessage(status: string, error?: string): string {
  const head = `AgentX could not set up this thread's workspace (${escapeText(status)}). The workspace was released, so it no longer counts toward the workspace limit.`;
  // Redacted before its lines are joined, since some redaction rules work line by line; the
  // redaction reads a bounded amount (redactAndCap), far more than the notice shows.
  const redacted = redactAndCap(error ?? "", PREPARATION_FAILURE_REASON_MAX * 4);
  const reason = redacted.text.replace(/\s+/g, " ").trim();
  if (reason === "") return `${head} Mention me again in this thread to start fresh.`;
  const next = COMMAND_FAILURE.test(reason)
    ? "Ask an administrator to fix the project's setup commands, then mention me again in this thread to start fresh."
    : "Mention me again in this thread to start fresh.";
  return `${head} ${next}\nReason: ${fitEscapedReason(escapeText(reason), redacted.truncated)}`;
}

/** Cuts escaped text to PREPARATION_FAILURE_REASON_MAX, marker included, never inside an entity. */
function fitEscapedReason(escaped: string, alreadyCut: boolean): string {
  if (escaped.length <= PREPARATION_FAILURE_REASON_MAX && !alreadyCut) return escaped;
  let cut = Math.min(escaped.length, PREPARATION_FAILURE_REASON_MAX - 3);
  const entity = escaped.lastIndexOf("&", cut - 1);
  if (entity !== -1 && !escaped.slice(entity, cut).includes(";")) cut = entity;
  const code = escaped.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${escaped.slice(0, cut)}...`;
}

export function limitMessage(result: { limit: SlackWorkspaceLimit; maximum: number; starterThreads: readonly SlackThread[]; openTaskCount?: number | undefined }): string {
  if (result.limit === "ORGANIZATION") {
    return `This organization already has ${result.maximum} AgentX workspaces, the most allowed, so I can't start a new one. ` +
      "Continue in an existing thread, or ask an administrator to raise the limit.";
  }
  const head = `You already have ${result.maximum} AgentX workspaces, the most one person can have, so I can't start a new one.`;
  // C16: the member's AI-tool tasks count against the same limit. Only their number is said here:
  // a task's title stays with its developer, never in the channel (D22).
  const tasks = result.openTaskCount ?? 0;
  if (result.starterThreads.length === 0 && tasks > 0) {
    const which = tasks === 1 ? "One of them is a task" : `${tasks} of them are tasks`;
    return `${head} ${which} started from an AI tool; close one there with agentx_close_task to free a workspace.`;
  }
  const links = result.starterThreads.map((thread, index) => `• <${escapeText(slackThreadUrl(thread))}|Thread ${index + 1}>`);
  return [
    `${head} Continue in one of your existing threads instead:`,
    ...links,
    ...(tasks > 0 ? [`You also have ${tasks} task${tasks === 1 ? "" : "s"} started from an AI tool; closing one there with agentx_close_task frees a workspace.`] : []),
  ].join("\n");
}
