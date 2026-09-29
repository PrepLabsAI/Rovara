// The two access-stack policy documents as pure functions: no CDK imports, so they can be unit
// tested with plain strings and printed as JSON (the access stack passes CDK tokens instead).
import { STACK_PARTS, environmentStackName } from "./environments.js";

export interface PolicyScope {
  env: string;
  partition: string;
  region: string;
  account: string;
  artifactBucketArn: string;
  pullThroughPrefix: string;
  cloudFormationRoleName: string;
  permissionsBoundaryArn?: string;
}

export interface PolicyStatementJson {
  Sid: string;
  Effect: "Allow" | "Deny";
  Action: string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}

/** Services the service role may use with any resource; IAM is handled separately and name-scoped. */
export const SERVICE_ROLE_SERVICES: readonly string[] = [
  "apigateway",
  "cloudformation",
  "cloudwatch",
  "cognito-idp",
  "dynamodb",
  "ec2",
  "ecr",
  "ecs",
  "kms",
  "lambda",
  "logs",
  "s3",
  "scheduler",
  "secretsmanager",
  "sns",
  "sqs",
  "ssm",
  "states",
];

/**
 * Services the default permission boundary allows by wildcard: the service role's own, plus what
 * the environment's roles call (Bedrock models, X-Ray, CodeBuild and API Gateway invoke). STS and
 * Service Quotas are not here: sts:* would let a bounded role assume any same-account role that
 * trusts the account, escaping the boundary, and servicequotas:* would let it read every quota in
 * the account instead of only the one EC2 vCPU quota prerequisites checks; the boundary names
 * sts:GetCallerIdentity and servicequotas:GetServiceQuota alone (see defaultBoundaryStatements).
 * Budgets is a wildcard here only as a ceiling (phase 15d2, FR-047). AWS's service reference for
 * Budgets confirms that ModifyBudget, ViewBudget, TagResource, UntagResource and
 * ListTagsForResource take the budget/${BudgetName} resource, so the service and operator roles'
 * own statements name the one monthly budget; the boundary only bounds them and grants nothing by
 * itself. The generated test in access-stack.test.ts keeps this list complete and free of unused
 * services.
 */
export const BOUNDARY_SERVICES: readonly string[] = [...SERVICE_ROLE_SERVICES, "bedrock", "budgets", "codebuild", "execute-api", "xray"];

/** Service-linked roles the service role may create while deploying. */
const SERVICE_LINKED_ROLE_SERVICES = ["ecs.amazonaws.com"];

/** Role management the service role needs on this environment's roles. */
const ROLE_ACTIONS = [
  "iam:CreateRole",
  "iam:DeleteRole",
  "iam:GetRole",
  "iam:UpdateRole",
  "iam:UpdateRoleDescription",
  "iam:TagRole",
  "iam:UntagRole",
  "iam:PutRolePolicy",
  "iam:DeleteRolePolicy",
  "iam:GetRolePolicy",
  "iam:AttachRolePolicy",
  "iam:DetachRolePolicy",
  "iam:UpdateAssumeRolePolicy",
  "iam:PutRolePermissionsBoundary",
  "iam:ListRolePolicies",
  "iam:ListAttachedRolePolicies",
];

/** Instance profile management the service role needs for the EC2 workers' instance profile. */
const INSTANCE_PROFILE_ACTIONS = [
  "iam:CreateInstanceProfile",
  "iam:DeleteInstanceProfile",
  "iam:GetInstanceProfile",
  "iam:AddRoleToInstanceProfile",
  "iam:RemoveRoleFromInstanceProfile",
  "iam:TagInstanceProfile",
  "iam:UntagInstanceProfile",
];

/**
 * What AWS::Budgets::Budget needs to create, update, delete and tag the monthly budget (phase
 * 15d2, FR-047). AWS Budgets has no separate Create/Update/Delete action: ModifyBudget covers all
 * three, and ViewBudget covers every read. No BudgetsAction permission: this is a plain budget with
 * notifications, not the separate AWS::Budgets::BudgetsAction resource.
 */
const BUDGET_ACTIONS = ["budgets:ModifyBudget", "budgets:ViewBudget", "budgets:TagResource", "budgets:UntagResource", "budgets:ListTagsForResource"];

/** The IAM path every role of an environment's stacks lives under, except the access stack's two roles. */
export function environmentRolePath(env: string): string {
  return `/agentx/${env}/`;
}

/** The name of the default permission boundary the access stack creates when the company gives none. */
export function defaultBoundaryName(env: string): string {
  return `agentx-${env}-boundary`;
}

/**
 * The default boundary's ARN. Deterministic (fixed name and path), so every other environment stack
 * can name it without a cross-stack import.
 */
export function defaultBoundaryArn(scope: Pick<PolicyScope, "env" | "partition" | "account">): string {
  return `arn:${scope.partition}:iam::${scope.account}:policy${environmentRolePath(scope.env)}${defaultBoundaryName(scope.env)}`;
}

/**
 * Role ARNs this environment's stacks may create and manage: every role under the environment's
 * IAM path. A path, not a name prefix, because CloudFormation truncates generated role names (a
 * long environment name loses the agentx-<env>- prefix) and agentx-prod-* would also match the
 * roles of an environment named prod-eu.
 */
function environmentRoles(scope: Pick<PolicyScope, "env" | "partition" | "account">): string {
  return `arn:${scope.partition}:iam::${scope.account}:role${environmentRolePath(scope.env)}*`;
}

/** Instance profiles under the environment's IAM path, like its roles. */
function environmentInstanceProfiles(scope: Pick<PolicyScope, "env" | "partition" | "account">): string {
  return `arn:${scope.partition}:iam::${scope.account}:instance-profile${environmentRolePath(scope.env)}*`;
}

/**
 * The inline policy of the role CloudFormation assumes to deploy this environment's stacks. The
 * boundary Deny statements name `permissionsBoundaryArn` when given, else the default boundary.
 */
export function serviceRoleStatements(scope: PolicyScope): PolicyStatementJson[] {
  const roles = environmentRoles(scope);
  const boundary = scope.permissionsBoundaryArn ?? defaultBoundaryArn(scope);
  return [
    { Sid: "Services", Effect: "Allow", Action: SERVICE_ROLE_SERVICES.map((s) => `${s}:*`), Resource: "*" },
    { Sid: "IamRoles", Effect: "Allow", Action: [...ROLE_ACTIONS], Resource: roles },
    { Sid: "IamInstanceProfiles", Effect: "Allow", Action: [...INSTANCE_PROFILE_ACTIONS], Resource: environmentInstanceProfiles(scope) },
    {
      // Only actions that carry the iam:PermissionsBoundary key: CreateRole and
      // PutRolePermissionsBoundary as the boundary being set, the role policy actions as the
      // role's current boundary. For any other action the key is absent, StringNotEquals
      // evaluates true, and the Deny would block it outright.
      Sid: "IamRequireBoundary",
      Effect: "Deny",
      Action: [
        "iam:CreateRole",
        "iam:PutRolePermissionsBoundary",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
      ],
      Resource: roles,
      Condition: { StringNotEquals: { "iam:PermissionsBoundary": boundary } },
    },
    { Sid: "IamKeepBoundary", Effect: "Deny", Action: ["iam:DeleteRolePermissionsBoundary"], Resource: roles },
    { Sid: "PassRoles", Effect: "Allow", Action: ["iam:PassRole"], Resource: roles },
    {
      Sid: "ServiceLinkedRoles",
      Effect: "Allow",
      Action: ["iam:CreateServiceLinkedRole"],
      Resource: `arn:${scope.partition}:iam::${scope.account}:role/aws-service-role/*`,
      Condition: { StringLike: { "iam:AWSServiceName": [...SERVICE_LINKED_ROLE_SERVICES] } },
    },
    // FR-047: the control-plane stack's monthly budget, and only that one, never budgets:* on *.
    { Sid: "Budget", Effect: "Allow", Action: [...BUDGET_ACTIONS], Resource: `arn:${scope.partition}:budgets::${scope.account}:budget/agentx-${scope.env}-monthly` },
  ];
}

/**
 * The default permission boundary: the most any AgentX role (the service and operator roles
 * included) can ever do, whatever its own policy says. It allows the services AgentX uses, role
 * management only on this environment's roles, and nothing for users, groups or managed policies.
 * The Deny statements hold even if a later change widens an Allow.
 */
export function defaultBoundaryStatements(scope: Pick<PolicyScope, "env" | "partition" | "account" | "cloudFormationRoleName">): PolicyStatementJson[] {
  const { partition, account } = scope;
  const roles = environmentRoles(scope);
  return [
    { Sid: "Services", Effect: "Allow", Action: BOUNDARY_SERVICES.map((s) => `${s}:*`), Resource: "*" },
    // The operator's identity check; the only STS action any AgentX role uses.
    { Sid: "CallerIdentity", Effect: "Allow", Action: ["sts:GetCallerIdentity"], Resource: "*" },
    // The operator's EC2 quota read (prerequisites on a resume); named like CallerIdentity above,
    // not scoped further, since a scoped ARN in the identity policy already limits it to one quota.
    { Sid: "Quotas", Effect: "Allow", Action: ["servicequotas:GetServiceQuota"], Resource: "*" },
    { Sid: "IamRoles", Effect: "Allow", Action: [...ROLE_ACTIONS], Resource: roles },
    { Sid: "IamInstanceProfiles", Effect: "Allow", Action: [...INSTANCE_PROFILE_ACTIONS], Resource: environmentInstanceProfiles(scope) },
    {
      // The operator passes the service role (root path) to CloudFormation; CloudFormation passes
      // the environment's roles to Lambda, ECS, EC2 and the rest.
      Sid: "PassRoles",
      Effect: "Allow",
      Action: ["iam:PassRole"],
      Resource: [roles, `arn:${partition}:iam::${account}:role/${scope.cloudFormationRoleName}`],
    },
    {
      Sid: "ServiceLinkedRoles",
      Effect: "Allow",
      Action: ["iam:CreateServiceLinkedRole"],
      Resource: `arn:${partition}:iam::${account}:role/aws-service-role/*`,
      Condition: { StringLike: { "iam:AWSServiceName": [...SERVICE_LINKED_ROLE_SERVICES] } },
    },
    { Sid: "DenyAccountChanges", Effect: "Deny", Action: ["organizations:*", "account:*"], Resource: "*" },
    { Sid: "DenyUsersAndGroups", Effect: "Deny", Action: ["iam:*User*", "iam:*Group*"], Resource: "*" },
    {
      Sid: "DenyPolicyManagement",
      Effect: "Deny",
      Action: ["iam:CreatePolicy*", "iam:*PolicyVersion*", "iam:DeletePolicy", "iam:SetDefaultPolicyVersion"],
      Resource: "*",
    },
    { Sid: "DenyBoundaryChanges", Effect: "Deny", Action: ["iam:*Policy*"], Resource: defaultBoundaryArn(scope) },
  ];
}

/** The inline policy of the role an operator assumes to run `agentx` against this environment. */
export function operatorRoleStatements(scope: PolicyScope): PolicyStatementJson[] {
  const { partition, region, account, env } = scope;
  // Exact stack names, never a wildcard prefix: agentx-<env>-* would also match another
  // environment's stacks (agentx-prod-* matches prod-eu) and the access stack itself.
  const stackArn = (part: (typeof STACK_PARTS)[number]) =>
    `arn:${partition}:cloudformation:${region}:${account}:stack/${environmentStackName(env, part)}/*`;
  // The operator may read the access stack but never change it: it holds the roles, so changing it
  // is the platform team's job.
  const deployedParts = STACK_PARTS.filter((part) => part !== "access");
  return [
    {
      Sid: "Stacks",
      Effect: "Allow",
      Action: [
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResources",
        "cloudformation:GetTemplate",
        "cloudformation:GetTemplateSummary",
        "cloudformation:ListStackResources",
      ],
      Resource: STACK_PARTS.map(stackArn),
    },
    {
      Sid: "ChangeSets",
      Effect: "Allow",
      Action: [
        "cloudformation:CreateChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet",
        "cloudformation:ListChangeSets",
        // The templates engine turns termination protection on right after a new stack's first deploy.
        "cloudformation:UpdateTerminationProtection",
      ],
      Resource: deployedParts.map(stackArn),
    },
    // ListStacks and ValidateTemplate support no resource-level scoping; both are read-only.
    { Sid: "StackList", Effect: "Allow", Action: ["cloudformation:ListStacks"], Resource: "*" },
    { Sid: "Templates", Effect: "Allow", Action: ["cloudformation:ValidateTemplate"], Resource: "*" },
    {
      Sid: "PassServiceRole",
      Effect: "Allow",
      Action: ["iam:PassRole"],
      Resource: `arn:${partition}:iam::${account}:role/${scope.cloudFormationRoleName}`,
      Condition: { StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" } },
    },
    {
      Sid: "Artifacts",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
      Resource: [scope.artifactBucketArn, `${scope.artifactBucketArn}/*`],
    },
    {
      Sid: "Settings",
      Effect: "Allow",
      Action: ["ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameter", "ssm:GetParametersByPath"],
      Resource: [
        `arn:${partition}:ssm:${region}:${account}:parameter/agentx/${env}`,
        `arn:${partition}:ssm:${region}:${account}:parameter/agentx/${env}/*`,
      ],
    },
    {
      Sid: "Secrets",
      Effect: "Allow",
      Action: [
        "secretsmanager:CreateSecret",
        "secretsmanager:PutSecretValue",
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetSecretValue",
        "secretsmanager:TagResource",
      ],
      Resource: `arn:${partition}:secretsmanager:${region}:${account}:secret:agentx/${env}/*`,
    },
    {
      Sid: "Images",
      Effect: "Allow",
      Action: ["ecr:DescribeRepositories", "ecr:DescribeImages"],
      Resource: `arn:${partition}:ecr:${region}:${account}:repository/${scope.pullThroughPrefix}/*`,
    },
    {
      Sid: "ModelChecks",
      Effect: "Allow",
      // The Converse API is authorized by bedrock:InvokeModel; there is no separate action.
      Action: ["bedrock:InvokeModel"],
      Resource: [
        `arn:${partition}:bedrock:*::foundation-model/*`,
        `arn:${partition}:bedrock:${region}:${account}:inference-profile/*`,
      ],
    },
    {
      // FR-018 step 7: the admin user. The identity stack's user pool carries agentx:env (15a's
      // Tags.of(app)); an exact tag value cannot match another environment. AdminListGroupsForUser
      // tells whether an existing user is already an administrator before init promotes it.
      Sid: "AdminUser",
      Effect: "Allow",
      Action: ["cognito-idp:AdminGetUser", "cognito-idp:AdminCreateUser", "cognito-idp:AdminAddUserToGroup", "cognito-idp:AdminListGroupsForUser"],
      Resource: `arn:${partition}:cognito-idp:${region}:${account}:userpool/*`,
      Condition: { StringEquals: { "aws:ResourceTag/agentx:env": env } },
    },
    {
      // FR-045: read the alert topic. No Publish: the test alarm goes through CloudWatch.
      Sid: "Alerts",
      Effect: "Allow",
      Action: ["sns:ListSubscriptionsByTopic"],
      Resource: `arn:${partition}:sns:${region}:${account}:agentx-${env}-alerts`,
    },
    {
      // FR-045: subscribe the alert address, but only email (the operator) or https (the alert
      // webhook): sqs, lambda and sms would let a compromised operator session re-route alerts
      // somewhere the platform team can't see. A separate statement because sns:Protocol is a
      // Subscribe-only context key; on Alerts above it would be absent and the condition would
      // deny those two read actions outright.
      Sid: "AlertsSubscribe",
      Effect: "Allow",
      Action: ["sns:Subscribe"],
      Resource: `arn:${partition}:sns:${region}:${account}:agentx-${env}-alerts`,
      Condition: { StringEquals: { "sns:Protocol": ["email", "https"] } },
    },
    {
      // FR-046: agentx alerts test flips this one alarm, named exactly.
      Sid: "TestAlarm",
      Effect: "Allow",
      Action: ["cloudwatch:SetAlarmState", "cloudwatch:DescribeAlarmHistory"],
      Resource: `arn:${partition}:cloudwatch:${region}:${account}:alarm:agentx-${env}-TestAlarm`,
    },
    // FR-047: the alerts step checks the budget CloudFormation made; it never changes it.
    { Sid: "Budget", Effect: "Allow", Action: ["budgets:ViewBudget"], Resource: `arn:${partition}:budgets::${account}:budget/agentx-${env}-monthly` },
    // prerequisites.ts:318 checks only the EC2 standard vCPU quota (ServiceCode "ec2", QuotaCode
    // "L-1216C47A") on an operator resume; the servicequotas "quota" resource type's ARN format is
    // arn:partition:servicequotas:region:account:serviceCode/quotaCode, so this scopes to exactly
    // that one quota rather than every quota in the account.
    {
      Sid: "Quotas",
      Effect: "Allow",
      Action: ["servicequotas:GetServiceQuota"],
      Resource: `arn:${partition}:servicequotas:${region}:${account}:ec2/L-1216C47A`,
    },
    { Sid: "Identity", Effect: "Allow", Action: ["sts:GetCallerIdentity"], Resource: "*" },
    {
      Sid: "Logs",
      Effect: "Allow",
      Action: ["logs:FilterLogEvents", "logs:StartQuery"],
      // CloudFormation names the stacks' log groups <stack name>-<logical id>-<suffix>; each stack's
      // exact name is the prefix, so no other environment's log groups match.
      Resource: deployedParts.map((part) => `arn:${partition}:logs:${region}:${account}:log-group:${environmentStackName(env, part)}-*`),
    },
    // GetQueryResults takes a query id and supports no resource type; DescribeLogGroups is a list
    // call that is authorized against every log group, so neither can be scoped by log group name.
    { Sid: "LogQueries", Effect: "Allow", Action: ["logs:GetQueryResults", "logs:DescribeLogGroups"], Resource: "*" },
  ];
}
