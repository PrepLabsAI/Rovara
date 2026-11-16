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
  // Spec 065: one project the person may use; it shows only what they may use, so it needs no scope.
  { method: "GET", path: "/v1/dev/client/projects/{project}", requires: "none" },
  // Spec 065a: a project's members.
  { method: "GET", path: "/v1/dev/client/projects/{project}/members", requires: "projects:members" },
  { method: "PUT", path: "/v1/dev/client/projects/{project}/members/{developerId}", requires: "projects:members" },
  { method: "DELETE", path: "/v1/dev/client/projects/{project}/members/{developerId}", requires: "projects:members" },
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
  // Decisions: approve a plan or request changes; decide on the pull-request feedback proposal.
  { method: "POST", path: "/v1/dev/tasks/{taskId}/workflow/decision", requires: "decisions:decide" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/workflow/feedback-decision", requires: "decisions:decide" },
  // T3: invite administration is full-access only; live company admin/owner membership is still required.
  { method: "POST", path: "/v1/dev/company/preapprovals", requires: "full" },
  { method: "DELETE", path: "/v1/dev/company/preapprovals/{emailHash}", requires: "full" },
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

const COMPILED = DEV_ROUTES.map((route) => ({
  route,
  pattern: new RegExp(`^${route.path.split("/").map((segment) => /^\{[A-Za-z]+\}$/.test(segment) ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("/")}$`),
}));

/** The row for this method and raw (still percent-encoded) path, or undefined: refused. */
export function devRouteOf(method: string, pathname: string): DevRoute | undefined {
  return COMPILED.find(({ route, pattern }) => route.method === method && pattern.test(pathname))?.route;
}
