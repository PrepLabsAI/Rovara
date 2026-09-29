// Spec 025 FR-032, C8: what the notifier posts in a shared thread. Every value from a record is
// escaped; free text from the worker is redacted and capped first. No em dashes.
import { DEVELOPER_SHARE_SUMMARY_MAX, redactAndCap } from "@agentx/contracts";
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

/** Redacts, then escapes within `limit` (F21): escaping grows text, so the cut comes after it. */
const fitRedacted = (text: string, limit: number) => fitEscaped(redactAndCap(text, limit).text, limit);
const clean = (text: string, limit: number) => fitRedacted(text.replace(/\s+/g, " ").trim(), limit);

export const READY_REPLY = "The workspace is ready, and the task is running.";

export function setupFailedReply(error: string | undefined): string {
  return `The workspace could not be set up, so the task did not run: ${clean(error ?? "setup failed", 300)}`;
}

export function endedReply(input: { status: string; failure?: { category: string; message: string } | undefined; summary?: string | undefined }): string {
  const head = input.failure === undefined
    ? `The task ended ${input.status}.`
    : `The task ended ${input.status} (${input.failure.category}): ${clean(input.failure.message, 300)}`;
  if (input.summary === undefined || input.summary.trim() === "") return head;
  // Summary lines are quoted, so the worker's text reads as the worker's.
  const summary = fitRedacted(input.summary.trim(), DEVELOPER_SHARE_SUMMARY_MAX).split("\n").map((line) => `>${line}`).join("\n");
  return `${head}\n${summary}`;
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
