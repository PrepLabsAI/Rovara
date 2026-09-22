import {
  agentXError,
  type CodeBuildCheckResult,
  type CodeBuildGateDefinition,
} from "@agentx/contracts";

export interface CodeBuildRequest {
  action: "start" | "status";
  repository: string;
  gate: string;
  projectName: string;
  commit: string;
  buildId?: string;
}

export type CodeBuildSink = (request: CodeBuildRequest) => Promise<CodeBuildCheckResult>;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "FAULT", "STOPPED", "TIMED_OUT"]);

export async function runCodeBuildGates(input: {
  repository: string;
  commit: string;
  gates: readonly CodeBuildGateDefinition[];
  sink?: CodeBuildSink;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  pollIntervalMilliseconds?: number;
  queueAllowanceMilliseconds?: number;
}): Promise<CodeBuildCheckResult[]> {
  if (input.gates.length === 0) return [];
  if (!input.sink) throw agentXError("RUNTIME_UNAVAILABLE", "CodeBuild callback is not configured");
  const now = input.now ?? Date.now;
  const wait = input.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const pollInterval = input.pollIntervalMilliseconds ?? 5_000;
  const queueAllowance = input.queueAllowanceMilliseconds ?? 120_000;
  const results: CodeBuildCheckResult[] = [];

  for (const gate of input.gates) {
    const deadline = now() + gate.timeoutMinutes * 60_000 + queueAllowance;
    let build = await input.sink({
      action: "start",
      repository: input.repository,
      gate: gate.name,
      projectName: gate.projectName,
      commit: input.commit,
    });
    while (!TERMINAL.has(build.status)) {
      if (now() >= deadline) {
        throw gateFailure(build, "polling deadline expired");
      }
      await wait(pollInterval);
      build = await input.sink({
        action: "status",
        repository: input.repository,
        gate: gate.name,
        projectName: gate.projectName,
        commit: input.commit,
        buildId: build.buildId,
      });
    }
    if (build.status !== "SUCCEEDED") throw gateFailure(build, `finished with ${build.status}`);
    if (build.resolvedSourceVersion !== input.commit) {
      throw gateFailure(build, "resolved a different source revision");
    }
    results.push(build);
  }
  return results;
}

function gateFailure(build: CodeBuildCheckResult, reason: string) {
  const logs = build.logsUrl ? `; logs: ${build.logsUrl}` : "";
  const revision = build.resolvedSourceVersion
    ? `; requested ${build.requestedSourceVersion}; resolved ${build.resolvedSourceVersion}`
    : `; requested ${build.requestedSourceVersion}`;
  return agentXError(
    "CONFIG_INVALID",
    `CodeBuild gate ${build.gate} on ${build.projectName} (${build.buildId}) ${reason}${revision}${logs}`,
  );
}
