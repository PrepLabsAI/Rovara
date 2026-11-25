// Opus review of L9b (2026-11-24): CodePipeline refuses an action configuration value longer than 1000 characters
// (API ActionDeclaration.configuration: "Value Length Constraints: Minimum length of 1. Maximum length of 1000."), so an
// over-long EnvironmentVariables value fails CreatePipeline/UpdatePipeline and with it the stack deploy.
import { describe, expect, it } from "vitest";
import { Template } from "aws-cdk-lib/assertions";
import type { Stack } from "aws-cdk-lib";
import { buildAgentXApp } from "../../infra/lib/app.js";

type Value = string | { "Fn::Join": [string, Array<string | object>] } | object;
// A Ref (the account, BetaAccountId) resolves to a 12-digit account id.
const resolved = (value: Value): string =>
  typeof value === "string" ? value
    : "Fn::Join" in value ? (value)["Fn::Join"][1].map((part) => (typeof part === "string" ? part : "123456789012")).join("")
      : JSON.stringify(value);

describe("L9b review: every pipeline action configuration value fits CodePipeline's 1000-character limit", () => {
  it("no action configuration value is longer than 1000 characters once the account ids are filled in", () => {
    const stack = buildAgentXApp().node.children.find((child) => child.node.id === "AgentXReleasePipeline") as Stack;
    interface PipelineJson { Stages: Array<{ Name: string; Actions: Array<{ Name: string; Configuration?: Record<string, unknown> }> }> }
    const pipeline = Object.values(Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string; Properties: PipelineJson }>).find((resource) => resource.Type === "AWS::CodePipeline::Pipeline")!;
    const over: string[] = [];
    for (const stage of pipeline.Properties.Stages) {
      for (const action of stage.Actions) {
        for (const [key, value] of Object.entries(action.Configuration ?? {})) {
          const length = resolved(value as Value).length;
          if (length > 1000) over.push(`${stage.Name}/${action.Name}/${key}: ${length}`);
        }
      }
    }
    expect(over).toEqual([]);
  });
});
