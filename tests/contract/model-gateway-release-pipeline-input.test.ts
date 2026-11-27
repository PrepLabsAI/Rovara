// Issue #1578: Code owns and deploys its own model gateway directly from AgentXProductionRelease.
// In both Beta and Production, ModelGatewayImage -> ModelGatewayDeploy -> ModelGatewayCheck run in strict order
// BEFORE the Code release (ReleaseBeta / ReleaseProduction), reading only Code's Source artifact and chaining gateway state artifacts.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  AGENTX_BETA_MODEL_GATEWAY_PROJECT_NAME,
  AGENTX_PRODUCTION_MODEL_GATEWAY_PROJECT_NAME,
  MODEL_GATEWAY_STEPS,
  ReleasePipelineStack,
} from "../../infra/lib/release-pipeline.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

interface Action {
  Name: string;
  RunOrder: number;
  InputArtifacts?: Array<{ Name: string }>;
  OutputArtifacts?: Array<{ Name: string }>;
  Configuration?: Record<string, unknown>;
}
const template = Template.fromStack(new ReleasePipelineStack(new App(), "GatewayFromCodePipeline", { env: { region: "us-east-1" } }));
const pipeline = Object.values(template.findResources("AWS::CodePipeline::Pipeline"))[0] as {
  Properties: { Stages: Array<{ Name: string; Actions: Action[] }> };
};
const stage = (name: string): Action[] => pipeline.Properties.Stages.find((s) => s.Name === name)!.Actions;

describe("Code's own model gateway steps in AgentXProductionRelease (#1578)", () => {
  it("runs ModelGatewayImage, ModelGatewayDeploy, and ModelGatewayCheck in order before the Code release in both stages", () => {
    expect(MODEL_GATEWAY_STEPS.map((s) => `${s.action}:${s.step}`)).toEqual([
      "ModelGatewayImage:image",
      "ModelGatewayDeploy:deploy",
      "ModelGatewayCheck:check",
    ]);
    for (const [stageName, releaseAction] of [["Beta", "ReleaseBeta"], ["Production", "ReleaseProduction"]] as const) {
      const names = stage(stageName).map((a) => a.Name);
      expect(names.indexOf("ModelGatewayImage")).toBeLessThan(names.indexOf("ModelGatewayDeploy"));
      expect(names.indexOf("ModelGatewayDeploy")).toBeLessThan(names.indexOf("ModelGatewayCheck"));
      expect(names.indexOf("ModelGatewayCheck")).toBeLessThan(names.indexOf(releaseAction));
    }
  });

  it("chains Code's Source clone and gateway state artifacts from Beta through Production with no CloudSource", () => {
    const beta = stage("Beta");
    const prod = stage("Production");
    const inputsOf = (actions: Action[], name: string) => (actions.find((a) => a.Name === name)!.InputArtifacts ?? []).map((i) => i.Name);
    const outputsOf = (actions: Action[], name: string) => (actions.find((a) => a.Name === name)!.OutputArtifacts ?? []).map((o) => o.Name);

    expect(inputsOf(beta, "ModelGatewayImage")).toEqual(["Source"]);
    expect(outputsOf(beta, "ModelGatewayImage")).toEqual(["GatewayBetaImage"]);
    expect(inputsOf(beta, "ModelGatewayDeploy")).toEqual(["Source", "GatewayBetaImage"]);
    expect(outputsOf(beta, "ModelGatewayDeploy")).toEqual(["GatewayBetaDeploy"]);
    expect(inputsOf(beta, "ModelGatewayCheck")).toEqual(["Source", "GatewayBetaDeploy"]);
    expect(outputsOf(beta, "ModelGatewayCheck")).toEqual(["GatewayBetaCheck"]);

    // Production's ModelGatewayImage reads Beta's GatewayBetaCheck state so it copies Beta's exact digest.
    expect(inputsOf(prod, "ModelGatewayImage")).toEqual(["Source", "GatewayBetaCheck"]);
    expect(outputsOf(prod, "ModelGatewayImage")).toEqual(["GatewayProdImage"]);
    expect(inputsOf(prod, "ModelGatewayDeploy")).toEqual(["Source", "GatewayProdImage"]);
    expect(outputsOf(prod, "ModelGatewayDeploy")).toEqual(["GatewayProdDeploy"]);
    expect(inputsOf(prod, "ModelGatewayCheck")).toEqual(["Source", "GatewayProdDeploy"]);
    expect(outputsOf(prod, "ModelGatewayCheck")).toEqual(["GatewayProdCheck"]);

    template.hasResourceProperties("AWS::CodeBuild::Project", { Name: AGENTX_BETA_MODEL_GATEWAY_PROJECT_NAME });
    template.hasResourceProperties("AWS::CodeBuild::Project", { Name: AGENTX_PRODUCTION_MODEL_GATEWAY_PROJECT_NAME });
  });
});
