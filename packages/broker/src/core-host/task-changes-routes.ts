// RD-2b2: `GET /v1/dev/tasks/{taskId}/changes`, the task page's Changes tab in one answer (the view is core/task-view/changes.ts; the response schema is `TaskChangesReadSchema` in packages/code-api).
//
// WHO MAY READ is decided by the mount, once per request, by the one read rule (core/task-flow/read-rule.ts `decideTaskRead`, see task-screen-routes.ts): this file is given `context.decision` and has no access rule of its own (no copy of the
// shared-reader rule, no gate). Anyone the task is not shown to gets the missing task's answer, a share (shown the task's summary, not its code changes) gets TASK_PART_NOT_SHOWN, both before this handler runs. A script token never reaches here.
//
// SOURCE CODE is the decision's own part, `decision.sourceCode` (read-rule.ts `mayReadSourceCode`): a live project grant proved on THIS request, decided for this reader and this task before any cache is asked. It covers the patches AND the file
// paths (a path can reveal the structure of code): with it false NO source is read (not the pull request's pages, not the kept list, not the worker's report) and the answer lists no file. The page cache below holds the FULL answer of a page, keyed by
// company, task, pull request and head, and is asked only after the decision says yes, so a cached page is never handed to a reader the decision refused.
//
// WHERE THE PULL REQUEST'S FILES COME FROM: the deployment's own diff route, asked through `taskRules.route` (the same rule, the same code-host reader, the same patch limit as `GET .../diff`), page by page. This file never imports
// developer/task-code-routes.ts or aws/task-web.ts (the old Code task page's files go away with it). A failed page is an unlisted page, never an error and never a message: the answer says it is not checked, or lists less.
import { z } from "zod";
import type { PlanDocument } from "@agentx/contracts";
import { readTaskPlanDocument } from "../aws/task-plan-document.js";
import { reportedChangedFiles, verifiedChangedFiles } from "../core/build-step/changed-files.js";
import { textReaderOf } from "../core/build-step/plan-input.js";
import type { TaskRecord } from "../core/task-flow/records.js";
import { taskChangesOf, type ChangesSources, type PullRequestPage } from "../core/task-view/changes.js";
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

/** Pages are kept for a short while (45 s) so a reload does not ask the code host again; see task-changes-cache.ts. */
const PAGES = createPageCache({ ttlMs: 45_000, max: 30 });

/** The cache key of one page: the company, the task, the pull request, its head and the page (a push is a new key; another company's never shares one). */
export const pageCacheKey = (companyId: string, taskId: string, pullRequest: { repository: string; number: number }, head: string, page: number): string =>
  `${companyId}|${taskId}|${pullRequest.repository}#${pullRequest.number}@${head}|${page}`;

/** One page of one pull request's files through the deployment's diff route; `undefined` when it cannot be read (not wired, refused, the code host down, an answer of another shape). */
function pageReader(context: TaskScreenContext, task: TaskRecord, cache: PageCache): ((pullRequest: { repository: string; number: number }, page: number) => Promise<PullRequestPage | undefined>) | undefined {
  const { taskRules, authorize, caller, flow } = context;
  if (taskRules === undefined || authorize === undefined) return undefined;
  // The head the task recorded for the pull request; without one nothing is cached (a new push could not be told from the old one).
  const headOf = (pullRequest: { repository: string; number: number }): string | undefined =>
    task.workflow?.pullRequests?.find((entry) => entry.repositoryId === pullRequest.repository && entry.number === pullRequest.number)?.headSha;
  const fetchPage = async (pullRequest: { repository: string; number: number }, page: number): Promise<PullRequestPage | undefined> => {
    const path = `/v1/dev/tasks/${task.taskId}/diff`;
    const query = `repository=${encodeURIComponent(pullRequest.repository)}&number=${pullRequest.number}&page=${page}`;
    try {
      const answer = await taskRules.route({
        request: { method: "GET", path: `${path}?${query}`, headers: {} }, path,
        person: { developerId: caller.principal.personId, name: caller.principal.displayName }, companyId: flow.deps.companyId,
        task: task, store: flow.deps.store,
        // The diff route asks the one read rule for its own read ("diff"), as the person asking: a page is read only for a person that read admits too.
        authorize: (read, seams) => authorize(read, task, seams),
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
  // The diff route asks the rule for "diff" itself, but only when a page is fetched: a page served from the cache never reaches it. So the read asks it here, once per answer and before the cache, and a person the "diff" read
  // refuses is given no page, hit or miss: the changes read can never show more of the code than the diff read does, even if the two reads are one day admitted differently. A rule that fails is a "no".
  let diffAllowed: Promise<boolean> | undefined;
  const mayReadDiff = (): Promise<boolean> => (diffAllowed ??= authorize("diff", task).then(() => true, () => false));
  return async (pullRequest, page) => {
    if (!(await mayReadDiff())) return undefined;
    const head = headOf(pullRequest);
    return head === undefined ? fetchPage(pullRequest, page) : cache.once(pageCacheKey(flow.deps.companyId, task.taskId, pullRequest, head, page), () => fetchPage(pullRequest, page));
  };
}

/** The task's current plan, for the "why"; a plan that is missing, old or cannot be verified is no plan (the why is then empty). */
async function planOf(context: TaskScreenContext, task: TaskRecord): Promise<PlanDocument | undefined> {
  try {
    return (await readTaskPlanDocument(task, textReaderOf(context.blobs), { document: "plan" })).content;
  } catch {
    return undefined;
  }
}

/** Every source of files (the pull request's pages, the kept list, the worker's report) and the plan for the why: built only for a reader the decision lets read source code. */
async function sourcesOf(context: TaskScreenContext, task: TaskRecord, cache: PageCache): Promise<ChangesSources> {
  const { flow } = context;
  const pullRequestPage = pageReader(context, task, cache);
  return {
    ...(pullRequestPage === undefined ? {} : { pullRequestPage }),
    verified: () => verifiedChangedFiles(flow.deps, task.workspaceId, task.workflow?.candidate?.digest),
    reported: () => reportedChangedFiles(flow.deps, task.workspaceId),
    plan: await planOf(context, task),
  };
}

export function readTaskChanges(context: TaskScreenContext): Promise<BrokerResponse> {
  return readTaskChangesWith(context, { cache: PAGES });
}

/** The read, with its page cache supplied (the tests supply their own). Order: the read rule's decision (the mount), then its source-code part, then the cache, then the code host. */
export async function readTaskChangesWith(context: TaskScreenContext, parts: { cache: PageCache }): Promise<BrokerResponse> {
  const task = context.decision.task;
  // Source code (patches and file paths) only where the decision proved it on this request; otherwise no source of files is read at all.
  const changes = await taskChangesOf(task, context.decision.sourceCode ? await sourcesOf(context, task, parts.cache) : {});
  return { statusCode: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ changes }) };
}
