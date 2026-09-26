import { CfnResource } from "aws-cdk-lib";
import type { IConstruct } from "constructs";

/**
 * True for any construct whose underlying CloudFormation resource is `AWS::IAM::Role`, whether it
 * was built as a typed `iam.CfnRole` (or the `iam.Role` L2 that wraps one) or as a plain
 * `CfnResource` of that type, which is how CDK builds custom-resource provider roles. Shared by the
 * `EnvironmentRolePath` and `PermissionsBoundaryAspect` aspects, which both need to find every IAM
 * role in a stack regardless of which shape created it.
 */
export function isIamRole(node: IConstruct): node is CfnResource {
  return CfnResource.isCfnResource(node) && node.cfnResourceType === "AWS::IAM::Role";
}
