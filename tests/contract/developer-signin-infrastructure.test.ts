// tests/contract/developer-signin-infrastructure.test.ts
import { createHash } from "node:crypto";
import { App, CfnParameter, Stack, aws_iam as iam } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { serviceRoleStatements, defaultBoundaryStatements, SERVICE_ROLE_SERVICES, type PolicyStatementJson } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { withoutCoreEngine } from "../support/core-engine-template.js";
import { withoutSwitchoverControlPlaneParity } from "../support/switchover-parity-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string; UpdateReplacePolicy?: string };
type Statement = { Effect?: string; Sid?: string; Action: string | string[]; Resource?: unknown; Principal?: unknown; Condition?: Record<string, unknown> };
type TemplateJson = { Parameters: Record<string, Record<string, unknown>>; Resources: Record<string, Resource>; Outputs: Record<string, { Value: unknown }> };
type Ref = { Ref: string };

function leadingKeysOf(statement: Statement): string[] {
  const scopedKeys = statement.Condition?.["ForAllValues:StringLike"];
  if (typeof scopedKeys !== "object" || scopedKeys === null || !("dynamodb:LeadingKeys" in scopedKeys)) {
    throw new Error("expected a DynamoDB leading-keys condition");
  }
  const keys = scopedKeys["dynamodb:LeadingKeys"];
  if (!Array.isArray(keys) || !keys.every((key: unknown) => typeof key === "string")) {
    throw new Error("expected DynamoDB leading keys to be strings");
  }
  return keys.filter((key: unknown): key is string => typeof key === "string");
}

let named: TemplateJson;
let legacy: TemplateJson;
let brokerEstimate: number;
let brokerArnEstimate: number;
let longestNamed: TemplateJson;
const LONGEST_ENV = "headroom-longest-env"; // 20 characters: the contract maximum.
const ARN_ESTIMATE_CONTEXT = "@aws-cdk/aws-iam.arnSizeEstimate";
let foundation: TemplateJson;

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
  const app = buildAgentXApp({ agentxEnv: "staging" });
  named = controlPlane(app, "agentx-staging-control-plane");
  foundation = controlPlane(app, "agentx-staging-foundation");
  const policy = app.node.findAll().find((node) => node instanceof iam.Policy && node.node.path.endsWith("/Broker/ServiceRole/DefaultPolicy")) as iam.Policy;
  // CDK's splitter uses these estimates on unresolved tokens, not serialized template length.
  const document = policy.document as unknown as { statements: Array<{ _estimateSize(options: { actionEstimate: number; arnEstimate: number }): number }> };
  brokerArnEstimate = (policy.node.tryGetContext(ARN_ESTIMATE_CONTEXT) as number | undefined) ?? 150;
  brokerEstimate = document.statements.reduce((total, statement) => total + statement._estimateSize({ actionEstimate: 20, arnEstimate: brokerArnEstimate }), 0);
  longestNamed = controlPlane(buildAgentXApp({ agentxEnv: LONGEST_ENV }), `agentx-${LONGEST_ENV}-control-plane`);
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
    expect(p.TaskPeopleChangesEnabled).toMatchObject({ Type: "String", Default: "false", AllowedValues: ["true", "false"] });
    expect(p.TaskPeoplePublicInvitationsEnabled).toMatchObject({ Type: "String", Default: "false", AllowedValues: ["true", "false"] });
    expect(p.TaskPeoplePrivateInvitationsEnabled).toMatchObject({ Type: "String", Default: "false", AllowedValues: ["true", "false"] });
    expect(p.WorkflowDependenciesEnabled).toMatchObject({ Type: "String", Default: "false", AllowedValues: ["true", "false"] });
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

  it("routes /v1/dev/* and /review/* to the broker without JWT, keeps /v1/auth/* on DeveloperIdentity, and leaves ANY /{proxy+} protected", () => {
    const routes = Object.fromEntries(ofType(named, "AWS::ApiGatewayV2::Route").map(([, resource]) => [resource.Properties.RouteKey as string, resource.Properties]));
    const authorizerId = (name: string) => ({ Ref: ofType(named, "AWS::ApiGatewayV2::Authorizer").find(([, r]) => r.Properties.Name === name)![0] });
    expect(routes["ANY /v1/dev/{proxy+}"]).toMatchObject({ AuthorizationType: "NONE", Target: routes["ANY /{proxy+}"]!.Target });
    expect(routes["ANY /v1/dev/{proxy+}"]!.AuthorizerId).toBeUndefined();
    expect(routes["ANY /review/{proxy+}"]).toMatchObject({ AuthorizationType: "NONE", Target: routes["ANY /{proxy+}"]!.Target });
    expect(routes["ANY /review/{proxy+}"]!.AuthorizerId).toBeUndefined();
    expect(routes["ANY /{proxy+}"]).toMatchObject({ AuthorizationType: "JWT", AuthorizerId: authorizerId("agentx-jwt") });
    const auth = routes["ANY /v1/auth/{proxy+}"]!;
    expect(auth.AuthorizationType).toBe("NONE");
    expect(auth.AuthorizerId).toBeUndefined();
    const [integrationId] = ofType(named, "AWS::ApiGatewayV2::Integration").find(([, r]) => JSON.stringify(r.Properties.IntegrationUri).includes(functionId(named, "DeveloperSignInFunction")))!;
    expect(auth.Target).toEqual({ "Fn::Join": ["", ["integrations/", { Ref: integrationId }]] });
  });

  it("signs with an RSA_2048 KMS key only the DeveloperIdentity role may use (R1)", () => {
    const keys = ofType(named, "AWS::KMS::Key").filter(([id]) => id.startsWith("DeveloperSignInTokenKey"));
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

  // Issue 173: the reconciler reads it too, for the unwaited task note's bot token (named environments only).
  it("lets only the ingress, the orchestrator task role, DeveloperIdentity, the task notifier and the reconciler read the Slack secret (R2, FR-034, #173)", () => {
    const [secretId] = ofType(named, "AWS::SecretsManager::Secret").find(([, resource]) => resource.Properties.Name === "agentx/staging/slack")!;
    const readers = rolesThatMay(named, "secretsmanager:GetSecretValue", secretId, SAMPLE_SLACK_SECRET_ARN);
    expect(readers).toEqual(["DeveloperSignInFunctionServiceRole", "DeveloperTaskNotifierFunctionServiceRole", "SessionsReconcilerServiceRole", "SlackIngressServiceRole", "SlackOrchestratorTaskRole"]);
  });

  it("lets DeveloperIdentity read only its own company sign-in secret besides the Slack secret, and the Slack adapter's signing secret", () => {
    const reads = statementsOfRole(named, "DeveloperSignInFunctionServiceRole").filter((s) => allows(s, "secretsmanager:GetSecretValue"));
    expect(reads).toHaveLength(3);
    expect(JSON.stringify(reads.map((s) => s.Resource))).toContain(":secret:agentx/staging/developer-oidc-??????");
    // Spec 062 Phase 7c1b: its Slack directory reads go through the adapter's commands once SlackViaChannel is on.
    expect(JSON.stringify(reads.map((s) => s.Resource))).toContain("ChannelApiSlackAdapterSecret");
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

  it("gives the broker only session, developer, email-index, sign-in client and membership reads on the sign-in table", () => {
    const [tableId] = ofType(named, "AWS::DynamoDB::Table").find(([logicalId]) => logicalId.startsWith("DeveloperSignInTable"))!;
    const tableStatements = statementsOfRole(named, "BrokerServiceRole").filter((statement) => touches(statement, "dynamodb") && reaches(named, statement, tableId, SAMPLE_TABLE_ARN));
    expect(tableStatements).toHaveLength(2);
    const reads = tableStatements.filter((statement) => actionsOf(statement).includes("dynamodb:GetItem"));
    const creatorChecks = tableStatements.filter((statement) => actionsOf(statement).includes("dynamodb:ConditionCheckItem"));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.Action).toBe("dynamodb:GetItem");
    expect(reads[0]!.Condition).toEqual({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*", "DEVELOPER#*", "EMAIL#*", "SIGNIN_CLIENTS", "COMPANY_MEMBER#*"] } });
    expect(creatorChecks).toHaveLength(1);
    expect(actionsOf(creatorChecks[0]!)).toEqual(["dynamodb:ConditionCheckItem"]);
    expect(creatorChecks[0]!.Condition).toEqual({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVELOPER#*"] },
      Null: { "dynamodb:LeadingKeys": "false" },
    });
  });

  it("gives DeveloperIdentity exactly the item operations its store uses on the sign-in table, nothing table-wide", () => {
    const [tableId] = ofType(named, "AWS::DynamoDB::Table").find(([logicalId]) => logicalId.startsWith("DeveloperSignInTable"))!;
    const tableStatements = statementsOfRole(named, "DeveloperSignInFunctionServiceRole").filter((statement) => touches(statement, "dynamodb") && reaches(named, statement, tableId, SAMPLE_TABLE_ARN));
    expect(tableStatements).toHaveLength(2);
    // TransactWriteItems is authorized per item as PutItem and UpdateItem; the store never condition-checks.
    expect(actionsOf(tableStatements[0]!).sort()).toEqual(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]);
    expect(tableStatements[0]!.Resource).toEqual({ "Fn::GetAtt": [tableId, "Arn"] });
    // Spec 063: it lists and removes sign-in clients, and deletes or queries nothing else.
    expect(actionsOf(tableStatements[1]!).sort()).toEqual(["dynamodb:DeleteItem", "dynamodb:Query"]);
    expect(tableStatements[1]!.Condition).toEqual({ "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["SIGNIN_CLIENTS"] }, Null: { "dynamodb:LeadingKeys": "false" } });
  });

  it("throttles the public /v1/auth/*, /v1/dev/*, and /review/* routes on the default stage (burst 50, 20 requests a second)", () => {
    const stages = ofType(named, "AWS::ApiGatewayV2::Stage");
    expect(stages).toHaveLength(1);
    const [, stage] = stages[0]!;
    expect(stage.Properties.RouteSettings).toEqual({
      "ANY /v1/auth/{proxy+}": { ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 },
      "ANY /v1/dev/{proxy+}": { ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 },
      "ANY /review/{proxy+}": { ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 },
    });
    // A stage's route settings name routes that must already exist.
    const routeId = (key: string) => ofType(named, "AWS::ApiGatewayV2::Route").find(([, r]) => r.Properties.RouteKey === key)![0];
    const dependsOn = [(stage as Resource & { DependsOn?: string | string[] }).DependsOn].flat();
    expect(dependsOn).toContain(routeId("ANY /v1/auth/{proxy+}"));
    expect(dependsOn).toContain(routeId("ANY /v1/dev/{proxy+}"));
    expect(dependsOn).toContain(routeId("ANY /review/{proxy+}"));
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
    expect(variables("Broker")).toMatchObject({
      AGENTX_TASK_PEOPLE_CHANGES_ENABLED: { Ref: "TaskPeopleChangesEnabled" },
      AGENTX_TASK_PEOPLE_PUBLIC_INVITATIONS_ENABLED: { Ref: "TaskPeoplePublicInvitationsEnabled" },
      AGENTX_TASK_PEOPLE_PRIVATE_INVITATIONS_ENABLED: { Ref: "TaskPeoplePrivateInvitationsEnabled" },
      AGENTX_WORKFLOW_DEPENDENCIES_ENABLED: { Ref: "WorkflowDependenciesEnabled" },
    });
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

describe("the legacy deployment (production)", () => {
  it("has the full developer sign-in and tasks, as named environments do, under its legacy names", () => {
    const text = JSON.stringify(legacy);
    for (const present of ["TaskPeopleChangesEnabled", "TaskPeoplePublicInvitationsEnabled", "TaskPeoplePrivateInvitationsEnabled", "WorkflowDependenciesEnabled", "McpConfirmElicitation",
      "AGENTX_WORKFLOW_DEPENDENCIES_ENABLED", "MCP_CONFIRM_ELICITATION", "ChatGptConnectionKey", "DeveloperTaskNotifier"]) {
      expect(text, present).toContain(present);
    }
    for (const present of ["SlackTeamId", "DeveloperSignInSlack", "DeveloperOidcIssuer", "DeveloperOidcClientId", "DeveloperOidcSince"]) expect(legacy.Parameters[present], present).toBeDefined();
    expect(legacy.Parameters.DeveloperSignInSlack).toMatchObject({ Default: "disabled" });
    expect(legacy.Parameters.DeveloperOidcIssuer).toMatchObject({ Default: "" });
    // Its own token key and the legacy names.
    expect(ofType(legacy, "AWS::KMS::Alias").map(([, r]) => r.Properties.AliasName)).toContain("alias/agentx/developer-tokens");
    const signIn = legacy.Resources[functionId(legacy, "DeveloperSignInFunction")]!;
    expect((signIn.Properties.Environment as { Variables: Record<string, unknown> }).Variables).toMatchObject({ AGENTX_ENV: "production", DEVELOPER_OIDC_SECRET_ID: "agentx/production/developer-oidc" });
    const broker = legacy.Resources[functionId(legacy, "Broker")]!;
    const brokerEnvironment = (broker.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(brokerEnvironment).toMatchObject({ AGENTX_ENV: "production" });
    expect(brokerEnvironment).not.toHaveProperty("DEVELOPER_API_SCOPE");
    // The developer-task grants: TASK# turn records and the cross-table condition check; admin changes audited under CHANGE#.
    const brokerRole = ((broker.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"])[0];
    const brokerStatements = grants(legacy).filter(({ role }) => role === brokerRole).map(({ statement }) => statement);
    expect(brokerStatements.some((statement) => allows(statement, "dynamodb:ConditionCheckItem") && JSON.stringify(statement.Resource).includes("DeveloperSignInTable"))).toBe(true);
    expect(JSON.stringify(brokerStatements)).toMatch(/TASK#\*/);
    expect(JSON.stringify(brokerStatements)).toContain("CHANGE#*");
    // The routes and their throttle, as in named environments; still only the one admin JWT authorizer.
    expect(ofType(legacy, "AWS::ApiGatewayV2::Route").map(([, r]) => r.Properties.RouteKey)).toEqual(expect.arrayContaining(["ANY /v1/auth/{proxy+}", "ANY /v1/dev/{proxy+}", "ANY /review/{proxy+}"]));
    expect(ofType(legacy, "AWS::ApiGatewayV2::Authorizer")).toHaveLength(1);
  });
});

describe("AI-tool turn records (spec 025 FR-037, R27)", () => {
  const brokerRole = (template: TemplateJson) => {
    const brokerFunction = template.Resources[functionId(template, "Broker")]!;
    return ((brokerFunction.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"])[0];
  };
  const turnTable = (template: TemplateJson) => ofType(template, "AWS::DynamoDB::Table").map(([id]) => id).find((id) => withoutHash(id) === "TurnRecords")!;

  it("lets the broker put items in TurnRecords only under TASK#, and (spec 025 25e) admin change audit records under CHANGE#", () => {
    const puts = grants(named).filter(({ role, statement }) => role === brokerRole(named) && allows(statement, "dynamodb:PutItem") && JSON.stringify(statement.Resource).includes(turnTable(named)));
    expect(puts).toHaveLength(2);
    // Each statement is chosen by its leading keys, so the order CDK emits them in does not matter.
    const putUnder = (key: string) => puts.filter(({ statement }) => JSON.stringify((statement.Condition as Record<string, Record<string, unknown>> | undefined)?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"]) === JSON.stringify([key]));
    const tasks = putUnder("TASK#*");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.statement.Condition).toEqual({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TASK#*"] } });
    expect(actionsOf(tasks[0]!.statement)).toEqual(["dynamodb:PutItem"]);
    // Spec 025 E3, FR-051: an admin change's audit record is written once, then stepped forward.
    const changes = putUnder("CHANGE#*");
    expect(changes).toHaveLength(1);
    expect(changes[0]!.statement.Condition).toEqual({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CHANGE#*"] } });
    expect(actionsOf(changes[0]!.statement)).toEqual(["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"]);
  });

  it("gives the broker no other write on TurnRecords: no delete or batch write, and an update only on CHANGE# audit records", () => {
    for (const action of ["dynamodb:DeleteItem", "dynamodb:BatchWriteItem"]) {
      expect(grants(named).some(({ role, statement }) => role === brokerRole(named) && allows(statement, action) && JSON.stringify(statement.Resource ?? "").includes(turnTable(named)))).toBe(false);
    }
    // Spec 025 25e changes this deliberately: an admin change audit record is stepped forward (E3).
    // The old assertion (no UpdateItem at all) now holds for every TurnRecords item outside CHANGE#.
    const updates = grants(named).filter(({ role, statement }) => role === brokerRole(named) && allows(statement, "dynamodb:UpdateItem") && JSON.stringify(statement.Resource ?? "").includes(turnTable(named)));
    expect(updates.map(({ statement }) => statement.Condition)).toEqual([{ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CHANGE#*"] } }]);
  });

  it("gives the legacy template (production) the same TASK# grants", () => {
    expect(grants(legacy).some(({ statement }) => (statement.Condition as Record<string, Record<string, unknown>> | undefined)?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"] !== undefined
      && JSON.stringify(statement.Condition).includes("TASK#"))).toBe(true);
  });
});

describe("the developer task notifier (spec 025 phase 25c, named environments)", () => {
  const stateId = () => ofType(named, "AWS::DynamoDB::Table").find(([id]) => withoutHash(id) === "State")![0];
  const streamMappings = (template: TemplateJson) => ofType(template, "AWS::Lambda::EventSourceMapping")
    .filter(([, mapping]) => JSON.stringify(mapping.Properties.EventSourceArn).includes("StreamArn"));

  it("runs the notifier with its table, queue, Slack secret and metrics namespace", () => {
    const [, notifier] = ofType(named, "AWS::Lambda::Function").find(([id]) => withoutHash(id) === "DeveloperTaskNotifierFunction")!;
    const variables = (notifier.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    const idOf = (type: string, prefix: string) => ofType(named, type).find(([id]) => withoutHash(id) === prefix)![0];
    const [secretId] = ofType(named, "AWS::SecretsManager::Secret").find(([, resource]) => resource.Properties.Name === "agentx/staging/slack")!;
    expect(variables).toMatchObject({
      STATE_TABLE_NAME: { Ref: stateId() },
      NOTICE_QUEUE_URL: { Ref: idOf("AWS::SQS::Queue", "DeveloperTaskNotifierNoticeQueue") },
      SLACK_SECRET_ARN: { Ref: secretId },
      AGENTX_METRICS_NAMESPACE: "AgentX/staging",
      AGENTX_TASK_PEOPLE_CHANGES_ENABLED: { Ref: "TaskPeopleChangesEnabled" },
    });
  });

  it("reads the state table's stream as its second and last reader, filtered to task, pointer and ended-operation changes (C7)", () => {
    const mappings = streamMappings(named);
    expect(mappings).toHaveLength(2);
    const notifierMapping = mappings.find(([, mapping]) => JSON.stringify(mapping.Properties.FunctionName).includes("DeveloperTaskNotifierFunction"))![1];
    const patterns = (notifierMapping.Properties.FilterCriteria as { Filters: Array<{ Pattern: string }> }).Filters.map((filter) => JSON.parse(filter.Pattern) as unknown);
    expect(patterns).toEqual([
      { dynamodb: { NewImage: { entityType: { S: ["DEVELOPER_TASK"] } } } },
      { dynamodb: { NewImage: { entityType: { S: ["DEVELOPER_TASK_POINTER"] } } } },
      // #342: every ended operation, so one that left its owner's ChatGPT plan says so; the code keeps a developer's
      // own for their notices and drops the rest.
      { dynamodb: { NewImage: { entityType: { S: ["OPERATION"] }, status: { S: ["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"] } } } },
      // Spec 025 E13: a fourth filter on this same mapping, never a third reader.
      { dynamodb: { NewImage: { entityType: { S: ["ADMIN_CHANGE"] } } } },
      // Task 19: a fifth, for refused Slack presses, on this same mapping. Spec 061: comment nudges share it, since a
      // mapping takes five filters by default.
      { dynamodb: { NewImage: { entityType: { S: ["WORKFLOW_ACTION_REFUSAL", "TASK_COMMENT_NUDGE", "TASK_PEOPLE_NOTIFICATION"] } } } },
    ]);
    expect(JSON.stringify(patterns.at(-1))).toContain("TASK_PEOPLE_NOTIFICATION");
    expect(notifierMapping.Properties).toMatchObject({ StartingPosition: "LATEST", MaximumRecordAgeInSeconds: 3600, MaximumRetryAttempts: 10, BisectBatchOnFunctionError: true });
    // A batch that still fails (the notice queue refusing sends, say) leaves a record of its shard and
    // sequence numbers, never its item images, and the operator is told.
    const [streamFailuresId] = ofType(named, "AWS::SQS::Queue").find(([id]) => withoutHash(id) === "DeveloperTaskNotifierStreamFailureQueue")!;
    expect(notifierMapping.Properties).toMatchObject({ DestinationConfig: { OnFailure: { Destination: { "Fn::GetAtt": [streamFailuresId, "Arn"] } } } });
  });

  it("consumes its own queue with per-message failures and a dead-letter queue", () => {
    const queueMappings = ofType(named, "AWS::Lambda::EventSourceMapping").filter(([, mapping]) => JSON.stringify(mapping.Properties.FunctionName).includes("DeveloperTaskNotifierFunction") && !JSON.stringify(mapping.Properties.EventSourceArn).includes("StreamArn"));
    expect(queueMappings).toHaveLength(1);
    // Ruling F15: one notice per invocation, so 10 s Slack calls never pass the 30 s timeout between a post and its marker.
    expect(queueMappings[0]![1].Properties).toMatchObject({ FunctionResponseTypes: ["ReportBatchItemFailures"], BatchSize: 1 });
    const [, notifier] = ofType(named, "AWS::Lambda::Function").find(([id]) => withoutHash(id) === "DeveloperTaskNotifierFunction")!;
    expect(notifier.Properties).toMatchObject({ Timeout: 30 });
    const [, queue] = ofType(named, "AWS::SQS::Queue").find(([id]) => withoutHash(id) === "DeveloperTaskNotifierNoticeQueue")!;
    expect(queue.Properties).toMatchObject({ MessageRetentionPeriod: 86_400, VisibilityTimeout: 180, SqsManagedSseEnabled: true });
    expect(queue.Properties.RedrivePolicy).toMatchObject({ maxReceiveCount: 100 });
  });

  it("limits closeout manifest access to the dedicated private task-closeout prefix", () => {
    const statements = statementsOfRole(named, "DeveloperTaskNotifierFunctionServiceRole");
    const closeout = statements.filter((statement) => JSON.stringify(statement.Resource).includes("private/task-closeouts"));
    expect(closeout).toHaveLength(1);
    expect(actionsOf(closeout[0]!).sort()).toEqual(["s3:GetObject", "s3:PutObject"]);
    expect(JSON.stringify(closeout[0]!.Resource)).toContain("private/task-closeouts/*/*");
    // The existing notice DLQ alarm is the exhausted closeout-work alarm; no new queue/service is introduced.
    expect(ofType(named, "AWS::CloudWatch::Alarm").some(([, alarm]) => alarm.Properties.AlarmName === "agentx-staging-DeveloperNoticeDeadLetters")).toBe(true);
  });

  it("gives the notifier only key-limited item access on the state table: no scan, no delete", () => {
    const statements = statementsOfRole(named, "DeveloperTaskNotifierFunctionServiceRole").filter((statement) => reaches(named, statement, stateId(), "arn:aws:dynamodb:us-east-1:111122223333:table/state"));
    const dynamo = statements.filter((statement) => touches(statement, "dynamodb") && !actionsOf(statement).some((action) => action.startsWith("dynamodb:DescribeStream") || action.startsWith("dynamodb:GetRecords") || action.startsWith("dynamodb:GetShardIterator") || action.startsWith("dynamodb:ListStreams")));
    for (const statement of dynamo) {
      expect(statement.Condition).toMatchObject({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": expect.any(Array) as unknown } });
      for (const forbidden of ["dynamodb:Scan", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"]) expect(allows(statement, forbidden)).toBe(false);
    }
    // The task read is chosen by its leading keys, not by position among the GetItem statements.
    const reads = dynamo.filter((statement) => allows(statement, "dynamodb:GetItem") && leadingKeysOf(statement).includes("DEVTASK#*"));
    expect(reads).toHaveLength(1);
    expect([...leadingKeysOf(reads[0]!)].sort()).toEqual(["CHATGPT_NOTICE#*", "DEVTASK#*", "OPERATION#*", "WORKSPACE#*"]);
    expect(actionsOf(reads[0]!).sort()).toEqual(["dynamodb:GetItem", "dynamodb:Query"]);
    const keysOf = (statement: Statement) => leadingKeysOf(statement);
    const writes = dynamo.filter((statement) => allows(statement, "dynamodb:PutItem") || allows(statement, "dynamodb:UpdateItem"));
    expect(writes).toHaveLength(4);
    // The task and its notice markers are put and updated; a shared thread record is only put;
    // an admin change (spec 025 E13) is only read and updated, never put; a ChatGPT fallback's notice
    // marker (#342) is only put.
    expect(writes.map((statement) => ({ actions: actionsOf(statement).sort(), keys: keysOf(statement) }))).toEqual(expect.arrayContaining([
      { actions: ["dynamodb:PutItem", "dynamodb:UpdateItem"], keys: ["DEVTASK#*"] },
      { actions: ["dynamodb:PutItem"], keys: ["SHARED_TASK#*"] },
      { actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"], keys: ["ADMIN_CHANGE#*"] },
      { actions: ["dynamodb:PutItem"], keys: ["CHATGPT_NOTICE#*"] },
    ]));
  });

  it("lets the ingress read shared thread records, and the broker read Slack thread counters, by key", () => {
    const [, ingress] = ofType(named, "AWS::Lambda::Function").find(([id]) => withoutHash(id) === "SlackIngress")!;
    expect((ingress.Properties.Environment as { Variables: Record<string, unknown> }).Variables).toMatchObject({ SHARED_TASKS: "enabled" });
    expect(statementsOfRole(named, "SlackIngressServiceRole")).toContainEqual(expect.objectContaining({
      Action: "dynamodb:GetItem", Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SHARED_TASK#*"] } },
    }));
    expect(statementsOfRole(named, "BrokerServiceRole")).toContainEqual(expect.objectContaining({
      Action: "dynamodb:GetItem", Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["THREAD#*"] } },
    }));
  });

  it("tells the operator when a notice or a stream batch is dead-lettered", () => {
    for (const [queue, name] of [["DeveloperTaskNotifierNoticeDeadLetterQueue", "agentx-staging-DeveloperNoticeDeadLetters"], ["DeveloperTaskNotifierStreamFailureQueue", "agentx-staging-DeveloperNoticeStreamFailures"]] as const) {
      const [queueId] = ofType(named, "AWS::SQS::Queue").find(([id]) => withoutHash(id) === queue)!;
      const [, alarm] = ofType(named, "AWS::CloudWatch::Alarm").find(([, resource]) => resource.Properties.AlarmName === name)!;
      expect(alarm.Properties).toMatchObject({
        MetricName: "ApproximateNumberOfMessagesVisible", Namespace: "AWS/SQS", Dimensions: [{ Name: "QueueName", Value: { "Fn::GetAtt": [queueId, "QueueName"] } }],
        Threshold: 1, ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching",
      });
      expect(JSON.stringify(alarm.Properties.AlarmActions)).toContain("OperatorAlerts");
    }
  });

  it("runs in the legacy template (production) too, with Slack task threads on", () => {
    expect(ofType(legacy, "AWS::Lambda::Function").map(([id]) => withoutHash(id))).toContain("DeveloperTaskNotifierFunction");
    expect(ofType(legacy, "AWS::CloudWatch::Alarm").map(([, resource]) => JSON.stringify(resource.Properties.AlarmName))).toContainEqual(expect.stringContaining("DeveloperNotice"));
    expect(streamMappings(legacy)).toHaveLength(streamMappings(named).length);
    const [, ingress] = ofType(legacy, "AWS::Lambda::Function").find(([id]) => withoutHash(id) === "SlackIngress")!;
    expect((ingress.Properties.Environment as { Variables: Record<string, unknown> }).Variables).toMatchObject({ SHARED_TASKS: "enabled" });
  });
});


const roleArn = (role: string) => ({ "Fn::GetAtt": [role, "Arn"] });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Restricted evaluator for these KMS policies: explicit Deny wins; ArnNotEquals is NOR.
 * Only root delegation permits identity-policy grants. Unknown conditions fail the test. */
function keyAllows(template: TemplateJson, keyId: string, role: string, action: string, identityOverride?: Statement[]): boolean {
  const statements = statementsIn(template.Resources[keyId]!.Properties.KeyPolicy);
  const arn = roleArn(role);
  const matchesPrincipal = (statement: Statement) => {
    const aws = (statement.Principal as { AWS?: unknown })?.AWS;
    return [aws].flat().some((principal) => principal === "*" || same(principal, arn));
  };
  const matchesCondition = (statement: Statement) => {
    if (statement.Condition === undefined) return true;
    expect(Object.keys(statement.Condition)).toEqual(["ArnNotEquals"]);
    const condition = statement.Condition.ArnNotEquals as Record<string, unknown>;
    expect(Object.keys(condition)).toEqual(["aws:PrincipalArn"]);
    return ![condition["aws:PrincipalArn"]].flat().some((exempt) => same(exempt, arn));
  };
  const matching = statements.filter((s) => allows(s, action) && reaches(template, s, keyId, SAMPLE_KEY_ARN) && matchesPrincipal(s) && matchesCondition(s));
  if (matching.some((s) => s.Effect === "Deny")) return false;
  if (matching.some((s) => s.Effect === "Allow")) return true;
  const rootDelegates = statements.some((s) => s.Effect === "Allow" && allows(s, action) && s.Condition === undefined && s.Resource === "*"
    && same(s.Principal, { AWS: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::", { Ref: "AWS::AccountId" }, ":root"]] } }));
  const identity = identityOverride ?? statementsOfRole(template, withoutHash(role));
  const applicable = identity.filter((s) => allows(s, action) && reaches(template, s, keyId, SAMPLE_KEY_ARN));
  return rootDelegates && !applicable.some((s) => s.Effect === "Deny") && applicable.some((s) => s.Effect === "Allow");
}

function signingKey(template: TemplateJson, prefix: string): [string, Resource] {
  const entries = ofType(template, "AWS::KMS::Key").filter(([id]) => id.startsWith(prefix));
  expect(entries, `${prefix} must exist even before the gateway is enabled`).toHaveLength(1);
  return entries[0]!;
}

describe("task-token key and membership IAM", () => {
  it("creates the named task key before gateway enablement, with no key in legacy", () => {
    const [id, key] = signingKey(named, "DeveloperSignInTaskTokenKey");
    expect(key.Properties).toMatchObject({ KeySpec: "RSA_2048", KeyUsage: "SIGN_VERIFY", PendingWindowInDays: 7, Description: "Signs AgentX staging task tokens" });
    expect(key.Properties.EnableKeyRotation ?? false).toBe(false);
    expect(key.DeletionPolicy).toBe("Delete");
    expect(key.UpdateReplacePolicy).toBe("Delete");
    expect(ofType(named, "AWS::KMS::Alias").filter(([, r]) => r.Properties.AliasName === "alias/agentx/staging/task-tokens").map(([, r]) => r.Properties.TargetKeyId)).toEqual([{ "Fn::GetAtt": [id, "Arn"] }]);
    expect(JSON.stringify(legacy)).not.toContain("TaskTokenKey");
    expect(JSON.stringify(legacy)).not.toContain("TASK_TOKEN_KEY_ARN");
    for (const prefix of ["Broker", "DeveloperSignInFunction"]) {
      const variables = (named.Resources[functionId(named, prefix)]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
      expect(variables.TASK_TOKEN_KEY_ARN).toEqual(roleArn(id));
      if (prefix === "DeveloperSignInFunction") expect(variables.DEVELOPER_TOKEN_KEY_ARN).toEqual(roleArn(signingKey(named, "DeveloperSignInTokenKey")[0]));
    }
  });

  it("changes only the named task key, alias, two env vars, public read and membership list item", () => {
    const remainder = structuredClone(named);
    const [taskId] = signingKey(remainder, "DeveloperSignInTaskTokenKey");
    delete remainder.Resources[taskId];
    const aliases = ofType(remainder, "AWS::KMS::Alias").filter(([, r]) => r.Properties.AliasName === "alias/agentx/staging/task-tokens");
    expect(aliases).toHaveLength(1);
    delete remainder.Resources[aliases[0]![0]];
    for (const prefix of ["Broker", "DeveloperSignInFunction"]) {
      const variables = (remainder.Resources[functionId(remainder, prefix)]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
      delete variables.TASK_TOKEN_KEY_ARN;
    }
    let reads = 0;
    let families = 0;
    for (const [, policy] of ofType(remainder, "AWS::IAM::Policy")) {
      const document = policy.Properties.PolicyDocument as { Statement: Statement[] };
      document.Statement = document.Statement.filter((s) => {
        if (!JSON.stringify(s.Resource).includes(taskId)) return true;
        expect(actionsOf(s)).toEqual(["kms:GetPublicKey"]);
        expect(JSON.stringify(policy.Properties.Roles)).toContain("DeveloperSignInFunctionServiceRole");
        reads += 1;
        return false;
      });
      for (const s of document.Statement) {
        const condition = s.Condition?.["ForAllValues:StringLike"] as { "dynamodb:LeadingKeys"?: string[] } | undefined;
        if (condition?.["dynamodb:LeadingKeys"]?.includes("COMPANY_MEMBER#*")) {
          condition["dynamodb:LeadingKeys"] = condition["dynamodb:LeadingKeys"].filter((key) => key !== "COMPANY_MEMBER#*");
          families += 1;
        }
      }
    }
    expect([reads, families]).toEqual([1, 1]);
    // The core engine's named-environment addition (E2) is checked in full by core-engine-infrastructure.test.ts; its shape is asserted here, then it is taken out so the digest still pins everything else.
    withoutCoreEngine(remainder);
    // The switch-over parity additions (evidence expiry rules, broker names) are checked in full by switchover-parity-infrastructure.test.ts; shape asserted, then taken out.
    withoutSwitchoverControlPlaneParity(remainder);
    const text = JSON.stringify(remainder).replace(/[a-f0-9]{64}/g, "<asset-hash>");
    // Re-pinned after reviewing the named-only IAM headroom policy diff; all R3R4 assertions remain.
    expect(createHash("sha256").update(text).digest("hex")).toBe("a1dd557411883920332ddf90e23cec2c6c20be9bc3e178fcd378f4dfad9bfc7b");
  });

  it("keeps the developer key resource byte-identical to the base", () => {
    const [, key] = signingKey(named, "DeveloperSignInTokenKey");
    expect(createHash("sha256").update(JSON.stringify(key)).digest("hex")).toBe("985e0782f6f8b959676a82fb7253a1b6d909109a2dbef0db16678f35e0640b47");
  });

  it("allows only the broker to sign task tokens and only DeveloperIdentity to sign developer tokens, including an overprivileged probe", () => {
    const [taskId, task] = signingKey(named, "DeveloperSignInTaskTokenKey");
    const [devId] = signingKey(named, "DeveloperSignInTokenKey");
    const roles = ofType(named, "AWS::IAM::Role").map(([id]) => id);
    const broker = roles.find((id) => withoutHash(id) === "BrokerServiceRole")!;
    const developer = roles.find((id) => withoutHash(id) === "DeveloperSignInFunctionServiceRole")!;
    const broad: Statement[] = [{ Effect: "Allow", Action: "kms:*", Resource: "*" }];
    for (const role of [...roles, "ProbeRole"]) {
      for (const [key, action, expected] of [
        [taskId, "kms:Sign", role === broker], [taskId, "kms:GetPublicKey", role === broker || role === developer],
        [devId, "kms:Sign", role === developer], [devId, "kms:GetPublicKey", role === developer],
      ] as const) expect(keyAllows(named, key, role, action, role === "ProbeRole" ? broad : undefined), `${role} ${action} ${key}`).toBe(expected);
    }
    expect(keyAllows(named, taskId, developer, "kms:Sign", broad)).toBe(false);
    // M1: a redundant identity grant is still forbidden even while the Deny masks it.
    const direct = statementsIn(task.Properties.KeyPolicy).filter((s) => s.Effect === "Allow" && same(s.Principal, { AWS: roleArn(broker) }));
    expect(direct).toHaveLength(1);
    expect(actionsOf(direct[0]!).sort()).toEqual(["kms:GetPublicKey", "kms:Sign"]);
    expect(statementsIn(task.Properties.KeyPolicy).filter((s) => s.Effect === "Allow" && allows(s, "kms:Sign"))).toHaveLength(2); // root and broker only
    expect(statementsOfRole(named, "DeveloperSignInFunctionServiceRole").filter((s) => touches(s, "kms") && reaches(named, s, taskId, SAMPLE_KEY_ARN)).flatMap(actionsOf)).toEqual(["kms:GetPublicKey"]);
  });

  it("keeps the R3R4 task-token grant out of broker identity policies", () => {
    expect(JSON.stringify(statementsOfRole(named, "BrokerServiceRole"))).not.toContain("TaskTokenKey");
  });

  it("keeps State-table reads unconditioned; tightening them must retain COMPANY_MEMBER and ORG families", () => {
    const [id] = ofType(named, "AWS::DynamoDB::Table").find(([id]) => withoutHash(id) === "State")!;
    const statements = statementsOfRole(named, "BrokerServiceRole").filter((s) => allows(s, "dynamodb:GetItem") && reaches(named, s, id, "arn:aws:dynamodb:us-east-1:111122223333:table/state"));
    expect(statements).toHaveLength(1);
    expect(statements[0]!.Condition, "State LeadingKeys tightening must explicitly keep COMPANY_MEMBER#* and ORG#*").toBeUndefined();
    for (const template of [named, legacy]) {
      const [signIn] = ofType(template, "AWS::DynamoDB::Table").find(([id]) => id.startsWith("DeveloperSignInTable"))!;
      const grants = statementsOfRole(template, "BrokerServiceRole").filter((s) => touches(s, "dynamodb") && reaches(template, s, signIn, SAMPLE_TABLE_ARN));
      for (const action of ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"]) expect(grants.some((s) => allows(s, action))).toBe(false);
      if (template === legacy) expect(leadingKeysOf(grants.find((s) => allows(s, "dynamodb:GetItem"))!)).toEqual(["SESSION#*", "DEVELOPER#*", "EMAIL#*", "SIGNIN_CLIENTS"]);
      for (const s of statementsOfRole(template, "BrokerServiceRole").filter((s) => touches(s, "dynamodb") && s.Condition?.["ForAllValues:StringLike"] !== undefined)) {
        const keys = leadingKeysOf(s);
        expect(keys).not.toContain("ORG#*");
        if (keys.includes("COMPANY_MEMBER#*")) expect(actionsOf(s)).toEqual(["dynamodb:GetItem"]);
      }
    }
  });
});

// Pure policy checks: no AWS API calls and no additional identity grants.

const policyScope = { env: "staging", partition: "aws", region: "us-east-1", account: "111122223333", artifactBucketArn: "arn:aws:s3:::agentx-artifacts", pullThroughPrefix: "agentx", cloudFormationRoleName: "agentx-staging-cloudformation" };
const boundary = defaultBoundaryStatements(policyScope);
const deploy = serviceRoleStatements(policyScope);
const boundaryArn = "arn:aws:iam::111122223333:policy/agentx/staging/agentx-staging-boundary";
const sampleRole = "arn:aws:iam::111122223333:role/agentx/staging/example";
function policyAllows(policy: PolicyStatementJson[], action: string, resource: string, context: Record<string, string> = {}): boolean {
  const matches = policy.filter((s) => allows(s, action) && [s.Resource].flat().some((r) => globRegExp(r).test(resource))
    && Object.entries(s.Condition ?? {}).every(([operator, entries]) => Object.entries(entries).every(([key, values]) => {
      const equal = [values].flat().some((value) => operator === "StringLike" ? globRegExp(value).test(context[key] ?? "") : value === context[key]);
      expect(["StringNotEquals", "StringLike", "StringEquals"]).toContain(operator);
      return operator === "StringNotEquals" ? !equal : equal;
    })));
  return matches.some((s) => s.Effect === "Allow") && !matches.some((s) => s.Effect === "Deny");
}

describe("task key deployment boundary coverage", () => {
  it("maps every rendered resource type to an allowed deploy service, with existing scoped IAM and Budget exceptions", () => {
    const types: Record<string, string> = {
      "AWS::DynamoDB::Table": "dynamodb", "AWS::S3::Bucket": "s3", "AWS::S3::BucketPolicy": "s3", "AWS::SQS::Queue": "sqs", "AWS::SQS::QueuePolicy": "sqs",
      "AWS::Logs::LogGroup": "logs", "AWS::Logs::MetricFilter": "logs", "AWS::Lambda::Function": "lambda", "AWS::Lambda::Permission": "lambda",
      "AWS::Lambda::EventInvokeConfig": "lambda", "AWS::Lambda::EventSourceMapping": "lambda", "AWS::KMS::Key": "kms", "AWS::KMS::Alias": "kms",
      "AWS::SecretsManager::Secret": "secretsmanager", "AWS::SNS::Topic": "sns", "AWS::SNS::TopicPolicy": "sns", "AWS::CloudWatch::Alarm": "cloudwatch",
      "AWS::ApiGatewayV2::Api": "apigateway", "AWS::ApiGatewayV2::Integration": "apigateway", "AWS::ApiGatewayV2::Authorizer": "apigateway",
      "AWS::ApiGatewayV2::Route": "apigateway", "AWS::ApiGatewayV2::Stage": "apigateway", "AWS::Scheduler::Schedule": "scheduler", "AWS::Scheduler::ScheduleGroup": "scheduler", "AWS::StepFunctions::StateMachine": "states",
    };
    for (const type of new Set(Object.values(named.Resources).map((r) => r.Type))) {
      let action: string;
      let resource = "*";
      let context: Record<string, string> = {};
      if (type === "AWS::IAM::Role" || type === "AWS::IAM::Policy") {
        action = type === "AWS::IAM::Role" ? "iam:CreateRole" : "iam:PutRolePolicy";
        resource = sampleRole;
        context = { "iam:PermissionsBoundary": boundaryArn };
        expect(deploy.find((s) => s.Sid === "IamRoles")?.Resource).toBe("arn:aws:iam::111122223333:role/agentx/staging/*");
      } else if (type === "AWS::Budgets::Budget") {
        action = "budgets:ModifyBudget";
        resource = "arn:aws:budgets::111122223333:budget/agentx-staging-monthly";
        expect(deploy.find((s) => s.Sid === "Budget")?.Resource).toBe(resource);
      } else {
        const service = types[type];
        expect(service, `unknown resource type ${type}: map and check its deployment permissions`).toBeDefined();
        expect(SERVICE_ROLE_SERVICES, type).toContain(service);
        action = `${service}:*`;
      }
      expect(policyAllows(deploy, action, resource, context), `${type} deploy`).toBe(true);
      expect(policyAllows(boundary, action, resource, context), `${type} boundary`).toBe(true);
    }
    expect(policyAllows(deploy, "iam:CreateRole", sampleRole)).toBe(false);
    expect(policyAllows(deploy, "iam:CreateRole", sampleRole.replace("staging", "other"), { "iam:PermissionsBoundary": boundaryArn })).toBe(false);
    expect(policyAllows(deploy, "budgets:ModifyBudget", "arn:aws:budgets::111122223333:budget/agentx-other-monthly")).toBe(false);
  });

  it("covers the schedule-group lifecycle the core engine's group needs, in the deploy role and the boundary", () => {
    // AWS::Scheduler::ScheduleGroup (core engine, lane E2): CloudFormation creates, tags and deletes it with these calls. The deploy role and the default boundary already allow the
    // scheduler service by wildcard (SERVICE_ROLE_SERVICES, BOUNDARY_SERVICES), so no policy changed; this pins that it stays so.
    const group = "arn:aws:scheduler:us-east-1:111122223333:schedule-group/agentx-staging-core-jobs";
    for (const action of ["scheduler:CreateScheduleGroup", "scheduler:GetScheduleGroup", "scheduler:DeleteScheduleGroup", "scheduler:TagResource", "scheduler:UntagResource", "scheduler:ListTagsForResource"]) {
      for (const policy of [deploy, boundary]) expect(policyAllows(policy, action, group), action).toBe(true);
    }
  });

  it("covers KMS lifecycle actions while refusing managed-policy creation", () => {
    for (const action of ["kms:CreateKey", "kms:PutKeyPolicy", "kms:DescribeKey", "kms:GetKeyPolicy", "kms:TagResource", "kms:ScheduleKeyDeletion", "kms:CreateAlias", "kms:UpdateAlias", "kms:DeleteAlias", "kms:ListAliases"]) {
      for (const policy of [deploy, boundary]) expect(policyAllows(policy, action, "*"), action).toBe(true);
    }
    for (const policy of [deploy, boundary]) expect(policyAllows(policy, "iam:CreatePolicy", "*"), "the deploy role cannot create a split managed policy").toBe(false);
    expect(boundary.some((s) => s.Effect === "Deny" && allows(s, "iam:CreatePolicy"))).toBe(true);
  });

  it("bounds every role-policy Allow action without a matching boundary Deny", () => {
    for (const { role, statement } of grants(named).filter(({ statement }) => statement.Effect === "Allow")) {
      for (const action of actionsOf(statement)) {
        // All non-IAM runtime actions are service-wide in the default boundary.
        // PassRole is the only scoped runtime exception; verify its rendered resource too.
        const resource = action.toLowerCase() === "iam:passrole" ? sampleRole : "*";
        expect(policyAllows(boundary, action, resource), `${role}: ${action}`).toBe(true);
        if (action.toLowerCase() === "iam:passrole") {
          for (const r of [statement.Resource].flat()) {
            const text = JSON.stringify(r);
            const localRole = ofType(named, "AWS::IAM::Role").find(([id]) => text.includes(`"${id}"`));
            if (localRole !== undefined) expect(localRole[1].Properties.Path).toBe("/agentx/staging/");
            else if (same(r, { Ref: "Ec2WorkerInstanceRoleArn" })) {
              const output = foundation.Outputs.Ec2WorkerInstanceRoleArn!.Value as { "Fn::GetAtt": [string, string] };
              expect(output["Fn::GetAtt"][1]).toBe("Arn");
              expect(foundation.Resources[output["Fn::GetAtt"][0]]!.Properties.Path).toBe("/agentx/staging/");
            } else expect(text).toContain(":role/agentx/staging/");
          }
        }
      }
    }
  });
});

// IAM headroom: frozen data captured from d605c7b24b0ac3ce4c2b015d8a70d1195593391a.
// Kept in this existing test because this lane cannot add files under the port guard.
type AccessTuple = [principal: string, effect: string, action: string, resource: string, condition: string];
const symbolicTypes: Record<string, string> = {
  "AWS::S3::Bucket": "bucket", "AWS::SQS::Queue": "queue", "AWS::KMS::Key": "key",
  "AWS::DynamoDB::Table": "table", "AWS::Lambda::Function": "function", "AWS::IAM::Role": "role",
  "AWS::StepFunctions::StateMachine": "machine", "AWS::SNS::Topic": "topic", "AWS::SecretsManager::Secret": "secret",
};
function symbol(template: TemplateJson, value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("unsupported IAM symbol");
  const node = value as Record<string, unknown>;
  if (Object.keys(node).length !== 1) throw new Error("unsupported IAM symbol");
  if (typeof node.Ref === "string") {
    const resource = template.Resources[node.Ref];
    return resource === undefined ? `parameter:${node.Ref}` : `${symbolicTypes[resource.Type] ?? resource.Type}:${withoutHash(node.Ref)}`;
  }
  if (Array.isArray(node["Fn::GetAtt"])) {
    const [id, attribute] = node["Fn::GetAtt"] as unknown[];
    if (typeof id !== "string" || typeof attribute !== "string" || template.Resources[id] === undefined) throw new Error("unsupported IAM symbol");
    return `${symbolicTypes[template.Resources[id].Type] ?? template.Resources[id].Type}:${withoutHash(id)}${attribute === "Arn" ? "" : `/${attribute}`}`;
  }
  if (Array.isArray(node["Fn::Join"])) {
    const [delimiter, parts] = node["Fn::Join"] as unknown[];
    if (typeof delimiter !== "string" || !Array.isArray(parts)) throw new Error("unsupported IAM symbol");
    return parts.map((part: unknown) => symbol(template, part)).join(delimiter);
  }
  // External worker role is derived from a parameter ARN: retain the entire opaque expression,
  // never guess which role or resource it names.
  if (Array.isArray(node["Fn::Select"]) || Array.isArray(node["Fn::Split"])) return `expression:${JSON.stringify(value)}`;
  throw new Error("unsupported IAM symbol");
}
const conditionOperators = new Set(["ForAllValues:StringLike", "ForAllValues:StringEquals", "StringEquals", "StringEqualsIfExists", "Bool", "Null", "ArnNotEquals", "ArnEquals", "ArnLike"]);
function conditionText(template: TemplateJson, value: unknown): string {
  if (value === undefined) return "{}";
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("unsupported IAM condition");
  const entries = Object.entries(value as Record<string, unknown>).sort().map(([operator, fields]) => {
    if (!conditionOperators.has(operator) || fields === null || typeof fields !== "object" || Array.isArray(fields)) throw new Error("unsupported IAM condition");
    return [operator, Object.fromEntries(Object.entries(fields).sort().map(([key, values]) => {
      const items = [values].flat();
      if (items.length === 0) throw new Error("unsupported IAM condition");
      return [key, items.map((v) => symbol(template, v)).sort()];
    }))];
  });
  return JSON.stringify(Object.fromEntries(entries));
}
function resourceStatements(template: TemplateJson): Array<{ owner: string; statement: Statement }> {
  return Object.entries(template.Resources).flatMap(([id, r]) => {
    const field = r.Type === "AWS::KMS::Key" ? "KeyPolicy" : ["AWS::SQS::QueuePolicy", "AWS::S3::BucketPolicy"].includes(r.Type) ? "PolicyDocument" : undefined;
    return field === undefined ? [] : statementsIn(r.Properties[field]).map((statement) => ({ owner: id, statement }));
  });
}
function accessTuples(template: TemplateJson): AccessTuple[] {
  const tuples: AccessTuple[] = [];
  const add = (principal: string, s: Statement, owner?: string) => {
    if (!["Allow", "Deny"].includes(s.Effect ?? "") || s.Resource === undefined || !actionsOf(s).every((a) => typeof a === "string") || Object.keys(s).some((key) => !["Effect", "Sid", "Action", "Resource", "Principal", "Condition"].includes(key))) throw new Error("unsupported IAM statement");
    const condition = conditionText(template, s.Condition);
    for (const action of actionsOf(s)) for (const resource of [s.Resource].flat()) {
      const resolved = owner !== undefined && template.Resources[owner]!.Type === "AWS::KMS::Key" && resource === "*" ? `key:${withoutHash(owner)}` : symbol(template, resource);
      tuples.push([principal, s.Effect!, action, resolved, condition]);
    }
  };
  for (const { role, statement } of grants(template)) add(`role:${withoutHash(role)}`, statement);
  for (const { owner, statement } of resourceStatements(template)) {
    const principal = statement.Principal;
    if (principal === "*") { add("*", statement, owner); continue; }
    if (principal === null || typeof principal !== "object" || Array.isArray(principal)) throw new Error("unsupported IAM principal");
    const p = principal as Record<string, unknown>;
    if (Object.keys(p).length !== 1 || p.AWS === undefined) throw new Error("unsupported IAM principal");
    for (const aws of [p.AWS].flat() as unknown[]) {
      const name = symbol(template, aws);
      // Root delegation is not a direct grant to every role; compare it separately below.
      if (name === "arn:parameter:AWS::Partition:iam::parameter:AWS::AccountId:root") continue;
      if (name !== "*" && !name.startsWith("role:")) throw new Error("unsupported IAM principal");
      add(name, statement, owner);
    }
  }
  return [...new Map(tuples.map((tuple) => [JSON.stringify(tuple), tuple])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

// The broker's effective access before INFRA-IAM-HEADROOM moved grants into resource policies, plus #663's reviewed core-engine grants (the broker on its own
// CoreEngineJobs queue and dead letters, the schedules' role invoking the broker), which landed beside it in the 2026-11-15 batch.
const beforeTuples: AccessTuple[] = [
  ["*","Deny","kms:GetPublicKey","key:DeveloperSignInTaskTokenKey","{\"ArnNotEquals\":{\"aws:PrincipalArn\":[\"role:BrokerServiceRole\",\"role:DeveloperSignInFunctionServiceRole\"]}}"],
  ["*","Deny","kms:GetPublicKey","key:DeveloperSignInTokenKey","{\"ArnNotEquals\":{\"aws:PrincipalArn\":[\"role:DeveloperSignInFunctionServiceRole\"]}}"],
  ["*","Deny","kms:Sign","key:DeveloperSignInTaskTokenKey","{\"ArnNotEquals\":{\"aws:PrincipalArn\":[\"role:BrokerServiceRole\"]}}"],
  ["*","Deny","kms:Sign","key:DeveloperSignInTokenKey","{\"ArnNotEquals\":{\"aws:PrincipalArn\":[\"role:DeveloperSignInFunctionServiceRole\"]}}"],
  ["*","Deny","kms:Sign","key:InvokeSigningKey","{\"ArnNotEquals\":{\"aws:PrincipalArn\":[\"role:DispatcherServiceRole\"]}}"],
  ["*","Deny","s3:*","bucket:Artifacts","{\"Bool\":{\"aws:SecureTransport\":[\"false\"]}}"],
  ["*","Deny","s3:*","bucket:Artifacts/*","{\"Bool\":{\"aws:SecureTransport\":[\"false\"]}}"],
  ["*","Deny","s3:*","bucket:SlackThreadSessions","{\"Bool\":{\"aws:SecureTransport\":[\"false\"]}}"],
  ["*","Deny","s3:*","bucket:SlackThreadSessions/*","{\"Bool\":{\"aws:SecureTransport\":[\"false\"]}}"],
  ["*","Deny","sqs:*","queue:ChannelApiEventDeadLetters","{\"Bool\":{\"aws:SecureTransport\":[\"false\"]}}"],
  ["*","Deny","sqs:*","queue:ChannelApiEvents","{\"Bool\":{\"aws:SecureTransport\":[\"false\"]}}"],
  ["*","Deny","sqs:*","queue:ChannelApiRequestDeadLetters","{\"Bool\":{\"aws:SecureTransport\":[\"false\"]}}"],
  ["*","Deny","sqs:*","queue:ChannelApiRequests","{\"Bool\":{\"aws:SecureTransport\":[\"false\"]}}"],
  ["*","Deny","sqs:*","queue:DeveloperTaskNotifierNoticeDeadLetterQueue","{\"Bool\":{\"aws:SecureTransport\":[\"false\"]}}"],
  ["*","Deny","sqs:*","queue:DeveloperTaskNotifierNoticeQueue","{\"Bool\":{\"aws:SecureTransport\":[\"false\"]}}"],
  ["*","Deny","sqs:*","queue:DeveloperTaskNotifierStreamFailureQueue","{\"Bool\":{\"aws:SecureTransport\":[\"false\"]}}"],
  ["role:BrokerServiceRole","Allow","cloudwatch:DescribeAlarms","arn:parameter:AWS::Partition:cloudwatch:parameter:AWS::Region:parameter:AWS::AccountId:alarm:agentx-staging-*","{}"],
  ["role:BrokerServiceRole","Allow","codebuild:BatchGetBuilds","arn:parameter:AWS::Partition:codebuild:parameter:AWS::Region:parameter:AWS::AccountId:project/agentx-*","{}"],
  ["role:BrokerServiceRole","Allow","codebuild:StartBuild","arn:parameter:AWS::Partition:codebuild:parameter:AWS::Region:parameter:AWS::AccountId:project/agentx-*","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:BatchGetItem","table:State","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:BatchGetItem","table:State/index/*","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:BatchWriteItem","table:State","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:BatchWriteItem","table:State/index/*","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:ConditionCheckItem","table:DeveloperSignInTable","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"DEVELOPER#*\"]},\"Null\":{\"dynamodb:LeadingKeys\":[\"false\"]}}"],
  ["role:BrokerServiceRole","Allow","dynamodb:ConditionCheckItem","table:State","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:ConditionCheckItem","table:State/index/*","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:DeleteItem","table:State","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:DeleteItem","table:State/index/*","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:DescribeTable","table:State","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:DescribeTable","table:State/index/*","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:GetItem","table:DeveloperSignInTable","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"COMPANY_MEMBER#*\",\"DEVELOPER#*\",\"EMAIL#*\",\"SESSION#*\",\"SIGNIN_CLIENTS\"]}}"],
  ["role:BrokerServiceRole","Allow","dynamodb:GetItem","table:SlackThreads","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"THREAD#*\"]}}"],
  ["role:BrokerServiceRole","Allow","dynamodb:GetItem","table:State","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:GetItem","table:State/index/*","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:GetItem","table:TurnRecords","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"CHANGE#*\"]}}"],
  ["role:BrokerServiceRole","Allow","dynamodb:GetRecords","table:State","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:GetRecords","table:State/index/*","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:GetShardIterator","table:State","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:GetShardIterator","table:State/index/*","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:PutItem","table:State","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:PutItem","table:State/index/*","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:PutItem","table:TurnRecords","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"CHANGE#*\"]}}"],
  ["role:BrokerServiceRole","Allow","dynamodb:PutItem","table:TurnRecords","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"TASK#*\"]}}"],
  ["role:BrokerServiceRole","Allow","dynamodb:Query","table:State","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:Query","table:State/index/*","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:Query","table:TurnRecords","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:Query","table:TurnRecords/index/byTime","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:Scan","table:State","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:Scan","table:State/index/*","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:UpdateItem","table:State","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:UpdateItem","table:State/index/*","{}"],
  ["role:BrokerServiceRole","Allow","dynamodb:UpdateItem","table:TurnRecords","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"CHANGE#*\"]}}"],
  ["role:BrokerServiceRole","Allow","kms:Decrypt","key:ChatGptConnectionKey","{}"],
  ["role:BrokerServiceRole","Allow","kms:Encrypt","key:ChatGptConnectionKey","{}"],
  ["role:BrokerServiceRole","Allow","kms:GetPublicKey","key:DeveloperSignInTaskTokenKey","{}"],
  ["role:BrokerServiceRole","Allow","kms:Sign","key:DeveloperSignInTaskTokenKey","{}"],
  ["role:BrokerServiceRole","Allow","lambda:InvokeFunction","function:DeveloperSignInFunction:*","{}"],
  ["role:BrokerServiceRole","Allow","lambda:InvokeFunction","function:DeveloperSignInFunction","{}"],
  ["role:BrokerServiceRole","Allow","lambda:InvokeFunction","function:PlanEvidence:*","{}"],
  ["role:BrokerServiceRole","Allow","lambda:InvokeFunction","function:PlanEvidence","{}"],
  ["role:BrokerServiceRole","Allow","s3:Abort*","bucket:Artifacts","{}"],
  ["role:BrokerServiceRole","Allow","s3:Abort*","bucket:Artifacts/*","{}"],
  ["role:BrokerServiceRole","Allow","s3:DeleteObject*","bucket:Artifacts","{}"],
  ["role:BrokerServiceRole","Allow","s3:DeleteObject*","bucket:Artifacts/*","{}"],
  ["role:BrokerServiceRole","Allow","s3:GetBucket*","bucket:Artifacts","{}"],
  ["role:BrokerServiceRole","Allow","s3:GetBucket*","bucket:Artifacts/*","{}"],
  ["role:BrokerServiceRole","Allow","s3:GetObject*","bucket:Artifacts","{}"],
  ["role:BrokerServiceRole","Allow","s3:GetObject*","bucket:Artifacts/*","{}"],
  ["role:BrokerServiceRole","Allow","s3:List*","bucket:Artifacts","{}"],
  ["role:BrokerServiceRole","Allow","s3:List*","bucket:Artifacts/*","{}"],
  ["role:BrokerServiceRole","Allow","s3:PutObject","bucket:Artifacts","{}"],
  ["role:BrokerServiceRole","Allow","s3:PutObject","bucket:Artifacts/*","{}"],
  ["role:BrokerServiceRole","Allow","s3:PutObjectLegalHold","bucket:Artifacts","{}"],
  ["role:BrokerServiceRole","Allow","s3:PutObjectLegalHold","bucket:Artifacts/*","{}"],
  ["role:BrokerServiceRole","Allow","s3:PutObjectRetention","bucket:Artifacts","{}"],
  ["role:BrokerServiceRole","Allow","s3:PutObjectRetention","bucket:Artifacts/*","{}"],
  ["role:BrokerServiceRole","Allow","s3:PutObjectTagging","bucket:Artifacts","{}"],
  ["role:BrokerServiceRole","Allow","s3:PutObjectTagging","bucket:Artifacts/*","{}"],
  ["role:BrokerServiceRole","Allow","s3:PutObjectVersionTagging","bucket:Artifacts","{}"],
  ["role:BrokerServiceRole","Allow","s3:PutObjectVersionTagging","bucket:Artifacts/*","{}"],
  ["role:BrokerServiceRole","Allow","secretsmanager:CreateSecret","arn:parameter:AWS::Partition:secretsmanager:parameter:AWS::Region:parameter:AWS::AccountId:secret:agentx/staging/channel-adapter/*","{}"],
  ["role:BrokerServiceRole","Allow","secretsmanager:GetSecretValue","arn:parameter:AWS::Partition:secretsmanager:parameter:AWS::Region:parameter:AWS::AccountId:secret:agentx/staging/connectors/*","{}"],
  ["role:BrokerServiceRole","Allow","secretsmanager:GetSecretValue","parameter:GitHubAppPrivateKeySecretArn","{}"],
  ["role:BrokerServiceRole","Allow","secretsmanager:PutSecretValue","arn:parameter:AWS::Partition:secretsmanager:parameter:AWS::Region:parameter:AWS::AccountId:secret:agentx/staging/channel-adapter/*","{}"],
  ["role:BrokerServiceRole","Allow","secretsmanager:PutSecretValue","arn:parameter:AWS::Partition:secretsmanager:parameter:AWS::Region:parameter:AWS::AccountId:secret:agentx/staging/connectors/*","{\"StringEquals\":{\"secretsmanager:ResourceTag/agentx-writable\":[\"refresh-token\"]}}"],
  ["role:BrokerServiceRole","Allow","sqs:ChangeMessageVisibility","queue:CoreEngineJobsDeadLetterQueue","{}"],
  ["role:BrokerServiceRole","Allow","sqs:ChangeMessageVisibility","queue:CoreEngineJobsQueue","{}"],
  ["role:BrokerServiceRole","Allow","sqs:DeleteMessage","queue:CoreEngineJobsDeadLetterQueue","{}"],
  ["role:BrokerServiceRole","Allow","sqs:DeleteMessage","queue:CoreEngineJobsQueue","{}"],
  ["role:BrokerServiceRole","Allow","sqs:GetQueueAttributes","queue:ChannelApiEventDeadLetters","{}"],
  ["role:BrokerServiceRole","Allow","sqs:GetQueueAttributes","queue:CoreEngineJobsDeadLetterQueue","{}"],
  ["role:BrokerServiceRole","Allow","sqs:GetQueueAttributes","queue:CoreEngineJobsQueue","{}"],
  ["role:BrokerServiceRole","Allow","sqs:GetQueueAttributes","queue:DeveloperTaskNotifierNoticeDeadLetterQueue","{}"],
  ["role:BrokerServiceRole","Allow","sqs:GetQueueAttributes","queue:DeveloperTaskNotifierStreamFailureQueue","{}"],
  ["role:BrokerServiceRole","Allow","sqs:GetQueueAttributes","queue:DispatchDeadLetterQueue","{}"],
  ["role:BrokerServiceRole","Allow","sqs:GetQueueAttributes","queue:SlackHandOffFailureQueue","{}"],
  ["role:BrokerServiceRole","Allow","sqs:GetQueueAttributes","queue:SlackRequestDeadLetterQueue","{}"],
  ["role:BrokerServiceRole","Allow","sqs:GetQueueAttributes","queue:SlackRequestQueue","{}"],
  ["role:BrokerServiceRole","Allow","sqs:GetQueueUrl","queue:SlackHandOffFailureQueue","{}"],
  ["role:BrokerServiceRole","Allow","sqs:GetQueueUrl","queue:SlackRequestQueue","{}"],
  ["role:BrokerServiceRole","Allow","sqs:ReceiveMessage","queue:CoreEngineJobsDeadLetterQueue","{}"],
  ["role:BrokerServiceRole","Allow","sqs:ReceiveMessage","queue:CoreEngineJobsQueue","{}"],
  ["role:BrokerServiceRole","Allow","sqs:SendMessage","queue:CoreEngineJobsDeadLetterQueue","{}"],
  ["role:BrokerServiceRole","Allow","sqs:SendMessage","queue:CoreEngineJobsQueue","{}"],
  ["role:BrokerServiceRole","Allow","sqs:SendMessage","queue:SlackHandOffFailureQueue","{}"],
  ["role:BrokerServiceRole","Allow","sqs:SendMessage","queue:SlackRequestQueue","{}"],
  ["role:BrokerServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/eval/runner-features","{}"],
  ["role:BrokerServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/eval/runner-image","{}"],
  ["role:BrokerServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/eval/settings","{}"],
  ["role:BrokerServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-anthropic-secret-arn","{}"],
  ["role:BrokerServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-e2e-agent-model","{}"],
  ["role:BrokerServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-executor-image","{}"],
  ["role:BrokerServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-image","{}"],
  ["role:BrokerServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-model-fallback","{}"],
  ["role:BrokerServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-model-id","{}"],
  ["role:BrokerServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-model-provider","{}"],
  ["role:BrokerServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-openai-secret-arn","{}"],
  ["role:BrokerServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-openrouter-providers","{}"],
  ["role:BrokerServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-openrouter-secret-arn","{}"],
  ["role:BrokerServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-prompt-cache-retention","{}"],
  ["role:BrokerServiceRole","Allow","states:StartExecution","arn:parameter:AWS::Partition:states:parameter:AWS::Region:parameter:AWS::AccountId:stateMachine:agentx-staging-swebench-eval","{}"],
  ["role:BrokerServiceRole","Allow","states:StartExecution","machine:SessionsDeleter","{}"],
  ["role:BrokerServiceRole","Allow","xray:PutTelemetryRecords","*","{}"],
  ["role:BrokerServiceRole","Allow","xray:PutTraceSegments","*","{}"],
  ["role:ChannelApiEventSenderServiceRole","Allow","dynamodb:GetItem","table:State","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"CHANNEL_ADAPTERS\"]}}"],
  ["role:ChannelApiEventSenderServiceRole","Allow","dynamodb:PutItem","table:ChannelApiState","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"LAST_EVENT#*\"]}}"],
  ["role:ChannelApiEventSenderServiceRole","Allow","secretsmanager:GetSecretValue","arn:parameter:AWS::Partition:secretsmanager:parameter:AWS::Region:parameter:AWS::AccountId:secret:agentx/staging/channel-adapter/*","{}"],
  ["role:ChannelApiEventSenderServiceRole","Allow","sqs:ChangeMessageVisibility","queue:ChannelApiEvents","{}"],
  ["role:ChannelApiEventSenderServiceRole","Allow","sqs:DeleteMessage","queue:ChannelApiEvents","{}"],
  ["role:ChannelApiEventSenderServiceRole","Allow","sqs:GetQueueAttributes","queue:ChannelApiEvents","{}"],
  ["role:ChannelApiEventSenderServiceRole","Allow","sqs:GetQueueUrl","queue:ChannelApiEvents","{}"],
  ["role:ChannelApiEventSenderServiceRole","Allow","sqs:ReceiveMessage","queue:ChannelApiEvents","{}"],
  ["role:ChannelApiEventSenderServiceRole","Allow","xray:PutTelemetryRecords","*","{}"],
  ["role:ChannelApiEventSenderServiceRole","Allow","xray:PutTraceSegments","*","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","dynamodb:BatchGetItem","table:SlackThreads","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","dynamodb:BatchWriteItem","table:SlackThreads","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","dynamodb:ConditionCheckItem","table:SlackThreads","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","dynamodb:DeleteItem","table:ChannelApiState","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","dynamodb:DeleteItem","table:SlackThreads","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","dynamodb:DescribeTable","table:SlackThreads","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","dynamodb:GetItem","table:ChannelApiState","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","dynamodb:GetItem","table:SlackThreads","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","dynamodb:GetItem","table:State","{\"ForAllValues:StringEquals\":{\"dynamodb:Attributes\":[\"baseBranch\",\"createdAt\",\"createdByOperationId\",\"entityType\",\"expectedHeadCommit\",\"id\",\"kind\",\"number\",\"pk\",\"result\",\"sk\",\"state\",\"status\",\"updatedAt\",\"url\"]},\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"WORKSPACE#*\"]},\"Null\":{\"dynamodb:Attributes\":[\"false\"]},\"StringEqualsIfExists\":{\"dynamodb:Select\":[\"SPECIFIC_ATTRIBUTES\"]}}"],
  ["role:ChannelApiIngressServiceRole","Allow","dynamodb:GetItem","table:State","{\"ForAllValues:StringEquals\":{\"dynamodb:Attributes\":[\"closedAt\",\"pk\",\"sk\",\"workspaceId\"]},\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"SLACK_THREAD#*\"]},\"Null\":{\"dynamodb:Attributes\":[\"false\"]},\"StringEqualsIfExists\":{\"dynamodb:Select\":[\"SPECIFIC_ATTRIBUTES\"]}}"],
  ["role:ChannelApiIngressServiceRole","Allow","dynamodb:GetItem","table:State","{\"ForAllValues:StringEquals\":{\"dynamodb:Attributes\":[\"pk\",\"share\",\"sk\",\"slackUserId\",\"workflow\"]},\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"DEVTASK#*\"]},\"Null\":{\"dynamodb:Attributes\":[\"false\"]},\"StringEqualsIfExists\":{\"dynamodb:Select\":[\"SPECIFIC_ATTRIBUTES\"]}}"],
  ["role:ChannelApiIngressServiceRole","Allow","dynamodb:GetItem","table:State","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"BINDING#*\",\"CHANNEL_ADAPTERS\",\"CHANNEL_LINK#*\",\"SHARED_TASK#*\",\"SLACK_BINDING#*\"]}}"],
  ["role:ChannelApiIngressServiceRole","Allow","dynamodb:GetItem","table:TurnRecords","{\"ForAllValues:StringEquals\":{\"dynamodb:Attributes\":[\"argumentsOmitted\",\"calls\",\"callsTruncated\",\"disposition\",\"durationMs\",\"emptyResponse\",\"error\",\"eventId\",\"expiresAt\",\"exportPk\",\"exportSk\",\"model\",\"offeredTools\",\"pk\",\"receivedAt\",\"recordingErrors\",\"requestedBy\",\"sk\",\"subject\",\"usage\",\"usageError\"]},\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"THREAD#*\"]},\"Null\":{\"dynamodb:Attributes\":[\"false\"]},\"StringEqualsIfExists\":{\"dynamodb:Select\":[\"SPECIFIC_ATTRIBUTES\"]}}"],
  ["role:ChannelApiIngressServiceRole","Allow","dynamodb:GetRecords","table:SlackThreads","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","dynamodb:GetShardIterator","table:SlackThreads","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","dynamodb:PutItem","table:ChannelApiState","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","dynamodb:PutItem","table:SlackThreads","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","dynamodb:PutItem","table:State","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"CHANNEL_LINK_CODE#*\"]}}"],
  ["role:ChannelApiIngressServiceRole","Allow","dynamodb:Query","table:SlackThreads","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","dynamodb:Query","table:State","{\"ForAllValues:StringEquals\":{\"dynamodb:Attributes\":[\"baseBranch\",\"createdAt\",\"createdByOperationId\",\"entityType\",\"expectedHeadCommit\",\"id\",\"kind\",\"number\",\"pk\",\"result\",\"sk\",\"state\",\"status\",\"updatedAt\",\"url\"]},\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"WORKSPACE#*\"]},\"Null\":{\"dynamodb:Attributes\":[\"false\"]},\"StringEqualsIfExists\":{\"dynamodb:Select\":[\"SPECIFIC_ATTRIBUTES\"]}}"],
  ["role:ChannelApiIngressServiceRole","Allow","dynamodb:Scan","table:SlackThreads","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","dynamodb:UpdateItem","table:SlackThreads","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","lambda:InvokeFunction","function:Broker:*","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","lambda:InvokeFunction","function:Broker","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","lambda:InvokeFunction","function:ChannelApiIngress","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","secretsmanager:GetSecretValue","arn:parameter:AWS::Partition:secretsmanager:parameter:AWS::Region:parameter:AWS::AccountId:secret:agentx/staging/channel-adapter/*","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","sqs:GetQueueAttributes","queue:ChannelApiEvents","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","sqs:GetQueueAttributes","queue:ChannelApiRequests","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","sqs:GetQueueUrl","queue:ChannelApiEvents","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","sqs:GetQueueUrl","queue:ChannelApiRequests","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","sqs:SendMessage","queue:ChannelApiEvents","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","sqs:SendMessage","queue:ChannelApiRequests","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","xray:PutTelemetryRecords","*","{}"],
  ["role:ChannelApiIngressServiceRole","Allow","xray:PutTraceSegments","*","{}"],
  ["role:CoreEngineJobsInvokeRole","Allow","lambda:InvokeFunction","function:Broker","{}"],
  ["role:DeveloperSignInFunctionServiceRole","Allow","dynamodb:DeleteItem","table:DeveloperSignInTable","{\"ForAllValues:StringEquals\":{\"dynamodb:LeadingKeys\":[\"SIGNIN_CLIENTS\"]},\"Null\":{\"dynamodb:LeadingKeys\":[\"false\"]}}"],
  ["role:DeveloperSignInFunctionServiceRole","Allow","dynamodb:GetItem","table:DeveloperSignInTable","{}"],
  ["role:DeveloperSignInFunctionServiceRole","Allow","dynamodb:PutItem","table:DeveloperSignInTable","{}"],
  ["role:DeveloperSignInFunctionServiceRole","Allow","dynamodb:Query","table:DeveloperSignInTable","{\"ForAllValues:StringEquals\":{\"dynamodb:LeadingKeys\":[\"SIGNIN_CLIENTS\"]},\"Null\":{\"dynamodb:LeadingKeys\":[\"false\"]}}"],
  ["role:DeveloperSignInFunctionServiceRole","Allow","dynamodb:UpdateItem","table:DeveloperSignInTable","{}"],
  ["role:DeveloperSignInFunctionServiceRole","Allow","kms:GetPublicKey","key:DeveloperSignInTaskTokenKey","{}"],
  ["role:DeveloperSignInFunctionServiceRole","Allow","kms:GetPublicKey","key:DeveloperSignInTokenKey","{}"],
  ["role:DeveloperSignInFunctionServiceRole","Allow","kms:Sign","key:DeveloperSignInTokenKey","{}"],
  ["role:DeveloperSignInFunctionServiceRole","Allow","secretsmanager:DescribeSecret","secret:ChannelApiSlackAdapterSecret","{}"],
  ["role:DeveloperSignInFunctionServiceRole","Allow","secretsmanager:DescribeSecret","secret:SlackSecret","{}"],
  ["role:DeveloperSignInFunctionServiceRole","Allow","secretsmanager:GetSecretValue","arn:parameter:AWS::Partition:secretsmanager:parameter:AWS::Region:parameter:AWS::AccountId:secret:agentx/staging/developer-oidc-??????","{}"],
  ["role:DeveloperSignInFunctionServiceRole","Allow","secretsmanager:GetSecretValue","secret:ChannelApiSlackAdapterSecret","{}"],
  ["role:DeveloperSignInFunctionServiceRole","Allow","secretsmanager:GetSecretValue","secret:SlackSecret","{}"],
  ["role:DeveloperSignInFunctionServiceRole","Allow","xray:PutTelemetryRecords","*","{}"],
  ["role:DeveloperSignInFunctionServiceRole","Allow","xray:PutTraceSegments","*","{}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","dynamodb:DescribeStream","table:State/StreamArn","{}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","dynamodb:GetItem","table:State","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"ADMIN_CHANGE#*\"]}}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","dynamodb:GetItem","table:State","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"CHATGPT_NOTICE#*\",\"DEVTASK#*\",\"OPERATION#*\",\"WORKSPACE#*\"]}}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","dynamodb:GetItem","table:State","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"WORKFLOW_DISPATCH\"]}}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","dynamodb:GetRecords","table:State/StreamArn","{}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","dynamodb:GetShardIterator","table:State/StreamArn","{}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","dynamodb:ListStreams","*","{}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","dynamodb:PutItem","table:State","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"CHATGPT_NOTICE#*\"]}}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","dynamodb:PutItem","table:State","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"DEVTASK#*\"]}}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","dynamodb:PutItem","table:State","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"SHARED_TASK#*\"]}}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","dynamodb:Query","table:State","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"CHATGPT_NOTICE#*\",\"DEVTASK#*\",\"OPERATION#*\",\"WORKSPACE#*\"]}}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","dynamodb:UpdateItem","table:State","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"ADMIN_CHANGE#*\"]}}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","dynamodb:UpdateItem","table:State","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"DEVTASK#*\"]}}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","s3:GetObject","bucket:Artifacts/private/*/*/*/*","{}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","s3:GetObject","bucket:Artifacts/private/task-closeouts/*/*","{}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","s3:PutObject","bucket:Artifacts/private/task-closeouts/*/*","{}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","secretsmanager:DescribeSecret","secret:ChannelApiSlackAdapterSecret","{}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","secretsmanager:DescribeSecret","secret:SlackSecret","{}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","secretsmanager:GetSecretValue","secret:ChannelApiSlackAdapterSecret","{}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","secretsmanager:GetSecretValue","secret:SlackSecret","{}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","sqs:ChangeMessageVisibility","queue:DeveloperTaskNotifierNoticeQueue","{}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","sqs:DeleteMessage","queue:DeveloperTaskNotifierNoticeQueue","{}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","sqs:GetQueueAttributes","queue:DeveloperTaskNotifierNoticeQueue","{}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","sqs:GetQueueAttributes","queue:DeveloperTaskNotifierStreamFailureQueue","{}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","sqs:GetQueueUrl","queue:DeveloperTaskNotifierNoticeQueue","{}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","sqs:GetQueueUrl","queue:DeveloperTaskNotifierStreamFailureQueue","{}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","sqs:ReceiveMessage","queue:DeveloperTaskNotifierNoticeQueue","{}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","sqs:SendMessage","queue:DeveloperTaskNotifierNoticeQueue","{}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","sqs:SendMessage","queue:DeveloperTaskNotifierStreamFailureQueue","{}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","xray:PutTelemetryRecords","*","{}"],
  ["role:DeveloperTaskNotifierFunctionServiceRole","Allow","xray:PutTraceSegments","*","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:BatchGetItem","table:State","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:BatchGetItem","table:State/index/*","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:BatchWriteItem","table:State","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:BatchWriteItem","table:State/index/*","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:ConditionCheckItem","table:State","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:ConditionCheckItem","table:State/index/*","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:DeleteItem","table:State","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:DeleteItem","table:State/index/*","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:DescribeTable","table:State","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:DescribeTable","table:State/index/*","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:GetItem","table:State","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:GetItem","table:State/index/*","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:GetRecords","table:State","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:GetRecords","table:State/index/*","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:GetShardIterator","table:State","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:GetShardIterator","table:State/index/*","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:PutItem","table:State","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:PutItem","table:State/index/*","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:Query","table:State","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:Query","table:State/index/*","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:Scan","table:State","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:Scan","table:State/index/*","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:UpdateItem","table:State","{}"],
  ["role:DispatcherServiceRole","Allow","dynamodb:UpdateItem","table:State/index/*","{}"],
  ["role:DispatcherServiceRole","Allow","kms:Sign","key:InvokeSigningKey","{}"],
  ["role:DispatcherServiceRole","Allow","s3:GetObject","bucket:Artifacts/workflow-e2e-admissions/*","{}"],
  ["role:DispatcherServiceRole","Allow","sqs:ChangeMessageVisibility","queue:DispatchQueue","{}"],
  ["role:DispatcherServiceRole","Allow","sqs:DeleteMessage","queue:DispatchQueue","{}"],
  ["role:DispatcherServiceRole","Allow","sqs:GetQueueAttributes","queue:DispatchQueue","{}"],
  ["role:DispatcherServiceRole","Allow","sqs:GetQueueUrl","queue:DispatchQueue","{}"],
  ["role:DispatcherServiceRole","Allow","sqs:ReceiveMessage","queue:DispatchQueue","{}"],
  ["role:DispatcherServiceRole","Allow","states:StartExecution","machine:SessionsProvisioner","{}"],
  ["role:DispatcherServiceRole","Allow","xray:PutTelemetryRecords","*","{}"],
  ["role:DispatcherServiceRole","Allow","xray:PutTraceSegments","*","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:BatchGetItem","table:State","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:BatchGetItem","table:State/index/*","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:BatchWriteItem","table:State","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:BatchWriteItem","table:State/index/*","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:ConditionCheckItem","table:State","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:ConditionCheckItem","table:State/index/*","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:DeleteItem","table:State","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:DeleteItem","table:State/index/*","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:DescribeTable","table:State","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:DescribeTable","table:State/index/*","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:GetItem","table:State","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:GetItem","table:State/index/*","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:GetRecords","table:State","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:GetRecords","table:State/index/*","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:GetShardIterator","table:State","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:GetShardIterator","table:State/index/*","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:PutItem","table:State","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:PutItem","table:State/index/*","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:Query","table:State","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:Query","table:State/index/*","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:Scan","table:State","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:Scan","table:State/index/*","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:UpdateItem","table:State","{}"],
  ["role:EvalBatchTickServiceRole","Allow","dynamodb:UpdateItem","table:State/index/*","{}"],
  ["role:EvalBatchTickServiceRole","Allow","ec2:TerminateInstances","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:instance/*","{\"StringEquals\":{\"aws:ResourceTag/DeploymentMode\":[\"swebench-eval\"],\"aws:ResourceTag/Environment\":[\"staging\"]}}"],
  ["role:EvalBatchTickServiceRole","Allow","s3:PutObject","bucket:Artifacts/evals/*","{}"],
  ["role:EvalBatchTickServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/eval/runner-features","{}"],
  ["role:EvalBatchTickServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/eval/runner-image","{}"],
  ["role:EvalBatchTickServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/eval/settings","{}"],
  ["role:EvalBatchTickServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-anthropic-secret-arn","{}"],
  ["role:EvalBatchTickServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-executor-image","{}"],
  ["role:EvalBatchTickServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-image","{}"],
  ["role:EvalBatchTickServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-model-id","{}"],
  ["role:EvalBatchTickServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-model-provider","{}"],
  ["role:EvalBatchTickServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-openai-secret-arn","{}"],
  ["role:EvalBatchTickServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-openrouter-providers","{}"],
  ["role:EvalBatchTickServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-openrouter-secret-arn","{}"],
  ["role:EvalBatchTickServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-prompt-cache-retention","{}"],
  ["role:EvalBatchTickServiceRole","Allow","states:DescribeExecution","arn:parameter:AWS::Partition:states:parameter:AWS::Region:parameter:AWS::AccountId:execution:agentx-staging-swebench-eval:*","{}"],
  ["role:EvalBatchTickServiceRole","Allow","states:StartExecution","arn:parameter:AWS::Partition:states:parameter:AWS::Region:parameter:AWS::AccountId:stateMachine:agentx-staging-swebench-eval","{}"],
  ["role:EvalBatchTickServiceRole","Allow","xray:PutTelemetryRecords","*","{}"],
  ["role:EvalBatchTickServiceRole","Allow","xray:PutTraceSegments","*","{}"],
  ["role:external:{\"Fn::Select\":[3,{\"Fn::Split\":[\"/\",{\"Ref\":\"Ec2WorkerInstanceRoleArn\"}]}]}","Allow","secretsmanager:GetSecretValue","parameter:AnthropicSecretArn","{}"],
  ["role:external:{\"Fn::Select\":[3,{\"Fn::Split\":[\"/\",{\"Ref\":\"Ec2WorkerInstanceRoleArn\"}]}]}","Allow","secretsmanager:GetSecretValue","parameter:OpenAISecretArn","{}"],
  ["role:external:{\"Fn::Select\":[3,{\"Fn::Split\":[\"/\",{\"Ref\":\"Ec2WorkerInstanceRoleArn\"}]}]}","Allow","secretsmanager:GetSecretValue","parameter:OpenRouterSecretArn","{}"],
  ["role:GithubWebhookRecoveryRole","Allow","lambda:InvokeFunction","function:Broker:*","{}"],
  ["role:GithubWebhookRecoveryRole","Allow","lambda:InvokeFunction","function:Broker","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:BatchGetItem","table:State","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:BatchGetItem","table:State/index/*","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:BatchWriteItem","table:State","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:BatchWriteItem","table:State/index/*","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:ConditionCheckItem","table:State","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:ConditionCheckItem","table:State/index/*","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:DeleteItem","table:State","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:DeleteItem","table:State/index/*","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:DescribeStream","table:State/StreamArn","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:DescribeTable","table:State","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:DescribeTable","table:State/index/*","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:GetItem","table:State","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:GetItem","table:State/index/*","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:GetRecords","table:State","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:GetRecords","table:State/index/*","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:GetRecords","table:State/StreamArn","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:GetShardIterator","table:State","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:GetShardIterator","table:State/index/*","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:GetShardIterator","table:State/StreamArn","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:ListStreams","*","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:PutItem","table:State","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:PutItem","table:State/index/*","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:Query","table:State","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:Query","table:State/index/*","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:Scan","table:State","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:Scan","table:State/index/*","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:UpdateItem","table:State","{}"],
  ["role:OutboxPublisherServiceRole","Allow","dynamodb:UpdateItem","table:State/index/*","{}"],
  ["role:OutboxPublisherServiceRole","Allow","sqs:GetQueueAttributes","queue:DispatchQueue","{}"],
  ["role:OutboxPublisherServiceRole","Allow","sqs:GetQueueUrl","queue:DispatchQueue","{}"],
  ["role:OutboxPublisherServiceRole","Allow","sqs:SendMessage","queue:DispatchQueue","{}"],
  ["role:OutboxPublisherServiceRole","Allow","xray:PutTelemetryRecords","*","{}"],
  ["role:OutboxPublisherServiceRole","Allow","xray:PutTraceSegments","*","{}"],
  ["role:PlanEvidenceServiceRole","Allow","dynamodb:DeleteItem","table:State","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"PLAN_EVIDENCE\"]}}"],
  ["role:PlanEvidenceServiceRole","Allow","dynamodb:GetItem","table:State","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"DEVTASK#*\",\"PLAN_EVIDENCE\",\"PROJECT#*\"]}}"],
  ["role:PlanEvidenceServiceRole","Allow","dynamodb:PutItem","table:State","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"DEVTASK#*\"]}}"],
  ["role:PlanEvidenceServiceRole","Allow","dynamodb:UpdateItem","table:State","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"PLAN_EVIDENCE\"]}}"],
  ["role:PlanEvidenceServiceRole","Allow","s3:GetObject","bucket:Artifacts/private/*","{}"],
  ["role:PlanEvidenceServiceRole","Allow","s3:PutObject","bucket:Artifacts/private/*/plan-documents/*.evidence.*.json","{}"],
  ["role:PlanEvidenceServiceRole","Allow","secretsmanager:GetSecretValue","parameter:GitHubAppPrivateKeySecretArn","{}"],
  ["role:PlanEvidenceServiceRole","Allow","xray:PutTelemetryRecords","*","{}"],
  ["role:PlanEvidenceServiceRole","Allow","xray:PutTraceSegments","*","{}"],
  ["role:SchedulerRoleForTarget490aa1","Allow","lambda:InvokeFunction","function:EvalBatchTick:*","{}"],
  ["role:SchedulerRoleForTarget490aa1","Allow","lambda:InvokeFunction","function:EvalBatchTick","{}"],
  ["role:SchedulerRoleForTarget9cef70","Allow","lambda:InvokeFunction","function:SessionsReaper:*","{}"],
  ["role:SchedulerRoleForTarget9cef70","Allow","lambda:InvokeFunction","function:SessionsReaper","{}"],
  ["role:SchedulerRoleForTargetd4b209","Allow","lambda:InvokeFunction","function:SessionsReconciler:*","{}"],
  ["role:SchedulerRoleForTargetd4b209","Allow","lambda:InvokeFunction","function:SessionsReconciler","{}"],
  ["role:SessionsDeleterRole","Allow","ec2:DeleteVolume","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:instance/*","{\"StringEquals\":{\"aws:ResourceTag/DeploymentMode\":[\"ec2-ebs\"],\"aws:ResourceTag/Environment\":[\"staging\"]}}"],
  ["role:SessionsDeleterRole","Allow","ec2:DeleteVolume","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:volume/*","{\"StringEquals\":{\"aws:ResourceTag/DeploymentMode\":[\"ec2-ebs\"],\"aws:ResourceTag/Environment\":[\"staging\"]}}"],
  ["role:SessionsDeleterRole","Allow","ec2:DescribeInstances","*","{}"],
  ["role:SessionsDeleterRole","Allow","ec2:DescribeVolumes","*","{}"],
  ["role:SessionsDeleterRole","Allow","ec2:TerminateInstances","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:instance/*","{\"StringEquals\":{\"aws:ResourceTag/DeploymentMode\":[\"ec2-ebs\"],\"aws:ResourceTag/Environment\":[\"staging\"]}}"],
  ["role:SessionsDeleterRole","Allow","ec2:TerminateInstances","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:volume/*","{\"StringEquals\":{\"aws:ResourceTag/DeploymentMode\":[\"ec2-ebs\"],\"aws:ResourceTag/Environment\":[\"staging\"]}}"],
  ["role:SessionsDeleterRole","Allow","lambda:InvokeFunction","function:SessionsSteps:*","{}"],
  ["role:SessionsDeleterRole","Allow","lambda:InvokeFunction","function:SessionsSteps","{}"],
  ["role:SessionsDeleterRole","Allow","logs:CreateLogDelivery","*","{}"],
  ["role:SessionsDeleterRole","Allow","logs:DeleteLogDelivery","*","{}"],
  ["role:SessionsDeleterRole","Allow","logs:DescribeLogGroups","*","{}"],
  ["role:SessionsDeleterRole","Allow","logs:DescribeResourcePolicies","*","{}"],
  ["role:SessionsDeleterRole","Allow","logs:GetLogDelivery","*","{}"],
  ["role:SessionsDeleterRole","Allow","logs:ListLogDeliveries","*","{}"],
  ["role:SessionsDeleterRole","Allow","logs:PutResourcePolicy","*","{}"],
  ["role:SessionsDeleterRole","Allow","logs:UpdateLogDelivery","*","{}"],
  ["role:SessionsProvisionerRole","Allow","ec2:AttachVolume","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:instance/*","{\"StringEquals\":{\"aws:ResourceTag/DeploymentMode\":[\"ec2-ebs\"],\"aws:ResourceTag/Environment\":[\"staging\"]}}"],
  ["role:SessionsProvisionerRole","Allow","ec2:AttachVolume","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:volume/*","{\"StringEquals\":{\"aws:ResourceTag/DeploymentMode\":[\"ec2-ebs\"],\"aws:ResourceTag/Environment\":[\"staging\"]}}"],
  ["role:SessionsProvisionerRole","Allow","ec2:CreateTags","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:instance/*","{\"StringEquals\":{\"ec2:CreateAction\":[\"CreateVolume\",\"RunInstances\"]}}"],
  ["role:SessionsProvisionerRole","Allow","ec2:CreateTags","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:volume/*","{\"StringEquals\":{\"ec2:CreateAction\":[\"CreateVolume\",\"RunInstances\"]}}"],
  ["role:SessionsProvisionerRole","Allow","ec2:CreateVolume","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:volume/*","{\"StringEquals\":{\"aws:RequestTag/DeploymentMode\":[\"ec2-ebs\"],\"aws:RequestTag/Environment\":[\"staging\"]}}"],
  ["role:SessionsProvisionerRole","Allow","ec2:DescribeInstances","*","{}"],
  ["role:SessionsProvisionerRole","Allow","ec2:DescribeVolumes","*","{}"],
  ["role:SessionsProvisionerRole","Allow","ec2:RunInstances","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region::image/*","{}"],
  ["role:SessionsProvisionerRole","Allow","ec2:RunInstances","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:instance/*","{\"ArnEquals\":{\"ec2:LaunchTemplate\":[\"arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:launch-template/parameter:Ec2WorkerLaunchTemplateId\"]}}"],
  ["role:SessionsProvisionerRole","Allow","ec2:RunInstances","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:launch-template/parameter:Ec2WorkerLaunchTemplateId","{}"],
  ["role:SessionsProvisionerRole","Allow","ec2:RunInstances","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:network-interface/*","{}"],
  ["role:SessionsProvisionerRole","Allow","ec2:RunInstances","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:security-group/*","{}"],
  ["role:SessionsProvisionerRole","Allow","ec2:RunInstances","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:subnet/*","{}"],
  ["role:SessionsProvisionerRole","Allow","ec2:RunInstances","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:volume/*","{}"],
  ["role:SessionsProvisionerRole","Allow","ec2:TerminateInstances","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:instance/*","{\"StringEquals\":{\"aws:ResourceTag/DeploymentMode\":[\"ec2-ebs\"],\"aws:ResourceTag/Environment\":[\"staging\"]}}"],
  ["role:SessionsProvisionerRole","Allow","ec2:TerminateInstances","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:volume/*","{\"StringEquals\":{\"aws:ResourceTag/DeploymentMode\":[\"ec2-ebs\"],\"aws:ResourceTag/Environment\":[\"staging\"]}}"],
  ["role:SessionsProvisionerRole","Allow","iam:PassRole","parameter:Ec2WorkerInstanceRoleArn","{\"StringEquals\":{\"iam:PassedToService\":[\"ec2.amazonaws.com\"]}}"],
  ["role:SessionsProvisionerRole","Allow","kms:CreateGrant","parameter:WorkspaceKmsKeyArn","{}"],
  ["role:SessionsProvisionerRole","Allow","kms:Decrypt","parameter:WorkspaceKmsKeyArn","{}"],
  ["role:SessionsProvisionerRole","Allow","kms:DescribeKey","parameter:WorkspaceKmsKeyArn","{}"],
  ["role:SessionsProvisionerRole","Allow","kms:GenerateDataKeyWithoutPlaintext","parameter:WorkspaceKmsKeyArn","{}"],
  ["role:SessionsProvisionerRole","Allow","kms:ReEncrypt*","parameter:WorkspaceKmsKeyArn","{}"],
  ["role:SessionsProvisionerRole","Allow","lambda:InvokeFunction","function:SessionsSteps:*","{}"],
  ["role:SessionsProvisionerRole","Allow","lambda:InvokeFunction","function:SessionsSteps","{}"],
  ["role:SessionsProvisionerRole","Allow","logs:CreateLogDelivery","*","{}"],
  ["role:SessionsProvisionerRole","Allow","logs:DeleteLogDelivery","*","{}"],
  ["role:SessionsProvisionerRole","Allow","logs:DescribeLogGroups","*","{}"],
  ["role:SessionsProvisionerRole","Allow","logs:DescribeResourcePolicies","*","{}"],
  ["role:SessionsProvisionerRole","Allow","logs:GetLogDelivery","*","{}"],
  ["role:SessionsProvisionerRole","Allow","logs:ListLogDeliveries","*","{}"],
  ["role:SessionsProvisionerRole","Allow","logs:PutResourcePolicy","*","{}"],
  ["role:SessionsProvisionerRole","Allow","logs:UpdateLogDelivery","*","{}"],
  ["role:SessionsProvisionerRole","Allow","ssm:GetParameter","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region::parameter/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64","{}"],
  ["role:SessionsProvisionerRole","Allow","ssm:GetParameter","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-qualified-ami","{}"],
  ["role:SessionsProvisionerRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region::parameter/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:BatchGetItem","table:State","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:BatchGetItem","table:State/index/*","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:BatchWriteItem","table:State","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:BatchWriteItem","table:State/index/*","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:ConditionCheckItem","table:State","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:ConditionCheckItem","table:State/index/*","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:DeleteItem","table:State","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:DeleteItem","table:State/index/*","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:DescribeTable","table:State","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:DescribeTable","table:State/index/*","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:GetItem","table:State","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:GetItem","table:State/index/*","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:GetRecords","table:State","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:GetRecords","table:State/index/*","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:GetShardIterator","table:State","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:GetShardIterator","table:State/index/*","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:PutItem","table:State","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:PutItem","table:State/index/*","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:Query","table:State","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:Query","table:State/index/*","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:Scan","table:State","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:Scan","table:State/index/*","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:UpdateItem","table:State","{}"],
  ["role:SessionsReaperServiceRole","Allow","dynamodb:UpdateItem","table:State/index/*","{}"],
  ["role:SessionsReaperServiceRole","Allow","ec2:DescribeInstances","*","{}"],
  ["role:SessionsReaperServiceRole","Allow","ec2:DescribeVolumes","*","{}"],
  ["role:SessionsReaperServiceRole","Allow","ec2:TerminateInstances","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:instance/*","{\"StringEquals\":{\"aws:ResourceTag/DeploymentMode\":[\"ec2-ebs\"],\"aws:ResourceTag/Environment\":[\"staging\"]}}"],
  ["role:SessionsReaperServiceRole","Allow","states:StartExecution","machine:SessionsProvisioner","{}"],
  ["role:SessionsReaperServiceRole","Allow","xray:PutTelemetryRecords","*","{}"],
  ["role:SessionsReaperServiceRole","Allow","xray:PutTraceSegments","*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:BatchGetItem","table:State","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:BatchGetItem","table:State/index/*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:BatchWriteItem","table:State","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:BatchWriteItem","table:State/index/*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:ConditionCheckItem","table:State","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:ConditionCheckItem","table:State/index/*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:DeleteItem","table:State","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:DeleteItem","table:State/index/*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:DescribeTable","table:State","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:DescribeTable","table:State/index/*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:GetItem","table:SlackThreads","{\"ForAllValues:StringEquals\":{\"dynamodb:Attributes\":[\"activeTurn\",\"pk\",\"sk\"]},\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"THREAD#*\"]},\"Null\":{\"dynamodb:Attributes\":[\"false\"]},\"StringEqualsIfExists\":{\"dynamodb:Select\":[\"SPECIFIC_ATTRIBUTES\"]}}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:GetItem","table:State","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:GetItem","table:State/index/*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:GetRecords","table:State","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:GetRecords","table:State/index/*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:GetShardIterator","table:State","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:GetShardIterator","table:State/index/*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:PutItem","table:State","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:PutItem","table:State/index/*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:Query","table:State","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:Query","table:State/index/*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:Scan","table:State","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:Scan","table:State/index/*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:UpdateItem","table:State","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","dynamodb:UpdateItem","table:State/index/*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","ec2:CreateTags","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:volume/*","{\"ForAllValues:StringEquals\":{\"aws:TagKeys\":[\"agentx:quarantined\"]},\"StringEquals\":{\"aws:ResourceTag/DeploymentMode\":[\"ec2-ebs\"],\"aws:ResourceTag/Environment\":[\"staging\"]}}"],
  ["role:SessionsReconcilerServiceRole","Allow","ec2:DeleteVolume","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:instance/*","{\"StringEquals\":{\"aws:ResourceTag/DeploymentMode\":[\"ec2-ebs\"],\"aws:ResourceTag/Environment\":[\"staging\"]}}"],
  ["role:SessionsReconcilerServiceRole","Allow","ec2:DeleteVolume","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:volume/*","{\"StringEquals\":{\"aws:ResourceTag/DeploymentMode\":[\"ec2-ebs\"],\"aws:ResourceTag/Environment\":[\"staging\"]}}"],
  ["role:SessionsReconcilerServiceRole","Allow","ec2:DescribeInstances","*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","ec2:DescribeVolumes","*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","ec2:TerminateInstances","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:instance/*","{\"StringEquals\":{\"aws:ResourceTag/DeploymentMode\":[\"ec2-ebs\"],\"aws:ResourceTag/Environment\":[\"staging\"]}}"],
  ["role:SessionsReconcilerServiceRole","Allow","ec2:TerminateInstances","arn:parameter:AWS::Partition:ec2:parameter:AWS::Region:parameter:AWS::AccountId:volume/*","{\"StringEquals\":{\"aws:ResourceTag/DeploymentMode\":[\"ec2-ebs\"],\"aws:ResourceTag/Environment\":[\"staging\"]}}"],
  ["role:SessionsReconcilerServiceRole","Allow","secretsmanager:DescribeSecret","secret:ChannelApiSlackAdapterSecret","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","secretsmanager:GetSecretValue","secret:ChannelApiSlackAdapterSecret","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","secretsmanager:GetSecretValue","secret:SlackSecret","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","ssm:GetParameter","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-qualified-ami","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","states:DescribeActivity","*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","states:DescribeExecution","arn:parameter:AWS::Partition:states:parameter:AWS::Region:parameter:AWS::AccountId:execution:expression:{\"Fn::Select\":[6,{\"Fn::Split\":[\":\",{\"Ref\":\"SessionsDeleterB48741EA\"}]}]}:*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","states:DescribeExecution","arn:parameter:AWS::Partition:states:parameter:AWS::Region:parameter:AWS::AccountId:execution:expression:{\"Fn::Select\":[6,{\"Fn::Split\":[\":\",{\"Ref\":\"SessionsProvisioner9C44055B\"}]}]}:*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","states:DescribeStateMachine","*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","states:DescribeStateMachineForExecution","arn:parameter:AWS::Partition:states:parameter:AWS::Region:parameter:AWS::AccountId:execution:expression:{\"Fn::Select\":[6,{\"Fn::Split\":[\":\",{\"Ref\":\"SessionsDeleterB48741EA\"}]}]}:*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","states:DescribeStateMachineForExecution","arn:parameter:AWS::Partition:states:parameter:AWS::Region:parameter:AWS::AccountId:execution:expression:{\"Fn::Select\":[6,{\"Fn::Split\":[\":\",{\"Ref\":\"SessionsProvisioner9C44055B\"}]}]}:*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","states:GetExecutionHistory","arn:parameter:AWS::Partition:states:parameter:AWS::Region:parameter:AWS::AccountId:execution:expression:{\"Fn::Select\":[6,{\"Fn::Split\":[\":\",{\"Ref\":\"SessionsDeleterB48741EA\"}]}]}:*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","states:GetExecutionHistory","arn:parameter:AWS::Partition:states:parameter:AWS::Region:parameter:AWS::AccountId:execution:expression:{\"Fn::Select\":[6,{\"Fn::Split\":[\":\",{\"Ref\":\"SessionsProvisioner9C44055B\"}]}]}:*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","states:ListActivities","*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","states:ListExecutions","machine:SessionsDeleter","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","states:ListExecutions","machine:SessionsProvisioner","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","states:ListStateMachines","machine:SessionsDeleter","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","states:ListStateMachines","machine:SessionsProvisioner","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","states:StartExecution","machine:SessionsProvisioner","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","xray:PutTelemetryRecords","*","{}"],
  ["role:SessionsReconcilerServiceRole","Allow","xray:PutTraceSegments","*","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:BatchGetItem","table:State","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:BatchGetItem","table:State/index/*","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:BatchWriteItem","table:State","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:BatchWriteItem","table:State/index/*","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:ConditionCheckItem","table:State","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:ConditionCheckItem","table:State/index/*","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:DeleteItem","table:State","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:DeleteItem","table:State/index/*","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:DescribeTable","table:State","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:DescribeTable","table:State/index/*","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:GetItem","table:State","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:GetItem","table:State/index/*","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:GetRecords","table:State","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:GetRecords","table:State/index/*","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:GetShardIterator","table:State","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:GetShardIterator","table:State/index/*","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:PutItem","table:State","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:PutItem","table:State/index/*","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:Query","table:State","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:Query","table:State/index/*","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:Scan","table:State","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:Scan","table:State/index/*","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:UpdateItem","table:State","{}"],
  ["role:SessionsStepsServiceRole","Allow","dynamodb:UpdateItem","table:State/index/*","{}"],
  ["role:SessionsStepsServiceRole","Allow","kms:GetPublicKey","key:InvokeSigningKey","{}"],
  ["role:SessionsStepsServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-anthropic-secret-arn","{}"],
  ["role:SessionsStepsServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-e2e-agent-model","{}"],
  ["role:SessionsStepsServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-executor-image","{}"],
  ["role:SessionsStepsServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-image","{}"],
  ["role:SessionsStepsServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-model-fallback","{}"],
  ["role:SessionsStepsServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-model-id","{}"],
  ["role:SessionsStepsServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-model-provider","{}"],
  ["role:SessionsStepsServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-openai-secret-arn","{}"],
  ["role:SessionsStepsServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-openrouter-providers","{}"],
  ["role:SessionsStepsServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-openrouter-secret-arn","{}"],
  ["role:SessionsStepsServiceRole","Allow","ssm:GetParameters","arn:parameter:AWS::Partition:ssm:parameter:AWS::Region:parameter:AWS::AccountId:parameter/agentx/staging/worker-prompt-cache-retention","{}"],
  ["role:SessionsStepsServiceRole","Allow","xray:PutTelemetryRecords","*","{}"],
  ["role:SessionsStepsServiceRole","Allow","xray:PutTraceSegments","*","{}"],
  ["role:SlackIngressServiceRole","Allow","dynamodb:BatchGetItem","table:SlackThreads","{}"],
  ["role:SlackIngressServiceRole","Allow","dynamodb:BatchWriteItem","table:SlackThreads","{}"],
  ["role:SlackIngressServiceRole","Allow","dynamodb:ConditionCheckItem","table:SlackThreads","{}"],
  ["role:SlackIngressServiceRole","Allow","dynamodb:DeleteItem","table:SlackThreads","{}"],
  ["role:SlackIngressServiceRole","Allow","dynamodb:DescribeTable","table:SlackThreads","{}"],
  ["role:SlackIngressServiceRole","Allow","dynamodb:GetItem","table:SlackThreads","{}"],
  ["role:SlackIngressServiceRole","Allow","dynamodb:GetItem","table:State","{\"ForAllValues:StringEquals\":{\"dynamodb:Attributes\":[\"pk\",\"share\",\"sk\",\"slackUserId\",\"workflow\"]},\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"DEVTASK#*\"]},\"Null\":{\"dynamodb:Attributes\":[\"false\"]},\"StringEqualsIfExists\":{\"dynamodb:Select\":[\"SPECIFIC_ATTRIBUTES\"]}}"],
  ["role:SlackIngressServiceRole","Allow","dynamodb:GetItem","table:State","{\"ForAllValues:StringEquals\":{\"dynamodb:Attributes\":[\"pk\",\"sk\",\"traceId\"]},\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"ADMIN_CHANGE#*\"]},\"Null\":{\"dynamodb:Attributes\":[\"false\"]},\"StringEqualsIfExists\":{\"dynamodb:Select\":[\"SPECIFIC_ATTRIBUTES\"]}}"],
  ["role:SlackIngressServiceRole","Allow","dynamodb:GetItem","table:State","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"SHARED_TASK#*\"]}}"],
  ["role:SlackIngressServiceRole","Allow","dynamodb:GetItem","table:State","{\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"SLACK_BINDING#*\"]}}"],
  ["role:SlackIngressServiceRole","Allow","dynamodb:GetItem","table:TurnRecords","{\"ForAllValues:StringEquals\":{\"dynamodb:Attributes\":[\"argumentsOmitted\",\"calls\",\"callsTruncated\",\"disposition\",\"durationMs\",\"emptyResponse\",\"error\",\"eventId\",\"expiresAt\",\"exportPk\",\"exportSk\",\"model\",\"offeredTools\",\"pk\",\"receivedAt\",\"recordingErrors\",\"requestedBy\",\"sk\",\"subject\",\"usage\",\"usageError\"]},\"ForAllValues:StringLike\":{\"dynamodb:LeadingKeys\":[\"THREAD#*\"]},\"Null\":{\"dynamodb:Attributes\":[\"false\"]},\"StringEqualsIfExists\":{\"dynamodb:Select\":[\"SPECIFIC_ATTRIBUTES\"]}}"],
  ["role:SlackIngressServiceRole","Allow","dynamodb:GetRecords","table:SlackThreads","{}"],
  ["role:SlackIngressServiceRole","Allow","dynamodb:GetShardIterator","table:SlackThreads","{}"],
  ["role:SlackIngressServiceRole","Allow","dynamodb:PutItem","table:SlackThreads","{}"],
  ["role:SlackIngressServiceRole","Allow","dynamodb:Query","table:SlackThreads","{}"],
  ["role:SlackIngressServiceRole","Allow","dynamodb:Scan","table:SlackThreads","{}"],
  ["role:SlackIngressServiceRole","Allow","dynamodb:UpdateItem","table:SlackThreads","{}"],
  ["role:SlackIngressServiceRole","Allow","lambda:InvokeFunction","function:Broker:*","{}"],
  ["role:SlackIngressServiceRole","Allow","lambda:InvokeFunction","function:Broker","{}"],
  ["role:SlackIngressServiceRole","Allow","lambda:InvokeFunction","function:SlackIngress","{}"],
  ["role:SlackIngressServiceRole","Allow","secretsmanager:DescribeSecret","secret:ChannelApiSlackAdapterSecret","{}"],
  ["role:SlackIngressServiceRole","Allow","secretsmanager:DescribeSecret","secret:SlackSecret","{}"],
  ["role:SlackIngressServiceRole","Allow","secretsmanager:GetSecretValue","secret:ChannelApiSlackAdapterSecret","{}"],
  ["role:SlackIngressServiceRole","Allow","secretsmanager:GetSecretValue","secret:SlackSecret","{}"],
  ["role:SlackIngressServiceRole","Allow","sqs:GetQueueAttributes","queue:SlackHandOffFailureQueue","{}"],
  ["role:SlackIngressServiceRole","Allow","sqs:GetQueueAttributes","queue:SlackRequestQueue","{}"],
  ["role:SlackIngressServiceRole","Allow","sqs:GetQueueUrl","queue:SlackHandOffFailureQueue","{}"],
  ["role:SlackIngressServiceRole","Allow","sqs:GetQueueUrl","queue:SlackRequestQueue","{}"],
  ["role:SlackIngressServiceRole","Allow","sqs:SendMessage","queue:SlackHandOffFailureQueue","{}"],
  ["role:SlackIngressServiceRole","Allow","sqs:SendMessage","queue:SlackRequestQueue","{}"],
  ["role:SlackIngressServiceRole","Allow","xray:PutTelemetryRecords","*","{}"],
  ["role:SlackIngressServiceRole","Allow","xray:PutTraceSegments","*","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","bedrock:InvokeModel","arn:parameter:AWS::Partition:bedrock:*::foundation-model/*","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","bedrock:InvokeModel","arn:parameter:AWS::Partition:bedrock:parameter:AWS::Region:parameter:AWS::AccountId:inference-profile/*","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","bedrock:InvokeModelWithResponseStream","arn:parameter:AWS::Partition:bedrock:*::foundation-model/*","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","bedrock:InvokeModelWithResponseStream","arn:parameter:AWS::Partition:bedrock:parameter:AWS::Region:parameter:AWS::AccountId:inference-profile/*","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","dynamodb:BatchGetItem","table:SlackThreads","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","dynamodb:BatchWriteItem","table:SlackThreads","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","dynamodb:ConditionCheckItem","table:SlackThreads","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","dynamodb:DeleteItem","table:SlackThreads","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","dynamodb:DescribeTable","table:SlackThreads","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","dynamodb:GetItem","table:SlackThreads","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","dynamodb:GetRecords","table:SlackThreads","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","dynamodb:GetShardIterator","table:SlackThreads","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","dynamodb:PutItem","table:SlackThreads","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","dynamodb:PutItem","table:TurnRecords","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","dynamodb:Query","table:SlackThreads","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","dynamodb:Scan","table:SlackThreads","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","dynamodb:UpdateItem","table:SlackThreads","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","execute-api:Invoke","arn:parameter:AWS::Partition:execute-api:parameter:AWS::Region:parameter:AWS::AccountId:AWS::ApiGatewayV2::Api:HttpApi/*/*/v1/service/*","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","s3:Abort*","bucket:SlackThreadSessions","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","s3:Abort*","bucket:SlackThreadSessions/*","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","s3:DeleteObject*","bucket:SlackThreadSessions","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","s3:DeleteObject*","bucket:SlackThreadSessions/*","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","s3:GetBucket*","bucket:SlackThreadSessions","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","s3:GetBucket*","bucket:SlackThreadSessions/*","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","s3:GetObject*","bucket:SlackThreadSessions","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","s3:GetObject*","bucket:SlackThreadSessions/*","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","s3:List*","bucket:SlackThreadSessions","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","s3:List*","bucket:SlackThreadSessions/*","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","s3:PutObject","bucket:SlackThreadSessions","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","s3:PutObject","bucket:SlackThreadSessions/*","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","s3:PutObjectLegalHold","bucket:SlackThreadSessions","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","s3:PutObjectLegalHold","bucket:SlackThreadSessions/*","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","s3:PutObjectRetention","bucket:SlackThreadSessions","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","s3:PutObjectRetention","bucket:SlackThreadSessions/*","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","s3:PutObjectTagging","bucket:SlackThreadSessions","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","s3:PutObjectTagging","bucket:SlackThreadSessions/*","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","s3:PutObjectVersionTagging","bucket:SlackThreadSessions","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","s3:PutObjectVersionTagging","bucket:SlackThreadSessions/*","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","secretsmanager:DescribeSecret","secret:ChannelApiSlackAdapterSecret","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","secretsmanager:DescribeSecret","secret:SlackSecret","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","secretsmanager:GetSecretValue","parameter:AnthropicSecretArn","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","secretsmanager:GetSecretValue","parameter:OpenAISecretArn","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","secretsmanager:GetSecretValue","parameter:OpenRouterSecretArn","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","secretsmanager:GetSecretValue","secret:ChannelApiSlackAdapterSecret","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","secretsmanager:GetSecretValue","secret:SlackSecret","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","sqs:ChangeMessageVisibility","queue:ChannelApiRequests","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","sqs:ChangeMessageVisibility","queue:SlackRequestQueue","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","sqs:DeleteMessage","queue:ChannelApiRequests","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","sqs:DeleteMessage","queue:SlackRequestQueue","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","sqs:GetQueueAttributes","queue:ChannelApiEvents","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","sqs:GetQueueAttributes","queue:ChannelApiRequests","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","sqs:GetQueueAttributes","queue:SlackRequestQueue","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","sqs:GetQueueUrl","queue:ChannelApiEvents","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","sqs:GetQueueUrl","queue:ChannelApiRequests","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","sqs:GetQueueUrl","queue:SlackRequestQueue","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","sqs:ReceiveMessage","queue:ChannelApiRequests","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","sqs:ReceiveMessage","queue:SlackRequestQueue","{}"],
  ["role:SlackOrchestratorTaskRole","Allow","sqs:SendMessage","queue:ChannelApiEvents","{}"],
  ["role:WorkflowDispatchRecoveryRole","Allow","lambda:InvokeFunction","function:Broker:*","{}"],
  ["role:WorkflowDispatchRecoveryRole","Allow","lambda:InvokeFunction","function:Broker","{}"],
];

function matchesConditions(text: string, context: Record<string, string[]>): boolean {
  const condition = JSON.parse(text) as Record<string, Record<string, string[]>>;
  return Object.entries(condition).every(([operator, fields]) => {
    if (!conditionOperators.has(operator)) throw new Error("unsupported IAM condition");
    return Object.entries(fields).every(([key, expected]) => {
      const actual = context[key] ?? [];
      if (operator === "Null") return expected.includes(String(actual.length === 0));
      if (operator === "StringEqualsIfExists" && actual.length === 0) return true;
      const like = operator.endsWith("Like");
      const one = (v: string) => expected.some((p) => like ? globRegExp(p).test(v) : p === v);
      if (operator === "ArnNotEquals") return !actual.some(one);
      if (operator.startsWith("ForAllValues:")) return actual.every(one);
      return actual.some(one);
    });
  });
}
function probe(tuples: AccessTuple[], principal: string, action: string, resource: string, context: Record<string, string[]>): boolean {
  const applicable = tuples.filter(([p, , a, r, c]) => (p === principal || p === "*") && globRegExp(a, "i").test(action) && globRegExp(r).test(resource) && matchesConditions(c, { ...context, "aws:PrincipalArn": [principal] }));
  return !applicable.some(([, e]) => e === "Deny") && applicable.some(([, e]) => e === "Allow") && policyAllows(defaultBoundaryStatements(policyScope), action, resource);
}

const BROKER_ARN_ESTIMATE = 144;
const BROKER_RESOLVED_INLINE_SIZE = 6114; // All inline documents after realistic ARN expansion.
const BROKER_INLINE_ESTIMATE = 7492; // This replaces the R3R4 pin.
const BROKER_INLINE_TARGET = 8500;
const RESERVED = {
  r2: 600, // State stream reads and callback-key read; EC2 belongs to the dispatcher.
  t5: 250, // Optional State LeadingKeys-limited GitHub grant, pending T5 Q3.
  t6: 150, // Company-session AssumeRole/TagSession, net of blanket-read removal.
};
function inlineEstimate(statements: Statement[], arnEstimate = BROKER_ARN_ESTIMATE): number {
  return statements.reduce((total, s) => total + `"Effect": "${s.Effect}",`.length + ["Action", "Resource"].reduce((size, key) => {
    const values = [s[key as "Action" | "Resource"]].flat();
    return size + key.length + 5 + values.reduce<number>((sum, v) => sum + (typeof v === "string" ? v.length : arnEstimate) + 3, 0);
  }, 0) + JSON.stringify(s.Condition ?? {}).length, 0);
}
function checkHeadroom(template: TemplateJson): void {
  const statements = statementsOfRole(template, "BrokerServiceRole");
  const n = inlineEstimate(statements);
  const reserveUnspent = Object.values(RESERVED).reduce((a, b) => a + b, 0);
  const message = `broker inline policy estimate is ${n}, pinned ${BROKER_INLINE_ESTIMATE}. CDK splits at 10,000 into a managed policy the deploy role cannot create (the boundary denies iam:CreatePolicy*), so the deploy would fail. Before adding a statement here, move the grant to a resource policy or merge statements (see briefs/codex/infra-iam-headroom/BRIEF.md). Reserve left: ${8500 - n - reserveUnspent}.`;
  expect(ofType(template, "AWS::IAM::Policy").filter(([, r]) => JSON.stringify(r.Properties.Roles).includes("BrokerServiceRole")), message).toHaveLength(1);
  expect(ofType(template, "AWS::IAM::ManagedPolicy"), message).toHaveLength(0);
  expect(Object.keys(template.Resources).filter((id) => id.includes("Overflow")), message).toEqual([]);
  expect(n, message).toBe(BROKER_INLINE_ESTIMATE);
}
/** Resolve only intrinsics present in the broker's policies; unknown forms fail the whole check.
 * Fixture: aws/us-west-2/12-digit account, maximum 20-character environment, and generated
 * stack-logicalID-13-character-suffix names (truncated only to the service's name limit).
 * Explicit physical names and ARN parameters are expanded, never replaced by a size estimate.
 */
function resolvedInlineSize(template: TemplateJson): number {
  const prefix = "arn:aws:";
  const regionAccount = "us-west-2:111122223333:";
  const stackName = `agentx-${LONGEST_ENV}-control-plane`;
  const resolve = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(resolve);
    if (value === null || typeof value !== "object") return value;
    const node = value as Record<string, unknown>;
    if (Object.hasOwn(node, "Ref")) {
      const refs: Record<string, string> = {
        "AWS::Partition": "aws", "AWS::Region": "us-west-2", "AWS::AccountId": "111122223333",
        GitHubAppPrivateKeySecretArn: `${prefix}secretsmanager:${regionAccount}secret:agentx/${LONGEST_ENV}/github-app-private-key-AbCdEf`,
      };
      if (typeof node.Ref !== "string") throw new Error("unsupported resolved inline reference");
      if (Object.hasOwn(refs, node.Ref)) return refs[node.Ref]!;
      if (template.Resources[node.Ref]?.Type === "AWS::StepFunctions::StateMachine") return resourceArn(node.Ref);
      throw new Error("unsupported resolved inline reference");
    }
    if (Object.hasOwn(node, "Fn::GetAtt")) {
      const attr = node["Fn::GetAtt"];
      if (!Array.isArray(attr) || attr.length !== 2 || typeof attr[0] !== "string" || attr[1] !== "Arn") throw new Error("unsupported resolved inline attribute");
      return resourceArn(attr[0]);
    }
    if (Object.hasOwn(node, "Fn::Join")) {
      const join = node["Fn::Join"];
      if (!Array.isArray(join) || join.length !== 2 || typeof join[0] !== "string" || !Array.isArray(join[1])) throw new Error("unsupported resolved inline join");
      const parts = join[1].map(resolve);
      if (!parts.every((part): part is string => typeof part === "string")) throw new Error("unsupported resolved inline join");
      return parts.join(join[0]);
    }
    if (Object.keys(node).some((key) => key.startsWith("Fn::"))) throw new Error("unsupported resolved inline intrinsic");
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, resolve(child)]));
  };
  const resourceArn = (id: string): string => {
    const resource = template.Resources[id];
    const formats: Record<string, { property: string; limit: number; service: string; kind: string }> = {
      "AWS::DynamoDB::Table": { property: "TableName", limit: 255, service: "dynamodb", kind: "table/" },
      "AWS::Lambda::Function": { property: "FunctionName", limit: 64, service: "lambda", kind: "function:" },
      "AWS::SQS::Queue": { property: "QueueName", limit: 80, service: "sqs", kind: "" },
      "AWS::StepFunctions::StateMachine": { property: "StateMachineName", limit: 80, service: "states", kind: "stateMachine:" },
    };
    const format = resource && formats[resource.Type];
    if (!resource || !format) throw new Error("unsupported resolved inline resource");
    const physical = resource.Properties[format.property];
    const name = physical === undefined ? `${`${stackName}-${id}`.slice(0, format.limit - 14)}-A1B2C3D4E5F6G` : resolve(physical);
    if (typeof name !== "string") throw new Error("unsupported resolved inline name");
    return `${prefix}${format.service}:${regionAccount}${format.kind}${name}`;
  };
  const broker = ofType(template, "AWS::IAM::Role").find(([id]) => withoutHash(id) === "BrokerServiceRole")!;
  const documents = ofType(template, "AWS::IAM::Policy")
    .filter(([, policy]) => (policy.Properties.Roles as Ref[] | undefined)?.some((role) => role.Ref === broker[0]))
    .map(([, policy]) => policy.Properties.PolicyDocument);
  documents.push(...((broker[1].Properties.Policies ?? []) as Array<{ PolicyDocument: unknown }>).map((policy) => policy.PolicyDocument));
  return documents.reduce<number>((total, document) => total + JSON.stringify(resolve(document)).replace(/\s/g, "").length, 0);
}

const movedResources = ["bucket:Artifacts", "bucket:Artifacts/*", "queue:SlackRequestQueue", "queue:DispatchDeadLetterQueue", "queue:SlackRequestDeadLetterQueue", "queue:DeveloperTaskNotifierNoticeDeadLetterQueue", "queue:DeveloperTaskNotifierStreamFailureQueue", "queue:ChannelApiEventDeadLetters", "key:ChatGptConnectionKey"];

describe("broker IAM headroom", () => {
  it("preserves every role's effective tuples exactly", () => {
    expect(accessTuples(named)).toEqual(beforeTuples);
  });

  it("has the same semantic results for every role, resource, condition and sibling", () => {
    const after = accessTuples(named);
    const roles = [...new Set([...beforeTuples, ...after].map(([p]) => p).filter((p) => p !== "*")), "role:agentx-other-env"];
    const extras = { s3: ["GetObject", "PutObject", "DeleteObject", "GetBucketPolicy", "PutBucketPolicy", "ListBucket", "GetObjectVersion"], sqs: ["SendMessage", "ReceiveMessage", "DeleteMessage", "PurgeQueue", "SetQueueAttributes", "GetQueueAttributes"], kms: ["Encrypt", "Decrypt", "GenerateDataKey", "Sign", "ScheduleKeyDeletion"], dynamodb: ["GetItem", "PutItem", "DeleteItem", "Scan", "Query"] };
    const actions = [...new Set([...beforeTuples, ...after].filter(([p]) => p === "role:BrokerServiceRole").map(([, , a]) => a).concat(Object.entries(extras).flatMap(([service, names]) => names.map((name) => `${service}:${name}`))))];
    const resources = [...new Set([...beforeTuples, ...after].map(([, , , r]) => r).concat(Object.entries(named.Resources).filter(([, r]) => Object.hasOwn(symbolicTypes, r.Type)).map(([id]) => symbol(named, { "Fn::GetAtt": [id, "Arn"] })), ["bucket:Sibling", "bucket:Sibling/object", "queue:Sibling", "key:Sibling", "table:Sibling"]))];
    // Index role-specific tuples once; this is a finite synthesized template, not customer input.
    for (const role of roles) {
      const b = beforeTuples.filter(([p]) => p === role || p === "*");
      const a = after.filter(([p]) => p === role || p === "*");
      const beforeResults: boolean[] = []; const afterResults: boolean[] = [];
      for (const action of actions) for (const resource of resources) for (const key of ["TASK#1", "COMPANY_MEMBER#1", undefined]) {
        const context = { "aws:SecureTransport": ["true"], "secretsmanager:ResourceTag/agentx-writable": ["refresh-token"], ...(key === undefined ? {} : { "dynamodb:LeadingKeys": [key] }) };
        beforeResults.push(probe(b, role, action, resource, context));
        afterResults.push(probe(a, role, action, resource, context));
      }
      expect(afterResults, role).toEqual(beforeResults);
    }
  }, 120_000);

  it("moves each exact grant to a broker-only resource policy with no duplicate identity grant", () => {
    const broker = ofType(named, "AWS::IAM::Role").find(([id]) => withoutHash(id) === "BrokerServiceRole")![0];
    const resourceOnly = structuredClone(named);
    for (const [id, r] of Object.entries(resourceOnly.Resources)) if (["AWS::IAM::Policy", "AWS::IAM::ManagedPolicy"].includes(r.Type)) delete resourceOnly.Resources[id];
    for (const [, r] of ofType(resourceOnly, "AWS::IAM::Role")) delete r.Properties.Policies;
    const moved = accessTuples(resourceOnly).filter(([, e, , r]) => e === "Allow" && movedResources.includes(r));
    expect(moved).toEqual(beforeTuples.filter(([p, e, , r]) => p === "role:BrokerServiceRole" && e === "Allow" && movedResources.includes(r)));
    for (const { statement } of resourceStatements(named).filter(({ statement }) => statement.Effect === "Allow" && JSON.stringify(statement.Principal).includes(broker))) {
      expect(statement.Principal).toEqual({ AWS: roleArn(broker) });
    }
    for (const s of statementsOfRole(named, "BrokerServiceRole")) for (const r of [s.Resource].flat()) expect(movedResources).not.toContain(symbol(named, r));
    for (const principal of ["role:DispatcherServiceRole", "role:DeveloperSignInFunctionServiceRole", "role:SlackIngressServiceRole", "role:agentx-other-env"]) {
      for (const [, , action, resource] of moved) expect(probe(moved, principal, action, resource, {})).toBe(false);
    }
    const [, key] = ofType(named, "AWS::KMS::Key").find(([id]) => withoutHash(id) === "ChatGptConnectionKey")!;
    expect(statementsIn(key.Properties.KeyPolicy).filter((s) => allows(s, "kms:PutKeyPolicy"))).toEqual([{
      Action: "kms:*", Effect: "Allow", Principal: { AWS: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::", { Ref: "AWS::AccountId" }, ":root"]] } }, Resource: "*",
    }]);
  });

  it("pins headroom and preserves the unspent reserve", () => { expect(brokerArnEstimate, "named broker ARN estimate fallback").toBe(BROKER_ARN_ESTIMATE); checkHeadroom(named); expect(inlineEstimate(statementsOfRole(named, "BrokerServiceRole"))).toBe(brokerEstimate); });

  it("enforces the 8500 ceiling including the complete reserve ledger", () => {
    const n = inlineEstimate(statementsOfRole(named, "BrokerServiceRole"));
    expect(n + Object.values(RESERVED).reduce((a, b) => a + b, 0), `broker inline ceiling ${BROKER_INLINE_TARGET}; RESERVED ledger ${JSON.stringify(RESERVED)}`).toBeLessThanOrEqual(BROKER_INLINE_TARGET);
  });

  it("calibrates the estimator against CDK at its actual split threshold", () => {
    for (const expected of [9999, 10001]) {
      const stack = new Stack(new App({ context: { [ARN_ESTIMATE_CONTEXT]: BROKER_ARN_ESTIMATE } }), `Calibration${expected}`);
      const role = new iam.Role(stack, "Role", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });
      const arn = new CfnParameter(stack, "ResourceArn").valueAsString;
      const tokenStatement: Statement = { Effect: "Allow", Action: "s3:GetObject", Resource: { Ref: "ResourceArn" } };
      const fixed: Statement = { Effect: "Allow", Action: "s3:PutObject", Resource: "x" };
      const length = expected - inlineEstimate([tokenStatement, fixed]) + 1;
      role.addToPolicy(new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [arn] }));
      role.addToPolicy(new iam.PolicyStatement({ actions: ["s3:PutObject"], resources: ["x".repeat(length)] }));
      const template = Template.fromStack(stack).toJSON() as TemplateJson;
      expect(inlineEstimate([tokenStatement, { ...fixed, Resource: "x".repeat(length) }])).toBe(expected);
      expect(ofType(template, "AWS::IAM::ManagedPolicy").length > 0, `CDK split at ${expected}`).toBe(expected > 10000);
    }
  });

  it("pins the longest-environment resolved aggregate with at least 1500 characters spare", () => {
    const size = resolvedInlineSize(longestNamed);
    const message = `broker resolved inline total ${size}; pinned ${BROKER_RESOLVED_INLINE_SIZE}; AWS aggregate quota 10240 requires at least 1500 spare (maximum 8740). Count every inline policy after ARN expansion.`;
    expect(LONGEST_ENV).toHaveLength(20);
    expect.soft(size, message).toBe(BROKER_RESOLVED_INLINE_SIZE);
    expect(size, message).toBeLessThanOrEqual(10240 - 1500);
  });

  it("counts separate and embedded inline policies and refuses unresolved forms", () => {
    const extra = structuredClone(longestNamed);
    const [broker, role] = ofType(extra, "AWS::IAM::Role").find(([id]) => withoutHash(id) === "BrokerServiceRole")!;
    const document = { Version: "2012-10-17", Statement: [{ Condition: { StringEquals: { "aws:PrincipalTag/label": "White space" } }, Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::headroom-probe/object" }] };
    extra.Resources.ExtraInline = { Type: "AWS::IAM::Policy", Properties: { Roles: [{ Ref: broker }], PolicyDocument: document } };
    role.Properties.Policies = [{ PolicyName: "Embedded", PolicyDocument: document }];
    expect(resolvedInlineSize(extra) - resolvedInlineSize(longestNamed)).toBe(2 * JSON.stringify(document).replace(/\s/g, "").length);
    for (const unsupported of [{ Ref: "do-not-echo" }, { "Fn::GetAtt": ["do-not-echo", "Arn"] }, { "Fn::Sub": "do-not-echo" }]) {
      extra.Resources.ExtraInline.Properties.PolicyDocument = { ...document, Statement: [{ ...document.Statement[0], Resource: unsupported }] };
      expect(() => resolvedInlineSize(extra)).toThrow(/^unsupported resolved inline (reference|resource|intrinsic)$/);
    }
  });

  it("sanity-checks JSON with every ARN token expanded to 150 characters", () => {
    const statements = statementsOfRole(named, "BrokerServiceRole").map((s) => ({ ...s, Resource: ([s.Resource].flat()).map((r) => typeof r === "string" ? r : "x".repeat(150)) }));
    expect(JSON.stringify({ Version: "2012-10-17", Statement: statements }).replace(/\s/g, "").length).toBeLessThan(10240 - 1000);
  });

  it("rejects unsupported conditions and statements with fixed errors", () => {
    const bad = structuredClone(named);
    const [, policy] = ofType(bad, "AWS::IAM::Policy")[0]!;
    for (const patch of [{ Condition: { Unsupported: { secret: "do-not-echo" } } }, { Effect: "do-not-echo" }, { Action: 123 }, { Resource: null }]) {
      const original = statementsIn(policy.Properties.PolicyDocument)[0]!;
      const copy = { ...original, ...patch };
      statementsIn(policy.Properties.PolicyDocument)[0] = copy as Statement;
      expect(() => accessTuples(bad)).toThrow(/^unsupported IAM (condition|statement|symbol)$/);
      statementsIn(policy.Properties.PolicyDocument)[0] = original;
    }
    expect(() => matchesConditions('{"Unsupported":{"secret":["do-not-echo"]}}', {})).toThrow("unsupported IAM condition");
  });
});

describe("projected broker additions", () => {
  it("fits concrete R2, T5 and T6 statements without assuming a future read removal", () => {
    const state = ofType(named, "AWS::DynamoDB::Table").find(([id]) => withoutHash(id) === "State")![0];
    const PROJECTED: Record<string, Statement[]> = {
      r2: [
        { Effect: "Allow", Action: "dynamodb:ListStreams", Resource: "*" },
        { Effect: "Allow", Action: ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator"], Resource: { "Fn::GetAtt": [state, "StreamArn"] } },
      ],
      t5: [{ Effect: "Allow", Action: "dynamodb:GetItem", Resource: roleArn(state), Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["GITHUB#*"] } } }],
      t6: [{ Effect: "Allow", Action: ["sts:AssumeRole", "sts:TagSession"], Resource: { "Fn::GetAtt": ["CompanySessionRole", "Arn"] } }],
    };
    const projected = structuredClone(statementsOfRole(named, "BrokerServiceRole"));
    const secrets = projected.find((s) => s.Action === "secretsmanager:GetSecretValue" && s.Condition === undefined)!;
    secrets.Resource = [...[secrets.Resource].flat(), { Ref: "CallbackKeyArn" }];
    projected.push(...Object.values(PROJECTED).flat());
    // T6's blanket company-read grant is not on this base. Count its full new statement;
    // never claim a saving by removing an unrelated existing install-wide secret grant.
    expect(inlineEstimate(projected), "R2/T5/T6 projected statements exceed the broker ceiling").toBeLessThanOrEqual(BROKER_INLINE_TARGET);
  });
});

describe("headroom evaluator positive and negative controls", () => {
  it("distinguishes moved grants, siblings, explicit denies and LeadingKeys contexts", () => {
    const tuples = accessTuples(named);
    const broker = "role:BrokerServiceRole";
    const secure = { "aws:SecureTransport": ["true"] };
    for (const [action, resource, allowed] of [
      ["s3:GetObject", "bucket:Artifacts/file", true], ["s3:GetObject", "bucket:Sibling/file", false],
      ["s3:PutBucketPolicy", "bucket:Artifacts", false], ["sqs:SendMessage", "queue:SlackRequestQueue", true],
      ["sqs:ReceiveMessage", "queue:SlackRequestQueue", false], ["sqs:DeleteMessage", "queue:SlackRequestQueue", false],
      ["sqs:PurgeQueue", "queue:SlackRequestQueue", false], ["sqs:SendMessage", "queue:DispatchDeadLetterQueue", false],
      ["kms:Encrypt", "key:ChatGptConnectionKey", true], ["kms:Decrypt", "key:ChatGptConnectionKey", true],
      ["kms:GenerateDataKey", "key:ChatGptConnectionKey", false], ["kms:ScheduleKeyDeletion", "key:ChatGptConnectionKey", false],
    ] as const) expect(probe(tuples, broker, action, resource, secure), `${action} ${resource}`).toBe(allowed);
    expect(probe(tuples, broker, "s3:GetObject", "bucket:Artifacts/file", { "aws:SecureTransport": ["false"] })).toBe(false);
    expect(probe(tuples, broker, "dynamodb:UpdateItem", "table:TurnRecords", { "dynamodb:LeadingKeys": ["TASK#1"] })).toBe(false);
    expect(probe(tuples, broker, "dynamodb:UpdateItem", "table:TurnRecords", { "dynamodb:LeadingKeys": ["CHANGE#1"] })).toBe(true);
    expect(probe(tuples, broker, "dynamodb:ConditionCheckItem", "table:DeveloperSignInTable", {})).toBe(false);
  });
});
