// Spec 025 FR-032, C8: what the notifier posts in a shared thread. Every value from a record is
// escaped; free text from the worker is redacted and capped first. No em dashes.
import { DEVELOPER_SHARE_SUMMARY_MAX, redactAndCap, redactText } from "@agentx/contracts";
import { escapeSlack, fitEscaped } from "../aws/slack-details-view.js";

export interface StartMessageInput {
  developerName: string;
  slackUserId?: string | undefined;
  client: string;
  title: string;
  project: string;
  mode: "view" | "continue";
  status: string;
  sharedReason: "requested" | "required";
}

const who = (input: Pick<StartMessageInput, "developerName" | "slackUserId">) =>
  input.slackUserId !== undefined ? `<@${input.slackUserId}>` : escapeSlack(input.developerName);

const MODE_SENTENCE = {
  view: (name: string) => `View only: follow-ups happen in ${name}'s AI tool, and I post each update here.`,
  continue: () => "Open to the channel: members of this channel may mention AgentX in this thread to steer the task.",
} as const;

export function startMessage(input: StartMessageInput): string {
  const name = who(input);
  return [
    // The client is one of four fixed names (R25), so it needs no escaping.
    `${name} started a task from ${input.client}: *${escapeSlack(input.title)}*`,
    `Project: \`${escapeSlack(input.project)}\`. Status: ${input.status}.`,
    input.mode === "view" ? MODE_SENTENCE.view(name) : MODE_SENTENCE.continue(),
    ...(input.sharedReason === "required" ? ["This project shares every task started from an AI tool."] : []),
  ].join("\n");
}

/** Redacts, then escapes and fits within `limit`, quote marks included (F21); a cut by either ends with the marker. */
function fitRedacted(text: string, limit: number, quoted = false): string {
  const redacted = redactAndCap(text, limit);
  return fitEscaped(redacted.text, limit, { quoteLines: quoted, cut: redacted.truncated });
}

const clean = (text: string, limit: number) => fitRedacted(text.replace(/\s+/g, " ").trim(), limit);

export const READY_REPLY = "The workspace is ready, and the task is running.";

/** #225: how much of a failed setup step's last lines of output the notice quotes, quote marks included. */
export const SETUP_OUTPUT_SHOWN_MAX = 700;
/** The worker's heading before a failed command's last lines (packages/worker/src/command-failure.ts). */
const LAST_LINES = "\nLast lines:\n";

export function setupFailedReply(error: string | undefined): string {
  const text = error ?? "setup failed";
  const at = text.indexOf(LAST_LINES);
  const head = `The workspace could not be set up, so the task did not run: ${clean(at < 0 ? text : text.slice(0, at), 300)}`;
  if (at < 0) return head;
  // #225: the step's last lines say why it failed, so they are kept as lines, quoted, end first.
  const tail = quotedTail(text.slice(at + LAST_LINES.length), SETUP_OUTPUT_SHOWN_MAX);
  return tail === "" ? head : `${head}\nLast lines of its output:\n${tail}`;
}

/**
 * The last lines of `text` that fit within `limit` once redacted, escaped and quoted, in order. A
 * last line too long by itself keeps its end, after "...", where an error usually is.
 */
function quotedTail(text: string, limit: number): string {
  const lines = redactText(text).split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim() !== "");
  const kept: string[] = [];
  let size = 0;
  for (const line of lines.reverse()) {
    const quoted = `>${escapeSlack(line)}`;
    const next = size + quoted.length + (kept.length === 0 ? 0 : 1);
    if (next <= limit) {
      kept.unshift(quoted);
      size = next;
      continue;
    }
    if (kept.length === 0) kept.unshift(endOf(line, limit));
    break;
  }
  return kept.join("\n");
}

/** ">..." and as much of the end of `line`, escaped, as fits within `limit`; never splits a character. */
function endOf(line: string, limit: number): string {
  let end = "";
  for (const character of [...line].reverse()) {
    const next = escapeSlack(character) + end;
    if (4 + next.length > limit) break;
    end = next;
  }
  return `>...${end}`;
}

export function endedReply(input: { kind?: string; status: string; failure?: { category: string; message: string } | undefined; summary?: string | undefined }): string {
  // Final review M4: a pull request's outcome is the pull request's, not the task's.
  if (input.kind === "publish" && input.status !== "SUCCEEDED") {
    return input.failure === undefined
      ? "The pull request was cancelled before it opened."
      : `The pull request could not be opened (${input.status}, ${input.failure.category}): ${clean(input.failure.message, 300)}`;
  }
  const head = input.failure === undefined
    ? `The task ended ${input.status}.`
    : `The task ended ${input.status} (${input.failure.category}): ${clean(input.failure.message, 300)}`;
  if (input.summary === undefined || input.summary.trim() === "") return head;
  // Summary lines are quoted, so the worker's text reads as the worker's; the quoted block fits the limit.
  return `${head}\n${fitRedacted(input.summary.trim(), DEVELOPER_SHARE_SUMMARY_MAX, true)}`;
}

export function pullRequestReply(url: string): string {
  return `Pull request opened: ${escapeSlack(url)}`;
}

export function modeReply(mode: "view" | "continue"): string {
  return mode === "view"
    ? "This thread is now view only: follow-ups happen in the developer's AI tool."
    : "This thread is now open to the channel: members of this channel may mention AgentX here to steer the task.";
}

export const CANCELLED_REPLY = "The task was cancelled before it ran.";
export const CLOSED_REPLY = "The task is closed, and its workspace is released. This thread no longer drives it.";
