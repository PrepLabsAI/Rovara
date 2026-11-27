// Issue #1578: Code decides its own release directly (no CODE_RELEASE=from-trigger, no Cloud Preflight export, no triggerCommands).
// A triggered run releases its Code commit (CODE_RELEASE defaults to "run"); a manual run can pass CODE_RELEASE=skip; PIPELINE_MODE=adopt skips Code release cleanly.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  AGENTX_BETA_CODE_PREFLIGHT_PROJECT_NAME,
  AGENTX_PRODUCTION_CODE_PREFLIGHT_PROJECT_NAME,
  CODE_RELEASE_CHECK,
  CODE_RELEASE_DEFAULT,
  CODE_RELEASE_EXPLICIT_VALUES,
  ReleasePipelineStack,
} from "../../infra/lib/release-pipeline.js";
import { runShell, scratch } from "../support/release-pipeline-shell.js";

interface Statement { Effect: string; Action: string | string[]; Resource: unknown }
interface Resource { Type: string; Properties: Record<string, unknown> }
const template = Template.fromStack(new ReleasePipelineStack(new App(), "CodeReleaseDirect", { env: { region: "us-east-1" } }));
const json = template.toJSON() as { Resources: Record<string, Resource> };
const pipeline = (Object.values(template.findResources("AWS::CodePipeline::Pipeline"))[0] as {
  Properties: {
    Variables: Array<{ Name: string; DefaultValue: string; Description: string }>;
    Triggers: unknown[];
    Stages: Array<{ Name: string; Actions: Array<{ Name: string; Configuration: Record<string, unknown> }> }>;
  };
}).Properties;
const text = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

describe("Code decides its own release directly (#1578)", () => {
  it("CODE_RELEASE defaults to run (not from-trigger) and every variable description stays within CodePipeline's 200-char limit", () => {
    expect(pipeline.Variables.map((variable) => variable.Name)).toEqual([
      "CODE_RELEASE", "PIPELINE_MODE", "CODE_ROLLBACK_TARGET", "MODEL_GATEWAY_DIGEST",
    ]);
    const variable = pipeline.Variables.find((candidate) => candidate.Name === "CODE_RELEASE")!;
    expect(variable.DefaultValue).toBe(CODE_RELEASE_DEFAULT);
    expect(variable.DefaultValue).toBe("run");
    expect(CODE_RELEASE_EXPLICIT_VALUES).toEqual(["run", "skip"]);
    for (const v of pipeline.Variables) expect(v.Description.length, v.Name).toBeLessThanOrEqual(200);
    expect(JSON.stringify(json)).not.toContain("from-trigger");
    expect(JSON.stringify(json)).not.toContain("CODE_RELEASE_EFFECTIVE");
  });

  it("Code release and model gateway actions read CODE_RELEASE directly from #{variables.CODE_RELEASE}", () => {
    const variablesOf = (action: { Configuration: Record<string, unknown> }): Record<string, string> => {
      const raw = action.Configuration.EnvironmentVariables as string | { "Fn::Join": [string, unknown[]] } | undefined;
      if (raw === undefined) return {};
      const joined = typeof raw === "string" ? raw : raw["Fn::Join"][1].map((part) => (typeof part === "string" ? part : "<ref>")).join("");
      return Object.fromEntries((JSON.parse(joined) as Array<{ name: string; value: string }>).map((v) => [v.name, v.value]));
    };
    for (const stage of pipeline.Stages.filter((candidate) => candidate.Name === "Beta" || candidate.Name === "Production")) {
      for (const action of stage.Actions) {
        const variables = variablesOf(action);
        if (variables.CODE_RELEASE !== undefined) {
          expect(variables.CODE_RELEASE, `${stage.Name} ${action.Name}`).toBe("#{variables.CODE_RELEASE}");
        }
      }
    }
  });

  it("a Code build accepts run and skip only and refuses from-trigger or any unknown value", () => {
    expect(CODE_RELEASE_CHECK).toBe('case "$CODE_RELEASE" in run|skip) ;; *) echo "CODE_RELEASE must be run or skip, got: $CODE_RELEASE" >&2; exit 1;; esac');
    const dir = scratch();
    for (const [value, status] of [["run", 0], ["skip", 0], ["from-trigger", 1], ["", 1], ["Run", 1]] as const) {
      expect(runShell(dir, [CODE_RELEASE_CHECK], { CODE_RELEASE: value }).status, value).toBe(status);
    }
  });

  it("Beta CodePreflight reads pipeline state only for supersession notes (no ListActionExecutions); Production only closes the gate", () => {
    const rolePolicy = (projectName: string): Statement[] => {
      const project = Object.values(json.Resources).find((resource) => resource.Type === "AWS::CodeBuild::Project" && resource.Properties.Name === projectName)!;
      const roleRef = (project.Properties.ServiceRole as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
      return Object.values(json.Resources)
        .filter((resource) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource.Properties.Roles).includes(roleRef))
        .flatMap((resource) => (resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
    };
    const actionsOf = (statements: Statement[]): string[] =>
      statements.filter((statement) => statement.Effect === "Allow").flatMap((statement) => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]));

    const betaActions = actionsOf(rolePolicy(AGENTX_BETA_CODE_PREFLIGHT_PROJECT_NAME)).filter((action) => action.startsWith("codepipeline:")).sort();
    expect(betaActions).toEqual(["codepipeline:GetPipelineExecution", "codepipeline:GetPipelineState"]);
    expect(text(rolePolicy(AGENTX_BETA_CODE_PREFLIGHT_PROJECT_NAME))).not.toContain("ListActionExecutions");

    const prodActions = actionsOf(rolePolicy(AGENTX_PRODUCTION_CODE_PREFLIGHT_PROJECT_NAME)).filter((action) => action.startsWith("codepipeline:"));
    expect(prodActions).toEqual(["codepipeline:DisableStageTransition"]);
  });
});
