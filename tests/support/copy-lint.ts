// Spec 048 FR-081: words that must never reach the install page. Each rule names where its words
// are allowed: technical details, the Stop for now screen, the lost connection notice and the
// ready screen (where a command with a copy button is the point).
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

/** The string literals in a piece of source: what the page's HTML and module can put on screen. */
export function quotedStrings(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    found.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return found;
}
