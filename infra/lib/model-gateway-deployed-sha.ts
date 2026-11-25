import { CfnOutput, type Stack } from "aws-cdk-lib";

/**
 * What the single release pipeline records on the stacks it deploys (BETA-CLOUD-PLAN 1.6, gate 1 and gate 2). The pipeline passes
 * `-c rovaraCloudSha=<the 40-hex Cloud commit being deployed>`; then, inside the same change set:
 *  - web and gateway carry the output `DeployedCloudSha`: the commit that stack was last deployed from. It adds no resource row, rolls back
 *    with the stack, and so cannot name a newer Cloud than the one live. Gate 1 (`deployed-drift`) reads it to check out the DEPLOYED tree.
 *  - the gateway also carries `ServiceArn` (the Fargate service), which gate 2 (`gateway-settled`) reads to find the ECS service without a
 *    stack-resource listing.
 * Without the context neither output exists: a hand deploy, and every template pinned by a test, is byte for byte what it was.
 */
export const CLOUD_SHA_CONTEXT_KEY = "rovaraCloudSha";
export const DEPLOYED_CLOUD_SHA_OUTPUT = "DeployedCloudSha";
export const GATEWAY_SERVICE_ARN_OUTPUT = "ServiceArn";

/** The sha named by the context: undefined when absent; a malformed value stops the synth (an output that names no commit would be worse than none). */
export function cloudShaContext(stack: Stack): string | undefined {
  const value = stack.node.tryGetContext(CLOUD_SHA_CONTEXT_KEY) as unknown;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) throw new Error(`${CLOUD_SHA_CONTEXT_KEY} must be a 40-character lowercase hex commit sha`);
  return value;
}

/** Adds the DeployedCloudSha output when the pipeline named the commit. Returns whether it did. */
export function addDeployedCloudSha(stack: Stack): boolean {
  const sha = cloudShaContext(stack);
  if (sha === undefined) return false;
  new CfnOutput(stack, DEPLOYED_CLOUD_SHA_OUTPUT, { value: sha, description: "The Cloud commit this stack was deployed from (written by the release pipeline; read by its drift gate)" });
  return true;
}
