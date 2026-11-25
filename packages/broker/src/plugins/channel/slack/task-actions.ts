// S1: how Slack shows a task action's form, its confirm and its refusals. This file holds LAYOUT and Slack's words only: it builds a modal from the `InputSpec` Code served (a Slack input per field, a select per item), reads the values
// back from a submission, and says a refusal in words picked by its stable reason. It imports nothing from `core/task-flow` or `core/task-actions` and holds no who, when or stage logic (a test fails on either): Code decides, this renders.
// Text that came from the task (a finding, a title) was made inert by Code before it was served; it is still escaped here for Slack's markup.
import {
  ACTION_WORDS, taskActionOfButtonId, type ActionValues, type ConfirmLines, type InputField, type InputSpec, type TaskActionId, type TaskActionRefusalReason, type TaskActionWrites,
} from "@agentx/contracts";
import { escapeText } from "./format.js";

/** The modal's callback id, and the id its inputs' action carries. */
export const TASK_ACTION_FORM = "rovara_task_form";
const INPUT_ACTION = "v";
const SECTION_MAX = 2_900;
const METADATA_MAX = 2_800;

/** What a form carries for itself (Slack returns it as given and the person cannot edit it): the move, what the person was shown, who opened it and where the card is. Never a right. */
export interface TaskFormContext {
  /** The registry id. */ a: TaskActionId;
  /** The task. */ t: string;
  /** The revision shown. */ r: number;
  /** The digest shown. */ d?: string | undefined;
  /** The confirm digest this form shows now. */ c?: string | undefined;
  /** The thread's workspace, channel and thread, the person who opened the form and their workspace, and the card's message. */
  s: string; h: string; ts: string; u: string; w: string; m: string;
  /** The card's words, cut, so it can be updated in place once the move was taken. */
  x?: string | undefined;
}

const plain = (text: string) => ({ type: "plain_text", text });
const mrkdwn = (text: string) => ({ type: "mrkdwn", text });
const cut = (text: string, max: number): string => { const chars = [...text]; return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`; };
const section = (text: string) => ({ type: "section", text: mrkdwn(cut(escapeText(text), SECTION_MAX)) });

/** The view shown the instant a press needs a form (its trigger is good for a few seconds): replaced by the real form as soon as Code has described it. */
export function loadingTaskModal(label: string): Record<string, unknown> {
  return { type: "modal", title: plain(cut(label, 24)), close: plain("Close"), blocks: [section("Getting this ready...")] };
}

/** A view that only says something (a refusal, a result), with one button to close it. */
export function messageTaskModal(label: string, text: string): Record<string, unknown> {
  return { type: "modal", title: plain(cut(label, 24)), close: plain("Close"), blocks: [section(text)] };
}

const blockOf = (id: string, label: string, element: Record<string, unknown>, optional: boolean) => ({ type: "input", block_id: id, optional, label: plain(cut(label, 2_000)), element });

function optionOf(option: { value: string; label: string }): Record<string, unknown> {
  return { text: plain(cut(option.label, 75)), value: cut(option.value, 150) };
}

function fieldBlocks(field: InputField, values: ActionValues): unknown[] {
  const given = values[field.id];
  if (field.kind === "text") {
    const initial = typeof given === "string" ? given : field.initial;
    return [blockOf(`f:${field.id}`, field.label, { type: "plain_text_input", action_id: INPUT_ACTION, multiline: field.multiline === true, max_length: field.max, ...(initial === undefined || initial === "" ? {} : { initial_value: cut(initial, field.max) }) }, !field.required)];
  }
  if (field.kind === "choice") {
    const initial = field.options.find((option) => option.value === (typeof given === "string" ? given : field.initial));
    return [blockOf(`f:${field.id}`, field.label, { type: "static_select", action_id: INPUT_ACTION, placeholder: plain("Choose"), options: field.options.slice(0, 100).map(optionOf), ...(initial === undefined ? {} : { initial_option: optionOf(initial) }) }, !field.required)];
  }
  if (field.kind === "pick-many") {
    const chosen = Array.isArray(given) ? new Set(given) : undefined;
    const initial = field.options.filter((option) => (chosen === undefined ? option.selected === true : chosen.has(option.value)));
    return [blockOf(`f:${field.id}`, field.label, { type: "multi_static_select", action_id: INPUT_ACTION, placeholder: plain("Choose"), options: field.options.slice(0, 100).map(optionOf), ...(initial.length === 0 ? {} : { initial_options: initial.slice(0, 100).map(optionOf) }) }, field.min === 0)];
  }
  return field.items.flatMap((item) => {
    const choice = typeof values[item.id] === "string" ? values[item.id] : field.choices.find((option) => option.selected === true)?.value;
    const initial = field.choices.find((option) => option.value === choice);
    const note = values[`${item.id}#note`];
    return [
      section(item.text),
      blockOf(`i:${item.id}:c`, "What to do", { type: "static_select", action_id: INPUT_ACTION, placeholder: plain("Choose"), options: field.choices.map(optionOf), ...(initial === undefined ? {} : { initial_option: optionOf(initial) }) }, false),
      blockOf(`i:${item.id}:n`, field.noteRequiredFor === undefined ? "Note (optional)" : `Note (needed to ${field.choices.find((option) => option.value === field.noteRequiredFor)?.label.toLowerCase() ?? "accept"})`,
        { type: "plain_text_input", action_id: INPUT_ACTION, multiline: true, max_length: field.noteMax, ...(typeof note === "string" && note !== "" ? { initial_value: cut(note, field.noteMax) } : {}) }, true),
    ];
  });
}

/** The context as Slack's private metadata, shrunk (the card's words first) until it fits Slack's limit. */
export function taskFormMetadata(context: TaskFormContext): string {
  let x = context.x === undefined ? "" : [...context.x].slice(0, 1_200).join("");
  while (x !== "" && JSON.stringify({ ...context, x }).length > METADATA_MAX) x = [...x].slice(0, Math.floor([...x].length * 0.8)).join("");
  return JSON.stringify(x === "" ? { ...context, x: undefined } : { ...context, x });
}

/**
 * The form: the confirm (when the move has one) above the fields, the fields filled from `values` (so a form shown again after a confirm keeps what the person typed), and a submit button named for the move.
 * `note` is one line above everything (a refusal of the last submit, or "fill in the required fields").
 */
export function taskActionModal(input: { label: string; spec: InputSpec; confirm?: ConfirmLines | undefined; context: TaskFormContext; values?: ActionValues | undefined; note?: string | undefined }): Record<string, unknown> {
  const values = input.values ?? {};
  const confirmBlocks = input.confirm === undefined ? [] : [section(input.confirm.title === input.label ? input.confirm.lines.join("\n") : `*${input.confirm.title}*\n${input.confirm.lines.join("\n")}`)];
  const blocks = [...(input.note === undefined ? [] : [section(input.note)]), ...confirmBlocks, ...input.spec.fields.flatMap((field) => fieldBlocks(field, values))].slice(0, 100);
  return {
    type: "modal", callback_id: TASK_ACTION_FORM, private_metadata: taskFormMetadata(input.context),
    title: plain(cut(input.label, 24)), submit: plain(cut(input.confirm?.button ?? input.label, 24)), close: plain("Cancel"),
    blocks: blocks.length === 0 ? [section(input.label)] : blocks,
  };
}

type StateValue = { type?: string; value?: string | null; selected_option?: { value?: string } | null; selected_options?: Array<{ value?: string }> };
const asRecord = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});

/** What the person entered, read back from a submission by the ids the form's blocks carry (`f:<field>`, `i:<item>:c` and `i:<item>:n`). Empty entries are left out. */
export function valuesOfSubmission(view: Record<string, unknown>): ActionValues {
  const state = asRecord(asRecord(view.state).values);
  const values: Record<string, string | string[]> = {};
  for (const [blockId, block] of Object.entries(state)) {
    const entry = asRecord(asRecord(block)[INPUT_ACTION]) as StateValue;
    const key = blockId.startsWith("f:") ? blockId.slice(2) : (() => { const found = /^i:([^:]+):([cn])$/u.exec(blockId); return found === null ? undefined : found[2] === "c" ? found[1]! : `${found[1]!}#note`; })();
    if (key === undefined) continue;
    if (Array.isArray(entry.selected_options)) values[key] = entry.selected_options.flatMap((option) => (typeof option.value === "string" ? [option.value] : []));
    else if (typeof entry.selected_option?.value === "string") values[key] = entry.selected_option.value;
    else if (typeof entry.value === "string" && entry.value.trim() !== "") values[key] = entry.value;
  }
  return values;
}

/** The context a form carries, or undefined when it does not read (the form is then closed). */
export function taskFormContextOf(view: Record<string, unknown>): TaskFormContext | undefined {
  try {
    const parsed = asRecord(JSON.parse(typeof view.private_metadata === "string" ? view.private_metadata : ""));
    const required = ["t", "s", "h", "ts", "u", "w", "m"].every((key) => typeof parsed[key] === "string") && typeof parsed.r === "number" && Number.isInteger(parsed.r) && typeof parsed.a === "string" && taskActionOfButtonId(`rovara_task:${parsed.a}`) !== undefined;
    return required ? parsed as unknown as TaskFormContext : undefined;
  } catch { return undefined; }
}

/** The words of a refusal, by its stable reason (never by a sentence). `writes` says whether to check the task before pressing again. */
const REFUSAL_WORDS: Record<TaskActionRefusalReason, string> = {
  not_linked: "Link your Slack account to Rovara first, then press the button again.",
  not_found: "That task is not available to you here.",
  not_yours: "Only the task's owner can do that.",
  not_offered: "That is not available now: the task has moved on.",
  stale: "This card is out of date. Use the latest message in this thread.",
  busy: "A step is running right now. Try again in a moment.",
  over_limit: "This task has used its run limit, so nothing was started.",
  needs_web: "Open the Rovara task page to do that.",
  needs_input: "That needs a value or a confirmation first. Press the button again.",
  closed: "This task is closed.",
  unavailable: "Something went wrong. Try again in a moment.",
};
export function taskActionRefusalWords(reason: TaskActionRefusalReason, writes: TaskActionWrites = "none"): string {
  return writes === "none" ? REFUSAL_WORDS[reason] : `${REFUSAL_WORDS[reason]} Check the task before you press it again: it may already have been done.`;
}

/** The one line a card shows once its move was taken in Slack. */
export const taskActionDoneLine = (id: TaskActionId): string => `Done in Slack: ${ACTION_WORDS[id].done || ACTION_WORDS[id].label}`;
export const TASK_ACTION_REPLAYED_WORDS = "That was already done.";
export const TASK_ACTION_EXPIRED_WORDS = "That button expired. Open the task page to act.";
