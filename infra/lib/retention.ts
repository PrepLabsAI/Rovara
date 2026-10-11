// Named environments only: every resource kept on a stack delete is kept with RetainExceptOnCreate,
// so a failed first create deletes what it made and a retry can reuse fixed names such as the
// secret agentx/<env>/slack (found in the live check, 2026-09-27). A delete or a replacing update
// still keeps the data. The legacy deployment keeps plain Retain.
import { CfnDeletionPolicy, CfnResource, type IAspect } from "aws-cdk-lib";
import type { IConstruct } from "constructs";

/** Kept as Retain: deletion protection makes a rollback's delete fail (leaving the stack
 * ROLLBACK_FAILED), and a user pool's name is not unique, so an orphan never blocks a retry. */
const ALWAYS_RETAIN = new Set(["AWS::Cognito::UserPool"]);

export class RetainExceptOnCreate implements IAspect {
  visit(node: IConstruct): void {
    if (!CfnResource.isCfnResource(node) || ALWAYS_RETAIN.has(node.cfnResourceType)) return;
    // Diagnostic records are attempt-specific and intentionally survive even a failed initial
    // create so operators can inspect why the deployment rolled back.
    if (node.getMetadata("agentx:retain-on-create-rollback") === true) return;
    if (node.cfnOptions.deletionPolicy === CfnDeletionPolicy.RETAIN) node.cfnOptions.deletionPolicy = CfnDeletionPolicy.RETAIN_EXCEPT_ON_CREATE;
  }
}
