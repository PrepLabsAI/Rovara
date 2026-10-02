// Spec 051 FR-009: AgentX's own verdict leads the Slack reply, and the agent's account follows it.
import type { CheckReport } from "./checks.js";

export const AGENT_ACCOUNT_LABEL = "*Agent's account:*";

function labels(report: CheckReport, checkClass: CheckReport["checks"][number]["class"]): string[] {
  return report.checks.filter((check) => check.class === checkClass).map((check) => check.label);
}

function reportLines(report: CheckReport): string[] {
  const lines: string[] = [];
  if (report.status === "regression") {
    for (const label of labels(report, "regression")) lines.push(`Not done: ${label} passed before and fails now.`);
  } else if (report.status === "verified") {
    // Only checks that passed now count: not already-failing, failing-with-no-earlier-result or not-rerun ones.
    const count = report.checks.filter((check) => check.class === "passing" || check.class === "fixed").length;
    lines.push(report.source === "agent_commands"
      ? `Checks passed (${count} of the agent's own test ${count === 1 ? "command" : "commands"}, rerun by AgentX).`
      : `Checks passed (${count} project ${count === 1 ? "check" : "checks"}).`);
  } else if (report.notVerifiedReason === "no_checks") {
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
 * so an earlier task's stale verdict never leads. The PR itself shows its draft state and checks.
 */
export function checksReplyPrefix(reports: readonly CheckReport[]): string {
  const last = reports.at(-1);
  if (last === undefined) return "";
  return `${reportLines(last).join("\n")}\n\n${AGENT_ACCOUNT_LABEL}\n`;
}
