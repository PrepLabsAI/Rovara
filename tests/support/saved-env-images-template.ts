/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- a synthesized CloudFormation template is untyped JSON: the walks and the mutants below index into it freely */
// L4-SE6 (owner-approved 2026-11-18): the saved environment images' registry side. A named control plane gets, from infra/lib/saved-env-images.ts: three roles (push, pull, manage) that trust only the broker
// role, each with one policy; ONE repository creation template; the five output keys of briefs/lead4/L4-SE-OUTPUT-CONTRACT.md; and four broker variables. The access stack's deploy role and default boundary get
// the statements of contracts access-policies.ts (AssumeSessionRoles, IamFixedNameRolesNotYetCreated, EcrTemplateServiceLinkedRole).
//
// Each digest or snapshot test that pins the rest of the control-plane or access template asserts these additions exactly (here), then takes them out in place, so the pins they hold stay the ones recorded
// before this change: removing exactly these additions gives back the old template (rule D). The same additions are asserted in full, with the widening mutants, in
// tests/contract/saved-env-images-infrastructure.test.ts. A template with none of them (the legacy deployment, which gets none of it) is returned as it is.
import { expect } from "vitest";
import {
  SAVED_ENV_KEEP_DEFAULT, SAVED_ENV_MANAGE_ACTIONS, SAVED_ENV_PULL_ACTIONS, SAVED_ENV_PUSH_ACTIONS,
  defaultBoundaryStatements, savedEnvLifecyclePolicy, savedEnvManageRoleName, savedEnvPullRoleName, savedEnvPushRoleName, savedEnvRepositoryPolicy, serviceRoleStatements,
} from "@agentx/contracts";

type Resource = { Type: string; Properties: Record<string, any>; DependsOn?: unknown };
type TemplateJson = { Resources: Record<string, Resource>; Outputs?: Record<string, { Value: unknown; Description?: string }> };
type Statement = { Sid?: string; [key: string]: unknown };

export const SAVED_ENV_ROLE_KINDS = ["Push", "Pull", "Manage"] as const;
export type SavedEnvRoleKind = (typeof SAVED_ENV_ROLE_KINDS)[number];
const ROLE_ID = (kind: SavedEnvRoleKind) => new RegExp(`^SavedEnvImages${kind}Role[0-9A-F]{8}$`, "u");
const POLICY_ID = (kind: SavedEnvRoleKind) => new RegExp(`^SavedEnvImages${kind}RoleDefaultPolicy[0-9A-F]{8}$`, "u");
const TEMPLATE_ID = /^SavedEnvImagesCreationTemplate[0-9A-F]{8}$/u;
const BROKER_FUNCTION = /^Broker[0-9A-F]{8}$/u;
const BROKER_ROLE = /^BrokerServiceRole[0-9A-F]{8}$/u;

export const SAVED_ENV_OUTPUT_KEYS = ["SavedEnvImgPushRoleArn", "SavedEnvImgPullRoleArn", "SavedEnvImgManageRoleArn", "SavedEnvRepoPrefix", "SavedEnvRegistryReady"] as const;
export const SAVED_ENV_BROKER_VARIABLES = ["ROVARA_SAVED_ENV_PUSH_ROLE_ARN", "ROVARA_SAVED_ENV_PULL_ROLE_ARN", "ROVARA_SAVED_ENV_MANAGE_ROLE_ARN", "ROVARA_SAVED_ENV_REPO_PREFIX"] as const;

/** The actions each role's own policy holds: the contracts' lists, the push role without the two scan actions (scanning is off in v1). */
export const ROLE_ACTIONS: Record<SavedEnvRoleKind, readonly string[]> = {
  Push: SAVED_ENV_PUSH_ACTIONS.filter((action) => action !== "ecr:StartImageScan" && action !== "ecr:DescribeImageScanFindings"),
  Pull: SAVED_ENV_PULL_ACTIONS,
  Manage: SAVED_ENV_MANAGE_ACTIONS,
};

export const roleNameOf = (kind: SavedEnvRoleKind, env: string): string => ({ Push: savedEnvPushRoleName, Pull: savedEnvPullRoleName, Manage: savedEnvManageRoleName })[kind](env);

/** `arn:<partition>:ecr:<region>:<account>:repository/rovara-env/<env>/*` as the template writes it. */
export const repositoriesResource = (env: string): unknown => ({
  "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":ecr:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, `:repository/rovara-env/${env}/*`]],
});

/** The statements of one role's policy, as the template holds them. */
export function roleStatements(kind: SavedEnvRoleKind, env: string): unknown[] {
  return [
    ...(kind === "Manage" ? [] : [{ Action: "ecr:GetAuthorizationToken", Effect: "Allow", Resource: "*", Sid: "RegistryToken" }]),
    { Action: [...ROLE_ACTIONS[kind]], Effect: "Allow", Resource: repositoriesResource(env), Sid: "ThisEnvironmentsImages" },
  ];
}

/** The trust of every role: the broker role, and only it. */
export function brokerOnlyTrust(brokerRoleId: string): unknown {
  return { Statement: [{ Action: "sts:AssumeRole", Effect: "Allow", Principal: { AWS: { "Fn::GetAtt": [brokerRoleId, "Arn"] } } }], Version: "2012-10-17" };
}

export function idsOf(template: TemplateJson): { roles: Record<SavedEnvRoleKind, string>; policies: Record<SavedEnvRoleKind, string>; creationTemplate: string; brokerFunction: string; brokerRole: string } {
  const ids = Object.keys(template.Resources);
  const one = (pattern: RegExp, type: string): string => {
    const found = ids.filter((id) => pattern.test(id) && template.Resources[id]!.Type === type);
    expect(found, `${String(pattern)} (${type})`).toHaveLength(1);
    return found[0]!;
  };
  return {
    roles: { Push: one(ROLE_ID("Push"), "AWS::IAM::Role"), Pull: one(ROLE_ID("Pull"), "AWS::IAM::Role"), Manage: one(ROLE_ID("Manage"), "AWS::IAM::Role") },
    policies: { Push: one(POLICY_ID("Push"), "AWS::IAM::Policy"), Pull: one(POLICY_ID("Pull"), "AWS::IAM::Policy"), Manage: one(POLICY_ID("Manage"), "AWS::IAM::Policy") },
    creationTemplate: one(TEMPLATE_ID, "AWS::ECR::RepositoryCreationTemplate"),
    brokerFunction: one(BROKER_FUNCTION, "AWS::Lambda::Function"),
    brokerRole: one(BROKER_ROLE, "AWS::IAM::Role"),
  };
}

/** The creation template's repository policy, resolved: the role ARN tokens put back as `<push>`, `<pull>`, `<manage>`. */
export function resolvedRepositoryPolicy(value: unknown, ids: ReturnType<typeof idsOf>): unknown {
  const join = (value as { "Fn::Join"?: [string, unknown[]] })["Fn::Join"];
  expect(join?.[0]).toBe("");
  const names: Record<string, string> = { [ids.roles.Push]: "<push>", [ids.roles.Pull]: "<pull>", [ids.roles.Manage]: "<manage>" };
  const text = join![1].map((part) => {
    if (typeof part === "string") return part;
    const attribute = (part as { "Fn::GetAtt"?: [string, string] })["Fn::GetAtt"];
    expect(attribute?.[1]).toBe("Arn");
    expect(names[attribute![0]], "a role of this construct").toBeDefined();
    return names[attribute![0]]!;
  }).join("");
  return JSON.parse(text);
}

export const expectedRepositoryPolicy = (): unknown => savedEnvRepositoryPolicy({ pushRoleArn: "<push>", pullRoleArn: "<pull>", manageRoleArn: "<manage>" });

/** The creation template's properties, exactly (RepositoryPolicy is compared resolved). No KMS, no custom role, no tags. */
export function expectedTemplateProperties(env: string): Record<string, unknown> {
  return {
    AppliedFor: ["CREATE_ON_PUSH"],
    Description: expect.any(String),
    EncryptionConfiguration: { EncryptionType: "AES256" },
    ImageTagMutability: "IMMUTABLE",
    LifecyclePolicy: JSON.stringify(savedEnvLifecyclePolicy(SAVED_ENV_KEEP_DEFAULT)),
    Prefix: `rovara-env/${env}`,
  };
}

export function expectedOutputs(ids: ReturnType<typeof idsOf>, env: string): Record<string, unknown> {
  return {
    SavedEnvImgPushRoleArn: { "Fn::GetAtt": [ids.roles.Push, "Arn"] },
    SavedEnvImgPullRoleArn: { "Fn::GetAtt": [ids.roles.Pull, "Arn"] },
    SavedEnvImgManageRoleArn: { "Fn::GetAtt": [ids.roles.Manage, "Arn"] },
    SavedEnvRepoPrefix: `rovara-env/${env}`,
    SavedEnvRegistryReady: "1",
  };
}

export function expectedBrokerVariables(ids: ReturnType<typeof idsOf>, env: string): Record<string, unknown> {
  return {
    ROVARA_SAVED_ENV_PUSH_ROLE_ARN: { "Fn::GetAtt": [ids.roles.Push, "Arn"] },
    ROVARA_SAVED_ENV_PULL_ROLE_ARN: { "Fn::GetAtt": [ids.roles.Pull, "Arn"] },
    ROVARA_SAVED_ENV_MANAGE_ROLE_ARN: { "Fn::GetAtt": [ids.roles.Manage, "Arn"] },
    ROVARA_SAVED_ENV_REPO_PREFIX: `rovara-env/${env}`,
  };
}

/** Control plane: asserts the additions exactly and takes them out (in place). A template without them is returned as it is. */
export function withoutSavedEnvImages<T>(input: T, env: string): T {
  const template = input as unknown as TemplateJson;
  if (!Object.keys(template.Resources).some((id) => id.startsWith("SavedEnvImages"))) return input;
  const ids = idsOf(template);
  const resources = template.Resources;
  for (const kind of SAVED_ENV_ROLE_KINDS) {
    const role = resources[ids.roles[kind]]!;
    expect(role.Properties.AssumeRolePolicyDocument, `${kind} trust`).toEqual(brokerOnlyTrust(ids.brokerRole));
    expect(role.Properties.RoleName).toBe(roleNameOf(kind, env));
    expect(role.Properties.Path).toBe(`/agentx/${env}/`);
    expect(role.Properties.MaxSessionDuration).toBe(3600);
    expect(Object.keys(role.Properties).sort()).toEqual(["AssumeRolePolicyDocument", "Description", "MaxSessionDuration", "Path", "PermissionsBoundary", "RoleName", "Tags"]);
    const policy = resources[ids.policies[kind]]!;
    expect(policy.Properties.PolicyDocument, `${kind} policy`).toEqual({ Statement: roleStatements(kind, env), Version: "2012-10-17" });
    expect(policy.Properties.Roles).toEqual([{ Ref: ids.roles[kind] }]);
    delete resources[ids.policies[kind]];
    delete resources[ids.roles[kind]];
  }
  const creation = resources[ids.creationTemplate]!;
  const { RepositoryPolicy, ...rest } = creation.Properties;
  expect(rest).toEqual(expectedTemplateProperties(env));
  expect(resolvedRepositoryPolicy(RepositoryPolicy, ids)).toEqual(expectedRepositoryPolicy());
  delete resources[ids.creationTemplate];
  // Outputs and the broker's variables.
  for (const [key, value] of Object.entries(expectedOutputs(ids, env))) {
    expect(template.Outputs?.[key]?.Value, `output ${key}`).toEqual(value);
    delete template.Outputs![key];
  }
  const variables = (resources[ids.brokerFunction]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  for (const [name, value] of Object.entries(expectedBrokerVariables(ids, env))) {
    expect(variables[name], `broker variable ${name}`).toEqual(value);
    delete variables[name];
  }
  // Nothing is left that depends on, or names, a removed resource.
  expect(JSON.stringify(template)).not.toContain("SavedEnvImages");
  return input;
}

const SAVED_ENV_ACCESS_SIDS = ["AssumeSessionRoles", "IamFixedNameRolesNotYetCreated", "EcrTemplateServiceLinkedRole"];

/** A contracts statement with its partition and account as the access template writes them (Fn::Join over Ref AWS::Partition and Ref AWS::AccountId). */
function inTemplateForm(value: unknown): unknown {
  if (typeof value === "string") {
    if (!value.includes("@P@") && !value.includes("@A@")) return value;
    const parts = value.split(/(@P@|@A@)/u).filter((part) => part !== "").map((part) => (part === "@P@" ? { Ref: "AWS::Partition" } : part === "@A@" ? { Ref: "AWS::AccountId" } : part));
    return { "Fn::Join": ["", parts] };
  }
  if (Array.isArray(value)) return value.map(inTemplateForm);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, inTemplateForm(inner)]));
  return value;
}

/** The statements contracts access-policies.ts adds for saved environments, as the access template holds them: in the default boundary, and in the deploy role. */
export function expectedAccessStatements(env: string): { boundary: Statement[]; deploy: Statement[] } {
  const scope = { env, partition: "@P@", region: "@R@", account: "@A@", cloudFormationRoleName: `agentx-${env}-cloudformation`, artifactBucketArn: "arn:@P@:s3:::bucket", pullThroughPrefix: `agentx-${env}` };
  const pick = (statements: Statement[]) => statements.filter((statement) => SAVED_ENV_ACCESS_SIDS.includes(statement.Sid ?? "")).map((statement) => inTemplateForm(statement) as Statement);
  return { boundary: pick(defaultBoundaryStatements(scope) as unknown as Statement[]), deploy: pick(serviceRoleStatements(scope) as unknown as Statement[]) };
}

/** Access stack: the three statements in the default boundary and the two in the deploy role (exact, from contracts' builders), taken out in place. */
export function withoutSavedEnvAccess<T>(input: T, env: string): T {
  const template = input as unknown as TemplateJson;
  const expected = expectedAccessStatements(env);
  const documents: Array<{ kind: "boundary" | "deploy"; document: { Statement: Statement[] } }> = [];
  for (const resource of Object.values(template.Resources)) {
    if (resource.Type === "AWS::IAM::ManagedPolicy") documents.push({ kind: "boundary", document: resource.Properties.PolicyDocument });
    if (resource.Type === "AWS::IAM::Role") for (const policy of (resource.Properties.Policies as Array<{ PolicyDocument: { Statement: Statement[] } }> | undefined) ?? []) documents.push({ kind: "deploy", document: policy.PolicyDocument });
  }
  let removed = 0;
  for (const { kind, document } of documents) {
    const found = document.Statement.filter((statement) => SAVED_ENV_ACCESS_SIDS.includes(statement.Sid ?? ""));
    if (found.length === 0) continue;
    expect(found, `${env} ${kind}`).toEqual(expected[kind]);
    document.Statement = document.Statement.filter((statement) => !SAVED_ENV_ACCESS_SIDS.includes(statement.Sid ?? ""));
    removed += 1;
  }
  expect(removed, "the boundary and the deploy role").toBe(2);
  return input;
}
