// Spec 048 FR-081: words that must never reach the install page. Each rule names where its words
// are allowed: technical details, the Stop for now screen, the lost connection notice and the
// ready screen (where a command with a copy button is the point).
import type { WizardState } from "../../packages/cli/src/init/ui/protocol.js";

export type CopyContext = "page" | "details" | "stop-for-now" | "lost-connection" | "ready";
export interface CopyEntry { where: string; text: string; context: CopyContext; failedRun?: boolean }
export interface CopyRule { id: string; pattern: RegExp; allowedIn: readonly CopyContext[]; onlyOnFailedRun?: boolean }

const COMMAND_PLACES: readonly CopyContext[] = ["details", "stop-for-now", "lost-connection", "ready"];

export const COPY_RULES: readonly CopyRule[] = [
  { id: "phase-or-spec-number", pattern: /\b(?:phase|spec)\s+\d+[a-z]?\d*\b|\b(?:FR|SC)-\d{3}\b/i, allowedIn: [] },
  { id: "dotted-config-key", pattern: /\b(?:slack|alerts|models|budget|github|identity|images)\.(?:[a-z]+[A-Z][A-Za-z]*|address|scope|kind|orchestrator|classifier|worker)\b/, allowedIn: ["details"] },
  { id: "cloudformation-type", pattern: /\bAWS::[A-Za-z0-9]+::[A-Za-z0-9]+/, allowedIn: ["details"] },
  { id: "cloudformation-logical-id", pattern: /\b[A-Z][a-z]+(?:[A-Z][a-z]+)*[0-9A-F]{8}\b/, allowedIn: ["details"] },
  { id: "raw-slack-markup", pattern: /<[@#!][A-Z0-9]/, allowedIn: [] },
  { id: "raw-slack-id", pattern: /\b[UWTBCGA](?=[A-Z0-9]*\d)[A-Z0-9]{4,}\b/, allowedIn: ["details"] },
  { id: "aws-arn", pattern: /\barn:aws[a-z-]*:/, allowedIn: ["details"] },
  { id: "enter-for", pattern: /\bEnter for\b/, allowedIn: [] },
  { id: "empty-leave-empty-for", pattern: /\bLeave empty for\s*(?:$|[.,;:)])/, allowedIn: [] },
  { id: "error-code", pattern: /\b[A-Z]{2,}_[A-Z_]{2,}\b/, allowedIn: ["details"] },
  { id: "finished-on-failed-run", pattern: /\bFinished\b/, allowedIn: [], onlyOnFailedRun: true },
  { id: "day-two-without-env", pattern: /\bagentx\s+(?!--env\s)(?:doctor|destroy|connector|project|channel|alerts|config|upgrade|deploy|signin|env)\b/, allowedIn: [] },
  { id: "unpublished-package", pattern: /@charterarc\/agentx(?!@\d)/, allowedIn: [] },
  {
    id: "terminal-instruction",
    pattern: /(?:^|[\s(])--[a-z][a-z0-9-]*|\b(?:run|type|pass)\s+(?:agentx|npx|aws|node|cdk)\b|\b(?:in|read|check|see) the terminal\b|\bthe terminal (?:running|shows|says)\b/i,
    allowedIn: COMMAND_PLACES,
  },
];

/** Every rule a text breaks, as "<rule> in <where>: "<match>" in "<text>"". Empty means clean. */
export function lintCopy(entries: readonly CopyEntry[]): string[] {
  const found: string[] = [];
  for (const entry of entries) {
    for (const rule of COPY_RULES) {
      if (rule.allowedIn.includes(entry.context)) continue;
      if (rule.onlyOnFailedRun === true && entry.failedRun !== true) continue;
      const match = rule.pattern.exec(entry.text);
      if (match !== null) found.push(`${rule.id} in ${entry.where}: "${match[0]}" in "${entry.text}"`);
    }
  }
  return found;
}

/** Every word a state puts on the page, with where it may say what (FR-081). The question's own
 * terminal text is left out when the page shows its label instead. */
export function stateEntries(state: WizardState, where: string): CopyEntry[] {
  const failedRun = state.phase === "failed";
  const at = (text: string, part: string, context: CopyContext = "page"): CopyEntry => ({ where: `${where}: ${part}`, text, context, failedRun });
  const entries: CopyEntry[] = [at(state.pageTitle, "tab title"), at(state.journey.timeLeftText, "time left")];
  for (const phase of state.journey.phases) entries.push(at(phase.title, "rail"), at(phase.statusWord, "rail"), at(phase.timeText, "rail"));
  for (const step of state.steps) {
    entries.push(at(step.title, "step"), at(step.usualText, "step"));
    // review fix round 1: a waiting step's message is terminal-only text (FR-072; slack-app.ts,
    // finish-steps.ts say "run agentx init --env ... again"); the page never renders it
    // (page.ts's renderRail reads only title/status/startedAt/usualSeconds/usualText/tookSeconds),
    // so it is linted as technical detail, not page copy.
    if (step.message !== undefined) entries.push(at(step.message, "step message", "details"));
  }
  for (const line of state.welcome ?? []) entries.push(at(line, "welcome"));
  if (state.resume !== undefined) entries.push(...state.resume.completed.map((title) => at(title, "resume")), ...(state.resume.continueFrom === undefined ? [] : [at(state.resume.continueFrom, "resume")]));
  const question = state.question;
  if (question !== undefined) {
    entries.push(at(question.label ?? question.text, "question"));
    for (const text of [question.why, question.example, question.hint, question.error]) if (text !== undefined) entries.push(at(text, "question help"));
    for (const choice of question.choices ?? []) entries.push(at(choice.label, "choice"));
    for (const button of question.buttons ?? []) entries.push(at(button.label, "button"));
    for (const field of question.fields ?? []) for (const text of [field.label, field.why, field.example, field.hint, field.error]) if (text !== undefined) entries.push(at(text, "form field"));
  }
  for (const card of state.cards ?? []) {
    const context: CopyContext = card.id === "ready" ? "ready" : "page";
    entries.push(at(card.title, `${card.id} card`, context), ...card.lines.map((line) => at(line, `${card.id} card`, context)));
    for (const check of card.checks ?? []) entries.push(at(check.label, `${card.id} check`), at(check.detail, `${card.id} check`));
    if (card.link !== undefined) entries.push(at(card.link.label, `${card.id} link`), ...(card.link.note === undefined ? [] : [at(card.link.note, `${card.id} link`)]));
    for (const command of card.commands ?? []) entries.push(at(command.label, `${card.id} command`, context), at(command.command, `${card.id} command`, context));
    for (const line of card.details ?? []) entries.push(at(line, `${card.id} details`, "details"));
  }
  if (state.link !== undefined) entries.push(at(state.link.label, "run link"), ...(state.link.note === undefined ? [] : [at(state.link.note, "run link")]));
  if (state.failure !== undefined) {
    entries.push(at(state.failure.title, "failure"), at(state.failure.what, "failure"), at(state.failure.next, "failure"));
    entries.push(...state.failure.details.map((line) => at(line, "failure details", "details")));
    if (state.failure.link !== undefined) entries.push(at(state.failure.link.label, "failure details", "details"));
  }
  if (state.outcome !== undefined) entries.push(at(state.outcome, "outcome"));
  for (const command of state.commands ?? []) entries.push(at(command.label, "stop for now", "stop-for-now"), at(command.command, "stop for now", "stop-for-now"));
  if (state.plan !== undefined) for (const line of state.plan.split("\n")) if (line.trim() !== "") entries.push(at(line, "plan"));
  return entries;
}

/** The string literals in a piece of source: what the page's HTML and module can put on screen. */
export function quotedStrings(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    found.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return found;
}
