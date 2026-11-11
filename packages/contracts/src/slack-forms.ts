// Spec 062 Phase 7c3b: Slack modals for the protocol's forms, and back. The Slack adapter opens a form with
// slackModalOf; the Slack-built modals the core's handlers still write are read into the neutral form with
// formOfSlackModal, which renders back to the same modal. A submission's state goes the same two ways.
import type { ChannelForm, ChannelFormFieldKind, ChannelFormOption, ChannelFormPart, ChannelFormValue } from "./channel-forms.js";

type Json = Record<string, unknown>;

const record = (value: unknown): Json | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : undefined);
const only = (object: Json, keys: readonly string[]) => Object.keys(object).every((key) => keys.includes(key));
const textOf = (value: unknown, type: "plain_text" | "mrkdwn"): string | undefined => {
  const object = record(value);
  return object?.type === type && typeof object.text === "string" && only(object, ["type", "text"]) ? object.text : undefined;
};
const plain = (text: string) => ({ type: "plain_text", text });
const mrkdwn = (text: string, literal?: boolean) => ({ type: "mrkdwn", text, ...(literal === true ? { verbatim: true } : {}) });
/** Slack's mrkdwn text, and whether it is verbatim; undefined for anything else. */
const markupOf = (value: unknown): { text: string; literal: boolean } | undefined => {
  const object = record(value);
  if (object?.type !== "mrkdwn" || typeof object.text !== "string" || !only(object, ["type", "text", "verbatim"])) return undefined;
  if (object.verbatim !== undefined && object.verbatim !== true) return undefined;
  return { text: object.text, literal: object.verbatim === true };
};

/** Slack's input element for each field kind. */
const ELEMENT_OF: Readonly<Record<ChannelFormFieldKind, string>> = {
  text: "plain_text_input", multiline: "plain_text_input", select: "static_select", multiselect: "multi_static_select",
  checkboxes: "checkboxes", radio: "radio_buttons", person: "users_select",
};

function slackOption(option: ChannelFormOption): Json {
  return {
    text: option.markup === true ? mrkdwn(option.label) : plain(option.label), value: option.value,
    ...(option.description === undefined ? {} : { description: option.descriptionMarkup === true ? mrkdwn(option.description) : plain(option.description) }),
  };
}

function optionOf(value: unknown): ChannelFormOption | undefined {
  const option = record(value);
  if (option === undefined || !only(option, ["text", "value", "description"]) || typeof option.value !== "string") return undefined;
  const plainLabel = textOf(option.text, "plain_text");
  const markupLabel = plainLabel === undefined ? textOf(option.text, "mrkdwn") : undefined;
  const label = plainLabel ?? markupLabel;
  if (label === undefined) return undefined;
  let description: string | undefined;
  let descriptionMarkup = false;
  if (option.description !== undefined) {
    description = textOf(option.description, "plain_text");
    if (description === undefined) {
      description = textOf(option.description, "mrkdwn");
      descriptionMarkup = true;
    }
    if (description === undefined) return undefined;
  }
  return {
    label, ...(markupLabel === undefined ? {} : { markup: true }), value: option.value,
    ...(description === undefined ? {} : { description, ...(descriptionMarkup ? { descriptionMarkup: true } : {}) }),
  };
}

function slackElement(part: Extract<ChannelFormPart, { type: "field" }>): Json {
  const options = part.options?.map(slackOption);
  const chosen = (values: readonly string[]) => (options ?? []).filter((option) => values.includes(option.value as string));
  const base: Json = { type: ELEMENT_OF[part.kind], action_id: part.inputId };
  switch (part.kind) {
    case "text": case "multiline":
      return { ...base, ...(part.kind === "multiline" ? { multiline: true } : {}), ...(part.initial === undefined ? {} : { initial_value: part.initial }),
        ...(part.maxLength === undefined ? {} : { max_length: part.maxLength }), ...(part.placeholder === undefined ? {} : { placeholder: plain(part.placeholder) }) };
    case "select": case "radio": {
      const initial = part.initial === undefined ? [] : chosen([part.initial]);
      return { ...base, options, ...(initial.length === 0 ? {} : { initial_option: initial[0] }),
        ...(part.placeholder === undefined ? {} : { placeholder: plain(part.placeholder) }) };
    }
    case "multiselect": case "checkboxes": {
      const initial = chosen(part.initialValues ?? []);
      return { ...base, options, ...(initial.length === 0 ? {} : { initial_options: initial }),
        ...(part.placeholder === undefined ? {} : { placeholder: plain(part.placeholder) }) };
    }
    case "person":
      return { ...base, ...(part.initial === undefined ? {} : { initial_user: part.initial }), ...(part.placeholder === undefined ? {} : { placeholder: plain(part.placeholder) }) };
  }
}

function slackBlock(part: ChannelFormPart): Json {
  const id = part.id === undefined ? {} : { block_id: part.id };
  switch (part.type) {
    case "section": return { type: "section", ...id, text: mrkdwn(part.text, part.literal) };
    case "context": return { type: "context", ...id, elements: [mrkdwn(part.text, part.literal)] };
    case "divider": return { type: "divider", ...id };
    case "field":
      return { type: "input", block_id: part.id, label: plain(part.label), ...(part.optional === undefined ? {} : { optional: part.optional }),
        ...(part.hint === undefined ? {} : { hint: plain(part.hint) }), element: slackElement(part) };
  }
}

/** A form as a Slack modal. */
export function slackModalOf(form: ChannelForm): Json {
  return {
    type: "modal", ...(form.formId === undefined ? {} : { callback_id: form.formId }), ...(form.state === undefined ? {} : { private_metadata: form.state }),
    title: plain(form.title), ...(form.submitLabel === undefined ? {} : { submit: plain(form.submitLabel) }),
    ...(form.closeLabel === undefined ? {} : { close: plain(form.closeLabel) }), blocks: form.parts.map(slackBlock),
  };
}

function kindOf(element: Json): ChannelFormFieldKind | undefined {
  switch (element.type) {
    case "plain_text_input": return element.multiline === true ? "multiline" : "text";
    case "static_select": return "select";
    case "multi_static_select": return "multiselect";
    case "checkboxes": return "checkboxes";
    case "radio_buttons": return "radio";
    case "users_select": return "person";
    default: return undefined;
  }
}

const ELEMENT_KEYS = ["type", "action_id", "multiline", "initial_value", "max_length", "placeholder", "options", "initial_option", "initial_options", "initial_user"];

function fieldOf(block: Json): ChannelFormPart | undefined {
  if (!only(block, ["type", "block_id", "label", "optional", "hint", "element"]) || typeof block.block_id !== "string") return undefined;
  if (block.optional !== undefined && typeof block.optional !== "boolean") return undefined;
  const label = textOf(block.label, "plain_text");
  const element = record(block.element);
  if (label === undefined || element === undefined || !only(element, ELEMENT_KEYS) || typeof element.action_id !== "string") return undefined;
  const kind = kindOf(element);
  if (kind === undefined || (element.multiline !== undefined && element.multiline !== true)) return undefined;
  const hint = block.hint === undefined ? undefined : textOf(block.hint, "plain_text");
  if (block.hint !== undefined && hint === undefined) return undefined;
  const placeholder = element.placeholder === undefined ? undefined : textOf(element.placeholder, "plain_text");
  if (element.placeholder !== undefined && placeholder === undefined) return undefined;
  const options = element.options === undefined ? undefined : Array.isArray(element.options) ? element.options.map(optionOf) : [undefined];
  if (options?.some((option) => option === undefined)) return undefined;
  const initialOption = element.initial_option === undefined ? undefined : optionOf(element.initial_option);
  if (element.initial_option !== undefined && initialOption === undefined) return undefined;
  const initialOptions = element.initial_options === undefined ? undefined : Array.isArray(element.initial_options) ? element.initial_options.map(optionOf) : [undefined];
  if (initialOptions?.some((option) => option === undefined)) return undefined;
  if (element.initial_value !== undefined && typeof element.initial_value !== "string") return undefined;
  if (element.initial_user !== undefined && typeof element.initial_user !== "string") return undefined;
  if (element.max_length !== undefined && typeof element.max_length !== "number") return undefined;
  const initial = typeof element.initial_value === "string" ? element.initial_value : typeof element.initial_user === "string" ? element.initial_user : initialOption?.value;
  return {
    type: "field", id: block.block_id, inputId: element.action_id, kind, label,
    ...(typeof block.optional === "boolean" ? { optional: block.optional } : {}), ...(hint === undefined ? {} : { hint }), ...(placeholder === undefined ? {} : { placeholder }),
    ...(initial === undefined ? {} : { initial }),
    ...(initialOptions === undefined ? {} : { initialValues: (initialOptions as ChannelFormOption[]).map((option) => option.value) }),
    ...(typeof element.max_length === "number" ? { maxLength: element.max_length } : {}),
    ...(options === undefined ? {} : { options: options as ChannelFormOption[] }),
  };
}

/** A Slack modal as a form that renders back to the same modal, or undefined for one it cannot read. */
export function formOfSlackModal(view: unknown): ChannelForm | undefined {
  const modal = record(view);
  if (modal === undefined || modal.type !== "modal" || !only(modal, ["type", "callback_id", "private_metadata", "title", "submit", "close", "blocks"])) return undefined;
  const title = textOf(modal.title, "plain_text");
  const submit = modal.submit === undefined ? undefined : textOf(modal.submit, "plain_text");
  const close = modal.close === undefined ? undefined : textOf(modal.close, "plain_text");
  if ((modal.callback_id !== undefined && typeof modal.callback_id !== "string") || title === undefined || (modal.submit !== undefined && submit === undefined) || (modal.close !== undefined && close === undefined)) return undefined;
  if (modal.private_metadata !== undefined && typeof modal.private_metadata !== "string") return undefined;
  const parts: ChannelFormPart[] = [];
  for (const value of Array.isArray(modal.blocks) ? modal.blocks : []) {
    const block = record(value);
    if (block === undefined) return undefined;
    const id = typeof block.block_id === "string" ? { id: block.block_id } : {};
    if (block.type === "section") {
      const text = markupOf(block.text);
      if (text === undefined || !only(block, ["type", "block_id", "text"])) return undefined;
      parts.push({ type: "section", ...id, text: text.text, ...(text.literal ? { literal: true } : {}) });
    } else if (block.type === "context") {
      const elements = Array.isArray(block.elements) ? block.elements : [];
      const text = elements.length === 1 ? markupOf(elements[0]) : undefined;
      if (text === undefined || !only(block, ["type", "block_id", "elements"])) return undefined;
      parts.push({ type: "context", ...id, text: text.text, ...(text.literal ? { literal: true } : {}) });
    } else if (block.type === "divider") {
      if (!only(block, ["type", "block_id"])) return undefined;
      parts.push({ type: "divider", ...id });
    } else if (block.type === "input") {
      const field = fieldOf(block);
      if (field === undefined) return undefined;
      parts.push(field);
    } else {
      return undefined;
    }
  }
  return {
    ...(typeof modal.callback_id === "string" ? { formId: modal.callback_id } : {}), title, ...(submit === undefined ? {} : { submitLabel: submit }), ...(close === undefined ? {} : { closeLabel: close }),
    ...(typeof modal.private_metadata === "string" ? { state: modal.private_metadata } : {}), parts,
  };
}

/** A submitted modal's `state.values` as the form's values, keyed by field and input ID. */
export function formValuesOfSlackState(stateValues: unknown): Record<string, Record<string, ChannelFormValue>> | undefined {
  const blocks = record(stateValues);
  if (blocks === undefined) return undefined;
  const values: Record<string, Record<string, ChannelFormValue>> = {};
  for (const [blockId, inputs] of Object.entries(blocks)) {
    const byInput = record(inputs);
    if (byInput === undefined) return undefined;
    const field: Record<string, ChannelFormValue> = {};
    values[blockId] = field;
    for (const [inputId, raw] of Object.entries(byInput)) {
      const input = record(raw);
      const kind = input === undefined ? undefined : kindOf(input);
      if (input === undefined || kind === undefined) return undefined;
      const options = Array.isArray(input.selected_options) ? input.selected_options.map((option) => record(option)?.value).filter((value): value is string => typeof value === "string") : undefined;
      const selected = record(input.selected_option)?.value;
      const value = typeof input.value === "string" ? input.value : typeof input.selected_user === "string" ? input.selected_user : typeof selected === "string" ? selected : undefined;
      // A text input reads as text whether multiline or not: Slack does not say which in the submitted state.
      field[inputId] = { kind: input.type === "plain_text_input" ? "text" : kind, ...(value === undefined ? {} : { value }), ...(options === undefined ? {} : { values: options }) };
    }
  }
  return values;
}

/** A form's submitted values as a Slack modal's `state.values`, as Slack's own submissions read. */
export function slackStateOfFormValues(values: Record<string, Record<string, ChannelFormValue>>): Json {
  const state: Json = {};
  for (const [blockId, inputs] of Object.entries(values)) {
    const byInput: Json = {};
    for (const [inputId, input] of Object.entries(inputs)) {
      const type = ELEMENT_OF[input.kind];
      if (input.kind === "text" || input.kind === "multiline") byInput[inputId] = { type, value: input.value ?? null };
      else if (input.kind === "person") byInput[inputId] = { type, selected_user: input.value ?? null };
      else if (input.kind === "select" || input.kind === "radio") byInput[inputId] = { type, selected_option: input.value === undefined ? null : { value: input.value } };
      else byInput[inputId] = { type, selected_options: (input.values ?? []).map((value) => ({ value })) };
    }
    state[blockId] = byInput;
  }
  return state;
}
