// Plug-in foundations, task P3: GitHub Actions as a CheckRunner. A listing is the checks GitHub reports on a pull request's head (the same read merge tracking
// makes), and a log is a job's log tail. It wraps `GitHubAppCredentialProvider`; `github-app.ts` is not edited. It lists by change request only: GitHub's read
// is a pull request's status, so a bare revision (or a run) is refused rather than answered with an empty list.
import { agentXError, HostScopeSchema, type Check, type CheckRunner, type CheckRunnerCapabilities, type CheckTarget, type HostScope, type ReadBudget, type UntrustedText } from "@agentx/contracts";
import { checkOf, pullRequestNumber } from "../../code-host/github/mapping.js";
import type { GitHubActionsProvider } from "../../code-host/github/provider.js";

export const GITHUB_ACTIONS_RUNNER_KIND = "github-actions";

export const GITHUB_ACTIONS_CAPABILITIES: CheckRunnerCapabilities = { listByChangeRequest: true, listByRevision: false, logTail: true, start: false, rerun: false };

export type { GitHubActionsProvider } from "../../code-host/github/provider.js";

function checkedScope(scope: HostScope): HostScope {
  const parsed = HostScopeSchema.safeParse(scope);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "the plug-in call has no valid scope");
  return parsed.data;
}

export function githubActionsCheckRunner(provider: GitHubActionsProvider): CheckRunner {
  return {
    kind: GITHUB_ACTIONS_RUNNER_KIND,
    capabilities: GITHUB_ACTIONS_CAPABILITIES,

    async listChecks(target: CheckTarget, scope: HostScope, budget?: ReadBudget): Promise<Check[]> {
      const checked = checkedScope(scope);
      if (target.kind !== "change-request") throw agentXError("CONFIG_INVALID", "GitHub Actions lists the checks of a change request only");
      const status = await provider.getPullRequestStatus(target.ref.repository.url, pullRequestNumber(target.ref), checked, budget);
      // The checks could not be read: they are not known, so no list is given (an empty one would read as "nothing is running").
      if (status.checksUnavailable === true) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub did not give the checks of this change request");
      return status.checks.map(checkOf);
    },

    async logTail(target: CheckTarget, check: Check, scope: HostScope, budget?: ReadBudget): Promise<UntrustedText | undefined> {
      const checked = checkedScope(scope);
      if (check.runId === undefined) return undefined;
      const repository = target.kind === "change-request" ? target.ref.repository : target.repository;
      return provider.getJobLogTail(repository.url, check.runId, checked, budget);
    },
  };
}
