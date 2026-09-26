import { CfnResource, Stack, type IAspect } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { IConstruct } from "constructs";
import { environmentRolePath } from "./access-policies.js";

/**
 * Puts every IAM role in the visited stacks under the environment's path, so the CloudFormation
 * service role can be scoped to `role/agentx/<env>/*` whatever name CloudFormation generates (it
 * truncates long generated names, dropping any name prefix). Roles built as plain CfnResource
 * (CDK's custom-resource providers) get the same property through an override. Stacks listed in
 * `except` are skipped: the access stack's fixed-name roles stay at the root path.
 */
export class EnvironmentRolePath implements IAspect {
  constructor(
    private readonly env: string,
    private readonly except: ReadonlySet<Stack>,
  ) {}

  visit(node: IConstruct): void {
    if (!CfnResource.isCfnResource(node) || node.cfnResourceType !== "AWS::IAM::Role") return;
    if (this.except.has(Stack.of(node))) return;
    if (node instanceof iam.CfnRole) node.path = environmentRolePath(this.env);
    else node.addPropertyOverride("Path", environmentRolePath(this.env));
  }
}
