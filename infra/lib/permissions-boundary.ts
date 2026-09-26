import { Aspects, Aws, CfnCondition, CfnParameter, CfnResource, Fn, Token, Validations, type IAspect, type Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { IConstruct } from "constructs";

const PARAMETER_ID = "PermissionsBoundaryArn";
const CONDITION_ID = "HasPermissionsBoundary";

/** The template validator checks PermissionsBoundary's minimum length against the Fn::If's empty-string
 * branch; that branch is AWS::NoValue, so the property is omitted instead. */
const F3033_ACKNOWLEDGMENT = {
  id: "CloudFormation-Validate::F3033",
  reason: "PermissionsBoundary is AWS::NoValue, not an empty string, when no boundary is given",
};

/** Every environment stack gets the condition for consistency, but a stack that declares no IAM role
 * (the identity stack, for one) never references it in any resource. */
const W8001_ACKNOWLEDGMENT = {
  id: "CloudFormation-Validate::W8001",
  reason: "HasPermissionsBoundary is added to every environment stack; some stacks have no IAM role to condition",
};

export interface PermissionsBoundaryParameter {
  readonly parameter: CfnParameter;
  readonly condition: CfnCondition;
}

/**
 * Sets every `AWS::IAM::Role` in the stack's `permissionsBoundary` to
 * `Fn::If [HasPermissionsBoundary, Ref PermissionsBoundaryArn, Ref AWS::NoValue]`, and acknowledges
 * the CloudFormation validator's F3033 false positive on that role (the AWS::NoValue branch is not
 * an empty string). Roles built as plain `CfnResource` of type `AWS::IAM::Role` (CDK's
 * custom-resource providers) get the same property through an override, mirroring
 * `EnvironmentRolePath` in role-path.ts. Throws if a role already declares a boundary: we have none
 * today, and a silent overwrite would hide a bug rather than surface one.
 */
class PermissionsBoundaryAspect implements IAspect {
  constructor(private readonly boundary: string) {}

  visit(node: IConstruct): void {
    if (!CfnResource.isCfnResource(node) || node.cfnResourceType !== "AWS::IAM::Role") return;
    if (node instanceof iam.CfnRole) {
      if (node.permissionsBoundary !== undefined) {
        throw new Error(`${node.node.path} already has a permissions boundary`);
      }
      node.permissionsBoundary = this.boundary;
    } else {
      // Plain CfnResource properties are raw CloudFormation JSON (PascalCase), unlike the
      // camelCase props cfn2ts-generated classes like iam.CfnRole translate for us.
      const properties = (node as unknown as { _cfnProperties?: Record<string, unknown> })._cfnProperties;
      if (properties?.PermissionsBoundary !== undefined) {
        throw new Error(`${node.node.path} already has a permissions boundary`);
      }
      node.addPropertyOverride("PermissionsBoundary", this.boundary);
    }
    Validations.of(node).acknowledge(F3033_ACKNOWLEDGMENT);
  }
}

/**
 * Creates the `PermissionsBoundaryArn` parameter and `HasPermissionsBoundary` condition on `stack`
 * once, and adds the aspect that conditionally applies the resulting boundary to every IAM role the
 * stack declares. Calling it again for the same stack is a no-op that returns the same parameter and
 * condition instead of creating duplicates or re-applying the aspect.
 */
export function applyPermissionsBoundaryParameter(stack: Stack): PermissionsBoundaryParameter {
  const existingParameter = stack.node.tryFindChild(PARAMETER_ID) as CfnParameter | undefined;
  const existingCondition = stack.node.tryFindChild(CONDITION_ID) as CfnCondition | undefined;
  if (existingParameter !== undefined && existingCondition !== undefined) {
    return { parameter: existingParameter, condition: existingCondition };
  }

  const parameter = new CfnParameter(stack, PARAMETER_ID, {
    type: "String",
    default: "",
    allowedPattern: "^$|^arn:aws[a-z-]*:iam::[0-9]{12}:policy/.+$",
    description: "Optional IAM permissions boundary policy ARN applied to every role this environment creates",
  });
  const condition = new CfnCondition(stack, CONDITION_ID, {
    expression: Fn.conditionNot(Fn.conditionEquals(parameter.valueAsString, "")),
  });
  Validations.of(condition).acknowledge(W8001_ACKNOWLEDGMENT);
  const boundary = Token.asString(Fn.conditionIf(condition.logicalId, parameter.valueAsString, Aws.NO_VALUE));
  Aspects.of(stack).add(new PermissionsBoundaryAspect(boundary));

  return { parameter, condition };
}
