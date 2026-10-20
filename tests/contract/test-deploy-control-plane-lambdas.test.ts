import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { CONTROL_PLANE_LAMBDAS, CONTROL_PLANE_LAMBDAS_NOT_DEPLOYED } from "../../scripts/test-deploy.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties?: { Code?: { ZipFile?: unknown; S3Bucket?: unknown } } };

/** Every Lambda of the real TEST installation's control-plane stack that runs code built from this repository. */
function repoBuiltLambdas(context: Record<string, unknown> = { "agentx:e2eQualificationTransport": "enabled" }): string[] {
  const env = "agentxlivetest123";
  // By default as TEST runs it: the standing qualification transport is lifted into the live stack, so it is synthesized here too.
  const stack = buildAgentXApp({ agentxEnv: env, ...context }).node.children
    .filter((child): child is Stack => Stack.isStack(child))
    .find((candidate) => candidate.stackName === `agentx-${env}-control-plane`);
  if (stack === undefined) throw new Error(`expected the real ${env} control-plane stack`);
  const resources = (Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> }).Resources;
  return Object.entries(resources)
    // Inline code (ZipFile) is CDK's own helper, not repo code; a repo-built function reads an asset from S3.
    .filter(([, resource]) => resource.Type === "AWS::Lambda::Function" && resource.Properties?.Code?.ZipFile === undefined)
    .map(([logicalId]) => logicalId)
    .sort();
}

describe("test-deploy's control-plane code units", () => {
  it("equal the repo-built Lambdas of the synthesized control-plane template, so a new Lambda is never left behind", () => {
    const deployable = Object.values(CONTROL_PLANE_LAMBDAS).map((lambda) => lambda.logicalId);
    const named = [...deployable, ...Object.keys(CONTROL_PLANE_LAMBDAS_NOT_DEPLOYED)].sort();
    expect(repoBuiltLambdas()).toEqual(named);
    expect(new Set(deployable).size).toBe(deployable.length);
  });

  it("also holds with the standing qualification transport on, as TEST runs it, and without it", () => {
    expect(repoBuiltLambdas({})).toEqual(repoBuiltLambdas({ "agentx:e2eQualificationTransport": "enabled" }));
  });

  it("leaves out only a function a code-only change set cannot move, with the reason", () => {
    // The proof function is invoked through a published version: new code in the function would not change what runs.
    expect(Object.keys(CONTROL_PLANE_LAMBDAS_NOT_DEPLOYED)).toEqual(["TaskPersonProofFunction817A5A36"]);
    for (const reason of Object.values(CONTROL_PLANE_LAMBDAS_NOT_DEPLOYED)) expect(reason).toMatch(/version/i);
  });
});
