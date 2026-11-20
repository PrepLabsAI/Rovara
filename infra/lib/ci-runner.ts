// #1200: an AWS CodeBuild-hosted GitHub Actions runner for CI's test shards (the `test (n/N)` jobs in .github/workflows/ci.yml) on pull requests into
// mainline, where waiting for GitHub's free runners took too long. Every other job, and every other branch, stays on GitHub's free runners. Only when
// asked for (-c agentxCiRunner=enabled): no release deploys it, and it has nothing to do with the production app stacks.
//
// The project answers GitHub's WORKFLOW_JOB_QUEUED webhook for PrepLabsAI/Rovara: a job whose runs-on label is `codebuild-rovara-ci-tests-<run id>-<attempt>`
// runs in a fresh, unprivileged ARM container, one job per build. GitHub is reached through the account's existing CodeConnections GitHub connection (the
// release pipeline's), so no token is stored.
//
// The repository is public and a fork's pull request runs its own workflow file, so it could ask for this runner by its label. The webhook therefore starts a
// build only for a job whose GitHub actor is one of the trusted accounts (TrustedGitHubActorIds, the repository's writers): the build's role can use the
// GitHub connection, which a stranger's code must never reach. The role can write this project's logs and use that connection, nothing else (CI's tests need
// no AWS access; the live-aws job keeps its own OIDC role).
//
// #1193: CI's linux-runtime job cannot run here (CodeBuild's on-demand hosts run Linux 4.14; it needs 5.9), so the first version's linux-runtime project is gone.
import { CfnParameter, RemovalPolicy, Stack, type StackProps, aws_codebuild as codebuild, aws_iam as iam, aws_logs as logs } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { AGENTX_RELEASE_REPOSITORY_NAME, AGENTX_RELEASE_REPOSITORY_OWNER } from "./release-pipeline.js";

export const CI_RUNNER_PROJECT = "rovara-ci-tests";

export class CiRunnerStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);
    const connectionArn = new CfnParameter(this, "GitHubConnectionArn", {
      type: "String",
      allowedPattern: "^arn:aws[a-z-]*:(codestar-connections|codeconnections):[a-z0-9-]+:[0-9]{12}:connection/[0-9a-f-]{36}$",
      description: "The account's CodeConnections GitHub connection that can read PrepLabsAI/Rovara (the release pipeline's)",
    });
    const trustedActors = new CfnParameter(this, "TrustedGitHubActorIds", {
      type: "String",
      allowedPattern: "^[0-9]+(\\|[0-9]+)*$",
      description: "The numeric GitHub account ids whose jobs may run here, separated by | (the repository's writers)",
    });
    const logGroup = new logs.LogGroup(this, "Logs", { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY });
    const role = new iam.Role(this, "Role", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      description: "CI's test-shard runner: its own logs and the GitHub connection only",
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
      description: "GitHub Actions runner for CI's test shards on pull requests into mainline (#1200)",
      serviceRole: role.roleArn,
      source: {
        type: "GITHUB",
        location: `https://github.com/${AGENTX_RELEASE_REPOSITORY_OWNER}/${AGENTX_RELEASE_REPOSITORY_NAME}`,
        auth: { type: "CODECONNECTIONS", resource: connectionArn.valueAsString },
      },
      artifacts: { type: "NO_ARTIFACTS" },
      // 8 vCPU / 16 GB ARM: the memory of GitHub's runner (16 GB). On MEDIUM (8 GB) the test-services guard's ceilings, a share of the machine's memory, refuse
      // the 1 GiB helpers its tests make (429). Unprivileged: the shards need no Docker (their Docker tests are switched off unless asked for).
      environment: { type: "ARM_CONTAINER", computeType: "BUILD_GENERAL1_LARGE", image: "aws/codebuild/amazonlinux-aarch64-standard:3.0", privilegedMode: false },
      // A GitHub Actions runner project: one queued workflow job per build, for this repository only, and only a trusted account's job.
      triggers: {
        webhook: true,
        filterGroups: [[{ type: "EVENT", pattern: "WORKFLOW_JOB_QUEUED" }, { type: "ACTOR_ACCOUNT_ID", pattern: `^(${trustedActors.valueAsString})$` }]],
      },
      timeoutInMinutes: 60,
      logsConfig: { cloudWatchLogs: { status: "ENABLED", groupName: logGroup.logGroupName } },
    });
    // CodeBuild checks the role when the project (and its webhook) is made: the role's policy must exist first.
    project.node.addDependency(role.node.findChild("DefaultPolicy"));
  }
}
