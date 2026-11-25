// `GET /v1/dev/tasks/{taskId}/changes` (RD-2b2 fills it; RD-2.0 writes the shape): the task's changed files in ONE answer, for the new task page's Changes tab. Once a pull request exists, its files across all pages; before one exists, the list
// the worker reported, labelled as not yet checked against the code host. Each file may carry the "why": the plan steps, checks and review findings that name it. Where nothing matches, `why` is empty (never a guess).
// Every member is optional and unknown members pass through (see task-read-common.ts). Until the lane fills it, Code answers `ROUTE_NOT_SERVED`.
import { z } from "zod";
import { loose } from "./task-read-common.js";

/** One changed file. `why` entries: `kind` is step, check or finding, `id` names it (a claim id, a check id, a finding reference), `text` says it in plain words. `patch` is cut like the diff read's (30,000 characters). */
export const ChangedFileWireSchema = loose({
  path: z.string().nullish(),
  repository: z.string().nullish(),
  additions: z.number().nullish(),
  deletions: z.number().nullish(),
  patch: z.string().nullish(),
  truncated: z.boolean().nullish(),
  why: z.array(loose({ kind: z.string().nullish(), id: z.string().nullish(), text: z.string().nullish() })).nullish(),
});

export const TaskChangesReadSchema = loose({
  changes: loose({
    taskId: z.string().nullish(),
    /** pull_request (the code host's list) or worker_report (what Rovara's worker said it changed). */
    source: z.string().nullish(),
    /** True only for a list the code host confirmed; false for the worker's. A client shows the worker's list labelled. */
    checkedAgainstCodeHost: z.boolean().nullish(),
    pullRequests: z.array(loose({ repository: z.string().nullish(), number: z.number().nullish(), url: z.string().nullish() })).nullish(),
    files: z.array(ChangedFileWireSchema).nullish(),
    /** How many files are left out of `files` (a cap), when any are. */
    filesNotListed: z.number().nullish(),
  }).nullish(),
});
export type TaskChangesRead = z.infer<typeof TaskChangesReadSchema>;

export const TASK_CHANGES_EXAMPLE = {
  changes: {
    taskId: "11111111-1111-4111-8111-111111111111",
    source: "pull_request",
    checkedAgainstCodeHost: true,
    pullRequests: [{ repository: "demo", number: 7, url: "https://github.com/example/demo/pull/7" }],
    files: [{ path: "src/health.ts", repository: "demo", additions: 12, deletions: 0, patch: "@@ -0,0 +1,12 @@\n+export const health = 1;", why: [{ kind: "step", id: "1.1", text: "It answers 200 with the version" }, { kind: "check", id: "unit", text: "Unit tests" }] }],
  },
} as const;
