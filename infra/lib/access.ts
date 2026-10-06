import { Aws, CfnCondition, CfnOutput, CfnParameter, Duration, Fn, RemovalPolicy, Stack, Validations, type StackProps } from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { defaultBoundaryName, defaultBoundaryStatements, environmentRolePath, operatorRoleStatements, serviceRoleStatements } from "./access-policies.js";
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

    // The default boundary applies whenever the company gives none, so every AgentX role always has
    // one. It exists only under UseDefaultBoundary; the roles and the Deny statements Ref it inside
    // the Fn::If's else branch, which is valid for a conditional resource (the branch is evaluated
    // only when the resource exists) and makes CloudFormation create the policy before the roles.
    // A DependsOn would not do: DependsOn on a resource whose condition is false fails the stack.
    const { effectiveBoundaryArn } = applyPermissionsBoundaryParameter(this, env, {
      defaultBoundary: (hasPermissionsBoundary) => {
        const useDefaultBoundary = new CfnCondition(this, "UseDefaultBoundary", {
          expression: Fn.conditionNot(hasPermissionsBoundary),
        });
        const policy = new iam.CfnManagedPolicy(this, "DefaultPermissionsBoundary", {
          managedPolicyName: defaultBoundaryName(env),
          path: environmentRolePath(env),
          description: `Default permission boundary for every agentx-${env} role`,
          policyDocument: {
            Version: "2012-10-17",
            Statement: defaultBoundaryStatements({ env, partition: Aws.PARTITION, region: Aws.REGION, account: this.account, cloudFormationRoleName: naming.cloudFormationRoleName }),
          },
        });
        policy.cfnOptions.condition = useDefaultBoundary;
        return policy.ref;
      },
    });
    const operatorPrincipalArn = new CfnParameter(this, "OperatorPrincipalArn", {
      type: "String",
      default: "",
      allowedPattern: "^$|^arn:aws[a-z-]*:iam::[0-9]{12}:(root|role/.+|user/.+)$",
      description: "Optional principal allowed to assume the operator role; empty trusts the account root",
    });
    const hasOperatorPrincipal = new CfnCondition(this, "HasOperatorPrincipal", {
      expression: Fn.conditionNot(Fn.conditionEquals(operatorPrincipalArn.valueAsString, "")),
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
    const serviceStatements = serviceRoleStatements({ ...policyScope, permissionsBoundaryArn: effectiveBoundaryArn });

    const serviceRole = new iam.CfnRole(this, "CloudFormationServiceRole", {
      roleName: naming.cloudFormationRoleName,
      description: `Role CloudFormation assumes to deploy the agentx-${env} stacks`,
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
      description: `Role an operator assumes to run agentx against the ${env} environment`,
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: {
              AWS: Fn.conditionIf(
                hasOperatorPrincipal.logicalId,
                operatorPrincipalArn.valueAsString,
                `arn:${Aws.PARTITION}:iam::${this.account}:root`,
              ),
            },
            Action: "sts:AssumeRole",
          },
        ],
      },
      maxSessionDuration: 3600,
      policies: [{ policyName: "operate", policyDocument: { Version: "2012-10-17", Statement: operatorRoleStatements(policyScope) } }],
    });

    new CfnOutput(this, "ArtifactBucketName", { value: bucket.bucketName });
    new CfnOutput(this, "CloudFormationRoleArn", { value: serviceRole.attrArn });
    new CfnOutput(this, "OperatorRoleArn", { value: operatorRole.attrArn });
    const effectiveBoundaryOutput = new CfnOutput(this, "EffectiveBoundaryArn", { value: effectiveBoundaryArn });
    // The validator does not see that the Fn::If takes the Ref branch only under UseDefaultBoundary.
    Validations.of(effectiveBoundaryOutput).acknowledge({
      id: "CloudFormation-Validate::W1001",
      reason: "The Ref to DefaultPermissionsBoundary is in the Fn::If branch taken only when UseDefaultBoundary holds",
    });
    new CfnOutput(this, "PullThroughPrefix", { value: naming.pullThroughPrefix });
  }
}
