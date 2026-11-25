// RD-2b2: `GET /v1/dev/tasks/{taskId}/changes`, the task page's Changes tab in one answer (the view is core/task-view/changes.ts; the response schema is `TaskChangesReadSchema` in packages/code-api).
//
// WHO MAY READ: exactly the task read's own rule, first and before anything else is read: `loadReadableTask` (the company, then the company's `canRead`; a shared reader is admitted only when the one "may read this task" function says so, never by a rule of this file). Anyone else, another company's caller and a missing task all get the same TASK_NOT_FOUND answer. This read is NOT part of F2-E's reduced admin view: a
// company admin who is not a reader gets the missing task's answer too (the rule has no admin branch). A script token never reaches here (dev-routes refuses it first).
//
// WHERE THE PULL REQUEST'S FILES COME FROM: the deployment's own diff route, asked through `taskRules.route` (the same rule, the same code-host reader, the same patch limit as `GET .../diff`), page by page. This file never imports
// developer/task-code-routes.ts or aws/task-web.ts (the old Code task page's files go away with it). A failed page is an unlisted page, never an error and never a message: the answer says it is not checked, or lists less.
import { z } from "zod";
import type { PlanDocument } from "@agentx/contracts";
import { readTaskPlanDocument } from "../aws/task-plan-document.js";
import { reportedChangedFiles, verifiedChangedFiles } from "../core/build-step/changed-files.js";
import { textReaderOf } from "../core/build-step/plan-input.js";
import { loadReadableTask } from "../core/task-flow/reads.js";
import type { TaskRecord } from "../core/task-flow/records.js";
import { taskChangesOf, type PullRequestPage } from "../core/task-view/changes.js";
import type { BrokerResponse } from "../handler.js";
import { createPageCache, type PageCache } from "./task-changes-cache.js";
import type { TaskScreenContext } from "./task-screen-routes.js";

/** What the diff route says in place of a patch it will not show whole (developer/task-code-routes.ts `DIFF_PATCH_TOO_LONG`; a test pins that the two are the same words). */
export const DIFF_ROUTE_PATCH_TOO_LONG = "This file's changes are too long to show here. Open the pull request to read them.";

/** One page of the diff route's answer, read for what this tab needs; anything else in it is ignored. */
const DiffAnswerSchema = z.object({
  files: z.array(z.object({ path: z.string().min(1).max(1_000), additions: z.number(), deletions: z.number(), patch: z.string().max(200_000).optional() })).max(100),
  more: z.boolean(),
});

/** The task, if this caller may read it by the task read's own rule (`loadReadableTask`); otherwise TASK_NOT_FOUND (the same for a missing task and another company's). No rule of this file's own: a shared reader is admitted by the one "may read this task" function when it exists. */
const readableTask = (context: TaskScreenContext): Promise<TaskRecord> => loadReadableTask(context.flow.deps, context.caller, context.taskId);

/**
 * THE ONE ACCESS DECISION FOR SOURCE CODE: may this reader see the repository's own content (the pull request's diff and its patches)? Today every reader of the task may (the rule that admitted them is the task read's). The
 * lane that makes the "may read this task" function (RD-2.0-READ-RULE) sets this per mode: for the changes read, source code follows the REPOSITORY's access, and a shared reader may not be a member of the repository. Nothing else in
 * this file decides it; the page reader below is only built when this says yes, and the rest of the answer (the kept lists, the why) carries no diff content.
 */
export function mayReadSourceCode(): boolean {
  return true;
}

/** Pages are kept for a short while (45 s) so a reload does not ask the code host again; see task-changes-cache.ts. */
const PAGES = createPageCache({ ttlMs: 45_000, max: 30 });

/** One page of one pull request's files through the deployment's diff route; `undefined` when it cannot be read (not wired, refused, the code host down, an answer of another shape). */
function pageReader(context: TaskScreenContext, task: TaskRecord, cache: PageCache): ((pullRequest: { repository: string; number: number }, page: number) => Promise<PullRequestPage | undefined>) | undefined {
  const { taskRules, caller, flow } = context;
  if (taskRules === undefined) return undefined;
  const headOf = (pullRequest: { repository: string; number: number }): string => {
    const recorded = task.workflow?.pullRequests?.find((entry) => entry.repositoryId === pullRequest.repository && entry.number === pullRequest.number);
    return recorded?.headSha ?? recorded?.candidateDigest ?? "";
  };
  const fetchPage = async (pullRequest: { repository: string; number: number }, page: number): Promise<PullRequestPage | undefined> => {
    const path = `/v1/dev/tasks/${task.taskId}/diff`;
    const query = `repository=${encodeURIComponent(pullRequest.repository)}&number=${pullRequest.number}&page=${page}`;
    try {
      const answer = await taskRules.route({
        request: { method: "GET", path: `${path}?${query}`, headers: {} }, path,
        person: { developerId: caller.principal.personId, name: caller.principal.displayName }, companyId: flow.deps.companyId,
        task: task, store: flow.deps.store,
      });
      if (answer.statusCode !== 200) return undefined;
      const parsed = DiffAnswerSchema.safeParse(JSON.parse(answer.body));
      if (!parsed.success) return undefined;
      return {
        more: parsed.data.more,
        files: parsed.data.files.map((file) => ({
          path: file.path, additions: file.additions, deletions: file.deletions,
          ...(file.patch === DIFF_ROUTE_PATCH_TOO_LONG ? { tooLong: true } : file.patch === undefined || file.patch === "" ? {} : { patch: file.patch }),
        })),
      };
    } catch {
      return undefined;
    }
  };
  return (pullRequest, page) => cache.once(`${flow.deps.companyId}|${task.taskId}|${pullRequest.repository}#${pullRequest.number}@${headOf(pullRequest)}|${page}`, () => fetchPage(pullRequest, page));
}

/** The task's current plan, for the "why"; a plan that is missing, old or cannot be verified is no plan (the why is then empty). */
async function planOf(context: TaskScreenContext, task: TaskRecord): Promise<PlanDocument | undefined> {
  try {
    return (await readTaskPlanDocument(task, textReaderOf(context.blobs), { document: "plan" })).content;
  } catch {
    return undefined;
  }
}

export function readTaskChanges(context: TaskScreenContext): Promise<BrokerResponse> {
  return readTaskChangesWith(context, { mayReadSourceCode, cache: PAGES });
}

/** The read, with its source-code gate and page cache supplied (the tests supply their own; the route uses `mayReadSourceCode` and the module's cache). Order: the task read's rule, then the gate, then the cache, then the code host. */
export async function readTaskChangesWith(context: TaskScreenContext, parts: { mayReadSourceCode(): boolean; cache: PageCache }): Promise<BrokerResponse> {
  const task = await readableTask(context);
  const { flow } = context;
  const pullRequestPage = parts.mayReadSourceCode() ? pageReader(context, task, parts.cache) : undefined;
  const changes = await taskChangesOf(task, {
    ...(pullRequestPage === undefined ? {} : { pullRequestPage }),
    verified: () => verifiedChangedFiles(flow.deps, task.workspaceId, task.workflow?.candidate?.digest),
    reported: () => reportedChangedFiles(flow.deps, task.workspaceId),
    plan: await planOf(context, task),
  });
  return { statusCode: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ changes }) };
}
