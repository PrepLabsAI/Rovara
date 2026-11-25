// The task reads Code already serves, written down as response schemas (RD-2.0): the plan document, the timeline events, the plan comments, a pull request's diff, People and the proof index. Each answer is read tolerantly (see
// task-read-common.ts); the shapes are what Code serves today, taken from the producing functions (`readTaskPlanDocument`, `coreTimeline`, `listCorePlanComments`, `readCoreTaskDiff`, `getTaskPeople`, `proofIndexOf`), and the route
// tests parse every served answer with them. Nothing here changes what Code serves.
import { z } from "zod";
import { PlanDocumentWireSchema, loose } from "./task-read-common.js";

/** `GET /v1/dev/tasks/{taskId}/plan?document=requirements|design|plan&version=n`: one stored version of one plan document. A task with no such document answers `NOT_FOUND`. */
export const TaskPlanReadSchema = loose({
  plan: loose({
    taskId: z.string().optional(),
    document: z.string().optional(),
    version: z.number().optional(),
    /** The digest the document was approved or can be approved by. */
    sha256: z.string().optional(),
    approved: z.boolean().optional(),
    /** Whether this is the latest version of the document. */
    current: z.boolean().optional(),
    /** Every stored version of the document, oldest first. */
    versions: z.array(z.number()).optional(),
    content: PlanDocumentWireSchema.optional(),
    summary: loose({
      scenarios: z.array(z.unknown()).optional(),
      checks: z.array(z.unknown()).optional(),
      noneReason: z.string().optional(),
      decisions: z.array(loose({ id: z.string().optional(), question: z.string().optional(), answer: z.string().optional() })).optional(),
      lines: z.array(z.string()).optional(),
      findingSentences: z.array(z.string()).optional(),
      selfCheckLines: z.array(z.string()).optional(),
    }).optional(),
  }).optional(),
});
export type TaskPlanRead = z.infer<typeof TaskPlanReadSchema>;

/** `GET /v1/dev/tasks/{taskId}/events?limit=n`: at most 50 lines, oldest first. `kind` is status, progress, tool, message or error today; read it as a string. */
export const TaskEventsReadSchema = loose({
  events: z.array(loose({ at: z.string().optional(), kind: z.string().optional(), text: z.string().optional() })).optional(),
});
export type TaskEventsRead = z.infer<typeof TaskEventsReadSchema>;

/** `GET /v1/dev/tasks/{taskId}/comments`: the plan comments, oldest first. `anchor` is `claim:<id>`, `decision:<id>`, `check:<id>` or absent (the whole document); `replyTo` names a comment this one answers. */
export const TaskCommentsReadSchema = loose({
  comments: z.array(loose({
    commentId: z.string().optional(),
    document: z.string().optional(),
    author: loose({ developerId: z.string().optional(), name: z.string().optional() }).optional(),
    text: z.string().optional(),
    at: z.string().optional(),
    rev: z.number().optional(),
    /** The comment was sent with a decision, so the planner has handled it and it can no longer change. */
    resolved: z.boolean().optional(),
    anchor: z.string().optional(),
    replyTo: z.string().optional(),
  })).optional(),
});
export type TaskCommentsRead = z.infer<typeof TaskCommentsReadSchema>;

/** `GET /v1/dev/tasks/{taskId}/diff?repository&number&page`: one page of the files of a pull request the workflow recorded. A file's `patch` is cut at 30,000 characters and absent for a binary file. */
export const TaskDiffReadSchema = loose({
  repository: z.string().optional(),
  number: z.number().optional(),
  page: z.number().optional(),
  files: z.array(loose({ path: z.string().optional(), additions: z.number().optional(), deletions: z.number().optional(), patch: z.string().optional() })).optional(),
  /** More pages follow. */
  more: z.boolean().optional(),
});
export type TaskDiffRead = z.infer<typeof TaskDiffReadSchema>;

/** `GET /v1/dev/tasks/{taskId}/people`: who is on the task and what they may do. `role` and `effectiveRole` are owner, commenter, viewer or denied today; read them as strings. */
export const TaskPeopleReadSchema = loose({
  view: loose({
    revision: z.number().optional(),
    orphaned: z.boolean().optional(),
    people: z.array(loose({
      personId: z.string().optional(), name: z.string().optional(), role: z.string().optional(), you: z.boolean().optional(),
      effectiveRole: z.string().nullable().optional(), method: z.string().optional(),
    })).optional(),
    canManage: z.boolean().optional(),
    canTakeOwnership: z.boolean().optional(),
    addPeopleUrl: z.string().optional(),
  }).optional(),
});
export type TaskPeopleRead = z.infer<typeof TaskPeopleReadSchema>;

/**
 * `GET /v1/dev/tasks/{taskId}/evidence`: the proof index of the task's current code (Cloud's `tasks.evidence.list`): one item per check result, kept-pack check and review, and the failing tests. `kind` is check_result, test_report or
 * review; `verdict` is pass, fail or unknown. `criterionIds` is always empty today (Code does not tie a check to a claim here: the checks read does).
 */
export const TaskEvidenceListSchema = loose({
  taskId: z.string().optional(),
  items: z.array(loose({
    id: z.string().optional(), sha256: z.string().optional(), title: z.string().optional(), kind: z.string().optional(), verdict: z.string().optional(), criterionIds: z.array(z.string()).optional(),
  })).optional(),
  failures: z.array(loose({ check: z.string().optional(), test: z.string().optional(), cause: z.string().optional() })).optional(),
  failuresNotListed: z.number().optional(),
});
export type TaskEvidenceList = z.infer<typeof TaskEvidenceListSchema>;

const TASK = "11111111-1111-4111-8111-111111111111";
const DIGEST = "a".repeat(64);

/** One request-free example answer of each (the rows' `example.response`; they parse with the schemas above). */
export const TASK_EXISTING_READ_EXAMPLES = {
  plan: {
    plan: {
      taskId: TASK, document: "plan", version: 2, sha256: DIGEST, approved: false, current: true, versions: [1, 2],
      content: {
        schemaVersion: 1, title: "Add a health check", why: [{ text: "Operators need to know the service is up.", author: "Rovara" }],
        claims: [{ id: "1", text: "Add GET /health", children: [{ id: "1.1", text: "It answers 200 with the version" }] }],
        notChanging: ["The public API"], risks: ["A slow check could delay deploys"],
        decisions: [{ id: "d1", claimId: "1", question: "Where does it live?", options: [{ id: "root", label: "At /health", consequence: "One path" }, { id: "api", label: "At /api/health", consequence: "Behind the API prefix" }], recommended: "root" }],
        checks: { proposed: [{ id: "unit", label: "Unit tests" }], proves: { unit: ["1", "1.1"] } },
      },
      summary: { scenarios: [], checks: [], decisions: [{ id: "d1", question: "Where does it live?", answer: "At /health" }], lines: ["Unit tests"], findingSentences: [], selfCheckLines: [] },
    },
  },
  events: { events: [{ at: "2026-11-15T10:00:00.000Z", kind: "status", text: "Task started" }, { at: "2026-11-15T10:04:00.000Z", kind: "status", text: "Approved: Looks right." }] },
  comments: { comments: [{ commentId: "22222222-2222-4222-8222-222222222222", document: "plan", author: { developerId: DIGEST, name: "Maya" }, text: "Put the banner above", at: "2026-11-15T10:05:00.000Z", rev: 1, resolved: false, anchor: "claim:1.1" }] },
  diff: { repository: "demo", number: 7, page: 1, files: [{ path: "src/health.ts", additions: 12, deletions: 0, patch: "@@ -0,0 +1,12 @@\n+export const health = 1;" }], more: false },
  people: { view: { revision: 3, orphaned: false, people: [{ personId: "33333333-3333-4333-8333-333333333333", name: "Maya", role: "owner", you: true, effectiveRole: "owner" }], canManage: true, canTakeOwnership: false } },
  evidence: { taskId: TASK, items: [{ id: "check:0", title: "Unit tests", kind: "check_result", verdict: "pass", criterionIds: [] }, { id: "review:code", title: "Code review", kind: "review", verdict: "pass", criterionIds: [] }], failures: [] },
} as const;
