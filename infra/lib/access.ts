import { Aws, CfnCondition, CfnOutput, CfnParameter, Duration, Fn, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { operatorRoleStatements, serviceRoleStatements, type PolicyStatementJson } from "./access-policies.js";
import type { AgentXNaming } from "./naming.js";
import { applyPermissionsBoundaryParameter } from "./permissions-boundary.js";

export interface AccessStackProps extends StackProps {
  naming: AgentXNaming;
}

/** Statements the policy module returns only when a boundary is set; the template decides at deploy time. */
const BOUNDARY_STATEMENT_SIDS = new Set(["IamRequireBoundary", "IamKeepBoundary"]);

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

    const { parameter: permissionsBoundaryArn, condition: hasPermissionsBoundary } = applyPermissionsBoundaryParameter(this);
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
      runtimeName: naming.runtimeName,
    };
    // The boundary statements are built with the parameter reference and then emitted only under
    // HasPermissionsBoundary, so an environment without a boundary gets no Deny at all.
    const serviceStatements = serviceRoleStatements({ ...policyScope, permissionsBoundaryArn: permissionsBoundaryArn.valueAsString }).map(
      (statement: PolicyStatementJson) =>
        BOUNDARY_STATEMENT_SIDS.has(statement.Sid) ? Fn.conditionIf(hasPermissionsBoundary.logicalId, statement, Aws.NO_VALUE) : statement,
    );

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
    new CfnOutput(this, "PullThroughPrefix", { value: naming.pullThroughPrefix });
  }
}
