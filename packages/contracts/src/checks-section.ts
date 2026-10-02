// Spec 051 FR-008 (D-2, D-7): the pull request's checks section, and whether the checks make it a draft. Pure and
// deterministic: the same checks always give the same text, so a retried callback opens the same pull request.
import type { CheckClass, CheckEntry, CheckOutcome, CheckReport } from "./checks.js";

/** GitHub's limit on a pull request description, in characters. */
export const PULL_REQUEST_BODY_MAX_CHARS = 65_536;
/** A failing check's output, as the section shows it: its last 40 lines, within 4,000 characters. */
const OUTPUT_TAIL_LINES = 40;
const OUTPUT_TAIL_CHARS = 4_000;
/** A label as a line shows it. */
const LABEL_SHOWN_CHARS = 200;

const CLASS_TEXT: Record<CheckClass, string> = {
  passing: "passing",
  regression: "regression",
  already_failing: "already failing before this change",
  fixed: "fixed",
  // Ruling C: listed, never a draft.
  failing_no_before: "fails now, with no earlier result",
  not_rerun: "not rerun",
};

const OUTCOME_TEXT: Record<CheckOutcome, string> = {
  passed: "passed",
  failed: "failed",
  timed_out: "timed out",
  unknown: "unknown",
  not_run: "not run",
};

/**
 * A draft when a check that passed before fails now: at publish, or in the workspace's latest task report (D-2). An
 * already-failing check, or one with no earlier result (Ruling C), is not a draft.
 */
export function checksMakeDraft(publishChecks: readonly CheckEntry[] | undefined, latestChecks: CheckReport | undefined): boolean {
  return (publishChecks ?? []).some((check) => check.class === "regression") || latestChecks?.status === "regression";
}

/** The tail of a check's output that the section shows. The worker and broker cut to it before sending or storing. */
export function checkOutputTail(output: string): string {
  const lines = output.replace(/\s+$/u, "").split("\n").slice(-OUTPUT_TAIL_LINES).join("\n");
  return lines.length <= OUTPUT_TAIL_CHARS ? lines : lines.slice(lines.length - OUTPUT_TAIL_CHARS).replace(/^[\uDC00-\uDFFF]/u, "");
}

/** The report with each check's output cut to what the section shows, for storing on the workspace record. */
export function checksForSection(report: CheckReport): CheckReport {
  return { ...report, checks: report.checks.map((check) => ({ ...check, output: checkOutputTail(check.output) })) };
}

interface Group {
  heading: string;
  checks: readonly CheckEntry[];
  where: string;
}

/**
 * The `## Checks` section for a pull request's description, or "" when there is nothing to report: no task report,
 * and every publish-time check passed (Review Focus 5: the description is then exactly as before). At most
 * `maxLength` characters: check outputs are left out from the last one first, then check lines, each with a note.
 */
export function checksSection(
  publishChecks: readonly CheckEntry[] | undefined,
  latestChecks: CheckReport | undefined,
  maxLength: number = PULL_REQUEST_BODY_MAX_CHARS,
): string {
  const publish = publishChecks ?? [];
  if (latestChecks === undefined && publish.every((check) => check.after === "passed")) return "";
  const status = checksMakeDraft(publish, latestChecks)
    ? "**This pull request is a draft: a check that passed before this change fails now.**"
    : "No check that passed before this change fails now.";
  const groups: Group[] = [];
  let latestNote: string | undefined;
  if (latestChecks !== undefined) {
    if (latestChecks.checks.length > 0) {
      groups.push({ heading: `After the last task, AgentX reran ${sourceText(latestChecks.source)}:`, checks: latestChecks.checks, where: "after the last task" });
    } else {
      latestNote = latestChecks.notVerifiedReason === "stopped" || latestChecks.notVerifiedReason === "error"
        ? "After the last task, AgentX could not check the work: the task stopped before AgentX could check it."
        : "After the last task, no checks ran.";
    }
  }
  if (publish.length > 0) groups.push({ heading: "At publish, AgentX reran the project's checks:", checks: publish, where: "at publish" });
  const totalLines = groups.reduce((sum, group) => sum + group.checks.length, 0);
  const outputs = groups.flatMap((group) => group.checks
    .filter((check) => check.after === "failed" || check.after === "timed_out")
    .map((check) => outputBlock(check, group.where)));

  const render = (lineLimit: number, outputLimit: number): string => {
    const blocks = ["## Checks", status, ...(latestNote === undefined ? [] : [latestNote])];
    let shown = 0;
    for (const group of groups) {
      const room = Math.max(0, lineLimit - shown);
      const lines = group.checks.slice(0, room).map(checkLine);
      shown += lines.length;
      if (lines.length > 0) blocks.push([group.heading, ...lines].join("\n"));
    }
    if (shown < totalLines) blocks.push(`_AgentX left out ${countText(totalLines - shown, "more check")} to keep this description within GitHub's limit._`);
    blocks.push(...outputs.slice(0, outputLimit));
    if (outputLimit < outputs.length) blocks.push(`_AgentX left out ${countText(outputs.length - outputLimit, "check output")} to keep this description within GitHub's limit._`);
    return blocks.join("\n\n");
  };

  let outputLimit = outputs.length;
  let lineLimit = totalLines;
  let section = render(lineLimit, outputLimit);
  while (section.length > maxLength && outputLimit > 0) section = render(lineLimit, --outputLimit);
  while (section.length > maxLength && lineLimit > 0) section = render(--lineLimit, outputLimit);
  return section.length <= maxLength ? section : "";
}

function sourceText(source: CheckReport["source"]): string {
  return source === "agent_commands" ? "the agent's own test commands" : "the project's checks";
}

function checkLine(check: CheckEntry): string {
  return `- ${inlineCode(check.label)}: ${OUTCOME_TEXT[check.before]} → ${OUTCOME_TEXT[check.after]}, ${CLASS_TEXT[check.class]}`;
}

function outputBlock(check: CheckEntry, where: string): string {
  const tail = checkOutputTail(check.output);
  const text = tail === "" ? "(no output)" : tail;
  const fence = "`".repeat(Math.max(3, longestRun(text, "`") + 1));
  return `### Output: ${inlineCode(check.label)} (${where})\n\n${fence}text\n${text}\n${fence}`;
}

/** The label as inline code, on one line and at most 200 characters, with a delimiter no backtick in it can close. */
function inlineCode(label: string): string {
  const flat = label.replace(/\s+/gu, " ").trim();
  const shown = flat.length <= LABEL_SHOWN_CHARS ? flat : `${flat.slice(0, LABEL_SHOWN_CHARS - 1).replace(/[\uD800-\uDBFF]$/u, "")}…`;
  const delimiter = "`".repeat(longestRun(shown, "`") + 1);
  const padded = shown.startsWith("`") || shown.endsWith("`") ? ` ${shown} ` : shown;
  return `${delimiter}${padded}${delimiter}`;
}

function longestRun(text: string, character: string): number {
  let longest = 0;
  let current = 0;
  for (const each of text) {
    current = each === character ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

function countText(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
