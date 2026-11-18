// Saved environment images, the registry side (lane L4-SE6; scope briefs/lead4/L4-SE-SCOPE.md section 3; owner approved 2026-11-18). Named environments only: the legacy template has none of it.
//
// What this creates, in the control plane's stack:
//   - ONE ECR repository creation template for the prefix `rovara-env/<env>`. Every repository the first push creates has immutable tags, AES-256 encryption (ECR's own: no KMS key, no key policy, no
//     grant), the lifecycle policy of contracts `savedEnvLifecyclePolicy` (untagged out after a day, a count BACKSTOP; the 30 day ceiling is the broker's manage walk) and the repository policy of
//     contracts `savedEnvRepositoryPolicy` (image reads only for the push and pull roles, writes only for the push role, image deletes only for the manage role). No custom creation role and no
//     resource tags: ECR requires a creation role only for KMS or tags (https://docs.aws.amazon.com/AmazonECR/latest/userguide/repository-creation-templates.html), and without one it creates the
//     repository through its own service-linked role (AWSServiceRoleForECRTemplate, which the deploy role may create: contracts access-policies.ts).
//   - THREE roles the broker assumes, each with a SESSION POLICY naming ONE repository (broker aws/saved-env-role-sessions.ts): push, pull and manage. Each trusts ONLY the broker role, and each role's own
//     policy reaches only ECR repositories under `rovara-env/<env>/*`, so a session that carried no policy would still reach only this environment's images; the session narrows it to ONE project of ONE
//     company. The role policies are written from the contracts' action lists, so the roles and the session policies never drift.
//
// Not created: a KMS key, a creation role, registry-wide scanning (one setting for the whole registry; scanning is off in v1, scope D4), any grant on the worker role or on the broker's own policy
// (the broker's inline policy is at its size pin; the trust names the broker role, and the permissions boundary allows the AssumeRole: contracts `AssumeSessionRoles`). Repositories are made at run
// time by the first push, not by CloudFormation: delete the stack and the repositories stay until the broker's purge (or a hand delete of `rovara-env/<env>/*`) removes them.
//
// Not decided here: whether the feature is on (the broker's `sv` setting and the project's `savedEnv.enabled`) or who an image belongs to (the repository name is a hash of the company and the project).
// With the feature off nothing pushes, and the empty template and roles cost nothing.
import { Aws, CfnOutput, Duration, Stack, aws_ecr as ecr, aws_iam as iam, type aws_lambda as lambda } from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  SAVED_ENV_KEEP_DEFAULT,
  SAVED_ENV_MANAGE_ACTIONS,
  SAVED_ENV_PULL_ACTIONS,
  SAVED_ENV_PUSH_ACTIONS,
  SAVED_ENV_MANAGE_ROLE_ARN_VARIABLE,
  SAVED_ENV_OUTPUT_MANAGE_ROLE_ARN,
  SAVED_ENV_OUTPUT_PULL_ROLE_ARN,
  SAVED_ENV_OUTPUT_PUSH_ROLE_ARN,
  SAVED_ENV_OUTPUT_REGISTRY_READY,
  SAVED_ENV_OUTPUT_REPO_PREFIX,
  SAVED_ENV_PULL_ROLE_ARN_VARIABLE,
  SAVED_ENV_PUSH_ROLE_ARN_VARIABLE,
  SAVED_ENV_PUSH_SESSION_SECONDS,
  SAVED_ENV_REGISTRY_READY_VALUE,
  SAVED_ENV_REPO_PREFIX_VARIABLE,
  savedEnvLifecyclePolicy,
  savedEnvManageRoleName,
  savedEnvPullRoleName,
  savedEnvPushRoleName,
  savedEnvRepositoriesArn,
  savedEnvRepositoryPolicy,
  savedEnvRepositoryPrefix,
} from "@agentx/contracts";

/** Scanning is off in v1 (scope D4): the push role does not get the scan actions the session policy lists (a session policy can only narrow a role, so listing them there changes nothing). */
const SCAN_ACTIONS: readonly string[] = ["ecr:StartImageScan", "ecr:DescribeImageScanFindings"];
export const SAVED_ENV_PUSH_ROLE_ACTIONS: readonly string[] = SAVED_ENV_PUSH_ACTIONS.filter((action) => !SCAN_ACTIONS.includes(action));

export interface SavedEnvImagesProps {
  /** The named environment (`staging`, `prod`). */
  readonly env: string;
  /** The role the broker runs as: the three roles trust it and nothing else. */
  readonly brokerRole: iam.IRole;
}

export class SavedEnvImages extends Construct {
  readonly pushRole: iam.Role;
  readonly pullRole: iam.Role;
  readonly manageRole: iam.Role;
  readonly template: ecr.CfnRepositoryCreationTemplate;

  constructor(scope: Construct, id: string, props: SavedEnvImagesProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const { env } = props;
    const repositories = savedEnvRepositoriesArn({ partition: Aws.PARTITION, region: Aws.REGION, account: Aws.ACCOUNT_ID }, env);

    const sessionRole = (logicalId: string, roleName: string, description: string, actions: readonly string[], withToken: boolean): iam.Role => {
      const role = new iam.Role(this, logicalId, {
        roleName,
        description,
        // Only the broker's role. A same-account trust that names a role ARN needs no statement in that role's own policy.
        assumedBy: new iam.ArnPrincipal(props.brokerRole.roleArn),
        // The longest session any of them is minted for is the push's 3,600 seconds (the chained-role maximum, and an IAM role's own minimum maximum); the broker asks for less (pull 1,800, manage 900)
        // and a session policy names the one repository.
        maxSessionDuration: Duration.seconds(SAVED_ENV_PUSH_SESSION_SECONDS),
      });
      // ECR cannot scope the token call to a repository: `*` is its only resource. What a token may DO is set by the session policy.
      if (withToken) role.addToPolicy(new iam.PolicyStatement({ sid: "RegistryToken", actions: ["ecr:GetAuthorizationToken"], resources: ["*"] }));
      role.addToPolicy(new iam.PolicyStatement({ sid: "ThisEnvironmentsImages", actions: [...actions], resources: [repositories] }));
      return role;
    };
    this.pushRole = sessionRole("PushRole", savedEnvPushRoleName(env), "Rovara saved environment images: the broker assumes this with a one-repository session policy to push an image", SAVED_ENV_PUSH_ROLE_ACTIONS, true);
    this.pullRole = sessionRole("PullRole", savedEnvPullRoleName(env), "Rovara saved environment images: the broker assumes this with a one-repository session policy to pull an image", SAVED_ENV_PULL_ACTIONS, true);
    this.manageRole = sessionRole("ManageRole", savedEnvManageRoleName(env), "Rovara saved environment images: the broker assumes this with a one-repository session policy to list and delete images", SAVED_ENV_MANAGE_ACTIONS, false);

    // The roles' real ARNs (the environment's path is put on them by the stack's aspect), so the policy names exactly the roles created here.
    const policy = savedEnvRepositoryPolicy({ pushRoleArn: this.pushRole.roleArn, pullRoleArn: this.pullRole.roleArn, manageRoleArn: this.manageRole.roleArn });
    this.template = new ecr.CfnRepositoryCreationTemplate(this, "CreationTemplate", {
      prefix: savedEnvRepositoryPrefix(env),
      appliedFor: ["CREATE_ON_PUSH"],
      description: "Rovara saved environment images: immutable tags, AES-256, keep the newest images, data actions for the push and pull roles only",
      imageTagMutability: "IMMUTABLE",
      encryptionConfiguration: { encryptionType: "AES256" },
      lifecyclePolicy: JSON.stringify(savedEnvLifecyclePolicy(SAVED_ENV_KEEP_DEFAULT)),
      repositoryPolicy: stack.toJsonString(policy),
    });
    // The repository policy names the roles by ARN, and the template must not be created before they exist.
    this.template.node.addDependency(this.pushRole, this.pullRole, this.manageRole);
  }

  /**
   * The output contract (briefs/lead4/L4-SE-OUTPUT-CONTRACT.md) and the broker's variables. The outputs are made on the STACK, so their keys are exactly the contract's (a construct would prefix its own
   * path). `SavedEnvRegistryReady` is "1" and exists only here, after the three roles AND the creation template are in this same template; `agentx config set savedEnvironments.switch on` refuses without it.
   * The broker gets the same four values as plain variables (they are the only way it learns the role ARNs: they are in the control-plane stack, so no other source), and so does nothing without them.
   */
  expose(stack: Stack, broker: lambda.Function): void {
    new CfnOutput(stack, SAVED_ENV_OUTPUT_PUSH_ROLE_ARN, { value: this.pushRole.roleArn, description: "The role the broker assumes, with a one-repository session policy, to push a saved environment image" });
    new CfnOutput(stack, SAVED_ENV_OUTPUT_PULL_ROLE_ARN, { value: this.pullRole.roleArn, description: "The role the broker assumes, with a one-repository session policy, to pull a saved environment image" });
    new CfnOutput(stack, SAVED_ENV_OUTPUT_MANAGE_ROLE_ARN, { value: this.manageRole.roleArn, description: "The role the broker assumes, with a one-repository session policy, to list and delete saved environment images" });
    new CfnOutput(stack, SAVED_ENV_OUTPUT_REPO_PREFIX, { value: this.template.prefix, description: "The repository name prefix the saved environment creation template covers" });
    new CfnOutput(stack, SAVED_ENV_OUTPUT_REGISTRY_READY, { value: SAVED_ENV_REGISTRY_READY_VALUE, description: "1 when the three saved environment image roles and the repository creation template exist" });
    broker.addEnvironment(SAVED_ENV_PUSH_ROLE_ARN_VARIABLE, this.pushRole.roleArn);
    broker.addEnvironment(SAVED_ENV_PULL_ROLE_ARN_VARIABLE, this.pullRole.roleArn);
    broker.addEnvironment(SAVED_ENV_MANAGE_ROLE_ARN_VARIABLE, this.manageRole.roleArn);
    broker.addEnvironment(SAVED_ENV_REPO_PREFIX_VARIABLE, this.template.prefix);
  }
}
