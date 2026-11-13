// Issue #438: what a finished turn in an adapter's conversation did, as typed events: a `pr` event for each pull
// request it opened or changed, a `check_report` for each worker task's checks and for each publication's checks on
// the commit it pushed, and the `done` event's outcome. An adapter can act on these without parsing display text.
import { checksReplyPrefix, type ChannelEvent, type TurnDisposition } from "@rovara-code/contracts";
import type { TurnPullRequest } from "@agentx/orchestrator";
import type { FinishedTurn } from "./processor.js";

type EventData<T extends ChannelEvent["type"]> = Extract<ChannelEvent, { type: T }>["data"];

const CHECK_STATUS = { verified: "passed", regression: "failed", not_verified: "unknown" } as const;
const TEXT_MAX = 4_000;

/** The pull requests a turn opened or changed, as `pr` events, in the order they happened. */
export function pullRequestEvents(pullRequests: readonly TurnPullRequest[]): Array<EventData<"pr">> {
  return pullRequests.map((pr) => ({
    url: pr.url, title: pr.title ?? `${pr.repository}#${pr.number}`,
    ...(pr.taskId === undefined ? {} : { taskId: pr.taskId }),
    repository: pr.repository, number: pr.number, headSha: pr.headSha, baseBranch: pr.baseBranch,
    ...(pr.draft === undefined ? {} : { draft: pr.draft }),
    action: pr.action,
  }));
}

/**
 * The check reports of a turn: each worker task's, then each publication's that ran checks, naming the commit it
 * checked, which is the pull request's head (`pr.headSha`) for the same task.
 */
export function checkReportEvents(turn: Pick<FinishedTurn<unknown>, "recorder">): Array<EventData<"check_report">> {
  const tasks = turn.recorder.taskCheckReports().map(({ taskId, report }) => ({
    text: (checksReplyPrefix([report]).trim() || "The checks finished.").slice(0, TEXT_MAX),
    status: CHECK_STATUS[report.status],
    ...(taskId === undefined ? {} : { taskId }),
    checks: report.checks.slice(0, 64).map((check) => ({ name: check.label.slice(0, 200), status: check.after })),
  }));
  const publications = turn.recorder.pullRequests().filter((pr) => pr.checks.length > 0).map((pr) => {
    const passed = pr.checks.filter((check) => check.status === "passed").length;
    return {
      text: `Checks on ${pr.repository}#${pr.number} at ${pr.headSha.slice(0, 7)}: ${passed} of ${pr.checks.length} passed.`,
      status: passed === pr.checks.length ? "passed" as const : "failed" as const,
      ...(pr.taskId === undefined ? {} : { taskId: pr.taskId }),
      commits: [{ repository: pr.repository, sha: pr.headSha }],
      checks: pr.checks,
    };
  });
  return [...tasks, ...publications];
}

/** How each disposition ends a request; undefined is a success, which is `no_change` when nothing ran. */
const ENDED: Partial<Record<TurnDisposition, { outcome: "failed" | "cancelled"; code?: string }>> = {
  failed: { outcome: "failed", code: "request_failed" },
  abandoned: { outcome: "cancelled" },
  confirmation_cancelled: { outcome: "cancelled" },
  confirmation_refused: { outcome: "failed", code: "confirmation_refused" },
  workspace_limit: { outcome: "failed", code: "workspace_limit" },
  workspace_closed: { outcome: "failed", code: "workspace_closed" },
  workspace_unavailable: { outcome: "failed", code: "workspace_unavailable" },
};

/** The `done` event's typed fields: how the request ended, the last task it ran, and why it failed. */
export function doneFields(turn: Pick<FinishedTurn<unknown>, "draft" | "recorder">): Pick<EventData<"done">, "outcome" | "taskId" | "code"> {
  const operations = turn.recorder.observation().workerOperations;
  const taskId = operations.at(-1);
  const ended = ENDED[turn.draft.disposition];
  const failureCode = turn.draft.error?.code?.toLowerCase();
  const code = ended?.outcome === "failed" && failureCode !== undefined && /^[a-z][a-z0-9_]{0,63}$/.test(failureCode) ? failureCode : ended?.code;
  return {
    outcome: ended?.outcome ?? (operations.length === 0 ? "no_change" : "succeeded"),
    ...(taskId === undefined ? {} : { taskId }),
    ...(code === undefined ? {} : { code }),
  };
}
