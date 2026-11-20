// #1182: an AWS CodeBuild-hosted GitHub Actions runner for CI's one long job, `linux-runtime` (.github/workflows/ci.yml); every other job stays on
// GitHub's free runners. Only when asked for (-c agentxCiRunner=enabled): no release deploys it, and it has nothing to do with the production app stacks.
//
// The project answers GitHub's WORKFLOW_JOB_QUEUED webhook for PrepLabsAI/Rovara: a job whose runs-on label is
// `codebuild-rovara-ci-linux-runtime-<run id>-<attempt>` runs in a fresh, privileged ARM container (Docker inside), one job per build. GitHub is
// reached through the account's existing CodeConnections GitHub connection (the release pipeline's), so no token is stored.
//
// The role can write this project's logs and use that connection, nothing else: CI's tests need no AWS access (the live-aws job keeps its own OIDC role).
import { CfnParameter, RemovalPolicy, Stack, type StackProps, aws_codebuild as codebuild, aws_iam as iam, aws_logs as logs } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { AGENTX_RELEASE_REPOSITORY_NAME, AGENTX_RELEASE_REPOSITORY_OWNER } from "./release-pipeline.js";

export const CI_RUNNER_PROJECT = "rovara-ci-linux-runtime";

export class CiRunnerStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);
    const connectionArn = new CfnParameter(this, "GitHubConnectionArn", {
      type: "String",
      allowedPattern: "^arn:aws[a-z-]*:(codestar-connections|codeconnections):[a-z0-9-]+:[0-9]{12}:connection/[0-9a-f-]{36}$",
      description: "The account's CodeConnections GitHub connection that can read PrepLabsAI/Rovara (the release pipeline's)",
    });
    const logGroup = new logs.LogGroup(this, "Logs", { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY });
    const role = new iam.Role(this, "Role", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      description: "CI's linux-runtime runner: its own logs and the GitHub connection only",
    });
    logGroup.grantWrite(role);
    role.addToPolicy(new iam.PolicyStatement({
      sid: "UseGitHubConnection",
      actions: ["codeconnections:UseConnection", "codeconnections:GetConnectionToken", "codeconnections:GetConnection",
        "codestar-connections:UseConnection", "codestar-connections:GetConnectionToken", "codestar-connections:GetConnection"],
      resources: [connectionArn.valueAsString],
    }));
    const project = new codebuild.CfnProject(this, "Project", {
      name: CI_RUNNER_PROJECT,
      description: "GitHub Actions runner for CI's linux-runtime job (#1182)",
      serviceRole: role.roleArn,
      source: {
        type: "GITHUB",
        location: `https://github.com/${AGENTX_RELEASE_REPOSITORY_OWNER}/${AGENTX_RELEASE_REPOSITORY_NAME}`,
        auth: { type: "CODECONNECTIONS", resource: connectionArn.valueAsString },
      },
      artifacts: { type: "NO_ARTIFACTS" },
      // 8 vCPU / 16 GB ARM (BUILD_GENERAL1_XLARGE is the next size up); privileged: the job builds images, runs Docker in Docker and sets iptables.
      environment: { type: "ARM_CONTAINER", computeType: "BUILD_GENERAL1_LARGE", image: "aws/codebuild/amazonlinux-aarch64-standard:3.0", privilegedMode: true },
      // A GitHub Actions runner project: one queued workflow job per build, for this repository only.
      triggers: { webhook: true, filterGroups: [[{ type: "EVENT", pattern: "WORKFLOW_JOB_QUEUED" }]] },
      timeoutInMinutes: 90,
      logsConfig: { cloudWatchLogs: { status: "ENABLED", groupName: logGroup.logGroupName } },
    });
    // CodeBuild checks the role when the project (and its webhook) is made: the role's policy must exist first.
    project.node.addDependency(role.node.findChild("DefaultPolicy"));
  }
}
