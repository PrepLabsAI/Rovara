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

/**
 * Spec 051 Ruling Y: a check that fails now and that no later report has shown passing. It outlives the report that
 * found it, so a follow-up task that runs no tests (or one that reruns it as already failing) cannot hide it.
 */
export const StandingFailureSchema = z.object({
  label: z.string().min(1).max(8_192),
  source: z.enum(["project", "agent_commands"]),
  class: z.enum(["regression", "already_failing", "failing_no_before"]),
}).strict();
export type StandingFailure = z.infer<typeof StandingFailureSchema>;
export const StandingFailuresSchema = z.array(StandingFailureSchema).max(64);

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

function failsNow(check: CheckEntry): boolean {
  return check.after === "failed" || check.after === "timed_out";
}

function sameCheck(left: { label: string; source: string }, right: { label: string; source: string }): boolean {
  return left.source === right.source && left.label === right.label;
}

/**
 * Ruling Y: the standing failures after a task ends. A report clears each earlier failure it shows passing, and adds
 * every check that fails in it, whatever its class (an earlier regression keeps its class). A marker (no report) keeps
 * the earlier failures exactly.
 */
export function nextStandingFailures(previous: readonly StandingFailure[], latest: LatestChecks): StandingFailure[] {
  if (isMarker(latest)) return [...previous];
  const next = previous.filter((failure) => !latest.checks.some((check) => sameCheck(check, failure) && check.after === "passed"));
  for (const check of latest.checks) {
    if (!failsNow(check)) continue;
    const failureClass = check.class === "regression" || check.class === "already_failing" || check.class === "failing_no_before" ? check.class : "failing_no_before";
    const index = next.findIndex((failure) => sameCheck(check, failure));
    if (index === -1) next.push({ label: check.label, source: check.source, class: failureClass });
    else if (next[index]!.class !== "regression") next[index] = { ...next[index]!, class: failureClass };
  }
  return next.slice(0, 64);
}

/**
 * The checks that still fail as the pull request sees them: the standing failures and any check failing in the latest
 * report, less a project check that publish reran and found passing (publish judges the project's checks itself). A
 * regression is never taken out that way: it stands until a later task's report shows it passing.
 */
export function failingChecks(
  publishChecks: readonly CheckEntry[] | undefined,
  latestChecks: LatestChecks | undefined,
  standingFailures: readonly StandingFailure[] | undefined,
): StandingFailure[] {
  const failures = [...(standingFailures ?? [])];
  for (const check of isMarker(latestChecks) || latestChecks === undefined ? [] : latestChecks.checks) {
    if (failsNow(check) && !failures.some((failure) => sameCheck(failure, check))) {
      failures.push({ label: check.label, source: check.source, class: check.class === "regression" || check.class === "already_failing" ? check.class : "failing_no_before" });
    }
  }
  return failures.filter((failure) => failure.source !== "project" || failure.class === "regression"
    || !(publishChecks ?? []).some((check) => check.label === failure.label && check.after === "passed"));
}

/**
 * A draft when any publish-time check fails (Ruling S: the pull request is the workspace's whole change since
 * preparation), or when a check still fails that an earlier task or the latest one found failing (Ruling Y: whatever
 * its class, because the agent's own commands have no preparation baseline). A latest task that was not verified does
 * not make a draft on its own: it keeps what was known before.
 */
export function checksMakeDraft(
  publishChecks: readonly CheckEntry[] | undefined,
  latestChecks: LatestChecks | undefined,
  standingFailures?: readonly StandingFailure[],
): boolean {
  return (publishChecks ?? []).some((check) => check.after !== "passed")
    || (!isMarker(latestChecks) && latestChecks?.status === "regression")
    || failingChecks(publishChecks, latestChecks, standingFailures).length > 0;
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
  /** Ruling Y: earlier tasks' failures, which have no entry (and no output) of their own. */
  earlier?: readonly StandingFailure[];
}

function groupLines(group: Group): string[] {
  return [
    ...group.checks.map((check) => checkLine(check, group.atPublish)),
    ...(group.earlier ?? []).map((failure) => `- ${inlineCode(failure.label)}: still fails, ${CLASS_TEXT[failure.class]}`),
  ];
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
  standingFailures?: readonly StandingFailure[],
): string {
  const publish = publishChecks ?? [];
  const failing = failingChecks(publish, latestChecks, standingFailures);
  const nothingToSay = latestChecks === undefined || (isMarker(latestChecks) && latestChecks.reason === "no_report");
  if (nothingToSay && failing.length === 0 && publish.every((check) => check.after === "passed")) return "";
  const regressed = publish.some((check) => check.class === "regression")
    || (!isMarker(latestChecks) && latestChecks?.status === "regression")
    || failing.some((failure) => failure.class === "regression");
  const status = regressed
    ? "**This pull request is a draft: a check that passed before this change fails now.**"
    : publish.some((check) => check.after !== "passed")
      ? "**This pull request is a draft: a check fails at publish.**"
      : failing.length > 0
        ? "**This pull request is a draft: a check still fails.**"
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
  // Ruling Y: failures from earlier tasks that the latest report does not show.
  const earlier = failing.filter((failure) => isMarker(latestChecks) || latestChecks === undefined
    || !latestChecks.checks.some((check) => sameCheck(check, failure)));
  if (earlier.length > 0) groups.push({ heading: "Still failing from earlier tasks:", checks: [], earlier, where: "earlier tasks", atPublish: false });
  if (publish.length > 0) groups.push({ heading: "At publish, AgentX reran the project's checks:", checks: publish, where: "at publish", atPublish: true });
  const totalLines = groups.reduce((sum, group) => sum + groupLines(group).length, 0);
  const outputs = groups.flatMap((group) => group.checks
    .filter((check) => check.after === "failed" || check.after === "timed_out")
    .map((check) => outputBlock(check, group.where)));

  const render = (lineLimit: number, outputLimit: number): string => {
    const blocks = ["## Checks", status, ...(latestNote === undefined ? [] : [latestNote])];
    let shown = 0;
    for (const group of groups) {
      const room = Math.max(0, lineLimit - shown);
      const lines = groupLines(group).slice(0, room);
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
