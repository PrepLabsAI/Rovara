import { agentXError, environmentStackName } from "@agentx/contracts";
import type { EnvironmentSettings } from "../../environments/settings.js";
import type { StackDeployer } from "../deployer.js";
import type { DeployPart, StackOutputs } from "../parameters.js";

type OutputRead = {
  existing: EnvironmentSettings | undefined;
  deployer: StackDeployer;
  env: string;
  fullOrder: DeployPart[];
  deploySet: ReadonlySet<DeployPart>;
  outputs: Partial<Record<DeployPart, StackOutputs>>;
};

export async function readDeploymentOutputs(input: OutputRead): Promise<void> {
  const { existing, deployer, env, outputs } = input;
  if (existing !== undefined) {
    await readExistingOutputs(existing, deployer, env, outputs);
  } else {
    await readResumedOutputs(input);
  }
}

async function readExistingOutputs(existing: EnvironmentSettings, deployer: StackDeployer, env: string, outputs: OutputRead["outputs"]): Promise<void> {
  // Every part this environment already has settings for supplies its outputs by reading the
  // existing stack, whether or not it is also being (re)deployed below: a part deployed on its
  // own (`--parts slack`) still needs the current outputs of the parts it is not redeploying.
  for (const part of Object.keys(existing.stacks) as DeployPart[]) {
    const knownStackName = existing.stacks[part];
    if (knownStackName === undefined) continue;
    const fetched = await deployer.outputs(knownStackName);
    if (fetched === undefined) {
      // access and identity are optional in the settings schema: silently treating a stack
      // settings names as gone would just drop it from the rewritten settings below, hiding a
      // real inconsistency (the recorded stack no longer reports outputs) as if it had never
      // existed. The other four parts are required by the schema, so the same silent loss
      // cannot happen for them: either something downstream needs their output and
      // `stackParameters` already names what is missing, or nothing does and settings simply
      // are not written (see the foundation/runtime/slack check below).
      if (part === "access" || part === "identity") {
        throw agentXError("CONFIG_INVALID", `stack ${knownStackName} (environment ${env}'s ${part} stack) no longer reports outputs; its settings may be stale`);
      }
      continue;
    }
    outputs[part] = fetched;
  }
}

async function readResumedOutputs({ deployer, env, fullOrder, deploySet, outputs }: OutputRead): Promise<void> {
  // No settings yet: this may be a fresh install resuming after an earlier partial failure.
  // Whatever isn't being (re)deployed this run may already exist from that earlier attempt;
  // probe it directly by the name this orchestrator would have used. A part whose stack does
  // not exist yet yields no outputs, exactly as `deployer.outputs` documents; `stackParameters`
  // reports clearly whatever a later part still needs and does not have.
  for (const part of fullOrder) {
    if (deploySet.has(part)) continue;
    const fetched = await deployer.outputs(environmentStackName(env, part));
    if (fetched !== undefined) outputs[part] = fetched;
  }
}
