// L4-U5d: a later message in the chat thread a hosted core task was started from becomes input for THAT task (`CoreTaskEntry.threadInput`), by the routing the web uses for a core task and under the web's rule for who may give it.
//
// Where it goes, by what the task waits for now (read here, never taken from the message):
//   - it waits for answers to Understand's questions (`POST /v1/dev/tasks/{id}/answers`): the message, when it MENTIONS Rovara, answers them (one question: the whole reply; more: one numbered line each, `your call` is an answer).
//     The move is `answerTaskOnRequest`, the web's own: the task's owner by the company's owner rule, the round checked, one request id one answer. A plain reply (no mention) never answers: a person talking in the thread must not
//     answer for the task by accident.
//   - its plan waits for review: the message is a NOTE for the plan (`kind: "plan_note"`). A chat reply decides nothing: a decision on a hosted install is the task page's, with a fresh sign-in
//     (`hosted-approvers.ts`: the one method is `rovara-step-up`), so "Request changes" stays there and the note is what the revised plan reads.
//   - otherwise: a follow-up NOTE the task's next step reads (`core/sessions/notes.ts`, the web's "message to the agent": `createSessionControlHost().planMessage`, with its hourly limit, the task's note cap and its refusal of an
//     ended task). Nothing is handed to a running step live from here: the note is read by the next step.
// The text is information, never an instruction: it is redacted, made plain and cut like the web's message, every chat mention in it is made the neutral word, and a note reaches a model only under the notes' untrusted frame
// (`notesPromptSection`). It never decides an approval, a gate, a tool or a budget.
//
// Who may give it (the web's rule, asked of the company's own access, never of the chat): the person is a live member of a company (the deployed identity point reads membership), the chat conversation's tenant is THAT
// company's (`ChatThreads.companyOf`; another company's workspace is refused with nothing written), the task is that company's, the person acts for it as its owner (`TaskAccess.ownerActing`: the person it runs for, or a
// People owner) and still holds a role on its project (`TaskAccess.checkStart`: a live member with the project's grant). Anyone else is refused, and the answer is the same whether they were never allowed or the task is not
// theirs. A refusal writes nothing.
//
// Each reply is added once: its id is made from the chat message's own id (the same for the two copies Slack sends of a mention and for a retry), so a repeat is a `duplicate`, never a second note or a second answer.
import { createHash } from "node:crypto";
import {
  AgentXError, INTENT_ANSWER_MAX_CHARS, SESSION_MESSAGE_MAX_CHARS, redactText,
  type ActorRef, type ConversationRef, type IntentAnswer, type IntentQuestion, type OrgId, type TransactItem,
} from "@agentx/contracts";
import { tenantIsCompanys } from "../core/channel/company.js";
import { readTaskThread } from "../core/channel/threads.js";
import { developerIdOf, taskSessionId } from "../core/sessions/create.js";
import { neutralizeSlackMentions } from "../core/sessions/slack-mentions.js";
import { routeOfTask, waitingForAnswers } from "../core/sessions/steer.js";
import { answerRequestTaken, answerTaskOnRequest } from "../core/task-flow/answer-request.js";
import type { TaskCaller, TaskFlowDeps } from "../core/task-flow/deps.js";
import { readTask } from "../core/task-flow/reads.js";
import { createSessionControlHost, MESSAGE_RATE_LIMITED } from "../local/app/host.js";
import type { ChatThreads } from "./chat-threads.js";
import type { DeployedCaller } from "./dev-routes.js";

/** The reply, as the chat adapter heard it. `messageId` is the chat's own id of the message (its time, in Slack). */
export interface ChatThreadInput {
  taskId: string;
  conversation: ConversationRef;
  actor: ActorRef;
  messageId: string;
  text: string;
  /** The message asks Rovara something (a mention), as against a person talking in the thread. */
  mention: boolean;
  /** The adapter read the reply as small talk ("thanks", "ok"). */
  smallTalk: boolean;
}

/** What became of it. `notice` names the fixed words the adapter says back (the adapter owns the words, never this module). */
export type ChatThreadInputResult =
  | { outcome: "captured"; notice: "answers_saved" | "plan_note_saved" | "note_saved" }
  | { outcome: "duplicate" }
  | { outcome: "small_talk" }
  | { outcome: "refused"; notice: "not_allowed" | "answers_unclear" | "rate_limited" | "not_saved" };

export interface ChatThreadInputDeps {
  chatThreads: Pick<ChatThreads, "companyOf">;
  runtimeFor(companyId: OrgId): Promise<{ flow: { deps: TaskFlowDeps } }>;
  now: () => number;
}

const NOT_ALLOWED: ChatThreadInputResult = { outcome: "refused", notice: "not_allowed" };
const NOT_SAVED: ChatThreadInputResult = { outcome: "refused", notice: "not_saved" };
const TRANSACT_ATTEMPTS = 3;

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** An id for this reply that is the same for every copy and every retry of it, and different for any other reply, task, thread or company. */
function replyDigest(companyId: string, taskId: string, conversation: ConversationRef, messageId: string): string {
  return sha(["chat-thread-input", companyId, taskId, conversation.channel, conversation.tenant, conversation.space, conversation.thread, messageId].join("\u0000"));
}

/** A request id (UUID shape, version 4) made from a reply's digest: one reply is one answer, whatever copy of it arrives. */
const requestIdOf = (digest: string): string => `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;

/** The message id a note keeps (`msg_` and 20 lowercase letters or digits). */
const noteMessageIdOf = (digest: string): string => `msg_${digest.slice(0, 20)}`;

/** The reply as text for a model and a note: credentials redacted, control and format characters gone (line breaks and tabs stay), chat mentions made neutral, no more than the web's message holds. */
export function cleanedReplyText(raw: string): string {
  return [...redactText(neutralizeSlackMentions(raw)).replace(/(?![\t\n\r])[\p{Cc}\p{Cf}]/gu, "").trim()].slice(0, SESSION_MESSAGE_MAX_CHARS).join("").trim();
}

const NUMBERED = /^\s*(?:q|question\s*)?([1-9])\s*[.):-]\s*(.*)$/iu;

/** One question's answer from the person's words: an option named by its letter or its label picks it; anything else is their own words (`your call` too). */
function answerOf(question: IntentQuestion, words: string): IntentAnswer | undefined {
  const said = words.trim();
  if (said === "") return undefined;
  const plain = said.toLowerCase().replace(/[.)\s]+$/u, "");
  const option = question.options?.find((candidate) => candidate.id.toLowerCase() === plain || candidate.label.trim().toLowerCase() === plain);
  return option === undefined ? { questionId: question.id, text: [...said].slice(0, INTENT_ANSWER_MAX_CHARS).join("") } : { questionId: question.id, optionId: option.id };
}

/**
 * The answers a reply gives to the questions asked. One question: the whole reply. More: one numbered line (`1. a`, `2) words`, `q3: your call`) for EVERY question, each number once, and nothing before the first;
 * a line that is not numbered goes on the line above it. Anything else is no answer (undefined): the task is not guessed at.
 */
export function answersFromReply(text: string, questions: readonly IntentQuestion[]): IntentAnswer[] | undefined {
  if (questions.length === 0) return undefined;
  if (questions.length === 1) {
    const only = answerOf(questions[0]!, text);
    return only === undefined ? undefined : [only];
  }
  const lines = new Map<number, string>();
  let last: number | undefined;
  for (const line of text.split(/\r?\n/u)) {
    const numbered = NUMBERED.exec(line);
    if (numbered !== null) {
      const number = Number(numbered[1]);
      if (lines.has(number)) return undefined;
      lines.set(number, numbered[2]!.trim());
      last = number;
    } else if (line.trim() !== "") {
      if (last === undefined) return undefined;
      lines.set(last, `${lines.get(last) ?? ""} ${line.trim()}`.trim());
    }
  }
  if (lines.size !== questions.length) return undefined;
  const answers: IntentAnswer[] = [];
  for (const [index, question] of questions.entries()) {
    const given = lines.get(index + 1);
    const answer = given === undefined ? undefined : answerOf(question, given);
    if (answer === undefined) return undefined;
    answers.push(answer);
  }
  return answers;
}

export async function addChatThreadInput(deps: ChatThreadInputDeps, deployed: DeployedCaller, input: ChatThreadInput): Promise<ChatThreadInputResult> {
  const { companyId } = deployed.principal;
  // The conversation, its actor and the person's company are one workspace and one company: a workspace of another company is never this company's thread.
  if (input.conversation.channel !== input.actor.channel || input.conversation.tenant !== input.actor.tenant) return NOT_ALLOWED;
  if (!(await tenantIsCompanys(deps.chatThreads.companyOf, companyId as OrgId, input.conversation.channel, input.conversation.tenant))) return NOT_ALLOWED;
  let flow: TaskFlowDeps;
  try { flow = (await deps.runtimeFor(companyId)).flow.deps; } catch { return NOT_SAVED; }
  if (flow.companyId !== companyId) return NOT_ALLOWED;
  const task = await readTask(flow, input.taskId);
  if (task === undefined || task.companyId !== companyId) return NOT_ALLOWED;
  // The thread the task was started from, when it was remembered, is this one.
  const remembered = await readTaskThread(flow.store, companyId as OrgId, typeof task.sessionId === "string" ? task.sessionId : taskSessionId(task.taskId));
  if (remembered !== undefined && (remembered.conversation.channel !== input.conversation.channel || remembered.conversation.tenant !== input.conversation.tenant
    || remembered.conversation.space !== input.conversation.space || remembered.conversation.thread !== input.conversation.thread)) return NOT_ALLOWED;
  const text = cleanedReplyText(input.text);
  const digest = replyDigest(companyId, task.taskId, input.conversation, input.messageId);
  const workflow = task.workflow;
  const caller: TaskCaller = { principal: deployed.principal, ...(deployed.client === undefined ? {} : { client: deployed.client }) };

  if (task.closedAt !== undefined || workflow === undefined) {
    // Closed tasks and tasks with no workflow take no notes; who asked is not told which.
    return (await acting(flow, deployed, task)) === undefined ? NOT_ALLOWED : NOT_SAVED;
  }

  // This very reply already answered the task's questions (a Slack retry, or the plain copy of the mention that answered): the task has moved on and is not waiting now, so it must not become a note as well.
  const requestId = requestIdOf(digest);
  if ((await acting(flow, deployed, task)) !== undefined && await answerRequestTaken(flow, task, requestId)) return { outcome: "duplicate" };

  // ---- Understand's questions are waiting: a mention answers them, the web's own move.
  if (waitingForAnswers(workflow)) {
    if ((await acting(flow, deployed, task)) === undefined) return NOT_ALLOWED;
    if (!input.mention || text === "") return NOT_SAVED;
    const asked = workflow.intent?.assessment;
    if (asked?.kind !== "questions" || workflow.intent === undefined) return NOT_SAVED;
    const answers = answersFromReply(text, asked.questions);
    if (answers === undefined) return { outcome: "refused", notice: "answers_unclear" };
    try {
      const answered = await answerTaskOnRequest(flow, caller, task.taskId, () => ({ requestId, round: workflow.intent!.rounds, answers }));
      return answered.repeated ? { outcome: "duplicate" } : { outcome: "captured", notice: "answers_saved" };
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      // Not the task's owner (or the task is not this person's to see): the same words. The task moved on while the reply was read, or the same id was used for other words: nothing was saved.
      if (error.code === "TASK_NOT_FOUND" || error.code === "FORBIDDEN") return NOT_ALLOWED;
      if (error.code === "INTENT_NOT_WAITING" || error.code === "CONFIG_INVALID" || error.code === "IDEMPOTENCY_CONFLICT") return NOT_SAVED;
      throw error;
    }
  }

  // ---- Not waiting for answers: small talk is not input, everything else is a note.
  // Small talk ("thanks", "ok") is never input and writes nothing, so it is told apart before anything is asked of who the person is.
  if (input.smallTalk) return { outcome: "small_talk" };
  const standing = await acting(flow, deployed, task);
  if (standing === undefined) return NOT_ALLOWED;
  if (text === "") return NOT_SAVED;
  const route = routeOfTask({ sessionId: typeof task.sessionId === "string" ? task.sessionId : taskSessionId(task.taskId) }, task);
  if (route.kind !== "note") return NOT_SAVED;
  const host = createSessionControlHost(flow);
  const author = { developerId: developerIdOf(deployed.principal), name: deployed.principal.displayName.trim().slice(0, 200) || "Rovara member" };
  const planReview = workflow.stage === "PLAN_REVIEW" && workflow.state === "WAITING";
  for (let attempt = 1; attempt <= TRANSACT_ATTEMPTS; attempt += 1) {
    // The plan reads the task again each time: a lost race (the hourly token, the note count) is planned again.
    const plan = await host.planMessage!(task.taskId, { messageId: noteMessageIdOf(digest), text, sessionId: typeof task.sessionId === "string" ? task.sessionId : taskSessionId(task.taskId), author, owner: true });
    if (plan.state === "not_delivered") return plan.reason === MESSAGE_RATE_LIMITED ? { outcome: "refused", notice: "rate_limited" } : NOT_SAVED;
    // Already saved (a repeat, or the other copy of the same mention): nothing to write.
    if (plan.items === undefined) return { outcome: "duplicate" };
    const items: TransactItem[] = [...plan.items, ...standing];
    const written = await flow.store.transact(items);
    if (written.applied) return { outcome: "captured", notice: planReview ? "plan_note_saved" : "note_saved" };
    // The note's own put failed: it was saved first by the other copy of the same reply.
    const notePut = plan.items.findIndex((item) => item.kind === "put" && typeof item.item["sk"] === "string" && item.item["sk"].startsWith("NOTE#"));
    if (notePut >= 0 && written.failed.includes(notePut)) return { outcome: "duplicate" };
    // The owner's live access fence failed: who may act changed in between.
    if (written.failed.some((index) => index >= plan.items!.length)) return NOT_ALLOWED;
  }
  // Every attempt lost a race with another write: nothing says the reply is refused, so it is not answered as one. Slack retries it.
  throw new Error("the thread reply could not be saved: its transaction was cancelled");
}

/**
 * The person's standing for this task, or undefined when they have none: the web's owner rule (`ownerActing`: the person the task runs for, or a People owner) AND a live role on the task's project (`checkStart`: a live
 * member of the company with the project's grant), so an owner who lost their place in the project adds nothing from a chat. The answer is the items that join the write (the live access fence).
 */
async function acting(flow: TaskFlowDeps, deployed: DeployedCaller, task: { taskId: string; developerId: string; project: string; ownerKey: string; workflow?: { ownerId?: string } | undefined }): Promise<readonly TransactItem[] | undefined> {
  if (flow.access.ownerActing === undefined || deployed.principal.companyId !== flow.companyId) return undefined;
  if (!(await flow.access.checkStart(deployed.principal, task.project)).allowed) return undefined;
  const found = await flow.access.ownerActing(deployed.principal, { taskId: task.taskId, developerId: task.developerId, project: task.project, ownerKey: task.workflow?.ownerId ?? task.ownerKey });
  return found === undefined ? undefined : (found.items ?? []);
}
