// L1-RELEASE-TAG-TRIGGER: a Cloud tag push started a release run with CLOUD_PROD=on and CLOUD_REF=latest. A trigger cannot bind variables and the source action exposes no tag name, so
// every triggered run carries the variable DEFAULTS: CLOUD_REF=from-trigger (the Cloud Preflight resolves the one vX.Y.Z tag on CLOUD_SOURCE_COMMIT, else refuses) and CLOUD_PROD=off.
// Production stays behind a disabled transition that nothing in the pipeline's own roles can enable. Synthesized template only: no AWS.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  AGENTX_PRODUCTION_CODE_PREFLIGHT_PROJECT_NAME,
  CLOUD_PROD_DEFAULT,
  CLOUD_REF_FROM_TRIGGER,
  CLOUD_REF_LATEST,
  CLOUD_SOURCE_COMMIT_VARIABLE,
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
const template = Template.fromStack(new ReleasePipelineStack(new App(), "TagTriggerPipeline", { env: { region: "us-east-1" } }));
const pipeline = (Object.values(template.findResources("AWS::CodePipeline::Pipeline"))[0] as { Properties: Pipeline }).Properties;
const variablesOf = (action: Action): Record<string, string> => {
  const raw = action.Configuration.EnvironmentVariables as string | { "Fn::Join": [string, unknown[]] } | undefined;
  if (raw === undefined) return {};
  const text = typeof raw === "string" ? raw : raw["Fn::Join"][1].map((part) => (typeof part === "string" ? part : "<ref>")).join("");
  return Object.fromEntries((JSON.parse(text) as Array<{ name: string; value: string }>).map((variable) => [variable.name, variable.value]));
};
const cloudActions = (stage: string): Action[] => pipeline.Stages.find((candidate) => candidate.Name === stage)!.Actions.filter((action) => action.Configuration.PrimarySource === "CloudSource");
const defaultOf = (name: string): string | undefined => pipeline.Variables.find((variable) => variable.Name === name)?.DefaultValue;

describe("a Cloud tag push cannot reach Production on its own", () => {
  it("starts from exactly two triggers, a mainline push and a release-tag push, and neither one sets a variable", () => {
    expect(pipeline.Triggers.map((trigger) => trigger.GitConfiguration.SourceActionName)).toEqual(["GitHub", "CloudGitHub"]);
    for (const trigger of pipeline.Triggers) {
      expect(trigger.GitConfiguration.PullRequest).toBeUndefined();
      expect(Object.keys(trigger).sort()).toEqual(["GitConfiguration", "ProviderType"]);
      expect(Object.keys(trigger.GitConfiguration).sort()).toEqual(["Push", "SourceActionName"]);
    }
    expect(pipeline.Triggers[1]!.GitConfiguration.Push).toEqual([{ Tags: { Includes: ["v*.*.*"], Excludes: ["v*-*"] } }]);
  });

  it("carries CLOUD_REF=from-trigger, never latest, on every run a trigger starts", () => {
    // A triggered run has no variable values of its own: it takes the defaults.
    expect(defaultOf("CLOUD_REF")).toBe(CLOUD_REF_FROM_TRIGGER);
    expect(defaultOf("CLOUD_REF")).not.toBe(CLOUD_REF_LATEST);
    expect(CLOUD_REF_FROM_TRIGGER).not.toMatch(/^v\d+\.\d+\.\d+$/u);
    for (const stage of ["Beta", "Production"]) {
      for (const action of cloudActions(stage)) {
        const variables = variablesOf(action);
        // The ref is the pipeline variable (so a run started by hand may override it), never a literal in the definition, and the commit the Cloud source resolved goes with it.
        expect(variables.CLOUD_REF, `${stage} ${action.Name}`).toBe("#{variables.CLOUD_REF}");
        // Beta's Preflight resolves the tag from it; Production's Preflight and the later steps read the resolved ref from the stage CLI's state (the 1000-character limit leaves no room for more).
        expect(variables[CLOUD_SOURCE_COMMIT_VARIABLE], `${stage} ${action.Name}`).toBe(stage === "Beta" && action.Name === "Preflight" ? "#{CloudSourceVariables.CommitId}" : undefined);
      }
    }
    // Nowhere in the pipeline is `latest` written as a value.
    expect(JSON.stringify(pipeline)).not.toContain(`"${CLOUD_REF_LATEST}"`);
    expect(JSON.stringify(pipeline.Variables.filter((variable) => variable.Name !== "CLOUD_REF"))).not.toContain(CLOUD_REF_LATEST);
  });

  it("carries CLOUD_PROD=off on every triggered run, and no action turns it on", () => {
    expect(CLOUD_PROD_DEFAULT).toBe("off");
    expect(defaultOf("CLOUD_PROD")).toBe("off");
    for (const stage of pipeline.Stages) {
      for (const action of stage.Actions) {
        const value = variablesOf(action).CLOUD_PROD;
        if (value !== undefined) expect(value, `${stage.Name} ${action.Name}`).toBe("#{variables.CLOUD_PROD}");
      }
    }
    expect(cloudActions("Production").length).toBeGreaterThan(0);
    for (const action of cloudActions("Production")) expect(variablesOf(action).CLOUD_PROD, action.Name).toBe("#{variables.CLOUD_PROD}");
    // Nothing else (a trigger, another variable's default) says `on`.
    expect(pipeline.Variables.filter((variable) => variable.DefaultValue === "on")).toEqual([]);
  });

  it("holds the Production stage behind a disabled transition, last, and every Production action sits after it", () => {
    expect(pipeline.DisableInboundStageTransitions).toEqual([{ StageName: "Production", Reason: PROMOTION_GATE_REASON }]);
    expect(pipeline.Stages.map((stage) => stage.Name)).toEqual(["Source", "Beta", "Production"]);
    const production = pipeline.Stages.find((stage) => stage.Name === "Production")!;
    // The way into the stage is the transition; the stage opens with its own Code Preflight (it closes the gate again) and then holds a manual approval of its own
    // (PROD-APPROVAL-BOUND, release-pipeline-prod-approval.test.ts): no Source or Beta action is a Production project.
    expect(production.Actions[0]!.Name).toBe("CodePreflight");
    expect(production.Actions[0]!.RunOrder).toBe(1);
    expect(JSON.stringify(production.Actions[0]!.Configuration.ProjectName)).toContain("ProductionCodePreflight");
    expect(production.Actions[1]!.Name).toBe("ApproveProduction");
    expect(production.Actions[1]!.RunOrder).toBe(2);
    for (const stage of pipeline.Stages.filter((candidate) => candidate.Name !== "Production")) {
      for (const action of stage.Actions) {
        expect(JSON.stringify(action.Configuration), `${stage.Name} ${action.Name}`).not.toMatch(/Production(CodePreflight|ProjectName)|release-agentx-production|ReleaseProduction/u);
      }
    }
    // Approval is the transition AND one manual approval per run, which a person answers (no role of the template can: release-pipeline-prod-approval.test.ts); every Production action is inside the gated stage.
    expect(pipeline.Stages.flatMap((stage) => stage.Actions).filter((action) => action.ActionTypeId.Category === "Approval").map((action) => action.Name)).toEqual(["ApproveProduction"]);
    expect(production.Actions.map((action) => action.ActionTypeId.Category)).toEqual(["Build", "Approval", ...production.Actions.slice(2).map(() => "Build")]);
  });

  it("gives no role in the template the right to open the transition, and the Production Preflight closes it again first", () => {
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
