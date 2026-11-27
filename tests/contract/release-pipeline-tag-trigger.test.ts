// Issue #1578: AgentXProductionRelease is Code-only. There is no Cloud source, Cloud tag trigger, Cloud parameter,
// Cloud variable, or Cloud action in the synthesized template, and Production stays gated behind its disabled transition and manual approval.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  AGENTX_PRODUCTION_CODE_PREFLIGHT_PROJECT_NAME,
  AGENTX_RELEASE_BRANCH,
  AGENTX_RELEASE_TRIGGER_PATHS,
  PROMOTION_GATE_REASON,
  ReleasePipelineStack,
} from "../../infra/lib/release-pipeline.js";

interface Action { Name: string; RunOrder: number; ActionTypeId: { Category: string; Provider: string }; Configuration: Record<string, unknown> }
interface Pipeline {
  Stages: Array<{ Name: string; Actions: Action[] }>;
  Variables: Array<{ Name: string; DefaultValue: string }>;
  DisableInboundStageTransitions?: Array<{ StageName: string; Reason: string }>;
  Triggers: Array<{ GitConfiguration: { SourceActionName: string; Push?: Array<Record<string, unknown>>; PullRequest?: unknown } }>;
}
const template = Template.fromStack(new ReleasePipelineStack(new App(), "CodeOnlyTriggerPipeline", { env: { region: "us-east-1" } }));
const json = template.toJSON() as { Parameters?: Record<string, unknown>; Outputs?: Record<string, unknown> };
const pipeline = (Object.values(template.findResources("AWS::CodePipeline::Pipeline"))[0] as { Properties: Pipeline }).Properties;

describe("AgentXProductionRelease has no Cloud trigger, source, parameter, variable, or action (#1578)", () => {
  it("starts from exactly one trigger: a qualifying push to Code mainline (no Cloud tag trigger)", () => {
    expect(pipeline.Triggers).toHaveLength(1);
    const [trigger] = pipeline.Triggers;
    expect(trigger!.GitConfiguration.SourceActionName).toBe("GitHub");
    expect(trigger!.GitConfiguration.PullRequest).toBeUndefined();
    expect(trigger!.GitConfiguration.Push).toEqual([
      { Branches: { Includes: [AGENTX_RELEASE_BRANCH] }, FilePaths: { Includes: [...AGENTX_RELEASE_TRIGGER_PATHS] } },
    ]);
    expect(JSON.stringify(pipeline.Triggers)).not.toContain("Tags");
    expect(JSON.stringify(pipeline.Triggers)).not.toContain("Cloud");
  });

  it("declares no Cloud parameters, variables, sources, actions, or ArtifactBucketName output", () => {
    const paramNames = Object.keys(json.Parameters ?? {}).filter((name) => name !== "BootstrapVersion");
    expect(paramNames.filter((name) => /Cloud/iu.test(name))).toEqual([]);
    expect(paramNames.sort()).toEqual(["BetaAccountId", "GitHubConnectionArn", "PortGuardNamesKeyArn", "PortGuardNamesParameterName"]);
    expect(pipeline.Variables.map((v) => v.Name)).toEqual(["CODE_RELEASE", "PIPELINE_MODE", "CODE_ROLLBACK_TARGET", "MODEL_GATEWAY_DIGEST"]);
    expect(Object.keys(json.Outputs ?? {})).not.toContain("ArtifactBucketName");
    expect(Object.keys(json.Outputs ?? {})).toContain("ProductionModelGatewayBuildRoleArn");
    const allActionNames = pipeline.Stages.flatMap((s) => s.Actions.map((a) => a.Name));
    expect(allActionNames.filter((name) => /Cloud/iu.test(name))).toEqual([]);
  });

  it("holds the Production stage behind a disabled transition and manual approval, with all Production writers after approval", () => {
    expect(pipeline.DisableInboundStageTransitions).toEqual([{ StageName: "Production", Reason: PROMOTION_GATE_REASON }]);
    expect(pipeline.Stages.map((stage) => stage.Name)).toEqual(["Source", "Beta", "Production"]);
    const production = pipeline.Stages.find((stage) => stage.Name === "Production")!;
    expect(production.Actions[0]!.Name).toBe("CodePreflight");
    expect(production.Actions[0]!.RunOrder).toBe(1);
    expect(production.Actions[1]!.Name).toBe("ApproveProduction");
    expect(production.Actions[1]!.RunOrder).toBe(2);
    for (const stage of pipeline.Stages.filter((candidate) => candidate.Name !== "Production")) {
      for (const action of stage.Actions) {
        expect(JSON.stringify(action.Configuration), `${stage.Name} ${action.Name}`).not.toMatch(/Production(CodePreflight|ModelGateway)|release-agentx-production|ReleaseProduction/u);
      }
    }
    expect(pipeline.Stages.flatMap((stage) => stage.Actions).filter((action) => action.ActionTypeId.Category === "Approval").map((action) => action.Name)).toEqual(["ApproveProduction"]);
    expect(production.Actions.map((action) => action.ActionTypeId.Category)).toEqual(["Build", "Approval", ...production.Actions.slice(2).map(() => "Build")]);
  });

  it("gives no role in the template the right to open the transition, and the Production Preflight closes it first", () => {
    const statements = (Object.values(template.findResources("AWS::IAM::Policy")) as Array<{ Properties: { PolicyDocument: { Statement: Array<{ Action: string | string[] }> } } }>)
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    const granted = statements.flatMap((statement) => [statement.Action].flat());
    expect(granted.filter((action) => /^(codepipeline:(EnableStageTransition|StartPipelineExecution|RetryStageExecution|PutApprovalResult|\*)|\*)$/u.test(action))).toEqual([]);
    const project = Object.values(template.findResources("AWS::CodeBuild::Project")).find((candidate) => (candidate as { Properties: { Name: string } }).Properties.Name === AGENTX_PRODUCTION_CODE_PREFLIGHT_PROJECT_NAME) as { Properties: { Source: { BuildSpec: string | { "Fn::Join": [string, unknown[]] } } } };
    const spec = project.Properties.Source.BuildSpec;
    const text = typeof spec === "string" ? spec : spec["Fn::Join"][1].map((part) => (typeof part === "string" ? part : "<token>")).join("");
    const commands = (JSON.parse(text) as { phases: { install: { commands: string[] } } }).phases.install.commands;
    expect(commands[0]).toMatch(/^aws codepipeline disable-stage-transition .* --stage-name Production /u);
  });
});
