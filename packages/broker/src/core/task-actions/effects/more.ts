// S1: the rest of the registry's effects: merge (irreversible, with a confirm), the answers to Understand's questions, and the People moves of the first cut (the view, and taking over a task nobody owns). Each `perform` is ONE call into
// the function the web already uses (`pressMergeAsPerson` through the hosted merge's own checks, `answerTaskOnRequest`, the People effects), judged for the person who pressed.
import {
  IntentAnswerSchema, YOUR_CALL_WORDS, agentXError, type ActionBinding, type ConfirmLines, type InputField, type TaskActionRisk, type WorkflowSnapshot,
} from "@agentx/contracts";
import { answerTaskOnRequest } from "../../task-flow/answer-request.js";
import type { TaskRecord } from "../../task-flow/records.js";
import type { ActionEnv, ActionCaller, Description, PressContext, Performed } from "../types.js";
import { inert, textOf } from "./values.js";
import { taskIsOpen } from "./moves.js";

// ---- merge

/** The merge button is offered while the task waits for the merge; whether it would merge NOW is read (and shown) when the person presses. */
export const mergeWhen = (env: ActionEnv, task: TaskRecord): ActionBinding | undefined => {
  const workflow = task.workflow;
  return env.merge !== undefined && taskIsOpen(task) && workflow !== undefined && workflow.stage === "WAIT_FOR_MERGE" && (workflow.pullRequests ?? []).some((pullRequest) => pullRequest.required && pullRequest.state !== "MERGED")
    ? { revision: workflow.revision } : undefined;
};
export const mergeRisk = (): TaskActionRisk => "irreversible";

export async function describeMerge(env: ActionEnv, caller: ActionCaller, task: TaskRecord): Promise<Description> {
  const readiness = await env.merge!.readiness(caller, task);
  if (!readiness.ready || readiness.heads === undefined || readiness.risk === undefined) {
    throw agentXError("TASK_ACTION_NOT_OFFERED", "the pull requests are not ready to merge", { reason: "not_offered", writes: "none" });
  }
  const lines = [
    "Merging puts the pull requests into their base branches on GitHub. This cannot be undone from Rovara.",
    ...readiness.heads.map((head) => `${inert(head.repositoryId, 80)} #${String(head.number)} at ${head.headSha.slice(0, 7)}`),
    `Risk: ${readiness.risk}.`,
  ];
  const confirm: ConfirmLines = { title: "Merge this task", lines, button: "Merge", danger: true };
  return { spec: { fields: [] }, confirm, bound: { heads: readiness.heads, risk: readiness.risk } };
}

export async function performMerge(ctx: PressContext): Promise<Performed> {
  // The heads and the risk are read again NOW and are exactly what the confirm digest bound: a press on anything else was refused before this.
  const readiness = await ctx.env.merge!.readiness(ctx.caller, ctx.task);
  if (!readiness.ready || readiness.heads === undefined || readiness.risk === undefined) throw agentXError("TASK_ACTION_NOT_OFFERED", "the pull requests are not ready to merge", { reason: "not_offered", writes: "none" });
  await ctx.env.merge!.press(ctx.caller, ctx.task, { requestId: ctx.requestId, expectedHeads: readiness.heads, risk: readiness.risk });
  return { status: "done" };
}

// ---- the answers to Understand's questions

function questionsOf(workflow: WorkflowSnapshot | undefined) {
  const assessment = workflow?.intent?.assessment;
  return workflow !== undefined && assessment?.kind === "questions" && workflow.stage === "UNDERSTAND" && workflow.state === "WAITING" ? { round: workflow.intent!.rounds, questions: assessment.questions } : undefined;
}

export const answerWhen = (task: TaskRecord): ActionBinding | undefined => {
  const found = taskIsOpen(task) ? questionsOf(task.workflow) : undefined;
  return found === undefined ? undefined : { revision: task.workflow!.revision };
};

const YOUR_CALL = "your_call";

export async function describeAnswer(_env: ActionEnv, _caller: ActionCaller, task: TaskRecord): Promise<Description> {
  const found = questionsOf(task.workflow)!;
  const fields: InputField[] = found.questions.flatMap((question): InputField[] => [
    { kind: "choice", id: question.id, label: inert(question.text, 110), required: false,
      options: [...(question.options ?? []).map((option) => ({ value: option.id, label: inert(`${option.label}${question.recommended === option.id ? " (recommended)" : ""}`, 100) })), { value: YOUR_CALL, label: `Your call (${YOUR_CALL_WORDS})` }] },
    { kind: "text", id: `${question.id}_text`, label: `${question.id}: in your own words (optional)`, required: false, max: 2_000, multiline: true },
  ]);
  return { spec: { fields: fields.slice(0, 8) } };
}

export async function performAnswer(ctx: PressContext): Promise<Performed> {
  const found = questionsOf(ctx.task.workflow);
  if (found === undefined) throw agentXError("TASK_ACTION_NOT_OFFERED", "the questions are not waiting", { reason: "not_offered", writes: "none" });
  const answers = found.questions.flatMap((question) => {
    const choice = textOf(ctx.values, question.id);
    const text = textOf(ctx.values, `${question.id}_text`);
    const parsed = IntentAnswerSchema.safeParse(choice === YOUR_CALL || choice === "" ? (text === "" ? (choice === "" ? undefined : { questionId: question.id, text: YOUR_CALL_WORDS }) : { questionId: question.id, text }) : { questionId: question.id, optionId: choice, ...(text === "" ? {} : { text }) });
    return parsed.success ? [parsed.data] : [];
  });
  if (answers.length !== found.questions.length) throw agentXError("TASK_ACTION_NEEDS_INPUT", "answer every question", { reason: "needs_input", writes: "none" });
  const result = await answerTaskOnRequest(ctx.deps, ctx.caller, ctx.task.taskId, () => ({ requestId: ctx.requestId, round: found.round, answers }));
  return { status: result.repeated ? "replayed" : "started" };
}

// ---- People: the view, and taking over a task nobody owns

export const peopleViewWhen = (task: TaskRecord): ActionBinding | undefined => (taskIsOpen(task) ? { revision: 0 } : undefined);

export async function performPeopleView(ctx: PressContext): Promise<Performed> {
  const view = await ctx.env.people?.view(ctx.caller, ctx.task);
  if (view === undefined) throw agentXError("TASK_ACTION_NOT_OFFERED", "the people of this task cannot be read here", { reason: "not_offered", writes: "none" });
  const take = await ctx.env.people?.canTakeOwnership(ctx.caller, ctx.task).catch(() => undefined);
  return { status: "done", said: view.lines.join("\n"), ...(take === undefined ? {} : { next: [{ id: "people.take-ownership" as const, label: "Take ownership", risk: "routine" as const, needsDialog: true, binding: { revision: take.peopleRevision } }] }) };
}

export const takeOwnershipWhen = (env: ActionEnv, task: TaskRecord, caller: ActionCaller | undefined): Promise<ActionBinding | undefined> | ActionBinding | undefined => {
  if (env.people === undefined || !taskIsOpen(task) || caller === undefined) return undefined;
  return env.people.canTakeOwnership(caller, task).then((found) => (found === undefined ? undefined : { revision: found.peopleRevision }), () => undefined);
};

export async function describeTakeOwnership(env: ActionEnv, caller: ActionCaller, task: TaskRecord): Promise<Description> {
  const found = await env.people?.canTakeOwnership(caller, task);
  if (found === undefined) throw agentXError("TASK_ACTION_NOT_OFFERED", "this task has an owner", { reason: "not_offered", writes: "none" });
  const confirm: ConfirmLines = { title: "Take ownership", lines: ["You become the owner of this task: you decide its plans and its spend.", "Say yes only if you mean to run it."], button: "Take ownership", danger: false };
  return { spec: { fields: [] }, confirm, bound: { peopleRevision: found.peopleRevision } };
}

export async function performTakeOwnership(ctx: PressContext): Promise<Performed> {
  const found = await ctx.env.people?.canTakeOwnership(ctx.caller, ctx.task);
  if (found === undefined) throw agentXError("TASK_ACTION_NOT_OFFERED", "this task has an owner", { reason: "not_offered", writes: "none" });
  await ctx.env.people!.takeOwnership(ctx.caller, ctx.task, { requestId: ctx.requestId, expectedPeopleRevision: found.peopleRevision });
  return { status: "done" };
}

/** The held entries (people add and role): declared, never offered in the first cut. */
export const heldWhen = (): ActionBinding | undefined => undefined;
export const performHeld = async (): Promise<Performed> => { throw agentXError("TASK_ACTION_NOT_OFFERED", "this is held for the second cut", { reason: "not_offered", writes: "none" }); };
