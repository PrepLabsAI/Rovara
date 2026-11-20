import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { CI_RUNNER_PROJECT, CiRunnerStack } from "../../infra/lib/ci-runner.js";

// #1200: CI's CodeBuild-hosted runner for the test shards of pull requests into mainline, an opt-in stack apart from the production app.
type Resource = { Properties: Record<string, unknown> };
type Triggers = { Webhook: boolean; FilterGroups: Array<Array<{ Type: string; Pattern: unknown }>> };

describe("the CI test-shard runner stack", () => {
  const template = Template.fromStack(new CiRunnerStack(new App(), "AgentXCiRunner", { env: { region: "us-east-1" } }));
  const resources = (type: string): Resource[] => Object.values(template.findResources(type) as Record<string, Resource>);

  it("is an unprivileged 8 vCPU / 16 GB ARM GitHub Actions runner for this repository's queued workflow jobs, through the GitHub connection", () => {
    template.hasResourceProperties("AWS::CodeBuild::Project", {
      Name: CI_RUNNER_PROJECT,
      Environment: { Type: "ARM_CONTAINER", ComputeType: "BUILD_GENERAL1_LARGE", Image: "aws/codebuild/amazonlinux-aarch64-standard:3.0", PrivilegedMode: false },
      Source: { Type: "GITHUB", Location: "https://github.com/PrepLabsAI/Rovara", Auth: { Type: "CODECONNECTIONS", Resource: { Ref: "GitHubConnectionArn" } } },
    });
    template.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 14 });
    expect(Object.keys(template.findResources("AWS::CodeBuild::Project"))).toHaveLength(1);
  });

  it("starts a build only for a trusted account's job: a fork's pull request can name the runner's label in its own workflow", () => {
    const [project] = resources("AWS::CodeBuild::Project");
    const triggers = project!.Properties.Triggers as Triggers;
    expect(triggers.Webhook).toBe(true);
    expect(triggers.FilterGroups).toHaveLength(1);
    expect(triggers.FilterGroups[0]).toEqual([
      { Type: "EVENT", Pattern: "WORKFLOW_JOB_QUEUED" },
      { Type: "ACTOR_ACCOUNT_ID", Pattern: { "Fn::Join": ["", ["^(", { Ref: "TrustedGitHubActorIds" }, ")$"]] } },
    ]);
    template.hasParameter("TrustedGitHubActorIds", { Type: "String", AllowedPattern: "^[0-9]+(\\|[0-9]+)*$" });
    const { Parameters } = template.toJSON() as { Parameters: Record<string, { AllowedPattern: string }> };
    const allowed = new RegExp(Parameters.TrustedGitHubActorIds!.AllowedPattern, "u");
    expect(allowed.test("123|456")).toBe(true);
    expect(allowed.test(".*")).toBe(false);
  });

  it("gives the runner its own logs and the connection, and nothing else", () => {
    const actions = resources("AWS::IAM::Policy").flatMap((policy) => (policy.Properties.PolicyDocument as { Statement: Array<{ Action: string | string[] }> }).Statement.flatMap((statement) => [statement.Action].flat()));
    for (const action of actions) expect(action, action).toMatch(/^(logs:|codeconnections:|codestar-connections:)/u);
  });

  it("is not part of the app unless asked for", () => {
    expect(buildAgentXApp().node.tryFindChild("AgentXCiRunner")).toBeUndefined();
  });
});
