// Spec 051 FR-009: AgentX's own verdict leads the Slack reply, and the agent's account follows it.
import type { CheckReport } from "./checks.js";

export const AGENT_ACCOUNT_LABEL = "*Agent's account:*";
/** Ruling Z: the line a turn adds when the pull request it opened is a draft, whatever the turn's own reports said. */
export const DRAFT_PULL_REQUEST_LINE = "Opened as a draft: AgentX's checks found failures.";

function labels(report: CheckReport, checkClass: CheckReport["checks"][number]["class"]): string[] {
  return report.checks.filter((check) => check.class === checkClass).map((check) => check.label);
}

function reportLines(report: CheckReport): string[] {
  const lines: string[] = [];
  if (report.status === "regression") {
    for (const label of labels(report, "regression")) lines.push(`Not done: ${label} passed before and fails now.`);
  } else if (report.status === "verified") {
    // Only checks that passed now count: not already-failing, failing-with-no-earlier-result or not-rerun ones.
    const rerun = report.checks.filter((check) => check.class !== "not_rerun").length;
    const count = report.checks.filter((check) => check.class === "passing" || check.class === "fixed").length;
    // With nothing passing (only checks that fail with no earlier result), "Checks passed" would mislead.
    if (count === 0) lines.push("No regression found, but no check passes yet.");
    // Ruling Z (I-2): a success headline only when every rerun check passes now.
    else if (count < rerun) lines.push(`Checks: ${count} of ${rerun} pass.`);
    else lines.push(report.source === "agent_commands"
      ? `Checks passed (${count} of the agent's own test commands, rerun by AgentX).`
      : `Checks passed (${count} project ${count === 1 ? "check" : "checks"}).`);
  } else if (report.notVerifiedReason === "no_checks" && report.source === "none") {
    // Only a project with no checks at all gets this advice; a round that could not rerun its checks is "stopped".
    lines.push("Not verified: no checks ran. Add readiness checks to the project so AgentX can check the agent's work.");
  } else {
    lines.push("Not verified: the task stopped before AgentX could check it.");
  }
  for (const label of labels(report, "already_failing")) lines.push(`Already failing before this change: ${label}.`);
  for (const label of labels(report, "failing_no_before")) lines.push(`Fails now, with no earlier result: ${label}.`);
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
