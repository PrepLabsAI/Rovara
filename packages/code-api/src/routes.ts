// The Code API's ONE route table (F3 cut 1, DEC 254zzz459/468): every route Rovara Code's developer API serves, by method and path, with what a caller's token needs to reach it.
// Moved here unchanged from packages/broker/src/aws/dev-route-scopes.ts (the rows and their comments are the same text, in the same order); the broker keeps only the selectors over
// these rows (devRouteOf, appRouteOf) and the worker rows, which are not part of this API. This file imports nothing but the scopes and the standing's reader (zod schemas): it is data, and a browser may load it.
//
// A request whose method and path match no row is refused before anyone is authenticated (fail closed), so a new route is unreachable until it is given a row. A sign-in client's token
// reaches a row only with the row's scope; the Rovara CLI's own token reaches every row, as before. Migration plan v3.2, lane ID part 1 (DEC 214 decision 7): named scopes.
import { z } from "zod";
import type { ClientScope } from "./scopes.js";
import { ROUTE_NOT_SERVED_MESSAGE } from "./errors.js";
import { TASK_CHANGES_EXAMPLE, TaskChangesReadSchema } from "./task-changes.js";
import { TASK_CHECKS_EXAMPLE, TaskChecksReadSchema } from "./task-checks.js";
import { TASK_EXISTING_READ_EXAMPLES, TaskCommentsReadSchema, TaskDiffReadSchema, TaskEventsReadSchema, TaskEvidenceListSchema, TaskPeopleReadSchema, TaskPlanReadSchema } from "./task-existing-reads.js";
import { TASK_SPEC_EXAMPLE, TaskSpecReadSchema } from "./task-spec.js";
import { TaskStandingWireSchema } from "./task-standing.js";
import { TASK_TIMELINE_EXAMPLE, TaskTimelineReadSchema } from "./task-timeline.js";

/**
 * What a row needs from a sign-in client's token:
 * - a named scope: the token carries it, and the client's registration still allows it;
 * - `full`: only the Rovara CLI or a client registered with full access (spec 066), which is off unless an
 *   administrator turns it on for that client;
 * - `none`: the route checks its caller itself (the access check, or a read that shows only what the person may use).
 */
export type RouteRequirement = ClientScope | "full" | "none";

export type RouteMethod = "GET" | "POST" | "PUT" | "DELETE";

/** One refusal a route may answer with: the code and its status (`errorStatus`). Typing and examples only; the code list in errors.ts is the one list. */
export interface RouteRefusal {
  code: string;
  status: number;
}

export interface Route {
  /** A stable name for the route. Absent on a row nobody calls through the client yet; `routeIdOf` then gives `METHOD path`. A row that carries a schema names itself. */
  id?: string;
  method: RouteMethod;
  /** The path, with each `{name}` standing for one non-empty path segment. */
  path: string;
  requires: RouteRequirement;
  /** The caller must be the Rovara web app's own sign-in client. A fact about the route; Code's router enforces it. */
  webAppOnly?: boolean;
  /** The body, and the query, a caller sends. Strict: Code validates what comes in with it. Rows added by later cuts; no row in cut 1 has one. */
  request?: z.ZodType;
  /** The answer a caller reads. A tolerant reader (unknown keys ignored). Rows added by later cuts. */
  response?: z.ZodType;
  /** The refusals the route may answer with. */
  errors?: readonly RouteRefusal[];
  /** One request, one success answer and one refusal answer, as data (for journeys and for a pretend Code). */
  example?: { request?: unknown; response?: unknown; refusal?: unknown };
}

/** A row's id: its own, or `METHOD path`. */
export function routeIdOf(route: Pick<Route, "id" | "method" | "path">): string {
  return route.id ?? `${route.method} ${route.path}`;
}

/** RD-2.0: what a read the table lists but Code does not serve yet may answer, and its example refusal (the same words for every task). */
const NOT_SERVED_ERRORS: readonly RouteRefusal[] = [{ code: "TASK_NOT_FOUND", status: 404 }, { code: "ROUTE_NOT_SERVED", status: 404 }];
/** The reads a task shared for its summary does not show (the read rule's table): spec, checks and changes answer such a reader TASK_PART_NOT_SHOWN (403). */
const PART_NOT_SHOWN_ERRORS: readonly RouteRefusal[] = [...NOT_SERVED_ERRORS, { code: "TASK_PART_NOT_SHOWN", status: 403 }];
const NOT_SERVED_REFUSAL = { error: { code: "ROUTE_NOT_SERVED", message: ROUTE_NOT_SERVED_MESSAGE } } as const;

/**
 * The /v1/dev/* rows (the developer API) first, then the core engine's /v1/app/* rows (Lane L12, served on the broker's HTTP API only while the core switch serves), each group in the order it
 * has always had: the first row that matches wins, so the order is part of the table.
 */
export const ROUTES: readonly Route[] = [
  { method: "GET", path: "/v1/dev/tasks/start-requests/{requestId}", requires: "tasks:read" },
  { method: "POST", path: "/v1/dev/company/connections/impact", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/start-estimates", requires: "tasks:read" },
  { method: "GET", path: "/v1/dev/projects/{project}/machine-size", requires: "tasks:read" },
  { method: "POST", path: "/v1/dev/projects/{project}/machine-size", requires: "full" },
  { method: "GET", path: "/v1/dev/projects/{name}/settings", requires: "full" },
  { method: "PUT", path: "/v1/dev/projects/{name}/settings", requires: "full" },
  // M4a slice 3 (TE-D8): the company administrator's read of every project against the company's bounds.
  { method: "GET", path: "/v1/dev/company/settings-compliance", requires: "full" },
  // DEC 253z, 254a: a person with no company makes their own with an operator's invite code; the web app only (the route checks it).
  { method: "POST", path: "/v1/dev/company", requires: "full" },
  // Spec 063 FR-004: a registered service's own route, authenticated by its secret or the person's token.
  { method: "POST", path: "/v1/dev/access", requires: "none" },
  // #634: the person chooses their own name.
  { method: "PUT", path: "/v1/dev/me/name", requires: "profile:name" },
  // DEC 254w: connected sign-ins. Full access only (the web app); DeveloperIdentity also checks the session and the person.
  { method: "GET", path: "/v1/dev/me/sign-ins", requires: "full" },
  { method: "POST", path: "/v1/dev/me/sign-ins/link", requires: "full" },
  { method: "POST", path: "/v1/dev/me/sign-ins/link/finish", requires: "full" },
  { method: "DELETE", path: "/v1/dev/me/sign-ins/{method}", requires: "full" },
  { method: "GET", path: "/v1/dev/company/members/{personId}/sign-ins", requires: "full" },
  { method: "DELETE", path: "/v1/dev/company/members/{personId}/sign-ins/{method}", requires: "full" },
  // DEC 254zzz73: GET /v1/dev/me/sign-in-factors (the step-up confirmation email and passkeys) is removed with the step-up.
  // Spec 065b: a project from a repository the GitHub App can reach.
  { method: "POST", path: "/v1/dev/client/projects", requires: "projects:create" },
  { method: "GET", path: "/v1/dev/client/repositories", requires: "projects:create" },
  // Guided onboarding PR 6: one project per repository, and the repository picker (the company's connected repositories, marked with its projects).
  { method: "POST", path: "/v1/dev/client/projects/bulk", requires: "projects:create" },
  { method: "GET", path: "/v1/dev/client/repositories/available", requires: "projects:create" },
  // Lanes AU and EV (#649): the company's audit records and events, for a company administrator. No named scope reads them yet, so only a client with full
  // access does (off unless an administrator turns it on); a named company-read scope is a follow-up.
  { method: "GET", path: "/v1/dev/client/company/audit/records", requires: "full" },
  { method: "GET", path: "/v1/dev/client/company/events", requires: "full" },
  // Spec 065: one project the person may use; it shows only what they may use, so it needs no scope.
  { method: "GET", path: "/v1/dev/client/projects/{project}", requires: "none" },
  // Spec 065a: a project's members.
  { method: "GET", path: "/v1/dev/client/projects/{project}/members", requires: "projects:members" },
  { method: "PUT", path: "/v1/dev/client/projects/{project}/members/{developerId}", requires: "projects:members" },
  { method: "DELETE", path: "/v1/dev/client/projects/{project}/members/{developerId}", requires: "projects:members" },
  // Lane W: a project's merge rules; full access only (the route also checks the project and who may change it).
  { method: "GET", path: "/v1/dev/client/projects/{project}/code-settings", requires: "full" },
  { method: "PUT", path: "/v1/dev/client/projects/{project}/code-settings", requires: "full" },
  // Guided onboarding PR 8: a project's setup checklist state (any member of the project's company) and its skipped optional rows (company owner or admin, or the project's administrator); full access only.
  { method: "GET", path: "/v1/dev/client/projects/{project}/setup-status", requires: "full" },
  { method: "PUT", path: "/v1/dev/client/projects/{project}/setup-status/skips", requires: "full" },
  // Guided onboarding PR 16 (DEC 254n item 3): a project's archive and restore, preview first; full access only, then a live company owner or admin, or the project's administrator.
  { method: "GET", path: "/v1/dev/client/projects/{project}/archive-preview", requires: "full" },
  { method: "POST", path: "/v1/dev/client/projects/{project}/archive", requires: "full" },
  { method: "GET", path: "/v1/dev/client/projects/{project}/restore-preview", requires: "full" },
  { method: "POST", path: "/v1/dev/client/projects/{project}/restore", requires: "full" },
  // L2-5 c: "no evals" for the project's latest finished setup run (the same people as the skips); full access only.
  { method: "PUT", path: "/v1/dev/client/projects/{project}/setup-status/eval-none", requires: "full" },
  // Tasks: read.
  { method: "GET", path: "/v1/dev/projects", requires: "tasks:read" },
  { method: "GET", path: "/v1/dev/tasks", requires: "tasks:read" },
  // F2-B: the task read carries `standing` (where the task stands for the person reading it). The answer is read tolerantly: only `standing` is named here, every other member passes through, and a standing that does not read leaves the answer as it is.
  { id: "tasks.read", method: "GET", path: "/v1/dev/tasks/{taskId}", requires: "tasks:read", response: z.object({ task: z.object({ standing: TaskStandingWireSchema.optional().catch(undefined) }).passthrough() }).passthrough() },
  // RD-2.0: the task page's reads. The six that Code already served now name themselves and carry a tolerant response schema (task-existing-reads.ts); the four new ones (spec, checks, changes, timeline) are listed after the proof index below.
  { id: "tasks.events", method: "GET", path: "/v1/dev/tasks/{taskId}/events", requires: "tasks:read", response: TaskEventsReadSchema, example: { response: TASK_EXISTING_READ_EXAMPLES.events } },
  { id: "tasks.plan", method: "GET", path: "/v1/dev/tasks/{taskId}/plan", requires: "tasks:read", response: TaskPlanReadSchema, example: { response: TASK_EXISTING_READ_EXAMPLES.plan } },
  { id: "tasks.people", method: "GET", path: "/v1/dev/tasks/{taskId}/people", requires: "tasks:read", response: TaskPeopleReadSchema, example: { response: TASK_EXISTING_READ_EXAMPLES.people } },
  { method: "GET", path: "/v1/dev/tasks/{taskId}/people/requests/{requestId}", requires: "tasks:read" },
  { method: "GET", path: "/v1/dev/tasks/{taskId}/workflow/feedback", requires: "tasks:read" },
  // #644: comments and steering notes, a pull request's diff, plan-document comments.
  { method: "GET", path: "/v1/dev/tasks/{taskId}/messages", requires: "tasks:read" },
  { id: "tasks.diff", method: "GET", path: "/v1/dev/tasks/{taskId}/diff", requires: "tasks:read", response: TaskDiffReadSchema, example: { response: TASK_EXISTING_READ_EXAMPLES.diff } },
  { id: "tasks.comments", method: "GET", path: "/v1/dev/tasks/{taskId}/comments", requires: "tasks:read", response: TaskCommentsReadSchema, example: { response: TASK_EXISTING_READ_EXAMPLES.comments } },
  // Cloud's Proof tab: the task's proof index (what the proof page shows as checked for its current code, and its failing tests), under the task read's own rule.
  { id: "tasks.evidence.list", method: "GET", path: "/v1/dev/tasks/{taskId}/evidence", requires: "tasks:read", response: TaskEvidenceListSchema, example: { response: TASK_EXISTING_READ_EXAMPLES.evidence } },
  // RD-2.0: the new reads of the task page, each in one answer (core-host/task-screen-routes.ts mounts them; each answers ROUTE_NOT_SERVED until its lane fills it: RD-2a spec, RD-2b1 checks, RD-2b2 changes, RD-2c timeline). Under the task read's own rule.
  { id: "tasks.spec", method: "GET", path: "/v1/dev/tasks/{taskId}/spec", requires: "tasks:read", response: TaskSpecReadSchema, errors: PART_NOT_SHOWN_ERRORS, example: { response: TASK_SPEC_EXAMPLE, refusal: NOT_SERVED_REFUSAL } },
  { id: "tasks.checks", method: "GET", path: "/v1/dev/tasks/{taskId}/checks", requires: "tasks:read", response: TaskChecksReadSchema, errors: PART_NOT_SHOWN_ERRORS, example: { response: TASK_CHECKS_EXAMPLE, refusal: NOT_SERVED_REFUSAL } },
  { id: "tasks.changes", method: "GET", path: "/v1/dev/tasks/{taskId}/changes", requires: "tasks:read", response: TaskChangesReadSchema, errors: PART_NOT_SHOWN_ERRORS, example: { response: TASK_CHANGES_EXAMPLE, refusal: NOT_SERVED_REFUSAL } },
  { id: "tasks.timeline", method: "GET", path: "/v1/dev/tasks/{taskId}/timeline", requires: "tasks:read", response: TaskTimelineReadSchema, errors: NOT_SERVED_ERRORS, example: { response: TASK_TIMELINE_EXAMPLE, refusal: NOT_SERVED_REFUSAL } },
  // Tasks: start.
  { method: "POST", path: "/v1/dev/tasks", requires: "tasks:start" },
  // Tasks: act on a task the person may act on.
  { method: "POST", path: "/v1/dev/tasks/{taskId}/continue", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/cancel", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/close", requires: "tasks:act" },
  { method: "GET", path: "/v1/dev/tasks/{taskId}/close", requires: "tasks:read" },
  // CORE-PARITY: manual publication, workflow review and share below are mounted by core-host/dev-routes.
  { method: "POST", path: "/v1/dev/tasks/{taskId}/pull-requests", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/people/role", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/people/take-ownership", requires: "tasks:act" },
  // Web task channel C4: owner-only People additions from the web (the candidates list names people, so it needs `tasks:act` too).
  { method: "GET", path: "/v1/dev/tasks/{taskId}/people/candidates", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/people/add", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/workflow/retry", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/workflow/review", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/workflow/publish-retry", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/workflow/keep-pull-requests", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/workflow/send-back", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/workflow/review-findings", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/workflow/feedback-retry", requires: "tasks:act" },
  // S3: the owner's answers to Understand's questions (a core task's; a workflow task has none to answer). The route keeps it to the task's owner.
  { method: "POST", path: "/v1/dev/tasks/{taskId}/answers", requires: "tasks:act" },
  // #644: a comment, or steering the running step (which the route itself keeps to the task's owner).
  { method: "POST", path: "/v1/dev/tasks/{taskId}/messages", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/comments", requires: "tasks:act" },
  // Tasks: share (spec 067 readers, and the Slack share).
  { method: "POST", path: "/v1/dev/tasks/{taskId}/share", requires: "tasks:share" },
  { method: "GET", path: "/v1/dev/tasks/{taskId}/readers", requires: "tasks:share" },
  { method: "PUT", path: "/v1/dev/tasks/{taskId}/readers/{developerId}", requires: "tasks:share" },
  { method: "DELETE", path: "/v1/dev/tasks/{taskId}/readers/{developerId}", requires: "tasks:share" },
  // Decisions: approve a plan or request changes; decide on the pull-request feedback proposal.
  { method: "POST", path: "/v1/dev/tasks/{taskId}/workflow/decision", requires: "decisions:decide" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/workflow/feedback-decision", requires: "decisions:decide" },
  // T3: invite administration is full-access only; live company admin/owner membership is still required.
  { method: "POST", path: "/v1/dev/company/preapprovals", requires: "full" },
  // INVITE-RESEND (DEC 254zzz184): the website-only resend remains behind full access and the route's live company role check.
  { method: "POST", path: "/v1/dev/company/preapprovals/{inviteId}/resend", requires: "full" },
  { method: "DELETE", path: "/v1/dev/company/preapprovals/{emailHash}", requires: "full" },
  // Lane LM8: the lessons API of one project of the caller's company (core-host/lessons-api.ts). Full access only, like the other company-admin routes; live membership and the project's roster still apply.
  { method: "GET", path: "/v1/dev/projects/{project}/lessons", requires: "full" },
  { method: "GET", path: "/v1/dev/projects/{project}/lessons/retire-requests", requires: "full" },
  { method: "GET", path: "/v1/dev/projects/{project}/lessons/weekly", requires: "full" },
  { method: "GET", path: "/v1/dev/projects/{project}/lessons/measure", requires: "full" },
  { method: "GET", path: "/v1/dev/projects/{project}/lessons/tuning", requires: "full" },
  // L4-RPL: compare current lesson selection to this company's finished task manifests; read-only and roster checked.
  { method: "GET", path: "/v1/dev/projects/{project}/lessons/replay", requires: "full" },
  { method: "GET", path: "/v1/dev/projects/{project}/lessons/mode", requires: "full" },
  { method: "PUT", path: "/v1/dev/projects/{project}/lessons/mode", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/lessons/mode/trial-offer", requires: "full" },
  // Lead 4 L4-LP3W: the approved lessons by code area, and "Where Rovara learns from" with its Pause (who may set the mode may pause).
  { method: "GET", path: "/v1/dev/projects/{project}/lessons/areas", requires: "full" },
  { method: "GET", path: "/v1/dev/projects/{project}/lessons/learning-sources", requires: "full" },
  { method: "PUT", path: "/v1/dev/projects/{project}/lessons/learning-sources/{source}", requires: "full" },
  { method: "GET", path: "/v1/dev/projects/{project}/lessons/weekly-summary", requires: "full" },
  { method: "PUT", path: "/v1/dev/projects/{project}/lessons/weekly-summary", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/lessons/{lessonId}/approve", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/lessons/{lessonId}/reject", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/lessons/{lessonId}/retire", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/lessons/{lessonId}/retire-request", requires: "full" },
  // L4-LP12b: the answer to the weekly list's "Keep it?" card (a lesson no task had needed for a long time); the people who decide lessons, read live; full access only like the rows around it.
  { method: "POST", path: "/v1/dev/projects/{project}/lessons/{lessonId}/keep", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/lessons/decisions", requires: "full" },
  // Lessons phase 4 (core-host/lessons-graduation.ts): this week's cards, making a proven lesson permanent, "Not now", the third conflict answer, the Tidy card, and the draft check tasks. Full access only; live membership,
  // the project's roster and the approver directory still decide, and a script token is refused.
  { method: "GET", path: "/v1/dev/projects/{project}/lessons/graduation", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/lessons/{lessonId}/graduate", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/lessons/{lessonId}/graduate-later", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/lessons/{lessonId}/both-places", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/lessons/tidy/retire-chosen", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/lessons/tidy/later", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/lessons/check-drafts/{draftId}/started", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/lessons/check-drafts/{draftId}/dismiss", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/lessons/rules/{ruleId}/retire", requires: "full" },
  // L4-AK3: Rovara skills (core-host/lessons-api.ts): list, "Make this a skill?", edit, the two approvals and retire. Full access only; live membership, the project's roster and the approver directory still decide.
  { method: "GET", path: "/v1/dev/projects/{project}/skills", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/lessons/{lessonId}/skill", requires: "full" },
  { method: "PUT", path: "/v1/dev/projects/{project}/skills/{skill}", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/skills/{skill}/approve", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/skills/{skill}/retire", requires: "full" },
  { method: "GET", path: "/v1/dev/projects/{project}/tasks/{taskId}/lessons", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/tasks/{taskId}/lessons/{lessonId}/not-helpful", requires: "full" },
  // L4-AK1H: team knowledge for a tool outside Rovara (core-host/knowledge-api.ts): a signed-in person's own token (full access, like the rows above) or a script token with the Team knowledge permission naming the project
  // (checked by the knowledge API; no sign-in client scope reaches it). At most 10 units and 2 KB an answer, 300 reads a day a person, no bulk mode.
  { method: "POST", path: "/v1/dev/projects/{project}/lessons", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/knowledge/areas", requires: "full" },
  // L4-AK3H: a team SUGGESTION from a tool outside Rovara (`team_propose`; core-host/knowledge-api.ts), the same two callers and the same Team knowledge permission. A weak-source lesson that waits for a second sighting and a person; at most 10 a person a UTC day.
  { method: "POST", path: "/v1/dev/projects/{project}/knowledge/propose", requires: "full" },
  // The Home number "Corrections you had to repeat" (core-host/lessons-repeats-api.ts): one project (its roster), or the company (owners and admins). Full access only, live membership.
  { method: "GET", path: "/v1/dev/projects/{project}/lessons/repeats", requires: "full" },
  { method: "GET", path: "/v1/dev/lessons/repeats", requires: "full" },
  // L4-JA7: "Knowledge stays in Rovara" (the company) and "local coding tools can fetch lessons" (a project) (core-host/knowledge-switch-api.ts). Full access only; live membership and role decide (company: an owner or admin; project: its admin, or a company owner or admin).
  { method: "GET", path: "/v1/dev/company/lessons/local-tools", requires: "full" },
  { method: "PUT", path: "/v1/dev/company/lessons/local-tools", requires: "full" },
  { method: "GET", path: "/v1/dev/projects/{project}/lessons/local-tools", requires: "full" },
  { method: "PUT", path: "/v1/dev/projects/{project}/lessons/local-tools", requires: "full" },
  // L4-SRC-SL: the person's own "Don't learn from my Slack messages" switch (core-host/lessons-slack-switch-api.ts). Full access only; the person is the signed-in caller, never a path or body.
  { method: "GET", path: "/v1/dev/me/lessons-slack", requires: "full" },
  { method: "PUT", path: "/v1/dev/me/lessons-slack", requires: "full" },
  // Lane W part 4: the company administrator's routes; full access only (DEC ANSWER-4), then a live admin or owner membership to change anyone.
  { method: "GET", path: "/v1/dev/company/members", requires: "full" },
  { method: "GET", path: "/v1/dev/company/members/{personId}/removal-preview", requires: "full" },
  { method: "POST", path: "/v1/dev/company/members/{personId}/removal", requires: "full" },
  { method: "PUT", path: "/v1/dev/company/members/{personId}/role", requires: "full" },
  // DEC 254zzz101: the hand-overs waiting to be finished, and finishing one to a successor picked now (website only, checked by the route).
  { method: "GET", path: "/v1/dev/company/members/handovers", requires: "full" },
  { method: "POST", path: "/v1/dev/company/members/{personId}/handover", requires: "full" },
  // Guided onboarding PR 1: connect the company's GitHub App installation (live owner/admin; the claim proves control on GitHub) and read the company's connections (any member).
  { method: "POST", path: "/v1/dev/company/github/connect", requires: "full" },
  { method: "POST", path: "/v1/dev/company/github/claim", requires: "full" },
  { method: "POST", path: "/v1/dev/company/github/choose", requires: "full" },
  { method: "GET", path: "/v1/dev/company/github", requires: "full" },
  // Guided onboarding PR 3: disconnect one installation (live owner, refused while the company's projects use it).
  { method: "DELETE", path: "/v1/dev/company/github/{installationId}", requires: "full" },
  // L4-GH: a person links their own GitHub account to themselves (the web app only; Code checks the live membership and the GitHub user authorization itself).
  { method: "GET", path: "/v1/dev/me/github", requires: "full" },
  { method: "DELETE", path: "/v1/dev/me/github", requires: "full" },
  { method: "POST", path: "/v1/dev/me/github/link", requires: "full" },
  { method: "POST", path: "/v1/dev/me/github/link/claim", requires: "full" },
  // Guided onboarding PR 4: Add to Slack (live owner/admin; disconnect owner) and the company's Slack connection (any member).
  { method: "POST", path: "/v1/dev/company/slack/install", requires: "full" },
  { method: "POST", path: "/v1/dev/company/slack/install/complete", requires: "full" },
  { method: "POST", path: "/v1/dev/company/slack/disconnect", requires: "full" },
  { method: "GET", path: "/v1/dev/company/slack", requires: "full" },
  // Guided onboarding PR 5: a project's Slack channel (live owner/admin or the project's admin to link, unlink and pick; any member to read).
  { method: "GET", path: "/v1/dev/company/slack/channels", requires: "full" },
  { method: "GET", path: "/v1/dev/company/slack/projects/{project}/channel", requires: "full" },
  { method: "PUT", path: "/v1/dev/company/slack/projects/{project}/channel", requires: "full" },
  { method: "DELETE", path: "/v1/dev/company/slack/projects/{project}/channel", requires: "full" },
  { method: "POST", path: "/v1/dev/company/slack/projects/{project}/channel/check", requires: "full" },
  // Guided onboarding PR 7: connect Linear by OAuth (live owner/admin), the connection's status (any member), disconnect (live owner), and a project's Linear team
  // (owner/admin or the project's admin).
  { method: "POST", path: "/v1/dev/company/linear/connect", requires: "full" },
  { method: "POST", path: "/v1/dev/company/linear/complete", requires: "full" },
  { method: "GET", path: "/v1/dev/company/linear", requires: "full" },
  { method: "DELETE", path: "/v1/dev/company/linear", requires: "full" },
  { method: "GET", path: "/v1/dev/company/linear/projects/{project}", requires: "full" },
  { method: "PUT", path: "/v1/dev/company/linear/projects/{project}", requires: "full" },
  { method: "DELETE", path: "/v1/dev/company/linear/projects/{project}", requires: "full" },
  // R1 + L1: a member links their own Linear account to themselves (the web app only; Code checks the live membership and Linear's own sign-in itself), and the company's owner/admin list who linked and remove a link.
  { method: "GET", path: "/v1/dev/me/tracker-accounts/linear", requires: "full" },
  { method: "DELETE", path: "/v1/dev/me/tracker-accounts/linear", requires: "full" },
  { method: "POST", path: "/v1/dev/me/tracker-accounts/linear/link", requires: "full" },
  { method: "POST", path: "/v1/dev/me/tracker-accounts/linear/link/claim", requires: "full" },
  { method: "GET", path: "/v1/dev/company/linear/people", requires: "full" },
  { method: "DELETE", path: "/v1/dev/company/linear/people/{personId}", requires: "full" },
  // Guided onboarding PR 14 (DEC 254n item 1): the company's own engine model (read: any member; change: live owner/admin, checked against the gateway's live list for the company).
  { method: "GET", path: "/v1/dev/company/engine-model", requires: "full" },
  { method: "PUT", path: "/v1/dev/company/engine-model", requires: "full" },
  // DEC 254zzz63: the company's own lessons learning model (read: any member; change: live owner/admin, a Claude model the gateway offers the company now).
  { method: "GET", path: "/v1/dev/company/learning-model", requires: "full" },
  { method: "PUT", path: "/v1/dev/company/learning-model", requires: "full" },
  // L4-EGR: Rovara's fixed outbound addresses (read only; a live owner or admin of the company).
  { method: "GET", path: "/v1/dev/company/egress-addresses", requires: "full" },
  // The CLI's own routes, which no named scope opens.
  { method: "GET", path: "/v1/dev/workspaces", requires: "full" },
  { method: "GET", path: "/v1/dev/channel-links", requires: "full" },
  { method: "DELETE", path: "/v1/dev/channel-links/{channel}/{workspace}/{account}", requires: "full" },
  { method: "GET", path: "/v1/dev/chatgpt/connection", requires: "full" },
  { method: "POST", path: "/v1/dev/chatgpt/connection", requires: "full" },
  { method: "DELETE", path: "/v1/dev/chatgpt/connection", requires: "full" },
  { method: "POST", path: "/v1/dev/chatgpt/connection/finish", requires: "full" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/e2e-publication-context", requires: "full" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/canvas-closeout/retry", requires: "full" },
  // ---- The core engine's own /v1/app/* routes (Lane L12; aws/core-app-routes.ts) ----
  // The same rule: a method and path with no row is refused before anyone is authenticated, and a sign-in client's token reaches a row only with its scope. Only the routes the core serves on AWS have rows (not
  // the laptop's asks, automations or page routes). Behind every row the core's own handler still takes the company from live membership and checks the person's level, grant or role.
  { method: "GET", path: "/v1/app/projects/{project}/known-failing", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/known-failing", requires: "full" },
  // Sessions (the core's session routes): reading one's own sessions is a task read; following and presence are a reader's own marks.
  { method: "GET", path: "/v1/app/sessions", requires: "tasks:read" },
  { method: "GET", path: "/v1/app/sessions/{sessionId}", requires: "tasks:read" },
  // The task's log of questions, answers and decisions (B5): the same readers as the session; one more row, nothing existing changed.
  { method: "GET", path: "/v1/app/sessions/{sessionId}/log", requires: "tasks:read" },
  { method: "POST", path: "/v1/app/sessions/{sessionId}/follow", requires: "tasks:read" },
  { method: "DELETE", path: "/v1/app/sessions/{sessionId}/follow", requires: "tasks:read" },
  { method: "POST", path: "/v1/app/sessions/{sessionId}/unfollow", requires: "tasks:read" },
  { method: "POST", path: "/v1/app/sessions/{sessionId}/presence", requires: "tasks:read" },
  // The in-app inbox (web task channel C7): the person's own attention rows and marking them read; each row is checked against the person's session access again before it is shown.
  { method: "GET", path: "/v1/app/inbox", requires: "tasks:read" },
  { method: "POST", path: "/v1/app/inbox/read", requires: "tasks:read" },
  // The signed link of an attention email stops those emails for the signed-in person it names (it changes their own notification setting, not a task read): full access only.
  { method: "POST", path: "/v1/app/notify/unsubscribe", requires: "full" },
  { method: "GET", path: "/v1/app/inbox/project-notices", requires: "full" },
  // Acting on a session's task (each also needs the person's session level).
  { method: "POST", path: "/v1/app/sessions/{sessionId}/stop", requires: "tasks:act" },
  { method: "POST", path: "/v1/app/sessions/{sessionId}/retry", requires: "tasks:act" },
  { method: "POST", path: "/v1/app/sessions/{sessionId}/messages", requires: "tasks:act" },
  { method: "POST", path: "/v1/app/sessions/{sessionId}/answers", requires: "tasks:act" },
  { method: "POST", path: "/v1/app/sessions/{sessionId}/revise-plan", requires: "tasks:act" },
  { method: "POST", path: "/v1/app/sessions/{sessionId}/close", requires: "tasks:act" },
  { method: "GET", path: "/v1/app/sessions/{sessionId}/close", requires: "tasks:read" },
  // Decision cards: the list and every act on a card (the performer checks the person's live authority).
  { method: "GET", path: "/v1/app/decisions", requires: "decisions:decide" },
  { method: "POST", path: "/v1/app/decisions/{kind}/{subject}/approve", requires: "decisions:decide" },
  { method: "POST", path: "/v1/app/decisions/{kind}/{subject}/reject", requires: "decisions:decide" },
  { method: "POST", path: "/v1/app/decisions/{kind}/{subject}/request-changes", requires: "decisions:decide" },
  { method: "POST", path: "/v1/app/decisions/{kind}/{subject}/evidence-opened", requires: "decisions:decide" },
  // How we work (read only): no named scope reads a project's settings, so full access only.
  { method: "GET", path: "/v1/app/projects/{project}/how-we-work", requires: "full" },
  { method: "GET", path: "/v1/app/projects/{project}/playbook", requires: "full" },
  // DEC 254z-amend3: a project's test environment state (read only: whether test services are on, why they are not available here, the catalog). Like how we work, no named scope reads it: full access only.
  { method: "GET", path: "/v1/app/projects/{project}/test-environment", requires: "full" },
  // L4-B3b (DEC 254zm item 4): approving the proposal that waits (the risk-based approver rule: a company owner or admin, or the project's maintainer for low and medium risk, an owner or admin for high).
  { method: "POST", path: "/v1/app/projects/{project}/test-environment/approve", requires: "full" },
  // L4-MF1: a project's saved environment image panel (read only: fixed words, counts and times; off with the install's saved-environments switch). Like the test environment: full access only.
  { method: "GET", path: "/v1/app/projects/{project}/environment-image", requires: "full" },
  // Guided onboarding L2-3: a project's setup run (it spends model money and runs the repository's commands): full access only, then a live company owner or admin, or the project's
  // administrator, to change; a project user may read it.
  { method: "GET", path: "/v1/app/projects/{project}/setup-agent", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/setup-agent", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/setup-agent/stop", requires: "full" },
  { method: "GET", path: "/v1/app/projects/{project}/setup-agent/journal", requires: "full" },
  // L4-P1: "Re-check setup" (core-host/setup-run-routes.ts `routeHostedSetupCheck`): the project's plain setup check, started by a person. Full access only; any live role on the project reads where it stands; a live company owner or
  // admin, or the project's administrator, starts it (the audit record first). No AI, no model key.
  { method: "GET", path: "/v1/app/projects/{project}/setup-check", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/setup-check", requires: "full" },
  // SETUP-CHECK-WATCH: "Stop check" (the same routeHostedSetupCheck): ends the project's running check, closes its workspace and releases its machine. The same people as start; the audit record first.
  { method: "POST", path: "/v1/app/projects/{project}/setup-check/stop", requires: "full" },
  // Wiki W0: a project's free file map (code host listings only: no model call, nothing spent or stored): full access only, then a live company owner or admin, or the project's administrator, to make one;
  // any person with a role on the project reads a kept one.
  { method: "GET", path: "/v1/app/projects/{project}/wiki-map", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/wiki-map", requires: "full" },
  // Lead 4 W2: the project wiki's reads (core-host/wiki-routes.ts): full access only, then any live role on the project (a company owner or admin, or a project grant). No writes here.
  { method: "GET", path: "/v1/app/projects/{project}/wiki", requires: "full" },
  { method: "GET", path: "/v1/app/projects/{project}/wiki/search", requires: "full" },
  { method: "GET", path: "/v1/app/projects/{project}/wiki/pages/{pageId}", requires: "full" },
  { method: "GET", path: "/v1/app/projects/{project}/wiki/pages/{pageId}/sources", requires: "full" },
  // Lead 4 L4-MF3: the company-wide agent directory (core-host/agent-directory-routes.ts): full access only, then a LIVE company owner or administrator (anyone else gets a fixed 403). Read only.
  { method: "GET", path: "/v1/app/agents", requires: "full" },
  // Lead 4 L4-LP3W: the team's approved lessons an agent is told in the page's code area (any live role on the project; nothing is written).
  { method: "GET", path: "/v1/app/projects/{project}/wiki/pages/{pageId}/lessons", requires: "full" },
  // L4-D (DEC 254z b): "Use this setup" (a candidate and its check), dropping it, and deciding it (the risk-based approver rule: a project maintainer for low and
  // medium risk, a company owner or admin for high).
  { method: "POST", path: "/v1/app/projects/{project}/setup-agent/confirm", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/setup-agent/discard", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/setup-agent/decide", requires: "full" },
  // Lead 4 C1: the wiki's corrections (core-host/wiki-corrections-routes.ts): full access only, then the caller's role on the project is read live (any role reads what it may do; a contributor adds notes and
  // marks; a maintainer approves, resolves and reads the disputed list). Additive: no existing row changed.
  { method: "GET", path: "/v1/app/projects/{project}/wiki/pages/{pageId}/corrections", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/wiki/pages/{pageId}/notes", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/wiki/pages/{pageId}/notes/{noteId}/approve", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/wiki/pages/{pageId}/notes/{noteId}/delete", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/wiki/pages/{pageId}/notes/{noteId}/suggest-lesson", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/wiki/pages/{pageId}/notes/{noteId}/acknowledge", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/wiki/pages/{pageId}/flags", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/wiki/pages/{pageId}/flags/resolve", requires: "full" },
  { method: "GET", path: "/v1/app/projects/{project}/wiki/disputed", requires: "full" },
  // Lead 4 A1/A2: the admin portal's cost and time report. Full access only, then a live company owner or admin (reads and feature changes), or the task's starter or a project maintainer (filing a task under a feature).
  { method: "GET", path: "/v1/app/org/report/tasks", requires: "full" },
  { method: "GET", path: "/v1/app/org/report/features", requires: "full" },
  { method: "POST", path: "/v1/app/org/report/features", requires: "full" },
  { method: "POST", path: "/v1/app/org/report/features/{featureId}/rename", requires: "full" },
  { method: "POST", path: "/v1/app/org/report/features/{featureId}/merge", requires: "full" },
  { method: "POST", path: "/v1/app/org/report/features/{featureId}/state", requires: "full" },
  { method: "POST", path: "/v1/app/tasks/{taskId}/feature", requires: "full" },
  // Lead 4 W4: the wiki build controls (core-host/wiki-build-routes.ts): full access only, then any live role on the project reads the state; a live company owner or admin, or the project's
  // administrator, builds, continues, stops, refreshes, gives the wiki to agents and deletes it.
  { method: "GET", path: "/v1/app/projects/{project}/wiki-build", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/wiki-build", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/wiki-build/continue", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/wiki-build/stop", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/wiki-build/refresh", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/wiki-build/agents", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/wiki-build/delete", requires: "full" },
  // L4-SC (DEC 254z c): "Update setup" after a merged plan's setup change: the offers (managers only), making a candidate from one (the same flow as confirm: check, then the risk-based decision above), and "Not now".
  { method: "GET", path: "/v1/app/projects/{project}/setup-agent/updates", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/setup-agent/updates/prepare", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/setup-agent/updates/dismiss", requires: "full" },
  // Lead 4 J3: the start box's path suggestion (core-host/start-suggest-routes.ts): full access only, then any live role on the project. Starts nothing, stores nothing.
  { method: "POST", path: "/v1/app/projects/{project}/code/suggest", requires: "full" },
  // Lead 4 J1: the smart Just answer (core-host/answer-routes.ts): full access only, then any live role on the project. It spends on the company's own key through the gateway's answers purpose.
  { method: "POST", path: "/v1/app/projects/{project}/answers", requires: "full" },
  { method: "GET", path: "/v1/app/projects/{project}/tasks/{taskId}/answers", requires: "full" },
  // Lead 4 J5: answers feed the wiki. "Not right" is the asker's own press (core-host/answer-routes.ts); the gap list is read from the answer records, maintainers only (core-host/wiki-corrections-routes.ts). Additive.
  { method: "POST", path: "/v1/app/projects/{project}/answers/{answerId}/not-right", requires: "full" },
  { method: "GET", path: "/v1/app/projects/{project}/wiki/gaps", requires: "full" },
  // L4-SF (d): allow or refuse a website a setup run asked for: a company owner or admin (the high-risk rule), bound to the exact ask.
  { method: "POST", path: "/v1/app/projects/{project}/setup-agent/host-decide", requires: "full" },
  // SETUP-LIMITS: the project's setup-run limits (core-host/setup-run-routes.ts, core/setup-agent/limits.ts): full access only, then any live role on the project reads them; the people who start a run change them.
  { method: "GET", path: "/v1/app/projects/{project}/setup-agent/limits", requires: "full" },
  { method: "PUT", path: "/v1/app/projects/{project}/setup-agent/limits", requires: "full" },
  // Lead 4 N1: the nightly upkeep switch (core-host/upkeep-routes.ts): full access only, then any live role on the project reads it; a live company owner or admin, or the project's administrator, switches it.
  { method: "GET", path: "/v1/app/projects/{project}/upkeep", requires: "full" },
  { method: "PUT", path: "/v1/app/projects/{project}/upkeep", requires: "full" },
  // L4-EVCI2: the setup card's "Eval check from your CI" (core-host/eval-check-routes.ts): full access only, then any live role on the project reads the confirmed check; a live company owner or admin, or the project's administrator, reads the proposals and confirms one (or none).
  { method: "GET", path: "/v1/app/projects/{project}/ci-eval-check", requires: "full" },
  { method: "PUT", path: "/v1/app/projects/{project}/ci-eval-check", requires: "full" },
  // Audit gap 11b: a project's ticket-sharing settings (core-host/ticket-updates-routes.ts, the laptop's local/app/intake.ts route): full access only, then any live role on the project reads; a live company
  // owner or admin, or the project's administrator, changes them.
  // R1 + L1 6.2b: a project's waiting tickets (Linear app intake on the core) at the one address the laptop, MCP and CLI use (core-host/intake-routes.ts); full access only, and the route checks the live standing on the project.
  { method: "GET", path: "/v1/app/projects/{project}/intake", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/intake/{itemId}/start", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/intake/{itemId}/dismiss", requires: "full" },
  { method: "GET", path: "/v1/app/projects/{project}/intake/updates", requires: "full" },
  { method: "PUT", path: "/v1/app/projects/{project}/intake/updates", requires: "full" },
  // Lead 4 PCF: the plan card's "Change" lists the open features to pick from; the same people as the filing above (the task's starter, a maintainer, an owner or admin).
  { method: "GET", path: "/v1/app/tasks/{taskId}/feature-choices", requires: "full" },
  // L4-P3: the company's one control over Rovara's automatic runs (core-host/system-runs-routes.ts): full access only, then only a live company owner or admin reads it, allows it or withdraws it.
  { method: "GET", path: "/v1/app/company/system-runs", requires: "full" },
  { method: "PUT", path: "/v1/app/company/system-runs", requires: "full" },
  // PRIVATE-PACKAGES P1b: the company's package tokens (core-host/package-registries-routes.ts): full access only; any live member reads the status line, only a live owner or admin sets, replaces or deletes. No row answers a value.
  { method: "GET", path: "/v1/app/company/package-registries", requires: "full" },
  { method: "PUT", path: "/v1/app/company/package-registries", requires: "full" },
  { method: "DELETE", path: "/v1/app/company/package-registries", requires: "full" },
  // L4-EVC (DEC 254zzz20): the project's ONE eval card (dollars), its single approval (confirm and approve the eval's spend in one act: the live owner/admin/maintainer rule). Full access only, like the setup candidate.
  { method: "GET", path: "/v1/app/projects/{project}/setup-agent/eval", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/setup-agent/eval-approve", requires: "full" },
  // L4-EVW2 (DEC 254zzz20 D2): "Try again" for Rovara's proposed wrapper file (a pull request on the repository that a person merges; Rovara never merges it): full access only, then the live owner/admin/maintainer rule.
  { method: "POST", path: "/v1/app/projects/{project}/setup-agent/eval-wrapper", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/setup-agent/eval-decide", requires: "full" },
  { method: "POST", path: "/v1/app/projects/{project}/setup-agent/eval-health", requires: "full" },
  // DEC 254zzz39 (6): the task owner's "Accept findings" on the web page, the one route that may accept a SECURITY finding on a core task (core-host/dev-routes.ts TASK_PAGE_FINDINGS): full access only, then the
  // web app's own client and the task's owner. Additive: no existing row changed.
  { method: "POST", path: "/v1/app/tasks/{taskId}/review-findings", requires: "full" },
  // DEC 254zzz94: the Merge button on a finished task (core-host/hosted-merge-routes.ts). Reading whether it would merge is a task read; the press is full access only, then the web app's own client
  // (DEC 254zzz91), the task owner / co-owner / project admin / company admin rule, Rovara's checks and GitHub's mergeable state. Additive: no existing row changed.
  { method: "GET", path: "/v1/app/tasks/{taskId}/merge", requires: "tasks:read" },
  { method: "POST", path: "/v1/app/tasks/{taskId}/merge", requires: "full" },
  // RD-2d: the file behind a link of the checks read (core-host/task-evidence-file-routes.ts): one stored file of the task's CURRENT evidence pack (command output as text/plain, a screenshot as image/jpeg), served after the
  // task read's own rule; anyone who may not read the task, and any digest the pack does not name, reads exactly as a missing task. Carries only `requires`, so it rides along unversioned (no schema, no new code).
  { method: "GET", path: "/v1/app/tasks/{taskId}/evidence/{sha}", requires: "tasks:read" },
  // Script tokens are long-lived credentials, and a person erase deletes a removed person's records: full access only (and a live owner or admin to make a token or erase).
  // #1175: the company's per-step agent model choice (core-host/agent-model-routes.ts): full access only, then the core reads the live role (any member reads,
  // an owner or admin changes). Without these rows the broker answered 404 before auth, and Cloud's "AI and spending" step could never finish.
  { method: "GET", path: "/v1/app/agent-models", requires: "full" },
  { method: "POST", path: "/v1/app/agent-models", requires: "full" },
  { method: "GET", path: "/v1/app/script-tokens", requires: "full" },
  { method: "POST", path: "/v1/app/script-tokens", requires: "full" },
  { method: "POST", path: "/v1/app/script-tokens/{tokenId}/revoke", requires: "full" },
  { method: "POST", path: "/v1/app/people/{personId}/erase", requires: "full" },
];

/** The /v1/dev/* rows, in table order. */
export const DEV_ROUTES: readonly Route[] = ROUTES.filter((route) => route.path.startsWith("/v1/dev/"));

/** The /v1/app/* rows (Lane L12), in table order. */
export const APP_ROUTES: readonly Route[] = ROUTES.filter((route) => route.path.startsWith("/v1/app/"));
