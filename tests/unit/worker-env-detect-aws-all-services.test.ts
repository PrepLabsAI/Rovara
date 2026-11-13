// Wide AWS plans (every service the emulator's table serves): detection reads the table, not a hand map. boto3, the JS SDK, Java and Go packages, CloudFormation types, Terraform prefixes and CDK modules each name a
// service the way their SDK does; a service no seed handler creates resources for is still a candidate and says it starts empty; a Terraform type no service owns is a `mentioned` candidate, never dropped.
import { describe, expect, it } from "vitest";
import { AWS_EMULATOR_SERVICES, awsServiceKeyFromCfnType, awsServiceKeyFromSdkName } from "@rovara-code/contracts";
import { boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import { awsServiceOfTerraformType } from "../../packages/worker/src/env-detect/iac-resources.js";
import { awsServicesFromList, normalizeAwsService } from "../../packages/worker/src/env-detect/dependency-candidates.js";

type Files = Record<string, string>;
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return runDetectors(bounded.reader, "svc");
}
const families = (detection: Awaited<ReturnType<typeof detect>>) => (detection.dependencies ?? []).map((item) => item.family).sort();
const family = (detection: Awaited<ReturnType<typeof detect>>, id: string) => detection.dependencies?.find((item) => item.family === id);

describe("service names come from the table", () => {
  it("reads each SDK's spelling of a service as its key, and keeps api-gateway, apigatewayv2 and the two Cognito services apart", () => {
    expect(awsServiceKeyFromSdkName("boto3", "secretsmanager")).toBe("secrets-manager");
    expect(awsServiceKeyFromSdkName("boto3", "cognito-idp")).toBe("cognito-identity-provider");
    expect(awsServiceKeyFromSdkName("boto3", "events")).toBe("eventbridge");
    expect(awsServiceKeyFromSdkName("js", "secrets-manager")).toBe("secrets-manager");
    expect(awsServiceKeyFromSdkName("js", "sfn")).toBe("sfn");
    expect(awsServiceKeyFromSdkName("java", "cognitoidentityprovider")).toBe("cognito-identity-provider");
    expect(awsServiceKeyFromSdkName("go", "cognitoidentity")).toBe("cognito-identity");
    expect(awsServiceKeyFromSdkName("endpointVariable", "SECRETS_MANAGER")).toBe("secrets-manager");
    expect(normalizeAwsService("apigatewayv2", "boto3")).toBe("apigatewayv2");
    expect(normalizeAwsService("apigatewayv2", "java")).toBe("apigatewayv2");
    expect(normalizeAwsService("apigateway", "boto3")).toBe("api-gateway");
    // `cognito` alone is no service of the table (user pools and identity pools are two): it is not read as either.
    expect(normalizeAwsService("cognito", "boto3")).toBe("cognito");
    expect(normalizeAwsService("cognito-idp", "boto3")).toBe("cognito-identity-provider");
    expect(normalizeAwsService("cognito-identity", "boto3")).toBe("cognito-identity");
  });
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

describe("code: one fixture per language", () => {
  it("Python: boto3 clients and resources by the boto3 column", async () => {
    const detection = await detect({
      "app/aws.py": [
        "import boto3",
        'sm = boto3.client("secretsmanager")',
        'q = boto3.resource("sqs")',
        'idp = boto3.client("cognito-idp")',
        'sf = boto3.client("stepfunctions")',
        'ev = boto3.client("events")',
        'gw = boto3.client("apigateway")',
        'gw2 = boto3.client("apigatewayv2")',
        'k = boto3.client("kinesis")',
        "",
      ].join("\n"),
    });
    expect(families(detection)).toEqual(["aws:api-gateway", "aws:apigatewayv2", "aws:cognito-identity-provider", "aws:eventbridge", "aws:kinesis", "aws:secrets-manager", "aws:sfn", "aws:sqs"]);
  });
  it("JavaScript: @aws-sdk/client-* packages", async () => {
    const detection = await detect({
      "src/aws.ts": [
        'import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";',
        'import { SFNClient } from "@aws-sdk/client-sfn";',
        'import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";',
        'import { ApiGatewayV2Client } from "@aws-sdk/client-apigatewayv2";',
        'import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";',
        "",
      ].join("\n"),
    });
    expect(families(detection)).toEqual(["aws:apigatewayv2", "aws:cognito-identity-provider", "aws:dynamodb", "aws:secrets-manager", "aws:sfn"]);
  });
  it("Java: software.amazon.awssdk.services.* imports", async () => {
    const detection = await detect({
      "src/main/java/App.java": [
        "import software.amazon.awssdk.services.secretsmanager.SecretsManagerClient;",
        "import software.amazon.awssdk.services.cognitoidentityprovider.CognitoIdentityProviderClient;",
        "import software.amazon.awssdk.services.apigatewayv2.ApiGatewayV2Client;",
        "import software.amazon.awssdk.services.eventbridge.EventBridgeClient;",
        "class App {}",
        "",
      ].join("\n"),
    });
    expect(families(detection)).toEqual(["aws:apigatewayv2", "aws:cognito-identity-provider", "aws:eventbridge", "aws:secrets-manager"]);
  });
  it("Go: github.com/aws/aws-sdk-go-v2/service/* imports", async () => {
    const detection = await detect({
      "main.go": ['package main', 'import (', '  "github.com/aws/aws-sdk-go-v2/service/sfn"', '  "github.com/aws/aws-sdk-go-v2/service/secretsmanager"', '  "github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs"', ')', 'func main() {}', ""].join("\n"),
    });
    expect(families(detection)).toEqual(["aws:cloudwatch-logs", "aws:secrets-manager", "aws:sfn"]);
  });
  it("settings: AWS_ENDPOINT_URL_<SUFFIX> names the service by the table's variable suffix", async () => {
    const detection = await detect({ ".env.example": "AWS_ENDPOINT_URL_SECRETS_MANAGER=http://localhost:4566\nAWS_ENDPOINT_URL_SFN=http://localhost:4566\nAWS_ENDPOINT_URL_EVENTBRIDGE=http://localhost:4566\n" });
    expect(families(detection)).toEqual(["aws:eventbridge", "aws:secrets-manager", "aws:sfn"]);
    expect(family(detection, "aws:sfn")!.hints.envNames).toEqual(["AWS_ENDPOINT_URL_SFN"]);
  });
});

describe("infrastructure code: one fixture per kind", () => {
  it("CloudFormation: any AWS::<name>::* type of a service the table knows is a candidate of that service", async () => {
    const template = [
      "Resources:",
      "  Stream:", "    Type: AWS::Kinesis::Stream",
      "  Pool:", "    Type: AWS::Cognito::UserPool",
      "  Identities:", "    Type: AWS::Cognito::IdentityPool",
      "  Flow:", "    Type: AWS::StepFunctions::StateMachine",
      "  Fn:", "    Type: AWS::Serverless::Function",
      "  Role:", "    Type: AWS::IAM::Role",
      "",
    ].join("\n");
    const detection = await detect({ "template.yaml": template });
    expect(families(detection)).toEqual(["aws:cognito-identity", "aws:cognito-identity-provider", "aws:iam", "aws:kinesis", "aws:sfn"]);
    expect(family(detection, "aws:kinesis")).toMatchObject({ strength: "declared", evidence: [{ path: "template.yaml", line: 2 }], hints: { startsEmpty: true, seenBy: ["iac"] } });
  });
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
  it("reads LocalStack's SERVICES by the table: cognito-idp and cognito-identity are the two Cognito services, and no service is read as a neighbour", () => {
    expect(awsServicesFromList("cognito-idp,cognito-identity,secretsmanager,events,ddb,stepfunctions,apigatewayv2,apigateway")).toEqual([
      "cognito-identity-provider", "cognito-identity", "secrets-manager", "eventbridge", "dynamodb", "sfn", "apigatewayv2", "api-gateway",
    ]);
    // LocalStack's bare `cognito` is neither: it is kept as the word it is, not turned into user pools.
    expect(awsServicesFromList("cognito")).toEqual(["cognito"]);
  });
});

describe("a service no seed handler creates resources for", () => {
  it("is a candidate that starts empty, with one fixed sentence in the notes; a seeded service is not", async () => {
    const detection = await detect({
      "app/aws.py": 'import boto3\nboto3.client("kinesis")\nboto3.client("sns")\nboto3.client("kms")\nboto3.client("ec2")\nboto3.client("ssm")\n',
    });
    expect(family(detection, "aws:kinesis")!.hints.startsEmpty).toBe(true);
    expect(family(detection, "aws:ec2")!.hints.startsEmpty).toBe(true);
    for (const seeded of ["aws:sns", "aws:kms", "aws:ssm"]) expect(family(detection, seeded)!.hints.startsEmpty).toBeUndefined();
    const note = detection.notes.find((text) => text.includes("start empty"));
    expect(note).toBe("Some AWS services start empty in the test services, and the tests create their resources: kinesis, ec2.");
  });
  it("is not claimed for a repository with only the three services that were seeded before: its detection is what it was", async () => {
    const detection = await detect({ "app/aws.py": 'import boto3\nboto3.client("s3")\nboto3.client("sqs")\nboto3.resource("dynamodb")\n' });
    expect(families(detection)).toEqual(["aws:dynamodb", "aws:s3", "aws:sqs"]);
    expect(detection.notes.some((text) => text.includes("start empty"))).toBe(false);
    for (const item of detection.dependencies ?? []) expect(item.hints).not.toHaveProperty("startsEmpty");
  });
});
