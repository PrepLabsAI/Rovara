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
  // DEC 254w: connected sign-ins. Full access only (the web app); DeveloperIdentity also checks the session, the step-up and the person.
  { method: "GET", path: "/v1/dev/me/sign-ins", requires: "full" },
  { method: "POST", path: "/v1/dev/me/sign-ins/link", requires: "full" },
  { method: "POST", path: "/v1/dev/me/sign-ins/link/finish", requires: "full" },
  { method: "DELETE", path: "/v1/dev/me/sign-ins/{method}", requires: "full" },
  { method: "GET", path: "/v1/dev/company/members/{personId}/sign-ins", requires: "full" },
  { method: "DELETE", path: "/v1/dev/company/members/{personId}/sign-ins/{method}", requires: "full" },
  // L4-MF4: the caller's OWN confirmation email (masked) and passkeys, for the web account page. Full access only; no path or parameter names a person.
  { method: "GET", path: "/v1/dev/me/sign-in-factors", requires: "full" },
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
  // Lane W: a project's merge rules; full access only (the route also checks the project and, to loosen, a fresh step-up).
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
  // Cloud's Proof tab: the task's proof index (what the proof page shows as checked for its current code, and its failing tests), under the task read's own rule.
  { method: "GET", path: "/v1/dev/tasks/{taskId}/evidence", requires: "tasks:read" },
  // Tasks: start.
  { method: "POST", path: "/v1/dev/tasks", requires: "tasks:start" },
  // Tasks: act on a task the person may act on.
  { method: "POST", path: "/v1/dev/tasks/{taskId}/continue", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/cancel", requires: "tasks:act" },
  { method: "POST", path: "/v1/dev/tasks/{taskId}/close", requires: "tasks:act" },
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
  { method: "GET", path: "/v1/dev/projects/{project}/lessons/measure", requires: "full" },
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
  // Guided onboarding PR 1: connect the company's GitHub App installation (live owner/admin; the claim proves control on GitHub) and read the company's connections (any member).
  { method: "POST", path: "/v1/dev/company/github/connect", requires: "full" },
  { method: "POST", path: "/v1/dev/company/github/claim", requires: "full" },
  { method: "POST", path: "/v1/dev/company/github/choose", requires: "full" },
  { method: "GET", path: "/v1/dev/company/github", requires: "full" },
  // Guided onboarding PR 3: disconnect one installation (live owner, fresh step-up, refused while the company's projects use it).
  { method: "DELETE", path: "/v1/dev/company/github/{installationId}", requires: "full" },
  // L4-GH: a person links their own GitHub account to themselves (the web app only; Code checks the live membership, the fresh step-up and the GitHub user authorization itself).
  { method: "GET", path: "/v1/dev/me/github", requires: "full" },
  { method: "DELETE", path: "/v1/dev/me/github", requires: "full" },
  { method: "POST", path: "/v1/dev/me/github/link", requires: "full" },
  { method: "POST", path: "/v1/dev/me/github/link/claim", requires: "full" },
  // Guided onboarding PR 4: Add to Slack (live owner/admin; disconnect owner + step-up) and the company's Slack connection (any member).
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
  // Guided onboarding PR 7: connect Linear by OAuth (live owner/admin), the connection's status (any member), disconnect (live owner, fresh step-up), and a project's Linear team
  // (owner/admin or the project's admin).
  { method: "POST", path: "/v1/dev/company/linear/connect", requires: "full" },
  { method: "POST", path: "/v1/dev/company/linear/complete", requires: "full" },
  { method: "GET", path: "/v1/dev/company/linear", requires: "full" },
  { method: "DELETE", path: "/v1/dev/company/linear", requires: "full" },
  { method: "GET", path: "/v1/dev/company/linear/projects/{project}", requires: "full" },
  { method: "PUT", path: "/v1/dev/company/linear/projects/{project}", requires: "full" },
  { method: "DELETE", path: "/v1/dev/company/linear/projects/{project}", requires: "full" },
  // Guided onboarding PR 14 (DEC 254n item 1): the company's own engine model (read: any member; change: live owner/admin, checked against the gateway's live list for the company).
  { method: "GET", path: "/v1/dev/company/engine-model", requires: "full" },
  { method: "PUT", path: "/v1/dev/company/engine-model", requires: "full" },
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
  // DEC 254z-amend3: a project's test environment state (read only: whether test services are on, why they are not available here, the catalog). Like how we work, no named scope reads it: full access only.
  { method: "GET", path: "/v1/app/projects/{project}/test-environment", requires: "full" },
  // L4-B3b (DEC 254zm item 4): approving the proposal that waits (a fresh step-up, then the risk-based approver rule: a company owner or admin, or the project's maintainer for low and medium risk, an owner or admin for high).
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
  // L4-D (DEC 254z b): "Use this setup" (a candidate and its check), dropping it, and deciding it (a fresh step-up, then the risk-based approver rule: a project maintainer for low and
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
  // Lead 4 J5: answers feed the wiki. "Not right" is the asker's own press (core-host/answer-routes.ts); the gap list is read from the answer records, maintainers only (core-host/wiki-corrections-routes.ts). Additive.
  { method: "POST", path: "/v1/app/projects/{project}/answers/{answerId}/not-right", requires: "full" },
  { method: "GET", path: "/v1/app/projects/{project}/wiki/gaps", requires: "full" },
  // L4-SF (d): allow or refuse a website a setup run asked for: a company owner or admin (the high-risk rule), a fresh step-up, bound to the exact ask.
  { method: "POST", path: "/v1/app/projects/{project}/setup-agent/host-decide", requires: "full" },
  // Lead 4 N1: the nightly upkeep switch (core-host/upkeep-routes.ts): full access only, then any live role on the project reads it; a live company owner or admin, or the project's administrator, switches it.
  { method: "GET", path: "/v1/app/projects/{project}/upkeep", requires: "full" },
  { method: "PUT", path: "/v1/app/projects/{project}/upkeep", requires: "full" },
  // Lead 4 PCF: the plan card's "Change" lists the open features to pick from; the same people as the filing above (the task's starter, a maintainer, an owner or admin).
  { method: "GET", path: "/v1/app/tasks/{taskId}/feature-choices", requires: "full" },
  // L4-P3: the company's one control over Rovara's automatic runs (core-host/system-runs-routes.ts): full access only, then only a live company owner or admin reads it, allows it (a fresh step-up) or withdraws it.
  { method: "GET", path: "/v1/app/company/system-runs", requires: "full" },
  { method: "PUT", path: "/v1/app/company/system-runs", requires: "full" },
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
