// Wide AWS plans (every service the emulator's table serves): detection reads the table, not a hand map. boto3, the JS SDK, Java and Go packages, CloudFormation types, Terraform prefixes and CDK modules each name a
// service the way their SDK does; a service no seed handler creates resources for is still a candidate and says it starts empty; a Terraform type no service owns is a `mentioned` candidate, never dropped.
import { describe, expect, it } from "vitest";
import { AWS_EMULATOR_SERVICES, awsServiceKeyFromCfnType, awsServiceKeyFromSdkName } from "@agentx/contracts";
import { boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import { awsServiceOfTerraformType } from "../../packages/worker/src/env-detect/iac-resources.js";

type Files = Record<string, string>;
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return runDetectors(bounded.reader, "svc");
}
const families = (detection: Awaited<ReturnType<typeof detect>>) => (detection.dependencies ?? []).map((item) => item.family).sort();
const family = (detection: Awaited<ReturnType<typeof detect>>, id: string) => detection.dependencies?.find((item) => item.family === id);

describe("service names come from the table", () => {
  it("tells the two Cognito services and the shared CloudFormation names apart by the resource type", () => {
    expect(awsServiceKeyFromCfnType("AWS::Cognito::UserPool")).toBe("cognito-identity-provider");
    expect(awsServiceKeyFromCfnType("AWS::Cognito::IdentityPool")).toBe("cognito-identity");
    expect(awsServiceKeyFromCfnType("AWS::Cognito::IdentityPoolRoleAttachment")).toBe("cognito-identity");
    expect(awsServiceKeyFromCfnType("AWS::SES::EmailIdentity")).toBe("ses");
    expect(awsServiceKeyFromCfnType("AWS::Events::Rule")).toBe("eventbridge");
    expect(awsServiceKeyFromCfnType("AWS::Lambda::Function")).toBe("lambda");
    expect(awsServiceKeyFromCfnType("AWS::Serverless::Function")).toBeUndefined();
    expect(awsServiceKeyFromCfnType("AWS::Constructor::Thing")).toBeUndefined();
    expect(awsServiceKeyFromCfnType("not a type")).toBeUndefined();
  });
  it("every name of every column is unique except the few the table shares on purpose, and resolves back to a service", () => {
    for (const row of AWS_EMULATOR_SERVICES) {
      expect(awsServiceKeyFromSdkName("js", row.jsPackage.replace("@aws-sdk/client-", ""))).toBe(row.key);
      expect(awsServiceKeyFromSdkName("java", row.javaPackage.split(".").pop()!)).toBe(row.key);
      expect(awsServiceKeyFromSdkName("go", row.goPackage.split("/").pop()!)).toBe(row.key);
      expect(awsServiceKeyFromSdkName("endpointVariable", row.envKey)).toBe(row.key);
    }
  });
  it("Terraform types are read by the table with a few overrides, and a type no service owns is mapped: false", () => {
    expect(awsServiceOfTerraformType("aws_sqs_queue_policy")).toEqual({ key: "sqs", mapped: true });
    expect(awsServiceOfTerraformType("aws_api_gateway_rest_api")).toEqual({ key: "api-gateway", mapped: true });
    expect(awsServiceOfTerraformType("aws_apigatewayv2_api")).toEqual({ key: "apigatewayv2", mapped: true });
    expect(awsServiceOfTerraformType("aws_secretsmanager_secret")).toEqual({ key: "secrets-manager", mapped: true });
    expect(awsServiceOfTerraformType("aws_cloudwatch_event_rule")).toEqual({ key: "eventbridge", mapped: true });
    expect(awsServiceOfTerraformType("aws_cloudwatch_log_group")).toEqual({ key: "cloudwatch-logs", mapped: true });
    expect(awsServiceOfTerraformType("aws_cognito_user_pool")).toEqual({ key: "cognito-identity-provider", mapped: true });
    expect(awsServiceOfTerraformType("aws_cognito_identity_pool")).toEqual({ key: "cognito-identity", mapped: true });
    expect(awsServiceOfTerraformType("aws_vpc")).toEqual({ key: "ec2", mapped: true });
    expect(awsServiceOfTerraformType("aws_sfn_state_machine")).toEqual({ key: "sfn", mapped: true });
    expect(awsServiceOfTerraformType("aws_frobnicator_widget")).toEqual({ key: "frobnicator", mapped: false });
    expect(awsServiceOfTerraformType("google_compute_instance")).toBeUndefined();
  });
});

describe("infrastructure code: one fixture per kind", () => {
  it("Terraform: aws_<prefix>_* through the table and a few overrides; an unmapped type is `mentioned`", async () => {
    const tf = [
      'resource "aws_kinesis_stream" "events" {', "  name = \"events\"", "}",
      'resource "aws_cloudwatch_event_rule" "nightly" {', "}",
      'resource "aws_cognito_user_pool" "main" {', "}",
      'resource "aws_frobnicator_widget" "w" {', "}",
      "",
    ].join("\n");
    const detection = await detect({ "main.tf": tf });
    expect(families(detection)).toEqual(["aws:cognito-identity-provider", "aws:eventbridge", "aws:frobnicator", "aws:kinesis"]);
    expect(family(detection, "aws:frobnicator")).toMatchObject({ strength: "mentioned" });
    expect(family(detection, "aws:kinesis")).toMatchObject({ strength: "declared", hints: { startsEmpty: true } });
  });
  it("CDK: the modules a source file imports, TypeScript and Python", async () => {
    const detection = await detect({
      "lib/stack.ts": ['import * as kinesis from "aws-cdk-lib/aws-kinesis";', 'import * as cognito from "aws-cdk-lib/aws-cognito";', 'import * as origins from "aws-cdk-lib/aws-lambda-event-sources";', ""].join("\n"),
      "infra/app_stack.py": ["from aws_cdk import aws_stepfunctions as sfn", "import aws_cdk.aws_sns as sns", ""].join("\n"),
    });
    expect(families(detection)).toEqual(["aws:cognito-identity-provider", "aws:kinesis", "aws:sfn", "aws:sns"]);
    expect(family(detection, "aws:kinesis")).toMatchObject({ strength: "mentioned" });
  });
});

describe("the CDK alias import and LocalStack's SERVICES list", () => {
  it("reads `import { aws_s3 as s3, aws_sns } from \"aws-cdk-lib\"` (on several lines, and through require) as the modules it names", async () => {
    const detection = await detect({
      "lib/a-stack.ts": 'import { Stack, aws_kinesis as kinesis, aws_sns } from "aws-cdk-lib";\nnew kinesis.Stream(this, "S");\n',
      "lib/b-stack.ts": 'import {\n  aws_cognito as cognito,\n  aws_stepfunctions,\n} from "aws-cdk-lib";\n',
      "lib/c-stack.js": 'const { aws_ec2 } = require("aws-cdk-lib");\n',
    });
    expect(families(detection)).toEqual(["aws:cognito-identity-provider", "aws:ec2", "aws:kinesis", "aws:sfn", "aws:sns"]);
    expect(family(detection, "aws:kinesis")).toMatchObject({ strength: "mentioned", evidence: [{ path: "lib/a-stack.ts", line: 1 }] });
  });
});

