// Builders for the task log's entries (`@agentx/contracts` `task-log.ts`). Every text is made safe when it is written, once, for every surface that will draw it: credentials redacted, control characters made
// spaces, one line, cut at the entry's bound (by characters, never in the middle of one). An entry whose text comes out empty is not written. Every builder is pure (no clock, no store), so the same event gives the
// same entry with the same key, and a repeat of it is the same row.
import { createHash } from "node:crypto";
import { CHAT_METHOD_PREFIX } from "../../ports/policy-defaults.js";
import {
  TASK_LOG_ENTRIES_MAX, TASK_LOG_PERSON_MAX, TASK_LOG_PLAN_LINES_MAX, TASK_LOG_PLAN_LINE_MAX, TASK_LOG_PLAN_NEEDED_MAX, TASK_LOG_PULL_REQUESTS_MAX, TASK_LOG_TEXT_MAX, TaskLogEntrySchema, redactText,
  type CodeMilestone, type IntentAnswer, type IntentQuestion, type TaskLogEntry, type TaskLogSurface, type TicketUpdateMoment,
} from "@agentx/contracts";

export { TASK_LOG_ENTRIES_MAX };

/** One plain line of at most `max` characters: credentials redacted, control characters made spaces, runs of space made one. Empty when nothing is left. */
export function cleanLogText(text: string, max: number): string {
  const flat = redactText(text).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
  return [...flat].slice(0, max).join("").trimEnd();
}

const sha = (text: string, length = 16): string => createHash("sha256").update(text, "utf8").digest("hex").slice(0, length);
const iso = (at: string): string => new Date(at).toISOString();

/** A pull request's address when it is a plain https address (no sign-in data), else nothing: only an address Rovara can vouch for is kept. */
export function plainHttpsLink(link: string): string | undefined {
  try {
    const url = new URL(link);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** The surface an Understand answer's `source` names (`INTENT_ANSWER_SOURCES`). */
export const SURFACE_OF_ANSWER_SOURCE: Readonly<Record<string, TaskLogSurface>> = { app: "web", slack: "slack", linear: "linear", cli: "cli", mcp: "mcp" };

/** Where a decision was made, from the method its proof came through (the Approvers seam's name for it): a chat's press or reply, a code host's comment, or the person's own page (the local session and anything else). */
export function surfaceOfMethod(method: string | undefined): TaskLogSurface {
  if (method === undefined) return "web";
  if (method.startsWith(CHAT_METHOD_PREFIX)) return method.slice(CHAT_METHOD_PREFIX.length) === "slack" ? "slack" : "web";
  return method.startsWith("code-host") ? "github" : "web";
}

/** The entry for a milestone of the task, or undefined when the milestone is not one the log keeps. A moment that repeats (a plan revised, another set of pull requests) has a key of its own. */
export function statusEntryOf(milestone: Pick<CodeMilestone, "kind" | "at" | "pullRequests">): TaskLogEntry | undefined {
  const moments: Partial<Record<CodeMilestone["kind"], TicketUpdateMoment>> = { started: "started", plan_ready: "plan_ready", pr_ready: "pr_opened", merged: "merged", closed: "closed" };
  const moment = moments[milestone.kind];
  if (moment === undefined) return undefined;
  const suffix = moment === "pr_opened" ? `#${sha((milestone.pullRequests ?? []).map((pr) => `${pr.repository}#${String(pr.number)}`).join(","), 12)}` : moment === "plan_ready" ? `#${sha(milestone.at, 12)}` : "";
  return TaskLogEntrySchema.parse({ key: `status:${moment}${suffix}`, at: iso(milestone.at), kind: "status", moment });
}

/** The pull requests' links, once per set. Undefined when no link is a plain https address. */
export function pullRequestEntryOf(milestone: Pick<CodeMilestone, "at" | "pullRequests">): TaskLogEntry | undefined {
  const requests = (milestone.pullRequests ?? []).slice(0, TASK_LOG_PULL_REQUESTS_MAX);
  const urls = requests.flatMap((request) => plainHttpsLink(request.url) ?? []);
  if (urls.length === 0) return undefined;
  return TaskLogEntrySchema.parse({ key: `pr:${sha(requests.map((request) => `${request.repository}#${String(request.number)}`).join(","), 12)}`, at: iso(milestone.at), kind: "pr", urls });
}

/** The plan summary of the plan waiting for review: the card's lines (redacted and bounded again here), its risk tier, without private cost figures. One per plan revision. */
export function planSummaryEntryOf(input: { revision: number; at: string; needed: string; lines: readonly string[]; risk: string; estimate?: string | undefined }): TaskLogEntry | undefined {
  const needed = cleanLogText(input.needed, TASK_LOG_PLAN_NEEDED_MAX);
  const lines = input.lines.map((line) => cleanLogText(line, TASK_LOG_PLAN_LINE_MAX)).filter((line) => line !== "").slice(0, TASK_LOG_PLAN_LINES_MAX);
  if (needed === "" || lines.length === 0) return undefined;
  const risk = input.risk === "low" || input.risk === "medium" ? input.risk : "high";
  return TaskLogEntrySchema.parse({ key: `plan:r${String(input.revision)}`, at: iso(input.at), kind: "plan_summary", revision: input.revision, needed, lines, risk });
}

/** The questions Understand asked a person in one round. */
export function questionEntriesOf(input: { round: number; at: string; questions: readonly IntentQuestion[] }): TaskLogEntry[] {
  return input.questions.flatMap((question) => {
    const text = cleanLogText(question.text, TASK_LOG_TEXT_MAX);
    if (text === "") return [];
    const choices = (question.options ?? []).map((option) => cleanLogText(option.label, 80)).filter((label) => label !== "");
    return [TaskLogEntrySchema.parse({ key: `question:r${String(input.round)}:${question.id}`, at: iso(input.at), kind: "question", questionId: question.id, round: input.round, text, ...(choices.length === 0 ? {} : { choices }) })];
  });
}

/** The answers one person gave to a round's questions: the option's words and/or what they said, with who gave them and where. */
export function answerEntriesOf(input: { round: number; at: string; by: string; surface: TaskLogSurface; questions: readonly IntentQuestion[]; answers: readonly IntentAnswer[] }): TaskLogEntry[] {
  const by = cleanLogText(input.by, TASK_LOG_PERSON_MAX);
  if (by === "") return [];
  return input.answers.flatMap((answer) => {
    const option = input.questions.find((question) => question.id === answer.questionId)?.options?.find((candidate) => candidate.id === answer.optionId)?.label;
    const text = cleanLogText([option, answer.text].filter((part): part is string => part !== undefined && part !== "").join(": "), TASK_LOG_TEXT_MAX);
    if (text === "") return [];
    return [TaskLogEntrySchema.parse({ key: `answer:r${String(input.round)}:${answer.questionId}`, at: iso(input.at), kind: "answer", questionId: answer.questionId, round: input.round, text, by, surface: input.surface })];
  });
}

/** An approval, or a request for changes, or a rejection: what, who, where. `requestId` is the decision's own id, so a repeat of the decision is the same entry. */
export function approvalEntryOf(input: {
  requestId: string; at: string; what: "plan" | "requirements" | "design" | "pull_request"; outcome: "approved" | "changes_requested" | "rejected"; artifactDigest?: string | undefined; revision?: number | undefined; by: string; surface: TaskLogSurface;
}): TaskLogEntry | undefined {
  const by = cleanLogText(input.by, TASK_LOG_PERSON_MAX);
  if (by === "") return undefined;
  const code = input.artifactDigest === undefined || !/^[0-9a-f]{64}$/u.test(input.artifactDigest) ? undefined : input.artifactDigest.slice(0, 8);
  return TaskLogEntrySchema.parse({
    key: `approval:${sha(input.requestId, 24)}`, at: iso(input.at), kind: "approval", what: input.what, outcome: input.outcome, by, surface: input.surface,
    ...(code === undefined ? {} : { code }), ...(input.revision === undefined ? {} : { revision: input.revision }),
  });
}
