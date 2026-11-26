import { CfnOutput, type Stack } from "aws-cdk-lib";

/**
 * What the single release pipeline records on the gateway stack it deploys (#1478 phase 2: the gateway is deployed from Code's commit, by Code's CDK app). The pipeline passes
 * `-c rovaraCodeSha=<the 40-hex Code commit the gateway image was built from>`; then, inside the same change set, the gateway carries:
 *  - the output `DeployedCodeSha`: the Code commit this stack was last deployed from. It adds no resource row, rolls back with the stack, and so cannot name a newer Code than the one
 *    live. The release pipeline's rollback and its floors read it to name the gateway by its Code commit. (The older `DeployedCloudSha` output, written while Cloud deployed the
 *    gateway, is not written any more: the Cloud sha is read from Cloud's web stack only.)
 *  - `ServiceArn` (the Fargate service), which the pipeline's settled gate reads to find the ECS service without a stack-resource listing.
 * Without the context neither output exists: a hand deploy, and every template pinned by a test, is byte for byte what it was.
 */
export const CODE_SHA_CONTEXT_KEY = "rovaraCodeSha";
export const DEPLOYED_CODE_SHA_OUTPUT = "DeployedCodeSha";
export const GATEWAY_SERVICE_ARN_OUTPUT = "ServiceArn";

/** The sha named by the context: undefined when absent; a malformed value stops the synth (an output that names no commit would be worse than none). */
export function codeShaContext(stack: Stack): string | undefined {
  const value = stack.node.tryGetContext(CODE_SHA_CONTEXT_KEY) as unknown;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) throw new Error(`${CODE_SHA_CONTEXT_KEY} must be a 40-character lowercase hex commit sha`);
  return value;
}

/** Adds the DeployedCodeSha output when the pipeline named the commit. Returns whether it did. */
export function addDeployedCodeSha(stack: Stack): boolean {
  const sha = codeShaContext(stack);
  if (sha === undefined) return false;
  new CfnOutput(stack, DEPLOYED_CODE_SHA_OUTPUT, { value: sha, description: "The Code commit this stack was deployed from (written by the release pipeline; read by its rollback floors)" });
  return true;
}
