// APIGW-ACCESS-LOGS (2026-11-24): the control-plane HTTP API's `$default` stage (every worker callback, dispatcher read, app and webhook call goes through it) writes an access log, so a
// refused callback can be traced to a route and a status. These tests pin where the log goes, how long it is kept, and above all what is NOT in it.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { BOUNDARY_SERVICES, SERVICE_ROLE_SERVICES, defaultBoundaryStatements, deployBoundaryStatements, serviceRoleStatements } from "@agentx/contracts";
import { API_ACCESS_LOG_FIELDS, API_ACCESS_LOG_FORMAT } from "../../infra/lib/api-access-log.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { environmentNaming, legacyNaming } from "../../infra/lib/naming.js";
import { apiAccessLogGroupName, withoutApiAccessLog } from "../support/api-access-log-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string; UpdateReplacePolicy?: string };
type Json = { Resources: Record<string, Resource> };

function controlPlane(context: Record<string, string>): Json {
  const app = buildAgentXApp(context);
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && /control-?plane/iu.test(child.stackName));
  if (stack === undefined) throw new Error("no control-plane stack");
  return Template.fromStack(stack).toJSON() as Json;
}
const ofType = (template: Json, type: string) => Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);

let legacy: Json;
let staging: Json;
beforeAll(() => {
  legacy = controlPlane({});
  staging = controlPlane({ agentxEnv: "staging" });
}, 300_000);

describe("the access log format", () => {
  it("is exactly these thirteen gateway fields, as JSON", () => {
    expect(JSON.parse(API_ACCESS_LOG_FORMAT)).toEqual({
      requestId: "$context.requestId",
      requestTime: "$context.requestTime",
      httpMethod: "$context.httpMethod",
      routeKey: "$context.routeKey",
      status: "$context.status",
      responseLength: "$context.responseLength",
      responseLatencyMs: "$context.responseLatency",
      errorResponseType: "$context.error.responseType",
      authorizerError: "$context.authorizer.error",
      integrationStatus: "$context.integration.status",
      integrationServiceStatus: "$context.integration.integrationStatus",
      integrationLatencyMs: "$context.integration.latency",
      integrationErrorMessage: "$context.integrationErrorMessage",
    });
    expect(Object.keys(API_ACCESS_LOG_FIELDS)).toHaveLength(13);
  });

  it("holds only $context values: no literal text, so nothing a caller sends can be copied in", () => {
    for (const value of Object.values(API_ACCESS_LOG_FIELDS)) expect(value).toMatch(/^\$context\.[A-Za-z.]+$/u);
  });

  it("leaves out the path, query string, caller address and identity, headers, bodies, claims and free-text errors", () => {
    const variables = Object.values(API_ACCESS_LOG_FIELDS);
    for (const forbidden of ["path", "resourcePath", "queryString", "identity", "sourceIp", "userAgent", "authorizer.claims", "authorizer.principalId", "error.message", "error.messageString", "requestBody", "request.header", "request.querystring", "request.path", "customDomain", "domainName", "accountId"]) {
      expect(variables.filter((variable) => variable.includes(forbidden)), forbidden).toEqual([]);
    }
    expect(API_ACCESS_LOG_FORMAT).not.toMatch(/header|body|token|secret|authorization|cookie/iu);
  });
});

describe.each([
  ["legacy production install", () => legacy, undefined],
  ["named environment", () => staging, "staging"],
] as const)("the control-plane template of the %s", (_label, template, env) => {
  it("sets AccessLogSettings on the $default stage, and only there", () => {
    const stages = ofType(template(), "AWS::ApiGatewayV2::Stage");
    expect(stages.map(([id]) => id)).toEqual(["DefaultStage"]);
    const settings = stages[0]![1].Properties.AccessLogSettings as { DestinationArn: { "Fn::GetAtt": string[] }; Format: string };
    expect(stages[0]![1].Properties.StageName).toBe("$default");
    expect(settings.Format).toBe(API_ACCESS_LOG_FORMAT);
    const [groupId, attribute] = settings.DestinationArn["Fn::GetAtt"];
    expect(attribute).toBe("Arn");
    expect(template().Resources[groupId!]!.Type).toBe("AWS::Logs::LogGroup");
  });

  it("writes to one dedicated log group: fixed name under the environment prefix, one month, destroyed with the stack, no KMS key", () => {
    const groups = ofType(template(), "AWS::Logs::LogGroup").filter(([, group]) => typeof group.Properties.LogGroupName === "string" && group.Properties.LogGroupName.includes("control-plane-api-access"));
    expect(groups).toHaveLength(1);
    const group = groups[0]![1];
    expect(group.Properties.LogGroupName).toBe(apiAccessLogGroupName(env));
    expect(group.Properties.RetentionInDays).toBe(30);
    expect(group.Properties.KmsKeyId).toBeUndefined();
    expect([group.DeletionPolicy, group.UpdateReplacePolicy]).toEqual(["Delete", "Delete"]);
  });

  it("is the template with only the log group and the stage setting added", () => {
    const copy = structuredClone(template());
    withoutApiAccessLog(copy, env === undefined ? {} : { env });
    expect(JSON.stringify(copy)).not.toContain("control-plane-api-access");
    expect(JSON.stringify(copy)).not.toContain("AccessLogSettings");
  });

  it("creates no IAM role or policy for the log (an HTTP API needs no account-level CloudWatch role)", () => {
    const names = Object.keys(template().Resources).filter((id) => id.startsWith("ApiAccessLogs"));
    expect(names).toHaveLength(1);
    expect(ofType(template(), "AWS::ApiGateway::Account")).toEqual([]);
    expect(ofType(template(), "AWS::Logs::ResourcePolicy")).toEqual([]);
  });
});

describe("naming and the deploy role", () => {
  it("names the group per install under /aws/vendedlogs/agentx/<env>/", () => {
    expect(legacyNaming().apiAccessLogGroupName).toBe("/aws/vendedlogs/agentx/production/control-plane-api-access");
    expect(environmentNaming("staging").apiAccessLogGroupName).toBe("/aws/vendedlogs/agentx/staging/control-plane-api-access");
    expect(environmentNaming("prod").apiAccessLogGroupName).toBe("/aws/vendedlogs/agentx/prod/control-plane-api-access");
  });

  it("needs no boundary change: the CloudFormation role and both boundaries already allow logs:* and apigateway:* and nothing denies them", () => {
    expect(SERVICE_ROLE_SERVICES).toEqual(expect.arrayContaining(["logs", "apigateway"]));
    expect(BOUNDARY_SERVICES).toEqual(expect.arrayContaining(["logs", "apigateway"]));
    const scope = { env: "staging", partition: "aws", region: "us-west-2", account: "000000000000", cloudFormationRoleName: "agentx-staging-cloudformation" };
    for (const statements of [defaultBoundaryStatements(scope), deployBoundaryStatements(scope)]) {
      const services = statements.find((statement) => statement.Sid === "Services")!;
      expect(services.Effect).toBe("Allow");
      expect(services.Resource).toBe("*");
      expect(services.Action).toEqual(expect.arrayContaining(["logs:*", "apigateway:*"]));
      for (const statement of statements.filter((candidate) => candidate.Effect === "Deny")) {
        expect(JSON.stringify(statement.Action), String(statement.Sid)).not.toMatch(/logs:|apigateway:/u);
      }
    }
    const serviceRole = serviceRoleStatements({ ...scope, artifactBucketArn: "arn:aws:s3:::example-artifacts", pullThroughPrefix: "agentx-staging" });
    expect(serviceRole.find((statement) => statement.Sid === "Services")!.Action).toEqual(expect.arrayContaining(["logs:*", "apigateway:*"]));
  });
});
