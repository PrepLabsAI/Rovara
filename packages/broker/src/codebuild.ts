import {
  BatchGetBuildsCommand,
  CodeBuildClient,
  StartBuildCommand,
  type Build,
} from "@aws-sdk/client-codebuild";
import {
  CodeBuildCheckResultSchema,
  agentXError,
  type CodeBuildCheckResult,
} from "@agentx/contracts";

export interface CodeBuildGateway {
  start(input: {
    gate: string;
    projectName: string;
    commit: string;
    timeoutMinutes: number;
    idempotencyToken: string;
  }): Promise<CodeBuildCheckResult>;
  status(input: {
    gate: string;
    projectName: string;
    commit: string;
    buildId: string;
  }): Promise<CodeBuildCheckResult>;
}

type CodeBuildClientLike = Pick<CodeBuildClient, "send">;

export class AwsCodeBuildGateway implements CodeBuildGateway {
  constructor(private readonly client: CodeBuildClientLike) {}

  async start(input: Parameters<CodeBuildGateway["start"]>[0]): Promise<CodeBuildCheckResult> {
    const response = await this.client.send(new StartBuildCommand({
      projectName: input.projectName,
      sourceVersion: input.commit,
      timeoutInMinutesOverride: input.timeoutMinutes,
      idempotencyToken: input.idempotencyToken,
    }));
    if (!response.build) throw agentXError("RUNTIME_UNAVAILABLE", "CodeBuild returned no build");
    return normalizeBuild(response.build, input);
  }

  async status(input: Parameters<CodeBuildGateway["status"]>[0]): Promise<CodeBuildCheckResult> {
    const response = await this.client.send(new BatchGetBuildsCommand({ ids: [input.buildId] }));
    const build = response.builds?.[0];
    if (!build || response.builds?.length !== 1 || (response.buildsNotFound?.length ?? 0) > 0) {
      throw agentXError("RUNTIME_UNAVAILABLE", "CodeBuild build was not found");
    }
    return normalizeBuild(build, input);
  }
}

export function createCodeBuildGateway(configuration: ConstructorParameters<typeof CodeBuildClient>[0] = {}) {
  return new AwsCodeBuildGateway(new CodeBuildClient(configuration));
}

function normalizeBuild(
  build: Build,
  input: { gate: string; projectName: string; commit: string; buildId?: string },
): CodeBuildCheckResult {
  if (!build.id || !build.buildStatus || build.projectName !== input.projectName) {
    throw agentXError("RUNTIME_UNAVAILABLE", "CodeBuild returned an invalid build response");
  }
  if (input.buildId !== undefined && build.id !== input.buildId) {
    throw agentXError("RUNTIME_UNAVAILABLE", "CodeBuild returned a different build identity");
  }
  return CodeBuildCheckResultSchema.parse({
    gate: input.gate,
    projectName: input.projectName,
    buildId: build.id,
    status: build.buildStatus,
    requestedSourceVersion: input.commit,
    ...(build.resolvedSourceVersion === undefined ? {} : { resolvedSourceVersion: build.resolvedSourceVersion }),
    ...(build.currentPhase === undefined ? {} : { currentPhase: build.currentPhase }),
    ...(build.startTime === undefined ? {} : { startedAt: build.startTime.toISOString() }),
    ...(build.endTime === undefined ? {} : { completedAt: build.endTime.toISOString() }),
    ...(build.logs?.deepLink === undefined ? {} : { logsUrl: build.logs.deepLink }),
  });
}
