// tests/contract/developer-signin-infrastructure.test.ts
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";

type Resource = { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string };
type Statement = { Effect?: string; Sid?: string; Action: string | string[]; Resource?: unknown; Principal?: unknown; Condition?: Record<string, unknown> };
type TemplateJson = { Parameters: Record<string, Record<string, unknown>>; Resources: Record<string, Resource>; Outputs: Record<string, { Value: unknown }> };
type Ref = { Ref: string };

let named: TemplateJson;
let legacy: TemplateJson;

const controlPlane = (app: ReturnType<typeof buildAgentXApp>, name: string) =>
  Template.fromStack(app.node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === name)!).toJSON() as TemplateJson;
const ofType = (template: TemplateJson, type: string) => Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);
const actionsOf = (statement: Statement) => [statement.Action].flat();
const statementsOf = (policy: Resource) => (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
const rolesOf = (policy: Resource) => (policy.Properties.Roles as Ref[]).map((role) => role.Ref);
/** Logical IDs end in an eight-character hash; drop it to compare names. */
const withoutHash = (logicalId: string) => logicalId.replace(/[0-9A-F]{8}$/, "");
const functionId = (template: TemplateJson, prefix: string) => ofType(template, "AWS::Lambda::Function").map(([id]) => id).find((id) => withoutHash(id) === prefix)!;
const roleNamesWith = (template: TemplateJson, matches: (statement: Statement) => boolean) =>
  ofType(template, "AWS::IAM::Policy").filter(([, policy]) => statementsOf(policy).some(matches)).flatMap(([, policy]) => rolesOf(policy)).map(withoutHash).sort();

beforeAll(() => {
  named = controlPlane(buildAgentXApp({ agentxEnv: "staging" }), "agentx-staging-control-plane");
  legacy = controlPlane(buildAgentXApp(), "AgentXControlPlane");
}, 300_000);

describe("developer sign-in infrastructure (named environments)", () => {
  it("declares the sign-in parameters, with sign-in off by default (R8)", () => {
    const p = named.Parameters;
    expect(p.SlackTeamId).toMatchObject({ Type: "String", Default: "", AllowedPattern: "^$|^[TE][A-Z0-9]{2,31}$" });
    expect(p.DeveloperSignInSlack).toMatchObject({ Type: "String", Default: "disabled", AllowedValues: ["enabled", "disabled"] });
    expect(p.DeveloperOidcIssuer).toMatchObject({ Type: "String", Default: "", AllowedPattern: "^$|^https://\\S+$" });
    expect(p.DeveloperOidcClientId).toMatchObject({ Type: "String", Default: "", MaxLength: 256 });
    expect(p.DeveloperOidcRequiredClaim).toMatchObject({ Type: "String", Default: "", MaxLength: 128 });
    expect(p.DeveloperOidcRequiredValues).toMatchObject({ Type: "String", Default: "[]", AllowedPattern: "^\\[.*\\]$" });
    expect(p.DeveloperOidcDisplayName).toMatchObject({ Type: "String", Default: "Company sign-in", MinLength: 1, MaxLength: 40 });
    for (const parameter of Object.values(p)) expect(JSON.stringify(parameter)).not.toContain("—");
  });

  it("adds a second JWT authorizer whose issuer is the API's own endpoint plus /v1/auth (FR-009)", () => {
    const authorizers = ofType(named, "AWS::ApiGatewayV2::Authorizer").map(([, resource]) => resource.Properties);
    expect(authorizers).toHaveLength(2);
    const developer = authorizers.find((properties) => properties.Name === "agentx-developer-jwt")!;
    const jwt = developer.JwtConfiguration as { Audience: string[]; Issuer: { "Fn::Join": [string, [{ "Fn::GetAtt": [string, string] }, string]] } };
    expect(jwt.Audience).toEqual(["agentx-developer"]);
    const [separator, [endpoint, suffix]] = jwt.Issuer["Fn::Join"];
    expect(separator).toBe("");
    expect(endpoint["Fn::GetAtt"][0]).toMatch(/^HttpApi/);
    expect(endpoint["Fn::GetAtt"][1]).toBe("ApiEndpoint");
    expect(suffix).toBe("/v1/auth");
    expect(authorizers.find((properties) => properties.Name === "agentx-jwt")).toBeDefined();
  });

  it("routes /v1/dev/* through the developer authorizer to the broker, /v1/auth/* with no authorizer to DeveloperIdentity, and leaves ANY /{proxy+} alone", () => {
    const routes = Object.fromEntries(ofType(named, "AWS::ApiGatewayV2::Route").map(([, resource]) => [resource.Properties.RouteKey as string, resource.Properties]));
    const authorizerId = (name: string) => ({ Ref: ofType(named, "AWS::ApiGatewayV2::Authorizer").find(([, r]) => r.Properties.Name === name)![0] });
    expect(routes["ANY /v1/dev/{proxy+}"]).toMatchObject({ AuthorizationType: "JWT", AuthorizerId: authorizerId("agentx-developer-jwt"), Target: routes["ANY /{proxy+}"]!.Target });
    expect(routes["ANY /{proxy+}"]).toMatchObject({ AuthorizationType: "JWT", AuthorizerId: authorizerId("agentx-jwt") });
    const auth = routes["ANY /v1/auth/{proxy+}"]!;
    expect(auth.AuthorizationType).toBe("NONE");
    expect(auth.AuthorizerId).toBeUndefined();
    const [integrationId] = ofType(named, "AWS::ApiGatewayV2::Integration").find(([, r]) => JSON.stringify(r.Properties.IntegrationUri).includes(functionId(named, "DeveloperSignInFunction")))!;
    expect(auth.Target).toEqual({ "Fn::Join": ["", ["integrations/", { Ref: integrationId }]] });
  });

  it("signs with an RSA_2048 KMS key only the DeveloperIdentity role may use (R1)", () => {
    const keys = ofType(named, "AWS::KMS::Key").filter(([, resource]) => resource.Properties.KeySpec === "RSA_2048");
    expect(keys).toHaveLength(1);
    const [keyId, key] = keys[0]!;
    expect(key.Properties.KeyUsage).toBe("SIGN_VERIFY");
    const deny = (key.Properties.KeyPolicy as { Statement: Statement[] }).Statement.find((statement) => statement.Effect === "Deny")!;
    expect(deny).toMatchObject({ Sid: "SignOnlyAsDeveloperIdentity", Action: "kms:Sign", Principal: { AWS: "*" }, Resource: "*" });
    const exempt = (deny.Condition as { ArnNotEquals: Record<string, unknown> }).ArnNotEquals["aws:PrincipalArn"] as { "Fn::GetAtt": [string, string] };
    expect(withoutHash(exempt["Fn::GetAtt"][0])).toBe("DeveloperSignInFunctionServiceRole");
    // The only identity policy that grants kms:Sign on this key is DeveloperIdentity's.
    expect(roleNamesWith(named, (s) => actionsOf(s).includes("kms:Sign") && JSON.stringify(s.Resource).includes(keyId))).toEqual(["DeveloperSignInFunctionServiceRole"]);
    const aliases = ofType(named, "AWS::KMS::Alias").map(([, resource]) => resource.Properties);
    expect(aliases.find((alias) => alias.AliasName === "alias/agentx/staging/developer-tokens")).toMatchObject({ TargetKeyId: { "Fn::GetAtt": [keyId, "Arn"] } });
  });

  it("lets only the ingress, the orchestrator task role and DeveloperIdentity read the Slack secret (R2)", () => {
    const [secretId] = ofType(named, "AWS::SecretsManager::Secret").find(([, resource]) => resource.Properties.Name === "agentx/staging/slack")!;
    const readers = roleNamesWith(named, (s) => actionsOf(s).includes("secretsmanager:GetSecretValue") && JSON.stringify(s.Resource).includes(secretId));
    expect(readers).toEqual(["DeveloperSignInFunctionServiceRole", "SlackIngressServiceRole", "SlackOrchestratorTaskRole"]);
  });

  it("lets DeveloperIdentity read only its own company sign-in secret besides the Slack secret", () => {
    const role = ofType(named, "AWS::IAM::Policy").filter(([, policy]) => rolesOf(policy).some((id) => withoutHash(id) === "DeveloperSignInFunctionServiceRole"));
    const reads = role.flatMap(([, policy]) => statementsOf(policy)).filter((s) => actionsOf(s).includes("secretsmanager:GetSecretValue"));
    expect(reads).toHaveLength(2);
    expect(JSON.stringify(reads.map((s) => s.Resource))).toContain(":secret:agentx/staging/developer-oidc-??????");
  });

  it("lets only the broker invoke DeveloperIdentity directly, and API Gateway only on /v1/auth/*", () => {
    const fnId = functionId(named, "DeveloperSignInFunction");
    expect(roleNamesWith(named, (s) => actionsOf(s).some((action) => action.startsWith("lambda:Invoke")) && JSON.stringify(s.Resource).includes(fnId))).toEqual(["BrokerServiceRole"]);
    const permissions = ofType(named, "AWS::Lambda::Permission").map(([, r]) => r.Properties).filter((properties) => JSON.stringify(properties.FunctionName).includes(fnId));
    expect(permissions).toHaveLength(1);
    expect(permissions[0]).toMatchObject({ Action: "lambda:InvokeFunction", Principal: "apigateway.amazonaws.com" });
    expect(JSON.stringify(permissions[0]!.SourceArn)).toContain("/*/*/v1/auth/*");
  });

  it("gives the broker only session and developer reads on the sign-in table", () => {
    const brokerPolicies = ofType(named, "AWS::IAM::Policy").filter(([, policy]) => rolesOf(policy).some((id) => withoutHash(id) === "BrokerServiceRole"));
    const statements = brokerPolicies.flatMap(([, policy]) => statementsOf(policy));
    const [tableId] = ofType(named, "AWS::DynamoDB::Table").find(([logicalId]) => logicalId.startsWith("DeveloperSignInTable"))!;
    const tableStatements = statements.filter((statement) => JSON.stringify(statement.Resource).includes(tableId));
    expect(tableStatements).toHaveLength(1);
    expect(tableStatements[0]!.Action).toBe("dynamodb:GetItem");
    expect(tableStatements[0]!.Condition).toEqual({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*", "DEVELOPER#*"] } });
  });

  it("keeps sign-in records in a retained, point-in-time recoverable table with a TTL", () => {
    const [, table] = ofType(named, "AWS::DynamoDB::Table").find(([logicalId]) => logicalId.startsWith("DeveloperSignInTable"))!;
    expect(table.Properties.TimeToLiveSpecification).toEqual({ AttributeName: "expiresAt", Enabled: true });
    expect(table.Properties.KeySchema).toEqual([{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }]);
    expect(table.Properties.BillingMode).toBe("PAY_PER_REQUEST");
    expect(table.Properties.PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
    expect(table.DeletionPolicy).toBe("Retain");
  });

  it("passes the developer configuration to the broker and DeveloperIdentity", () => {
    const functions = Object.fromEntries(ofType(named, "AWS::Lambda::Function").map(([id, resource]) => [
      withoutHash(id), Object.keys((resource.Properties.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables ?? {}),
    ]));
    expect(functions.Broker).toEqual(expect.arrayContaining(["DEVELOPER_TOKEN_ISSUER", "AGENTX_ENV", "DEVELOPER_SIGNIN_TABLE_NAME", "DEVELOPER_IDENTITY_FUNCTION_ARN", "SLACK_TEAM_ID", "DEVELOPER_SIGNIN_SLACK", "DEVELOPER_OIDC_ISSUER"]));
    expect(functions.Broker).not.toContain("SLACK_SECRET_ARN");
    expect(functions.DeveloperSignInFunction).toEqual(expect.arrayContaining([
      "AGENTX_ENV", "DEVELOPER_TOKEN_ISSUER", "DEVELOPER_SIGNIN_TABLE_NAME", "DEVELOPER_TOKEN_KEY_ARN", "SLACK_SECRET_ARN", "SLACK_TEAM_ID",
      "DEVELOPER_SIGNIN_SLACK", "DEVELOPER_OIDC_ISSUER", "DEVELOPER_OIDC_CLIENT_ID", "DEVELOPER_OIDC_REQUIRED_CLAIM", "DEVELOPER_OIDC_REQUIRED_VALUES",
      "DEVELOPER_OIDC_DISPLAY_NAME", "DEVELOPER_OIDC_SECRET_ID",
    ]));
    expect(named.Outputs.DeveloperSignInIssuer!.Value).toEqual({ "Fn::Join": ["", [{ "Fn::GetAtt": [expect.stringMatching(/^HttpApi/) as unknown as string, "ApiEndpoint"] }, "/v1/auth"]] });
  });
});

describe("the legacy deployment (R3)", () => {
  it("has none of it", () => {
    const text = JSON.stringify(legacy);
    for (const absent of ["SlackTeamId", "DeveloperSignIn", "DeveloperOidc", "agentx-developer-jwt", "/v1/dev/", "/v1/auth", "DEVELOPER_TOKEN_ISSUER", "developer-tokens"]) {
      expect(text).not.toContain(absent);
    }
    expect(ofType(legacy, "AWS::ApiGatewayV2::Authorizer")).toHaveLength(1);
    expect(ofType(legacy, "AWS::KMS::Key").map(([, r]) => r.Properties.KeySpec)).toEqual(["ECC_NIST_P256"]);
  });
});
