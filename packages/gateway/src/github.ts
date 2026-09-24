import { GuardRejection, type Access, type Binder, type ConnectorDefinition, type Guard } from "./types.js";
import { isObject, resultText } from "./util.js";

export interface GitHubRepositoryScope { name: string; url: string; credentialRef: string }

/** Mints a repository-scoped installation token and names the repository it is valid for. */
export type GitHubIssuer = (repository: GitHubRepositoryScope, access: Access) => Promise<{ owner: string; repo: string; token: string }>;

export const GITHUB_MCP_ENDPOINT = new URL("https://api.githubcopilot.com/mcp/");

/** The App's installation token is authoritative for owner and repo, so the binder takes them from it. */
export const githubBinder: Binder<GitHubRepositoryScope> = {
  properties: ["owner", "repo"],
  bind: (_scope, credential) => ({ owner: credential.bindings.owner, repo: credential.bindings.repo }),
};

/**
 * GitHub's issue endpoints also accept pull-request numbers. This scope guard keeps issue tools off
 * pull requests so AgentX's validated pull-request workflows cannot be bypassed.
 */
export const issueNotPullRequestGuard: Guard = {
  requiredTools: (tool, args) => args.issue_number !== undefined && tool !== "issue_read" ? ["issue_read"] : [],
  async check({ arguments: args, bound, connection }) {
    if (args.issue_number === undefined) return;
    const number = args.issue_number;
    if (!Number.isSafeInteger(number) || (number as number) < 1) throw new GuardRejection("Invalid issue number.");
    const result = await connection.call("issue_read", { method: "get", owner: bound.owner, repo: bound.repo, issue_number: number });
    if (result.isError) throw new Error("Issue preflight failed");
    const issue: unknown = JSON.parse(resultText(result));
    const expected = `https://github.com/${String(bound.owner)}/${String(bound.repo)}/issues/${number as number}`.toLowerCase();
    if (!isObject(issue) || issue.number !== number || typeof issue.html_url !== "string" || issue.html_url.toLowerCase() !== expected || issue.pull_request) {
      throw new GuardRejection("This integration requires an issue in the selected repository, not a pull request or another resource.");
    }
  },
};

export function githubConnector(issue: GitHubIssuer): ConnectorDefinition<GitHubRepositoryScope> {
  return {
    label: "GitHub",
    endpoint: GITHUB_MCP_ENDPOINT,
    permissionsHint: "GitHub App issue permissions",
    credentials: {
      async issue(scope, access) {
        const issued = await issue(scope, access);
        return { token: issued.token, bindings: { owner: issued.owner, repo: issued.repo } };
      },
    },
    binder: githubBinder,
    guards: [issueNotPullRequestGuard],
  };
}
