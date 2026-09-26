// What an install or upgrade needs from a deploy engine: deploy one environment stack and read a
// stack's outputs. The templates engine (AWS SDK change sets) and the cdk engine both implement it.
import type { DeployPart, StackOutputs } from "./parameters.js";

export type { StackOutputs } from "./parameters.js";

export type DeployEvent =
  | { kind: "uploading"; what: string }
  | { kind: "changes"; stackName: string; changes: Array<{ action: string; logicalId: string; type: string; replacement: string }> }
  | { kind: "no-changes"; stackName: string }
  | { kind: "deploying"; stackName: string }
  | { kind: "deployed"; stackName: string };

export interface DeployRequest {
  part: DeployPart;
  stackName: string;
  parameters: Record<string, string>;
  /** undefined for the access stack (deployed with the caller's credentials) */
  roleArn?: string;
  terminationProtection: boolean;
  onEvent?: (event: DeployEvent) => void;
}

export interface StackDeployer {
  deploy(request: DeployRequest): Promise<StackOutputs>;
  /** undefined when the stack does not exist */
  outputs(stackName: string): Promise<StackOutputs | undefined>;
}

/** Parts whose stacks carry termination protection: access, foundation, identity, runtime. */
export const PROTECTED_PARTS: ReadonlySet<DeployPart> = new Set<DeployPart>(["access", "foundation", "identity", "runtime"]);
