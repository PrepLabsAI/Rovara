import { Aws, CfnCondition, CfnOutput, CfnParameter, CfnRule, Duration, Fn, RemovalPolicy, Stack, Validations, type StackProps } from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { defaultBoundaryName, defaultBoundaryStatements, deployBoundaryName, deployBoundaryStatements, environmentRolePath, operatorRoleStatements, serviceRoleStatements } from "./access-policies.js";
import { OPERATOR_EXTERNAL_ID_PATTERN_SOURCE, OPERATOR_PRINCIPAL_PATTERN_SOURCE } from "@agentx/contracts";
import type { AgentXNaming } from "./naming.js";
import { applyPermissionsBoundaryParameter } from "./permissions-boundary.js";

export interface AccessStackProps extends StackProps {
  naming: AgentXNaming;
}

/**
 * The one template a platform team deploys and reviews for an environment: the artifact bucket,
 * the ECR pull-through cache rule, the role CloudFormation assumes to deploy every other stack, and
 * the role operators assume to run `agentx`. The service role cannot deploy its own stack, so these
 * live apart from the rest.
 */
export class AccessStack extends Stack {
  constructor(scope: Construct, id: string, props: AccessStackProps) {
    super(scope, id, props);
    const { naming } = props;
    const env = naming.env;
    if (env === undefined) throw new Error("the access stack exists only for named environments");
    const ecsFailureRuleArn = Fn.sub(`arn:${"${AWS::Partition}"}:events:${"${AWS::Region}"}:${"${AWS::AccountId}"}:rule/agentx-${env}-*-service-failures`);

    // The default boundary applies whenever the company gives none, so every AgentX role always has
    // one. It exists only under UseDefaultBoundary; the roles and the Deny statements Ref it inside
    // the Fn::If's else branch, which is valid for a conditional resource (the branch is evaluated
    // only when the resource exists) and makes CloudFormation create the policy before the roles.
    // A DependsOn would not do: DependsOn on a resource whose condition is false fails the stack.
    // TWO-BOUNDARIES: two default policies, both under UseDefaultBoundary. The RUNTIME one (the old name) caps every role the later stacks create; the DEPLOY one caps only this stack's
    // two roles (the CloudFormation service role and the operator role). A company-given boundary replaces both, as the single one was replaced before.
    let useDefaultBoundary: CfnCondition | undefined;
    const defaultPolicy = (id: string, name: string, description: string, statements: ReturnType<typeof defaultBoundaryStatements>, hasPermissionsBoundary: CfnCondition): string => {
      useDefaultBoundary ??= new CfnCondition(this, "UseDefaultBoundary", { expression: Fn.conditionNot(hasPermissionsBoundary) });
      const policy = new iam.CfnManagedPolicy(this, id, {
        managedPolicyName: name,
        path: environmentRolePath(env),
        description,
        policyDocument: {
          Version: "2012-10-17",
          Statement: statements.map((statement) => statement.Sid === "EcsFailureEventsRule" ? { ...statement, Resource: ecsFailureRuleArn } : statement),
        },
      });
      policy.cfnOptions.condition = useDefaultBoundary;
      return policy.ref;
    };
    const boundaryScope = { env, partition: Aws.PARTITION, region: Aws.REGION, account: this.account, cloudFormationRoleName: naming.cloudFormationRoleName };
    const { effectiveBoundaryArn, rolesBoundaryArn } = applyPermissionsBoundaryParameter(this, env, {
      defaultBoundary: (hasPermissionsBoundary) => defaultPolicy("DefaultPermissionsBoundary", defaultBoundaryName(env), `Default permission boundary for every agentx-${env} role`, defaultBoundaryStatements(boundaryScope), hasPermissionsBoundary),
      deployBoundary: (hasPermissionsBoundary) => defaultPolicy("DeployPermissionsBoundary", deployBoundaryName(env), `Permission boundary for the agentx-${env} CloudFormation service role and operator role`, deployBoundaryStatements(boundaryScope), hasPermissionsBoundary),
    });
    // Who may assume the operator role (L4-HARD, owner 2026-11-18). Empty (the documented default): any principal of THIS account that its own IAM allows to call
    // sts:AssumeRole on the role (the customer's own platform team). A named principal is ONE role or user: never a whole account (`...:root`), whichever account.
    // A principal of ANOTHER account can assume the role only with the external id below (the trust policy has no other statement for it), so a guessed or pasted
    // ARN alone opens nothing; `agentx init` and upgrade refuse a cross-account principal without an id up front (packages/contracts access-policies.ts operatorTrustProblem).
    const operatorPrincipalArn = new CfnParameter(this, "OperatorPrincipalArn", {
      type: "String",
      default: "",
      allowedPattern: OPERATOR_PRINCIPAL_PATTERN_SOURCE,
      constraintDescription: "must be empty (this account's own principals) or the ARN of ONE IAM role or user, arn:aws:iam::<12-digit account>:role/<name> or :user/<name>; a whole account (:root) is refused",
      description: "Optional operator-role principal: one IAM role or user ARN. Empty trusts this account's own principals. A principal of another account also needs OperatorExternalId",
    });
    const operatorExternalId = new CfnParameter(this, "OperatorExternalId", {
      type: "String",
      default: "",
      allowedPattern: OPERATOR_EXTERNAL_ID_PATTERN_SOURCE,
      constraintDescription: "must be empty or 2 to 1224 characters of letters, digits and + = , . @ : / _ -",
      description: "The sts:ExternalId a principal of ANOTHER account must present to assume the operator role (required for one; unused for a principal of this account). Not a secret: it guards against a confused deputy",
    });
    const hasOperatorPrincipal = new CfnCondition(this, "HasOperatorPrincipal", {
      expression: Fn.conditionNot(Fn.conditionEquals(operatorPrincipalArn.valueAsString, "")),
    });
    const hasOperatorExternalId = new CfnCondition(this, "HasOperatorExternalId", {
      expression: Fn.conditionAnd(hasOperatorPrincipal, Fn.conditionNot(Fn.conditionEquals(operatorExternalId.valueAsString, ""))),
    });
    // An id with no principal to present it is a mistake, not a setting: refused with these words at create or change-set time.
    new CfnRule(this, "OperatorExternalIdNeedsPrincipal", {
      ruleCondition: Fn.conditionNot(Fn.conditionEquals(operatorExternalId.valueAsString, "")),
      assertions: [{
        assert: Fn.conditionNot(Fn.conditionEquals(operatorPrincipalArn.valueAsString, "")),
        assertDescription: "OperatorExternalId is only used with OperatorPrincipalArn: name the role or user that will present it, or clear OperatorExternalId",
      }],
    });

    const bucket = new s3.Bucket(this, "ArtifactBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30) }],
      // Retained: release artifacts must outlive a stack deletion.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    new ecr.CfnPullThroughCacheRule(this, "PullThroughCacheRule", {
      ecrRepositoryPrefix: naming.pullThroughPrefix,
      upstreamRegistryUrl: "public.ecr.aws",
    });

    const policyScope = {
      env,
      partition: Aws.PARTITION,
      // Aws.REGION, not this.region: the stack's env pins a region for synthesis, but the released
      // template must deploy into whichever region the operator picks.
      region: Aws.REGION,
      account: this.account,
      artifactBucketArn: bucket.bucketArn,
      pullThroughPrefix: naming.pullThroughPrefix,
      cloudFormationRoleName: naming.cloudFormationRoleName,
    };
    // The boundary Deny statements always apply and name the effective boundary.
    const serviceStatements = serviceRoleStatements({ ...policyScope, permissionsBoundaryArn: effectiveBoundaryArn })
      .map((statement) => statement.Sid === "EcsFailureEventsRule" ? { ...statement, Resource: ecsFailureRuleArn } : statement);

    const serviceRole = new iam.CfnRole(this, "CloudFormationServiceRole", {
      roleName: naming.cloudFormationRoleName,
      description: `CloudFormation deployment role for ${env}`,
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "cloudformation.amazonaws.com" },
            Action: "sts:AssumeRole",
            Condition: { StringEquals: { "aws:SourceAccount": this.account } },
          },
        ],
      },
      policies: [{ policyName: "deploy", policyDocument: { Version: "2012-10-17", Statement: serviceStatements } }],
    });

    const operatorRole = new iam.CfnRole(this, "OperatorRole", {
      roleName: naming.operatorRoleName,
      description: `AgentX operator role for ${env}`,
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            // The default (this account's root, which still needs an allow on the caller's side) or ONE named role or user. Either way only a caller OF THIS ACCOUNT
            // gets in through this statement: a principal of another account has no way in here.
            Sid: "OperatorOfThisAccount",
            Effect: "Allow",
            Principal: {
              AWS: Fn.conditionIf(
                hasOperatorPrincipal.logicalId,
                operatorPrincipalArn.valueAsString,
                `arn:${Aws.PARTITION}:iam::${this.account}:root`,
              ),
            },
            Action: "sts:AssumeRole",
            Condition: { StringEquals: { "aws:PrincipalAccount": Aws.ACCOUNT_ID } },
          },
          // Only when an external id is set: the named principal, of any account, with that id. This is the only way a principal of another account can assume the role.
          Fn.conditionIf(hasOperatorExternalId.logicalId, {
            Sid: "NamedOperatorWithExternalId",
            Effect: "Allow",
            Principal: { AWS: operatorPrincipalArn.valueAsString },
            Action: "sts:AssumeRole",
            Condition: { StringEquals: { "sts:ExternalId": operatorExternalId.valueAsString } },
          }, Aws.NO_VALUE),
        ],
      },
      maxSessionDuration: 3600,
      policies: [{ policyName: "operate", policyDocument: { Version: "2012-10-17", Statement: operatorRoleStatements(policyScope) } }],
    });

    new CfnOutput(this, "ArtifactBucketName", { value: bucket.bucketName });
    new CfnOutput(this, "CloudFormationRoleArn", { value: serviceRole.attrArn });
    new CfnOutput(this, "OperatorRoleArn", { value: operatorRole.attrArn });
    const effectiveBoundaryOutput = new CfnOutput(this, "EffectiveBoundaryArn", { value: effectiveBoundaryArn });
    const deployBoundaryOutput = new CfnOutput(this, "DeployBoundaryArn", { value: rolesBoundaryArn });
    // The validator does not see that the Fn::If takes the Ref branch only under UseDefaultBoundary.
    for (const output of [effectiveBoundaryOutput, deployBoundaryOutput]) {
      Validations.of(output).acknowledge({
        id: "CloudFormation-Validate::W1001",
        reason: "The Ref to the default permissions boundary is in the Fn::If branch taken only when UseDefaultBoundary holds",
      });
    }
    new CfnOutput(this, "PullThroughPrefix", { value: naming.pullThroughPrefix });
  }
}
