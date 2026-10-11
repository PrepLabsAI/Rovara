import { z } from "zod";
import { WORKFLOW_PROPOSED_CHECKS_MAX, WorkflowCheckProposalSchema, type WorkflowCheck, type WorkflowCheckProposal } from "./task-workflow.js";
import { WORKFLOW_PROPOSED_CHECK_DEFAULT_TIMEOUT_SECONDS, WorkflowProposedCheckInputSchema as ProposedCheckInputSchema, hasControlCharacter } from "./workflow-check-input.js";

export { WORKFLOW_FEEDBACK_CHECK_COMMAND_MAX, WORKFLOW_PROPOSED_CHECK_DEFAULT_TIMEOUT_SECONDS, WorkflowProposedCheckInputSchema, feedbackReplacementCheckProblem, hasControlCharacter, proposedCheckExecutableAllowed, proposedCheckProblem, type WorkflowProposedCheckInput } from "./workflow-check-input.js";

/** The note shown when a plan's `agentx-checks` block is malformed or over a limit. */
export const WORKFLOW_PROPOSED_CHECKS_UNREADABLE = "AgentX could not read the proposed checks";
const CHECKS_INFO_STRING = "agentx-checks";

/** The most claims one check may name in `proves`; matches the most claims a plan document holds. */
const PROVES_MAX = 50;
const ProvesSchema = z.array(z.string().min(1).max(60)).max(PROVES_MAX);

const ProposedChecksBlockSchema = z.object({
  checks: z.array(ProposedCheckInputSchema).max(WORKFLOW_PROPOSED_CHECKS_MAX),
  none_reason: z.string().trim().max(300).nullable().optional(),
}).strict();

const ProposedChecksWithProvesBlockSchema = z.object({
  checks: z.array(ProposedCheckInputSchema.extend({ proves: ProvesSchema }).strict()).max(WORKFLOW_PROPOSED_CHECKS_MAX),
  none_reason: z.string().trim().max(300).nullable().optional(),
}).strict();

const NOT_CHANGING_REFERENCE = /^nc([1-9][0-9]{0,2})$/;

/** The 1-based position a `proves` entry `nc<N>` names in a plan's Not changing list; undefined for anything else. */
export function notChangingReference(id: string): number | undefined {
  const match = NOT_CHANGING_REFERENCE.exec(id);
  return match === null ? undefined : Number(match[1]);
}

/** True when `id` names one of the first `count` Not changing entries (`nc1` ... `nc<count>`). */
export function isNotChangingReference(id: string, count: number): boolean {
  const position = notChangingReference(id);
  return position !== undefined && position <= count;
}

/**
 * Plain-English problems with line breaks and other control characters in a raw `checks` object (as the planner wrote
 * it), so the worker's format retry can name them. Anything that is not the expected shape is left for the schema.
 */
export function proposedCheckTextIssues(rawChecks: unknown): string[] {
  const list: unknown = typeof rawChecks === "object" && rawChecks !== null ? (rawChecks as { checks?: unknown }).checks : undefined;
  if (!Array.isArray(list)) return [];
  const issues: string[] = [];
  for (const entry of list as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { label, args } = entry as { label?: unknown; args?: unknown };
    // Control characters are shown as spaces: the problem is that they are there, and they would garble the message.
    const shown = typeof label === "string" ? Array.from(label, (char) => (hasControlCharacter(char) ? " " : char)).join("").replace(/\s+/gu, " ").trim().slice(0, 80) : "";
    const name = shown === "" ? "(unnamed)" : shown;
    if (typeof label === "string" && hasControlCharacter(label.trim())) {
      issues.push(`check ${name}: the label may not contain line breaks or control characters`);
    }
    if (Array.isArray(args) && (args as unknown[]).some((arg) => typeof arg === "string" && hasControlCharacter(arg))) {
      issues.push(`check ${name}: arguments may not contain line breaks or control characters; write \\n as a two-character escape inside your script if you need it`);
    }
  }
  return issues;
}

/** The content of the text's last fenced block whose info string is exactly `infoString`; null for an unclosed one. */
export function lastFencedBlock(text: string, infoString: string): string | null | undefined {
  let found: string | null | undefined;
  let open: { info: string; lines: string[] } | undefined;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = line.trimEnd();
    if (open === undefined) {
      if (trimmed.startsWith("```")) open = { info: trimmed.slice(3).trim(), lines: [] };
    } else if (trimmed === "```") {
      if (open.info === infoString) found = open.lines.join("\n");
      open = undefined;
    } else {
      open.lines.push(line);
    }
  }
  if (open?.info === infoString) found = null;
  return found;
}

/** The text with the content of its last fenced block whose info string is `infoString` replaced; unchanged when there is none or it is not closed. */
export function replaceLastFencedBlock(text: string, infoString: string, content: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let open: { info: string; first: number } | undefined;
  let found: { first: number; end: number } | undefined;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trimEnd();
    if (open === undefined) {
      if (trimmed.startsWith("```")) open = { info: trimmed.slice(3).trim(), first: index + 1 };
    } else if (trimmed === "```") {
      if (open.info === infoString) found = { first: open.first, end: index };
      open = undefined;
    }
  }
  if (found === undefined) return text;
  return [...lines.slice(0, found.first), content, ...lines.slice(found.end)].join("\n");
}

function sameCommand(a: WorkflowCheck["command"], b: WorkflowCheck["command"]): boolean {
  return a.cwd === b.cwd && a.executable === b.executable && a.args.length === b.args.length && a.args.every((arg, index) => arg === b.args[index]);
}

/** The most checks one task may run: the worker's readiness list holds at most this many. */
const TASK_CHECKS_MAX = 64;

/** What `extractProposedChecks` reads besides the checks: the registered repositories and the project's own checks. */
export interface ProposedChecksInput {
  repositoryPaths: string[];
  required: WorkflowCheck[];
  optionalCount?: number;
}

/** A plan document's checks also say which claims each one proves; every ID must be one of `claimIds`. */
export interface ProposedChecksWithProvesInput extends ProposedChecksInput {
  allowProves: true;
  claimIds: ReadonlySet<string>;
  /** How many Not changing entries the plan has: `proves` may also hold `nc1` ... `nc<notChangingCount>`. */
  notChangingCount?: number;
}

/**
 * The checks of an already-parsed `agentx-checks` JSON value (or a plan document's `checks` member), read all or nothing:
 * a malformed or over-limit value proposes nothing and carries a note. Each check must run in a registered repository
 * (or a folder inside one). Proposals identical to a required project check or to an earlier proposal are dropped; the
 * rest are `proposed-1`... At most 8, and no more than the 64 checks a task may run leave room for beside the project's
 * required and optional (`optionalCount`) checks. With `allowProves`, each check also names the claims it proves
 * (`proves`: claim IDs, or `nc<N>` for the N-th Not changing entry); the result then maps every proposed ID to those claim IDs, merged when a duplicate proposal was dropped.
 */
export function extractProposedChecks(json: unknown, input: ProposedChecksWithProvesInput): WorkflowCheckProposal & { proves: Record<string, string[]> };
export function extractProposedChecks(json: unknown, input: ProposedChecksInput): WorkflowCheckProposal;
export function extractProposedChecks(json: unknown, input: ProposedChecksInput | ProposedChecksWithProvesInput): WorkflowCheckProposal & { proves?: Record<string, string[]> } {
  const withProves = "allowProves" in input;
  const unreadable = { proposed: [], proposalNote: WORKFLOW_PROPOSED_CHECKS_UNREADABLE, ...(withProves ? { proves: {} } : {}) };
  const parsed = (withProves ? ProposedChecksWithProvesBlockSchema : ProposedChecksBlockSchema).safeParse(json);
  if (!parsed.success) return unreadable;
  const checks: Array<z.infer<typeof ProposedCheckInputSchema> & { proves?: string[] }> = parsed.data.checks;
  const insideRepository = (cwd: string) => input.repositoryPaths.some((path) => cwd === path || cwd.startsWith(`${path}/`));
  if (checks.some((check) => !insideRepository(check.cwd))) return unreadable;
  if (withProves && checks.some((check) => (check.proves ?? []).some((id) => !input.claimIds.has(id) && !isNotChangingReference(id, input.notChangingCount ?? 0)))) return unreadable;
  const entries = checks.map((check) => ({ label: check.label, proves: check.proves ?? [], command: { cwd: check.cwd, executable: check.executable, args: check.args,
    timeoutSeconds: check.timeoutSeconds ?? WORKFLOW_PROPOSED_CHECK_DEFAULT_TIMEOUT_SECONDS } }));
  const kept: typeof entries = [];
  for (const entry of entries) {
    if (input.required.some((required) => sameCommand(required.command, entry.command))) continue;
    const earlier = kept.find((other) => sameCommand(other.command, entry.command));
    if (earlier === undefined) kept.push(entry);
    else earlier.proves = [...new Set([...earlier.proves, ...entry.proves])];
  }
  const proposed = kept.map((check, index) => ({ id: `proposed-${index + 1}`, label: check.label, command: check.command }));
  if (proposed.length > Math.min(WORKFLOW_PROPOSED_CHECKS_MAX, TASK_CHECKS_MAX - input.required.length - (input.optionalCount ?? 0))) return unreadable;
  const noneReason = parsed.data.none_reason ?? "";
  const result = WorkflowCheckProposalSchema.safeParse({ proposed, ...(noneReason === "" ? {} : { noneReason }) });
  if (!result.success) return unreadable;
  return withProves ? { ...result.data, proves: Object.fromEntries(kept.map((check, index) => [`proposed-${index + 1}`, check.proves])) } : result.data;
}

/** The checks a coding plan proposes in its last `agentx-checks` block; no block proposes nothing, an unclosed or malformed one is unreadable. */
export function parseProposedChecks(plan: string, input: ProposedChecksInput): WorkflowCheckProposal {
  const block = lastFencedBlock(plan, CHECKS_INFO_STRING);
  if (block === undefined) return { proposed: [] };
  if (block === null) return { proposed: [], proposalNote: WORKFLOW_PROPOSED_CHECKS_UNREADABLE };
  let json: unknown;
  try {
    json = JSON.parse(block);
  } catch {
    return { proposed: [], proposalNote: WORKFLOW_PROPOSED_CHECKS_UNREADABLE };
  }
  return extractProposedChecks(json, input);
}
