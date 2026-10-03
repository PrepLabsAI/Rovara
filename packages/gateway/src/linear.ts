import type { OwnershipRule } from "@agentx/contracts";
import { genericBinder, ownershipGuard, ownershipGuardedTools } from "./generic.js";
import type { Binder, ConnectorDefinition, CredentialProvider, Guard, GuardedItemTools } from "./types.js";

/** A Linear team a connector may address, by the alias the model sees and the team's UUID. */
export interface LinearTeamScope { alias: string; teamId: string }

export const LINEAR_MCP_ENDPOINT = new URL("https://mcp.linear.app/mcp");

/**
 * Linear names the team `team` (name or id) on some tools and `teamId` (id) on others. Both are
 * bound only on the tools that have them, always to the scope's team UUID. The guard reads the scope.
 */
export const LINEAR_BIND = { optional: { team: "teamId", teamId: "teamId" } } as const;
export const linearBinder: Binder<LinearTeamScope> = genericBinder<LinearTeamScope>(LINEAR_BIND);

/** Comment targets whose team cannot be proven with a Linear tool. */
const UNVERIFIABLE_COMMENT_TARGETS = ["id", "parentId", "projectId", "initiativeId", "documentId", "milestoneId", "statusUpdateId", "statusUpdateType"];
const COMMENT_TOOLS = ["save_comment", "list_comments"];

/**
 * The API key may reach more teams than the project scopes. Before a call addresses an existing
 * issue, read it with get_issue and refuse unless its `teamId` is the scope's team, so nothing is
 * sent otherwise (spec 055: Linear's guard as data).
 * - get_issue, save_issue (update), list_comments and save_comment name the issue they act on;
 *   save_issue also names a parent, a duplicate and lists of related and blocking issues.
 * - Comments are only allowed on issues, since no Linear tool proves the team of another target.
 * - includeRelations is refused: related issues can belong to another team get_issue would return.
 */
export const LINEAR_OWNERSHIP: OwnershipRule = {
  mode: "ownership",
  itemNoun: "issue",
  references: {
    get_issue: ["id"],
    save_issue: ["id", "parentId", "duplicateOf", "relatedTo[]", "blocks[]", "blockedBy[]", "removeRelatedTo[]", "removeBlocks[]", "removeBlockedBy[]"],
    list_comments: ["issueId"],
    save_comment: ["issueId"],
  },
  lookup: { tool: "get_issue", argument: "id" },
  // The live get_issue result carries the team UUID as top-level `teamId` (`team` is the name).
  field: "teamId",
  equals: "teamId",
  caseInsensitive: true,
  refuse: [
    {
      tools: ["get_issue"], arguments: ["includeRelations"], equals: true,
      message: "This {vendor} connector refuses get_issue with includeRelations: true, because related issues can belong to another team it does not return.",
    },
    {
      tools: COMMENT_TOOLS, arguments: UNVERIFIABLE_COMMENT_TARGETS,
      message: "This {vendor} connector only works with comments on issues in the {alias} team, so {argument} is not allowed. Pass issueId.",
    },
  ],
  require: [{ tools: COMMENT_TOOLS, argument: "issueId", message: "Pass issueId: this {vendor} connector only works with comments on issues in the {alias} team." }],
  targetArguments: ["id", "issueId", "commentId"],
};

/**
 * Issue #49: the tools issueInTeamGuard checks, and the arguments a Linear tool names an issue or a
 * comment through. Registration's preflight warns about an approved tool outside the set that has one.
 */
export const LINEAR_GUARDED_ITEM_TOOLS: GuardedItemTools = ownershipGuardedTools(LINEAR_OWNERSHIP);

export const issueInTeamGuard: Guard = ownershipGuard(LINEAR_OWNERSHIP, { vendor: "Linear", scopeNoun: "team" });

export function linearConnector(credentials: CredentialProvider<LinearTeamScope>): ConnectorDefinition<LinearTeamScope> {
  return {
    label: "Linear",
    endpoint: LINEAR_MCP_ENDPOINT,
    permissionsHint: "the Linear API key's permissions and team access",
    credentials,
    binder: linearBinder,
    guards: [issueInTeamGuard],
    attributionKeys: ["description", "body"],
    // save_issue and save_comment update the item named by id, and create one without it.
    itemArguments: ["id"],
    guardedItemTools: LINEAR_GUARDED_ITEM_TOOLS,
  };
}
