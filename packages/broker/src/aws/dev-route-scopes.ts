// Migration plan v3.2, lane ID part 1 (DEC 214 decision 7): named scopes in front of Rovara's developer API.
// Every /v1/dev/* route the broker serves has exactly one row here, by method and path. A request whose method and
// path match no row is refused before anyone is authenticated (fail closed), so a new route is unreachable until it
// is given a row. A sign-in client's token reaches a row only with the row's scope; the Rovara CLI's own token
// reaches every row, as before.
import type { ClientScope } from "@agentx/contracts";

/**
 * What a row needs from a sign-in client's token:
 * - a named scope: the token carries it, and the client's registration still allows it;
 * - `full`: only the Rovara CLI or a client registered with full access (spec 066), which is off unless an
 *   administrator turns it on for that client;
 * - `none`: the route checks its caller itself (the access check, or a read that shows only what the person may use).
 */
export type DevRouteRequirement = ClientScope | "full" | "none";

export type DevRouteMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface DevRoute {
  method: DevRouteMethod;
  /** The path, with each `{name}` standing for one non-empty path segment. */
  path: string;
  requires: DevRouteRequirement;
}

export const DEV_ROUTES: readonly DevRoute[] = [
  { method: "GET", path: "/v1/dev/projects/{name}/settings", requires: "full" },
  { method: "PUT", path: "/v1/dev/projects/{name}/settings", requires: "full" },
  // M4a slice 3 (TE-D8): the company administrator's read of every project against the company's bounds.
  { method: "GET", path: "/v1/dev/company/settings-compliance", requires: "full" },
  // Spec 063 FR-004: a registered service's own route, authenticated by its secret or the person's token.
  { method: "POST", path: "/v1/dev/access", requires: "none" },
  // #634: the person chooses their own name.
  { method: "PUT", path: "/v1/dev/me/name", requires: "profile:name" },
  // Spec 065b: a project from a repository the GitHub App can reach.
  { method: "POST", path: "/v1/dev/client/projects", requires: "projects:create" },
  { method: "GET", path: "/v1/dev/client/repositories", requires: "projects:create" },
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
  // Lane W: a project's merge rules; full access only (the route also checks the project and, to loosen, a fresh step-up).
  { method: "GET", path: "/v1/dev/client/projects/{project}/code-settings", requires: "full" },
  { method: "PUT", path: "/v1/dev/client/projects/{project}/code-settings", requires: "full" },
  // Tasks: read.
  { method: "GET", path: "/v1/dev/projects", requires: "tasks:read" },
  { method: "GET", path: "/v1/dev/tasks", requires: "tasks:read" },
  { method: "GET", path: "/v1/dev/tasks/{taskId}", requires: "tasks:read" },
  { method: "GET", path: "/v1/dev/tasks/{taskId}/events", requires: "tasks:read" },
  { method: "GET", path: "/v1/dev/tasks/{taskId}/plan", requires: "tasks:read" },
  { method: "GET", path: "/v1/dev/tasks/{taskId}/people", requires: "tasks:read" },
  { method: "GET", path: "/v1/dev/tasks/{taskId}/people/requests/{requestId}", requires: "tasks:read" },
  { method: "GET", path: "/v1/dev/tasks/{taskId}/workflow/feedback", requires: "tasks:read" },
  // #644: comments and steering notes, a pull request's diff, plan-document comments.
  { method: "GET", path: "/v1/dev/tasks/{taskId}/messages", requires: "tasks:read" },
  { method: "GET", path: "/v1/dev/tasks/{taskId}/diff", requires: "tasks:read" },
  { method: "GET", path: "/v1/dev/tasks/{taskId}/comments", requires: "tasks:read" },
  // Tasks: start.
  { method: "POST", path: "/v1/dev/tasks", requires: "tasks:start" },
  // Tasks: act on a task the person may act on.
  { method: "POST", path: "/v1/dev/tasks/{taskId}/continue", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/cancel", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/close", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/pull-requests", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/people/role", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/people/take-ownership", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/workflow/retry", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/workflow/review", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/workflow/publish-retry", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/workflow/keep-pull-requests", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/workflow/send-back", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/workflow/review-findings", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/workflow/feedback-retry", requires: "tasks:act" },
  // #644: a comment, or steering the running step (which the route itself keeps to the task's owner).
  { method: "POST", path: "/v1/dev/tasks/{taskId}/messages", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/comments", requires: "tasks:act" },
  // Tasks: share (spec 067 readers, and the Slack share).
  { method: "POST", path: "/v1/dev/tasks/{taskId}/share", requires: "tasks:share" },
  { method: "GET", path: "/v1/dev/tasks/{taskId}/readers", requires: "tasks:share" },
  { method: "PUT", path: "/v1/dev/tasks/{taskId}/readers/{developerId}", requires: "tasks:share" },
  { method: "DELETE", path: "/v1/dev/tasks/{taskId}/readers/{developerId}", requires: "tasks:share" },
  // Lane W: merge a task's pull request; full access only, and a fresh step-up from a web client's verified token.
  { method: "POST", path: "/v1/dev/tasks/{taskId}/merge", requires: "full" },
  // Decisions: approve a plan or request changes; decide on the pull-request feedback proposal.
  { method: "POST", path: "/v1/dev/tasks/{taskId}/workflow/decision", requires: "decisions:decide" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/workflow/feedback-decision", requires: "decisions:decide" },
  // T3: invite administration is full-access only; live company admin/owner membership is still required.
  { method: "POST", path: "/v1/dev/company/preapprovals", requires: "full" },
  { method: "DELETE", path: "/v1/dev/company/preapprovals/{emailHash}", requires: "full" },
  // Lane LM8: the lessons API of one project of the caller's company (core-host/lessons-api.ts). Full access only, like the other company-admin routes; live membership and the project's roster still apply.
  { method: "GET", path: "/v1/dev/projects/{project}/lessons", requires: "full" },
  { method: "GET", path: "/v1/dev/projects/{project}/lessons/retire-requests", requires: "full" },
  { method: "GET", path: "/v1/dev/projects/{project}/lessons/mode", requires: "full" },
  { method: "PUT", path: "/v1/dev/projects/{project}/lessons/mode", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/lessons/mode/trial-offer", requires: "full" },
  { method: "GET", path: "/v1/dev/projects/{project}/lessons/weekly-summary", requires: "full" },
  { method: "PUT", path: "/v1/dev/projects/{project}/lessons/weekly-summary", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/lessons/{lessonId}/approve", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/lessons/{lessonId}/reject", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/lessons/{lessonId}/retire", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/lessons/{lessonId}/retire-request", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/lessons/decisions", requires: "full" },
  { method: "GET", path: "/v1/dev/projects/{project}/tasks/{taskId}/lessons", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/tasks/{taskId}/lessons/{lessonId}/not-helpful", requires: "full" },
  // The Home number "Corrections you had to repeat" (core-host/lessons-repeats-api.ts): one project (its roster), or the company (owners and admins). Full access only, live membership.
  { method: "GET", path: "/v1/dev/projects/{project}/lessons/repeats", requires: "full" },
  { method: "GET", path: "/v1/dev/lessons/repeats", requires: "full" },
  // Lane W part 4: the company administrator's routes; full access only (DEC ANSWER-4), then a live admin or owner membership, and a fresh step-up to change anyone.
  { method: "GET", path: "/v1/dev/company/members", requires: "full" },
  { method: "GET", path: "/v1/dev/company/members/{personId}/removal-preview", requires: "full" },
  { method: "POST", path: "/v1/dev/company/members/{personId}/removal", requires: "full" },
  { method: "PUT", path: "/v1/dev/company/members/{personId}/role", requires: "full" },
  // Guided onboarding PR 7: connect Linear by OAuth (live owner/admin), the connection's status (any member), disconnect (live owner, fresh step-up), and a project's Linear team
  // (owner/admin or the project's admin).
  { method: "POST", path: "/v1/dev/company/linear/connect", requires: "full" },
  { method: "POST", path: "/v1/dev/company/linear/complete", requires: "full" },
  { method: "GET", path: "/v1/dev/company/linear", requires: "full" },
  { method: "DELETE", path: "/v1/dev/company/linear", requires: "full" },
  { method: "GET", path: "/v1/dev/company/linear/projects/{project}", requires: "full" },
  { method: "PUT", path: "/v1/dev/company/linear/projects/{project}", requires: "full" },
  { method: "DELETE", path: "/v1/dev/company/linear/projects/{project}", requires: "full" },
  // L2-4: a project's waiting tickets (Linear app intake on the core); full access only (the route also checks the company owner/admin or the project's admin, live).
  { method: "GET", path: "/v1/dev/projects/{project}/intake", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/intake/{itemId}/start", requires: "full" },
  { method: "POST", path: "/v1/dev/projects/{project}/intake/{itemId}/dismiss", requires: "full" },
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
];

/**
 * Lane L12: the core engine's own /v1/app/* routes on the broker's HTTP API (aws/core-app-routes.ts), served only while the core switch serves. The same rule as DEV_ROUTES: a method and
 * path with no row here is refused before anyone is authenticated, and a sign-in client's token reaches a row only with its scope. Only the routes the core serves on AWS have rows (not
 * the laptop's asks, automations or page routes). Behind every row the core's own handler still takes the company from live membership and checks the person's level, grant or role.
 */
export const APP_ROUTES: readonly DevRoute[] = [
  // Sessions (the core's session routes): reading one's own sessions is a task read; following and presence are a reader's own marks.
  { method: "GET", path: "/v1/app/sessions", requires: "tasks:read" },
  { method: "GET", path: "/v1/app/sessions/{sessionId}", requires: "tasks:read" },
  { method: "POST", path: "/v1/app/sessions/{sessionId}/follow", requires: "tasks:read" },
  { method: "DELETE", path: "/v1/app/sessions/{sessionId}/follow", requires: "tasks:read" },
  { method: "POST", path: "/v1/app/sessions/{sessionId}/unfollow", requires: "tasks:read" },
  { method: "POST", path: "/v1/app/sessions/{sessionId}/presence", requires: "tasks:read" },
  // Acting on a session's task (each also needs the person's session level).
  { method: "POST", path: "/v1/app/sessions/{sessionId}/stop", requires: "tasks:act" },
  { method: "POST", path: "/v1/app/sessions/{sessionId}/retry", requires: "tasks:act" },
  { method: "POST", path: "/v1/app/sessions/{sessionId}/messages", requires: "tasks:act" },
  { method: "POST", path: "/v1/app/sessions/{sessionId}/answers", requires: "tasks:act" },
  { method: "POST", path: "/v1/app/sessions/{sessionId}/revise-plan", requires: "tasks:act" },
  { method: "POST", path: "/v1/app/sessions/{sessionId}/close", requires: "tasks:act" },
  // Decision cards: the list and every act on a card (an act also needs a fresh step-up, which a sign-in client's token never carries).
  { method: "GET", path: "/v1/app/decisions", requires: "decisions:decide" },
  { method: "POST", path: "/v1/app/decisions/{kind}/{subject}/approve", requires: "decisions:decide" },
  { method: "POST", path: "/v1/app/decisions/{kind}/{subject}/reject", requires: "decisions:decide" },
  { method: "POST", path: "/v1/app/decisions/{kind}/{subject}/request-changes", requires: "decisions:decide" },
  { method: "POST", path: "/v1/app/decisions/{kind}/{subject}/evidence-opened", requires: "decisions:decide" },
  // How we work (read only): no named scope reads a project's settings, so full access only.
  { method: "GET", path: "/v1/app/projects/{project}/how-we-work", requires: "full" },
  { method: "GET", path: "/v1/app/projects/{project}/playbook", requires: "full" },
  // Script tokens are long-lived credentials, and a person erase deletes a removed person's records: full access only (and a fresh step-up to make a token or erase).
  { method: "GET", path: "/v1/app/script-tokens", requires: "full" },
  { method: "POST", path: "/v1/app/script-tokens", requires: "full" },
  { method: "POST", path: "/v1/app/script-tokens/{tokenId}/revoke", requires: "full" },
  { method: "POST", path: "/v1/app/people/{personId}/erase", requires: "full" },
];

const compile = (routes: readonly DevRoute[]) => routes.map((route) => ({
  route,
  pattern: new RegExp(`^${route.path.split("/").map((segment) => /^\{[A-Za-z]+\}$/.test(segment) ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("/")}$`),
}));
const COMPILED = compile(DEV_ROUTES);
const APP_COMPILED = compile(APP_ROUTES);

/** The row for this method and raw (still percent-encoded) path, or undefined: refused. */
export function devRouteOf(method: string, pathname: string): DevRoute | undefined {
  return COMPILED.find(({ route, pattern }) => route.method === method && pattern.test(pathname))?.route;
}

/** Lane L12: the /v1/app/* row for this method and raw (still percent-encoded) path, or undefined: refused. */
export function appRouteOf(method: string, pathname: string): DevRoute | undefined {
  return APP_COMPILED.find(({ route, pattern }) => route.method === method && pattern.test(pathname))?.route;
}
