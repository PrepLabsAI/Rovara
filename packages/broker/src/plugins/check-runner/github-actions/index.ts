// Plug-in foundations, task P3: GitHub Actions as a CheckRunner. A listing is the checks GitHub reports on a pull request's head (the same read merge tracking
// makes), and a log is a job's log tail. It wraps `GitHubAppCredentialProvider`; `github-app.ts` is not edited. It lists by change request only: GitHub's read
// is a pull request's status, so a bare revision (or a run) is refused rather than answered with an empty list.
import {
  agentXError, CheckLookupSchema, CheckRunFactsSchema, HostScopeSchema, LatestCheckSchema, SeenCheckSchema,
  type Check, type CheckLookup, type CheckRunFacts, type CheckRunner, type CheckRunnerCapabilities, type CheckTarget, type HostScope, type LatestCheck, type ReadBudget, type RepositoryRef, type SeenCheck, type UntrustedText,
} from "@agentx/contracts";
import { checkOf, pullRequestNumber } from "../../code-host/github/mapping.js";
import { isActionsApp } from "../../../github-check-facts.js";
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

    // TE-E0 option A. Each read is offered only when the client has it; every answer is checked against the port's schema, and one that does not fit is "not known" (undefined), never a guess.
    ...(provider.getCheckRunFacts === undefined ? {} : {
      async runFacts(target: CheckTarget, check: Check, scope: HostScope, budget?: ReadBudget): Promise<CheckRunFacts | undefined> {
        const checked = checkedScope(scope);
        if (check.runId === undefined) return undefined;
        const repository = target.kind === "change-request" ? target.ref.repository : target.repository;
        const appId = check.source === undefined ? undefined : Number(check.source);
        const facts = await provider.getCheckRunFacts!(repository.url, check.runId, checked, budget, { actionsJob: appId === undefined || isActionsApp(appId) });
        const parsed = facts === undefined ? undefined : CheckRunFactsSchema.safeParse(facts);
        return parsed?.success === true ? parsed.data : undefined;
      },
    }),
    ...(provider.getLatestCheckRun === undefined ? {} : {
      async latestCheck(repository: RepositoryRef, at: CheckLookup, wanted: { name: string; source?: string | undefined }, scope: HostScope, budget?: ReadBudget): Promise<LatestCheck | undefined> {
        const checked = checkedScope(scope);
        const lookup = CheckLookupSchema.safeParse(at);
        if (!lookup.success) throw agentXError("CONFIG_INVALID", "the check lookup is invalid");
        // A source that is not an app id cannot be one of GitHub's: nothing matches it.
        const appId = wanted.source === undefined ? undefined : /^[1-9][0-9]{0,15}$/u.test(wanted.source) ? Number(wanted.source) : Number.NaN;
        if (appId !== undefined && Number.isNaN(appId)) return undefined;
        const found = await provider.getLatestCheckRun!(repository.url, lookup.data, { name: wanted.name, ...(appId === undefined ? {} : { appId }) }, checked, budget);
        if (found === undefined) return undefined;
        const parsed = LatestCheckSchema.safeParse({ revision: found.headSha, check: checkOf(found.check) });
        if (!parsed.success) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned a check Rovara cannot read");
        return parsed.data;
      },
    }),
    ...(provider.listSeenCheckNames === undefined ? {} : {
      async seenChecks(repository: RepositoryRef, scope: HostScope, budget?: ReadBudget): Promise<{ checks: SeenCheck[]; complete: boolean }> {
        const listed = await provider.listSeenCheckNames!(repository.url, checkedScope(scope), budget);
        let complete = listed.complete === true;
        const checks = listed.checks.flatMap((entry) => {
          const parsed = SeenCheckSchema.safeParse(entry);
          if (!parsed.success) complete = false;
          return parsed.success ? [parsed.data] : [];
        });
        return { checks, complete };
      },
    }),
  };
}
