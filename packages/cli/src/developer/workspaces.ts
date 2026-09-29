// Spec 041: what `agentx workspaces` reads from the control plane, and what it prints when there is
// no browser to show it in. The page in ../workspaces-ui/ renders the same response.
import { DeveloperWorkspacesResponseSchema, type DeveloperWorkspace, type DeveloperWorkspacesResponse } from "@agentx/contracts";
import { sanitizeServerText } from "../auth.js";
import { developerGet } from "./commands.js";
import type { DeveloperSessionDeps } from "./session.js";

export interface DeveloperWorkspacesResult {
  env: string;
  url: string;
  workspaces: DeveloperWorkspacesResponse;
}

export async function fetchDeveloperWorkspaces(deps: DeveloperSessionDeps, env: string | undefined): Promise<DeveloperWorkspacesResult> {
  const { env: resolved, url, body } = await developerGet(deps, env, "/v1/dev/workspaces", DeveloperWorkspacesResponseSchema);
  return { env: resolved, url, workspaces: body };
}

/** What a workspace is doing, in a developer's words rather than the record's status name. */
export function workspaceState(workspace: DeveloperWorkspace): string {
  if (workspace.busy) return "working";
  switch (workspace.status) {
    case "READY":
      return "ready";
    case "BUSY":
      return "working";
    case "PREPARING":
    case "RESUMING":
      return "starting";
    case "UNPREPARED":
      return "not started";
    case "STOPPED":
      return "stopped";
    case "CLOSING":
      return "closing";
    case "CLOSED":
      return "closed";
    case "PREPARATION_FAILED":
      return "failed to start";
    case "UNHEALTHY":
      return "unhealthy";
  }
}

/** The workspaces of one project, newest first. */
export function workspacesOfProject(response: DeveloperWorkspacesResponse, project: string): DeveloperWorkspace[] {
  return response.workspaces.filter((workspace) => workspace.projectName === project);
}

/** The text `agentx workspaces --no-ui` prints: every project, with the workspaces in it. */
export function workspacesText(result: DeveloperWorkspacesResult): string {
  const { developer, projects, notices } = result.workspaces;
  const lines = [`AgentX environment ${result.env} (${result.url}), signed in as ${sanitizeServerText(developer.name)}.`];
  if (projects.length === 0) {
    lines.push("You cannot use any project yet: join a project's Slack channel, or ask an admin for access.");
  }
  for (const project of projects) {
    const workspaces = workspacesOfProject(result.workspaces, project.name);
    lines.push("", `${project.name}  (revision ${project.latestRevision}, ${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"})`);
    if (workspaces.length === 0) {
      lines.push("  no workspaces yet: start a thread in this project's Slack channel");
      continue;
    }
    for (const workspace of workspaces) {
      lines.push(`  ${workspace.id}  ${workspaceState(workspace).padEnd(14)} revision ${workspace.projectRevision}  updated ${workspace.updatedAt}`);
    }
  }
  if (notices.includes("slack_unavailable")) {
    lines.push("", "Slack could not be reached, so projects you use through a Slack channel are not listed; try again later.");
  }
  return `${lines.join("\n")}\n`;
}
