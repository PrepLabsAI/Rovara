// tests/contract/developer-signin-infrastructure.test.ts
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";

type Resource = { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string; UpdateReplacePolicy?: string };
type Statement = { Effect?: string; Sid?: string; Action: string | string[]; Resource?: unknown; Principal?: unknown; Condition?: Record<string, unknown> };
type TemplateJson = { Parameters: Record<string, Record<string, unknown>>; Resources: Record<string, Resource>; Outputs: Record<string, { Value: unknown }> };
type Ref = { Ref: string };

let named: TemplateJson;
let legacy: TemplateJson;

const controlPlane = (app: ReturnType<typeof buildAgentXApp>, name: string) =>
  Template.fromStack(app.node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === name)!).toJSON() as TemplateJson;
const ofType = (template: TemplateJson, type: string) => Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);
const actionsOf = (statement: Statement) => [statement.Action].flat();
const statementsIn = (document: unknown) => (document as { Statement: Statement[] }).Statement;
/** Logical IDs end in an eight-character hash; drop it to compare names. */
const withoutHash = (logicalId: string) => logicalId.replace(/[0-9A-F]{8}$/, "");
const functionId = (template: TemplateJson, prefix: string) => ofType(template, "AWS::Lambda::Function").map(([id]) => id).find((id) => withoutHash(id) === prefix)!;

/** Every identity-policy statement in the template, with the role (logical ID) it applies to:
 * AWS::IAM::Policy, AWS::IAM::ManagedPolicy (by its Roles or a role's ManagedPolicyArns) and a
 * role's inline Policies. */
function grants(template: TemplateJson): Array<{ role: string; statement: Statement }> {
  const found: Array<{ role: string; statement: Statement }> = [];
  const add = (roles: string[], document: unknown) => { for (const role of roles) for (const statement of statementsIn(document)) found.push({ role, statement }); };
  // A role from outside the stack (such as the EC2 worker role, named from an ARN parameter) keeps
  // a readable label, so its grants still count.
  const refs = (value: unknown) => ((value ?? []) as unknown[]).map((ref) => (typeof (ref as Ref).Ref === "string" ? (ref as Ref).Ref : `external:${JSON.stringify(ref)}`));
  for (const [, policy] of ofType(template, "AWS::IAM::Policy")) add(refs(policy.Properties.Roles), policy.Properties.PolicyDocument);
  for (const [id, policy] of ofType(template, "AWS::IAM::ManagedPolicy")) {
    const attachedBy = ofType(template, "AWS::IAM::Role").filter(([, role]) => refs(role.Properties.ManagedPolicyArns).includes(id)).map(([roleId]) => roleId);
    add([...new Set([...refs(policy.Properties.Roles), ...attachedBy])], policy.Properties.PolicyDocument);
  }
  for (const [roleId, role] of ofType(template, "AWS::IAM::Role")) {
    for (const inline of (role.Properties.Policies ?? []) as Array<{ PolicyDocument: unknown }>) add([roleId], inline.PolicyDocument);
  }
  return found;
}

/** An IAM-style pattern ("*" any run of characters, "?" one character) as a whole-string RegExp. */
const globRegExp = (glob: string, flags = "") => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`, flags);
/** IAM action match (case-insensitive), honoring "*" and wildcards such as "kms:*" or "lambda:Invoke*". */
const allows = (statement: Statement, action: string) => actionsOf(statement).some((pattern) => globRegExp(pattern, "i").test(action));
/** Whether any of the statement's actions is in `service`, or a wildcard (such as "*") that covers it. */
const touches = (statement: Statement, service: string) =>
  actionsOf(statement).some((pattern) => pattern.toLowerCase().startsWith(`${service}:`) || globRegExp(pattern, "i").test(`${service}:AnyAction`));

/** A resource as a glob: pseudo parameters (AWS::Region and so on) become "*"; a stack parameter
 * is a specific value chosen at deploy time, so it stays an opaque token that matches nothing. */
function asGlob(value: unknown): string {
  if (typeof value === "string") return value;
  const node = value as { Ref?: string; "Fn::Join"?: [string, unknown[]] };
  if (typeof node.Ref === "string") return node.Ref.startsWith("AWS::") ? "*" : "\u0000";
  if (node["Fn::Join"] !== undefined) return node["Fn::Join"][1].map(asGlob).join(node["Fn::Join"][0]);
  // Any other intrinsic could produce anything: count it as a wildcard.
  return "*";
}

/** Whether a statement's resources can reach the resource `logicalId`, whose ARN looks like
 * `sampleArn`: by naming it, or by a pattern (including "*") that names no other logical ID and
 * matches the sample. */
function reaches(template: TemplateJson, statement: Statement, logicalId: string, sampleArn: string): boolean {
  const others = Object.keys(template.Resources).filter((id) => id !== logicalId);
  return [statement.Resource].flat().some((resource) => {
    const text = JSON.stringify(resource);
    if (text.includes(`"${logicalId}"`)) return true;
    if (others.some((id) => text.includes(`"${id}"`))) return false;
    return globRegExp(asGlob(resource)).test(sampleArn);
  });
}

/** The roles (hash dropped, sorted, distinct) with a grant of `action` that reaches `logicalId`. */
const rolesThatMay = (template: TemplateJson, action: string, logicalId: string, sampleArn: string) =>
  [...new Set(grants(template).filter(({ statement }) => statement.Effect !== "Deny" && allows(statement, action) && reaches(template, statement, logicalId, sampleArn)).map(({ role }) => withoutHash(role)))].sort();
const statementsOfRole = (template: TemplateJson, roleName: string) => grants(template).filter(({ role }) => withoutHash(role) === roleName).map(({ statement }) => statement);

const SAMPLE_KEY_ARN = "arn:aws:kms:us-east-1:111122223333:key/0b8a3c2e-1111-2222-3333-444455556666";
const SAMPLE_SLACK_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111122223333:secret:agentx/staging/slack-AbCdEf";
const SAMPLE_FUNCTION_ARN = "arn:aws:lambda:us-east-1:111122223333:function:agentx-staging-control-p-DeveloperSignInFunction-AbCdEf";
const SAMPLE_TABLE_ARN = "arn:aws:dynamodb:us-east-1:111122223333:table/agentx-staging-control-plane-DeveloperSignInTable-AbCdEf";

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
    // FR-045: when each method was last turned on, in epoch seconds; "0" is never.
    expect(p.DeveloperSignInSlackSince).toMatchObject({ Type: "String", Default: "0", AllowedPattern: "^[0-9]{1,12}$" });
    expect(p.DeveloperOidcSince).toMatchObject({ Type: "String", Default: "0", AllowedPattern: "^[0-9]{1,12}$" });
    for (const parameter of Object.values(p)) expect(JSON.stringify(parameter)).not.toContain("—");
  });

  it("has no JWT authorizer whose issuer is this API, which API Gateway cannot create before the API serves discovery (D17)", () => {
    // The live check on 2026-09-27: creating an authorizer whose issuer is <api>/v1/auth failed with
    // "Issuer must have a valid discovery endpoint", because the API did not exist yet.
    const authorizers = ofType(named, "AWS::ApiGatewayV2::Authorizer").map(([, resource]) => resource.Properties);
    const apiIds = ofType(named, "AWS::ApiGatewayV2::Api").map(([id]) => id);
    for (const properties of authorizers.filter((p) => p.AuthorizerType === "JWT")) {
      const issuer = JSON.stringify((properties.JwtConfiguration as { Issuer: unknown }).Issuer);
      for (const apiId of apiIds) expect(issuer).not.toContain(apiId);
      expect(issuer).not.toContain("/v1/auth");
    }
    expect(authorizers.map((properties) => properties.Name)).toEqual(["agentx-jwt"]);
  });

  it("routes /v1/dev/* with no authorizer to the broker, which verifies the token itself (D17), /v1/auth/* with no authorizer to DeveloperIdentity, and leaves ANY /{proxy+} alone", () => {
    const routes = Object.fromEntries(ofType(named, "AWS::ApiGatewayV2::Route").map(([, resource]) => [resource.Properties.RouteKey as string, resource.Properties]));
    const authorizerId = (name: string) => ({ Ref: ofType(named, "AWS::ApiGatewayV2::Authorizer").find(([, r]) => r.Properties.Name === name)![0] });
    expect(routes["ANY /v1/dev/{proxy+}"]).toMatchObject({ AuthorizationType: "NONE", Target: routes["ANY /{proxy+}"]!.Target });
    expect(routes["ANY /v1/dev/{proxy+}"]!.AuthorizerId).toBeUndefined();
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
    const denies = (key.Properties.KeyPolicy as { Statement: Statement[] }).Statement.filter((statement) => statement.Effect === "Deny");
    expect(denies).toHaveLength(1);
    const deny = denies[0]!;
    expect(deny).toMatchObject({ Sid: "SignAndGetPublicKeyOnlyAsDeveloperIdentity", Principal: { AWS: "*" }, Resource: "*" });
    expect(actionsOf(deny).sort()).toEqual(["kms:GetPublicKey", "kms:Sign"]);
    const exempt = (deny.Condition as { ArnNotEquals: Record<string, unknown> }).ArnNotEquals["aws:PrincipalArn"] as { "Fn::GetAtt": [string, string] };
    expect(withoutHash(exempt["Fn::GetAtt"][0])).toBe("DeveloperSignInFunctionServiceRole");
    expect(exempt["Fn::GetAtt"][1]).toBe("Arn");
    // The only identity policies that grant kms:Sign or kms:GetPublicKey on this key (by name or pattern) are DeveloperIdentity's.
    for (const action of ["kms:Sign", "kms:GetPublicKey"]) {
      expect(rolesThatMay(named, action, keyId, SAMPLE_KEY_ARN)).toEqual(["DeveloperSignInFunctionServiceRole"]);
    }
    const aliases = ofType(named, "AWS::KMS::Alias").map(([, resource]) => resource.Properties);
    expect(aliases.find((alias) => alias.AliasName === "alias/agentx/staging/developer-tokens")).toMatchObject({ TargetKeyId: { "Fn::GetAtt": [keyId, "Arn"] } });
  });

  it("lets only the ingress, the orchestrator task role and DeveloperIdentity read the Slack secret (R2)", () => {
    const [secretId] = ofType(named, "AWS::SecretsManager::Secret").find(([, resource]) => resource.Properties.Name === "agentx/staging/slack")!;
    const readers = rolesThatMay(named, "secretsmanager:GetSecretValue", secretId, SAMPLE_SLACK_SECRET_ARN);
    expect(readers).toEqual(["DeveloperSignInFunctionServiceRole", "SlackIngressServiceRole", "SlackOrchestratorTaskRole"]);
  });

  it("lets DeveloperIdentity read only its own company sign-in secret besides the Slack secret", () => {
    const reads = statementsOfRole(named, "DeveloperSignInFunctionServiceRole").filter((s) => allows(s, "secretsmanager:GetSecretValue"));
    expect(reads).toHaveLength(2);
    expect(JSON.stringify(reads.map((s) => s.Resource))).toContain(":secret:agentx/staging/developer-oidc-??????");
  });

  it("lets only the broker invoke DeveloperIdentity directly, and API Gateway only on /v1/auth/*", () => {
    const fnId = functionId(named, "DeveloperSignInFunction");
    for (const action of ["lambda:InvokeFunction", "lambda:InvokeFunctionUrl"]) {
      expect(rolesThatMay(named, action, fnId, SAMPLE_FUNCTION_ARN), action).toEqual(action === "lambda:InvokeFunction" ? ["BrokerServiceRole"] : []);
    }
    const permissions = ofType(named, "AWS::Lambda::Permission").map(([, r]) => r.Properties).filter((properties) => JSON.stringify(properties.FunctionName).includes(fnId));
    expect(permissions).toHaveLength(1);
    expect(permissions[0]).toMatchObject({ Action: "lambda:InvokeFunction", Principal: "apigateway.amazonaws.com" });
    expect(JSON.stringify(permissions[0]!.SourceArn)).toContain("/*/*/v1/auth/*");
  });

  it("gives the broker only session and developer reads on the sign-in table", () => {
    const [tableId] = ofType(named, "AWS::DynamoDB::Table").find(([logicalId]) => logicalId.startsWith("DeveloperSignInTable"))!;
    const tableStatements = statementsOfRole(named, "BrokerServiceRole").filter((statement) => touches(statement, "dynamodb") && reaches(named, statement, tableId, SAMPLE_TABLE_ARN));
    expect(tableStatements).toHaveLength(1);
    expect(tableStatements[0]!.Action).toBe("dynamodb:GetItem");
    expect(tableStatements[0]!.Condition).toEqual({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*", "DEVELOPER#*"] } });
  });

  it("gives DeveloperIdentity exactly the item operations its store uses on the sign-in table, nothing table-wide", () => {
    const [tableId] = ofType(named, "AWS::DynamoDB::Table").find(([logicalId]) => logicalId.startsWith("DeveloperSignInTable"))!;
    const tableStatements = statementsOfRole(named, "DeveloperSignInFunctionServiceRole").filter((statement) => touches(statement, "dynamodb") && reaches(named, statement, tableId, SAMPLE_TABLE_ARN));
    expect(tableStatements).toHaveLength(1);
    // TransactWriteItems is authorized per item as PutItem and UpdateItem; the store never deletes or condition-checks.
    expect(actionsOf(tableStatements[0]!).sort()).toEqual(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]);
    expect(tableStatements[0]!.Resource).toEqual({ "Fn::GetAtt": [tableId, "Arn"] });
  });

  it("throttles the public /v1/auth/* and /v1/dev/* routes on the default stage (burst 50, 20 requests a second)", () => {
    const stages = ofType(named, "AWS::ApiGatewayV2::Stage");
    expect(stages).toHaveLength(1);
    const [, stage] = stages[0]!;
    expect(stage.Properties.RouteSettings).toEqual({
      "ANY /v1/auth/{proxy+}": { ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 },
      "ANY /v1/dev/{proxy+}": { ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 },
    });
    // A stage's route settings name routes that must already exist.
    const routeId = (key: string) => ofType(named, "AWS::ApiGatewayV2::Route").find(([, r]) => r.Properties.RouteKey === key)![0];
    const dependsOn = [(stage as Resource & { DependsOn?: string | string[] }).DependsOn].flat();
    expect(dependsOn).toContain(routeId("ANY /v1/auth/{proxy+}"));
    expect(dependsOn).toContain(routeId("ANY /v1/dev/{proxy+}"));
  });

  it("keeps sign-in records in a retained, point-in-time recoverable table with a TTL", () => {
    const [, table] = ofType(named, "AWS::DynamoDB::Table").find(([logicalId]) => logicalId.startsWith("DeveloperSignInTable"))!;
    expect(table.Properties.TimeToLiveSpecification).toEqual({ AttributeName: "expiresAt", Enabled: true });
    expect(table.Properties.KeySchema).toEqual([{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }]);
    expect(table.Properties.BillingMode).toBe("PAY_PER_REQUEST");
    expect(table.Properties.PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
    expect(table.DeletionPolicy).toBe("RetainExceptOnCreate");
    expect(table.UpdateReplacePolicy).toBe("Retain");
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
    // FR-045: both functions get each method's enabled-since cutoff straight from its parameter.
    const variables = (prefix: string) => (named.Resources[functionId(named, prefix)]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    for (const prefix of ["Broker", "DeveloperSignInFunction"]) {
      expect(variables(prefix).DEVELOPER_SIGNIN_SLACK_SINCE).toEqual({ Ref: "DeveloperSignInSlackSince" });
      expect(variables(prefix).DEVELOPER_OIDC_SINCE).toEqual({ Ref: "DeveloperOidcSince" });
    }
    const [separator, [endpoint, suffix]] = (named.Outputs.DeveloperSignInIssuer!.Value as { "Fn::Join": [string, [{ "Fn::GetAtt": [string, string] }, string]] })["Fn::Join"];
    expect(separator).toBe("");
    expect(endpoint["Fn::GetAtt"][0]).toMatch(/^HttpApi/);
    expect(endpoint["Fn::GetAtt"][1]).toBe("ApiEndpoint");
    expect(suffix).toBe("/v1/auth");
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
    expect(ofType(legacy, "AWS::ApiGatewayV2::Stage").map(([, r]) => r.Properties.RouteSettings)).toEqual([undefined]);
  });
});

describe("AI-tool turn records (spec 025 FR-037, R27)", () => {
  const brokerRole = (template: TemplateJson) => {
    const brokerFunction = template.Resources[functionId(template, "Broker")]!;
    return ((brokerFunction.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"])[0];
  };
  const turnTable = (template: TemplateJson) => ofType(template, "AWS::DynamoDB::Table").map(([id]) => id).find((id) => withoutHash(id) === "TurnRecords")!;

  it("lets the broker put items in TurnRecords only under TASK#", () => {
    const puts = grants(named).filter(({ role, statement }) => role === brokerRole(named) && allows(statement, "dynamodb:PutItem") && JSON.stringify(statement.Resource).includes(turnTable(named)));
    expect(puts).toHaveLength(1);
    expect(puts[0]!.statement.Condition).toEqual({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TASK#*"] } });
    expect(actionsOf(puts[0]!.statement)).toEqual(["dynamodb:PutItem"]);
  });

  it("gives the broker no other write on TurnRecords, and no update or delete anywhere on it", () => {
    for (const action of ["dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"]) {
      expect(grants(named).some(({ role, statement }) => role === brokerRole(named) && allows(statement, action) && JSON.stringify(statement.Resource ?? "").includes(turnTable(named)))).toBe(false);
    }
  });

  it("adds nothing to the legacy templates", () => {
    expect(grants(legacy).some(({ statement }) => (statement.Condition as Record<string, Record<string, unknown>> | undefined)?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"] !== undefined
      && JSON.stringify(statement.Condition).includes("TASK#"))).toBe(false);
  });
});
