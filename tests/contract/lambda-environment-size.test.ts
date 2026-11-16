// Lambda holds all of a function's environment variables, keys and values together, to 4,096 bytes, and only the deploy says so. A named environment's broker was over it once the
// core switch-on lanes added their settings (2026-11-15: 4,135 bytes in the staging fixture, 4,393 with the longest environment name). This resolves the broker's and the
// dispatcher's environments with the longest names CloudFormation can generate and holds each under a ceiling with 128 bytes of margin, measured the stricter way (the compact
// JSON of the map, which counts each variable's quotes and separators), so a later lane cannot drift past the limit unseen.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { describe, expect, it } from "vitest";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { LAMBDA_ENVIRONMENT_LIMIT_BYTES, controlPlaneOf, environmentBytes, keyValueBytes, lambdaEnvironments, type Template as ResolvableTemplate } from "../support/lambda-environment-size.js";

skipLambdaBundling();

/** The named control plane, synthesized (the measure itself, tests/support/lambda-environment-size.ts, takes the template). */
function synthesized(env: string): { template: unknown; stackName: string } {
  const stack = buildAgentXApp({ agentxEnv: env }).node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane");
  if (stack === undefined) throw new Error("no control plane stack");
  return { template: Template.fromStack(stack).toJSON(), stackName: stack.stackName };
}

/** 4,096 less 128 bytes of margin (core switch-on decision, 2026-11-15). */
const CEILING_BYTES = 3968;
const DERIVE_DONT_ADD = [
  "Derive it, don't add an environment variable.",
  "A value the environment's name decides goes in DERIVED_BROKER_VARIABLES (packages/contracts/src/broker-environment.ts), not in the function's environment;",
  "a generated name or id goes in AGENTX_NAMES (BROKER_NAMES), a constrained setting in AGENTX_SETTINGS (BROKER_SETTINGS).",
].join(" ");
/** The longest environment name the installer accepts (20 characters), and the usual one. */
const LONGEST_ENVIRONMENT = "a1234567890123456789";
const ENVIRONMENTS = [LONGEST_ENVIRONMENT, "staging"] as const;
const MEASURED = /^(Broker|Dispatcher)[0-9A-F]{8}$/u;

describe("the broker's and the dispatcher's environments stay under Lambda's 4 KB limit, with 128 bytes of margin", () => {
  for (const env of ENVIRONMENTS) {
    describe(`environment ${env}`, () => {
      const functions = controlPlaneOf(env, synthesized(env)).functions;

      it("finds both functions", () => {
        expect(functions.map((entry) => entry.logicalId.replace(/[0-9A-F]{8}$/u, "")).sort()).toEqual(["Broker", "Dispatcher"]);
      });

      for (const name of ["Broker", "Dispatcher"]) {
        it(`holds the ${name} at or under ${CEILING_BYTES} bytes, as compact JSON and as keys plus values`, () => {
          const entry = functions.find((candidate) => candidate.logicalId.startsWith(name))!;
          expect(entry.bytes, `${name}: ${entry.bytes} bytes of JSON (${entry.keyValueBytes} keys plus values) against ${CEILING_BYTES}. ${DERIVE_DONT_ADD}`).toBeLessThanOrEqual(CEILING_BYTES);
          expect(entry.keyValueBytes).toBeLessThanOrEqual(entry.bytes);
        });
      }
    });
  }
});

describe("the measuring", () => {
  it("counts the compact JSON of the variable map and the keys plus values, in bytes", () => {
    expect(environmentBytes({ A: "1" })).toBe('{"A":"1"}'.length);
    expect(environmentBytes({ NAME: "é" })).toBe(Buffer.byteLength('{"NAME":"é"}'));
    expect(keyValueBytes({ A: "1", NAME: "é" })).toBe(1 + 1 + 4 + 2);
    expect(LAMBDA_ENVIRONMENT_LIMIT_BYTES - CEILING_BYTES).toBe(128);
  });

  it("gives a generated name the stack's name, the logical id and 13 random characters, cut at the type's limit, and a role's ARN the environment's path", () => {
    const template: ResolvableTemplate = { Resources: {
      Queue: { Type: "AWS::SQS::Queue", Properties: {} },
      Role: { Type: "AWS::IAM::Role", Properties: {} },
      Broker00000000: { Type: "AWS::Lambda::Function", Properties: { Environment: { Variables: { URL: { Ref: "Queue" }, ROLE: { "Fn::GetAtt": ["Role", "Arn"] } } } } },
    } };
    const [entry] = lambdaEnvironments(template, { env: "x", stackName: "agentx-x-control-plane" }, MEASURED);
    expect(entry!.variables).toEqual({
      URL: "https://sqs.ap-southeast-4.amazonaws.com/123456789012/agentx-x-control-plane-Queue-A1B2C3D4E5F6G",
      ROLE: "arn:aws:iam::123456789012:role/agentx/x/agentx-x-control-plane-Role-A1B2C3D4E5F6G",
    });
  });

  it("refuses an intrinsic it does not know, instead of guessing its length", () => {
    const template: ResolvableTemplate = { Resources: { Broker00000000: { Type: "AWS::Lambda::Function", Properties: { Environment: { Variables: { X: { "Fn::Base64": "a" } } } } } } };
    expect(() => lambdaEnvironments(template, { env: "x", stackName: "s" }, MEASURED)).toThrow("Fn::Base64 is not resolved by this measure");
  });
});
