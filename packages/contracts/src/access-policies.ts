// The two access-stack policy documents as pure functions: no CDK imports, so they can be unit
// tested with plain strings and printed as JSON (the access stack passes CDK tokens instead).
import { STACK_PARTS, environmentStackName } from "./environments.js";
import { releasePipelineDenyStatements } from "./release-pipeline-names.js";
import { savedEnvManageRoleName, savedEnvPullRoleName, savedEnvPushRoleName } from "./saved-env-image.js";
import { slackTokenReaderBoundaryStatement, slackTokenReaderLookupResource } from "./slack-company-tokens.js";

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
  Resource?: string | string[];
  NotResource?: string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}

/** Only this environment's uniquely named ECS deployment-failure rule. */
function ecsFailureRuleArn(scope: Pick<PolicyScope, "env" | "partition" | "region" | "account">): string {
  return `arn:${scope.partition}:events:${scope.region}:${scope.account}:rule/agentx-${scope.env}-*-service-failures`;
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
 * the account instead of only the two EC2 quotas prerequisites checks; the boundary names
 * sts:GetCallerIdentity and servicequotas:GetServiceQuota alone (see defaultBoundaryStatements).
 * Budgets is a wildcard here only as a ceiling (phase 15d2, FR-047). AWS's service reference for
 * Budgets confirms that ModifyBudget, ViewBudget, TagResource, UntagResource and
 * ListTagsForResource take the budget/${BudgetName} resource, so the service and operator roles'
 * own statements name the one monthly budget; the boundary only bounds them and grants nothing by
 * itself. The generated test in access-stack.test.ts keeps this list complete and free of unused
 * services.
 */
export const BOUNDARY_SERVICES: readonly string[] = [...SERVICE_ROLE_SERVICES, "bedrock", "budgets", "codebuild", "execute-api", "xray"];

/**
 * Service-linked roles the service role may create while deploying. route53resolver: associating a named environment's DNS firewall query logging config makes Resolver
 * create AWSServiceRoleForRoute53Resolver for the caller on first use in an account.
 */
const SERVICE_LINKED_ROLE_SERVICES = ["ecs.amazonaws.com", "route53resolver.amazonaws.com"];

/**
 * A named environment's DNS firewall (infra/lib/agent-dns-firewall.ts): its domain lists, rule group, VPC association and query logging config. Not a wildcard service: every
 * Resolver action is limited to this account and region, and the list actions (which take no resource) are the only ones on `*`. The query log destination is a CloudWatch Logs
 * group, so CloudFormation also calls the logs delivery actions, which "logs" already covers. The same two statements are in the default boundary, which bounds the service role.
 */
function dnsFirewallStatements(scope: Pick<PolicyScope, "partition" | "region" | "account">): PolicyStatementJson[] {
  return [
    { Sid: "DnsFirewall", Effect: "Allow", Action: ["route53resolver:*"], Resource: `arn:${scope.partition}:route53resolver:${scope.region}:${scope.account}:*` },
    { Sid: "DnsFirewallList", Effect: "Allow", Action: ["route53resolver:List*"], Resource: "*" },
  ];
}

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

/** The role actions that set or change what a role may do: allowed only for a role that carries the environment's boundary (the default boundary's IamRolesBounded; serviceRoleStatements' IamRequireBoundary). */
const BOUNDARY_RULED_ROLE_ACTIONS = ["iam:CreateRole", "iam:PutRolePermissionsBoundary", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy"];

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
 * TWO-BOUNDARIES (owner's choice A): the environment has two default boundaries. The RUNTIME boundary (`defaultBoundaryName`, unchanged name and ARN) caps every role a merged template
 * creates under /agentx/<env>/ and holds only what such roles use (a census of every role policy of every stack: `iam:PassRole`, `ses:SendEmail` and the services, plus the
 * trust-granted sts:AssumeRole of the broker and of the Slack service). The DEPLOY boundary caps ONLY the CloudFormation service role and the operator role (the access stack's
 * two roles) and holds what only they need (IAM role and instance-profile management, service-linked roles, DNS firewall, quotas, the fixed-name lookups) with the rules that stop those
 * roles escalating: new roles must carry the RUNTIME boundary, CloudFormation writes only through the environment's CloudFormation role and only on the environment's stacks, no
 * boundary removal and no edit of either boundary.
 */
export function deployBoundaryName(env: string): string {
  return `agentx-${env}-deploy-boundary`;
}

/** The deploy boundary's ARN, deterministic like the runtime one. */
export function deployBoundaryArn(scope: Pick<PolicyScope, "env" | "partition" | "account">): string {
  return `arn:${scope.partition}:iam::${scope.account}:policy${environmentRolePath(scope.env)}${deployBoundaryName(scope.env)}`;
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
 * Saved environment images (L4-SE6, owner-approved 2026-11-18): the broker assumes three fixed-name roles (push, pull, manage), each with a session policy that names ONE repository
 * (contracts saved-env-image.ts). Three statements carry it, all for named environments:
 *   - `AssumeSessionRoles` (the boundary only): `sts:AssumeRole` on exactly those three role ARNs, and only for the broker's role (`aws:PrincipalArn`). The boundary has no other
 *     `sts:AssumeRole`: `sts:*` would let a bounded role assume any same-account role that trusts the account. The three roles' trust policies name the broker role too, so the broker's own
 *     inline policy needs nothing (it is at its size pin). The company-secrets role (lane T6) has the same gap and is NOT added here (not approved in this change): when it is, its role ARN
 *     goes into `brokerAssumableRoleArns`, with `sts:TagSession`, so the two share ONE statement.
 *   - `IamFixedNameRolesNotYetCreated` (deploy role and boundary): CloudFormation looks a fixed-name role up by its PATH-LESS ARN (iam:GetRole) before it creates it, and cleans it up by that ARN when
 *     a create rolls back; IAM, which cannot know the path of a role that does not exist yet, checks `role/<name>`. Lookups and deletes only: no create or change action, so a role at the root path
 *     can never be made through it (the real role is created under the environment path, where `IamRoles` applies).
 *   - `EcrTemplateServiceLinkedRole` (deploy role and boundary): the first repository creation template in an account makes ECR create AWSServiceRoleForECRTemplate, and the caller must hold
 *     iam:CreateServiceLinkedRole (https://docs.aws.amazon.com/AmazonECR/latest/userguide/slr-rct.html). Named exactly, apart from `SERVICE_LINKED_ROLE_SERVICES`. The deploy role is itself
 *     bounded (the access stack's aspect), so the boundary carries it too.
 */
const FIXED_NAME_ROLE_LOOKUP_ACTIONS = [
  "iam:GetRole",
  "iam:GetRolePolicy",
  "iam:ListRolePolicies",
  "iam:ListAttachedRolePolicies",
  "iam:DeleteRolePolicy",
  "iam:DetachRolePolicy",
  "iam:DeleteRole",
];
const ECR_TEMPLATE_SERVICE = "ecr.amazonaws.com";

/** The broker's role, as the three session roles' trust and the boundary's condition name it: `agentx-<env>-broker-role` under the environment's path. */
export function brokerRoleArn(scope: Pick<PolicyScope, "env" | "partition" | "account">): string {
  return `arn:${scope.partition}:iam::${scope.account}:role${environmentRolePath(scope.env)}agentx-${scope.env}-broker-role`;
}

/** The three roles the broker assumes for a saved environment image (push, pull, manage), by their exact ARNs under the environment's path. */
export function savedEnvSessionRoleArns(scope: Pick<PolicyScope, "env" | "partition" | "account">): string[] {
  return [savedEnvPushRoleName(scope.env), savedEnvPullRoleName(scope.env), savedEnvManageRoleName(scope.env)]
    .map((name) => `arn:${scope.partition}:iam::${scope.account}:role${environmentRolePath(scope.env)}${name}`);
}

/** Every role the broker may assume under the boundary: today the three saved environment image roles only. */
export function brokerAssumableRoleArns(scope: Pick<PolicyScope, "env" | "partition" | "account">): string[] {
  return savedEnvSessionRoleArns(scope);
}

function assumeSessionRolesStatement(scope: Pick<PolicyScope, "env" | "partition" | "account">): PolicyStatementJson {
  return {
    Sid: "AssumeSessionRoles",
    Effect: "Allow",
    Action: ["sts:AssumeRole"],
    Resource: brokerAssumableRoleArns(scope),
    Condition: { ArnEquals: { "aws:PrincipalArn": brokerRoleArn(scope) } },
  };
}

function fixedNameRoleLookupStatement(scope: Pick<PolicyScope, "env" | "partition" | "account">): PolicyStatementJson {
  return {
    Sid: "IamFixedNameRolesNotYetCreated",
    Effect: "Allow",
    Action: [...FIXED_NAME_ROLE_LOOKUP_ACTIONS],
    // R5 step 1: the Slack token reader role is fixed-name too (contracts slack-company-tokens.ts), so its lookup is listed with the three image roles.
    Resource: [...[savedEnvPushRoleName(scope.env), savedEnvPullRoleName(scope.env), savedEnvManageRoleName(scope.env)].map((name) => `arn:${scope.partition}:iam::${scope.account}:role/${name}`), slackTokenReaderLookupResource(scope)],
  };
}

function ecrTemplateServiceLinkedRoleStatement(scope: Pick<PolicyScope, "partition" | "account">): PolicyStatementJson {
  return {
    Sid: "EcrTemplateServiceLinkedRole",
    Effect: "Allow",
    Action: ["iam:CreateServiceLinkedRole"],
    Resource: `arn:${scope.partition}:iam::${scope.account}:role/aws-service-role/${ECR_TEMPLATE_SERVICE}/AWSServiceRoleForECRTemplate`,
    Condition: { StringEquals: { "iam:AWSServiceName": ECR_TEMPLATE_SERVICE } },
  };
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
    // Keep the resource exact to this environment's rule. EventBridge actions that do not
    // support rule resources remain unavailable with this resource constraint.
    { Sid: "EcsFailureEventsRule", Effect: "Allow", Action: ["events:*"], Resource: ecsFailureRuleArn(scope) },
    ...dnsFirewallStatements(scope),
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
    // L4-SE6: the saved environment image roles' fixed-name lookups, and ECR's creation template service-linked role (see above).
    fixedNameRoleLookupStatement(scope),
    ecrTemplateServiceLinkedRoleStatement(scope),
    // FR-047: the control-plane stack's monthly budget, and only that one, never budgets:* on *.
    { Sid: "Budget", Effect: "Allow", Action: [...BUDGET_ACTIONS], Resource: `arn:${scope.partition}:budgets::${scope.account}:budget/agentx-${scope.env}-monthly` },
  ];
}

// ---- Who may assume the operator role (L4-HARD, owner 2026-11-18)
/**
 * The operator-role principal the access stack accepts (`OperatorPrincipalArn`): empty (this account's own principals) or ONE IAM role or user. A whole
 * account (`...:root`) is not accepted, whichever account it is: it would trust every principal of that account. The pattern is a source string because
 * CloudFormation takes it as the parameter's AllowedPattern; OPERATOR_PRINCIPAL_PATTERN is the same pattern without the empty case.
 */
export const OPERATOR_PRINCIPAL_PATTERN_SOURCE = "^$|^arn:aws[a-z-]*:iam::[0-9]{12}:(role|user)/.+$";
export const OPERATOR_PRINCIPAL_PATTERN = /^arn:aws[a-z-]*:iam::([0-9]{12}):(?:role|user)\/.+$/u;
/** STS's external id alphabet and length (2 to 1,224 of [\w+=,.@:/-]); empty means none. */
export const OPERATOR_EXTERNAL_ID_PATTERN_SOURCE = "^$|^[\\w+=,.@:/-]{2,1224}$";
export const OPERATOR_EXTERNAL_ID_PATTERN = /^[\w+=,.@:/-]{2,1224}$/u;

/**
 * The refusal, in words, for an operator principal / external id pair that must not reach the access stack, or undefined when it is fine. `account` is the
 * account the access stack is deployed to. A principal of another account is allowed only with an external id (the trust policy then lets it in only when it
 * presents that id: access.ts); a whole-account principal is never allowed; an id with no principal is a mistake. The same rules the template's parameter
 * patterns and Rule enforce, so a person hears it before a deploy instead of from CloudFormation.
 */
export function operatorTrustProblem(input: { principal?: string | undefined; externalId?: string | undefined; account: string }): string | undefined {
  const principal = input.principal ?? "";
  const externalId = input.externalId ?? "";
  if (externalId !== "" && !OPERATOR_EXTERNAL_ID_PATTERN.test(externalId)) return "the operator external id must be 2 to 1224 characters of letters, digits and + = , . @ : / _ -";
  if (principal === "") return externalId === "" ? undefined : "an operator external id is only used with an operator principal: name the role or user that will present it, or drop the external id";
  if (/^arn:aws[a-z-]*:iam::[0-9]{12}:root$/u.test(principal)) return "the operator principal can't be a whole account (:root): name one IAM role or user, or leave it empty for this account's own principals";
  const match = OPERATOR_PRINCIPAL_PATTERN.exec(principal);
  if (match === null) return "the operator principal must be the ARN of one IAM role or user (arn:aws:iam::<12-digit account>:role/<name> or :user/<name>)";
  if (match[1] !== input.account && externalId === "") {
    return `the operator principal belongs to another AWS account (${match[1]}): a principal of another account needs an external id (--operator-external-id), which it must present to assume the operator role`;
  }
  return undefined;
}

type BoundaryScope = Pick<PolicyScope, "env" | "partition" | "region" | "account" | "cloudFormationRoleName">;

/**
 * The Deny statements EVERY AgentX role carries, whichever boundary caps it (the runtime boundary and the deploy boundary both end with these): they hold even if a later change widens an
 * Allow. Both boundaries' ARNs are named by DenyBoundaryChanges, so no capped role can edit either.
 */
function boundaryDenyStatements(scope: BoundaryScope): PolicyStatementJson[] {
  const roles = environmentRoles(scope);
  return [
    { Sid: "DenyAccountChanges", Effect: "Deny", Action: ["organizations:*", "account:*"], Resource: "*" },
    { Sid: "DenyUsersAndGroups", Effect: "Deny", Action: ["iam:*User*", "iam:*Group*"], Resource: "*" },
    {
      Sid: "DenyPolicyManagement",
      Effect: "Deny",
      Action: ["iam:CreatePolicy*", "iam:*PolicyVersion*", "iam:DeletePolicy", "iam:SetDefaultPolicyVersion"],
      Resource: "*",
    },
    { Sid: "DenyBoundaryChanges", Effect: "Deny", Action: ["iam:*Policy*"], Resource: [defaultBoundaryArn(scope), deployBoundaryArn(scope)] },
    // Never remove a boundary from a role (no Allow lists it either; the explicit Deny keeps a later Allow from opening it).
    { Sid: "DenyBoundaryRemoval", Effect: "Deny", Action: ["iam:DeleteRolePermissionsBoundary"], Resource: roles },
    // The DNS firewall fails closed and is the VPC's only resolver path: no AgentX role may switch it to fail open, share it, or route DNS around it, whatever a later Allow says.
    {
      Sid: "DenyDnsFirewallEscapes",
      Effect: "Deny",
      Action: ["route53resolver:UpdateFirewallConfig", "route53resolver:Put*Policy", "route53resolver:CreateResolverEndpoint", "route53resolver:CreateResolverRule", "route53resolver:AssociateResolverRule"],
      Resource: "*",
    },
    ...stackEscapeDenyStatements(scope),
    // The environment release pipeline's pointers, secret, buckets, projects, approval and stack: no role under either boundary touches them, whatever a later Allow says.
    ...releasePipelineDenyStatements(scope),
  ];
}

/**
 * The RUNTIME permission boundary (`defaultBoundaryName`): the most any role a merged template creates under /agentx/<env>/ can ever do, whatever its own policy says. It allows the
 * services AgentX uses, `iam:PassRole` on the environment's roles (the sessions provisioner passes the worker role to EC2), a read-only `iam:GetRole` on them (the auto-requalify preflight), the read-only quota List (the model-discovery check), the one email send, the broker's assume of the saved
 * environment image roles and the Slack service's assume of its token reader role. It has NO role management, no instance profiles and no service-linked roles: no runtime role uses
 * any (census, tests/contract/two-boundaries.test.ts), so a runtime role can never be given them by editing its own policy. The Deny statements hold even if a later change widens an Allow.
 */
export function defaultBoundaryStatements(scope: BoundaryScope): PolicyStatementJson[] {
  const { partition, account } = scope;
  return [
    { Sid: "Services", Effect: "Allow", Action: BOUNDARY_SERVICES.map((s) => `${s}:*`), Resource: "*" },
    // SES sending only, and only as an email identity of this account and region (the attention email sender's own policy narrows it to the one identity CoreAttentionEmailSender names);
    // never ses:* (identity, configuration and suppression-list changes stay outside every AgentX role). The Sid keeps its old name (the step-up sender, removed by DEC 254zzz73) so the
    // deployed boundary does not change.
    { Sid: "StepUpEmail", Effect: "Allow", Action: ["ses:SendEmail"], Resource: `arn:${partition}:ses:${scope.region}:${account}:identity/*` },
    { Sid: "PassRoles", Effect: "Allow", Action: ["iam:PassRole"], Resource: environmentRoles(scope) },
    // Read-only, the environment's roles only: the auto-requalify machine's preflight reads the worker role (runtime-requalify-steps.ts GetRoleCommand; census with every context flag on).
    { Sid: "ReadRoles", Effect: "Allow", Action: ["iam:GetRole"], Resource: environmentRoles(scope) },
    // DEC 432: the worker's model-discovery check lists the Bedrock service quotas (e2e-model-discovery-aws.ts ListServiceQuotasCommand). Read-only: the List action alone, which takes no resource
    // (`*`); never GetServiceQuota (not called), RequestServiceQuotaIncrease or any Put. The single boundary never allowed it, so the check was AccessDenied on named environments.
    { Sid: "ListQuotas", Effect: "Allow", Action: ["servicequotas:ListServiceQuotas"], Resource: "*" },
    // L4-SE6 and R5: the broker's sts:AssumeRole of the saved environment image roles (the trust names the broker role), and the Slack service's of its per-company token reader role (the
    // trust names the service's role and the one session tag). Trust grants, boundary caps: neither role's own policy has a statement for it.
    assumeSessionRolesStatement(scope),
    { Sid: "SlackTokenReader", ...slackTokenReaderBoundaryStatement({ env: scope.env, partition, account, named: true }) },
    ...boundaryDenyStatements(scope),
  ];
}

/**
 * The DEPLOY permission boundary (`deployBoundaryName`): caps ONLY the CloudFormation service role and the operator role. It is the previous single boundary less what only runtime roles
 * use (the email send, the broker's and the Slack service's assumes), so what CloudFormation and the operator can do is unchanged. What stops them escalating: role management is on this
 * environment's roles only; the actions that set or change what a role may do (create, set a boundary, attach, detach, put or delete an inline policy) are allowed only for a role that carries the
 * RUNTIME boundary (a role carrying the deploy boundary, or none, can never be made or changed through it, and an administrator policy attached to a runtime role is capped by the runtime
 * boundary); iam:DeleteRolePermissionsBoundary is allowed nowhere and denied; and the Deny statements both boundaries share.
 */
export function deployBoundaryStatements(scope: BoundaryScope): PolicyStatementJson[] {
  const { partition, account } = scope;
  const roles = environmentRoles(scope);
  return [
    { Sid: "Services", Effect: "Allow", Action: BOUNDARY_SERVICES.map((s) => `${s}:*`), Resource: "*" },
    { Sid: "EcsFailureEventsRule", Effect: "Allow", Action: ["events:*"], Resource: ecsFailureRuleArn(scope) },
    ...dnsFirewallStatements(scope),
    // The operator's identity check; the only STS action either deploy role uses.
    { Sid: "CallerIdentity", Effect: "Allow", Action: ["sts:GetCallerIdentity"], Resource: "*" },
    // The operator's EC2 quota reads (prerequisites on a resume); named like CallerIdentity above,
    // not scoped further, since scoped ARNs in the identity policy already limit it to two quotas.
    { Sid: "Quotas", Effect: "Allow", Action: ["servicequotas:GetServiceQuota"], Resource: "*" },
    // Role management on the environment's roles, WITH the boundary rules of serviceRoleStatements built into the boundary itself (a boundary does not pass to the roles it caps, so
    // a role carrying it could otherwise rebound itself or a sibling to AdministratorAccess, or create a role with none): the actions that set or change what a role may do are
    // allowed only for a role that carries the RUNTIME boundary (iam:PermissionsBoundary is the boundary being set, or the role's current one for the policy actions), and
    // iam:DeleteRolePermissionsBoundary is in neither list, so it is never allowed. Deploy roles never gain a role unbounded, or bounded by anything but the runtime boundary.
    { Sid: "IamRoles", Effect: "Allow", Action: ROLE_ACTIONS.filter((action) => !BOUNDARY_RULED_ROLE_ACTIONS.includes(action)), Resource: roles },
    {
      Sid: "IamRolesBounded",
      Effect: "Allow",
      Action: [...BOUNDARY_RULED_ROLE_ACTIONS],
      Resource: roles,
      Condition: { StringEquals: { "iam:PermissionsBoundary": defaultBoundaryArn(scope) } },
    },
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
    // L4-SE6 and R5: the fixed-name role lookups (the three image roles and the Slack token reader role), and ECR's template service-linked role.
    fixedNameRoleLookupStatement(scope),
    ecrTemplateServiceLinkedRoleStatement(scope),
    ...boundaryDenyStatements(scope),
  ];
}

/**
 * CloudFormation runs a stack's operation as the stack's STORED role when the caller passes none, and a caller needs no iam:PassRole for it. Stacks outside the environment's own (the
 * access stack, the Cloud stacks, CDKToolkit) may store the admin CDK bootstrap role, so a bounded role with cloudformation:* could update one and run as admin. Two Deny statements:
 *   - CreateStack, UpdateStack and CreateChangeSet are refused unless the call passes THIS environment's CloudFormation role (cloudformation:RoleArn). With no role passed the key is
 *     absent and StringNotEquals is true, so a call without a role is refused too (it would run as the caller or the stored role).
 *   - The writes that run a stack's template, and the delete, are refused on every stack outside `agentx-<env>-*` (the pipeline's stack, the Cloud stacks, CDKToolkit, a new stack with
 *     any other name). The access stack is `agentx-<env>-access`, so release-pipeline-names.ts denies the same writes there (an administrator deploys it with the caller's own
 *     credentials, never a stored role, never the environment's CloudFormation role).
 */
export function stackEscapeDenyStatements(scope: Pick<PolicyScope, "env" | "partition" | "account" | "cloudFormationRoleName">): PolicyStatementJson[] {
  return [
    {
      Sid: "DenyCfnWithoutEnvRole",
      Effect: "Deny",
      Action: ["cloudformation:CreateStack", "cloudformation:UpdateStack", "cloudformation:CreateChangeSet"],
      Resource: "*",
      Condition: { StringNotEquals: { "cloudformation:RoleArn": `arn:${scope.partition}:iam::${scope.account}:role/${scope.cloudFormationRoleName}` } },
    },
    {
      Sid: "DenyCfnOutsideEnvStacks",
      Effect: "Deny",
      Action: ["cloudformation:Create*", "cloudformation:Update*", "cloudformation:Delete*", "cloudformation:Execute*"],
      NotResource: [`arn:${scope.partition}:cloudformation:*:*:stack/agentx-${scope.env}-*/*`],
    },
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
    // prerequisites.ts checks two EC2 quotas on an operator resume: standard vCPUs (ServiceCode
    // "ec2", QuotaCode "L-1216C47A") and EC2-VPC Elastic IPs ("L-0263D0A3"). The servicequotas
    // "quota" resource type's ARN format is
    // arn:partition:servicequotas:region:account:serviceCode/quotaCode, so this scopes to exactly
    // those two quotas rather than every quota in the account.
    {
      Sid: "Quotas",
      Effect: "Allow",
      Action: ["servicequotas:GetServiceQuota"],
      Resource: [
        `arn:${partition}:servicequotas:${region}:${account}:ec2/L-1216C47A`,
        `arn:${partition}:servicequotas:${region}:${account}:ec2/L-0263D0A3`,
      ],
    },
    // The Elastic IP check counts the region's allocated addresses. ec2:DescribeAddresses has no
    // resource-level permissions, so "*" is its only Resource; it reads, and changes nothing.
    { Sid: "Addresses", Effect: "Allow", Action: ["ec2:DescribeAddresses"], Resource: "*", Condition: { StringEquals: { "aws:RequestedRegion": region } } },
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
