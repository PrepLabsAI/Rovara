// Plug-in foundations, task P3: AWS CodeBuild as a CheckRunner, over the existing `CodeBuildGateway` (`broker/src/codebuild.ts`, not edited). CodeBuild has no
// "list the checks on a commit": a build is started for one gate at one revision and read again by its id, so this runner starts and reads runs and lists only
// a run it was told about. A repository is served only if it was registered with the runner; anything else is refused before the gateway is called.
import {
  agentXError, CheckStartRequestSchema, CheckTargetSchema, HostScopeSchema,
  type Check, type CheckRunner, type CheckRunnerCapabilities, type CheckRunRef, type CheckStartRequest, type CheckTarget, type HostScope, type ReadBudget, type UntrustedText,
} from "@agentx/contracts";
import type { CodeBuildCheckResult } from "@agentx/contracts";
import type { CodeBuildGateway } from "../../../codebuild.js";

export const CODEBUILD_RUNNER_KIND = "codebuild";

export const CODEBUILD_CAPABILITIES: CheckRunnerCapabilities = { listByChangeRequest: false, listByRevision: false, logTail: false, start: true, rerun: false };

export interface CodeBuildRunnerOptions {
  gateway: CodeBuildGateway;
  /** The repositories (by address) this runner may build. */
  allowedRepositories: readonly string[];
}

function checkedScope(scope: HostScope): void {
  if (!HostScopeSchema.safeParse(scope).success) throw agentXError("CONFIG_INVALID", "the plug-in call has no valid scope");
}

const CONCLUSION_OF: Readonly<Record<CodeBuildCheckResult["status"], Check["conclusion"]>> = {
  IN_PROGRESS: undefined, SUCCEEDED: "success", FAILED: "failure", FAULT: "error", STOPPED: "cancelled", TIMED_OUT: "timed_out",
};

/** A CodeBuild result as a neutral check: IN_PROGRESS is pending, every other status is a finished check with a conclusion. */
export function checkOfBuild(result: CodeBuildCheckResult): Check {
  const conclusion = CONCLUSION_OF[result.status];
  return {
    name: result.gate, state: conclusion === undefined ? "pending" : "completed", ...(conclusion === undefined ? {} : { conclusion }),
    required: false, url: result.logsUrl ?? "", runId: result.buildId, source: result.projectName,
  };
}

export function codeBuildCheckRunner(options: CodeBuildRunnerOptions): CheckRunner {
  const allowed = new Set(options.allowedRepositories);
  const requireRegistered = (url: string): void => {
    if (!allowed.has(url)) throw agentXError("CONFIG_INVALID", "the repository is not registered with this runner");
  };
  const readRun = async (target: Extract<CheckTarget, { kind: "run" }>): Promise<Check> => {
    requireRegistered(target.repository.url);
    if (target.project === undefined) throw agentXError("CONFIG_INVALID", "a CodeBuild run is read with its project");
    return checkOfBuild(await options.gateway.status({ gate: target.gate, projectName: target.project, commit: target.revision, buildId: target.run.id }));
  };
  return {
    kind: CODEBUILD_RUNNER_KIND,
    capabilities: CODEBUILD_CAPABILITIES,

    async listChecks(target: CheckTarget, scope: HostScope, budget?: ReadBudget): Promise<Check[]> {
      checkedScope(scope);
      budget?.beforeRequest();
      const parsed = CheckTargetSchema.parse(target);
      // CodeBuild cannot list by change request or revision: refuse, never answer an empty list for a target it cannot see.
      if (parsed.kind !== "run") throw agentXError("CONFIG_INVALID", "CodeBuild lists only a run it was told about");
      return [await readRun(parsed)];
    },

    // CodeBuild logs are not read through this runner.
    async logTail(_target: CheckTarget, _check: Check, scope: HostScope): Promise<UntrustedText | undefined> {
      checkedScope(scope);
      return undefined;
    },

    async start(request: CheckStartRequest, scope: HostScope): Promise<{ run: CheckRunRef; check: Check }> {
      checkedScope(scope);
      const parsed = CheckStartRequestSchema.parse(request);
      requireRegistered(parsed.repository.url);
      const result = await options.gateway.start({ gate: parsed.gate, projectName: parsed.project, commit: parsed.revision, timeoutMinutes: parsed.timeoutMinutes, idempotencyToken: parsed.idempotencyKey });
      return { run: { runner: CODEBUILD_RUNNER_KIND, id: result.buildId }, check: checkOfBuild(result) };
    },

    async getRun(target: Extract<CheckTarget, { kind: "run" }>, scope: HostScope): Promise<Check> {
      checkedScope(scope);
      return readRun(CheckTargetSchema.parse(target) as Extract<CheckTarget, { kind: "run" }>);
    },
  };
}
