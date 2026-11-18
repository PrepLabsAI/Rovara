// Lane L4-PRP (design pr-redesign.md 2.6, rule 2.1.7): the verdict the "Rovara" Check carries. The merge core's `SummaryCheckSource.verdict` is a seam; this is the build step's answer to it. It reads the SAME inputs the
// description of the pull request is written from (`descriptionInputsOf`, the changed files the code host gave and `verifyPublishedChanges` kept) and runs the same functions (`workflowPullRequestCheckVerdict`), so the Check's
// title and text say what the description says. It answers only for the code Rovara recorded and checked; for anything else it answers nothing, and the Check is what it was. It never changes a conclusion (the Check's table does).
//
//   - Only this company's task (a task of another company reads as none), a Rovara Code (version 2) workflow with a candidate, and a pull request of that workflow that is open (recorded OPEN, or UNKNOWN as a published one is until a fix push), at the head the Check is being written for and holds the
//     checked candidate. A head Rovara did not check, or a stale one, has no verdict (never words about other code).
//   - The files come from the list the code host gave (`VERIFIED_FILES`), never from the worker. Without it the verdict says the files were not read and the risk is treated as high, exactly as the description does at that point.
//     A kept list at the keep's limit may be cut (the description was made from the whole list), so it gives no verdict rather than different numbers.
//   - A read that fails gives no verdict.
import type { RovaraCheckVerdict } from "@agentx/contracts";
import type { SummaryCheckVerdictInput } from "../merge/summary-check.js";
import { descriptionContextOf, descriptionInputsOf, lessonsUsedOf, verifiedChangedFiles, VERIFIED_FILES_KEPT_MAX } from "./changed-files.js";
import { workflowPullRequestCheckVerdict } from "../proof/workflow-pull-request-body.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { readTask } from "../task-flow/reads.js";

export type PullRequestVerdictSource = (input: SummaryCheckVerdictInput) => Promise<RovaraCheckVerdict | undefined>;

/** The verdict source of the "Rovara" Check, over a company's task flow. */
export function createPullRequestVerdictSource(deps: TaskFlowDeps): PullRequestVerdictSource {
  return async (input) => {
    try {
      if (input.task.orgId !== deps.companyId) return undefined;
      const task = await readTask(deps, input.task.taskId);
      if (task === undefined || task.companyId !== deps.companyId || task.closedAt !== undefined) return undefined;
      const workflow = task.workflow;
      const candidate = workflow?.candidate;
      if (workflow === undefined || workflow.definitionVersion !== "1.1.0" || candidate === undefined) return undefined;
      const entry = (workflow.pullRequests ?? []).find((pullRequest) => pullRequest.repositoryId === input.repositoryId && pullRequest.number === input.number);
      if (entry === undefined || (entry.state !== "OPEN" && entry.state !== "UNKNOWN") || entry.headSha !== input.headSha || entry.candidateDigest !== candidate.digest) return undefined;
      const files = await verifiedChangedFiles(deps, task.workspaceId, candidate.digest);
      if (files !== undefined && files.files.length >= VERIFIED_FILES_KEPT_MAX) return undefined;
      const inputs = await descriptionInputsOf(deps, task, workflow, candidate.digest);
      const lessonsUsed = await lessonsUsedOf(deps, task, input.repositoryId);
      const mergeOrderLines = await deps.mergeOrderLines?.(task, input.repositoryId).catch(() => []) ?? [];
      return workflowPullRequestCheckVerdict(task, workflow, inputs.plan?.text, descriptionContextOf(inputs, { ...(files === undefined ? {} : { changedFiles: files }), mergeOrderLines, lessonsUsed }));
    } catch {
      return undefined;
    }
  };
}
