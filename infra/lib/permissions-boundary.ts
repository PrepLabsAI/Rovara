import { Aspects, Aws, CfnCondition, CfnParameter, Fn, Token, Validations, type IAspect, type Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { IConstruct } from "constructs";
import { defaultBoundaryArn } from "./access-policies.js";
import { isIamRole } from "./iam-roles.js";

const PARAMETER_ID = "PermissionsBoundaryArn";
const CONDITION_ID = "HasPermissionsBoundary";

/** The template validator checks PermissionsBoundary's minimum length against the parameter's empty
 * default; the Fn::If takes that branch only when the parameter is not empty. */
const F3033_ACKNOWLEDGMENT = {
  id: "CloudFormation-Validate::F3033",
  reason: "PermissionsBoundary takes the parameter only when it is not empty, else the default boundary ARN",
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
  /** `Fn::If [HasPermissionsBoundary, Ref PermissionsBoundaryArn, <default boundary>]`. */
  readonly effectiveBoundaryArn: string;
}

export interface PermissionsBoundaryOptions {
  /**
   * Returns the default boundary's ARN for the else branch, given the HasPermissionsBoundary
   * condition. The access stack passes one that creates the default boundary policy and returns
   * its Ref; every other stack uses the deterministic ARN.
   */
  readonly defaultBoundary?: (hasPermissionsBoundary: CfnCondition) => string;
}

/**
 * Sets every `AWS::IAM::Role` in the stack's `permissionsBoundary` to the effective boundary
 * (the given one, else the default), and acknowledges the CloudFormation validator's F3033 false
 * positive on that role (the empty-parameter branch is never taken). Roles built as plain `CfnResource` of type `AWS::IAM::Role` (CDK's
 * custom-resource providers) get the same property through an override, mirroring
 * `EnvironmentRolePath` in role-path.ts. Throws if a role already declares a boundary: we have none
 * today, and a silent overwrite would hide a bug rather than surface one.
 */
class PermissionsBoundaryAspect implements IAspect {
  constructor(private readonly boundary: string) {}

  visit(node: IConstruct): void {
    if (!isIamRole(node)) return;
    if (node instanceof iam.CfnRole) {
      if (node.permissionsBoundary !== undefined) {
        throw new Error(`${node.node.path} already has a permissions boundary`);
      }
      node.permissionsBoundary = this.boundary;
    } else {
      // Plain CfnResource properties are raw CloudFormation JSON (PascalCase), unlike the
      // camelCase props cfn2ts-generated classes like iam.CfnRole translate for us.
      // Reading `_cfnProperties` relies on an aws-cdk-lib internal field (pinned at 2.269.0);
      // the "throws on an existing plain-CfnResource boundary" test in permissions-boundary.test.ts guards it.
      const properties = (node as unknown as { _cfnProperties?: Record<string, unknown> })._cfnProperties;
      if (properties?.PermissionsBoundary !== undefined) {
        throw new Error(`${node.node.path} already has a permissions boundary`);
      }
      node.addPropertyOverride("PermissionsBoundary", this.boundary);
    }
    Validations.of(node).acknowledge(F3033_ACKNOWLEDGMENT);
  }
}

const applied = new WeakMap<Stack, PermissionsBoundaryParameter>();

/**
 * Creates the `PermissionsBoundaryArn` parameter and `HasPermissionsBoundary` condition on `stack`
 * once, and adds the aspect that applies the effective boundary to every IAM role the stack
 * declares: the given boundary, else the environment's default boundary (created by the access
 * stack), so a boundary always applies. Calling it again for the same stack is a no-op that returns
 * the first call's result instead of creating duplicates or re-applying the aspect.
 */
export function applyPermissionsBoundaryParameter(stack: Stack, env: string, options: PermissionsBoundaryOptions = {}): PermissionsBoundaryParameter {
  const existing = applied.get(stack);
  if (existing !== undefined) return existing;

  const parameter = new CfnParameter(stack, PARAMETER_ID, {
    type: "String",
    default: "",
    allowedPattern: "^$|^arn:aws[a-z-]*:iam::[0-9]{12}:policy/.+$",
    description: "Optional IAM permissions boundary policy ARN applied to every role this environment creates; empty uses the default boundary",
  });
  const condition = new CfnCondition(stack, CONDITION_ID, {
    expression: Fn.conditionNot(Fn.conditionEquals(parameter.valueAsString, "")),
  });
  Validations.of(condition).acknowledge(W8001_ACKNOWLEDGMENT);
  const fallback = options.defaultBoundary?.(condition) ?? defaultBoundaryArn({ env, partition: Aws.PARTITION, account: Aws.ACCOUNT_ID });
  const effectiveBoundaryArn = Token.asString(Fn.conditionIf(condition.logicalId, parameter.valueAsString, fallback));
  Aspects.of(stack).add(new PermissionsBoundaryAspect(effectiveBoundaryArn));

  const result = { parameter, condition, effectiveBoundaryArn };
  applied.set(stack, result);
  return result;
}
