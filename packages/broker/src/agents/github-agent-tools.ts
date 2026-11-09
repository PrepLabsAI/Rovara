// packages/broker/src/agents/github-agent-tools.ts
// The GitHub tools an agent can be granted (R63). An agent reads issues, pull requests and code, and
// writes issues, comments and reviews. It never pushes, merges, changes workflows or touches secrets:
// those happen only through Rovara Code's pull request flow. A call mints a token with exactly the
// permissions of the tool plus `metadata: read`, and `checkAgentTokenPermissions` refuses anything wider.
import { agentXError } from "@agentx/contracts";

export type GitHubAgentLevel = "read" | "write";

/** What a catalog entry may hold: `contents` is never `write`. */
export interface GitHubAgentToolPermissionSet {
  issues?: GitHubAgentLevel;
  pull_requests?: GitHubAgentLevel;
  contents?: "read";
}

/** What a token for one call carries: the tool's permissions plus `metadata: read`. `actions` and `deployments` are Plan 4's GitHub Actions connector's, at `read` only. */
export type GitHubAgentTokenPermissions = GitHubAgentToolPermissionSet & { metadata?: "read"; actions?: "read"; deployments?: "read" };

/** What a GitHub Actions tool's catalog entry may hold (Plan 4 Task 17): reads of workflow runs and deployments, and nothing else. */
export interface GitHubActionsToolPermissionSet {
  actions?: "read";
  deployments?: "read";
}

const ISSUES_READ = { issues: "read" } as const;
const ISSUES_WRITE = { issues: "write" } as const;
const PULL_REQUEST_READ = { pull_requests: "read", contents: "read" } as const;
const CONTENTS_READ = { contents: "read" } as const;

function frozenCatalog(entries: Record<string, GitHubAgentToolPermissionSet>): Readonly<Record<string, Readonly<GitHubAgentToolPermissionSet>>> {
  return Object.freeze(Object.fromEntries(Object.entries(entries).map(([tool, permissions]) => [tool, Object.freeze({ ...permissions })])));
}

/** The only GitHub tools an agent can be granted. A tool not listed here is refused. */
export const GITHUB_AGENT_TOOL_PERMISSIONS: Readonly<Record<string, Readonly<GitHubAgentToolPermissionSet>>> = frozenCatalog({
  get_issue: ISSUES_READ,
  issue_read: ISSUES_READ,
  get_issue_comments: ISSUES_READ,
  list_issues: ISSUES_READ,
  search_issues: ISSUES_READ,
  add_issue_comment: ISSUES_WRITE,
  update_issue: ISSUES_WRITE,
  create_issue: ISSUES_WRITE,
  issue_write: ISSUES_WRITE,
  pull_request_read: PULL_REQUEST_READ,
  get_pull_request: PULL_REQUEST_READ,
  get_pull_request_comments: PULL_REQUEST_READ,
  get_pull_request_diff: PULL_REQUEST_READ,
  get_pull_request_files: PULL_REQUEST_READ,
  get_pull_request_reviews: PULL_REQUEST_READ,
  get_pull_request_status: PULL_REQUEST_READ,
  list_pull_requests: PULL_REQUEST_READ,
  search_pull_requests: PULL_REQUEST_READ,
  pull_request_review_write: { pull_requests: "write" },
  list_commits: CONTENTS_READ,
  get_commit: CONTENTS_READ,
  get_file_contents: CONTENTS_READ,
  search_code: CONTENTS_READ,
});

const ACTIONS_READ = Object.freeze({ actions: "read" } as const);
const DEPLOYMENTS_READ = Object.freeze({ deployments: "read" } as const);

/**
 * Plan 4 Task 17: the permissions each GitHub Actions connector tool mints its token with, read-only by type. This is the connector's own catalog: the
 * Plan 3 refusal list below (`*workflow*`) belongs to the tools of the `github` connector and does not apply to it. A tool not listed here is refused.
 */
export const GITHUB_ACTIONS_AGENT_TOOL_PERMISSIONS: Readonly<Record<string, Readonly<GitHubActionsToolPermissionSet>>> = Object.freeze({
  list_workflow_runs: ACTIONS_READ,
  get_workflow_execution: ACTIONS_READ,
  list_execution_jobs: ACTIONS_READ,
  get_job_log: ACTIONS_READ,
  list_deployments: DEPLOYMENTS_READ,
  list_deployment_statuses: DEPLOYMENTS_READ,
});

/** The permissions a call to a GitHub Actions tool mints a token with: the tool's own plus `metadata: read`. A tool not in the catalog throws AGENT_TOOL_NOT_GRANTED. */
export function githubActionsToolPermissions(
  tool: string,
  catalog: Readonly<Record<string, Readonly<GitHubActionsToolPermissionSet>>> = GITHUB_ACTIONS_AGENT_TOOL_PERMISSIONS,
): GitHubAgentTokenPermissions {
  if (typeof tool !== "string" || !Object.hasOwn(catalog, tool)) throw agentXError("AGENT_TOOL_NOT_GRANTED", "That GitHub Actions tool is not available.");
  return { ...catalog[tool], metadata: "read" };
}

/**
 * Tools that are never presented and never run, whatever a project approved: a call is refused with
 * AGENT_TOOL_NOT_GRANTED. `*` matches any run of characters, so `*workflow*` and `*secret*` cover every
 * tool that names a workflow or a secret.
 */
export const GITHUB_AGENT_REFUSED_TOOLS: readonly string[] = Object.freeze([
  "push_files", "create_or_update_file", "delete_file", "create_branch", "create_repository", "fork_repository", "create_pull_request",
  "update_pull_request_branch", "merge_pull_request", "enable_pull_request_auto_merge", "*workflow*", "*secret*",
]);

export const GITHUB_AGENT_REFUSAL = "Pushes and merges happen only through Rovara Code's pull request flow.";

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "u");
}
const REFUSED_PATTERNS = GITHUB_AGENT_REFUSED_TOOLS.map(globToRegExp);

/** A tool name as the refusal list sees it: NFKC, without format characters, trimmed and lowercase, so `Merge_Pull_Request` and `merge_pull_<zero-width space>request` are the same tool. */
function comparable(tool: string): string {
  return tool.replace(/\p{Cf}/gu, "").normalize("NFKC").replace(/\p{Cf}/gu, "").trim().toLowerCase();
}

/** Whether a tool name is on the refusal list (exactly or by glob), however it is spelled. */
export function isGitHubAgentToolRefused(tool: string): boolean {
  if (typeof tool !== "string") return true;
  const name = comparable(tool);
  return REFUSED_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * The permissions a call to a granted tool mints a token with: the tool's own plus `metadata: read`. A
 * refused tool, a tool not in the catalog and a name that is not a string all throw
 * AGENT_TOOL_NOT_GRANTED with the pull request flow text. The refusal list wins over a catalog entry.
 */
export function githubAgentToolPermissions(
  tool: string,
  catalog: Readonly<Record<string, Readonly<GitHubAgentToolPermissionSet>>> = GITHUB_AGENT_TOOL_PERMISSIONS,
): GitHubAgentTokenPermissions {
  if (typeof tool !== "string" || isGitHubAgentToolRefused(tool) || !Object.hasOwn(catalog, tool)) {
    throw agentXError("AGENT_TOOL_NOT_GRANTED", GITHUB_AGENT_REFUSAL);
  }
  return { ...catalog[tool], metadata: "read" };
}

const TOKEN_PERMISSION_KEYS = new Set(["issues", "pull_requests", "contents", "metadata", "actions", "deployments"]);

function forbidden(problem: string): never {
  throw agentXError("FORBIDDEN", `An agent's GitHub token cannot carry ${problem}.`);
}

/**
 * Refuses any token permission an agent must never hold: `contents: write`, `workflows`, `administration`,
 * `actions: write`, `deployments: write`, and every key outside issues, pull_requests, contents, metadata, actions and
 * deployments. `contents`, `metadata`, `actions` and `deployments` may only be `read`; `issues` and `pull_requests` are `read` or `write`. Returns the checked
 * permissions. The token minter (14b) calls it before every request to GitHub.
 */
export function checkAgentTokenPermissions(permissions: unknown): GitHubAgentTokenPermissions {
  if (permissions === null || typeof permissions !== "object" || Array.isArray(permissions)) forbidden("anything but a permission map");
  const checked: Record<string, string> = {};
  for (const [key, level] of Object.entries(permissions)) {
    if (!TOKEN_PERMISSION_KEYS.has(key)) forbidden(`the ${JSON.stringify(key.slice(0, 40))} permission`);
    const allowed = key === "issues" || key === "pull_requests" ? level === "read" || level === "write" : level === "read";
    if (!allowed) forbidden(`${key}: ${JSON.stringify(typeof level === "string" ? level.slice(0, 20) : typeof level)}`);
    checked[key] = level as string;
  }
  return checked;
}
