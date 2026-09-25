import { GuardRejection, type Binder, type ConnectorDefinition, type CredentialProvider, type Guard } from "./types.js";
import { isObject, resultText } from "./util.js";

/** A Linear team a connector may address, by the alias the model sees and the team's UUID. */
export interface LinearTeamScope { alias: string; teamId: string }

export const LINEAR_MCP_ENDPOINT = new URL("https://mcp.linear.app/mcp");

/**
 * Linear names the team `team` (name or id) on some tools and `teamId` (id) on others. Both are
 * bound only on the tools that have them, always to the scope's team UUID. The guard reads the scope.
 */
export const linearBinder: Binder<LinearTeamScope> = {
  properties: [],
  optionalProperties: ["team", "teamId"],
  bind: (scope) => ({ team: scope.teamId, teamId: scope.teamId }),
};

/** The argument naming the issue each issue-addressed tool acts on. */
const ISSUE_ARGUMENT: Readonly<Record<string, string>> = { get_issue: "id", save_issue: "id", list_comments: "issueId", save_comment: "issueId" };
/** Comment targets whose team cannot be proven with a Linear tool. */
const UNVERIFIABLE_COMMENT_TARGETS = ["id", "parentId", "projectId", "initiativeId", "documentId", "milestoneId", "statusUpdateId", "statusUpdateType"] as const;
const NO_TEAM = "The Linear team check could not run, so the request was not sent.";

/** 5b passes the call's scope to every guard. Anything but a Linear team scope refuses the call. */
function scopeOf(scope: unknown): LinearTeamScope {
  if (!isObject(scope) || typeof scope.alias !== "string" || typeof scope.teamId !== "string" || scope.teamId === "") throw new GuardRejection(NO_TEAM);
  return { alias: scope.alias, teamId: scope.teamId };
}

/** The live get_issue result carries the team UUID as top-level `teamId` (`team` is the name). */
function teamIdOf(issue: unknown): string | undefined {
  return isObject(issue) && typeof issue.teamId === "string" ? issue.teamId : undefined;
}

/**
 * The API key may reach more teams than the project scopes. Before a call addresses an existing
 * issue, read it and refuse unless it belongs to the scope's team, so nothing is sent otherwise.
 */
export const issueInTeamGuard: Guard = {
  requiredTools(tool, args) {
    const key = ISSUE_ARGUMENT[tool];
    return key !== undefined && typeof args[key] === "string" ? ["get_issue"] : [];
  },
  async check({ tool, arguments: args, connection, scope }) {
    const key = ISSUE_ARGUMENT[tool];
    if (key === undefined) return;
    const team = scopeOf(scope);
    if (tool === "save_comment" || tool === "list_comments") {
      const other = UNVERIFIABLE_COMMENT_TARGETS.find((name) => args[name] !== undefined);
      if (other !== undefined) throw new GuardRejection(`This Linear connector only works with comments on issues in the ${team.alias} team, so ${other} is not allowed. Pass issueId.`);
      if (args.issueId === undefined) throw new GuardRejection(`Pass issueId: this Linear connector only works with comments on issues in the ${team.alias} team.`);
    }
    const id = args[key];
    if (id === undefined) return; // save_issue without id creates, and the binder sets its team.
    if (typeof id !== "string" || id.length === 0 || id.length > 128) throw new GuardRejection("Invalid Linear issue ID.");
    const shown = JSON.stringify(id.slice(0, 64));
    const result = await connection.call("get_issue", { id });
    if (result.isError) throw new GuardRejection(`Linear issue ${shown} was not found or this connector cannot see it.`);
    let issue: unknown;
    try { issue = JSON.parse(resultText(result)); } catch { issue = undefined; }
    const teamId = teamIdOf(issue);
    if (teamId === undefined) throw new GuardRejection(`Could not confirm that Linear issue ${shown} is in the ${team.alias} team, so the request was not sent.`);
    if (teamId.toLowerCase() !== team.teamId.toLowerCase()) throw new GuardRejection(`Linear issue ${shown} is not in the ${team.alias} team this connector may use.`);
  },
};

export function linearConnector(credentials: CredentialProvider<LinearTeamScope>): ConnectorDefinition<LinearTeamScope> {
  return {
    label: "Linear",
    endpoint: LINEAR_MCP_ENDPOINT,
    permissionsHint: "the Linear API key's permissions and team access",
    credentials,
    binder: linearBinder,
    guards: [issueInTeamGuard],
    attributionKeys: ["description", "body"],
  };
}
