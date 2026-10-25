import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type TemplateJson = {
  Parameters?: Record<string, Record<string, unknown>>;
  Conditions?: Record<string, unknown>;
  Resources?: Record<string, { Type: string; Condition?: string; Properties?: Record<string, unknown> }>;
};

function namedTemplate(env: string, account = "944937319445", region = "us-east-1"): TemplateJson {
  const rendered: unknown = Template.fromStack(new ControlPlaneStack(new App(), `Proof-${env}-${account}-${region}`, {
    env: { account, region }, naming: environmentNaming(env),
  })).toJSON();
  return rendered as TemplateJson;
}

function proofEntries(template: TemplateJson) {
  return Object.entries(template.Resources ?? {}).filter(([logicalId]) => logicalId.includes("TaskPersonProof"));
}

function workflowDependencyEnvironmentEntries(template: TemplateJson) {
  return Object.entries(template.Resources ?? {}).filter(([id, resource]) => id.startsWith("Broker") && resource.Type === "AWS::Lambda::Function");
}

function runtimeCatalogEnvironmentEntries(template: TemplateJson) {
  const brokers = workflowDependencyEnvironmentEntries(template);
  const dispatchers = Object.entries(template.Resources ?? {}).filter(([id, resource]) => id.startsWith("Dispatcher") && resource.Type === "AWS::Lambda::Function");
  expect(brokers, "one Broker owns both runtime catalog IDs").toHaveLength(1);
  expect(dispatchers, "one Dispatcher owns the project setup catalog ID").toHaveLength(1);
  const brokerVariables = brokers[0]![1].Properties!.Environment as { Variables: Record<string, unknown> };
  const dispatcherVariables = dispatchers[0]![1].Properties!.Environment as { Variables: Record<string, unknown> };
  return { broker: brokerVariables.Variables, dispatcher: dispatcherVariables.Variables };
}

function expectRuntimeCatalogEnvironment(template: TemplateJson, prefix: string) {
  const { broker, dispatcher } = runtimeCatalogEnvironmentEntries(template);
  const setupId = `${prefix}-project-setup-runtime-v1`;
  const featureId = `${prefix}-e2e-mock-runtime-v1`;
  expect(broker.AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID).toBe(setupId);
  expect(broker.AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID).toBe(featureId);
  expect(dispatcher.AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID).toBe(setupId);
  expect(dispatcher).not.toHaveProperty("AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID");
}

function appControlPlane(env: string): TemplateJson {
  const stacks = buildAgentXApp({ agentxEnv: env }).node.children.filter((child): child is Stack => Stack.isStack(child));
  const stack = stacks.find((candidate) => candidate.stackName === `agentx-${env}-control-plane`);
  if (stack === undefined) throw new Error(`expected the real ${env} control-plane stack`);
  return Template.fromStack(stack).toJSON();
}

function parentRemainderDigest(template: TemplateJson): string {
  const remainder = structuredClone(template);
  delete remainder.Parameters?.TaskPersonProofEnabled;
  // Spec 059's default-OFF runtime graph addition is asserted exactly below; exclude only that
  // named parameter and its corresponding Broker environment reference from the proof-only hash.
  delete remainder.Parameters?.WorkflowDependenciesEnabled;
  const conditions = remainder.Conditions ?? {};
  for (const id of Object.keys(conditions)) if (id.includes("InstallTaskPersonProof")) delete conditions[id];
  const resources = remainder.Resources ?? {};
  for (const id of Object.keys(resources)) if (id.startsWith("TaskPersonProof")) delete resources[id];
  const dispatchers = Object.entries(resources).filter(([id, resource]) => id.startsWith("Dispatcher") && resource.Type === "AWS::Lambda::Function");
  expect(dispatchers, "the actual Dispatcher remains in the parent template remainder").toHaveLength(1);
  const variables = dispatchers[0]![1].Properties!.Environment as { Variables: Record<string, unknown> };
  delete variables.Variables.TASK_PERSON_PROOF_FUNCTION_ARN;
  delete variables.Variables.SLACK_TEAM_ID;
  delete variables.Variables.DEVELOPER_SIGNIN_TABLE_NAME;
  for (const [id] of workflowDependencyEnvironmentEntries(remainder)) {
    const brokerVariables = resources[id]!.Properties!.Environment as { Variables: Record<string, unknown> };
    delete brokerVariables.Variables.AGENTX_WORKFLOW_DEPENDENCIES_ENABLED;
    delete brokerVariables.Variables.AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID;
    delete brokerVariables.Variables.AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID;
  }
  for (const [, resource] of Object.entries(resources).filter(([id, resource]) => id.startsWith("Dispatcher") && resource.Type === "AWS::Lambda::Function")) {
    const dispatcherVariables = resource.Properties!.Environment as { Variables: Record<string, unknown> };
    delete dispatcherVariables.Variables.AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID;
  }
  // This separately tested, least-privilege creator fence is the only additional sign-in-table
  // statement. Remove only its exact action/resource pair so historical parent hashes stay scoped.
  for (const entry of developerSignInConditionCheckEntries(remainder)) {
    const policy = resources[entry.policyId]!;
    const document = policy.Properties!.PolicyDocument as { Statement: unknown };
    if (Array.isArray(document.Statement)) document.Statement.splice(entry.index, 1);
    else delete (document as { Statement?: unknown }).Statement;
  }
  const establishedAssetHashNormalization = JSON.stringify(remainder).replace(/[a-f0-9]{64}/g, "<asset-hash>");
  return createHash("sha256").update(establishedAssetHashNormalization).digest("hex");
}

function realAppControlPlane(env?: string): TemplateJson {
  const app = buildAgentXApp(env === undefined ? {} : { agentxEnv: env });
  const stacks = app.node.children.filter((child): child is Stack => Stack.isStack(child));
  const stackName = env === undefined ? "AgentXControlPlane" : `agentx-${env}-control-plane`;
  const stack = stacks.find((candidate) => candidate.stackName === stackName);
  if (stack === undefined) throw new Error(`expected actual app control-plane stack ${stackName}`);
  return Template.fromStack(stack).toJSON();
}

function normalizeSingleton(value: unknown): unknown {
  // CDK may emit one IAM Action/Resource as a scalar or a singleton array; normalize only that shape.
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

function developerSignInConditionCheckEntries(template: TemplateJson): Array<{ policyId: string; index: number; statement: Record<string, unknown>; tableId: string }> {
  const resources = template.Resources ?? {};
  const signInTable = Object.entries(resources).find(([id, resource]) => id.startsWith("DeveloperSignInTable") && resource.Type === "AWS::DynamoDB::Table");
  const brokerRole = Object.entries(resources).find(([id, resource]) => id.startsWith("BrokerServiceRole") && resource.Type === "AWS::IAM::Role");
  if (signInTable === undefined || brokerRole === undefined) return [];
  const [tableId] = signInTable;
  const roleId = brokerRole[0];
  const expectedResource = { "Fn::GetAtt": [tableId, "Arn"] };
  const entries: Array<{ policyId: string; index: number; statement: Record<string, unknown>; tableId: string }> = [];
  for (const [policyId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::IAM::Policy") continue;
    const properties = resource.Properties as { Roles?: unknown; PolicyDocument?: { Statement?: unknown } } | undefined;
    const roles = Array.isArray(properties?.Roles) ? properties.Roles as Array<Record<string, unknown>> : [];
    if (!roles.some((role) => role.Ref === roleId)) continue;
    const rawStatements = properties?.PolicyDocument?.Statement;
    const statements = Array.isArray(rawStatements) ? rawStatements : rawStatements === undefined ? [] : [rawStatements];
    statements.forEach((value, index) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return;
      const statement = value as Record<string, unknown>;
      if (normalizeSingleton(statement.Action) === "dynamodb:ConditionCheckItem"
        && JSON.stringify(statement.Resource) === JSON.stringify(expectedResource)) {
        entries.push({ policyId, index, statement, tableId });
      }
    });
  }
  return entries;
}

describe("the named TEST proof-only installation gate", () => {
  it("declares a distinct default-OFF gate only for the approved named environment", () => {
    const approved = namedTemplate("agentxlivetest123");
    const foreign = namedTemplate("staging", "123456789012");
    const wrongAccount = namedTemplate("agentxlivetest123", "123456789012");
    const legacy = Template.fromStack(new ControlPlaneStack(new App(), "Legacy")).toJSON() as TemplateJson;

    expect(approved.Parameters?.TaskPersonProofEnabled).toMatchObject({
      Type: "String",
      Default: "false",
      AllowedValues: ["true", "false"],
    });
    expect(proofEntries(approved).length).toBeGreaterThan(0);
    expect(approved.Parameters?.TaskPeopleChangesEnabled).toMatchObject({ Default: "false" });
    expect(approved.Parameters?.TaskPeoplePublicInvitationsEnabled).toMatchObject({ Default: "false" });
    expect(approved.Parameters?.TaskPeoplePrivateInvitationsEnabled).toMatchObject({ Default: "false" });
    expect(foreign.Parameters?.TaskPersonProofEnabled).toBeUndefined();
    expect(proofEntries(foreign)).toHaveLength(0);
    expect(wrongAccount.Parameters?.TaskPersonProofEnabled).toMatchObject({ Default: "false" });
    expect(proofEntries(wrongAccount).length).toBeGreaterThan(0);
    expect(legacy.Parameters?.TaskPersonProofEnabled).toBeUndefined();
    expect(proofEntries(legacy)).toHaveLength(0);
  });

  it("preserves exact parent app templates outside the named proof addition", () => {
    const named = realAppControlPlane("agentxlivetest123");
    const foreign = realAppControlPlane("staging");
    const legacy = realAppControlPlane();
    expectRuntimeCatalogEnvironment(named, "agentx-agentxlivetest123");
    expectRuntimeCatalogEnvironment(foreign, "agentx-staging");
    expectRuntimeCatalogEnvironment(legacy, "agentx-production");

    for (const [label, template] of [["staging", foreign], ["legacy", legacy]] as const) {
      expect(template.Parameters?.TaskPersonProofEnabled, `${label} has no proof-only parameter`).toBeUndefined();
      expect(proofEntries(template), `${label} has no proof-only resources`).toHaveLength(0);
      const dispatchers = Object.entries(template.Resources ?? {}).filter(([id, resource]) => id.startsWith("Dispatcher") && resource.Type === "AWS::Lambda::Function");
      expect(dispatchers, `${label} has its ordinary Dispatcher`).toHaveLength(1);
      const variables = dispatchers[0]![1].Properties!.Environment as { Variables: Record<string, unknown> };
      for (const key of ["TASK_PERSON_PROOF_FUNCTION_ARN", "SLACK_TEAM_ID", "DEVELOPER_SIGNIN_TABLE_NAME"]) {
        expect(variables.Variables, `${label} has no proof-only ${key}`).not.toHaveProperty(key);
      }
    }

    for (const [label, template] of [["named", named], ["foreign", foreign]] as const) {
      expect(template.Parameters?.WorkflowDependenciesEnabled, `${label} preserves the default-OFF workflow gate`).toMatchObject({
        Type: "String", Default: "false", AllowedValues: ["true", "false"],
      });
      const broker = workflowDependencyEnvironmentEntries(template);
      expect(broker, `${label} has exactly one Broker with the workflow flag`).toHaveLength(1);
      const variables = broker[0]![1].Properties!.Environment as { Variables: Record<string, unknown> };
      expect(variables.Variables.AGENTX_WORKFLOW_DEPENDENCIES_ENABLED, `${label} wires only the parameter reference`).toEqual({ Ref: "WorkflowDependenciesEnabled" });
    }
    expect(legacy.Parameters?.WorkflowDependenciesEnabled, "legacy has no workflow gate parameter").toBeUndefined();
    const legacyBrokers = workflowDependencyEnvironmentEntries(legacy);
    expect(legacyBrokers, "legacy has its Broker Lambda").toHaveLength(1);
    const legacyVariables = legacyBrokers[0]![1].Properties!.Environment as { Variables: Record<string, unknown> };
    expect(legacyVariables.Variables.AGENTX_WORKFLOW_DEPENDENCIES_ENABLED, "legacy has no workflow flag").toBeUndefined();

    const digestCases = [
      {
        label: "named",
        template: named,
        withRoute: "52c1731a283d7005facb8b5c46e85088ec5d3e57269fc386152ecee4d8bc3aaf",
        withoutRoute: "f6a9d65a4ddc6827c96ac96597f8c022febeb0f19078ce61fc2c148958419471",
      },
      {
        label: "foreign",
        template: foreign,
        withRoute: "9b8685eedefbd77b2367ff89c29db96adeb28a36dc2b97d16ac84c5b1c78e90c",
        withoutRoute: "fca4ea55d5ace740fe8bc83ed7ff762579125b433280ba0c4f06b88bf725f626",
      },
      {
        label: "legacy",
        template: legacy,
        withRoute: "1f0b918254a14b6791514f47902eca58f783e301c5a2335b7d766a950f760b92",
        withoutRoute: "a41f3a2dedd12ec2c7940789a85fb448626181dc2b658e6e7ad46f18d95c0f06",
      },
    ] as const;
    for (const { label, template, withRoute, withoutRoute } of digestCases) {
      const creatorChecks = developerSignInConditionCheckEntries(template);
      if (label === "legacy") {
        expect(creatorChecks, "legacy has no new sign-in creator identity fence").toHaveLength(0);
      } else {
        expect(creatorChecks, `${label} has exactly one broker creator identity fence`).toHaveLength(1);
        expect(creatorChecks[0]!.statement, `${label} checks only the exact sign-in table key namespace`).toEqual({
          Action: "dynamodb:ConditionCheckItem",
          Condition: {
            "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVELOPER#*"] },
            Null: { "dynamodb:LeadingKeys": "false" },
          },
          Effect: "Allow",
          Resource: { "Fn::GetAtt": [creatorChecks[0]!.tableId, "Arn"] },
        });
      }
      expect(template.Resources?.ProjectSetupExecutionReadRoute, `${label} has the approved setup read route`).toMatchObject({
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          AuthorizationType: "NONE",
          RouteKey: "GET /v1/internal/project-setups/{setupExecutionId}/execution",
        },
      });
      expect(parentRemainderDigest(template), `${label} parent remainder with the route`).toBe(withRoute);
      const priorRemainder = structuredClone(template);
      delete priorRemainder.Resources?.ProjectSetupExecutionReadRoute;
      expect(parentRemainderDigest(priorRemainder), `${label} parent remainder with only the approved route removed`).toBe(withoutRoute);
    }
  });

  it("conditions the isolated proof resources on the switch, exact account and region", () => {
    const approved = namedTemplate("agentxlivetest123");
    const proofResources = proofEntries(approved);
    const conditionId = Object.keys(approved.Conditions ?? {}).find((id) => id.includes("InstallTaskPersonProof"));
    expect(conditionId).toBeDefined();
    const condition = approved.Conditions?.[conditionId!];
    expect(JSON.stringify(condition)).toContain("TaskPersonProofEnabled");
    expect(JSON.stringify(condition)).toContain("944937319445");
    expect(JSON.stringify(condition)).toContain("us-east-1");
    expect(proofResources.map(([id]) => id)).toEqual(expect.arrayContaining([
      expect.stringContaining("Role"), expect.stringContaining("Function"), expect.stringContaining("Version"),
      expect.stringContaining("SecretReadPolicy"), expect.stringContaining("DispatcherPolicy"),
    ]));
    for (const [id, resource] of proofResources.filter(([, resource]) => resource.Type !== "AWS::CloudFormation::Condition")) {
      if (id.includes("Role") || id.includes("Function") || id.includes("Version") || id.includes("Policy")) {
        expect(resource.Condition).toBe(conditionId);
      }
    }
  });

  it("keeps the proof function and role free of unrelated runtime permissions", () => {
    const approved = namedTemplate("agentxlivetest123");
    const resources = approved.Resources ?? {};
    const [functionId, proofFunction] = Object.entries(resources).find(([id, resource]) =>
      id.includes("TaskPersonProofFunction") && resource.Type === "AWS::Lambda::Function",
    )!;
    const properties = proofFunction.Properties!;
    expect(properties).toMatchObject({ MemorySize: 512, Timeout: 7 });
    expect(properties).not.toHaveProperty("TracingConfig");
    expect(properties).not.toHaveProperty("VpcConfig");
    const variables = (properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(variables).toMatchObject({ AGENTX_ENV: "agentxlivetest123" });
    expect(Object.keys(variables).sort()).toEqual(["AGENTX_ENV", "SLACK_SECRET_ARN", "SLACK_TEAM_ID"]);
    const roleId = ((properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"])[0];
    expect(roleId).toContain("TaskPersonProofRole");
    const role = resources[roleId]!.Properties!;
    expect(role).not.toHaveProperty("ManagedPolicyArns");
    expect(JSON.stringify(role.AssumeRolePolicyDocument)).toContain("lambda.amazonaws.com");
    const rolePolicies = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::IAM::Policy"
      && JSON.stringify(resource.Properties?.Roles).includes(roleId));
    expect(rolePolicies).toHaveLength(1);
    const statements = (rolePolicies[0]![1].Properties!.PolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement;
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ Effect: "Allow", Action: ["secretsmanager:GetSecretValue"] });
    expect(JSON.stringify(statements[0]?.Resource)).toContain("SlackSecret");
    expect(JSON.stringify(proofFunction)).not.toMatch(/xray:|logs:|kms:|dynamodb:/);
    expect(functionId).toContain("TaskPersonProofFunction");
  });

  it("limits the dispatcher addition to projected Developer GetItem and the published proof version", () => {
    const approved = appControlPlane("agentxlivetest123");
    const resources = approved.Resources ?? {};
    const conditionId = Object.keys(approved.Conditions ?? {}).find((id) => id.includes("InstallTaskPersonProof"));
    expect(conditionId).toBeDefined();
    const policy = Object.entries(resources).find(([id, resource]) => id.includes("TaskPersonProofDispatcherPolicy") && resource.Type === "AWS::IAM::Policy")?.[1];
    expect(policy).toBeDefined();
    const statements = (policy!.Properties!.PolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement;
    expect(statements).toHaveLength(3);
    const getItem = statements.find((statement) => JSON.stringify(statement.Action).includes("dynamodb:GetItem"));
    const denyUnprojectedGetItem = statements.find((statement) => statement.Sid === "DenyGetItemUnlessSpecificAttributes");
    const invoke = statements.find((statement) => JSON.stringify(statement.Action).includes("lambda:InvokeFunction"));
    const dispatcherEntries = Object.entries(resources).filter(([id, resource]) => id.startsWith("Dispatcher") && resource.Type === "AWS::Lambda::Function");
    expect(dispatcherEntries).toHaveLength(1);
    const dispatcher = dispatcherEntries[0];
    const dispatcherRole = ((dispatcher![1].Properties!.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"])[0];
    expect(policy!.Properties!.Roles).toEqual([{ Ref: dispatcherRole }]);
    const tableId = Object.keys(resources).find((id) => id.includes("DeveloperSignInTable"));
    expect(tableId).toBeDefined();
    expect(getItem).toEqual({
      Effect: "Allow",
      Action: ["dynamodb:GetItem"],
      Resource: [{ "Fn::GetAtt": [tableId, "Arn"] }],
      Condition: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVELOPER#*"] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "developerId", "provider", "issuer", "subject", "slackUserId", "revoked", "displayName"] },
        Null: { "dynamodb:LeadingKeys": "false", "dynamodb:Attributes": "false" },
      },
    });
    const expectedProjectionDeny = {
      Sid: "DenyGetItemUnlessSpecificAttributes",
      Effect: "Deny",
      Action: "dynamodb:GetItem",
      Resource: { "Fn::GetAtt": [tableId, "Arn"] },
      Condition: { StringNotEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" } },
    };
    const assertExactProjectionDeny = (statement: Record<string, unknown>) => expect({
      ...statement,
      Action: normalizeSingleton(statement.Action),
      Resource: normalizeSingleton(statement.Resource),
    }).toEqual(expectedProjectionDeny);
    assertExactProjectionDeny(denyUnprojectedGetItem!);
    const extraNullCounterfactual = structuredClone(denyUnprojectedGetItem!);
    extraNullCounterfactual.Condition = {
      ...(extraNullCounterfactual.Condition as Record<string, unknown>),
      Null: { "dynamodb:Select": "false" },
    };
    expect(() => assertExactProjectionDeny(extraNullCounterfactual)).toThrow();
    const versionId = Object.keys(resources).find((id) => JSON.stringify(invoke?.Resource).includes(id));
    expect(invoke).toEqual({ Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: [{ Ref: versionId }] });
    expect(versionId).toContain("TaskPersonProofFunctionCurrentVersion");
    expect(resources[versionId!]?.Type).toBe("AWS::Lambda::Version");
    expect(JSON.stringify(invoke?.Resource)).not.toContain("$LATEST");
    const variables = dispatcher![1].Properties!.Environment as { Variables: Record<string, unknown> };
    expect(Object.keys(variables.Variables).filter((key) => ["TASK_PERSON_PROOF_FUNCTION_ARN", "SLACK_TEAM_ID", "DEVELOPER_SIGNIN_TABLE_NAME"].includes(key)).sort()).toEqual([
      "TASK_PERSON_PROOF_FUNCTION_ARN", "SLACK_TEAM_ID", "DEVELOPER_SIGNIN_TABLE_NAME",
    ].sort());
    expect(JSON.stringify(variables.Variables.TASK_PERSON_PROOF_FUNCTION_ARN)).toContain("TaskPersonProofFunctionCurrentVersion");
    for (const key of ["TASK_PERSON_PROOF_FUNCTION_ARN", "SLACK_TEAM_ID", "DEVELOPER_SIGNIN_TABLE_NAME"]) {
      expect(JSON.stringify(variables.Variables[key])).toContain(conditionId);
    }

    const functions = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::Lambda::Function");
    const roleFor = (resource: { Properties?: Record<string, unknown> }): string =>
      ((resource.Properties!.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"])[0];
    const purpose = (prefix: string) => {
      const matches = functions.filter(([id]) => id.startsWith(prefix));
      expect(matches, `expected exactly one ${prefix} Lambda`).toHaveLength(1);
      return matches[0]!;
    };
    const [brokerId, broker] = purpose("Broker");
    const [notifierId, notifier] = purpose("DeveloperTaskNotifier");
    const [signInId, signIn] = purpose("DeveloperSignIn");
    for (const [id, resource] of [[brokerId, broker], [notifierId, notifier], [signInId, signIn]] as const) {
      const envVars = (resource.Properties!.Environment as { Variables: Record<string, unknown> }).Variables;
      expect(envVars, `${id} must not receive proof-only runtime configuration`).not.toHaveProperty("TASK_PERSON_PROOF_FUNCTION_ARN");
    }
    const brokerVars = (broker.Properties!.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(brokerVars.SLACK_TEAM_ID).toEqual({ Ref: "SlackTeamId" });
    expect(brokerVars.DEVELOPER_SIGNIN_TABLE_NAME).toEqual({ Ref: tableId });
    const notifierVars = (notifier.Properties!.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(notifierVars.SLACK_TEAM_ID).toBeUndefined();
    expect(notifierVars.DEVELOPER_SIGNIN_TABLE_NAME).toBeUndefined();
    const signInVars = (signIn.Properties!.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(signInVars.SLACK_TEAM_ID).toEqual({ Ref: "SlackTeamId" });
    expect(signInVars.DEVELOPER_SIGNIN_TABLE_NAME).toEqual({ Ref: tableId });

    const proofPolicyRoles = policy!.Properties!.Roles as Array<{ Ref?: string }>;
    expect(proofPolicyRoles).toEqual([{ Ref: dispatcherRole }]);
    for (const [, otherFunction] of [[brokerId, broker], [notifierId, notifier], [signInId, signIn]] as const) {
      expect(proofPolicyRoles).not.toContainEqual({ Ref: roleFor(otherFunction) });
    }
  });
});
