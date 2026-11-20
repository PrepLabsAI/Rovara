import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { CI_RUNNER_PROJECT, CiRunnerStack } from "../../infra/lib/ci-runner.js";

// #1182: CI's CodeBuild-hosted runner for the linux-runtime job, an opt-in stack apart from the production app.
describe("the CI linux-runtime runner stack", () => {
  const template = Template.fromStack(new CiRunnerStack(new App(), "AgentXCiRunner", { env: { region: "us-east-1" } }));

  it("is a privileged 8 vCPU / 16 GB ARM GitHub Actions runner for this repository's queued workflow jobs, through the GitHub connection", () => {
    template.hasResourceProperties("AWS::CodeBuild::Project", {
      Name: CI_RUNNER_PROJECT,
      Environment: { Type: "ARM_CONTAINER", ComputeType: "BUILD_GENERAL1_LARGE", Image: "aws/codebuild/amazonlinux-aarch64-standard:3.0", PrivilegedMode: true },
      Source: { Type: "GITHUB", Location: "https://github.com/PrepLabsAI/Rovara", Auth: { Type: "CODECONNECTIONS", Resource: { Ref: "GitHubConnectionArn" } } },
      Triggers: { Webhook: true, FilterGroups: [[{ Type: "EVENT", Pattern: "WORKFLOW_JOB_QUEUED" }]] },
    });
    template.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 14 });
  });

  it("gives the runner its own logs and the connection, and nothing else", () => {
    const policies = Object.values(template.findResources("AWS::IAM::Policy"));
    const actions = policies.flatMap((policy) => (policy.Properties.PolicyDocument.Statement as Array<{ Action: string | string[] }>).flatMap((statement) => [statement.Action].flat()));
    for (const action of actions) expect(action, action).toMatch(/^(logs:|codeconnections:|codestar-connections:)/u);
  });

  it("is not part of the app unless asked for", () => {
    expect(buildAgentXApp().node.tryFindChild("AgentXCiRunner")).toBeUndefined();
  });
});
