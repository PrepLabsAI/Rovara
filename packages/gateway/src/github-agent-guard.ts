// packages/gateway/src/github-agent-guard.ts
// The guard for an agent's GitHub calls. It replaces issueNotPullRequestGuard for agent calls only;
// the existing guard keeps serving the non-agent connector. Every owner and repo the model names must be
// the scope's bound repository; a pull request tool needs a pull request number that exists in it;
// add_issue_comment may name a pull request; every other issue tool refuses a pull request number.
import { issueNotPullRequestGuard } from "./github.js";
import { GuardRejection, type Guard, type GuardInput } from "./types.js";

/** Whether a pull request with this number exists in the repository. Injected: the gateway has no GitHub client of its own. */
export type PullRequestLookup = (input: { owner: string; repo: string; number: number }) => Promise<boolean>;

export interface AgentGitHubGuardDeps { pullRequestExists: PullRequestLookup }

const PULL_REQUEST_NUMBER_ARGUMENTS = ["pullNumber", "pull_number"] as const;
/** Tools that act on one pull request and so must name one. */
const PULL_REQUEST_TOOLS = /^(?:pull_request_read|pull_request_review_write|get_pull_request(?:_.+)?)$/u;
/** The one issue tool that may name a pull request (a pull request is an issue to GitHub's comment API). */
const COMMENT_ON_PULL_REQUEST_TOOL = "add_issue_comment";

const WRONG_REPOSITORY = "This integration can only use the selected repository.";

function boundRepository(bound: GuardInput["bound"]): { owner: string; repo: string } {
  const { owner, repo } = bound;
  if (typeof owner !== "string" || typeof repo !== "string" || owner === "" || repo === "") throw new GuardRejection(WRONG_REPOSITORY);
  return { owner, repo };
}

function checkRepository(args: GuardInput["arguments"], bound: { owner: string; repo: string }): void {
  const same = (value: string, expected: string) => value.toLowerCase() === expected.toLowerCase();
  if (args.owner !== undefined && (typeof args.owner !== "string" || !same(args.owner, bound.owner))) throw new GuardRejection(WRONG_REPOSITORY);
  if (args.repo !== undefined && (typeof args.repo !== "string" || !same(args.repo, bound.repo))) throw new GuardRejection(WRONG_REPOSITORY);
  if (args.repository !== undefined && (typeof args.repository !== "string" || !same(args.repository, `${bound.owner}/${bound.repo}`))) throw new GuardRejection(WRONG_REPOSITORY);
}

function pullRequestNumber(args: GuardInput["arguments"], required: boolean): number | undefined {
  const named = PULL_REQUEST_NUMBER_ARGUMENTS.filter((key) => args[key] !== undefined);
  if (named.length === 0) {
    if (required) throw new GuardRejection("This tool needs a pull request number in the selected repository.");
    return undefined;
  }
  const numbers = named.map((key) => args[key]);
  const [first] = numbers;
  if (typeof first !== "number" || !Number.isSafeInteger(first) || first < 1 || numbers.some((number) => number !== first)) {
    throw new GuardRejection("Invalid pull request number.");
  }
  return first;
}

export function agentGitHubGuard(deps: AgentGitHubGuardDeps): Guard {
  return {
    requiredTools: (tool, args) => tool === COMMENT_ON_PULL_REQUEST_TOOL ? [] : issueNotPullRequestGuard.requiredTools(tool, args),
    async check(input: GuardInput) {
      const bound = boundRepository(input.bound);
      checkRepository(input.arguments, bound);
      const number = pullRequestNumber(input.arguments, PULL_REQUEST_TOOLS.test(input.tool));
      if (number !== undefined && !(await deps.pullRequestExists({ ...bound, number }))) {
        throw new GuardRejection("This integration requires a pull request in the selected repository.");
      }
      if (input.tool === COMMENT_ON_PULL_REQUEST_TOOL) {
        const issue = input.arguments.issue_number;
        if (issue !== undefined && (typeof issue !== "number" || !Number.isSafeInteger(issue) || issue < 1)) throw new GuardRejection("Invalid issue number.");
        return;
      }
      await issueNotPullRequestGuard.check(input);
    },
  };
}
