// Spec 051 FR-009: AgentX's own verdict leads the Slack reply, and the agent's account follows it.
import { EVIDENCE_TRUST_CLASS_WORDS } from "./check-kinds.js";
import { TEST_RESULT_WORDS, checkResultNote } from "./check-result-notes.js";
import type { CheckReport } from "./checks.js";

export const AGENT_ACCOUNT_LABEL = "*Agent's account:*";
/** Ruling Z: the line a turn adds when the pull request it opened is a draft, whatever the turn's own reports said. */
export const DRAFT_PULL_REQUEST_LINE = "Opened as a draft: AgentX's checks found failures.";

function labels(report: CheckReport, checkClass: CheckReport["checks"][number]["class"]): string[] {
  return report.checks.filter((check) => check.class === checkClass).map((check) => check.label);
}

const passesNow = (check: CheckReport["checks"][number]): boolean => check.class === "passing" || check.class === "fixed";

/**
 * TEST-RESULT-HONESTY: a line for each check that tested nothing (every test skipped) when others did test (when none did, the verdict says so once), and for each failure that looks like a missing service
 * (a hint: "looks like", never a fact).
 */
function testResultLines(report: CheckReport): string[] {
  const noted = report.checks.map((check) => ({ check, note: checkResultNote(check) }));
  const othersRan = noted.some(({ check, note }) => passesNow(check) && note.skipped?.all !== true);
  return noted.flatMap(({ check, note }) => {
    if (report.status === "verified" && othersRan && passesNow(check) && note.skipped?.all === true) return [`${TEST_RESULT_WORDS.allSkipped}: ${check.label}.`];
    return note.needs.length === 0 ? [] : [`${check.label}: ${TEST_RESULT_WORDS.needsShort(note.needs)}.`];
  });
}

function reportLines(report: CheckReport): string[] {
  const lines: string[] = [];
  if (report.status === "regression") {
    for (const label of labels(report, "regression")) lines.push(`Not done: ${label} passed before and fails now.`);
  } else if (report.status === "verified") {
    // Only checks that passed now count: not already-failing, failing-with-no-earlier-result or not-rerun ones.
    const rerun = report.checks.filter((check) => check.class !== "not_rerun").length;
    const passing = report.checks.filter(passesNow);
    const count = passing.length;
    // A check whose output says every test was skipped tested nothing: it is not a pass, and tests skipped in the others are said (TEST-RESULT-HONESTY).
    const skips = passing.map((check) => checkResultNote(check).skipped);
    const untested = skips.filter((skip) => skip?.all === true).length;
    const skipped = skips.reduce((sum, skip) => sum + (skip?.all === true ? 0 : skip?.skipped ?? 0), 0);
    const ran = count - untested;
    // General fakes (DEC 234): checks a Rovara-made fake answered are counted apart, in fixed words, never as plain passes.
    const made = report.checks.filter((check) => check.madeByRovara === true && (check.class === "passing" || check.class === "fixed")).length;
    const madeWords = made === 0 ? "" : `; ${made} ${EVIDENCE_TRUST_CLASS_WORDS.made_by_rovara}, never change proof`;
    const what = report.source === "agent_commands" ? `${count} of the agent's own test commands, rerun by AgentX${madeWords}` : `${count} project ${count === 1 ? "check" : "checks"}${madeWords}`;
    // With nothing passing (only checks that fail with no earlier result), "Checks passed" would mislead.
    if (count === 0) lines.push("No regression found, but no check passes yet.");
    else if (ran === 0) lines.push(`${TEST_RESULT_WORDS.allSkipped} (${what}).`);
    // Ruling Z (I-2): a success headline only when every rerun check passes now.
    else if (ran < rerun) lines.push(`Checks: ${ran} of ${rerun} pass${made === 0 ? "" : ` (${made} ${EVIDENCE_TRUST_CLASS_WORDS.made_by_rovara}, never change proof)`}${skipped === 0 ? "" : `; ${TEST_RESULT_WORDS.skipped(skipped)}`}.`);
    else lines.push(skipped === 0 ? `Checks passed (${what}).` : `${TEST_RESULT_WORDS.passedWithSkips(skipped)} (${what}).`);
  } else if (report.notVerifiedReason === "no_checks" && report.source === "none") {
    // Only a project with no checks at all gets this advice; a round that could not rerun its checks is "stopped".
    lines.push("Not verified: no checks ran. Add readiness checks to the project so AgentX can check the agent's work.");
  } else {
    lines.push("Not verified: the task stopped before AgentX could check it.");
  }
  for (const label of labels(report, "already_failing")) lines.push(`Already failing before this change: ${label}.`);
  for (const label of labels(report, "failing_no_before")) lines.push(`Fails now, with no earlier result: ${label}.`);
  lines.push(...testResultLines(report));
  return lines;
}

/**
 * The reply's leading verdict, ending with the label for the agent's own account, or "" when the turn has
 * no report so the reply stays exactly as it was (Review Focus 5). Only the turn's last report is used,
 * so an earlier task's stale verdict never leads. A turn whose pull request opened as a draft (Ruling Z) says so, even
 * when it ran no task: the pull request itself shows its checks.
 */
export function checksReplyPrefix(reports: readonly CheckReport[], options: { draftPullRequest?: boolean } = {}): string {
  const last = reports.at(-1);
  const lines = [...(last === undefined ? [] : reportLines(last)), ...(options.draftPullRequest === true ? [DRAFT_PULL_REQUEST_LINE] : [])];
  if (lines.length === 0) return "";
  return `${lines.join("\n")}\n\n${AGENT_ACCOUNT_LABEL}\n`;
}
