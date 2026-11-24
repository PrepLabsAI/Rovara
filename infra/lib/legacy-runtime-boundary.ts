import { Aspects, Aws, type IAspect, type Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { IConstruct } from "constructs";
import { isIamRole } from "./iam-roles.js";
import type { AgentXNaming } from "./naming.js";

/**
 * The deny-only permissions boundary of the deployment that predates named environments (no
 * `agentxEnv` context): every runtime role there (Lambda, ECS task, the worker's EC2 instance role,
 * the Slack orchestrator) is capped by it. It is the Cloud boundary's pattern: `Allow * on *` keeps
 * each role's own policy as the effective ceiling, and the explicit denies below remove the
 * ability to change IAM, change CloudFormation stacks, assume or pass the CDK deployer roles, or
 * change Lambda code or configuration. Even if a later commit grants a runtime role
 * `cloudformation:*` or `iam:*` by mistake, the role still cannot use it (staging findings F1/F2).
 *
 * Not applied to the release pipeline stack: the release build is the deployer by design and
 * assumes the CDK bootstrap roles; that stack, the installer and the other context-gated stacks
 * are listed nowhere here.
 *
 * Each stack that holds runtime roles gets its own copy of the policy (same statements, one name
 * per stack), so a stack's roles never depend on another stack having been deployed first. Only the
 * control-plane copy has a PassRole exception: the session provisioner's one grant, the worker's
 * instance role passed to EC2, whose ARN is that stack's `Ec2WorkerInstanceRoleArn` parameter.
 */
export type LegacyRuntimeBoundaryPart = "control-plane" | "foundation" | "slack";

export const LEGACY_RUNTIME_BOUNDARY_PARTS: readonly LegacyRuntimeBoundaryPart[] = ["control-plane", "foundation", "slack"];

/** The stack parameter the control plane receives the worker instance role's ARN in (session-lifecycle.ts). */
export const WORKER_ROLE_ARN_PARAMETER = "Ec2WorkerInstanceRoleArn";

export function legacyRuntimeBoundaryName(naming: AgentXNaming, part: LegacyRuntimeBoundaryPart): string {
  return `${naming.resourcePrefix}-runtime-boundary-${part}`;
}

/** Every IAM action that writes (anything but Get, List, Simulate and the like). PassRole is denied separately, with its one exception. */
export const IAM_WRITE_DENIES = [
  "iam:Create*", "iam:Delete*", "iam:Put*", "iam:Attach*", "iam:Detach*", "iam:Update*", "iam:Add*", "iam:Remove*", "iam:Set*",
  "iam:Tag*", "iam:Untag*", "iam:Upload*", "iam:Change*", "iam:Reset*", "iam:Enable*", "iam:Deactivate*",
] as const;

/** Removing or changing a boundary (this one included): already inside IAM_WRITE_DENIES, listed apart so the intent is explicit and a removal of one list cannot reopen it. */
export const BOUNDARY_DENIES = [
  "iam:DeleteRolePermissionsBoundary", "iam:PutRolePermissionsBoundary", "iam:DeleteUserPermissionsBoundary", "iam:PutUserPermissionsBoundary",
  "iam:DeletePolicy", "iam:CreatePolicyVersion", "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion",
] as const;

/** CloudFormation actions that read; everything else on a CloudFormation resource is denied. */
export const CLOUDFORMATION_READS = ["cloudformation:Describe*", "cloudformation:List*", "cloudformation:Get*"] as const;

/** The CloudFormation writes that name no stack ARN (a resource-restricted deny never matches those), listed so the deny above is not the only one. */
export const CLOUDFORMATION_WRITE_DENIES = [
  "cloudformation:Create*", "cloudformation:Update*", "cloudformation:Delete*", "cloudformation:Execute*", "cloudformation:Cancel*", "cloudformation:Continue*",
  "cloudformation:Rollback*", "cloudformation:Set*", "cloudformation:Signal*", "cloudformation:Register*", "cloudformation:Deregister*",
  "cloudformation:Activate*", "cloudformation:Deactivate*", "cloudformation:Publish*", "cloudformation:Import*", "cloudformation:Test*", "cloudformation:Record*",
] as const;

export const LAMBDA_CODE_DENIES = [
  "lambda:Create*", "lambda:Delete*", "lambda:Update*", "lambda:Put*", "lambda:Add*", "lambda:Remove*", "lambda:Publish*",
] as const;

export const ACCOUNT_DENIES = ["organizations:*", "account:*"] as const;

/** Policies on resources the runtime roles use: who else may pull an image, read a bucket or a secret. No runtime role writes any of them. */
export const RESOURCE_POLICY_DENIES = [
  "ecr:SetRepositoryPolicy", "ecr:DeleteRepositoryPolicy", "ecr:PutRegistryPolicy", "ecr:DeleteRegistryPolicy",
  "s3:PutBucketPolicy", "s3:DeleteBucketPolicy", "s3:PutBucketAcl", "s3:PutObjectAcl", "s3:PutObjectVersionAcl",
  "s3:PutBucketPublicAccessBlock", "s3:PutAccountPublicAccessBlock", "s3:PutAccessPointPolicy", "s3:DeleteAccessPointPolicy",
  "secretsmanager:PutResourcePolicy", "secretsmanager:DeleteResourcePolicy",
  // The saved-environment creation template carries the repository policy that keeps one company's images from every other reader; replication copies images out of the registry.
  "ecr:CreateRepositoryCreationTemplate", "ecr:UpdateRepositoryCreationTemplate", "ecr:DeleteRepositoryCreationTemplate", "ecr:PutReplicationConfiguration",
] as const;

/** Running commands or tasks on compute the runtime roles do not own, and building new state machines. The session provisioner starts workers with ec2:RunInstances and Step Functions executions; neither is here. */
export const COMPUTE_CONTROL_DENIES = [
  "ssm:SendCommand", "ssm:StartSession", "ssm:StartAutomationExecution",
  "ecs:RunTask", "ecs:StartTask", "ecs:ExecuteCommand", "ecs:RegisterTaskDefinition", "ecs:CreateService", "ecs:UpdateService",
  "states:CreateStateMachine", "states:UpdateStateMachine", "states:DeleteStateMachine",
  "codebuild:CreateProject", "codebuild:UpdateProject", "codebuild:DeleteProject", "codebuild:ImportSourceCredentials",
  // SendCommand by another name: State Manager associations, documents and maintenance-window tasks run commands on instances; EC2 Instance Connect pushes an SSH key.
  "ssm:CreateAssociation", "ssm:CreateAssociationBatch", "ssm:UpdateAssociation", "ssm:StartAssociationsOnce", "ssm:CreateDocument", "ssm:UpdateDocument",
  "ssm:UpdateDocumentDefaultVersion", "ssm:RegisterTaskWithMaintenanceWindow",
  "ec2-instance-connect:SendSSHPublicKey", "ec2-instance-connect:SendSerialConsoleSSHPublicKey", "ec2-instance-connect:OpenTunnel",
  // A code change for the worker by another name: the worker image and model-key parameters every new worker reads, and the launch template (user data) the provisioner starts it from.
  "ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters", "ssm:LabelParameterVersion",
  "ec2:CreateLaunchTemplate", "ec2:CreateLaunchTemplateVersion", "ec2:ModifyLaunchTemplate", "ec2:DeleteLaunchTemplate", "ec2:DeleteLaunchTemplateVersions", "ec2:ModifyInstanceAttribute",
] as const;

/** Every CodeBuild action on the release projects (and their report groups). The broker may start `agentx-*` projects; release projects are named `release-agentx-*` so they stay outside that. */
export const RELEASE_PROJECT_CODEBUILD_DENY = "codebuild:*";

/**
 * The boundary's statements. `workerRoleArn` is the one role a runtime role may pass, and only to
 * EC2; without it every PassRole is denied.
 */
export function legacyRuntimeBoundaryStatements(workerRoleArn?: string): iam.PolicyStatement[] {
  const partition = Aws.PARTITION;
  const deny = (props: Omit<iam.PolicyStatementProps, "effect">) => new iam.PolicyStatement({ effect: iam.Effect.DENY, ...props });
  const statements = [
    new iam.PolicyStatement({ sid: "AllowAll", effect: iam.Effect.ALLOW, actions: ["*"], resources: ["*"] }),
    deny({ sid: "DenyIamChanges", actions: [...IAM_WRITE_DENIES], resources: ["*"] }),
    deny({ sid: "DenyBoundaryChanges", actions: [...BOUNDARY_DENIES], resources: ["*"] }),
    workerRoleArn === undefined
      ? deny({ sid: "DenyPassRole", actions: ["iam:PassRole"], resources: ["*"] })
      : deny({ sid: "DenyPassRoleExceptWorkerRole", actions: ["iam:PassRole"], notResources: [workerRoleArn] }),
    ...(workerRoleArn === undefined
      ? []
      : [deny({
        sid: "DenyWorkerRolePassToOtherServices",
        actions: ["iam:PassRole"],
        resources: [workerRoleArn],
        conditions: { StringNotEquals: { "iam:PassedToService": "ec2.amazonaws.com" } },
      })]),
    deny({ sid: "DenyStackChanges", notActions: [...CLOUDFORMATION_READS], resources: [`arn:${partition}:cloudformation:*:*:*`] }),
    deny({ sid: "DenyStackChangesWithoutStackArn", actions: [...CLOUDFORMATION_WRITE_DENIES], resources: ["*"] }),
    deny({ sid: "DenyDeployerRoles", actions: ["sts:AssumeRole", "iam:PassRole"], resources: [`arn:${partition}:iam::*:role/cdk-*`, `arn:${partition}:iam::*:role/*/cdk-*`] }),
    // The release pipeline's SourceActionRole trusts the account root and writes the pipeline's artifact bucket, whose source the release build (the CDK deployer) runs:
    // assuming it reaches the deployer without naming a cdk-* role. No runtime role assumes a pipeline role.
    deny({ sid: "DenyReleasePipelineRoles", actions: ["sts:AssumeRole"], resources: [`arn:${partition}:iam::*:role/AgentXReleasePipeline-*`] }),
    deny({ sid: "DenyLambdaCodeChanges", actions: [...LAMBDA_CODE_DENIES], resources: ["*"] }),
    deny({ sid: "DenyAccountChanges", actions: [...ACCOUNT_DENIES], resources: ["*"] }),
    deny({ sid: "DenyResourcePolicyChanges", actions: [...RESOURCE_POLICY_DENIES], resources: ["*"] }),
    deny({ sid: "DenyComputeControl", actions: [...COMPUTE_CONTROL_DENIES], resources: ["*"] }),
    deny({
      sid: "DenyReleaseProjects",
      actions: [RELEASE_PROJECT_CODEBUILD_DENY],
      resources: [`arn:${partition}:codebuild:*:*:project/release-*`, `arn:${partition}:codebuild:*:*:report-group/release-*`],
    }),
  ];
  return statements;
}

class LegacyRuntimeBoundaryAspect implements IAspect {
  constructor(private readonly boundaryArn: string) {}

  visit(node: IConstruct): void {
    if (!isIamRole(node)) return;
    if (node instanceof iam.CfnRole) {
      if (node.permissionsBoundary !== undefined) throw new Error(`${node.node.path} already has a permissions boundary`);
      node.permissionsBoundary = this.boundaryArn;
    } else {
      // Plain CfnResource roles (CDK's custom-resource providers): raw CloudFormation properties, as permissions-boundary.ts does.
      const properties = (node as unknown as { _cfnProperties?: Record<string, unknown> })._cfnProperties;
      if (properties?.PermissionsBoundary !== undefined) throw new Error(`${node.node.path} already has a permissions boundary`);
      node.addPropertyOverride("PermissionsBoundary", this.boundaryArn);
    }
  }
}

const BOUNDARY_ID = "RuntimeBoundary";

/**
 * Creates the stack's copy of the runtime boundary and sets it as the `PermissionsBoundary` of every
 * IAM role the stack declares (an in-place property change on each existing role, never a
 * replacement). Legacy naming only. For the control plane the worker role's ARN is the stack's own
 * `Ec2WorkerInstanceRoleArn` parameter, found here so the caller passes nothing.
 */
export function applyLegacyRuntimeBoundary(stack: Stack, naming: AgentXNaming, part: LegacyRuntimeBoundaryPart): iam.ManagedPolicy {
  if (naming.env !== undefined) throw new Error("the runtime boundary is for the deployment that predates named environments");
  let workerRoleArn: string | undefined;
  if (part === "control-plane") {
    const parameter = stack.node.tryFindChild(WORKER_ROLE_ARN_PARAMETER);
    if (parameter === undefined || !("valueAsString" in parameter)) {
      throw new Error(`the control plane has no ${WORKER_ROLE_ARN_PARAMETER} parameter to except from the PassRole deny`);
    }
    workerRoleArn = (parameter as { valueAsString: string }).valueAsString;
  }
  const policy = new iam.ManagedPolicy(stack, BOUNDARY_ID, {
    managedPolicyName: legacyRuntimeBoundaryName(naming, part),
    description: "Deny-only permissions boundary of the AgentX runtime roles: no IAM, CloudFormation, CDK deployer role or Lambda code changes",
    statements: legacyRuntimeBoundaryStatements(workerRoleArn),
  });
  Aspects.of(stack).add(new LegacyRuntimeBoundaryAspect(policy.managedPolicyArn));
  return policy;
}


/** Applies the deny-only runtime boundary to the three legacy runtime stacks; a no-op for a named environment (it has its own environment boundary). */
export function applyLegacyRuntimeBoundaries(naming: AgentXNaming, stacks: { controlPlane: Stack; foundation: Stack; slack: Stack }): void {
  if (naming.env !== undefined) return;
  applyLegacyRuntimeBoundary(stacks.controlPlane, naming, "control-plane");
  applyLegacyRuntimeBoundary(stacks.foundation, naming, "foundation");
  applyLegacyRuntimeBoundary(stacks.slack, naming, "slack");
}
