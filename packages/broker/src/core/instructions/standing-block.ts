// Standing instructions: builds the ONE text a step carries in its system prompt. Pure: the dispatch reads the company rules, the recipe's layers and the switch, and passes them in.
// Order, top to bottom: the precedence wording, company rules (Required, then Preferred), the project's "How we work" (the whole process's layers, then the step's), per-task extras (empty for now),
// then a closing line. Rovara's own prompt, preamble and in-message rules always win; the repository's files, skills and lessons rank below the block.
// Text written by members (layers, extras, agent names) is made inert, escaped and quoted line by line, so it cannot forge a section, the header or the closing line, or close Pi's <addendum> tag.
import { createHash } from "node:crypto";
import { STANDING_INSTRUCTIONS_WORDING, redactText, type CompanyInstructionsSnapshot, type CompanyRule, type StandingInstructionsPayload } from "@agentx/contracts";
import { inertRuleText } from "../playbook/inert-rule-text.js";

const { header, company: companyTitle, required: requiredTitle, preferred: preferredTitle, checking, howWeWork: howWeWorkTitle, extras: extrasTitle, closingStart, closingEnd } = STANDING_INSTRUCTIONS_WORDING;

/** One piece of project-written or task-written text, under the name of the agent or person who wrote it (an empty name prints the text alone). */
export interface StandingLayer { agentName: string; text: string }

export interface StandingInstructionsInput {
  /** The company's rules, already checked against the size limits (`readCompanyInstructions`). */
  company?: CompanyInstructionsSnapshot | undefined;
  /** The project's "How we work": the whole process's layers, then the step's, already filtered for the step (`wholeAgentLayers`, `stepInstructionLayers`). */
  howWeWork?: readonly StandingLayer[] | undefined;
  /** Per-task extras (nothing passes it yet). */
  extras?: readonly StandingLayer[] | undefined;
  /** The stage checks work (plan check, review, second review, feedback review): the company section also tells it to judge the change against the rules. */
  checking?: boolean | undefined;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** One line of inert text: hidden characters out, every run of white space (line and paragraph separators included) one space. The size limits are counted on this text. */
export const foldedRuleText = (text: string): string => inertRuleText(text).replace(/\s+/g, " ").trim();

/** `foldedRuleText` with angle brackets escaped, for the prompt. */
export const oneLineOf = (text: string): string => foldedRuleText(text).replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Layer text, inert and quoted: every line starts with "> ", so no line of it can read as a section title, a number, the header or the closing line; angle brackets are escaped. */
const quoted = (text: string): string =>
  redactText(inertRuleText(text)).replace(/</g, "&lt;").replace(/>/g, "&gt;").split(/\n|\u2028|\u2029/u).map((line) => (line === "" ? ">" : `> ${line}`)).join("\n");

/** A company rule as one bullet: inert, secrets redacted (checked again at render, not only at save), folded to one line so a rule cannot start a section of its own. */
const bulletOf = (rule: CompanyRule): string => `- ${redactText(oneLineOf(rule.text))}`;

function companySection(company: CompanyInstructionsSnapshot, isChecking: boolean): string {
  const group = (priority: CompanyRule["priority"], title: string): string[] => {
    const rules = company.rules.filter((rule) => rule.priority === priority);
    return rules.length === 0 ? [] : [title, ...rules.map(bulletOf)];
  };
  return [companyTitle, ...group("required", requiredTitle), ...group("preferred", preferredTitle), ...(isChecking ? [checking] : [])].join("\n");
}

function layersSection(title: string, layers: readonly StandingLayer[]): string | undefined {
  const present = layers.filter((layer) => inertRuleText(layer.text).length > 0);
  if (present.length === 0) return undefined;
  return [title, ...present.map((layer) => {
    const name = oneLineOf(layer.agentName);
    return name === "" ? quoted(layer.text) : `From ${name}:\n${quoted(layer.text)}`;
  })].join("\n\n");
}

const numbered = (sections: ReadonlyArray<string | undefined>): string =>
  sections.filter((section): section is string => section !== undefined).map((section, index) => `${String(index + 1)}. ${section}`).join("\n\n");

/** The block's text with its closing line. The code in the closing line is taken from a hash of everything above it, which text inside the block cannot know. */
function closed(body: string): string {
  return `${body}\n\n${closingStart} ${sha256(body).slice(0, 12)}. ${closingEnd}`;
}

/**
 * The block for one step, or `undefined` when there is nothing to say (no company rules, no layers, no extras): then the step's prompt is exactly what it was before. The sections that are present are
 * numbered in order of authority. `company` is the company part alone, which a stage that may not see the project's layers (the second reviewer shown only the change) still gets.
 */
export function buildStandingInstructions(input: StandingInstructionsInput): StandingInstructionsPayload | undefined {
  const company = input.company === undefined || input.company.rules.length === 0 ? undefined : input.company;
  const companyText = company === undefined ? undefined : companySection(company, input.checking === true);
  const howWeWork = layersSection(howWeWorkTitle, input.howWeWork ?? []);
  const extras = layersSection(extrasTitle, input.extras ?? []);
  if (companyText === undefined && howWeWork === undefined && extras === undefined) return undefined;
  const text = closed(`${header}\n\n${numbered([companyText, howWeWork, extras])}`);
  return {
    text,
    digest: sha256(text),
    ...(company === undefined ? {} : { company: { version: company.version, text: closed(`${header}\n\n${numbered([companyText])}`) } }),
  };
}
