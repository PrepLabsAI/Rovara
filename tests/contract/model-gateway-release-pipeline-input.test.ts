// #1478 phase 2, "both repos change": Code's pipeline hands the Code clone (the `Source` input, a full clone) to EVERY Cloud action, which is what lets CloudImage build the gateway
// image from the Code checkout and CloudGateway make the stack with Code's CDK app at the Code sha. The Cloud steps themselves live in Cloud (ops/pipeline); this pins the input.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CLOUD_STEPS_BEFORE_CODE, ReleasePipelineStack } from "../../infra/lib/release-pipeline.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

interface Action { Name: string; InputArtifacts?: Array<{ Name: string }>; Configuration?: Record<string, unknown> }
const template = Template.fromStack(new ReleasePipelineStack(new App(), "GatewayFromCodePipeline", { env: { region: "us-east-1" } }));
const pipeline = Object.values(template.findResources("AWS::CodePipeline::Pipeline"))[0] as { Properties: { Stages: Array<{ Name: string; Actions: Action[] }> } };
const stage = (name: string): Action[] => pipeline.Properties.Stages.find((s) => s.Name === name)!.Actions;

describe("the Cloud gateway actions get the Code clone", () => {
  it("CloudImage and CloudGateway keep their steps, in order, before the Code release", () => {
    expect(CLOUD_STEPS_BEFORE_CODE.map((s) => `${s.action}:${s.step}`)).toEqual(["Preflight:preflight", "CloudImage:image", "CloudGateway:gateway", "GatewayCheck:gateway-check"]);
  });

  it.each(["Beta", "Production"])("%s: every Cloud action, CloudImage and CloudGateway included, reads the Code clone as an input beside the Cloud clone and the state", (name) => {
    const actions = stage(name).filter((a) => ["Preflight", "CloudImage", "CloudGateway", "GatewayCheck", "CloudWebApp", "CloudProof"].includes(a.Name));
    expect(actions.map((a) => a.Name)).toEqual(expect.arrayContaining(["CloudImage", "CloudGateway"]));
    for (const action of actions) {
      const inputs = (action.InputArtifacts ?? []).map((i) => i.Name);
      expect(inputs, action.Name).toContain("Source");
      expect(inputs, action.Name).toContain("CloudSource");
    }
  });
});
