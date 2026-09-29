// FR-003: a `Prompter` that asks on the wizard page instead of the terminal. Every question
// `agentx init` already asks goes through here unchanged; nothing about what it asks, or in what
// order, is different from the terminal path.
//
// The checks each method gives the hub are `terminalPrompter`'s own, so a refused answer is shown
// on the field and the question comes back, rather than ending the run. FR-012: a secret's value is
// only ever the promise's result. It is never put in the question, in the rejection message, or in
// anything the page can read back.
import { stripPasteMarkers, type Prompter } from "../prompts.js";
import type { AnswerCheck, WizardHub } from "./state.js";

export const CONFIRM_YES = "yes";
export const CONFIRM_NO = "no";

/** `terminalPrompter.ask`'s rule: an empty field means the default, and is an answer only when the
 * question has one. */
function askCheck(options: { defaultValue?: string; validate?: (value: string) => string | undefined }): AnswerCheck {
  return (raw) => {
    const typed = raw.trim();
    const value = typed === "" && options.defaultValue !== undefined ? options.defaultValue : typed;
    if (value === "" && options.defaultValue === undefined) return { error: "an answer is required" };
    const problem = options.validate?.(value);
    return problem === undefined ? { value } : { error: problem };
  };
}

/** `cleanSecret`'s own rules, applied on the field: the common mis-paste (an empty field, or a
 * value with the surrounding text copied with it) becomes an inline error rather than a dead run.
 * `cleanSecret` still runs afterwards on the way to Secrets Manager; this only front-runs it. */
function secretCheck(what: string, multiline: boolean): AnswerCheck {
  return (raw) => {
    const value = stripPasteMarkers(raw).trim();
    if (value === "") return { error: `the ${what} is empty` };
    if (!multiline && /\s/.test(value)) return { error: `the ${what} contains spaces or line breaks; copy it again and paste only the value` };
    return { value };
  };
}

export function browserPrompter(hub: WizardHub): Prompter {
  return {
    async ask(question, options) {
      return hub.ask(
        { kind: "ask", text: question, ...(options.defaultValue === undefined ? {} : { defaultValue: options.defaultValue }) },
        askCheck(options),
      );
    },
    async choose<T extends string>(question: string, choices: ReadonlyArray<{ value: T; label: string }>, options: { flag: string; defaultValue: T }): Promise<T> {
      const answer = await hub.ask(
        {
          kind: "choose",
          text: question,
          defaultValue: options.defaultValue,
          choices: choices.map((choice) => ({ value: choice.value, label: choice.label })),
        },
        (raw) => {
          if (raw === "") return { value: options.defaultValue };
          return choices.some((choice) => choice.value === raw) ? { value: raw } : { error: "choose one of the options" };
        },
      );
      // The check above accepted it, so it is one of `choices` (or the default), hence a T.
      return answer as T;
    },
    async confirm(question, options) {
      const answer = await hub.ask(
        { kind: "confirm", text: question, defaultConfirm: options.defaultValue },
        (raw) => (raw === CONFIRM_YES || raw === CONFIRM_NO ? { value: raw } : { error: "answer yes or no" }),
      );
      return answer === CONFIRM_YES;
    },
    async secret(question, options) {
      const multiline = options.multiline === true;
      return hub.ask(
        { kind: "secret", text: question, masked: true, ...(multiline ? { multiline: true } : {}) },
        secretCheck(question, multiline),
      );
    },
  };
}
