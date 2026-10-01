// FR-003: a `Prompter` that asks on the wizard page instead of the terminal. Every question
// `agentx init` already asks goes through here unchanged; nothing about what it asks, or in what
// order, is different from the terminal path.
//
// The checks each method gives the hub are `terminalPrompter`'s own, so a refused answer is shown
// on the field and the question comes back, rather than ending the run. FR-012: a secret's value is
// only ever the promise's result. It is never put in the question, in the rejection message, or in
// anything the page can read back.
//
// Spec 048 FR-010 and FR-011: every question also carries the page's own words (question-copy.ts):
// a label, a why line, an example, a hint for an empty field, and verb buttons. The terminal's own
// question text and behavior never change; help is page-only.
import { stripPasteMarkers, type Prompter, type QuestionHelp } from "../prompts.js";
import type { WizardButton } from "./protocol.js";
import { pageHint, questionHelp } from "./question-copy.js";
import type { AnswerCheck, NewQuestion, WizardHub } from "./state.js";

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
 * `cleanSecret` still runs afterwards on the way to Secrets Manager; this only front-runs it.
 * `validate` (FR-040) then checks the cleaned value, so a refusal never sees the paste markers. */
function secretCheck(what: string, multiline: boolean, validate?: (value: string) => string | undefined): AnswerCheck {
  return (raw) => {
    const value = stripPasteMarkers(raw).trim();
    if (value === "") return { error: `the ${what} is empty` };
    if (!multiline && /\s/.test(value)) return { error: `the ${what} contains spaces or line breaks; copy it again and paste only the value` };
    const problem = validate?.(value);
    return problem === undefined ? { value } : { error: problem };
  };
}

/** The help fields a question carries to the page, only those that are set. */
function pageFields(help: QuestionHelp): Pick<NewQuestion, "label" | "why" | "example" | "learnMoreUrl"> {
  return {
    ...(help.label === undefined ? {} : { label: help.label }),
    ...(help.why === undefined ? {} : { why: help.why }),
    ...(help.example === undefined ? {} : { example: help.example }),
    ...(help.learnMoreUrl === undefined ? {} : { learnMoreUrl: help.learnMoreUrl }),
  };
}

export function browserPrompter(hub: WizardHub): Prompter {
  return {
    async ask(question, options) {
      const help = questionHelp({ kind: "ask", text: question, flag: options.flag, ...(options.help === undefined ? {} : { given: options.help }) });
      const hint = pageHint(options.defaultValue, help);
      return hub.ask(
        { kind: "ask", text: question, ...(options.defaultValue === undefined ? {} : { defaultValue: options.defaultValue }), ...pageFields(help), ...(hint === undefined ? {} : { hint }) },
        askCheck(options),
      );
    },
    async choose<T extends string>(question: string, choices: ReadonlyArray<{ value: T; label: string }>, options: { flag: string; defaultValue: T; help?: QuestionHelp }): Promise<T> {
      const help = questionHelp({ kind: "choose", text: question, flag: options.flag, ...(options.help === undefined ? {} : { given: options.help }) });
      const labelled = choices.map((choice) => ({ value: choice.value, label: help.choiceLabels?.[choice.value] ?? choice.label }));
      const asButtons = help.buttons === true;
      const buttons: WizardButton[] = labelled.map((choice, index) => ({ value: choice.value, label: choice.label, primary: index === 0 }));
      const answer = await hub.ask(
        {
          kind: asButtons ? "actions" : "choose", text: question, defaultValue: options.defaultValue, choices: labelled,
          ...(asButtons ? { buttons } : {}), ...pageFields(help),
        },
        (raw) => {
          if (raw === "" && !asButtons) return { value: options.defaultValue };
          return choices.some((choice) => choice.value === raw) ? { value: raw } : { error: "choose one of the options" };
        },
      );
      return answer as T;
    },
    async confirm(question, options) {
      const help = questionHelp({ kind: "confirm", text: question, ...(options.help === undefined ? {} : { given: options.help }) });
      const buttons: WizardButton[] = [
        { value: CONFIRM_YES, label: help.yesLabel ?? "Yes", primary: true },
        { value: CONFIRM_NO, label: help.noLabel ?? "No", primary: false },
      ];
      const answer = await hub.ask(
        { kind: "confirm", text: question, defaultConfirm: options.defaultValue, buttons, ...pageFields(help) },
        (raw) => (raw === CONFIRM_YES || raw === CONFIRM_NO ? { value: raw } : { error: "answer yes or no" }),
      );
      return answer === CONFIRM_YES;
    },
    async secret(question, options) {
      const multiline = options.multiline === true;
      const help = questionHelp({ kind: "secret", text: question, flag: options.flag, ...(options.help === undefined ? {} : { given: options.help }) });
      return hub.ask(
        { kind: "secret", text: question, masked: true, ...(multiline ? { multiline: true } : {}), ...pageFields(help) },
        secretCheck(question, multiline, options.validate),
      );
    },
  };
}
