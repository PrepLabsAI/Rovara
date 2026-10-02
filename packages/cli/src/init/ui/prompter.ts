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
import { stripPasteMarkers, type FormField, type Prompter, type QuestionHelp } from "../prompts.js";
import type { WizardButton, WizardField } from "./protocol.js";
import { pageHint, questionHelp } from "./question-copy.js";
import { isShowableLink, NEW_TAB_NOTE, type AnswerCheck, type NewQuestion, type WizardHub } from "./state.js";

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
    async form(title, fields, options) {
      const help = questionHelp({ kind: "form", text: title, ...(options.help === undefined ? {} : { given: options.help }) });
      const fieldHelp = (field: FormField) => questionHelp({ kind: field.choices !== undefined ? "choose" : field.secret === true ? "secret" : "ask", text: field.question, flag: field.flag, ...(field.help === undefined ? {} : { given: field.help }) });
      const toField = (field: FormField, kept?: string, error?: string): WizardField => {
        const words = fieldHelp(field);
        const hint = field.secret === true || field.choices !== undefined ? undefined : pageHint(field.defaultValue, words);
        const link = words.learnMoreUrl !== undefined && isShowableLink(words.learnMoreUrl)
          ? { url: words.learnMoreUrl, label: words.linkLabel ?? "Learn more", note: NEW_TAB_NOTE } : undefined;
        return {
          name: field.name, label: words.label ?? field.question,
          ...(words.why === undefined ? {} : { why: words.why }),
          ...(words.example === undefined ? {} : { example: words.example }),
          ...(hint === undefined ? {} : { hint }),
          ...(field.secret === true ? { masked: true } : {}),
          // A choice's own label is the field's own data; only the field's own `help` relabels it
          // (never the shared question-copy catalog, which is keyed by flag and could otherwise
          // relabel an unrelated form field that happens to reuse a flag such as --engine).
          ...(field.choices === undefined ? {} : {
            choices: field.choices.map((choice) => ({ value: choice.value, label: field.help?.choiceLabels?.[choice.value] ?? choice.label })),
            defaultValue: field.defaultValue ?? field.choices[0]?.value ?? "",
          }),
          ...(field.section === undefined ? {} : { section: field.section }),
          ...(field.group === undefined ? {} : { group: field.group }),
          ...(link === undefined ? {} : { link }),
          // FR-012: only a plain value is ever sent back to the page, never a secret.
          ...(field.secret !== true && kept !== undefined ? { value: kept } : {}),
          ...(error === undefined ? {} : { error }),
        };
      };
      const plainStart = Object.fromEntries(fields.filter((field) => field.secret !== true && options.values?.[field.name] !== undefined).map((field) => [field.name, options.values?.[field.name] ?? ""]));
      const question = (kept: Record<string, string> = plainStart, errors: Record<string, string> = {}): NewQuestion => ({
        kind: "form", text: title, ...pageFields(help),
        ...(options.summary === undefined ? {} : { summary: [...options.summary] }),
        ...(help.submitLabel === undefined ? {} : { submitLabel: help.submitLabel }),
        fields: fields.map((field) => toField(field, kept[field.name], errors[field.name])),
      });
      const choiceCheck = (field: FormField): AnswerCheck => (raw) => {
        const value = raw.trim() === "" ? field.defaultValue ?? field.choices?.[0]?.value ?? "" : raw.trim();
        return field.choices?.some((choice) => choice.value === value) === true ? { value } : { error: "choose one of the options" };
      };
      const raw = await hub.ask(question(), (posted) => {
        let parsed: unknown;
        try { parsed = JSON.parse(posted); } catch { return { error: "the form could not be read; try again" }; }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: "the form could not be read; try again" };
        const given = parsed as Record<string, unknown>;
        const values: Record<string, string> = {};
        const errors: Record<string, string> = {};
        for (const field of fields) {
          const value = typeof given[field.name] === "string" ? (given[field.name] as string) : "";
          const check = field.choices !== undefined ? choiceCheck(field)
            : field.secret === true ? secretCheck(field.question, false, field.validate)
              : askCheck({ ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }), ...(field.validate === undefined ? {} : { validate: field.validate }) });
          const result = check(value);
          if ("error" in result) errors[field.name] = result.error;
          else values[field.name] = result.value;
        }
        if (Object.keys(errors).length === 0) Object.assign(errors, options.crossCheck?.(values) ?? {});
        const refused = Object.keys(errors).length;
        if (refused === 0) return { value: JSON.stringify(values) };
        const kept = Object.fromEntries(fields.filter((field) => field.secret !== true && values[field.name] !== undefined).map((field) => [field.name, values[field.name] ?? ""]));
        return { error: refused === 1 ? "Check the field marked below." : `Check the ${refused} fields marked below.`, retry: question(kept, errors) };
      });
      return JSON.parse(raw) as Record<string, string>;
    },
  };
}
