// The triggers each built-in agent suggests (Plan 4 Task 18, filled out in Task 27). They are Plan 4 data and never recipe content (Plan 3 R1-6): a built-in recipe lists
// `person` alone, and a suggestion starts nothing until a maintainer turns it on for a project (H8). Each is an event or schedule spec; a project's trigger copies the spec it
// turns on, so a later change to a suggestion changes no trigger that is already on.
import type { BuiltinAgentId } from "./agent.js";
import type { EventTriggerSpec, ScheduleTriggerSpec } from "./trigger-specs.js";

export type BuiltinTriggerSpec = EventTriggerSpec | ScheduleTriggerSpec;

/** People who belong to a repository: what a suggestion on a public repository is limited to. */
const MEMBERS_ONLY = ["OWNER", "MEMBER", "COLLABORATOR"];

// A suggestion's place in its list is part of its identity (a project's trigger for it is keyed by the index), so a list only ever grows at the end.
export const BUILTIN_TRIGGER_SUGGESTIONS: Record<BuiltinAgentId, ReadonlyArray<BuiltinTriggerSpec>> = {
  // Meta repo lane F: a label or an assignment on a Jira or GitHub issue asks Rovara Code for work. A trigger on one MUST name the label (or the assignee) that asks (`triggerProblems`);
  // who may start work is decided by the intake engine from the person who did it, never by the label.
  "rovara-code": [
    { kind: "event", source: "github", type: "issues.labeled" },
    { kind: "event", source: "github", type: "issues.assigned" },
    { kind: "event", source: "jira", type: "issue.labeled" },
    { kind: "event", source: "jira", type: "issue.assigned" },
  ],
  "ticket-triage": [
    { kind: "event", source: "linear", type: "issue.created" },
    { kind: "event", source: "jira", type: "issue.created" },
    { kind: "event", source: "github", type: "issues.opened", filter: { authorAssociation: MEMBERS_ONLY } },
  ],
  "root-cause-analyst": [
    { kind: "event", source: "sentry", type: "issue.created" },
    { kind: "event", source: "pagerduty", type: "incident.triggered" },
    { kind: "event", source: "cloudwatch", type: "alarm.fired" },
  ],
  "code-reviewer": [
    { kind: "event", source: "github", type: "pull_request.opened", filter: { authorAssociation: MEMBERS_ONLY } },
    { kind: "event", source: "github", type: "pull_request.ready_for_review", filter: { authorAssociation: MEMBERS_ONLY } },
  ],
  "deploy-reviewer": [
    { kind: "event", source: "github", type: "deployment_status.success", filter: { environment: ["production"] } },
    { kind: "event", source: "vercel", type: "deployment.succeeded", filter: { target: ["production"] } },
  ],
  "service-reviewer": [{ kind: "schedule", schedule: { kind: "weekly", at: "09:00", day: "MON" }, timezone: "UTC", missed: "run_once" }],
};
