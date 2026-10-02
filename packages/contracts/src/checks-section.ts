// Spec 051 FR-008 (D-2, D-7): the pull request's checks section, and whether the checks make it a draft. Pure and
// deterministic: the same checks always give the same text, so a retried callback opens the same pull request.
import { z } from "zod";
import { CheckReportSchema, type CheckClass, type CheckEntry, type CheckOutcome, type CheckReport } from "./checks.js";

/** GitHub's limit on a pull request description, in characters. */
export const PULL_REQUEST_BODY_MAX_CHARS = 65_536;
/** A failing check's output, as the section shows it: its last 40 lines, within 4,000 characters. */
const OUTPUT_TAIL_LINES = 40;
const OUTPUT_TAIL_CHARS = 4_000;
/** A label as a line shows it. */
const LABEL_SHOWN_CHARS = 200;
/** All of a stored report's outputs together, so the workspace record stays small. */
const STORED_OUTPUT_TOTAL_CHARS = 48_000;

/**
 * Spec 051 Ruling T: the latest task ended without a check report. `interrupted` is also what a task reads as from its
 * start until its own result arrives, so a task that never reports cannot leave an older report standing.
 */
export const LatestNotVerifiedSchema = z.object({
  status: z.literal("not_verified"),
  reason: z.enum(["failed", "cancelled", "interrupted", "no_report"]),
}).strict();
export type LatestNotVerified = z.infer<typeof LatestNotVerifiedSchema>;

/** What the workspace keeps about its latest task: the report, or why there is none. */
export const LatestChecksSchema = z.union([CheckReportSchema, LatestNotVerifiedSchema]);
export type LatestChecks = z.infer<typeof LatestChecksSchema>;

const NOT_VERIFIED_TEXT: Record<LatestNotVerified["reason"], string> = {
  failed: "the task failed",
  cancelled: "the task was cancelled",
  interrupted: "the task was interrupted",
  no_report: "the worker sent no check report",
};

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

function isMarker(latest: LatestChecks | undefined): latest is LatestNotVerified {
  return latest !== undefined && "reason" in latest;
}

/**
 * A draft when any publish-time check fails (Ruling S: the pull request is the workspace's whole change since
 * preparation), or when the workspace's latest task report is a regression (D-2). A latest task that was not verified
 * does not make a draft on its own; neither does an already-failing check in a task report (FR-008).
 */
export function checksMakeDraft(publishChecks: readonly CheckEntry[] | undefined, latestChecks: LatestChecks | undefined): boolean {
  return (publishChecks ?? []).some((check) => check.after !== "passed") || (!isMarker(latestChecks) && latestChecks?.status === "regression");
}

/** The tail of a check's output that the section shows. The worker and broker cut to it before sending or storing. */
export function checkOutputTail(output: string, maxChars: number = OUTPUT_TAIL_CHARS): string {
  const lines = output.replace(/\s+$/u, "").split("\n").slice(-OUTPUT_TAIL_LINES).join("\n");
  const limit = Math.min(maxChars, OUTPUT_TAIL_CHARS);
  return lines.length <= limit ? lines : lines.slice(lines.length - limit).replace(/^[\uDC00-\uDFFF]/u, "");
}

/** The latest checks as the workspace record stores them: each output cut to the section's tail, 48,000 chars in all. */
export function checksForSection(latest: LatestChecks): LatestChecks {
  if (isMarker(latest) || latest.checks.length === 0) return latest;
  const perCheck = Math.floor(STORED_OUTPUT_TOTAL_CHARS / latest.checks.length);
  return { ...latest, checks: latest.checks.map((check) => ({ ...check, output: checkOutputTail(check.output, perCheck) })) };
}

interface Group {
  heading: string;
  checks: readonly CheckEntry[];
  where: string;
  /** Publish judges against preparation (Ruling S), so its regression says so. */
  atPublish: boolean;
}

/**
 * The `## Checks` section for a pull request's description, or "" when there is nothing to report: no task report (or
 * a worker that sends none), and every publish-time check passed. The description is then exactly as before (Review
 * Focus 5). At most `maxLength` characters: check outputs are left out from the last one first, then check lines, each
 * with a note.
 */
export function checksSection(
  publishChecks: readonly CheckEntry[] | undefined,
  latestChecks: LatestChecks | undefined,
  maxLength: number = PULL_REQUEST_BODY_MAX_CHARS,
): string {
  const publish = publishChecks ?? [];
  const nothingToSay = latestChecks === undefined || (isMarker(latestChecks) && latestChecks.reason === "no_report");
  if (nothingToSay && publish.every((check) => check.after === "passed")) return "";
  const regressed = publish.some((check) => check.class === "regression") || (!isMarker(latestChecks) && latestChecks?.status === "regression");
  const status = regressed
    ? "**This pull request is a draft: a check that passed before this change fails now.**"
    : checksMakeDraft(publish, latestChecks)
      ? "**This pull request is a draft: a check fails at publish.**"
      : "No check that passed before this change fails now.";
  const groups: Group[] = [];
  let latestNote: string | undefined;
  if (isMarker(latestChecks)) {
    latestNote = `After the last task: Not verified (${NOT_VERIFIED_TEXT[latestChecks.reason]}).`;
  } else if (latestChecks !== undefined) {
    if (latestChecks.checks.length > 0) {
      const heading = latestChecks.status === "not_verified"
        ? `After the last task: Not verified. AgentX could not rerun ${sourceText(latestChecks.source)}:`
        : `After the last task, AgentX reran ${sourceText(latestChecks.source)}:`;
      groups.push({ heading, checks: latestChecks.checks, where: "after the last task", atPublish: false });
    } else {
      latestNote = latestChecks.notVerifiedReason === "stopped" || latestChecks.notVerifiedReason === "error"
        ? "After the last task: Not verified (the task stopped before AgentX could check it)."
        : "After the last task: Not verified (no checks ran).";
    }
  }
  if (publish.length > 0) groups.push({ heading: "At publish, AgentX reran the project's checks:", checks: publish, where: "at publish", atPublish: true });
  const totalLines = groups.reduce((sum, group) => sum + group.checks.length, 0);
  const outputs = groups.flatMap((group) => group.checks
    .filter((check) => check.after === "failed" || check.after === "timed_out")
    .map((check) => outputBlock(check, group.where)));

  const render = (lineLimit: number, outputLimit: number): string => {
    const blocks = ["## Checks", status, ...(latestNote === undefined ? [] : [latestNote])];
    let shown = 0;
    for (const group of groups) {
      const room = Math.max(0, lineLimit - shown);
      const lines = group.checks.slice(0, room).map((check) => checkLine(check, group.atPublish));
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

function checkLine(check: CheckEntry, atPublish: boolean): string {
  const classText = atPublish && check.class === "regression" ? "regression (passed at preparation, fails now)" : CLASS_TEXT[check.class];
  return `- ${inlineCode(check.label)}: ${OUTCOME_TEXT[check.before]} → ${OUTCOME_TEXT[check.after]}, ${classText}`;
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
